/**
 * OpenClaw Agent Runner：知忆进程内通用 Agent Loop 执行引擎。
 *
 * 定位与 DirectExecutionRunner / MultiCAAdapter 并列：
 * - 不直接查业务 DB、不接管 Goal/Project/BusinessTask/Execution 状态机
 * - 只消费由知忆注入的上下文与业务任务描述，驱动 OpenClaw Agent Core 完成多轮推理与 Tool Calling
 * - 维护活跃 AbortController / Agent 引用，支持并发取消与停机清理
 */
import type { AgentProfile } from '../../../types';
import type { BusinessTask } from '../../domain/types';
import type { PersonalAIEvent } from '../../events/event-types';
import type { PersonalAIIdentity } from '../../identity/identity-manager';
import type { ExecutionTask } from '../../task/task-repository';
import type { Agent } from '../../vendor/openclaw/agent-core/agent.js';
import { createZhiyiOpenClawAgent } from './agent-factory';
import { createOpenClawEventTranslator } from './event-adapter';
import {
  chatHistoryToAgentMessages,
  extractTextFromAssistantMessage,
  findLastAssistantMessage,
} from './message-adapter';
import { resolveAgentAllowedTools } from './tool-gateway';
import type { OpenClawAgentRunnerDeps, OpenClawRunOptions } from './types';
import { MemoryContextProvider } from '../memory/context-provider';

const WORK_TOOL_NAMES: readonly string[] = [
  'goal_list',
  'goal_create',
  'goal_update',
  'project_list',
  'project_create',
  'project_update',
  'project_summary',
  'proactive_notifications',
  'task_list',
  'task_detail',
  'task_executions',
  'task_create',
  'task_update',
];

const MEMORY_TOOL_NAMES: readonly string[] = [
  'recall_memory',
  'remember_memory',
  'update_memory',
  'memory_search',
  'memory_get',
  'memory_create',
  'memory_update',
  'memory_archive',
];

const MEMORY_TOOL_GUIDANCE: string = [
  '[长期记忆使用准则]',
  '1. 优先使用自动注入：日常问答和任务执行优先使用已自动注入的长期记忆上下文，切忌每轮无意义重复检索。',
  '2. recall_memory 使用时机：仅当自动注入的上下文不足，或者用户明确询问历史记忆、过往偏好或技术选型时才按需调用。',
  '3. remember_memory 使用时机：仅当用户明确要求保存（例如“记住……”、“保存偏好……”）时才允许调用；严禁凭模型推测擅自保存闲聊或临时信息。',
  '4. update_memory 使用时机：仅当用户明确要求纠正或更新特定记忆时调用，必须先明确指定 memory_id；若目标不明确，向用户核实或先用 recall_memory 查找，严禁凭猜测修改相似记忆。',
  '5. 保护用户已确认记忆：严禁擅自覆盖或弱化用户已确认记忆。',
  '[/长期记忆使用准则]',
].join('\n');

const WORK_TOOL_GUIDANCE: string = [
  '[工作管理工具使用准则]',
  '1. 查询优先于猜测：查看未完成事项或找不到确切 ID 时，先调用 project_list / task_list / goal_list / task_detail 核实真实数据；严禁编造或猜想 ID。',
  '2. 讨论想法不要擅自建单：若用户只是在探讨思路、征求意见或闲聊，直接回复讨论即可，禁止私自调用 task_create / project_create / goal_create。',
  '3. 明确要求再创建/修改：仅当用户明确要求记录、新建或更新目标/项目/任务时，才调用对应创建或修改工具；创建任务默认只落库追踪，不会自动触发执行。',
  '4. 缺关键信息先确认：当操作对象不明确（如存在多个同名项目/任务）或缺少必要字段时，先向用户简明确认，不要代作决定。',
  '5. 严守操作边界：删除、取消或启动执行任务均不在工作管理工具权限范围内；如用户明确需要取消或执行任务，请引导通过对应的执行或取消接口完成。',
  '6. 如实反馈结果：仅依据工具真实返回的数据（ID、标题、状态、优先级、关联项目）作答，不虚构未执行的变更。',
  '[/工作管理工具使用准则]',
].join('\n');

const MAX_RESULT_CHARS = 100_000;

interface AsyncEventChannel<T> extends AsyncIterable<T> {
  push: (item: T) => void;
  close: () => void;
}

function createAsyncEventChannel<T>(): AsyncEventChannel<T> {
  const buffer: T[] = [];
  const waiters: Array<(res: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(item: T): void {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: item, done: false });
      } else {
        buffer.push(item);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined as unknown as T, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift() as T, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };
}

export class OpenClawAgentRunner {
  private readonly activeRuns = new Map<
    string,
    { agent: Agent; controller: AbortController }
  >();

  constructor(private readonly deps: OpenClawAgentRunnerDeps) {}

  private buildSystemPrompt(
    agent: AgentProfile,
    prebuiltSystemMessage?: string,
    taskMemoryContext?: string,
  ): string {
    const parts: string[] = [];
    if (prebuiltSystemMessage && prebuiltSystemMessage.trim() !== '') {
      parts.push(prebuiltSystemMessage.trim());
    }
    if (taskMemoryContext && taskMemoryContext.trim() !== '') {
      parts.push(taskMemoryContext.trim());
    }
    const allowed = resolveAgentAllowedTools({ agent });
    if (WORK_TOOL_NAMES.some((name) => allowed.has(name))) {
      parts.push(WORK_TOOL_GUIDANCE);
    }
    if (MEMORY_TOOL_NAMES.some((name) => allowed.has(name))) {
      parts.push(MEMORY_TOOL_GUIDANCE);
    }
    if (agent.instructions.trim() !== '') {
      parts.push(`[Agent 角色指令]\n${agent.instructions.trim()}`);
    }
    return parts.join('\n\n');
  }

  async *stream(
    task: BusinessTask,
    execution: ExecutionTask,
    agentProfile: AgentProfile,
    identity: PersonalAIIdentity,
    options: OpenClawRunOptions = {},
  ): AsyncGenerator<PersonalAIEvent> {
    const controller = new AbortController();
    const channel = createAsyncEventChannel<PersonalAIEvent>();
    let currentTurns = 0;

    let taskMemoryContext: string | undefined = undefined;
    const hasPrebuiltMemory = Boolean(
      options.prebuiltSystemMessage &&
        options.prebuiltSystemMessage.includes('<personal_memory_context>'),
    );
    if (!hasPrebuiltMemory) {
      const memoryProvider =
        this.deps.memoryContextProvider ??
        (this.deps.toolGateway?.memoryService
          ? new MemoryContextProvider({
              config: this.deps.config,
              memoryService: this.deps.toolGateway.memoryService,
              agentStore: this.deps.agentStore,
              projectStore: this.deps.projectStore,
              logger: this.deps.logger,
            })
          : null);

      if (memoryProvider) {
        const promptText = [task.title, task.description].filter(Boolean).join('\n\n') || task.title;
        const memoryResult = memoryProvider.buildContext({
          identity,
          queryText: promptText,
          projectId: task.project_id ?? identity.project_id,
          agentId: agentProfile.agent_id,
        });
        if (memoryResult.injected && memoryResult.text) {
          taskMemoryContext = memoryResult.text;
        }
      }
    }

    const modelName: string =
      agentProfile.model_preference ||
      options.modelOverride ||
      this.deps.config.defaultModel;
    const systemPrompt = this.buildSystemPrompt(
      agentProfile,
      options.prebuiltSystemMessage,
      taskMemoryContext,
    );
    const initialMessages = chatHistoryToAgentMessages(options.historyMessages, modelName);

    const agent = createZhiyiOpenClawAgent({
      modelName,
      systemPrompt,
      agentProfile,
      task,
      execution,
      identity,
      modelAdapter: this.deps.modelAdapter,
      toolGateway: this.deps.toolGateway,
      logger: this.deps.logger,
      onUsage: options.onUsage,
      maxContextTokens: options.maxContextTokens,
      getTurnCount: () => currentTurns,
      publicOrigin: options.publicOrigin,
      initialMessages,
    });

    this.activeRuns.set(execution.id, { agent, controller });

    const onExternalAbort = (): void => {
      controller.abort();
      agent.abort('cancelled');
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onExternalAbort();
      } else {
        options.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const { metrics, handleEvent } = createOpenClawEventTranslator(execution.id, (ev) => {
      channel.push(ev);
    });

    const unsubscribe = agent.subscribe((event) => {
      handleEvent(event);
      currentTurns = metrics.turns;
      if (event.type === 'tool_execution_start') {
        this.deps.businessTaskManager.recordExecutionProgress(
          execution.id,
          `调用工具：${event.toolName}`,
          {
            eventType: 'tool_call',
            metadata: { phase: 'start', tool: event.toolName, tool_call_id: event.toolCallId },
          },
        );
      } else if (event.type === 'tool_execution_end') {
        this.deps.businessTaskManager.recordExecutionProgress(
          execution.id,
          `工具结束：${event.toolName}${event.isError ? '（失败）' : ''}`,
          {
            eventType: 'tool_call',
            metadata: {
              phase: 'end',
              tool: event.toolName,
              tool_call_id: event.toolCallId,
              is_error: event.isError,
            },
          },
        );
      }
    });

    const desc = task.description.trim();
    const title = task.title.trim();
    const userPrompt: string =
      desc !== '' && desc !== title
        ? desc.includes(title)
          ? desc
          : `${title}\n\n${desc}`
        : title;

    const promptPromise: Promise<unknown> = agent
      .prompt(userPrompt)
      .catch((error: unknown): unknown => error)
      .finally(() => {
        channel.close();
      });

    try {
      for await (const ev of channel) {
        yield ev;
      }

      const caughtError = await promptPromise;
      const lastAssistant = findLastAssistantMessage(agent.state.messages);
      const isCancelled =
        controller.signal.aborted || lastAssistant?.stopReason === 'aborted';

      if (isCancelled) {
        this.deps.businessTaskManager.finishDirectExecution(execution.id, {
          status: 'cancelled',
          error: '用户取消任务',
        });
        if (options.rethrowOnError) {
          throw new Error('用户取消任务');
        }
        return;
      }

      const failureMessage: string | undefined =
        agent.state.errorMessage ||
        (lastAssistant?.stopReason === 'error'
          ? lastAssistant.errorMessage || '模型推理失败'
          : undefined) ||
        (caughtError instanceof Error
          ? caughtError.message
          : caughtError !== undefined
            ? String(caughtError)
            : undefined);

      if (failureMessage) {
        this.deps.logger.warn(
          `[openclaw-runner] 执行 ${execution.id} 失败: ${failureMessage}`,
        );
        const statusMatch = failureMessage.match(/模型上游返回\s+(\d{3})/);
        const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
        this.deps.businessTaskManager.finishDirectExecution(execution.id, {
          status: 'failed',
          error: failureMessage,
          statusCode,
        });
        if (options.rethrowOnError) {
          throw new Error(failureMessage);
        }
        return;
      }

      const finalAssistantText: string = lastAssistant
        ? extractTextFromAssistantMessage(lastAssistant)
        : '';
      const resultText: string = (finalAssistantText || metrics.streamedText).slice(
        0,
        MAX_RESULT_CHARS,
      );

      this.deps.businessTaskManager.finishDirectExecution(execution.id, {
        status: 'completed',
        result: resultText,
      });
    } finally {
      unsubscribe();
      options.signal?.removeEventListener('abort', onExternalAbort);
      this.activeRuns.delete(execution.id);
    }
  }

  async run(
    task: BusinessTask,
    execution: ExecutionTask,
    agentProfile: AgentProfile,
    identity: PersonalAIIdentity,
    options: OpenClawRunOptions = {},
  ): Promise<void> {
    for await (const _ of this.stream(task, execution, agentProfile, identity, options)) {
      // 非流式 /work-tasks/:id/execute 消费事件流直至 Execution 收敛终态
    }
  }

  abort(executionId: string): boolean {
    const entry = this.activeRuns.get(executionId);
    if (!entry) return false;
    entry.controller.abort();
    entry.agent.abort('cancelled');
    return true;
  }

  abortAll(): void {
    for (const entry of this.activeRuns.values()) {
      entry.controller.abort();
      entry.agent.abort('shutdown');
    }
    this.activeRuns.clear();
  }
}
