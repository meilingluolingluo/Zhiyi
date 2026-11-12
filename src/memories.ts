/** 正式记忆库 CRUD。所有 SQL 均强制携带 user_id 条件，实现严格用户隔离。 */
import { randomUUID } from 'node:crypto';
import { Database } from './db';
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type Memory,
  type MemoryFilters,
  type MemoryPatch,
  type MemoryScope,
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

function rowToMemory(row: Memory): Memory {
  return {
    memory_id: row.memory_id,
    user_id: row.user_id,
    agent_id: row.agent_id ?? null,
    project_id: row.project_id ?? null,
    type: row.type,
    scope: row.scope,
    content: row.content,
    source: row.source,
    confidence: Number(row.confidence),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class MemoryStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: NewMemory): Memory {
    const now: string = new Date().toISOString();
    const memory: Memory = {
      memory_id: `mem_${randomUUID()}`,
      user_id: input.user_id,
      agent_id: input.agent_id ?? null,
      project_id: input.project_id ?? null,
      type: normalizeType(input.type),
      scope: normalizeScope(input.scope),
      content: input.content,
      source: input.source ?? 'api',
      confidence: clampConfidence(input.confidence),
      created_at: now,
      updated_at: now,
    };
    this.db.run(
      `INSERT INTO memories
       (memory_id, user_id, agent_id, project_id, type, scope, content, source, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.memory_id,
        memory.user_id,
        memory.agent_id,
        memory.project_id,
        memory.type,
        memory.scope,
        memory.content,
        memory.source,
        memory.confidence,
        memory.created_at,
        memory.updated_at,
      ],
    );
    return memory;
  }

  /** 按 id 查询；不属于该用户的记忆返回 undefined（对外表现为 404）。 */
  getById(userId: string, memoryId: string): Memory | undefined {
    const row = this.db.get<Memory>(
      'SELECT * FROM memories WHERE memory_id = ? AND user_id = ?',
      [memoryId, userId],
    );
    return row ? rowToMemory(row) : undefined;
  }

  list(userId: string, filters: MemoryFilters = {}): Memory[] {
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filters.agent_id !== undefined) {
      conditions.push('agent_id = ?');
      params.push(filters.agent_id);
    }
    if (filters.project_id !== undefined) {
      conditions.push('project_id = ?');
      params.push(filters.project_id);
    }
    if (filters.type !== undefined) {
      conditions.push('type = ?');
      params.push(filters.type);
    }
    if (filters.scope !== undefined) {
      conditions.push('scope = ?');
      params.push(filters.scope);
    }
    const limit: number = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset: number = Math.max(filters.offset ?? 0, 0);
    const sql: string = `SELECT * FROM memories WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    return this.db.all<Memory>(sql, [...params, limit, offset]).map(rowToMemory);
  }

  /** 检索用的候选集合：仅当前用户，不附加其它过滤条件。 */
  allForUser(userId: string): Memory[] {
    return this.db
      .all<Memory>('SELECT * FROM memories WHERE user_id = ?', [userId])
      .map(rowToMemory);
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
      'agent_id',
      'project_id',
      'source',
      'confidence',
    ];
    for (const field of allowed) {
      if (!(field in patch)) continue;
      const value: unknown = patch[field];
      assignments.push(`${field} = ?`);
      if (field === 'type') params.push(normalizeType(value));
      else if (field === 'scope') params.push(normalizeScope(value));
      else if (field === 'confidence') params.push(clampConfidence(value as number));
      else params.push(value === undefined ? null : value);
    }
    assignments.push('updated_at = ?');
    params.push(new Date().toISOString(), memoryId, userId);
    this.db.run(
      `UPDATE memories SET ${assignments.join(', ')} WHERE memory_id = ? AND user_id = ?`,
      params,
    );
    return this.getById(userId, memoryId);
  }

  remove(userId: string, memoryId: string): boolean {
    return (
      this.db.run('DELETE FROM memories WHERE memory_id = ? AND user_id = ?', [
        memoryId,
        userId,
      ]).changes > 0
    );
  }

  count(userId: string): number {
    const row = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM memories WHERE user_id = ?',
      [userId],
    );
    return Number(row?.total ?? 0);
  }
}
