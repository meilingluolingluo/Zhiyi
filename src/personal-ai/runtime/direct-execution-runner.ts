/**
 * direct_llm 后端执行器（绑定业务 Task）：
 * 请求内直接流式调用 ModelAdapter（不经过 MultiCA CLI 或 TaskWorker），
 * 并维护进程内 AbortController 表以支持并发取消与优雅停机。
 */
import type { AgentStore } from '../../agents';
import type { AppConfig } from '../../config';
import { injectMemoryMessages } from '../../context';
import type { Logger } from '../../logger';
import type { MemoryStore } from '../../memories';
import type { AgentProfile, ChatMessage } from '../../types';
import { ModelAdapterError, type ModelAdapter, type TokenUsage } from '../adapters/model/model-adapter';
import type { ProjectStore } from '../domain/project-store';
import type { BusinessTask } from '../domain/types';
import type { PersonalAIIdentity } from '../identity/identity-manager';
import type { BusinessTaskManager } from '../task/business-task-manager';
import type { ExecutionTask } from '../task/task-repository';
import { MemoryContextProvider, MemoryService } from './memory';

const MAX_RESULT_CHARS = 100_000;

export interface DirectExecutionRunnerDeps {
  config: AppConfig;
  memoryStore: MemoryStore;
  agentStore: AgentStore;
  modelAdapter: ModelAdapter;
  businessTaskManager: BusinessTaskManager;
  logger: Logger;
  memoryContextProvider?: MemoryContextProvider;
  projectStore?: ProjectStore;
}

export class DirectExecutionRunner {
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(private readonly deps: DirectExecutionRunnerDeps) {}

  async *stream(
    task: BusinessTask,
    execution: ExecutionTask,
    agent: AgentProfile,
    identity: PersonalAIIdentity,
    options: {
      signal?: AbortSignal;
      modelOverride?: string;
      onUsage?: (usage: TokenUsage) => void;
      rethrowOnError?: boolean;
    } = {},
  ): AsyncGenerator<string> {
    const controller = new AbortController();
    this.activeControllers.set(execution.id, controller);

    const promptText: string =
      [task.title, task.description].filter(Boolean).join('\n\n') || task.title;
    const baseMessages: ChatMessage[] = [];
    if (agent.instructions.trim() !== '') {
      baseMessages.push({ role: 'system', content: agent.instructions.trim() });
    }
    baseMessages.push({ role: 'user', content: promptText });

    const memoryProvider =
      this.deps.memoryContextProvider ??
      new MemoryContextProvider({
        config: this.deps.config,
        memoryService: new MemoryService({ memoryStore: this.deps.memoryStore }),
        agentStore: this.deps.agentStore,
        projectStore: this.deps.projectStore,
        logger: this.deps.logger,
      });

    const memory = memoryProvider.buildContext({
      identity: {
        ...identity,
        agent_id: agent.agent_id,
        project_id: task.project_id ?? identity.project_id,
      },
      queryText: promptText,
      projectId: task.project_id ?? identity.project_id,
      agentId: agent.agent_id,
    });
    const messages: ChatMessage[] =
      memory.injected && memory.text
        ? injectMemoryMessages(baseMessages, memory.text)
        : baseMessages;

    const signal: AbortSignal = options.signal
      ? (AbortSignal.any([controller.signal, options.signal]) as AbortSignal)
      : controller.signal;

    let output = '';
    try {
      for await (const delta of this.deps.modelAdapter.stream(messages, {
        model: agent.model_preference || options.modelOverride || undefined,
        signal,
        onUsage: options.onUsage,
      })) {
        if (output.length < MAX_RESULT_CHARS) {
          output += delta;
        }
        yield delta;
      }
      if (signal.aborted) {
        this.deps.businessTaskManager.finishDirectExecution(execution.id, {
          status: 'cancelled',
          error: '用户取消任务',
        });
        return;
      }
      this.deps.businessTaskManager.finishDirectExecution(execution.id, {
        status: 'completed',
        result: output.slice(0, MAX_RESULT_CHARS),
      });
    } catch (error) {
      if (signal.aborted) {
        this.deps.businessTaskManager.finishDirectExecution(execution.id, {
          status: 'cancelled',
          error: '用户取消任务',
        });
        if (options.rethrowOnError) throw error;
        return;
      }
      const message: string = error instanceof Error ? error.message : String(error);
      const statusCode: number | undefined =
        error instanceof ModelAdapterError ? error.status : undefined;
      const errorCode: string | undefined =
        error instanceof Error && error.name === 'TimeoutError' ? 'upstream_timeout' : undefined;
      this.deps.logger.warn(`[direct-runner] 执行 ${execution.id} 失败: ${message}`);
      this.deps.businessTaskManager.finishDirectExecution(execution.id, {
        status: 'failed',
        error: message,
        statusCode,
        errorCode,
      });
      if (options.rethrowOnError) throw error;
    } finally {
      this.activeControllers.delete(execution.id);
    }
  }

  async run(
    task: BusinessTask,
    execution: ExecutionTask,
    agent: AgentProfile,
    identity: PersonalAIIdentity,
  ): Promise<void> {
    for await (const _ of this.stream(task, execution, agent, identity)) {
      // HTTP /execute 非流式模式：仅消费完成流并由 stream() 回写终态
    }
  }

  abort(executionId: string): boolean {
    const controller = this.activeControllers.get(executionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  abortAll(): void {
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
  }
}
