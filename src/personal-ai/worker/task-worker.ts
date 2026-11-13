/**
 * 后台任务 Worker：不依赖 HTTP 请求生命周期，负责 MultiCA 等外部 Execution 的派发、轮询、恢复与僵死对账。
 *
 * - 启动时按安全边界恢复遗留 dispatching 任务（已建外部单则直接恢复轮询，不重复建单）、
 *   把重启中断的 direct_llm 执行收敛为 failed + needs_verification（绝不假定成功），并对账孤儿业务任务；
 * - 定时检测长时间无进展的外部执行（stalled）与轮询超限，标记为需核实；
 * - 终态写入、事件记录与业务 Task 状态同步置于同一事务，消除写后崩溃分裂窗口。
 */
import type { AgentStore } from '../../agents';
import type { Logger } from '../../logger';
import type { AgentExecutionAdapter } from '../adapters/agent/agent-adapter';
import { mapExternalStatus, MultiCAError } from '../adapters/agent/multica-adapter';
import type { ExecutionStatus, MulticaConfig, PersonalAIConfig } from '../config';
import type { ExecutionEventStore } from '../task/execution-event-store';
import {
  classifyExecutionFailure,
  type ExecutionEventType,
} from '../task/execution-lifecycle';
import type { ExecutionTask, TaskPatch, TaskRepository } from '../task/task-repository';

const INTERNAL_STATUSES: readonly string[] = [
  'pending',
  'dispatching',
  'running',
  'completed',
  'failed',
  'cancelled',
];

const DEFAULT_STALE_EXECUTION_MS = 15 * 60_000;

export interface TaskWorkerDeps {
  config: PersonalAIConfig;
  multica: MulticaConfig;
  repo: TaskRepository;
  adapter: AgentExecutionAdapter | null;
  logger: Logger;
  agentStore?: AgentStore;
  eventStore?: ExecutionEventStore;
  staleExecutionMs?: number;
  onExecutionTerminalInTx?: (taskId: string, status: 'completed' | 'failed' | 'cancelled') => void;
  onStartupRecoverInTx?: () => void;
  onTaskCompleted?: (params: {
    userId: string;
    taskId: string;
    agentId: string | null;
    result: string;
  }) => void;
}

export class TaskWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly deps: TaskWorkerDeps) {}

  start(): void {
    const { recoveredCount, resumedCount, exhaustedCount, staleDirectCount } =
      this.deps.repo.runInTransaction(() => {
        const recovery = this.deps.repo.recoverDetailed();
        for (const exec of recovery.resumedRunning) {
          this.deps.eventStore?.record({
            executionId: exec.id,
            taskId: exec.task_id,
            userId: exec.user_id,
            eventType: 'recovered',
            agentId: exec.agent_id,
            status: exec.status,
            message: `服务重启后发现已有外部任务 ${exec.external_task_id}，直接恢复轮询（不重复创建）`,
            metadata: { external_task_id: exec.external_task_id },
          });
        }
        for (const exec of recovery.resetToPending) {
          this.deps.eventStore?.record({
            executionId: exec.id,
            taskId: exec.task_id,
            userId: exec.user_id,
            eventType: 'recovered',
            agentId: exec.agent_id,
            status: exec.status,
            message: '服务重启后将未创建外部单的 dispatching 任务安全回退为 pending 重新派发',
            metadata: { attempt_count: exec.attempt_count },
          });
        }
        for (const exec of recovery.exhausted) {
          this.deps.eventStore?.record({
            executionId: exec.id,
            taskId: exec.task_id,
            userId: exec.user_id,
            eventType: 'verification_required',
            agentId: exec.agent_id,
            status: exec.status,
            message: exec.error ?? '派发重试次数超过上限，结果未确认，请核实后重试',
            metadata: { error_category: exec.error_category, error_code: exec.error_code },
          });
          if (exec.task_id) {
            this.deps.onExecutionTerminalInTx?.(exec.task_id, 'failed');
          }
        }

        const staleDirect = this.deps.repo.failStaleDirectExecutionsAndList(
          '服务重启导致流式执行中断，结果未能确认，请核实后重试',
        );
        for (const exec of staleDirect) {
          this.deps.eventStore?.record({
            executionId: exec.id,
            taskId: exec.task_id,
            userId: exec.user_id,
            eventType: 'verification_required',
            agentId: exec.agent_id,
            status: exec.status,
            message: exec.error ?? '服务重启导致流式执行中断，结果未能确认',
            metadata: {
              error_category: exec.error_category,
              error_code: exec.error_code,
              needs_verification: true,
            },
          });
        }

        this.deps.onStartupRecoverInTx?.();

        return {
          recoveredCount: recovery.resetToPending.length,
          resumedCount: recovery.resumedRunning.length,
          exhaustedCount: recovery.exhausted.length,
          staleDirectCount: staleDirect.length,
        };
      });

    if (recoveredCount + resumedCount > 0) {
      this.deps.logger.info(
        `[task-worker] 启动恢复 ${recoveredCount} 个待重派任务，续轮询 ${resumedCount} 个外部任务`,
      );
    }
    if (exhaustedCount > 0) {
      this.deps.logger.warn(
        `[task-worker] ${exhaustedCount} 个任务超过派发重试上限，已标记为需核实`,
      );
    }
    if (staleDirectCount > 0) {
      this.deps.logger.info(
        `[task-worker] 收敛 ${staleDirectCount} 个重启中断的 direct_llm 执行（已标记需核实）`,
      );
    }

    this.timer = setInterval((): void => {
      void this.tick();
    }, Math.max(200, this.deps.multica.pollIntervalMs));
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private resolveExternalAssignee(logicalAgentId: string | null): string | undefined {
    if (!logicalAgentId) return this.deps.multica.defaultAgent || undefined;
    if (this.deps.agentStore) {
      const profile = this.deps.agentStore.get(logicalAgentId);
      if (profile) {
        const raw: unknown = profile.backend_config?.assignee;
        if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
        return this.deps.multica.defaultAgent || undefined;
      }
    }
    return logicalAgentId;
  }

  private applyPatchWithSync(
    task: ExecutionTask,
    patch: TaskPatch,
    event?: {
      eventType: ExecutionEventType;
      message?: string;
      metadata?: Record<string, unknown>;
    },
  ): boolean {
    const nextStatus = patch.status;
    if (
      nextStatus === 'completed' ||
      nextStatus === 'failed' ||
      nextStatus === 'cancelled'
    ) {
      const terminalStatus: 'completed' | 'failed' | 'cancelled' = nextStatus;
      return this.deps.repo.runInTransaction((): boolean => {
        const applied: boolean = this.deps.repo.updateIfActive(task.id, patch);
        if (!applied) return false;
        if (event) {
          this.deps.eventStore?.record({
            executionId: task.id,
            taskId: task.task_id,
            userId: task.user_id,
            eventType: event.eventType,
            agentId: task.agent_id,
            status: terminalStatus,
            message: event.message,
            metadata: event.metadata,
          });
        }
        if (task.task_id) {
          this.deps.onExecutionTerminalInTx?.(task.task_id, terminalStatus);
        }
        return true;
      });
    }

    const applied = this.deps.repo.updateIfActive(task.id, patch);
    if (applied && event) {
      this.deps.eventStore?.record({
        executionId: task.id,
        taskId: task.task_id,
        userId: task.user_id,
        eventType: event.eventType,
        agentId: task.agent_id,
        status: nextStatus ?? task.status,
        message: event.message,
        metadata: event.metadata,
      });
    }
    return applied;
  }

  /** 立即派发一个新建任务（Runtime 调用），与轮询互斥由 status 保证。 */
  async dispatch(taskId: string): Promise<void> {
    const task: ExecutionTask | undefined = this.deps.repo.getById(taskId);
    if (!task || task.status !== 'pending' || task.external_task_id) return;
    if (task.execution_mode === 'direct_llm') return;
    const adapter: AgentExecutionAdapter | null = this.deps.adapter;
    if (!adapter) {
      const classified = classifyExecutionFailure({
        message: 'MultiCA 未启用（MULTICA_ENABLED=false）',
        codeOverride: 'multica_disabled',
        categoryOverride: 'non_retryable',
      });
      this.applyPatchWithSync(
        task,
        {
          status: 'failed',
          error: classified.message,
          error_category: classified.category,
          error_code: classified.code,
          retryable: classified.retryable,
          needs_verification: classified.needsVerification,
          completed_at: new Date().toISOString(),
        },
        {
          eventType: 'failed',
          message: classified.message,
          metadata: { error_category: classified.category, error_code: classified.code },
        },
      );
      return;
    }

    if (!this.deps.repo.claimForDispatch(taskId, new Date().toISOString())) {
      this.deps.logger.info(`[task-worker] 任务 ${taskId} 已非 pending（可能被取消），跳过派发`);
      return;
    }
    try {
      const created = await adapter.createTask({
        userId: task.user_id,
        conversationId: task.conversation_id,
        taskId: task.id,
        title: task.input_summary ?? '知忆任务',
        description: (task.input_summary ?? '').slice(0, 8000),
        agentId: this.resolveExternalAssignee(task.agent_id),
        projectId: task.project_id ?? undefined,
      });
      const applied: boolean = this.applyPatchWithSync(
        task,
        {
          status: 'running',
          external_task_id: created.externalTaskId,
          progress_message: `已创建 MultiCA issue ${created.externalTaskId}（${created.status}）`,
        },
        {
          eventType: 'started',
          message: `已派发至 MultiCA (${created.externalTaskId})，Agent 开始执行`,
          metadata: { external_task_id: created.externalTaskId, external_status: created.status },
        },
      );
      if (!applied) {
        // createTask 窗口内任务已被取消/已完成：补记外部 id 便于审计并尽力取消外部 run。
        this.deps.repo.update(taskId, {
          external_task_id: created.externalTaskId,
          progress_message: '任务已进入终态，已尽力回收外部 run',
        });
        const reclaimed: boolean = adapter.cancelTask
          ? await adapter.cancelTask(created.externalTaskId)
          : false;
        this.deps.logger.warn(
          `[task-worker] 任务 ${taskId} 在派发期间已终态，外部 issue ${created.externalTaskId} 回收=${reclaimed}`,
        );
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const errorKind = error instanceof MultiCAError ? error.kind : undefined;
      const classified = classifyExecutionFailure({
        message: `派发失败：${rawMessage}`,
        errorKind,
      });
      this.applyPatchWithSync(
        task,
        {
          status: 'failed',
          error: classified.message,
          error_category: classified.category,
          error_code: classified.code,
          retryable: classified.retryable,
          needs_verification: classified.needsVerification,
          completed_at: new Date().toISOString(),
        },
        {
          eventType: classified.needsVerification ? 'verification_required' : 'failed',
          message: classified.message,
          metadata: {
            error_category: classified.category,
            error_code: classified.code,
            retryable: classified.retryable,
          },
        },
      );
    }
  }

  private async pollOne(task: ExecutionTask): Promise<void> {
    const adapter: AgentExecutionAdapter | null = this.deps.adapter;
    if (!adapter || !task.external_task_id) return;
    const patch: TaskPatch = { increment_poll: true };
    let pollEvent:
      | { eventType: ExecutionEventType; message?: string; metadata?: Record<string, unknown> }
      | undefined;

    try {
      const status = await adapter.getTaskStatus(task.external_task_id);
      const raw: string = status.status ?? 'unknown';
      const mapped: ExecutionStatus = INTERNAL_STATUSES.includes(raw)
        ? (raw as ExecutionStatus)
        : mapExternalStatus(raw, status.rawStatus);
      patch.progress_message = status.message ?? null;
      if (status.externalRunId) patch.external_run_id = status.externalRunId;

      if (mapped === 'completed') {
        const result = await adapter.getTaskResult(
          task.external_task_id,
          status.externalRunId ?? task.external_run_id ?? undefined,
        );
        patch.completed_at = new Date().toISOString();
        if (result.status === 'completed') {
          patch.status = 'completed';
          patch.result = result.content ?? '';
          patch.error_category = null;
          patch.error_code = null;
          patch.retryable = false;
          patch.needs_verification = false;
          pollEvent = {
            eventType: 'completed',
            message: '外部 Agent 执行完成',
            metadata: { external_task_id: task.external_task_id },
          };
        } else {
          const classified = classifyExecutionFailure({
            message: result.error ?? 'Agent 未返回结果',
          });
          patch.status = 'failed';
          patch.error = classified.message;
          patch.error_category = classified.category;
          patch.error_code = classified.code;
          patch.retryable = classified.retryable;
          patch.needs_verification = classified.needsVerification;
          pollEvent = {
            eventType: classified.needsVerification ? 'verification_required' : 'failed',
            message: classified.message,
            metadata: {
              error_category: classified.category,
              error_code: classified.code,
              retryable: classified.retryable,
            },
          };
        }
      } else if (mapped === 'cancelled') {
        const reason = `外部任务已取消（${status.rawStatus ?? raw}）`;
        patch.status = 'cancelled';
        patch.error = reason;
        patch.error_category = 'cancelled';
        patch.error_code = 'external_cancelled';
        patch.retryable = false;
        patch.needs_verification = false;
        patch.completed_at = new Date().toISOString();
        pollEvent = {
          eventType: 'cancelled',
          message: reason,
          metadata: { external_task_id: task.external_task_id },
        };
      } else if (mapped === 'failed') {
        const classified = classifyExecutionFailure({
          message: `MultiCA 任务失败：${status.rawStatus ?? raw}`,
        });
        patch.status = 'failed';
        patch.error = classified.message;
        patch.error_category = classified.category;
        patch.error_code = classified.code;
        patch.retryable = classified.retryable;
        patch.needs_verification = classified.needsVerification;
        patch.completed_at = new Date().toISOString();
        pollEvent = {
          eventType: 'failed',
          message: classified.message,
          metadata: {
            error_category: classified.category,
            error_code: classified.code,
            retryable: classified.retryable,
          },
        };
      } else {
        patch.status = 'running';
        patch.last_progress_at = new Date().toISOString();
        if (status.message && status.message !== task.progress_message) {
          pollEvent = {
            eventType: 'progress',
            message: status.message,
            metadata: { poll_count: task.poll_count + 1 },
          };
        }
      }
    } catch (error) {
      // 单次轮询网络/CLI抖动不立即判死，由 maxPolls 与僵死超时控制安全兜底。
      const rawMessage = error instanceof Error ? error.message : String(error);
      patch.progress_message = `轮询暂失败：${rawMessage}`;
      pollEvent = {
        eventType: 'progress',
        message: patch.progress_message,
        metadata: { transient_poll_error: true, poll_count: task.poll_count + 1 },
      };
    }

    if (
      patch.status !== 'completed' &&
      patch.status !== 'failed' &&
      patch.status !== 'cancelled' &&
      task.poll_count + 1 > this.deps.multica.maxPolls
    ) {
      const classified = classifyExecutionFailure({
        message: `轮询次数超过上限（${this.deps.multica.maxPolls}），结果尚未确认，请核实后重试`,
        codeOverride: 'poll_limit_exceeded',
        categoryOverride: 'needs_verification',
      });
      patch.status = 'failed';
      patch.error = classified.message;
      patch.error_category = classified.category;
      patch.error_code = classified.code;
      patch.retryable = classified.retryable;
      patch.needs_verification = classified.needsVerification;
      patch.completed_at = new Date().toISOString();
      pollEvent = {
        eventType: 'verification_required',
        message: classified.message,
        metadata: { poll_count: task.poll_count + 1, needs_verification: true },
      };
    }

    const applied: boolean = this.applyPatchWithSync(task, patch, pollEvent);
    if (!applied) {
      this.deps.logger.info(`[task-worker] 任务 ${task.id} 已进入终态，丢弃本次轮询结果`);
      return;
    }
    if (patch.status === 'completed' && task.task_id && typeof patch.result === 'string') {
      this.deps.onTaskCompleted?.({
        userId: task.user_id,
        taskId: task.task_id,
        agentId: task.agent_id,
        result: patch.result,
      });
    }
  }

  /** 检查并收敛长时间无进展的外部执行，避免静默卡死或假定成功。 */
  private reconcileStalledExecutions(): void {
    const staleMs = this.deps.staleExecutionMs ?? DEFAULT_STALE_EXECUTION_MS;
    if (staleMs <= 0) return;
    const staleBeforeIso = new Date(Date.now() - staleMs).toISOString();
    const stalled = this.deps.repo.runInTransaction((): ExecutionTask[] => {
      const rows = this.deps.repo.failStalledExternalExecutions(staleBeforeIso);
      for (const exec of rows) {
        this.deps.eventStore?.record({
          executionId: exec.id,
          taskId: exec.task_id,
          userId: exec.user_id,
          eventType: 'verification_required',
          agentId: exec.agent_id,
          status: 'failed',
          message: exec.error ?? '执行长时间无进展，结果无法确认，请核实后重试',
          metadata: {
            error_category: exec.error_category,
            error_code: exec.error_code,
            needs_verification: true,
          },
        });
        if (exec.task_id) {
          this.deps.onExecutionTerminalInTx?.(exec.task_id, 'failed');
        }
      }
      return rows;
    });
    if (stalled.length > 0) {
      this.deps.logger.warn(
        `[task-worker] 检测到 ${stalled.length} 个长时间无进展的 Execution，已收敛为 failed + 需核实`,
      );
    }
  }

  /** 一轮轮询：清理僵死超时任务后，按并发上限派发/轮询活跃任务。 */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.reconcileStalledExecutions();
      const tasks: ExecutionTask[] = this.deps.repo.listActive(this.deps.multica.maxConcurrentTasks);
      for (const task of tasks) {
        if (!task.external_task_id && task.status === 'pending') {
          await this.dispatch(task.id);
          continue;
        }
        await this.pollOne(task);
      }
    } catch (error) {
      this.deps.logger.error('[task-worker] 轮询异常', error);
    } finally {
      this.busy = false;
    }
  }
}
