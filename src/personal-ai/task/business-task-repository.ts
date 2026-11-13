/**
 * 业务任务（tasks 表）持久化：同用户复合约束校验、同事务父子环检测（深度上限 10）、
 * CAS 状态机守卫、软删除与崩溃孤儿对账。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db';
import {
  BUSINESS_TASK_STATUSES,
  DomainError,
  INITIAL_TASK_STATUSES,
  type BusinessTask,
  type BusinessTaskFilters,
  type BusinessTaskPatch,
  type BusinessTaskStatus,
  type EnsureUserOptions,
  type NewBusinessTaskInput,
  type PageResult,
  type PriorityLevel,
  type SubtaskStats,
} from '../domain/types';
import type { UserProfileStore } from '../domain/user-profile-store';
import type { TaskRepository } from './task-repository';

export const MAX_TASK_DEPTH = 10;

const MANUAL_PATCH_TRANSITIONS: Readonly<Record<BusinessTaskStatus, readonly BusinessTaskStatus[]>> = {
  draft: ['draft', 'pending', 'ready', 'assigned', 'blocked'],
  pending: ['pending', 'ready', 'assigned', 'blocked'],
  ready: ['pending', 'ready', 'assigned', 'blocked'],
  assigned: ['pending', 'ready', 'assigned', 'blocked'],
  in_progress: [],
  blocked: ['pending', 'ready', 'assigned', 'blocked'],
  completed: [],
  failed: [],
  cancelled: [],
};

function normalizePriority(value: number | undefined): PriorityLevel {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new DomainError(400, 'invalid_priority', 'priority 必须为 0-4 的整数');
  }
  return value as PriorityLevel;
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError(400, 'invalid_title', 'title 不能为空');
  }
  const trimmed: string = value.trim();
  if (trimmed.length > 200) {
    throw new DomainError(400, 'invalid_title', 'title 长度不能超过 200');
  }
  return trimmed;
}

function rowToTask(row: BusinessTask): BusinessTask {
  return {
    ...row,
    project_id: row.project_id ?? null,
    parent_task_id: row.parent_task_id ?? null,
    priority: Number(row.priority) as PriorityLevel,
    assignee_agent_id: row.assignee_agent_id ?? null,
    due_at: row.due_at ?? null,
    deleted_at: row.deleted_at ?? null,
  };
}

export class BusinessTaskRepository {
  constructor(
    private readonly db: Database,
    private readonly userProfiles: UserProfileStore,
    private readonly taskRepo: TaskRepository,
  ) {}

  hasOwnedActiveProjectInTx(userId: string, projectId: string): boolean {
    const row = this.db.get<{ id: string }>(
      'SELECT id FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [projectId, userId],
    );
    return row !== undefined;
  }

  private assertOwnedProjectInTx(userId: string, projectId: string): void {
    if (!this.hasOwnedActiveProjectInTx(userId, projectId)) {
      throw new DomainError(404, 'not_found', '关联项目不存在或无权访问');
    }
  }

  private assertActiveAgentInTx(agentId: string): void {
    const row = this.db.get<{ agent_id: string; status: string }>(
      'SELECT agent_id, status FROM agents WHERE agent_id = ?',
      [agentId],
    );
    if (!row) {
      throw new DomainError(404, 'agent_not_found', `Agent ${agentId} 不存在`);
    }
    if (row.status !== 'active') {
      throw new DomainError(409, 'agent_disabled', `Agent ${agentId} 已禁用`);
    }
  }

  private measureSubtreeDepthInTx(
    userId: string,
    rootId: string,
    visited: Set<string>,
  ): number {
    let maxHeight = 1;
    const queue: Array<{ id: string; height: number }> = [{ id: rootId, height: 1 }];
    while (queue.length > 0) {
      const current = queue.shift() as { id: string; height: number };
      const children = this.db.all<{ id: string }>(
        'SELECT id FROM tasks WHERE parent_task_id = ? AND user_id = ? AND deleted_at IS NULL',
        [current.id, userId],
      );
      for (const child of children) {
        if (visited.has(child.id)) {
          throw new DomainError(409, 'task_cycle_detected', '检测到父子任务循环引用');
        }
        visited.add(child.id);
        const nextHeight: number = current.height + 1;
        if (nextHeight > maxHeight) maxHeight = nextHeight;
        queue.push({ id: child.id, height: nextHeight });
      }
    }
    return maxHeight;
  }

  /**
   * 在当前事务内校验父子任务无环且整条链路深度不超过 MAX_TASK_DEPTH（10 层）。
   */
  private validateParentInTx(
    userId: string,
    taskId: string,
    parentTaskId: string,
    isExistingTask: boolean,
  ): void {
    if (parentTaskId === taskId) {
      throw new DomainError(409, 'task_cycle_detected', '任务不能将自身设为父任务');
    }
    const visited = new Set<string>([taskId]);
    let ancestorDepth = 0;
    let cursor: string | null = parentTaskId;

    while (cursor !== null) {
      if (visited.has(cursor)) {
        throw new DomainError(409, 'task_cycle_detected', '检测到父子任务循环引用');
      }
      ancestorDepth += 1;
      if (ancestorDepth >= MAX_TASK_DEPTH) {
        throw new DomainError(
          400,
          'task_depth_exceeded',
          `父子任务嵌套深度不能超过 ${MAX_TASK_DEPTH} 层`,
        );
      }
      visited.add(cursor);

      const parent:
        | {
            id: string;
            user_id: string;
            parent_task_id: string | null;
            deleted_at: string | null;
          }
        | undefined = this.db.get<{
        id: string;
        user_id: string;
        parent_task_id: string | null;
        deleted_at: string | null;
      }>('SELECT id, user_id, parent_task_id, deleted_at FROM tasks WHERE id = ?', [cursor]);

      if (!parent || parent.user_id !== userId || parent.deleted_at !== null) {
        throw new DomainError(404, 'not_found', '父任务不存在或无权访问');
      }
      cursor = parent.parent_task_id;
    }

    if (isExistingTask) {
      const subtreeHeight: number = this.measureSubtreeDepthInTx(userId, taskId, visited);
      if (ancestorDepth + subtreeHeight > MAX_TASK_DEPTH) {
        throw new DomainError(
          400,
          'task_depth_exceeded',
          `父子任务嵌套深度不能超过 ${MAX_TASK_DEPTH} 层`,
        );
      }
    }
  }

  createInTx(userId: string, input: NewBusinessTaskInput, userOptions?: EnsureUserOptions): BusinessTask {
    const title: string = normalizeTitle(input.title);
    const description: string =
      typeof input.description === 'string' ? input.description.slice(0, 8000) : '';
    const priority: PriorityLevel = normalizePriority(input.priority);
    const rawStatus: unknown = input.status;
    let status: BusinessTaskStatus = 'pending';
    if (rawStatus !== undefined) {
      if (typeof rawStatus !== 'string' || !INITIAL_TASK_STATUSES.includes(rawStatus as BusinessTaskStatus)) {
        throw new DomainError(
          400,
          'invalid_initial_status',
          `创建任务仅允许初始状态 ${INITIAL_TASK_STATUSES.join(' | ')}`,
        );
      }
      status = rawStatus as BusinessTaskStatus;
    }

    const assigneeAgentId: string | null =
      input.assignee_agent_id === undefined ||
      input.assignee_agent_id === null ||
      input.assignee_agent_id === ''
        ? null
        : String(input.assignee_agent_id).trim();
    if (status === 'assigned' && !assigneeAgentId) {
      throw new DomainError(400, 'missing_assignee', '创建状态为 assigned 的任务必须指定 assignee_agent_id');
    }

    const projectId: string | null =
      input.project_id === undefined || input.project_id === null || input.project_id === ''
        ? null
        : String(input.project_id).trim();
    const parentTaskId: string | null =
      input.parent_task_id === undefined ||
      input.parent_task_id === null ||
      input.parent_task_id === ''
        ? null
        : String(input.parent_task_id).trim();
    const dueAt: string | null =
      input.due_at === undefined || input.due_at === null || input.due_at === ''
        ? null
        : String(input.due_at).trim().slice(0, 64);

    this.userProfiles.ensureUserInTx(userId, userOptions);
    if (projectId) this.assertOwnedProjectInTx(userId, projectId);
    if (assigneeAgentId) this.assertActiveAgentInTx(assigneeAgentId);

    const id: string = `btask_${randomUUID()}`;
    if (parentTaskId) this.validateParentInTx(userId, id, parentTaskId, false);

    const now: string = new Date().toISOString();
    this.db.run(
      `INSERT INTO tasks
         (id, user_id, project_id, parent_task_id, title, description, status, priority,
          assignee_agent_id, due_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        userId,
        projectId,
        parentTaskId,
        title,
        description,
        status,
        priority,
        assigneeAgentId,
        dueAt,
        now,
        now,
      ],
    );
    return this.getActive(userId, id) as BusinessTask;
  }

  create(userId: string, input: NewBusinessTaskInput, userOptions?: EnsureUserOptions): BusinessTask {
    return this.db.transaction((): BusinessTask => this.createInTx(userId, input, userOptions));
  }

  getActive(userId: string, taskId: string): BusinessTask | undefined {
    const row = this.db.get<BusinessTask>(
      'SELECT * FROM tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [taskId, userId],
    );
    return row ? rowToTask(row) : undefined;
  }

  getByIdInternal(taskId: string): BusinessTask | undefined {
    const row = this.db.get<BusinessTask>(
      'SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL',
      [taskId],
    );
    return row ? rowToTask(row) : undefined;
  }

  list(userId: string, filters: BusinessTaskFilters = {}): PageResult<BusinessTask> {
    const conditions: string[] = ['user_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [userId];

    if (filters.project_id !== undefined) {
      conditions.push('project_id = ?');
      params.push(filters.project_id);
    }
    if (filters.status !== undefined) {
      if (!BUSINESS_TASK_STATUSES.includes(filters.status)) {
        throw new DomainError(400, 'invalid_status', '非法的任务状态过滤条件');
      }
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.parent_task_id !== undefined) {
      if (filters.parent_task_id === null) {
        conditions.push('parent_task_id IS NULL');
      } else {
        conditions.push('parent_task_id = ?');
        params.push(filters.parent_task_id);
      }
    }

    const where: string = conditions.join(' AND ');
    const limit: number = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset: number = Math.max(filters.offset ?? 0, 0);

    const totalRow = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM tasks WHERE ${where}`,
      params,
    );
    const items: BusinessTask[] = this.db
      .all<BusinessTask>(
        `SELECT * FROM tasks WHERE ${where} ORDER BY priority DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )
      .map(rowToTask);

    return { items, total: Number(totalRow?.total ?? 0), limit, offset };
  }

  listSubtasks(userId: string, parentTaskId: string): BusinessTask[] {
    return this.db
      .all<BusinessTask>(
        `SELECT * FROM tasks
          WHERE user_id = ? AND parent_task_id = ? AND deleted_at IS NULL
          ORDER BY priority DESC, created_at ASC, id ASC`,
        [userId, parentTaskId],
      )
      .map(rowToTask);
  }

  subtaskStats(subtasks: readonly BusinessTask[]): SubtaskStats {
    const stats: SubtaskStats = {
      total: subtasks.length,
      completed: 0,
      in_progress: 0,
      failed: 0,
      cancelled: 0,
      pending: 0,
    };
    for (const item of subtasks) {
      if (item.status === 'completed') stats.completed += 1;
      else if (item.status === 'in_progress') stats.in_progress += 1;
      else if (item.status === 'failed') stats.failed += 1;
      else if (item.status === 'cancelled') stats.cancelled += 1;
      else stats.pending += 1;
    }
    return stats;
  }

  update(userId: string, taskId: string, patch: BusinessTaskPatch): BusinessTask | undefined {
    return this.db.transaction((): BusinessTask | undefined => {
      const existing: BusinessTask | undefined = this.getActive(userId, taskId);
      if (!existing) return undefined;

      const assignments: string[] = [];
      const params: unknown[] = [];

      if ('title' in patch) {
        assignments.push('title = ?');
        params.push(normalizeTitle(patch.title));
      }
      if ('description' in patch) {
        if (typeof patch.description !== 'string') {
          throw new DomainError(400, 'invalid_description', 'description 必须为字符串');
        }
        assignments.push('description = ?');
        params.push(patch.description.slice(0, 8000));
      }
      if ('priority' in patch) {
        assignments.push('priority = ?');
        params.push(normalizePriority(patch.priority));
      }
      if ('due_at' in patch) {
        const val = patch.due_at;
        assignments.push('due_at = ?');
        params.push(val === null || val === '' ? null : String(val).trim().slice(0, 64));
      }
      if ('project_id' in patch) {
        const val = patch.project_id;
        if (val === null || val === '') {
          assignments.push('project_id = ?');
          params.push(null);
        } else {
          const projectId: string = String(val).trim();
          this.assertOwnedProjectInTx(userId, projectId);
          assignments.push('project_id = ?');
          params.push(projectId);
        }
      }
      if ('parent_task_id' in patch) {
        const val = patch.parent_task_id;
        if (val === null || val === '') {
          assignments.push('parent_task_id = ?');
          params.push(null);
        } else {
          const parentId: string = String(val).trim();
          this.validateParentInTx(userId, taskId, parentId, true);
          assignments.push('parent_task_id = ?');
          params.push(parentId);
        }
      }

      let nextAssignee: string | null = existing.assignee_agent_id;
      if ('assignee_agent_id' in patch) {
        const val = patch.assignee_agent_id;
        if (val === null || val === '') {
          nextAssignee = null;
        } else {
          nextAssignee = String(val).trim();
          this.assertActiveAgentInTx(nextAssignee);
        }
        assignments.push('assignee_agent_id = ?');
        params.push(nextAssignee);
      }

      let expectedCurrentStatus: BusinessTaskStatus | null = null;
      if ('status' in patch) {
        const target: unknown = patch.status;
        if (typeof target !== 'string' || !BUSINESS_TASK_STATUSES.includes(target as BusinessTaskStatus)) {
          throw new DomainError(400, 'invalid_status', '非法的任务状态');
        }
        const targetStatus = target as BusinessTaskStatus;

        if (targetStatus === 'cancelled') {
          throw new DomainError(
            409,
            'use_cancel_endpoint',
            'cancelled 状态只能通过专门取消接口触发',
            'conflict',
          );
        }
        if (this.taskRepo.hasActiveByTaskId(taskId)) {
          throw new DomainError(
            409,
            'active_execution_exists',
            '存在活跃 Execution 时禁止通过 PATCH 修改任务状态',
            'conflict',
          );
        }
        if (targetStatus === 'in_progress') {
          throw new DomainError(
            409,
            'use_execute_endpoint',
            'in_progress 只能由执行接口创建 Execution 后进入',
            'conflict',
          );
        }
        if (targetStatus === 'completed' || targetStatus === 'failed') {
          throw new DomainError(
            409,
            'managed_by_execution',
            `${targetStatus} 状态只能由 Execution 终态同步触发`,
            'conflict',
          );
        }

        const allowed: readonly BusinessTaskStatus[] = MANUAL_PATCH_TRANSITIONS[existing.status];
        if (!allowed.includes(targetStatus)) {
          throw new DomainError(
            409,
            'invalid_status_transition',
            `不允许从 ${existing.status} 手工变更为 ${targetStatus}`,
            'conflict',
          );
        }
        if (targetStatus === 'assigned' && !nextAssignee) {
          throw new DomainError(400, 'missing_assignee', '变更为 assigned 状态时必须指定 assignee_agent_id');
        }

        expectedCurrentStatus = existing.status;
        assignments.push('status = ?');
        params.push(targetStatus);
      }

      if (assignments.length === 0) return existing;

      assignments.push('updated_at = ?');
      params.push(new Date().toISOString(), taskId, userId);

      const whereStatus: string = expectedCurrentStatus ? ' AND status = ?' : '';
      if (expectedCurrentStatus) params.push(expectedCurrentStatus);

      const result = this.db.run(
        `UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL${whereStatus}`,
        params,
      );
      if (result.changes === 0) {
        throw new DomainError(409, 'status_conflict', '任务状态已被并发修改', 'conflict');
      }
      return this.getActive(userId, taskId);
    });
  }

  /**
   * 软删除业务 Task（永不硬删，完整保留 execution_tasks 历史）。
   * - 自身有活跃 Execution 或处于 in_progress 时禁止删除（409）；
   * - 存在未终结子任务时默认返回 409；cascade=true 时在无活跃子树 Execution 前提下连带取消并软删除。
   */
  softDelete(userId: string, taskId: string, cascade = false): boolean {
    return this.db.transaction((): boolean => {
      const root: BusinessTask | undefined = this.getActive(userId, taskId);
      if (!root) return false;

      if (root.status === 'in_progress' || this.taskRepo.hasActiveByTaskId(root.id)) {
        throw new DomainError(
          409,
          'active_execution_exists',
          '任务存在活跃 Execution，请先取消后再删除',
          'conflict',
        );
      }

      const subtree: BusinessTask[] = [root];
      const visited = new Set<string>([root.id]);
      const queue: string[] = [root.id];
      while (queue.length > 0) {
        const parentId: string = queue.shift() as string;
        const children = this.db
          .all<BusinessTask>(
            'SELECT * FROM tasks WHERE parent_task_id = ? AND user_id = ? AND deleted_at IS NULL',
            [parentId, userId],
          )
          .map(rowToTask);
        for (const child of children) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          subtree.push(child);
          queue.push(child.id);
        }
      }

      const descendants: BusinessTask[] = subtree.slice(1);
      const nonTerminalChildren = descendants.filter(
        (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled',
      );
      if (!cascade && nonTerminalChildren.length > 0) {
        throw new DomainError(
          409,
          'has_active_subtasks',
          '存在未终结子任务，请先处理子任务或使用 cascade=true',
          'conflict',
        );
      }

      for (const node of descendants) {
        if (node.status === 'in_progress' || this.taskRepo.hasActiveByTaskId(node.id)) {
          throw new DomainError(
            409,
            'active_subtask_execution',
            `子任务 ${node.id} 存在活跃 Execution，请先取消后再删除`,
            'conflict',
          );
        }
      }

      const now: string = new Date().toISOString();
      for (const node of subtree) {
        const nextStatus: BusinessTaskStatus =
          node.status === 'completed' || node.status === 'failed' || node.status === 'cancelled'
            ? node.status
            : 'cancelled';
        this.db.run(
          `UPDATE tasks
              SET deleted_at = ?, status = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
          [now, nextStatus, now, node.id, userId],
        );
      }
      return true;
    });
  }

  setAssigneeInTx(userId: string, taskId: string, agentId: string): void {
    this.db.run(
      `UPDATE tasks SET assignee_agent_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [agentId, new Date().toISOString(), taskId, userId],
    );
  }

  casStatusInTx(
    userId: string,
    taskId: string,
    expectedStatus: BusinessTaskStatus,
    nextStatus: BusinessTaskStatus,
  ): boolean {
    const res = this.db.run(
      `UPDATE tasks SET status = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status = ? AND deleted_at IS NULL`,
      [nextStatus, new Date().toISOString(), taskId, userId, expectedStatus],
    );
    return res.changes > 0;
  }

  casSyncTerminalInTx(
    taskId: string,
    terminalStatus: 'completed' | 'failed' | 'cancelled',
  ): boolean {
    const res = this.db.run(
      `UPDATE tasks SET status = ?, updated_at = ?
        WHERE id = ? AND status = 'in_progress' AND deleted_at IS NULL`,
      [terminalStatus, new Date().toISOString(), taskId],
    );
    return res.changes > 0;
  }

  /**
   * 崩溃启动对账：扫描仍停留在 in_progress 且已无活跃 Execution 的孤儿业务 Task，
   * 严格按 ORDER BY created_at DESC, id DESC 取最新一条 Execution 终态同步对齐。
   */
  reconcileOrphanedInProgressInTx(): number {
    const orphans = this.db.all<{ task_id: string; latest_status: string | null }>(`
      SELECT t.id AS task_id,
             (SELECT e.status
                FROM execution_tasks e
               WHERE e.task_id = t.id
               ORDER BY e.created_at DESC, e.rowid DESC, e.id DESC
               LIMIT 1) AS latest_status
        FROM tasks t
       WHERE t.status = 'in_progress'
         AND t.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM execution_tasks a
            WHERE a.task_id = t.id
              AND a.status IN ('pending', 'dispatching', 'running')
         )
    `);
    let reconciled = 0;
    for (const row of orphans) {
      if (
        row.latest_status === 'completed' ||
        row.latest_status === 'failed' ||
        row.latest_status === 'cancelled'
      ) {
        if (this.casSyncTerminalInTx(row.task_id, row.latest_status)) {
          reconciled += 1;
        }
      }
    }
    return reconciled;
  }
}
