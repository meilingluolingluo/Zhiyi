/**
 * 任务依赖关系仓储：管理业务任务之间的前置依赖（finish_to_start），
 * 提供拓扑排序、循环依赖检测与前置条件完成度检查。
 */
import type { Database } from '../../db';
import { DomainError, type BusinessTaskStatus, type TaskDependency } from '../domain/types';

interface RawDependencyRow {
  id: number;
  user_id: string;
  task_id: string;
  depends_on_id: string;
  dependency_type: 'finish_to_start';
  created_at: string;
}

export class TaskDependencyRepository {
  constructor(private readonly db: Database) {}

  /** 检查候选依赖是否会导致环路（A -> B -> A）。 */
  detectCycle(userId: string, taskId: string, candidateDependsOnId: string): boolean {
    if (taskId === candidateDependsOnId) return true;

    // 广度优先遍历 candidateDependsOnId 的所有前置依赖，如果发现可达 taskId 则成环
    const visited = new Set<string>();
    const queue: string[] = [candidateDependsOnId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === taskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const rows = this.db.all<{ depends_on_id: string }>(
        'SELECT depends_on_id FROM task_dependencies WHERE user_id = ? AND task_id = ?',
        [userId, current],
      );
      for (const row of rows) {
        if (!visited.has(row.depends_on_id)) {
          queue.push(row.depends_on_id);
        }
      }
    }

    return false;
  }

  /** 为任务添加一条前置依赖。 */
  addDependency(
    userId: string,
    taskId: string,
    dependsOnId: string,
    dependencyType: 'finish_to_start' = 'finish_to_start',
  ): TaskDependency {
    if (taskId === dependsOnId) {
      throw new DomainError(400, 'self_dependency', '任务不能依赖自身');
    }

    // 验证两任务均存在且属于同一用户
    const task = this.db.get<{ id: string }>(
      'SELECT id FROM tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [taskId, userId],
    );
    if (!task) {
      throw new DomainError(404, 'task_not_found', `任务不存在：${taskId}`);
    }

    const prereq = this.db.get<{ id: string }>(
      'SELECT id FROM tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [dependsOnId, userId],
    );
    if (!prereq) {
      throw new DomainError(404, 'depends_on_not_found', `前置依赖任务不存在：${dependsOnId}`);
    }

    if (this.detectCycle(userId, taskId, dependsOnId)) {
      throw new DomainError(400, 'dependency_cycle', `添加依赖将导致循环依赖：${taskId} -> ${dependsOnId}`);
    }

    const now = new Date().toISOString();
    this.db.run(
      `INSERT OR IGNORE INTO task_dependencies
         (user_id, task_id, depends_on_id, dependency_type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, taskId, dependsOnId, dependencyType, now],
    );

    const row = this.db.get<RawDependencyRow>(
      'SELECT * FROM task_dependencies WHERE user_id = ? AND task_id = ? AND depends_on_id = ?',
      [userId, taskId, dependsOnId],
    );
    if (!row) {
      throw new DomainError(500, 'dependency_create_failed', '创建依赖关系失败');
    }
    return row;
  }

  /** 移除前置依赖。 */
  removeDependency(userId: string, taskId: string, dependsOnId: string): boolean {
    const res = this.db.run(
      'DELETE FROM task_dependencies WHERE user_id = ? AND task_id = ? AND depends_on_id = ?',
      [userId, taskId, dependsOnId],
    );
    return res.changes > 0;
  }

  /** 全量覆盖设置任务的前置依赖。 */
  setDependencies(userId: string, taskId: string, dependsOnIds: string[]): void {
    const uniqueIds = Array.from(new Set(dependsOnIds.filter(Boolean)));
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM task_dependencies WHERE user_id = ? AND task_id = ?',
        [userId, taskId],
      );
      for (const depId of uniqueIds) {
        this.addDependency(userId, taskId, depId);
      }
    });
  }

  /** 列出指定任务所依赖的前置任务 ID 列表。 */
  listDependencies(userId: string, taskId: string): string[] {
    const rows = this.db.all<{ depends_on_id: string }>(
      'SELECT depends_on_id FROM task_dependencies WHERE user_id = ? AND task_id = ? ORDER BY id ASC',
      [userId, taskId],
    );
    return rows.map((r) => r.depends_on_id);
  }

  /** 列出所有依赖指定任务的下游任务 ID 列表。 */
  listDependents(userId: string, dependsOnId: string): string[] {
    const rows = this.db.all<{ task_id: string }>(
      'SELECT task_id FROM task_dependencies WHERE user_id = ? AND depends_on_id = ? ORDER BY id ASC',
      [userId, dependsOnId],
    );
    return rows.map((r) => r.task_id);
  }

  /** 查询未完成的前置依赖任务清单。 */
  getUnfinishedDependencies(
    userId: string,
    taskId: string,
  ): Array<{ id: string; title: string; status: BusinessTaskStatus }> {
    return this.db.all<{ id: string; title: string; status: BusinessTaskStatus }>(
      `SELECT t.id, t.title, t.status
       FROM task_dependencies d
       JOIN tasks t ON d.depends_on_id = t.id AND d.user_id = t.user_id
       WHERE d.user_id = ? AND d.task_id = ? AND t.deleted_at IS NULL AND t.status != 'completed'
       ORDER BY d.id ASC`,
      [userId, taskId],
    );
  }

  /** 判断指定任务的所有前置依赖是否都已 completed。 */
  areDependenciesSatisfied(userId: string, taskId: string): boolean {
    const unfinished = this.getUnfinishedDependencies(userId, taskId);
    return unfinished.length === 0;
  }

  /** 检查是否有任何前置依赖进入 failed 终态。 */
  getFailedDependencies(
    userId: string,
    taskId: string,
  ): Array<{ id: string; title: string; status: BusinessTaskStatus }> {
    return this.db.all<{ id: string; title: string; status: BusinessTaskStatus }>(
      `SELECT t.id, t.title, t.status
       FROM task_dependencies d
       JOIN tasks t ON d.depends_on_id = t.id AND d.user_id = t.user_id
       WHERE d.user_id = ? AND d.task_id = ? AND t.deleted_at IS NULL AND t.status = 'failed'
       ORDER BY d.id ASC`,
      [userId, taskId],
    );
  }
}
