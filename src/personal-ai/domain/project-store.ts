/**
 * Project Management 持久化（projects 实体 + 软删除 + 关联 Goal 查询）。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db';
import {
  DomainError,
  PROJECT_STATUSES,
  type EnsureUserOptions,
  type Goal,
  type NewProjectInput,
  type PageResult,
  type Project,
  type ProjectFilters,
  type ProjectPatch,
  type ProjectStatus,
} from './types';
import type { UserProfileStore } from './user-profile-store';

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

function normalizeProjectStatus(value: unknown, fallback: ProjectStatus = 'active'): ProjectStatus {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && PROJECT_STATUSES.includes(value as ProjectStatus)) {
    return value as ProjectStatus;
  }
  throw new DomainError(
    400,
    'invalid_status',
    `Project status 必须为 ${PROJECT_STATUSES.join(' | ')}`,
  );
}

function rowToProject(row: Project): Project {
  return {
    ...row,
    deleted_at: row.deleted_at ?? null,
  };
}

export class ProjectStore {
  constructor(
    private readonly db: Database,
    private readonly userProfiles: UserProfileStore,
  ) {}

  create(userId: string, input: NewProjectInput, userOptions?: EnsureUserOptions): Project {
    const title: string = normalizeTitle(input.title);
    const description: string =
      typeof input.description === 'string' ? input.description.slice(0, 4000) : '';
    const status: ProjectStatus = normalizeProjectStatus(input.status, 'active');

    return this.db.transaction((): Project => {
      this.userProfiles.ensureUserInTx(userId, userOptions);
      const now: string = new Date().toISOString();
      const id: string = `proj_${randomUUID()}`;

      this.db.run(
        `INSERT INTO projects
           (id, user_id, title, description, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        [id, userId, title, description, status, now, now],
      );

      if (Array.isArray(input.goal_ids)) {
        const seen = new Set<string>();
        for (const rawGoalId of input.goal_ids) {
          if (typeof rawGoalId !== 'string' || rawGoalId.trim() === '') continue;
          const goalId: string = rawGoalId.trim();
          if (seen.has(goalId)) continue;
          seen.add(goalId);
          const goal = this.db.get<{ id: string }>(
            'SELECT id FROM goals WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
            [goalId, userId],
          );
          if (!goal) {
            throw new DomainError(404, 'not_found', 'Goal 不存在或无权访问');
          }
          this.db.run(
            `INSERT OR IGNORE INTO goal_projects (goal_id, project_id, user_id, created_at)
             VALUES (?, ?, ?, ?)`,
            [goalId, id, userId, now],
          );
        }
      }

      return this.get(userId, id) as Project;
    });
  }

  get(userId: string, projectId: string): Project | undefined {
    const row = this.db.get<Project>(
      'SELECT * FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [projectId, userId],
    );
    return row ? rowToProject(row) : undefined;
  }

  list(userId: string, filters: ProjectFilters = {}): PageResult<Project> {
    const limit: number = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset: number = Math.max(filters.offset ?? 0, 0);

    if (filters.goal_id) {
      const conditions: string[] = [
        'p.user_id = ?',
        'p.deleted_at IS NULL',
        'gp.goal_id = ?',
        'gp.user_id = ?',
      ];
      const params: unknown[] = [userId, filters.goal_id, userId];
      if (filters.status !== undefined) {
        conditions.push('p.status = ?');
        params.push(normalizeProjectStatus(filters.status));
      }
      const where: string = conditions.join(' AND ');
      const totalRow = this.db.get<{ total: number }>(
        `SELECT COUNT(*) AS total
           FROM projects p
           JOIN goal_projects gp ON gp.project_id = p.id AND gp.user_id = p.user_id
          WHERE ${where}`,
        params,
      );
      const items: Project[] = this.db
        .all<Project>(
          `SELECT p.*
             FROM projects p
             JOIN goal_projects gp ON gp.project_id = p.id AND gp.user_id = p.user_id
            WHERE ${where}
            ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`,
          [...params, limit, offset],
        )
        .map(rowToProject);
      return { items, total: Number(totalRow?.total ?? 0), limit, offset };
    }

    const conditions: string[] = ['user_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [userId];
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(normalizeProjectStatus(filters.status));
    }
    const where: string = conditions.join(' AND ');
    const totalRow = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM projects WHERE ${where}`,
      params,
    );
    const items: Project[] = this.db
      .all<Project>(
        `SELECT * FROM projects WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )
      .map(rowToProject);
    return { items, total: Number(totalRow?.total ?? 0), limit, offset };
  }

  update(userId: string, projectId: string, patch: ProjectPatch): Project | undefined {
    return this.db.transaction((): Project | undefined => {
      const existing: Project | undefined = this.get(userId, projectId);
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
        params.push(normalizeProjectStatus(patch.status));
      }

      if (assignments.length === 0) return existing;

      assignments.push('updated_at = ?');
      params.push(new Date().toISOString(), projectId, userId);
      this.db.run(
        `UPDATE projects SET ${assignments.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        params,
      );
      return this.get(userId, projectId);
    });
  }

  /** 软删除 Project：保留历史 tasks.project_id 关联与 execution_tasks 审计，不级联删子数据。 */
  softDelete(userId: string, projectId: string): boolean {
    const now: string = new Date().toISOString();
    const res = this.db.run(
      'UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [now, now, projectId, userId],
    );
    return res.changes > 0;
  }

  listGoalsForProject(userId: string, projectId: string): Goal[] {
    return this.db.all<Goal>(
      `SELECT g.*
         FROM goals g
         JOIN goal_projects gp ON gp.goal_id = g.id AND gp.user_id = g.user_id
        WHERE gp.project_id = ? AND gp.user_id = ? AND g.deleted_at IS NULL
        ORDER BY g.priority DESC, g.updated_at DESC, g.id DESC`,
      [projectId, userId],
    );
  }
}
