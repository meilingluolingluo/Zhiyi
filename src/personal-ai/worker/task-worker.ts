/**
 * 后台任务 Worker：不依赖 HTTP 请求生命周期。
 *
 * - 服务启动时 recover() 恢复未完成（上一进程遗留 dispatching）任务，
 *   清理遗留 direct_llm 流式执行，并对账孤儿 in_progress 业务任务；
 * - 定时轮询 active 任务，并发受 MULTICA_MAX_CONCURRENT_TASKS 限制；
 * - 失败任务有限重试（依靠 maxPolls 上限），不无限循环；
 * - 终态写入与业务 Task 状态同步置于同一事务，消除写后崩溃分裂窗口；
 * - 完成后停止轮询；任务状态全部持久化。
 */
import type { AgentStore } from '../../agents';
import type { Logger } from '../../logger';
import type { AgentExecutionAdapter } from '../adapters/agent/agent-adapter';
import { mapExternalStatus } from '../adapters/agent/multica-adapter';
import type { ExecutionStatus, MulticaConfig, PersonalAIConfig } from '../config';
import type { ExecutionTask, TaskPatch, TaskRepository } from '../task/task-repository';

const INTERNAL_STATUSES: readonly string[] = [
  'pending', 'dispatching', 'running', 'completed', 'failed', 'cancelled',
];

export interface TaskWorkerDeps {
  config: PersonalAIConfig;
  multica: MulticaConfig;
  repo: TaskRepository;
  adapter: AgentExecutionAdapter | null;
  logger: Logger;
  agentStore?: AgentStore;
  onExecutionTerminalInTx?: (taskId: string, status: 'completed' | 'failed') => void;
  onStartupRecoverInTx?: () => void;
}

export class TaskWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly deps: TaskWorkerDeps) {}

  start(): void {
    const { recovered, staleDirect } = this.deps.repo.runInTransaction((): {
      recovered: number;
      staleDirect: number;
    } => {
      const recoveredCount: number = this.deps.repo.recover();
      const staleDirectCount: number = this.deps.repo.failStaleDirectExecutions(
        '服务重启导致流式执行中断',
      );
      this.deps.onStartupRecoverInTx?.();
      return { recovered: recoveredCount, staleDirect: staleDirectCount };
    });
    if (recovered > 0) this.deps.logger.info(`[task-worker] 恢复 ${recovered} 个未完成任务`);
    if (staleDirect > 0) {
      this.deps.logger.info(`[task-worker] 收敛 ${staleDirect} 个重启中断的 direct_llm 执行`);
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
    executionId: string,
    taskId: string | null,
    patch: TaskPatch,
  ): boolean {
    if (patch.status === 'completed' || patch.status === 'failed') {
      const terminalStatus: 'completed' | 'failed' = patch.status;
      return this.deps.repo.runInTransaction((): boolean => {
        const applied: boolean = this.deps.repo.updateIfActive(executionId, patch);
        if (applied && taskId) {
          this.deps.onExecutionTerminalInTx?.(taskId, terminalStatus);
        }
        return applied;
      });
    }
    return this.deps.repo.updateIfActive(executionId, patch);
  }

  /** 立即派发一个新建任务（Runtime 调用），与轮询互斥由 status 保证。 */
  async dispatch(taskId: string): Promise<void> {
    const task: ExecutionTask | undefined = this.deps.repo.getById(taskId);
    if (!task || task.status !== 'pending' || task.external_task_id) return;
    if (task.execution_mode === 'direct_llm') return;
    const adapter: AgentExecutionAdapter | null = this.deps.adapter;
    if (!adapter) {
      // 用终态保护写入：若此刻用户已取消，cancelled 优先，不被改写成 failed。
      this.applyPatchWithSync(taskId, task.task_id, {
        status: 'failed',
        error: 'MultiCA 未启用（MULTICA_ENABLED=false）',
        completed_at: new Date().toISOString(),
      });
      return;
    }
    // 原子抢占：只有仍为 pending 才能进入 dispatching，
    // 避免「读到 pending → 用户取消 → 写入 dispatching」覆盖终态。
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
      const applied: boolean = this.deps.repo.updateIfActive(taskId, {
        status: 'running',
        external_task_id: created.externalTaskId,
        progress_message: `已创建 MultiCA issue ${created.externalTaskId}（${created.status}）`,
      });
      if (!applied) {
        // createTask 窗口内任务已被取消/已完成：状态保持不变，只补记外部 id（便于审计与回收），
        // 并尽力取消外部 run，避免留下无人认领的 Agent 执行。
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
      this.applyPatchWithSync(taskId, task.task_id, {
        status: 'failed',
        error: `派发失败：${error instanceof Error ? error.message : String(error)}`,
        completed_at: new Date().toISOString(),
      });
    }
  }

  private async pollOne(task: ExecutionTask): Promise<void> {
    const adapter: AgentExecutionAdapter | null = this.deps.adapter;
    if (!adapter || !task.external_task_id) return;
    const patch: TaskPatch = { increment_poll: true };
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
        } else {
          patch.status = 'failed';
          patch.error = result.error ?? 'Agent 未返回结果';
        }
      } else if (mapped === 'failed' || mapped === 'cancelled') {
        patch.status = 'failed';
        patch.error = `MultiCA 任务状态：${status.rawStatus ?? raw}`;
        patch.completed_at = new Date().toISOString();
      } else {
        patch.status = 'running';
      }
    } catch (error) {
      // 单次轮询失败不立即判定任务失败，由 maxPolls 控制重试上限。
      patch.progress_message = `轮询暂失败：${error instanceof Error ? error.message : String(error)}`;
    }

    if (task.poll_count + 1 > this.deps.multica.maxPolls) {
      patch.status = 'failed';
      patch.error = `轮询次数超过上限（${this.deps.multica.maxPolls}）`;
      patch.completed_at = new Date().toISOString();
    }
    // 终态保护：快照可能已过期（用户在这段异步 CLI 调用期间取消/任务已被判定终态），
    // 因此用带 `status IN (活动态)` 条件的 SQL 回写，并在同事务内同步业务 Task 状态。
    const applied: boolean = this.applyPatchWithSync(task.id, task.task_id, patch);
    if (!applied) {
      this.deps.logger.info(`[task-worker] 任务 ${task.id} 已进入终态，丢弃本次轮询结果`);
    }
  }

  /** 一轮轮询：并发数由「本轮取出的任务数」限制。 */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
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
