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
  extractTextFromAssistantMessage,
  findLastAssistantMessage,
} from './message-adapter';
import type { OpenClawAgentRunnerDeps, OpenClawRunOptions } from './types';

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

  private buildSystemPrompt(agent: AgentProfile, prebuiltSystemMessage?: string): string {
    const parts: string[] = [];
    if (prebuiltSystemMessage && prebuiltSystemMessage.trim() !== '') {
      parts.push(prebuiltSystemMessage.trim());
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

    const modelName: string =
      agentProfile.model_preference ||
      options.modelOverride ||
      this.deps.config.defaultModel;
    const systemPrompt = this.buildSystemPrompt(agentProfile, options.prebuiltSystemMessage);

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
    });

    const userPrompt: string =
      [task.title, task.description].filter(Boolean).join('\n\n') || task.title;

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
        this.deps.businessTaskManager.finishDirectExecution(execution.id, {
          status: 'failed',
          error: failureMessage,
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
