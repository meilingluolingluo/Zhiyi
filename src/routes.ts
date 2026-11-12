/** HTTP 路由层：REST API + 代理入口 + 仅 Mock 模式开放的调试端点。 */
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type Router,
} from 'express';
import type { AppDeps } from './app';
import { isAdminRequest } from './admin-auth';
import {
  AGENT_PRIVILEGED_FIELDS,
  BUILTIN_AGENT_IDS,
  toPublicAgentProfile,
} from './agents';
import { errorBody } from './errors';
import type { MockMode } from './mock-upstream';
import { resolveIdentity, type HeaderBag, type ResolvedIdentity } from './identity';
import { DomainError } from './personal-ai/domain/types';
import { handleChatCompletion } from './proxy';
import { searchMemories } from './search';
import {
  executeImageGeneration,
  executeTitleGeneration,
  requestPublicOrigin,
} from './upstream/media-handlers';
import { isValidImageFilename } from './upstream/media-store';
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type AgentAdminPatch,
  type CandidateStatus,
  type MemoryScope,
  type MemoryType,
} from './types';

function identityOf(res: ExpressResponse): ResolvedIdentity {
  return res.locals.identity as ResolvedIdentity;
}

function bodyOf(req: ExpressRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function queryInt(value: unknown, fallback: number): number {
  const parsed: number = Number(queryString(value));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parseScopes(value: unknown): MemoryScope[] | undefined {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const scopes: MemoryScope[] = raw
    .map((item: unknown): string => String(item).trim())
    .filter((item: string): boolean => MEMORY_SCOPES.includes(item as MemoryScope)) as MemoryScope[];
  return scopes.length > 0 ? scopes : undefined;
}

function invalid(res: ExpressResponse, message: string): void {
  res.status(400).json(errorBody(message, 'bad_request'));
}

function notFound(res: ExpressResponse, resource: string): void {
  res.status(404).json(errorBody(`${resource} 不存在或无权访问`, 'not_found'));
}

/** 把 Mock 上游返回的 Web Response 写回 Express 响应（含 SSE 流）。 */
async function writeWebResponse(web: Response, res: ExpressResponse): Promise<void> {
  res.status(web.status);
  web.headers.forEach((value: string, key: string): void => {
    if (!['content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
  if (web.body) {
    const reader = web.body.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      res.write(Buffer.from(result.value));
    }
    res.end();
    return;
  }
  res.send(await web.text());
}

export function createRouter(deps: AppDeps): Router {
  const router: Router = express.Router();

  // 统一解析身份（user_id / agent_id 只由服务端 API Key 决定）。
  router.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    res.locals.identity = resolveIdentity(deps.config, req.headers as HeaderBag, bodyOf(req));
    next();
  });

  // ===== 健康检查 =====
  router.get('/health', (_req: ExpressRequest, res: ExpressResponse): void => {
    let dbOk = true;
    try {
      deps.db.get<{ ok: number }>('SELECT 1 AS ok');
    } catch {
      dbOk = false;
      deps.logger.error('健康检查：数据库不可用');
    }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      upstream: {
        mode: deps.config.mockUpstream ? 'mock' : 'remote',
        base_url: deps.config.mockUpstream ? null : deps.config.upstreamBaseUrl,
        api_key_configured: !deps.config.mockUpstream && deps.config.upstreamApiKey !== '',
        default_model: deps.config.defaultModel,
      },
      memory: {
        enabled: deps.config.memoryEnabled,
        auto_extract: deps.config.memoryAutoExtract,
        max_items: deps.config.memoryMaxItems,
        token_budget: deps.config.memoryTokenBudget,
      },
      time: new Date().toISOString(),
    });
  });

  // ===== 记忆 CRUD =====
  router.post('/v1/memories', (req: ExpressRequest, res: ExpressResponse): void => {
    const body = bodyOf(req);
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      invalid(res, 'content 不能为空');
      return;
    }
    const identity: ResolvedIdentity = identityOf(res);
    const scope: MemoryScope = MEMORY_SCOPES.includes(body.scope as MemoryScope)
      ? (body.scope as MemoryScope)
      : 'personal';
    const memory = deps.memoryStore.create({
      user_id: identity.user_id,
      // body 中的 user_id / agent_id 属于身份字段，一律忽略；
      // agent 专属记忆通过 scope=agent 自动归属到服务端解析出的 agent_id。
      agent_id: scope === 'agent' ? identity.agent_id : null,
      project_id:
        typeof body.project_id === 'string'
          ? body.project_id
          : scope === 'project'
            ? identity.project_id
            : null,
      type: MEMORY_TYPES.includes(body.type as MemoryType) ? (body.type as MemoryType) : 'semantic',
      scope,
      content: body.content.trim(),
      source: typeof body.source === 'string' ? body.source : 'api',
      confidence: typeof body.confidence === 'number' ? body.confidence : 0.8,
    });
    res.status(201).json({ memory });
  });

  router.get('/v1/memories', (req: ExpressRequest, res: ExpressResponse): void => {
    const identity: ResolvedIdentity = identityOf(res);
    const filters: Record<string, unknown> = {
      limit: queryInt(req.query.limit, 50),
      offset: queryInt(req.query.offset, 0),
    };
    const agentId: string | undefined = queryString(req.query.agent_id);
    const projectId: string | undefined = queryString(req.query.project_id);
    const type: string | undefined = queryString(req.query.type);
    const scope: string | undefined = queryString(req.query.scope);
    if (agentId) filters.agent_id = agentId;
    if (projectId) filters.project_id = projectId;
    if (type && MEMORY_TYPES.includes(type as MemoryType)) filters.type = type as MemoryType;
    if (scope && MEMORY_SCOPES.includes(scope as MemoryScope)) filters.scope = scope as MemoryScope;
    const items = deps.memoryStore.list(identity.user_id, filters);
    res.json({ items, count: items.length, total: deps.memoryStore.count(identity.user_id) });
  });

  router.post('/v1/memories/search', (req: ExpressRequest, res: ExpressResponse): void => {
    const body = bodyOf(req);
    if (typeof body.query !== 'string') {
      invalid(res, 'query 必须为字符串');
      return;
    }
    const identity: ResolvedIdentity = identityOf(res);
    const hits = searchMemories(deps.memoryStore, {
      query: body.query,
      user_id: identity.user_id,
      // body 中的 user_id / agent_id 属于身份字段，一律忽略，以服务端解析为准，
      // 防止伪造 agent_id 越权读取其它 Agent 的 scope=agent 专属记忆。
      agent_id: identity.agent_id,
      project_id:
        typeof body.project_id === 'string' ? body.project_id : identity.project_id,
      scopes: parseScopes(body.scopes),
      limit: typeof body.limit === 'number' ? body.limit : 10,
    });
    res.json({ query: body.query, count: hits.length, results: hits });
  });

  router.get('/v1/memories/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    const memory = deps.memoryStore.getById(identityOf(res).user_id, req.params.id);
    if (!memory) {
      notFound(res, '记忆');
      return;
    }
    res.json({ memory });
  });

  router.patch('/v1/memories/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    const body = bodyOf(req);
    if ('content' in body && (typeof body.content !== 'string' || body.content.trim() === '')) {
      invalid(res, 'content 不能为空');
      return;
    }
    const updated = deps.memoryStore.update(
      identityOf(res).user_id,
      req.params.id,
      body as Parameters<typeof deps.memoryStore.update>[2],
    );
    if (!updated) {
      notFound(res, '记忆');
      return;
    }
    res.json({ memory: updated });
  });

  router.delete('/v1/memories/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    const removed: boolean = deps.memoryStore.remove(identityOf(res).user_id, req.params.id);
    if (!removed) {
      notFound(res, '记忆');
      return;
    }
    res.json({ deleted: true, memory_id: req.params.id });
  });

  // ===== Agent Profile =====
  const adminToken: string = deps.adminToken ?? deps.config.settingsToken;

  router.post('/v1/agents', (req: ExpressRequest, res: ExpressResponse): void => {
    const body = bodyOf(req);
    if (typeof body.agent_id !== 'string' || body.agent_id.trim() === '' ||
        typeof body.name !== 'string' || body.name.trim() === '') {
      invalid(res, 'agent_id 与 name 不能为空');
      return;
    }
    const agentId: string = body.agent_id.trim();
    const isAdmin: boolean = isAdminRequest(req, adminToken);
    const hasPrivilegedField: boolean = AGENT_PRIVILEGED_FIELDS.some((field: string): boolean =>
      Object.prototype.hasOwnProperty.call(body, field),
    );
    if (!isAdmin && hasPrivilegedField) {
      res.status(403).json(
        errorBody('无权设置 Agent 特权运行配置，请以管理员身份通过 PATCH /v1/agents/:id 配置', 'forbidden'),
      );
      return;
    }
    if (!isAdmin && BUILTIN_AGENT_IDS.includes(agentId)) {
      res.status(403).json(errorBody('无权覆盖内置 Agent 配置', 'forbidden'));
      return;
    }
    if (hasPrivilegedField) {
      invalid(res, '运行配置字段请通过 PATCH /v1/agents/:id 更新');
      return;
    }
    const profile = deps.agentStore.create({
      agent_id: agentId,
      name: body.name.trim(),
      role: typeof body.role === 'string' ? body.role : '',
      description: typeof body.description === 'string' ? body.description : '',
      core_memory: typeof body.core_memory === 'string' ? body.core_memory : '',
    });
    res.status(201).json({ profile: isAdmin ? profile : toPublicAgentProfile(profile) });
  });

  router.get('/v1/agents', (req: ExpressRequest, res: ExpressResponse): void => {
    const isAdmin: boolean = isAdminRequest(req, adminToken);
    const items = deps.agentStore.list().map((item) =>
      isAdmin ? item : toPublicAgentProfile(item),
    );
    res.json({ items });
  });

  router.get('/v1/agents/:id/profile', (req: ExpressRequest, res: ExpressResponse): void => {
    const profile = deps.agentStore.get(req.params.id);
    if (!profile) {
      notFound(res, 'Agent Profile');
      return;
    }
    const isAdmin: boolean = isAdminRequest(req, adminToken);
    res.json({ profile: isAdmin ? profile : toPublicAgentProfile(profile) });
  });

  router.patch('/v1/agents/:id', (req: ExpressRequest, res: ExpressResponse): void => {
    if (!isAdminRequest(req, adminToken)) {
      res.status(401).json(
        errorBody(
          adminToken === ''
            ? 'Agent 运行配置仅允许本机 loopback 访问（可配置 ZHIYI_SETTINGS_TOKEN 开放远程管理）'
            : '需要有效的管理令牌（Authorization: Bearer <ZHIYI_SETTINGS_TOKEN> 或 X-Zhiyi-Admin-Token）',
          'unauthorized',
        ),
      );
      return;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      invalid(res, '请求体必须是对象');
      return;
    }
    try {
      const updated = deps.agentStore.updateAdmin(req.params.id, req.body as AgentAdminPatch);
      if (!updated) {
        notFound(res, 'Agent Profile');
        return;
      }
      res.json({ profile: updated });
    } catch (error) {
      if (error instanceof DomainError) {
        res.status(error.status).json(errorBody(error.message, error.code, error.type));
        return;
      }
      throw error;
    }
  });

  // ===== 对话轨迹 =====
  router.post('/v1/trajectories', (req: ExpressRequest, res: ExpressResponse): void => {
    const body = bodyOf(req);
    const identity: ResolvedIdentity = identityOf(res);
    const requestPayload: string =
      typeof body.request === 'string'
        ? body.request
        : JSON.stringify(body.request ?? body.messages ?? {});
    const saved = deps.trajectoryStore.save({
      request_id:
        typeof body.request_id === 'string' && body.request_id.trim() !== ''
          ? body.request_id.trim()
          : identity.request_id,
      user_id: identity.user_id,
      agent_id: identity.agent_id,
      session_id:
        typeof body.session_id === 'string' ? body.session_id : identity.session_id,
      task_id: typeof body.task_id === 'string' ? body.task_id : identity.task_id,
      project_id:
        typeof body.project_id === 'string' ? body.project_id : identity.project_id,
      model: typeof body.model === 'string' ? body.model : deps.config.defaultModel,
      request: requestPayload,
      response: typeof body.response === 'string' ? body.response : JSON.stringify(body.response ?? ''),
      status: typeof body.status === 'string' ? body.status : 'manual',
    });
    // Store 已按 (user_id, request_id) 查重；这里再做一层防御，绝不回传他人记录。
    if (saved.record.user_id !== identity.user_id) {
      res.status(500).json(errorBody('轨迹记录与当前用户不匹配', 'trajectory_user_mismatch', 'server_error'));
      return;
    }
    res.status(saved.inserted ? 201 : 200).json({ inserted: saved.inserted, trajectory: saved.record });
  });

  router.get('/v1/trajectories', (req: ExpressRequest, res: ExpressResponse): void => {
    const page = deps.trajectoryStore.list(identityOf(res).user_id, {
      agent_id: queryString(req.query.agent_id),
      session_id: queryString(req.query.session_id),
      limit: queryInt(req.query.limit, 20),
      offset: queryInt(req.query.offset, 0),
    });
    res.json(page);
  });

  // ===== 候选记忆 =====
  router.get('/v1/memory-candidates', (req: ExpressRequest, res: ExpressResponse): void => {
    const status: string | undefined = queryString(req.query.status);
    const items = deps.candidateStore.list(identityOf(res).user_id, {
      status: status as CandidateStatus | undefined,
      limit: queryInt(req.query.limit, 50),
      offset: queryInt(req.query.offset, 0),
    });
    res.json({ items, count: items.length });
  });

  router.post('/v1/memory-candidates/:id/approve', (req: ExpressRequest, res: ExpressResponse): void => {
    const result = deps.candidateStore.approve(
      identityOf(res).user_id,
      req.params.id,
      deps.memoryStore,
    );
    if (!result.ok) {
      res.status(result.reason === 'not_found' ? 404 : 409).json(
        errorBody(
          result.reason === 'not_found' ? '候选记忆不存在或无权访问' : '已拒绝的候选不能通过',
          result.reason ?? 'conflict',
        ),
      );
      return;
    }
    res.json(result);
  });

  router.post('/v1/memory-candidates/:id/reject', (req: ExpressRequest, res: ExpressResponse): void => {
    const candidate = deps.candidateStore.reject(identityOf(res).user_id, req.params.id);
    if (!candidate) {
      res.status(404).json(errorBody('候选记忆不存在、已通过或无权访问', 'not_found'));
      return;
    }
    res.json({ candidate });
  });

  // ===== 代理入口 =====
  router.get('/v1/images/files/:filename', (req: ExpressRequest, res: ExpressResponse): void => {
    const filename = String(req.params.filename ?? '').trim();
    if (!isValidImageFilename(filename)) {
      invalid(res, '非法图片文件名');
      return;
    }
    const found = deps.mediaStore.read(filename);
    if (!found) {
      notFound(res, '图片文件');
      return;
    }
    res.setHeader('Content-Type', found.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(found.data);
  });

  router.post('/v1/images/generations', (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    void (async (): Promise<void> => {
      const body = bodyOf(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (prompt === '') {
        invalid(res, 'prompt 不能为空');
        return;
      }
      const result = await executeImageGeneration(
        {
          config: deps.config,
          transport: deps.transport,
          logger: deps.logger,
          mediaStore: deps.mediaStore,
          upstream: deps.upstream,
        },
        body,
        { publicOrigin: requestPublicOrigin(req) },
      );
      if (!result.ok) {
        res
          .status(result.status >= 400 ? result.status : 502)
          .json(errorBody(result.errorText || '生图上游请求失败', 'upstream_error', 'upstream_error'));
        return;
      }
      res.status(result.status).json(result.payload);
    })().catch(next);
  });

  router.post('/v1/titles', (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    void (async (): Promise<void> => {
      const body = bodyOf(req);
      const result = await executeTitleGeneration(
        {
          config: deps.config,
          transport: deps.transport,
          upstream: deps.upstream,
        },
        {
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          assistantReply: typeof body.assistant_reply === 'string' ? body.assistant_reply : undefined,
          messages: Array.isArray(body.messages) ? (body.messages as never) : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          maxLength: typeof body.max_length === 'number' ? body.max_length : undefined,
        },
      );
      res.json(result);
    })().catch(next);
  });

  router.post('/v1/chat/completions', (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    void handleChatCompletion(req, res, deps).catch(next);
  });

  // ===== 仅 Mock 模式开放的调试端点 =====
  if (deps.config.mockUpstream && deps.mock) {
    const mock = deps.mock;
    router.get('/__mock__/last-request', (_req: ExpressRequest, res: ExpressResponse): void => {
      res.json({
        count: mock.requestLog.length,
        request: mock.getLastRequest(),
        requests: mock.requestLog.slice(-5),
        extraction_prompt: mock.lastExtractionPrompt,
      });
    });
    router.post('/__mock__/configure', (req: ExpressRequest, res: ExpressResponse): void => {
      const body = bodyOf(req);
      const allowedModes: readonly string[] = ['auto', 'text', 'tool', 'error', 'slow', 'stream'];
      const mode: string =
        typeof body.mode === 'string' && allowedModes.includes(body.mode) ? body.mode : 'auto';
      const behavior = mock.configure({
        mode: mode as MockMode,
        status: typeof body.status === 'number' ? body.status : undefined,
        delayMs: typeof body.delayMs === 'number' ? body.delayMs : undefined,
        errorBody: body.errorBody,
        chunks: Array.isArray(body.chunks) ? (body.chunks as string[]) : undefined,
      });
      res.json({ behavior });
    });
    router.post('/__mock__/reset', (_req: ExpressRequest, res: ExpressResponse): void => {
      mock.reset();
      res.json({ ok: true });
    });
    router.post('/mock/v1/chat/completions', (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
      void (async (): Promise<void> => {
        const web: Response = await mock.handle(bodyOf(req));
        await writeWebResponse(web, res);
      })().catch(next);
    });
  }

  router.use((_req: ExpressRequest, res: ExpressResponse): void => {
    res.status(404).json(errorBody('接口不存在', 'not_found'));
  });
  return router;
}

/** Express 统一错误处理：JSON 解析错误与内部异常都返回 OpenAI 风格错误体。 */
export const errorMiddleware: ErrorRequestHandler = (
  error: unknown,
  _req: ExpressRequest,
  res: ExpressResponse,
  _next: NextFunction,
): void => {
  const err = (error ?? {}) as { status?: number; message?: string; body?: unknown };
  const status: number = typeof err.status === 'number' && err.status >= 400 ? err.status : 500;
  const message: string =
    status === 400 && err.body !== undefined
      ? '请求体不是合法 JSON'
      : (err.message ?? '服务内部错误');
  if (status >= 500) console.error('[memory-gateway] 未处理异常', error);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: status === 400 ? 'invalid_json' : 'internal_error',
    },
  });
};
