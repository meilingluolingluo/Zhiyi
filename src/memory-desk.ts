/**
 * 记忆台管理 API（Memory Desk）：面向前端与调试终端的最小治理接口。
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
import { evolveMemoryWrite } from './memory-evolution';
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type CandidateStatus,
  type MemoryCategory,
  type MemoryFilters,
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

function truncateText(text: string, maxLength = 300): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * 从对话轨迹中提取人机交互摘要，供审核候选时直观查看原始证据。
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

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function queryInt(value: unknown, fallback: number): number {
  const parsed: number = Number(queryString(value));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function createMemoryDeskRouter(deps: AppDeps): Router {
  const router = Router();

  // 严格 API Key 身份鉴权
  router.use('/v1/memory-desk', (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    const apiKey = extractApiKey(req.headers);
    if (!apiKey) {
      res.status(401).json(errorBody('缺少 API Key，请通过 Authorization: Bearer <key> 或 x-api-key 提供', 'unauthorized', 'unauthorized'));
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

  // 1. GET /v1/memory-desk/memories — 正式记忆列表，支持 type / scope / category / status 过滤与分页
  router.get('/v1/memory-desk/memories', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const limit = queryInt(req.query.limit, 50);
    const offset = queryInt(req.query.offset, 0);
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

    if (type && MEMORY_TYPES.includes(type as MemoryType)) {
      filters.type = type as MemoryType;
    }
    if (scope && MEMORY_SCOPES.includes(scope as MemoryScope)) {
      filters.scope = scope as MemoryScope;
    }
    if (category && MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
      filters.category = category as MemoryCategory;
    }
    if (status && MEMORY_STATUSES.includes(status as MemoryStatus)) {
      filters.status = status as MemoryStatus;
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

  // 2. GET /v1/memory-desk/candidates — 候选记忆列表，默认 pending，支持 status 过滤与分页
  router.get('/v1/memory-desk/candidates', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity = res.locals.identity as { user_id: string; agent_id: string };
    const limit = queryInt(req.query.limit, 50);
    const offset = queryInt(req.query.offset, 0);
    const statusParam = queryString(req.query.status);

    let statusFilter: CandidateStatus | undefined = 'pending';
    if (statusParam === 'all') {
      statusFilter = undefined;
    } else if (statusParam) {
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

  // 3. GET /v1/memory-desk/candidates/:id — 候选详情 + evidence_trajectory_ids + 轨迹摘要
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

    const trajectories = deps.trajectoryStore.findByIds(identity.user_id, evidenceIds);
    const evidenceTrajectories = trajectories.map(summarizeTrajectory);

    res.json({
      candidate,
      evidence_trajectory_ids: evidenceIds,
      evidence_trajectories: evidenceTrajectories,
    });
  });

  // 4. POST /v1/memory-desk/candidates/:id/approve — 审批通过，幂等，需校验关联有效证据轨迹
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

    const result = deps.candidateStore.approve(identity.user_id, req.params.id, deps.memoryStore);
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

  // 5. POST /v1/memory-desk/candidates/:id/reject — 拒绝候选，幂等
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

  // 6. POST /v1/memory-desk/memories — 手动创建正式记忆，source='manual'，可挂关联证据
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
        ...errorBody(evolved.reason, 'conflict_blocked'),
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

  return router;
}
