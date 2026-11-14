/** 正式记忆库 CRUD。所有 SQL 均强制携带 user_id 条件，实现严格用户隔离。 */
import { randomUUID } from 'node:crypto';
import { Database } from './db';
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type Memory,
  type MemoryCategory,
  type MemoryFilters,
  type MemoryPatch,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type NewMemory,
} from './types';

function clampConfidence(value: number | undefined): number {
  const raw: number = typeof value === 'number' && Number.isFinite(value) ? value : 0.8;
  return Math.min(1, Math.max(0, raw));
}

function normalizeType(value: unknown): MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType) ? (value as MemoryType) : 'semantic';
}

function normalizeScope(value: unknown): MemoryScope {
  return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : 'personal';
}

export function normalizeMemoryCategory(value: unknown): MemoryCategory {
  return MEMORY_CATEGORIES.includes(value as MemoryCategory)
    ? (value as MemoryCategory)
    : 'general';
}

export function normalizeMemoryStatus(value: unknown): MemoryStatus {
  return MEMORY_STATUSES.includes(value as MemoryStatus) ? (value as MemoryStatus) : 'active';
}

export function parseEvidenceTrajectoryIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
      }
    } catch {
      return [];
    }
  }
  return [];
}

interface RawMemoryRow extends Omit<Memory, 'verified_by_user' | 'evidence_trajectory_ids'> {
  verified_by_user?: number | boolean;
  evidence_trajectory_ids?: string | string[];
}

function rowToMemory(row: RawMemoryRow): Memory {
  return {
    memory_id: row.memory_id,
    user_id: row.user_id,
    agent_id: row.agent_id ?? null,
    project_id: row.project_id ?? null,
    goal_id: row.goal_id ?? null,
    task_id: row.task_id ?? null,
    type: normalizeType(row.type),
    scope: normalizeScope(row.scope),
    category: normalizeMemoryCategory(row.category),
    status: normalizeMemoryStatus(row.status),
    content: row.content,
    source: row.source,
    confidence: Number(row.confidence),
    evidence_trajectory_ids: parseEvidenceTrajectoryIds(row.evidence_trajectory_ids),
    verified_by_user: Boolean(row.verified_by_user),
    expires_at: row.expires_at ?? null,
    superseded_by: row.superseded_by ?? null,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class MemoryStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  create(input: NewMemory): Memory {
    const now: string = new Date().toISOString();
    const status: MemoryStatus = normalizeMemoryStatus(input.status);
    const archivedAt: string | null = status === 'archived' || status === 'superseded' ? now : null;
    const evidenceIds: string[] = parseEvidenceTrajectoryIds(input.evidence_trajectory_ids);
    const memory: Memory = {
      memory_id: `mem_${randomUUID()}`,
      user_id: input.user_id,
      agent_id: input.agent_id ?? null,
      project_id: input.project_id ?? null,
      goal_id: input.goal_id ?? null,
      task_id: input.task_id ?? null,
      type: normalizeType(input.type),
      scope: normalizeScope(input.scope),
      category: normalizeMemoryCategory(input.category),
      status,
      content: input.content,
      source: input.source ?? 'api',
      confidence: clampConfidence(input.confidence),
      evidence_trajectory_ids: evidenceIds,
      verified_by_user: Boolean(input.verified_by_user),
      expires_at: input.expires_at ?? null,
      superseded_by: null,
      archived_at: archivedAt,
      created_at: now,
      updated_at: now,
    };
    this.db.run(
      `INSERT INTO memories
       (memory_id, user_id, agent_id, project_id, goal_id, task_id,
        type, scope, category, status, content, source, confidence,
        evidence_trajectory_ids, verified_by_user, expires_at, superseded_by, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.memory_id,
        memory.user_id,
        memory.agent_id,
        memory.project_id,
        memory.goal_id,
        memory.task_id,
        memory.type,
        memory.scope,
        memory.category,
        memory.status,
        memory.content,
        memory.source,
        memory.confidence,
        JSON.stringify(memory.evidence_trajectory_ids),
        memory.verified_by_user ? 1 : 0,
        memory.expires_at,
        memory.superseded_by,
        memory.archived_at,
        memory.created_at,
        memory.updated_at,
      ],
    );
    return memory;
  }

  /** 按 id 查询；不属于该用户的记忆返回 undefined（对外表现为 404）。 */
  getById(userId: string, memoryId: string): Memory | undefined {
    const row = this.db.get<RawMemoryRow>(
      'SELECT * FROM memories WHERE memory_id = ? AND user_id = ?',
      [memoryId, userId],
    );
    return row ? rowToMemory(row) : undefined;
  }

  list(userId: string, filters: MemoryFilters = {}): Memory[] {
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(filters.status);
    } else if (!filters.include_archived) {
      conditions.push("status = 'active'");
    }
    if (filters.agent_id !== undefined) {
      conditions.push('agent_id = ?');
      params.push(filters.agent_id);
    }
    if (filters.project_id !== undefined) {
      conditions.push('project_id = ?');
      params.push(filters.project_id);
    }
    if (filters.goal_id !== undefined) {
      conditions.push('goal_id = ?');
      params.push(filters.goal_id);
    }
    if (filters.task_id !== undefined) {
      conditions.push('task_id = ?');
      params.push(filters.task_id);
    }
    if (filters.type !== undefined) {
      conditions.push('type = ?');
      params.push(filters.type);
    }
    if (filters.scope !== undefined) {
      conditions.push('scope = ?');
      params.push(filters.scope);
    }
    if (filters.category !== undefined) {
      conditions.push('category = ?');
      params.push(filters.category);
    }
    const limit: number = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset: number = Math.max(filters.offset ?? 0, 0);
    const sql: string = `SELECT * FROM memories WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    return this.db.all<RawMemoryRow>(sql, [...params, limit, offset]).map(rowToMemory);
  }

  /** 检索用的候选集合：默认仅返回 active 记录，按 user_id 隔离。 */
  allForUser(userId: string, includeInactive = false): Memory[] {
    const sql = includeInactive
      ? 'SELECT * FROM memories WHERE user_id = ?'
      : "SELECT * FROM memories WHERE user_id = ? AND status = 'active'";
    return this.db.all<RawMemoryRow>(sql, [userId]).map(rowToMemory);
  }

  update(userId: string, memoryId: string, patch: MemoryPatch): Memory | undefined {
    const existing: Memory | undefined = this.getById(userId, memoryId);
    if (!existing) return undefined;

    const assignments: string[] = [];
    const params: unknown[] = [];
    const allowed: Array<keyof MemoryPatch> = [
      'content',
      'type',
      'scope',
      'category',
      'status',
      'agent_id',
      'project_id',
      'goal_id',
      'task_id',
      'source',
      'confidence',
      'evidence_trajectory_ids',
      'verified_by_user',
      'expires_at',
      'superseded_by',
      'archived_at',
    ];
    for (const field of allowed) {
      if (!(field in patch)) continue;
      const value: unknown = patch[field];
      assignments.push(`${field} = ?`);
      if (field === 'type') params.push(normalizeType(value));
      else if (field === 'scope') params.push(normalizeScope(value));
      else if (field === 'category') params.push(normalizeMemoryCategory(value));
      else if (field === 'status') params.push(normalizeMemoryStatus(value));
      else if (field === 'confidence') params.push(clampConfidence(value as number));
      else if (field === 'evidence_trajectory_ids') params.push(JSON.stringify(parseEvidenceTrajectoryIds(value)));
      else if (field === 'verified_by_user') params.push(value ? 1 : 0);
      else params.push(value === undefined ? null : value);
    }
    if (
      (patch.status === 'archived' || patch.status === 'superseded') &&
      !('archived_at' in patch)
    ) {
      assignments.push('archived_at = ?');
      params.push(new Date().toISOString());
    }
    assignments.push('updated_at = ?');
    params.push(new Date().toISOString(), memoryId, userId);
    this.db.run(
      `UPDATE memories SET ${assignments.join(', ')} WHERE memory_id = ? AND user_id = ?`,
      params,
    );
    return this.getById(userId, memoryId);
  }

  archive(userId: string, memoryId: string, supersededBy?: string | null): Memory | undefined {
    const status: MemoryStatus = supersededBy ? 'superseded' : 'archived';
    return this.update(userId, memoryId, {
      status,
      superseded_by: supersededBy ?? null,
      archived_at: new Date().toISOString(),
    });
  }

  remove(userId: string, memoryId: string): boolean {
    return (
      this.db.run('DELETE FROM memories WHERE memory_id = ? AND user_id = ?', [
        memoryId,
        userId,
      ]).changes > 0
    );
  }

  count(userId: string, includeInactive = false): number {
    const sql = includeInactive
      ? 'SELECT COUNT(*) AS total FROM memories WHERE user_id = ?'
      : "SELECT COUNT(*) AS total FROM memories WHERE user_id = ? AND status = 'active'";
    const row = this.db.get<{ total: number }>(sql, [userId]);
    return Number(row?.total ?? 0);
  }

  countMatching(userId: string, filters: MemoryFilters = {}): number {
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(filters.status);
    } else if (!filters.include_archived) {
      conditions.push("status = 'active'");
    }
    if (filters.agent_id !== undefined) {
      conditions.push('agent_id = ?');
      params.push(filters.agent_id);
    }
    if (filters.project_id !== undefined) {
      conditions.push('project_id = ?');
      params.push(filters.project_id);
    }
    if (filters.goal_id !== undefined) {
      conditions.push('goal_id = ?');
      params.push(filters.goal_id);
    }
    if (filters.task_id !== undefined) {
      conditions.push('task_id = ?');
      params.push(filters.task_id);
    }
    if (filters.type !== undefined) {
      conditions.push('type = ?');
      params.push(filters.type);
    }
    if (filters.scope !== undefined) {
      conditions.push('scope = ?');
      params.push(filters.scope);
    }
    if (filters.category !== undefined) {
      conditions.push('category = ?');
      params.push(filters.category);
    }
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM memories WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return Number(row?.total ?? 0);
  }
}
