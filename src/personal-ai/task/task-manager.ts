/** 任务门面：对外只暴露受用户隔离约束的操作。 */
import type { ExecutionTask, NewExecutionTask, TaskRepository, TaskPatch } from './task-repository';

export class TaskManager {
  constructor(
    private readonly repo: TaskRepository,
    private readonly onExecutionCancelledInTx?: (taskId: string) => void,
  ) {}

  createIfAbsent(input: NewExecutionTask): { task: ExecutionTask; created: boolean } {
    return this.repo.create(input);
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

  /**
   * 只允许取消尚未完成的任务；已完成的任务保持原状态。
   *
   * 状态流转用 `updateIfActive` 的单条条件 UPDATE 完成（`WHERE status IN (活动态)`），
   * 因此并发/重复取消时只有一次能成功，其余返回 `already_<终态>`（路由层映射为 409），
   * 也不会把已经 cancelled 的任务再写一遍造成语义歧义。
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
        completed_at: new Date().toISOString(),
      };
      if (!this.repo.updateIfActive(id, patch)) {
        // 走到这里说明状态在读取后被别处推进到终态（例如 Worker 恰好判定 completed）。
        const latest: ExecutionTask | undefined = this.repo.get(userId, id);
        return { ok: false, reason: `already_${latest?.status ?? 'terminal'}` };
      }
      if (task.task_id) {
        this.onExecutionCancelledInTx?.(task.task_id);
      }
      return { ok: true, task: this.repo.get(userId, id) };
    });
  }

  /**
   * 内部更新入口（门面层）。
   *
   * 默认走终态保护更新：已完成 / 失败 / 已取消的任务不会被改回活动态，
   * 避免调用方无意中「复活」终态任务。
   *
   * @returns true = 已写入；false = 任务已是终态或不存在。
   */
  update(id: string, patch: TaskPatch): boolean {
    return this.repo.updateIfActive(id, patch);
  }
}
