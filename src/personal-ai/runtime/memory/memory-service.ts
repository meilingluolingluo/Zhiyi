/**
 * 个人记忆运行时服务（Memory Service）：
 * 统一封装 Memory Core，作为 Personal AI Runtime 内记忆检索与生命周期管理的唯一服务层。
 *
 * 职责：
 * 1. 记忆检索（按可信用户身份、作用域过滤、有效性核验与关键词加权）；
 * 2. 记忆写入（用户明确要求记住时，以 manual 来源与用户确认标记写入正式记忆库）；
 * 3. 记忆修改（受控字段更新，防篡改校验，跨用户 404 隔离）；
 * 4. 冲突检测与演进（复用 evolveMemoryWrite 与 mutateMemoryWithGuard）。
 */
import type { CandidateStore } from '../../../candidates';
import type { MemoryStore } from '../../../memories';
import {
  evolveMemoryWrite,
  MemoryConflictError,
  mutateMemoryWithGuard,
} from '../../../memory-evolution';
import { isMemoryExpired, searchMemories } from '../../../search';
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type Memory,
  type MemoryCategory,
  type MemoryPatch,
  type MemoryScope,
  type MemoryType,
  type SearchHit,
} from '../../../types';
import { DomainError } from '../../domain/types';

export interface MemoryServiceDeps {
  memoryStore: MemoryStore;
  candidateStore?: CandidateStore;
}

export interface RecallMemoryItem {
  memory_id: string;
  content: string;
  scope: MemoryScope;
  category: MemoryCategory;
  type: MemoryType;
  confidence: number;
  status: string;
  source: string;
  verified_by_user: boolean;
  trust_label: '用户已确认' | '推断参考';
  evidence_trajectory_ids: string[];
  evidence_status: 'available' | 'manual_no_evidence' | 'none';
  project_id: string | null;
  goal_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecallResult {
  count: number;
  items: RecallMemoryItem[];
  hits: SearchHit[];
}

export interface RecallParams {
  userId: string;
  query: string;
  scope?: MemoryScope;
  projectId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  categories?: MemoryCategory[];
  includeArchived?: boolean;
  limit?: number;
}

export interface RememberParams {
  userId: string;
  content: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  type?: MemoryType;
  projectId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  confidence?: number;
  expiresAt?: string | null;
}

export interface UpdateMemoryParams {
  userId: string;
  memoryId: string;
  content?: string;
  category?: MemoryCategory;
  scope?: MemoryScope;
  type?: MemoryType;
  projectId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  confidence?: number;
  expiresAt?: string | null;
}

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  /**
   * 检索有效长期记忆。
   * 自动过滤已删除、已归档与已过期条目，严格限定用户身份与可见作用域。
   */
  recall(params: RecallParams): RecallResult {
    const query = (params.query ?? '').trim();
    const limit = typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), 10) : 5;
    const scopes = params.scope && MEMORY_SCOPES.includes(params.scope) ? [params.scope] : undefined;

    const rawHits = searchMemories(this.deps.memoryStore, {
      query,
      user_id: params.userId,
      agent_id: params.agentId ?? undefined,
      project_id: params.projectId ?? undefined,
      goal_id: params.goalId ?? undefined,
      task_id: params.taskId ?? undefined,
      scopes,
      categories: params.categories,
      include_archived: params.includeArchived === true,
      limit,
    });

    const nowMs = Date.now();
    const validHits = rawHits.filter((hit) => {
      const m = hit.memory;
      if (m.user_id !== params.userId) return false;
      if (params.includeArchived !== true) {
        if (m.status !== 'active') return false;
        if (isMemoryExpired(m, nowMs)) return false;
      }
      return true;
    });

    const items: RecallMemoryItem[] = validHits.map((hit) => {
      const m = hit.memory;
      const isManual = m.source === 'manual';
      const evidenceCount = m.evidence_trajectory_ids ? m.evidence_trajectory_ids.length : 0;
      const evidenceStatus =
        evidenceCount > 0 ? 'available' : isManual ? 'manual_no_evidence' : 'none';

      return {
        memory_id: m.memory_id,
        content: m.content,
        scope: m.scope,
        category: m.category,
        type: m.type,
        confidence: m.confidence,
        status: m.status,
        source: m.source,
        verified_by_user: m.verified_by_user,
        trust_label: m.verified_by_user ? '用户已确认' : '推断参考',
        evidence_trajectory_ids: m.evidence_trajectory_ids ?? [],
        evidence_status: evidenceStatus,
        project_id: m.project_id ?? null,
        goal_id: m.goal_id ?? null,
        task_id: m.task_id ?? null,
        created_at: m.created_at,
        updated_at: m.updated_at,
      };
    });

    return {
      count: items.length,
      items,
      hits: validHits,
    };
  }

  /**
   * 记录用户明确要求保存的正式记忆。
   * 采用 manual 来源语义与用户确认标记写入，复用演进与冲突保护。
   */
  remember(params: RememberParams): {
    action: string;
    memory: Memory;
    note?: string;
  } {
    const content = (params.content ?? '').trim();
    if (content.length < 4) {
      throw new DomainError(400, 'invalid_content', '记忆内容至少需要 4 个字符');
    }

    const scope: MemoryScope =
      params.scope && MEMORY_SCOPES.includes(params.scope) ? params.scope : 'personal';
    const category: MemoryCategory =
      params.category && MEMORY_CATEGORIES.includes(params.category)
        ? params.category
        : 'preference';
    const type: MemoryType =
      params.type && MEMORY_TYPES.includes(params.type) ? params.type : 'semantic';

    const confidence =
      typeof params.confidence === 'number'
        ? Math.min(1, Math.max(0.1, params.confidence))
        : 1.0;

    const evolved = evolveMemoryWrite(
      this.deps.memoryStore,
      {
        user_id: params.userId,
        agent_id: scope === 'agent' ? params.agentId ?? null : null,
        project_id: params.projectId ?? null,
        goal_id: params.goalId ?? null,
        task_id: params.taskId ?? null,
        type,
        scope,
        category,
        content,
        source: 'manual',
        confidence,
        verified_by_user: true,
        expires_at: params.expiresAt ?? null,
        evidence_trajectory_ids: [],
      },
      {
        actor: 'user',
        supersedeConflicts: true,
      },
    );

    if (evolved.action === 'conflict_blocked') {
      throw new DomainError(
        409,
        'conflict_blocked',
        `检测到与用户已确认记忆 ${evolved.conflictWith.memory_id} 冲突：${evolved.reason}`,
      );
    }

    return {
      action: evolved.action,
      memory: evolved.memory,
      note: evolved.action === 'merged' ? evolved.note : undefined,
    };
  }

  /**
   * 更新已有记忆。
   * 严格限定白名单字段，防篡改校验，跨用户访问返回 404。
   */
  update(params: UpdateMemoryParams): Memory {
    const memoryId = (params.memoryId ?? '').trim();
    if (!memoryId) {
      throw new DomainError(400, 'missing_memory_id', '必须指定需要更新的 memory_id');
    }

    const existing = this.deps.memoryStore.getById(params.userId, memoryId);
    if (!existing) {
      throw new DomainError(404, 'memory_not_found', `记忆 ${memoryId} 不存在或无权访问`);
    }

    const patch: MemoryPatch = {};
    if (typeof params.content === 'string') {
      const trimmed = params.content.trim();
      if (trimmed.length < 4) {
        throw new DomainError(400, 'invalid_content', '记忆内容至少需要 4 个字符');
      }
      patch.content = trimmed;
    }
    if (params.category && MEMORY_CATEGORIES.includes(params.category)) {
      patch.category = params.category;
    }
    if (params.scope && MEMORY_SCOPES.includes(params.scope)) {
      patch.scope = params.scope;
    }
    if (params.type && MEMORY_TYPES.includes(params.type)) {
      patch.type = params.type;
    }
    if (params.projectId !== undefined) {
      patch.project_id = params.projectId;
    }
    if (params.goalId !== undefined) {
      patch.goal_id = params.goalId;
    }
    if (params.taskId !== undefined) {
      patch.task_id = params.taskId;
    }
    if (typeof params.confidence === 'number') {
      patch.confidence = Math.min(1, Math.max(0.1, params.confidence));
    }
    if (params.expiresAt !== undefined) {
      patch.expires_at = params.expiresAt;
    }

    try {
      return mutateMemoryWithGuard(
        this.deps.memoryStore,
        params.userId,
        memoryId,
        { kind: 'update', patch },
        { actor: 'user', userConfirmedCorrection: true },
      );
    } catch (error) {
      if (error instanceof MemoryConflictError) {
        throw new DomainError(error.status, error.code, error.message);
      }
      throw error;
    }
  }

  /**
   * 获取单条记忆详情。跨租户返回 null。
   */
  get(userId: string, memoryId: string): Memory | null {
    return this.deps.memoryStore.getById(userId, memoryId) ?? null;
  }
}
