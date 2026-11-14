/** 对话轨迹存储：按 (user_id, request_id) 去重，按用户隔离。 */
import { randomUUID } from 'node:crypto';
import { Database } from './db';
import type { NewTrajectory, Trajectory } from './types';

export interface TrajectoryFilters {
  agent_id?: string;
  session_id?: string;
  limit?: number;
  offset?: number;
}

export interface TrajectoryPage {
  items: Trajectory[];
  total: number;
  limit: number;
  offset: number;
}

export interface SaveResult {
  inserted: boolean;
  record: Trajectory;
}

export class TrajectoryStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 仅在「当前用户 + 相同 request_id」已存在时返回原记录，避免重复保存与重复提取。
   * 查重必须带 user_id，否则跨用户 request_id 碰撞会泄漏他人轨迹并静默丢数据。
   */
  save(input: NewTrajectory): SaveResult {
    const existing: Trajectory | undefined = this.db.get<Trajectory>(
      'SELECT * FROM trajectories WHERE request_id = ? AND user_id = ?',
      [input.request_id, input.user_id],
    );
    if (existing) return { inserted: false, record: existing };

    const record: Trajectory = {
      id: `traj_${randomUUID()}`,
      request_id: input.request_id,
      user_id: input.user_id,
      agent_id: input.agent_id,
      session_id: input.session_id ?? null,
      task_id: input.task_id ?? null,
      project_id: input.project_id ?? null,
      model: input.model ?? '',
      request: input.request ?? '{}',
      response: input.response ?? '',
      status: input.status ?? 'ok',
      created_at: new Date().toISOString(),
    };
    try {
      this.db.run(
        `INSERT INTO trajectories
         (id, request_id, user_id, agent_id, session_id, task_id, project_id,
          model, request, response, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.request_id,
          record.user_id,
          record.agent_id,
          record.session_id,
          record.task_id,
          record.project_id,
          record.model,
          record.request,
          record.response,
          record.status,
          record.created_at,
        ],
      );
    } catch (error) {
      const raced: Trajectory | undefined = this.db.get<Trajectory>(
        'SELECT * FROM trajectories WHERE request_id = ? AND user_id = ?',
        [input.request_id, input.user_id],
      );
      if (raced) return { inserted: false, record: raced };
      throw error;
    }
    return { inserted: true, record };
  }

  list(userId: string, filters: TrajectoryFilters = {}): TrajectoryPage {
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filters.agent_id !== undefined) {
      conditions.push('agent_id = ?');
      params.push(filters.agent_id);
    }
    if (filters.session_id !== undefined) {
      conditions.push('session_id = ?');
      params.push(filters.session_id);
    }
    const where: string = conditions.join(' AND ');
    const limit: number = Math.min(Math.max(filters.limit ?? 20, 1), 200);
    const offset: number = Math.max(filters.offset ?? 0, 0);
    const totalRow = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM trajectories WHERE ${where}`,
      params,
    );
    const items: Trajectory[] = this.db.all<Trajectory>(
      `SELECT * FROM trajectories WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items, total: Number(totalRow?.total ?? 0), limit, offset };
  }

  getById(userId: string, id: string): Trajectory | undefined {
    return this.db.get<Trajectory>(
      'SELECT * FROM trajectories WHERE user_id = ? AND (id = ? OR request_id = ?)',
      [userId, id, id],
    );
  }

  findByIds(userId: string, ids: string[]): Trajectory[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.all<Trajectory>(
      `SELECT * FROM trajectories WHERE user_id = ? AND (id IN (${placeholders}) OR request_id IN (${placeholders}))`,
      [userId, ...ids, ...ids],
    );
  }
}
