/**
 * OpenAI Chat Completions 代理。
 * 流程：解析身份 → 检索记忆 → 追加独立 system message → 转发上游 →
 *       原样返回响应 → 异步保存轨迹 → 异步提取候选记忆。
 * 注入记忆时只追加 messages，不改动任何其它字段或工具调用语义。
 */
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { completionsUrl, type AppConfig } from './config';
import { buildMemoryContext, injectMemoryMessages } from './context';
import { resolveIdentity, STRIPPED_BODY_FIELDS, type HeaderBag, type ResolvedIdentity } from './identity';
import { errorBody } from './errors';
import type { AgentStore } from './agents';
import type { MemoryStore } from './memories';
import type { BackgroundTracker } from './background';
import type { ExtractionQueue } from './extractor';
import type { TrajectoryStore } from './trajectories';
import type { Logger } from './logger';
import type { ChatMessage, UpstreamTransport } from './types';
import { lastUserPrompt } from './upstream/ducx-report';
import type { UpstreamService } from './upstream/service';

export interface ProxyDeps {
  config: AppConfig;
  agentStore: AgentStore;
  memoryStore: MemoryStore;
  trajectoryStore: TrajectoryStore;
  queue: ExtractionQueue;
  background: BackgroundTracker;
  transport: UpstreamTransport;
  logger: Logger;
  /** 运行期模型服务设置；未注入时保持原有 .env 行为。 */
  upstream?: UpstreamService;
}

interface BackgroundParams {
  identity: ResolvedIdentity;
  model: string;
  requestSnapshot: string;
  assistantText: string;
  status: string;
  shouldExtract: boolean;
  messages: ChatMessage[];
}

/** 从上游非流式响应中提取 assistant 文本（含 tool_calls 时序列化工具调用）。 */
export function extractAssistantText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: unknown[] };
      }>;
    };
    const message = parsed.choices?.[0]?.message;
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.tool_calls)) return JSON.stringify(message.tool_calls);
    return '';
  } catch {
    return raw.slice(0, 1000);
  }
}

/** 解析单个 SSE frame，拼接 delta.content。 */
export function parseSseFrame(frame: string): string {
  let text = '';
  for (const line of frame.split('\n')) {
    const trimmed: string = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data: string = trimmed.slice(5).trim();
    if (data === '' || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta: string | undefined = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') text += delta;
    } catch {
      // 忽略注释行或非 JSON 的 data 行，保持透传不受影响。
    }
  }
  return text;
}

function cloneMessages(messages: unknown[]): ChatMessage[] {
  return messages.map((message: unknown): ChatMessage => {
    if (message && typeof message === 'object') {
      return { ...(message as Record<string, unknown>) } as ChatMessage;
    }
    return { role: 'user', content: String(message ?? '') };
  });
}

function scheduleBackground(deps: ProxyDeps, params: BackgroundParams): void {
  deps.background.run(async (): Promise<void> => {
    try {
      const saved = deps.trajectoryStore.save({
        request_id: params.identity.request_id,
        user_id: params.identity.user_id,
        agent_id: params.identity.agent_id,
        session_id: params.identity.session_id,
        task_id: params.identity.task_id,
        project_id: params.identity.project_id,
        model: params.model,
        request: params.requestSnapshot,
        response: params.assistantText,
        status: params.status,
      });
      if (!saved.inserted || !params.shouldExtract) return;
      deps.queue.enqueue({
        trajectory: saved.record,
        messages: params.messages,
        assistantText: params.assistantText,
        source: 'auto-extract',
      });
    } catch (error) {
      deps.logger.error('轨迹保存失败（不影响模型请求）', error);
    }
  });
}

export async function handleChatCompletion(
  req: ExpressRequest,
  res: ExpressResponse,
  deps: ProxyDeps,
): Promise<void> {
  const rawBody: Record<string, unknown> =
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  if (!Array.isArray(rawBody.messages)) {
    res.status(400).json(errorBody('请求体缺少 messages 数组', 'missing_messages'));
    return;
  }

  // 复用路由中间件已解析的身份，避免同一请求生成两个不同的 request_id。
  const identity: ResolvedIdentity =
    (res.locals.identity as ResolvedIdentity | undefined) ??
    resolveIdentity(deps.config, req.headers as HeaderBag, rawBody);

  const requestModel: string | undefined =
    typeof rawBody.model === 'string' && rawBody.model.trim() !== '' ? rawBody.model.trim() : undefined;
  const resolved: Awaited<ReturnType<UpstreamService['resolveForRequest']>> = deps.upstream
    ? await deps.upstream.resolveForRequest(requestModel)
    : null;

  // 只删除自定义扩展字段，其余 OpenAI 协议字段（含 tools / tool_choice / tool_calls）原样透传。
  const cleanBody: Record<string, unknown> = { ...rawBody };
  for (const field of STRIPPED_BODY_FIELDS) delete cleanBody[field];
  cleanBody.model = resolved?.model ?? requestModel ?? deps.config.defaultModel;

  const originalMessages: ChatMessage[] = cloneMessages(rawBody.messages);

  // DUCX 来源上报：异步执行，失败只记日志，不影响模型请求。
  const userPrompt: string = lastUserPrompt(originalMessages);
  if (userPrompt !== '' && deps.upstream) {
    void deps.upstream
      .reportUsage({
        sessionId: identity.session_id ?? 'unknown-session',
        prompt: userPrompt,
        cwd: process.cwd(),
      })
      .catch((error: unknown): void => {
        deps.logger.warn('DUCX 来源上报失败（不影响请求）', error);
      });
  }

  const context = buildMemoryContext({
    config: deps.config,
    memoryStore: deps.memoryStore,
    agentStore: deps.agentStore,
    identity,
    messages: originalMessages,
  });
  const finalMessages: ChatMessage[] =
    context.injected && context.systemMessage
      ? injectMemoryMessages(originalMessages, context.systemMessage)
      : originalMessages;
  cleanBody.messages = finalMessages;

  const requestSnapshot: string = JSON.stringify(cleanBody);
  const model: string = String(cleanBody.model);
  const wantsStream: boolean = cleanBody.stream === true;
  const url: string = completionsUrl(resolved?.baseUrl ?? deps.config.upstreamBaseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (resolved) {
    Object.assign(headers, resolved.headers);
  } else if (deps.config.upstreamApiKey) {
    headers.authorization = `Bearer ${deps.config.upstreamApiKey}`;
  }

  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    controller.abort(new Error('upstream timeout'));
  }, deps.config.upstreamTimeoutMs);

  try {
    const upstream: Response = await deps.transport(url, {
      method: 'POST',
      headers,
      body: requestSnapshot,
      signal: controller.signal,
    });

    // 上游错误：原样回传状态码与响应体，并记录失败轨迹。
    if (!upstream.ok) {
      const errorText: string = await upstream.text();
      res
        .status(upstream.status)
        .set('content-type', upstream.headers.get('content-type') ?? 'application/json')
        .send(errorText);
      scheduleBackground(deps, {
        identity,
        model,
        requestSnapshot,
        assistantText: errorText,
        status: 'upstream_error',
        shouldExtract: false,
        messages: originalMessages,
      });
      return;
    }

    if (!wantsStream) {
      const rawText: string = await upstream.text();
      res
        .status(upstream.status)
        .set('content-type', upstream.headers.get('content-type') ?? 'application/json')
        .send(rawText);
      const assistantText: string = extractAssistantText(rawText);
      scheduleBackground(deps, {
        identity,
        model,
        requestSnapshot,
        assistantText,
        status: 'ok',
        shouldExtract: true,
        messages: originalMessages,
      });
      return;
    }

    // 流式：逐块透传 SSE，同时解析 delta 拼接最终响应内容。
    res.status(upstream.status);
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    );
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let disconnected = false;
    const onClose = (): void => {
      if (!res.writableEnded) disconnected = true;
    };
    res.on('close', onClose);

    let assistantText = '';
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const value: Uint8Array = result.value;
        if (disconnected) {
          await reader.cancel().catch((): void => undefined);
          break;
        }
        res.write(Buffer.from(value));
        sseBuffer += decoder.decode(value, { stream: true });
        let index: number = sseBuffer.indexOf('\n\n');
        while (index >= 0) {
          const frame: string = sseBuffer.slice(0, index);
          sseBuffer = sseBuffer.slice(index + 2);
          assistantText += parseSseFrame(frame);
          index = sseBuffer.indexOf('\n\n');
        }
      }
      assistantText += parseSseFrame(sseBuffer);
    }
    res.off('close', onClose);
    if (!disconnected && !res.writableEnded) res.end();

    scheduleBackground(deps, {
      identity,
      model,
      requestSnapshot,
      assistantText,
      status: 'ok',
      shouldExtract: !disconnected,
      messages: originalMessages,
    });
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    const aborted: boolean =
      controller.signal.aborted ||
      (error instanceof Error && error.name === 'AbortError') ||
      /timeout|abort/i.test(message);
    deps.logger.warn('上游请求失败', message);
    if (!res.headersSent) {
      res.status(aborted ? 504 : 502).json(
        errorBody(
          aborted ? `上游请求超时（${deps.config.upstreamTimeoutMs}ms）` : `上游请求失败：${message}`,
          aborted ? 'upstream_timeout' : 'upstream_error',
          'upstream_error',
        ),
      );
    } else if (!res.writableEnded) {
      res.end();
    }
    scheduleBackground(deps, {
      identity,
      model,
      requestSnapshot,
      assistantText: message,
      status: aborted ? 'timeout' : 'error',
      shouldExtract: false,
      messages: originalMessages,
    });
  } finally {
    clearTimeout(timer);
  }
}
