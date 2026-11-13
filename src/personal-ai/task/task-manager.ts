/** 任务门面：对外只暴露受用户隔离约束的操作，并同步记录取消等生命周期事件。 */
import type { ExecutionEventRecord, ExecutionEventStore } from './execution-event-store';
import type { ExecutionTask, NewExecutionTask, TaskPatch, TaskRepository } from './task-repository';

export class TaskManager {
  constructor(
    private readonly repo: TaskRepository,
    private readonly onExecutionCancelledInTx?: (taskId: string) => void,
    private readonly eventStore?: ExecutionEventStore,
  ) {}

  createIfAbsent(input: NewExecutionTask): { task: ExecutionTask; created: boolean } {
    const res = this.repo.create(input);
    if (res.created && this.eventStore) {
      this.eventStore.record({
        executionId: res.task.id,
        taskId: res.task.task_id,
        userId: res.task.user_id,
        eventType: 'created',
        agentId: res.task.agent_id,
        status: res.task.status,
        message: `创建执行记录（${res.task.execution_mode}）`,
      });
    }
    return res;
  }

  getForUser(userId: string, id: string): ExecutionTask | undefined {
    return this.repo.get(userId, id);
  }

  listForUser(userId: string, limit?: number): ExecutionTask[] {
    return this.repo.listForUser(userId, limit);
  }

  listByTaskId(
    userId: string,
    taskId: string,
    limit?: number,
    offset?: number,
  ): { items: ExecutionTask[]; total: number } {
    return this.repo.listByTaskId(userId, taskId, limit, offset);
  }

  getLatestByTaskId(userId: string, taskId: string): ExecutionTask | undefined {
    return this.repo.getLatestByTaskId(userId, taskId);
  }

  listEvents(
    userId: string,
    executionId: string,
    limit?: number,
    offset?: number,
  ): { items: ExecutionEventRecord[]; total: number } | undefined {
    const exec = this.repo.get(userId, executionId);
    if (!exec || !this.eventStore) return exec ? { items: [], total: 0 } : undefined;
    return this.eventStore.listByExecution(userId, executionId, limit, offset);
  }

  /**
   * 只允许取消尚未完成的任务；已完成的任务保持原状态。
   * 状态流转由单条条件 UPDATE 完成，并发/重复取消时只有一次能成功。
   */
  cancelForUser(userId: string, id: string): { ok: boolean; task?: ExecutionTask; reason?: string } {
    return this.repo.runInTransaction((): { ok: boolean; task?: ExecutionTask; reason?: string } => {
      const task: ExecutionTask | undefined = this.repo.get(userId, id);
      if (!task) return { ok: false, reason: 'not_found' };
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        return { ok: false, reason: `already_${task.status}` };
      }
      const patch: TaskPatch = {
        status: 'cancelled',
        error: '用户取消任务',
        error_category: 'cancelled',
        error_code: 'cancelled_by_user',
        retryable: false,
        needs_verification: false,
        completed_at: new Date().toISOString(),
      };
      if (!this.repo.updateIfActive(id, patch)) {
        const latest: ExecutionTask | undefined = this.repo.get(userId, id);
        return { ok: false, reason: `already_${latest?.status ?? 'terminal'}` };
      }
      this.eventStore?.record({
        executionId: id,
        taskId: task.task_id,
        userId,
        eventType: 'cancelled',
        agentId: task.agent_id,
        status: 'cancelled',
        message: '用户取消任务',
      });
      if (task.task_id) {
        this.onExecutionCancelledInTx?.(task.task_id);
      }
      return { ok: true, task: this.repo.get(userId, id) };
    });
  }

  /**
   * 内部更新入口（门面层）：仅在任务处于活动态时更新。
   */
  update(id: string, patch: TaskPatch): boolean {
    return this.repo.updateIfActive(id, patch);
  }
}
