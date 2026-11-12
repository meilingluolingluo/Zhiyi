/**
 * 模型适配器：复用现有 OpenAI 兼容上游（fetchTransport 或内置 Mock），
 * 不重新实现模型供应商路由。MODEL_BASE_URL / MODEL_API_KEY 为可选覆盖，
 * 未设置时沿用 AppConfig 的 upstreamBaseUrl / upstreamApiKey。
 */
import { completionsUrl, type AppConfig } from '../../../config';
import type { Logger } from '../../../logger';
import type { ChatMessage, UpstreamTransport } from '../../../types';
import type { UpstreamService, ResolvedUpstream } from '../../../upstream/service';
import type { PersonalAIConfig } from '../../config';

export interface ModelAdapterDeps {
  config: AppConfig;
  personalAI: PersonalAIConfig;
  transport: UpstreamTransport;
  logger: Logger;
  /** 运行期模型服务设置；未注入时保持原有 .env 行为（测试 / Mock 模式）。 */
  upstream?: UpstreamService;
}

export class ModelAdapterError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ModelAdapterError';
  }
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface RawChatStreamRequest {
  messages: ChatMessage[];
  model?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
}

export class ModelAdapter {
  constructor(private readonly deps: ModelAdapterDeps) {}

  private baseUrl(): string {
    return this.deps.personalAI.modelBaseUrlOverride || this.deps.config.upstreamBaseUrl;
  }

  private apiKey(): string {
    return this.deps.personalAI.modelApiKeyOverride || this.deps.config.upstreamApiKey;
  }

  /**
   * 统一模型请求通道：复用知忆的模型设置、API Key、DUCX 认证刷新与超时控制。
   * 供 text-only `stream()` 与 OpenClaw Tool Calling `openRawStream()` 共用。
   */
  async openRawStream(
    request: RawChatStreamRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ response: Response; model: string }> {
    const resolved: ResolvedUpstream | null = this.deps.upstream
      ? await this.deps.upstream.resolveForRequest(request.model)
      : null;
    const modelName: string = resolved?.model || request.model || this.deps.config.defaultModel;
    const url: string = completionsUrl(resolved?.baseUrl ?? this.baseUrl());

    const buildHeaders = (auth: Record<string, string>): Record<string, string> => {
      const result: Record<string, string> = { 'content-type': 'application/json' };
      if (resolved) Object.assign(result, auth);
      else {
        const key: string = this.apiKey();
        if (!this.deps.config.mockUpstream && key !== '') result.authorization = `Bearer ${key}`;
      }
      return result;
    };

    const timeout: AbortSignal = AbortSignal.timeout(this.deps.config.upstreamTimeoutMs);
    const signal: AbortSignal = options.signal
      ? (AbortSignal.any([options.signal, timeout]) as AbortSignal)
      : timeout;

    const payload: Record<string, unknown> = {
      model: modelName,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools;
      if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
    }
    if (typeof request.temperature === 'number') payload.temperature = request.temperature;
    if (typeof request.max_tokens === 'number') payload.max_tokens = request.max_tokens;

    const body: string = JSON.stringify(payload);
    const send = (headers: Record<string, string>): Promise<Response> =>
      this.deps.transport(url, { method: 'POST', headers, body, signal });

    let response: Response = await send(buildHeaders(resolved?.headers ?? {}));
    // DUCX 登录态过期时重新铸造一次认证头，与 codex-mixin 的刷新策略一致。
    if ((response.status === 401 || response.status === 403) && resolved?.authMode === 'ducx') {
      resolved.onAuthRejected();
      const refreshed: ResolvedUpstream | null | undefined =
        await this.deps.upstream?.resolveForRequest(request.model);
      if (refreshed) response = await send(buildHeaders(refreshed.headers));
    }

    if (!response.ok || !response.body) {
      const text: string = await response.text().catch((): string => '');
      throw new ModelAdapterError(
        `模型上游返回 ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
    }

    return { response, model: modelName };
  }

  /** 流式调用上游，逐块产出 assistant 文本。 */
  async *stream(
    messages: ChatMessage[],
    options: {
      model?: string;
      signal?: AbortSignal;
      /** 上游在流末尾返回 usage 时回调（OpenAI stream_options.include_usage）。 */
      onUsage?: (usage: TokenUsage) => void;
    } = {},
  ): AsyncGenerator<string> {
    const { response } = await this.openRawStream(
      { model: options.model, messages },
      { signal: options.signal },
    );

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body!.getReader();
    const decoder: TextDecoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines: string[] = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line: string = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data: string = line.slice(5).trim();
          if (data === '' || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: Partial<TokenUsage>;
            };
            if (parsed.usage && options.onUsage) {
              options.onUsage({
                prompt_tokens: Number(parsed.usage.prompt_tokens ?? 0),
                completion_tokens: Number(parsed.usage.completion_tokens ?? 0),
                total_tokens: Number(parsed.usage.total_tokens ?? 0),
              });
            }
            const delta: string | undefined = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta !== '') yield delta;
          } catch {
            // 忽略注释行与非 JSON data 行，保持流式链路不中断。
          }
        }
      }
    } finally {
      await reader.cancel().catch((): void => undefined);
    }
  }

  /** 非流式语义由流式拼接提供，避免维护两套调用路径。 */
  async complete(messages: ChatMessage[], options: { model?: string; signal?: AbortSignal } = {}): Promise<string> {
    let text = '';
    for await (const delta of this.stream(messages, options)) text += delta;
    return text;
  }
}
