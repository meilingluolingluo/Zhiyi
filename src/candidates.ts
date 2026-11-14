/** 候选记忆：自动提取与工作复盘产物，按用户审批或可信合并策略进入正式记忆库。 */
import { createHash, randomUUID } from 'node:crypto';
import { Database } from './db';
import { normalizeContent } from './extraction-rules';
import { normalizeMemoryCategory, parseEvidenceTrajectoryIds, type MemoryStore } from './memories';
import {
  evolveMemoryWriteInTx,
  findConflictingMemory,
  findEvolutionRelation,
  isDuplicateContent,
} from './memory-evolution';
import { DomainError } from './personal-ai/domain/types';
import {
  MEMORY_CATEGORIES,
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

/** 计算标准化正文的 SHA-256 哈希值，用于批内精确去重（Mem0 V3 Hash Deduplication）。 */
export function createContentHash(content: string): string {
  const normalized = normalizeContent(content).toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export interface CandidatePatch {
  content?: string;
  category?: MemoryCategory;
  scope?: MemoryScope;
  type?: MemoryType;
  confidence?: number;
}

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
  entities?: string[];
  evolution_relation?: string | null;
  conflict_memory_id?: string | null;
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

function parseEntities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }
  return [];
}

function rowToCandidate(
  row: MemoryCandidate & {
    evidence_trajectory_ids?: string | string[];
    entities?: string | string[];
  },
): MemoryCandidate {
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
    entities: parseEntities(row.entities),
    evolution_relation: row.evolution_relation ?? null,
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
    const relationResult = findEvolutionRelation(
      input.content,
      {
        scope,
        agent_id: input.agent_id ?? null,
        project_id: input.project_id ?? null,
        category,
      },
      memoryStore.allForUser(input.user_id, false),
    );
    const conflictMemoryId =
      input.conflict_memory_id !== undefined
        ? input.conflict_memory_id
        : relationResult.relatedMemory?.memory_id ?? null;
    const evolutionRelation = input.evolution_relation ?? relationResult.relation;
    const entities = Array.isArray(input.entities) ? input.entities : [];

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
      conflict_memory_id: conflictMemoryId,
      confidence: Math.min(1, Math.max(0, Number(input.confidence) || 0)),
      status: input.status ?? 'pending',
      created_memory_id: null,
      entities,
      evolution_relation: evolutionRelation,
      created_at: now,
      updated_at: now,
    };
    this.db.run(
      `INSERT INTO memory_candidates
       (id, user_id, agent_id, project_id, goal_id, task_id, type, scope, category, content, source,
        trajectory_id, evidence_trajectory_ids, conflict_memory_id, confidence, status, created_memory_id, entities, evolution_relation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
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
        JSON.stringify(candidate.entities ?? []),
        candidate.evolution_relation,
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
    const limit: number = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const offset: number = Math.max(filters.offset ?? 0, 0);
    return this.db
      .all<MemoryCandidate>(
        `SELECT * FROM memory_candidates WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )
      .map(rowToCandidate);
  }

  count(userId: string, filters: CandidateFilters = {}): number {
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM memory_candidates WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return Number(row?.total ?? 0);
  }

  /**
   * 修改候选记忆。
   * 支持编辑正文、分类、作用域与类型；严格保留原有证据链（trajectory_id 与 evidence_trajectory_ids）。
   */
  update(
    userId: string,
    id: string,
    patch: CandidatePatch,
    memoryStore: MemoryStore,
  ): MemoryCandidate {
    const existing = this.get(userId, id);
    if (!existing) {
      throw new DomainError(404, 'candidate_not_found', '候选记忆不存在或无权访问');
    }
    if (existing.status === 'approved' || existing.status === 'rejected') {
      throw new DomainError(409, 'candidate_immutable', '已审批或已拒绝的候选记忆不可修改');
    }

    const nextContent = typeof patch.content === 'string' ? patch.content.trim() : existing.content;
    if (nextContent.length < 4) {
      throw new DomainError(400, 'invalid_content', '记忆内容至少需要 4 个字符');
    }
    const nextScope = patch.scope && MEMORY_SCOPES.includes(patch.scope) ? patch.scope : existing.scope;
    const nextCategory = patch.category && MEMORY_CATEGORIES.includes(patch.category) ? patch.category : existing.category;
    const nextType = patch.type && MEMORY_TYPES.includes(patch.type) ? patch.type : existing.type;
    const nextConfidence = typeof patch.confidence === 'number'
      ? Math.min(1, Math.max(0, patch.confidence))
      : existing.confidence;

    const conflict = findConflictingMemory(
      nextContent,
      {
        scope: nextScope,
        agent_id: existing.agent_id,
        project_id: existing.project_id,
        category: nextCategory,
      },
      memoryStore.allForUser(userId, false),
    );

    const now = new Date().toISOString();
    this.db.run(
      `UPDATE memory_candidates
       SET content = ?, scope = ?, category = ?, type = ?, confidence = ?, conflict_memory_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [
        nextContent,
        nextScope,
        nextCategory,
        nextType,
        nextConfidence,
        conflict?.memory.memory_id ?? null,
        now,
        id,
        userId,
      ],
    );

    return this.get(userId, id)!;
  }

  /**
   * 幂等审批入库：用户审批通过后标记 verified_by_user=true，并在同事务内处理去重合并与冲突替代。
   * 支持传入候选字段修改覆盖项（overrides），在入库前原子应用编辑。
   */
  approve(
    userId: string,
    id: string,
    memoryStore: MemoryStore,
    overrides?: CandidatePatch,
  ): ApproveResult {
    return this.db.transaction((): ApproveResult => {
      let candidate: MemoryCandidate | undefined = this.get(userId, id);
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

      if (overrides && Object.keys(overrides).length > 0) {
        candidate = this.update(userId, id, overrides, memoryStore);
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

      if (candidate.evolution_relation === 'outdated' && candidate.conflict_memory_id) {
        memoryStore.archive(userId, candidate.conflict_memory_id);
        const auditMemory = memoryStore.create({
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
          status: 'archived',
        });
        this.db.run(
          `UPDATE memory_candidates
           SET status = 'approved', created_memory_id = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
          [auditMemory.memory_id, new Date().toISOString(), id, userId],
        );
        return {
          ok: true,
          idempotent: false,
          memory: auditMemory,
          candidate: this.get(userId, id),
        };
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
    const seenHashes = new Set<string>();

    for (const item of items) {
      if (!item || typeof item.content !== 'string' || item.content.trim().length < 6) continue;
      const confidence: number = Number(item.confidence);
      if (!Number.isFinite(confidence)) continue;

      const contentHash = createContentHash(item.content);
      if (seenHashes.has(contentHash)) continue;
      seenHashes.add(contentHash);

      let evolutionRelation: string | null = null;
      if (item.event === 'DELETE') {
        evolutionRelation = 'outdated';
      } else if (item.event === 'UPDATE') {
        evolutionRelation = 'conflict';
      } else if (item.event === 'SUPPLEMENT') {
        evolutionRelation = 'supplement';
      } else if (item.event === 'ADD') {
        evolutionRelation = 'new';
      }

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
          entities: item.entities ?? [],
          evolution_relation: evolutionRelation,
          conflict_memory_id: item.old_memory_id ?? undefined,
        },
        memoryStore,
      );
      if (result.created) created += 1;
    }
    return created;
  }
}
