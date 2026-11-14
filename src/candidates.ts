/** 候选记忆：自动提取与工作复盘产物，按用户审批或可信合并策略进入正式记忆库。 */
import { randomUUID } from 'node:crypto';
import { Database } from './db';
import { normalizeContent } from './extraction-rules';
import { normalizeMemoryCategory, parseEvidenceTrajectoryIds, type MemoryStore } from './memories';
import {
  evolveMemoryWriteInTx,
  findConflictingMemory,
  isDuplicateContent,
} from './memory-evolution';
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type CandidateStatus,
  type ExtractedCandidate,
  type Memory,
  type MemoryCandidate,
  type MemoryCategory,
  type MemoryScope,
  type MemoryType,
} from './types';

export interface NewCandidate {
  user_id: string;
  agent_id?: string | null;
  project_id?: string | null;
  goal_id?: string | null;
  task_id?: string | null;
  type: MemoryType;
  scope: MemoryScope;
  category?: MemoryCategory;
  content: string;
  source?: string;
  trajectory_id?: string | null;
  evidence_trajectory_ids?: string[];
  confidence: number;
  status?: CandidateStatus;
}

export interface CandidateFilters {
  status?: CandidateStatus;
  limit?: number;
  offset?: number;
}

export interface CreateResult {
  created: boolean;
  candidate?: MemoryCandidate;
}

export interface ApproveResult {
  ok: boolean;
  idempotent: boolean;
  reason?: string;
  memory?: Memory;
  candidate?: MemoryCandidate;
}

function normalizeType(value: unknown): MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType) ? (value as MemoryType) : 'semantic';
}

function normalizeScope(value: unknown): MemoryScope {
  return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : 'personal';
}

function rowToCandidate(row: MemoryCandidate & { evidence_trajectory_ids?: string | string[] }): MemoryCandidate {
  return {
    ...row,
    agent_id: row.agent_id ?? null,
    project_id: row.project_id ?? null,
    goal_id: row.goal_id ?? null,
    task_id: row.task_id ?? null,
    category: normalizeMemoryCategory(row.category),
    trajectory_id: row.trajectory_id ?? null,
    evidence_trajectory_ids: parseEvidenceTrajectoryIds(row.evidence_trajectory_ids),
    conflict_memory_id: row.conflict_memory_id ?? null,
    created_memory_id: row.created_memory_id ?? null,
    confidence: Number(row.confidence),
  };
}

export class CandidateStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 去重：与已有活跃正式记忆、待处理/已通过候选比较语义重复。
   */
  hasSimilar(userId: string, content: string, memoryStore: MemoryStore): boolean {
    const key: string = normalizeContent(content);
    if (key.length === 0) return true;
    const memories: Memory[] = memoryStore.allForUser(userId, false);
    for (const memory of memories) {
      if (isDuplicateContent(content, memory.content)) return true;
    }
    const rows: MemoryCandidate[] = this.db.all<MemoryCandidate>(
      `SELECT * FROM memory_candidates
       WHERE user_id = ? AND status IN ('pending', 'low_confidence', 'approved')`,
      [userId],
    );
    for (const row of rows) {
      if (isDuplicateContent(content, row.content)) return true;
    }
    return false;
  }

  create(input: NewCandidate, memoryStore: MemoryStore): CreateResult {
    if (this.hasSimilar(input.user_id, input.content, memoryStore)) {
      return { created: false };
    }
    const now: string = new Date().toISOString();
    const scope = normalizeScope(input.scope);
    const category = normalizeMemoryCategory(input.category);
    const conflict = findConflictingMemory(
      input.content,
      {
        scope,
        agent_id: input.agent_id ?? null,
        project_id: input.project_id ?? null,
        category,
      },
      memoryStore.allForUser(input.user_id, false),
    );
    const evidenceIds: string[] = [];
    if (input.trajectory_id && input.trajectory_id.trim() !== '') {
      evidenceIds.push(input.trajectory_id.trim());
    }
    if (Array.isArray(input.evidence_trajectory_ids)) {
      for (const id of input.evidence_trajectory_ids) {
        if (typeof id === 'string' && id.trim() !== '' && !evidenceIds.includes(id.trim())) {
          evidenceIds.push(id.trim());
        }
      }
    }
    const candidate: MemoryCandidate = {
      id: `cand_${randomUUID()}`,
      user_id: input.user_id,
      agent_id: input.agent_id ?? null,
      project_id: input.project_id ?? null,
      goal_id: input.goal_id ?? null,
      task_id: input.task_id ?? null,
      type: normalizeType(input.type),
      scope,
      category,
      content: input.content,
      source: input.source ?? 'auto-extract',
      trajectory_id: input.trajectory_id ?? null,
      evidence_trajectory_ids: evidenceIds,
      conflict_memory_id: conflict?.memory.memory_id ?? null,
      confidence: Math.min(1, Math.max(0, Number(input.confidence) || 0)),
      status: input.status ?? 'pending',
      created_memory_id: null,
      created_at: now,
      updated_at: now,
    };
    this.db.run(
      `INSERT INTO memory_candidates
       (id, user_id, agent_id, project_id, goal_id, task_id, type, scope, category, content, source,
        trajectory_id, evidence_trajectory_ids, conflict_memory_id, confidence, status, created_memory_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        candidate.id,
        candidate.user_id,
        candidate.agent_id,
        candidate.project_id,
        candidate.goal_id,
        candidate.task_id,
        candidate.type,
        candidate.scope,
        candidate.category,
        candidate.content,
        candidate.source,
        candidate.trajectory_id,
        JSON.stringify(candidate.evidence_trajectory_ids ?? []),
        candidate.conflict_memory_id,
        candidate.confidence,
        candidate.status,
        candidate.created_at,
        candidate.updated_at,
      ],
    );
    return { created: true, candidate };
  }

  get(userId: string, id: string): MemoryCandidate | undefined {
    const row = this.db.get<MemoryCandidate>(
      'SELECT * FROM memory_candidates WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    return row ? rowToCandidate(row) : undefined;
  }

  list(userId: string, filters: CandidateFilters = {}): MemoryCandidate[] {
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    const limit: number = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset: number = Math.max(filters.offset ?? 0, 0);
    return this.db
      .all<MemoryCandidate>(
        `SELECT * FROM memory_candidates WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )
      .map(rowToCandidate);
  }

  /**
   * 幂等审批入库：用户审批通过后标记 verified_by_user=true，并在同事务内处理去重合并与冲突替代。
   */
  approve(userId: string, id: string, memoryStore: MemoryStore): ApproveResult {
    return this.db.transaction((): ApproveResult => {
      const candidate: MemoryCandidate | undefined = this.get(userId, id);
      if (!candidate) return { ok: false, idempotent: false, reason: 'not_found' };
      if (candidate.status === 'approved') {
        const memory: Memory | undefined = candidate.created_memory_id
          ? memoryStore.getById(userId, candidate.created_memory_id)
          : undefined;
        return { ok: true, idempotent: true, memory, candidate };
      }
      if (candidate.status === 'rejected') {
        return { ok: false, idempotent: false, reason: 'rejected', candidate };
      }

      const evidenceTrajectoryIds: string[] = [];
      if (candidate.trajectory_id && candidate.trajectory_id.trim() !== '') {
        evidenceTrajectoryIds.push(candidate.trajectory_id.trim());
      }
      if (Array.isArray(candidate.evidence_trajectory_ids)) {
        for (const tid of candidate.evidence_trajectory_ids) {
          if (typeof tid === 'string' && tid.trim() !== '' && !evidenceTrajectoryIds.includes(tid.trim())) {
            evidenceTrajectoryIds.push(tid.trim());
          }
        }
      }

      const evolved = evolveMemoryWriteInTx(
        memoryStore,
        {
          user_id: userId,
          agent_id: candidate.agent_id,
          project_id: candidate.project_id,
          goal_id: candidate.goal_id,
          task_id: candidate.task_id,
          type: candidate.type,
          scope: candidate.scope,
          category: candidate.category,
          content: candidate.content,
          source: `candidate:${candidate.id}`,
          confidence: candidate.confidence,
          evidence_trajectory_ids: evidenceTrajectoryIds,
          verified_by_user: true,
        },
        { actor: 'user', supersedeConflicts: true },
      );

      if (evolved.action === 'conflict_blocked') {
        return { ok: false, idempotent: false, reason: 'conflict_blocked', candidate };
      }

      const memory = evolved.memory;
      this.db.run(
        `UPDATE memory_candidates
         SET status = 'approved', created_memory_id = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
        [memory.memory_id, new Date().toISOString(), id, userId],
      );
      return {
        ok: true,
        idempotent: false,
        memory,
        candidate: this.get(userId, id),
      };
    });
  }

  reject(userId: string, id: string): MemoryCandidate | undefined {
    const candidate: MemoryCandidate | undefined = this.get(userId, id);
    if (!candidate || candidate.status === 'approved') return undefined;
    this.db.run(
      `UPDATE memory_candidates SET status = 'rejected', updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [new Date().toISOString(), id, userId],
    );
    return this.get(userId, id);
  }

  /** 把模型/规则/任务复盘产出的候选批量落库，返回新建数量。 */
  createFromExtraction(
    items: ExtractedCandidate[],
    context: {
      user_id: string;
      agent_id: string | null;
      project_id: string | null;
      goal_id?: string | null;
      task_id?: string | null;
      trajectory_id: string | null;
      source: string;
      minConfidence: number;
    },
    memoryStore: MemoryStore,
  ): number {
    let created = 0;
    for (const item of items) {
      if (!item || typeof item.content !== 'string' || item.content.trim().length < 6) continue;
      const confidence: number = Number(item.confidence);
      if (!Number.isFinite(confidence)) continue;
      const result: CreateResult = this.create(
        {
          user_id: context.user_id,
          agent_id: context.agent_id,
          project_id: context.project_id ?? null,
          goal_id: context.goal_id ?? null,
          task_id: context.task_id ?? null,
          type: normalizeType(item.type),
          scope: normalizeScope(item.scope),
          category: normalizeMemoryCategory(item.category),
          content: item.content.trim(),
          source: context.source,
          trajectory_id: context.trajectory_id,
          confidence,
          status: confidence < context.minConfidence ? 'low_confidence' : 'pending',
        },
        memoryStore,
      );
      if (result.created) created += 1;
    }
    return created;
  }
}
