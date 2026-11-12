/**
 * Goal Management 持久化（goals + goal_projects 同用户 M:N 关联）。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db';
import {
  DomainError,
  GOAL_STATUSES,
  type EnsureUserOptions,
  type Goal,
  type GoalFilters,
  type GoalPatch,
  type GoalStatus,
  type NewGoalInput,
  type PageResult,
  type PriorityLevel,
  type Project,
} from './types';
import type { UserProfileStore } from './user-profile-store';

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

function normalizeGoalStatus(value: unknown, fallback: GoalStatus = 'active'): GoalStatus {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && GOAL_STATUSES.includes(value as GoalStatus)) {
    return value as GoalStatus;
  }
  throw new DomainError(400, 'invalid_status', `Goal status 必须为 ${GOAL_STATUSES.join(' | ')}`);
}

function rowToGoal(row: Goal): Goal {
  return {
    ...row,
    priority: Number(row.priority) as PriorityLevel,
    target_date: row.target_date ?? null,
    deleted_at: row.deleted_at ?? null,
  };
}

export class GoalStore {
  constructor(
    private readonly db: Database,
    private readonly userProfiles: UserProfileStore,
  ) {}

  create(userId: string, input: NewGoalInput, userOptions?: EnsureUserOptions): Goal {
    const title: string = normalizeTitle(input.title);
    const description: string =
      typeof input.description === 'string' ? input.description.slice(0, 4000) : '';
    const status: GoalStatus = normalizeGoalStatus(input.status, 'active');
    const priority: PriorityLevel = normalizePriority(input.priority);
    const targetDate: string | null =
      input.target_date === undefined || input.target_date === null || input.target_date === ''
        ? null
        : String(input.target_date).trim().slice(0, 64);

    return this.db.transaction((): Goal => {
      this.userProfiles.ensureUserInTx(userId, userOptions);
      const now: string = new Date().toISOString();
      const id: string = `goal_${randomUUID()}`;

      this.db.run(
        `INSERT INTO goals
           (id, user_id, title, description, status, priority, target_date, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [id, userId, title, description, status, priority, targetDate, now, now],
      );

      if (Array.isArray(input.project_ids)) {
        const seen = new Set<string>();
        for (const rawProjId of input.project_ids) {
          if (typeof rawProjId !== 'string' || rawProjId.trim() === '') continue;
          const projId: string = rawProjId.trim();
          if (seen.has(projId)) continue;
          seen.add(projId);
          this.linkProjectInTx(userId, id, projId, now);
        }
      }

      return this.get(userId, id) as Goal;
    });
  }

  get(userId: string, goalId: string): Goal | undefined {
    const row = this.db.get<Goal>(
      'SELECT * FROM goals WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [goalId, userId],
    );
    return row ? rowToGoal(row) : undefined;
  }

  list(userId: string, filters: GoalFilters = {}): PageResult<Goal> {
    const conditions: string[] = ['user_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [userId];
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(normalizeGoalStatus(filters.status));
    }
    const where: string = conditions.join(' AND ');
    const limit: number = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset: number = Math.max(filters.offset ?? 0, 0);

    const totalRow = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM goals WHERE ${where}`,
      params,
    );
    const items: Goal[] = this.db
      .all<Goal>(
        `SELECT * FROM goals WHERE ${where} ORDER BY priority DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )
      .map(rowToGoal);

    return { items, total: Number(totalRow?.total ?? 0), limit, offset };
  }

  update(userId: string, goalId: string, patch: GoalPatch): Goal | undefined {
    return this.db.transaction((): Goal | undefined => {
      const existing: Goal | undefined = this.get(userId, goalId);
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
        params.push(patch.description.slice(0, 4000));
      }
      if ('status' in patch) {
        assignments.push('status = ?');
        params.push(normalizeGoalStatus(patch.status));
      }
      if ('priority' in patch) {
        assignments.push('priority = ?');
        params.push(normalizePriority(patch.priority));
      }
      if ('target_date' in patch) {
        const val = patch.target_date;
        assignments.push('target_date = ?');
        params.push(val === null || val === '' ? null : String(val).trim().slice(0, 64));
      }

      if (assignments.length === 0) return existing;

      assignments.push('updated_at = ?');
      params.push(new Date().toISOString(), goalId, userId);
      this.db.run(
        `UPDATE goals SET ${assignments.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        params,
      );
      return this.get(userId, goalId);
    });
  }

  softDelete(userId: string, goalId: string): boolean {
    const now: string = new Date().toISOString();
    const res = this.db.run(
      'UPDATE goals SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [now, now, goalId, userId],
    );
    return res.changes > 0;
  }

  linkProject(userId: string, goalId: string, projectId: string): void {
    this.db.transaction((): void => {
      this.linkProjectInTx(userId, goalId, projectId, new Date().toISOString());
    });
  }

  linkProjectInTx(userId: string, goalId: string, projectId: string, now: string): void {
    const goal = this.db.get<{ id: string }>(
      'SELECT id FROM goals WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [goalId, userId],
    );
    if (!goal) {
      throw new DomainError(404, 'not_found', 'Goal 不存在或无权访问');
    }
    const project = this.db.get<{ id: string }>(
      'SELECT id FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [projectId, userId],
    );
    if (!project) {
      throw new DomainError(404, 'not_found', 'Project 不存在或无权访问');
    }
    this.db.run(
      `INSERT OR IGNORE INTO goal_projects (goal_id, project_id, user_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [goalId, projectId, userId, now],
    );
  }

  unlinkProject(userId: string, goalId: string, projectId: string): boolean {
    const res = this.db.run(
      'DELETE FROM goal_projects WHERE goal_id = ? AND project_id = ? AND user_id = ?',
      [goalId, projectId, userId],
    );
    return res.changes > 0;
  }

  listProjectsForGoal(userId: string, goalId: string): Project[] {
    return this.db.all<Project>(
      `SELECT p.*
         FROM projects p
         JOIN goal_projects gp ON gp.project_id = p.id AND gp.user_id = p.user_id
        WHERE gp.goal_id = ? AND gp.user_id = ? AND p.deleted_at IS NULL
        ORDER BY p.updated_at DESC, p.id DESC`,
      [goalId, userId],
    );
  }
}
