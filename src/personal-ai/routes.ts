/**
 * Personal AI HTTP 接口。
 *
 * - POST /v1/personal-ai/chat/completions  ← ADP OpenAICompatible vendor 的真实入口
 *   （请求/响应兼容 OpenAI Chat Completions，默认 SSE 流式）
 * - POST /v1/personal-ai/messages         ← ADP V2 SSE 直连模式（按源码枚举输出）
 * - GET|POST /v1/personal-ai/tasks...     ← 任务查询与取消（强制用户隔离）
 * - GET  /health/personal-ai              ← ADP / Personal AI / Memory / MultiCA daemon 健康
 */
import express, {
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type Router,
} from 'express';
import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../app';
import { errorBody } from '../errors';
import type { ChatMessage } from '../types';
import type { AgentExecutionAdapter } from './adapters/agent/agent-adapter';
import type { TokenUsage } from './adapters/model/model-adapter';
import {
  ADP_V2_EVENT_TYPES,
  createProtocolContext,
  encodeEvent,
  frameEventType,
  progressText,
} from './adapters/protocol/adp-protocol-adapter';
import type { PersonalAIConfig, PersonalAIProtocol } from './config';
import type { PersonalAIEvent } from './events/event-types';
import { resolvePersonalAIIdentity, type HeaderBag, type PersonalAIIdentity } from './identity/identity-manager';
import type { PersonalAIRuntime } from './runtime/personal-ai-runtime';
import type { DirectExecutionRunner } from './runtime/direct-execution-runner';
import type { OpenClawAgentRunner } from './runtime/openclaw/agent-runner';
import type { TaskManager } from './task/task-manager';
import type { TaskWorker } from './worker/task-worker';
import type { MulticaConfig } from './config';

export interface PersonalAIRouterDeps {
  base: AppDeps;
  config: PersonalAIConfig;
  multica: MulticaConfig;
  runtime: PersonalAIRuntime;
  taskManager: TaskManager;
  worker: TaskWorker;
  adapter: AgentExecutionAdapter | null;
  directRunner?: DirectExecutionRunner;
  openClawRunner?: OpenClawAgentRunner;
}

interface RawBodyRequest extends ExpressRequest {
  rawBody?: string;
}

function bodyOf(req: ExpressRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

function messagesOf(body: Record<string, unknown>): ChatMessage[] | null {
  const raw: unknown = body.messages;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const messages: ChatMessage[] = raw.filter(
    (item: unknown): item is ChatMessage => !!item && typeof item === 'object',
  );
  return messages.length > 0 ? messages : null;
}

function resolveProtocol(req: ExpressRequest, config: PersonalAIConfig): PersonalAIProtocol {
  const fromHeader: unknown = req.headers['x-personalai-protocol'];
  const fromQuery: unknown = req.query.protocol;
  const value: string = String(fromHeader ?? fromQuery ?? config.protocol).toLowerCase();
  return value === 'adp-v2' ? 'adp-v2' : 'openai';
}

function sseHeaders(res: ExpressResponse): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

function authFailure(res: ExpressResponse, status: number, message: string): void {
  res.status(status).json(errorBody(message, status === 401 ? 'unauthorized' : 'bad_request'));
}

function identify(
  req: ExpressRequest,
  deps: PersonalAIRouterDeps,
): { ok: true; identity: PersonalAIIdentity } | { ok: false; status: number; error: string } {
  const body: Record<string, unknown> = bodyOf(req);
  const rawBody: string = (req as RawBodyRequest).rawBody ?? JSON.stringify(body);
  const result = resolvePersonalAIIdentity(
    deps.config,
    req.headers as HeaderBag,
    body,
    rawBody,
  );
  if (!result.ok || !result.identity) {
    return { ok: false, status: result.status ?? 401, error: result.error ?? '身份解析失败' };
  }
  return { ok: true, identity: result.identity };
}

export function createPersonalAIRouter(deps: PersonalAIRouterDeps): Router {
  const router: Router = express.Router();

  router.post('/v1/personal-ai/chat/completions', async (req, res): Promise<void> => {
    const auth = identify(req, deps);
    if (!auth.ok) {
      authFailure(res, auth.status, auth.error);
      return;
    }
    if (!deps.config.enabled) {
      authFailure(res, 503, '知忆未启用（PERSONAL_AI_ENABLED=false）');
      return;
    }
    const body: Record<string, unknown> = bodyOf(req);
    const messages: ChatMessage[] | null = messagesOf(body);
    if (!messages) {
      authFailure(res, 400, 'messages 必须为非空数组');
      return;
    }
    const protocol: PersonalAIProtocol = resolveProtocol(req, deps.config);
    const model: string =
      typeof body.model === 'string' && body.model.trim() !== ''
        ? body.model
        : deps.base.config.defaultModel;
    // 响应/SSE 帧应显示「真正生效的模型」：设置页启用且以设置为准时不回显 ADP 固定 ModelName。
    const activeSettings = deps.base.upstream?.view();
    const responseModel: string =
      activeSettings?.active &&
      activeSettings.model.trim() !== '' &&
      (activeSettings.modelOverride !== 'request' || typeof body.model !== 'string')
        ? activeSettings.model.trim()
        : model;

    const headerTimezone: string | undefined = req.header('x-timezone') ?? undefined;

    // ADP 的 OpenAICompatible vendor 固定 stream:true；这里也支持 stream:false 便于调试。
    if (body.stream === false) {
      const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let text = '';
      let errorMessage: string | null = null;
      for await (const event of deps.runtime.run({
        identity: auth.identity,
        messages,
        model,
        timezone: headerTimezone,
        usage,
      })) {
        if (event.type === 'text_delta' || event.type === 'final_answer') text += event.content;
        else if (event.type === 'error') {
          errorMessage = event.message;
          break;
        } else {
          const progress: string | null = progressText(event);
          if (progress) text += progress;
        }
      }
      if (errorMessage) {
        // 非流式必须保持 OpenAI 语义：上游错误用对应 HTTP 状态码，而不是 200 + 文本。
        const matched: RegExpMatchArray | null = errorMessage.match(/模型上游返回\s*(\d{3})/);
        const upstreamStatus: number = matched ? Number(matched[1]) : 0;
        const status: number =
          upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502;
        res.status(status).json(errorBody(errorMessage, 'upstream_error', 'upstream_error'));
        return;
      }
      res.json({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage,
      });
      return;
    }

    sseHeaders(res);
    const ctx = createProtocolContext(protocol, responseModel, auth.identity.conversation_id);
    const controller: AbortController = new AbortController();
    let clientGone = false;
    res.on('close', (): void => {
      clientGone = true;
      controller.abort();
    });
    try {
      for await (const event of deps.runtime.run({
        identity: auth.identity,
        messages,
        model,
        timezone: headerTimezone,
        signal: controller.signal,
      })) {
        if (clientGone) break;
        for (const frame of encodeEvent(event, ctx)) res.write(frame);
      }
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      for (const frame of encodeEvent({ type: 'error', message }, ctx)) res.write(frame);
      for (const frame of encodeEvent({ type: 'message_end' }, ctx)) res.write(frame);
    } finally {
      if (!clientGone) res.end();
    }
  });

  /** ADP V2 SSE 直连模式：只输出源码枚举内的事件类型。 */
  router.post('/v1/personal-ai/messages', async (req, res): Promise<void> => {
    const auth = identify(req, deps);
    if (!auth.ok) {
      authFailure(res, auth.status, auth.error);
      return;
    }
    // 与 /chat/completions 保持一致：关闭 Personal AI 时不得再对外提供服务。
    if (!deps.config.enabled) {
      authFailure(res, 503, '知忆未启用（PERSONAL_AI_ENABLED=false）');
      return;
    }
    const body: Record<string, unknown> = bodyOf(req);
    const messages: ChatMessage[] | null = messagesOf(body);
    if (!messages) {
      authFailure(res, 400, 'messages 必须为非空数组');
      return;
    }
    sseHeaders(res);
    const ctx = createProtocolContext('adp-v2', deps.base.config.defaultModel, auth.identity.conversation_id);
    const headerTimezone: string | undefined = req.header('x-timezone') ?? undefined;
    for await (const event of deps.runtime.run({
      identity: auth.identity,
      messages,
      timezone: headerTimezone,
    })) {
      for (const frame of encodeEvent(event, ctx)) {
        // 防御性校验：绝不向前端发送未经验证的自定义事件类型。
        // 只认帧的「顶层」Type（嵌套的 Message.Type / Contents[].Type 不是事件类型）。
        const eventType: string | null = frameEventType(frame);
        if (eventType !== null && !ADP_V2_EVENT_TYPES.includes(eventType)) continue;
        res.write(frame);
      }
    }
    res.end();
  });

  router.get('/v1/personal-ai/tasks', (req, res): void => {
    const auth = identify(req, deps);
    if (!auth.ok) {
      authFailure(res, auth.status, auth.error);
      return;
    }
    const rawLimit: unknown = req.query.limit;
    const parsed: number = Number(rawLimit);
    const limit: number = Number.isFinite(parsed) && parsed > 0 ? Math.min(200, Math.floor(parsed)) : 50;
    res.json({ items: deps.taskManager.listForUser(auth.identity.user_id, limit) });
  });

  router.get('/v1/personal-ai/tasks/:id', (req, res): void => {
    const auth = identify(req, deps);
    if (!auth.ok) {
      authFailure(res, auth.status, auth.error);
      return;
    }
    const task = deps.taskManager.getForUser(auth.identity.user_id, req.params.id);
    if (!task) {
      res.status(404).json(errorBody('任务不存在或无权访问', 'not_found'));
      return;
    }
    res.json(task);
  });

  router.post('/v1/personal-ai/tasks/:id/cancel', async (req, res): Promise<void> => {
    const auth = identify(req, deps);
    if (!auth.ok) {
      authFailure(res, auth.status, auth.error);
      return;
    }
    const before = deps.taskManager.getForUser(auth.identity.user_id, req.params.id);
    const outcome = deps.taskManager.cancelForUser(auth.identity.user_id, req.params.id);
    if (!outcome.ok) {
      res.status(outcome.reason === 'not_found' ? 404 : 409).json(
        errorBody(`任务无法取消：${outcome.reason}`, 'conflict'),
      );
      return;
    }
    let externalCancelled = false;
    if (before?.execution_mode === 'direct_llm') {
      const abortedDirect = deps.directRunner?.abort(req.params.id) ?? false;
      const abortedOpenClaw = deps.openClawRunner?.abort(req.params.id) ?? false;
      externalCancelled = abortedDirect || abortedOpenClaw;
    } else if (before?.external_task_id && deps.adapter?.cancelTask) {
      externalCancelled = await deps.adapter.cancelTask(
        before.external_task_id,
        before.external_run_id ?? undefined,
      );
    }
    res.json({
      ...outcome,
      external_cancelled: externalCancelled,
      note: externalCancelled
        ? '内部任务与 MultiCA run 均已取消'
        : '内部任务已标记取消；MultiCA run 取消能力未确认（可能缺少 run id 或 CLI 未连接）',
    });
  });

  /** 聚合健康：ADP / Personal AI / Memory Core / MultiCA daemon。 */
  router.get('/health/personal-ai', async (_req, res): Promise<void> => {
    let dbOk = true;
    try {
      deps.base.db.get<{ ok: number }>('SELECT 1 AS ok');
    } catch {
      dbOk = false;
    }
    let adp: { configured: boolean; reachable: boolean | null; error?: string } = {
      configured: deps.config.adpHealthUrl !== '',
      reachable: null,
    };
    if (deps.config.adpHealthUrl !== '') {
      try {
        const response: Response = await fetch(deps.config.adpHealthUrl, {
          signal: AbortSignal.timeout(1500),
        });
        adp = { configured: true, reachable: response.ok };
      } catch (error) {
        adp = {
          configured: true,
          reachable: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    let daemon: { status: string; available: boolean } = {
      status: deps.adapter ? 'unknown' : 'disabled',
      available: false,
    };
    if (deps.adapter?.daemonStatus) {
      daemon = await deps.adapter.daemonStatus();
    }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      personal_ai: {
        enabled: deps.config.enabled,
        protocol: deps.config.protocol,
        signature_required: deps.config.sharedSecret !== '',
      },
      adp,
      memory_core: { db: dbOk ? 'ok' : 'error', memory_enabled: deps.base.config.memoryEnabled },
      multica: {
        enabled: deps.multica.enabled,
        cli_path: deps.multica.cliPath,
        daemon_required: deps.multica.daemonRequired,
        daemon,
        poll_interval_ms: deps.multica.pollIntervalMs,
        max_concurrent_tasks: deps.multica.maxConcurrentTasks,
      },
      tasks: { active: deps.base.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM execution_tasks WHERE status IN ('pending','dispatching','running')",
      )?.n ?? 0 },
      time: new Date().toISOString(),
    });
  });

  return router;
}
