/**
 * 记忆台管理 API（Memory Desk）：面向个人记忆的统一治理与全生命周期接口。
 *
 * 统一路由前缀 /v1/memory-desk。
 * 鉴权约束：只认服务端 API Key，越权访问一律返回 404。
 */
import {
  Router,
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';
import type { AppDeps } from './app';
import { errorBody } from './errors';
import { extractApiKey } from './identity';
import { evolveMemoryWrite, findEvolutionRelation } from './memory-evolution';
import type { CandidatePatch } from './candidates';
import {
  CANDIDATE_STATUSES,
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type CandidateStatus,
  type MemoryCategory,
  type MemoryFilters,
  type MemoryPatch,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type Trajectory,
} from './types';

export interface TrajectorySummary {
  id: string;
  request_id: string;
  agent_id: string;
  model: string;
  user_prompt: string;
  assistant_response: string;
  created_at: string;
}

export interface EvidenceTrajectorySummary extends TrajectorySummary {
  content_type: 'raw' | 'summary' | 'unavailable';
  status: 'available' | 'missing';
}

function truncateText(text: string, maxLength = 300): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * 从对话轨迹中提取人机交互摘要，供审核候选与记忆回溯时直观查看原始证据。
 */
export function summarizeTrajectory(traj: Trajectory): TrajectorySummary {
  let userPrompt = '';
  try {
    const parsedReq = JSON.parse(traj.request);
    if (Array.isArray(parsedReq?.messages)) {
      const userMsgs = parsedReq.messages.filter(
        (m: unknown): m is { role: string; content: unknown } =>
          typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'user',
      );
      const lastUser = userMsgs[userMsgs.length - 1];
      if (typeof lastUser?.content === 'string') {
        userPrompt = lastUser.content;
      } else if (Array.isArray(lastUser?.content)) {
        userPrompt = lastUser.content
          .map((part: unknown): string =>
            typeof part === 'object' && part !== null && 'text' in part
              ? String((part as { text: unknown }).text ?? '')
              : '',
          )
          .filter(Boolean)
          .join(' ');
      }
    } else if (typeof parsedReq?.prompt === 'string') {
      userPrompt = parsedReq.prompt;
    }
  } catch {
    userPrompt = typeof traj.request === 'string' ? traj.request : '';
  }

  let assistantResponse = '';
  try {
    const parsedRes = JSON.parse(traj.response);
    if (
      Array.isArray(parsedRes?.choices) &&
      typeof parsedRes.choices[0]?.message?.content === 'string'
    ) {
      assistantResponse = parsedRes.choices[0].message.content;
    } else if (typeof parsedRes === 'string') {
      assistantResponse = parsedRes;
    }
  } catch {
    assistantResponse = typeof traj.response === 'string' ? traj.response : '';
  }

  return {
    id: traj.id,
    request_id: traj.request_id,
    agent_id: traj.agent_id,
    model: traj.model,
    user_prompt: truncateText(userPrompt.trim()),
    assistant_response: truncateText(assistantResponse.trim()),
    created_at: traj.created_at,
  };
}

/**
 * 组装证据轨迹详情与整体可用性状态。
 */
export function buildEvidenceDetails(
  userId: string,
  evidenceIds: string[],
  trajectoryStore: AppDeps['trajectoryStore'],
  isManual = false,
): {
  evidence_status: 'available' | 'partial' | 'missing' | 'manual_no_evidence' | 'none';
  evidence_trajectory_ids: string[];
  evidence_trajectories: EvidenceTrajectorySummary[];
} {
  if (isManual && evidenceIds.length === 0) {
    return {
      evidence_status: 'manual_no_evidence',
      evidence_trajectory_ids: [],
      evidence_trajectories: [],
    };
  }

  if (evidenceIds.length === 0) {
    return {
      evidence_status: 'none',
      evidence_trajectory_ids: [],
      evidence_trajectories: [],
    };
  }

  const trajectories = trajectoryStore.findByIds(userId, evidenceIds);
  const foundMap = new Map<string, Trajectory>();
  for (const t of trajectories) {
    foundMap.set(t.id, t);
    foundMap.set(t.request_id, t);
  }

  const items: EvidenceTrajectorySummary[] = [];
  let availableCount = 0;

  for (const id of evidenceIds) {
    const traj = foundMap.get(id);
    if (traj) {
      availableCount += 1;
      const summary = summarizeTrajectory(traj);
      items.push({
        ...summary,
        content_type: 'raw',
        status: 'available',
      });
    } else {
      items.push({
        id,
        request_id: id,
        agent_id: '',
        model: '',
        user_prompt: '',
        assistant_response: '',
        created_at: '',
        content_type: 'unavailable',
        status: 'missing',
      });
    }
  }

  let evidence_status: 'available' | 'partial' | 'missing' = 'missing';
  if (availableCount === evidenceIds.length) {
    evidence_status = 'available';
  } else if (availableCount > 0) {
    evidence_status = 'partial';
  } else {
    evidence_status = 'missing';
  }

  return {
    evidence_status,
    evidence_trajectory_ids: evidenceIds,
    evidence_trajectories: items,
  };
}

function parsePaginationParams(query: Record<string, unknown>): {
  limit: number;
  offset: number;
  error?: string;
} {
  let limit = 20;
  if (query.limit !== undefined) {
    const raw = String(query.limit).trim();
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { limit: 20, offset: 0, error: 'limit 必须是大于 0 的有效正整数' };
    }
    limit = Math.min(parsed, 100);
  }

  let offset = 0;
  if (query.offset !== undefined) {
    const raw = String(query.offset).trim();
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { limit: 20, offset: 0, error: 'offset 必须是非负整数' };
    }
    offset = parsed;
  }

  return { limit, offset };
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function createMemoryDeskRouter(deps: AppDeps): Router {
  const router = Router();

  // 严格 API Key 身份鉴权
  router.use('/v1/memory-desk', (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    const apiKey = extractApiKey(req.headers);
    if (!apiKey) {
      res.status(401).json(
        errorBody('缺少 API Key，请通过 Authorization: Bearer <key> 或 x-api-key 提供', 'unauthorized', 'unauthorized'),
      );
      return;
    }
    const identity = deps.config.apiKeys[apiKey];
    if (!identity) {
      res.status(401).json(errorBody('无效的 API Key', 'unauthorized', 'unauthorized'));
      return;
    }
    res.locals.identity = {
      ...identity,
      api_key: apiKey,
    };
    next();
  });

  // 1. GET /v1/memory-desk/memories — 正式记忆列表，支持 type / scope / category / status / source 过滤与分页
  router.get('/v1/memory-desk/memories', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    if (pagination.error) {
      res.status(400).json(errorBody(pagination.error, 'bad_request', 'bad_request'));
      return;
    }

    const { limit, offset } = pagination;
    const includeArchived = String(req.query.include_archived ?? '').toLowerCase() === 'true';

    const filters: MemoryFilters = {
      limit,
      offset,
      include_archived: includeArchived,
    };

    const type = queryString(req.query.type);
    const scope = queryString(req.query.scope);
    const category = queryString(req.query.category);
    const status = queryString(req.query.status);
    const source = queryString(req.query.source);

    if (type !== undefined) {
      if (!MEMORY_TYPES.includes(type as MemoryType)) {
        res.status(400).json(errorBody('非法的记忆类型 (type)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      filters.type = type as MemoryType;
    }
    if (scope !== undefined) {
      if (!MEMORY_SCOPES.includes(scope as MemoryScope)) {
        res.status(400).json(errorBody('非法的记忆作用域 (scope)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      filters.scope = scope as MemoryScope;
    }
    if (category !== undefined) {
      if (!MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
        res.status(400).json(errorBody('非法的记忆分类 (category)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      filters.category = category as MemoryCategory;
    }
    if (status !== undefined) {
      if (!MEMORY_STATUSES.includes(status as MemoryStatus)) {
        res.status(400).json(errorBody('非法的记忆状态 (status)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      filters.status = status as MemoryStatus;
    }
    if (source !== undefined) {
      filters.source = source;
    }

    const items = deps.memoryStore.list(identity.user_id, filters);
    const total = deps.memoryStore.countMatching(identity.user_id, filters);

    res.json({
      items,
      total,
      limit,
      offset,
    });
  });

  // 2. GET /v1/memory-desk/memories/:id — 正式记忆详情与证据详情
  router.get('/v1/memory-desk/memories/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const memory = deps.memoryStore.getById(identity.user_id, req.params.id);
    if (!memory) {
      res.status(404).json(errorBody('记忆不存在或无权访问', 'not_found', 'not_found'));
      return;
    }

    const isManual = memory.source === 'manual';
    const evidenceIds = memory.evidence_trajectory_ids ?? [];
    const evidence = buildEvidenceDetails(identity.user_id, evidenceIds, deps.trajectoryStore, isManual);

    const previousVersions = deps.memoryStore
      .allForUser(identity.user_id, true)
      .filter((m) => m.superseded_by === memory.memory_id)
      .map((m) => ({
        memory_id: m.memory_id,
        content: m.content,
        created_at: m.created_at,
      }));

    res.json({
      memory,
      previous_versions: previousVersions,
      evidence_status: evidence.evidence_status,
      evidence_trajectory_ids: evidence.evidence_trajectory_ids,
      evidence_trajectories: evidence.evidence_trajectories,
    });
  });

  // 3. POST /v1/memory-desk/memories — 手动创建正式记忆，source='manual'，可挂关联证据
  router.post('/v1/memory-desk/memories', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};

    if (typeof body.content !== 'string' || body.content.trim() === '') {
      res.status(400).json(errorBody('content 不能为空', 'bad_request', 'bad_request'));
      return;
    }

    const evidenceIds: string[] = [];
    if (Array.isArray(body.evidence_trajectory_ids)) {
      const rawIds = body.evidence_trajectory_ids.filter(
        (id: unknown): id is string => typeof id === 'string' && id.trim().length > 0,
      );
      if (rawIds.length > 0) {
        const found = deps.trajectoryStore.findByIds(identity.user_id, rawIds);
        const validIdSet = new Set<string>();
        for (const t of found) {
          validIdSet.add(t.id);
          validIdSet.add(t.request_id);
        }
        for (const rawId of rawIds) {
          if (validIdSet.has(rawId) && !evidenceIds.includes(rawId)) {
            evidenceIds.push(rawId);
          }
        }
      }
    }

    const scope: MemoryScope = MEMORY_SCOPES.includes(body.scope as MemoryScope)
      ? (body.scope as MemoryScope)
      : 'personal';

    const evolved = evolveMemoryWrite(
      deps.memoryStore,
      {
        user_id: identity.user_id,
        agent_id: scope === 'agent' ? identity.agent_id : null,
        project_id: typeof body.project_id === 'string' ? body.project_id : null,
        goal_id:
          typeof body.goal_id === 'string' && body.goal_id.trim() !== '' ? body.goal_id.trim() : null,
        task_id:
          typeof body.task_id === 'string' && body.task_id.trim() !== '' ? body.task_id.trim() : null,
        type: MEMORY_TYPES.includes(body.type as MemoryType) ? (body.type as MemoryType) : 'semantic',
        scope,
        category: MEMORY_CATEGORIES.includes(body.category as MemoryCategory)
          ? (body.category as MemoryCategory)
          : 'general',
        content: body.content.trim(),
        source: 'manual',
        confidence:
          typeof body.confidence === 'number'
            ? Math.min(1, Math.max(0, body.confidence))
            : 1.0,
        evidence_trajectory_ids: evidenceIds,
        verified_by_user: true,
        expires_at:
          typeof body.expires_at === 'string' && body.expires_at.trim() !== ''
            ? body.expires_at.trim()
            : null,
      },
      {
        actor: 'user',
        supersedeConflicts: body.supersede_conflicts !== false,
      },
    );

    if (evolved.action === 'conflict_blocked') {
      res.status(409).json({
        ...errorBody(evolved.reason, 'conflict_blocked', 'conflict_blocked'),
        conflict_memory_id: evolved.conflictWith.memory_id,
      });
      return;
    }

    res.status(201).json({
      memory: evolved.memory,
      evolution_action: evolved.action,
      ...(evolved.action === 'superseded'
        ? { superseded_ids: evolved.superseded.map((m) => m.memory_id) }
        : {}),
    });
  });

  // 4. PATCH /v1/memory-desk/memories/:id — 编辑正式记忆，保护来源与审计完整性
  router.patch('/v1/memory-desk/memories/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const existing = deps.memoryStore.getById(identity.user_id, req.params.id);
    if (!existing) {
      res.status(404).json(errorBody('记忆不存在或无权访问', 'not_found', 'not_found'));
      return;
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};

    // 关键安全守卫：禁止客户端篡改关键主键、用户归属与原始来源
    if (body.memory_id !== undefined && body.memory_id !== existing.memory_id) {
      res.status(400).json(errorBody('不允许修改记忆 ID', 'invalid_field', 'invalid_field'));
      return;
    }
    if (body.user_id !== undefined && body.user_id !== identity.user_id) {
      res.status(400).json(errorBody('不允许修改所属用户', 'invalid_field', 'invalid_field'));
      return;
    }
    if (body.source !== undefined && body.source !== existing.source) {
      res.status(400).json(errorBody('不允许篡改记忆原始来源', 'invalid_field', 'invalid_field'));
      return;
    }
    if (body.created_at !== undefined && body.created_at !== existing.created_at) {
      res.status(400).json(errorBody('不允许修改记忆创建时间', 'invalid_field', 'invalid_field'));
      return;
    }

    const patch: MemoryPatch = {};

    if ('content' in body) {
      if (typeof body.content !== 'string' || body.content.trim() === '') {
        res.status(400).json(errorBody('content 不能为空', 'bad_request', 'bad_request'));
        return;
      }
      patch.content = body.content.trim();
    }

    if ('type' in body) {
      if (!MEMORY_TYPES.includes(body.type as MemoryType)) {
        res.status(400).json(errorBody('非法的记忆类型 (type)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      patch.type = body.type as MemoryType;
    }

    if ('scope' in body) {
      if (!MEMORY_SCOPES.includes(body.scope as MemoryScope)) {
        res.status(400).json(errorBody('非法的记忆作用域 (scope)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      patch.scope = body.scope as MemoryScope;
    }

    if ('category' in body) {
      if (!MEMORY_CATEGORIES.includes(body.category as MemoryCategory)) {
        res.status(400).json(errorBody('非法的记忆分类 (category)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      patch.category = body.category as MemoryCategory;
    }

    if ('status' in body) {
      if (!MEMORY_STATUSES.includes(body.status as MemoryStatus)) {
        res.status(400).json(errorBody('非法的记忆状态 (status)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      patch.status = body.status as MemoryStatus;
    }

    if ('confidence' in body) {
      if (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1) {
        res.status(400).json(errorBody('confidence 必须为 0 到 1 之间的数值', 'invalid_field', 'invalid_field'));
        return;
      }
      patch.confidence = body.confidence;
    }

    if ('expires_at' in body) {
      patch.expires_at =
        typeof body.expires_at === 'string' && body.expires_at.trim() !== ''
          ? body.expires_at.trim()
          : null;
    }

    // 证据关联：若显式传入，仅挂载当前用户真实存在的证据轨迹
    if ('evidence_trajectory_ids' in body) {
      if (Array.isArray(body.evidence_trajectory_ids)) {
        const rawIds = body.evidence_trajectory_ids.filter(
          (id: unknown): id is string => typeof id === 'string' && id.trim().length > 0,
        );
        const found = deps.trajectoryStore.findByIds(identity.user_id, rawIds);
        const validIdSet = new Set<string>();
        for (const t of found) {
          validIdSet.add(t.id);
          validIdSet.add(t.request_id);
        }
        const updatedEvidenceIds: string[] = [];
        for (const rawId of rawIds) {
          if (validIdSet.has(rawId) && !updatedEvidenceIds.includes(rawId)) {
            updatedEvidenceIds.push(rawId);
          }
        }
        patch.evidence_trajectory_ids = updatedEvidenceIds;
      }
    }

    const updated = deps.memoryStore.update(identity.user_id, req.params.id, patch);
    res.json({ memory: updated });
  });

  // 5. DELETE /v1/memory-desk/memories/:id — 删除正式记忆，同步清理检索索引
  router.delete('/v1/memory-desk/memories/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const existing = deps.memoryStore.getById(identity.user_id, req.params.id);
    if (!existing) {
      res.status(404).json(errorBody('记忆不存在或无权访问', 'not_found', 'not_found'));
      return;
    }

    const removed = deps.memoryStore.remove(identity.user_id, req.params.id);
    if (!removed) {
      res.status(404).json(errorBody('记忆不存在或无权访问', 'not_found', 'not_found'));
      return;
    }

    res.json({
      ok: true,
      deleted: true,
      memory_id: req.params.id,
    });
  });

  // 6. GET /v1/memory-desk/candidates — 候选记忆列表，默认 pending，支持 status 过滤与分页
  router.get('/v1/memory-desk/candidates', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    if (pagination.error) {
      res.status(400).json(errorBody(pagination.error, 'bad_request', 'bad_request'));
      return;
    }

    const { limit, offset } = pagination;
    const statusParam = queryString(req.query.status);

    let statusFilter: CandidateStatus | undefined = 'pending';
    if (statusParam === 'all') {
      statusFilter = undefined;
    } else if (statusParam !== undefined) {
      if (!CANDIDATE_STATUSES.includes(statusParam as CandidateStatus)) {
        res.status(400).json(errorBody('非法的候选状态 (status)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      statusFilter = statusParam as CandidateStatus;
    }

    const items = deps.candidateStore.list(identity.user_id, {
      status: statusFilter,
      limit,
      offset,
    });
    const total = deps.candidateStore.count(identity.user_id, {
      status: statusFilter,
    });

    res.json({
      items,
      total,
      limit,
      offset,
    });
  });

  // 7. GET /v1/memory-desk/candidates/:id — 候选详情 + evidence_trajectory_ids + 轨迹摘要
  router.get('/v1/memory-desk/candidates/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const candidate = deps.candidateStore.get(identity.user_id, req.params.id);
    if (!candidate) {
      res.status(404).json(errorBody('候选记忆不存在或无权访问', 'not_found', 'not_found'));
      return;
    }

    const evidenceIds: string[] = [];
    if (candidate.trajectory_id && candidate.trajectory_id.trim() !== '') {
      evidenceIds.push(candidate.trajectory_id.trim());
    }
    if (Array.isArray(candidate.evidence_trajectory_ids)) {
      for (const tid of candidate.evidence_trajectory_ids) {
        if (typeof tid === 'string' && tid.trim() !== '' && !evidenceIds.includes(tid.trim())) {
          evidenceIds.push(tid.trim());
        }
      }
    }

    const evidence = buildEvidenceDetails(identity.user_id, evidenceIds, deps.trajectoryStore, false);

    const evolutionAnalysis = findEvolutionRelation(
      candidate.content,
      {
        scope: candidate.scope,
        agent_id: candidate.agent_id,
        project_id: candidate.project_id,
        category: candidate.category,
      },
      deps.memoryStore.allForUser(identity.user_id, false),
    );
    const conflictMemory = candidate.conflict_memory_id
      ? deps.memoryStore.getById(identity.user_id, candidate.conflict_memory_id) ?? null
      : null;

    res.json({
      candidate,
      evolution_analysis: evolutionAnalysis,
      conflict_memory: conflictMemory,
      evidence_status: evidence.evidence_status,
      evidence_trajectory_ids: evidence.evidence_trajectory_ids,
      evidence_trajectories: evidence.evidence_trajectories,
    });
  });

  // 8. PATCH /v1/memory-desk/candidates/:id — 编辑候选记忆（正文/分类/作用域/置信度），保留证据链
  router.patch('/v1/memory-desk/candidates/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};

    const candidate = deps.candidateStore.get(identity.user_id, req.params.id);
    if (!candidate) {
      res.status(404).json(errorBody('候选记忆不存在或无权访问', 'not_found', 'not_found'));
      return;
    }
    if (candidate.status === 'approved' || candidate.status === 'rejected') {
      res.status(409).json(errorBody('已审批或已拒绝的候选记忆不可修改', 'conflict', 'conflict'));
      return;
    }

    const patch: CandidatePatch = {};
    if (body.content !== undefined) {
      if (typeof body.content !== 'string' || body.content.trim().length < 4) {
        res.status(400).json(errorBody('content 必须为至少 4 字符的字符串', 'bad_request', 'bad_request'));
        return;
      }
      patch.content = body.content.trim();
    }
    if (body.category !== undefined) {
      if (!MEMORY_CATEGORIES.includes(body.category as MemoryCategory)) {
        res.status(400).json(errorBody('非法的记忆分类 (category)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      patch.category = body.category as MemoryCategory;
    }
    if (body.scope !== undefined) {
      if (!MEMORY_SCOPES.includes(body.scope as MemoryScope)) {
        res.status(400).json(errorBody('非法的记忆作用域 (scope)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      patch.scope = body.scope as MemoryScope;
    }
    if (body.type !== undefined) {
      if (!MEMORY_TYPES.includes(body.type as MemoryType)) {
        res.status(400).json(errorBody('非法的记忆类型 (type)', 'invalid_enum', 'invalid_enum'));
        return;
      }
      patch.type = body.type as MemoryType;
    }
    if (body.confidence !== undefined) {
      const conf = Number(body.confidence);
      if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
        res.status(400).json(errorBody('confidence 必须为 0 到 1 之间的数值', 'bad_request', 'bad_request'));
        return;
      }
      patch.confidence = conf;
    }

    const updated = deps.candidateStore.update(identity.user_id, req.params.id, patch, deps.memoryStore);
    res.json({ candidate: updated });
  });

  // 9. POST /v1/memory-desk/candidates/:id/approve — 审批通过，幂等，支持修改后再批准，需校验关联有效证据轨迹
  router.post('/v1/memory-desk/candidates/:id/approve', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const candidate = deps.candidateStore.get(identity.user_id, req.params.id);
    if (!candidate) {
      res.status(404).json(errorBody('候选记忆不存在或无权访问', 'not_found', 'not_found'));
      return;
    }

    if (candidate.status === 'approved') {
      const memory = candidate.created_memory_id
        ? deps.memoryStore.getById(identity.user_id, candidate.created_memory_id)
        : undefined;
      res.json({
        ok: true,
        idempotent: true,
        memory,
        candidate,
      });
      return;
    }

    if (candidate.status === 'rejected') {
      res.status(409).json(errorBody('已拒绝的候选记忆不能通过', 'conflict', 'conflict'));
      return;
    }

    const evidenceIds: string[] = [];
    if (candidate.trajectory_id && candidate.trajectory_id.trim() !== '') {
      evidenceIds.push(candidate.trajectory_id.trim());
    }
    if (Array.isArray(candidate.evidence_trajectory_ids)) {
      for (const tid of candidate.evidence_trajectory_ids) {
        if (typeof tid === 'string' && tid.trim() !== '' && !evidenceIds.includes(tid.trim())) {
          evidenceIds.push(tid.trim());
        }
      }
    }

    if (evidenceIds.length === 0) {
      res.status(400).json(errorBody('候选记忆缺少关联的证据轨迹，无法通过审批入库', 'missing_evidence', 'missing_evidence'));
      return;
    }

    const validTrajectories = deps.trajectoryStore.findByIds(identity.user_id, evidenceIds);
    if (validTrajectories.length === 0) {
      res.status(400).json(errorBody('候选记忆关联的证据轨迹不存在或无权访问，无法通过审批入库', 'invalid_evidence', 'invalid_evidence'));
      return;
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const rawOverrides = (body.overrides && typeof body.overrides === 'object' ? body.overrides : body) as Record<string, unknown>;
    const overrides: CandidatePatch = {};
    if (typeof rawOverrides.content === 'string' && rawOverrides.content.trim().length >= 4) {
      overrides.content = rawOverrides.content.trim();
    }
    if (typeof rawOverrides.category === 'string' && MEMORY_CATEGORIES.includes(rawOverrides.category as MemoryCategory)) {
      overrides.category = rawOverrides.category as MemoryCategory;
    }
    if (typeof rawOverrides.scope === 'string' && MEMORY_SCOPES.includes(rawOverrides.scope as MemoryScope)) {
      overrides.scope = rawOverrides.scope as MemoryScope;
    }
    if (typeof rawOverrides.type === 'string' && MEMORY_TYPES.includes(rawOverrides.type as MemoryType)) {
      overrides.type = rawOverrides.type as MemoryType;
    }
    if (typeof rawOverrides.confidence === 'number' && rawOverrides.confidence >= 0 && rawOverrides.confidence <= 1) {
      overrides.confidence = rawOverrides.confidence;
    }

    const result = deps.candidateStore.approve(
      identity.user_id,
      req.params.id,
      deps.memoryStore,
      Object.keys(overrides).length > 0 ? overrides : undefined,
    );
    if (!result.ok) {
      const code = result.reason === 'not_found' ? 'not_found' : 'conflict';
      res.status(result.reason === 'not_found' ? 404 : 409).json(
        errorBody(
          result.reason === 'not_found'
            ? '候选记忆不存在或无权访问'
            : result.reason === 'rejected'
              ? '已拒绝的候选记忆不能通过'
              : '存在冲突记忆且无法自动替代',
          code,
          code,
        ),
      );
      return;
    }

    res.json({
      ok: true,
      idempotent: result.idempotent,
      memory: result.memory,
      candidate: result.candidate,
    });
  });

  // 9. POST /v1/memory-desk/candidates/:id/reject — 拒绝候选，幂等
  router.post('/v1/memory-desk/candidates/:id/reject', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const candidate = deps.candidateStore.get(identity.user_id, req.params.id);
    if (!candidate) {
      res.status(404).json(errorBody('候选记忆不存在或无权访问', 'not_found', 'not_found'));
      return;
    }

    if (candidate.status === 'approved') {
      res.status(409).json(errorBody('已通过的候选记忆不能拒绝', 'conflict', 'conflict'));
      return;
    }

    if (candidate.status === 'rejected') {
      res.json({
        ok: true,
        idempotent: true,
        candidate,
      });
      return;
    }

    const updated = deps.candidateStore.reject(identity.user_id, req.params.id);
    res.json({
      ok: true,
      idempotent: false,
      candidate: updated,
    });
  });

  return router;
}
