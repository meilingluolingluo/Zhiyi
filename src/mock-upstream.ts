/**
 * 内置 OpenAI 兼容 Mock 上游。
 * - 支持普通文本、tool_calls、SSE 流式、错误与超时模拟。
 * - 记录「最后一次收到的请求」，用于验证记忆注入内容。
 * - 通过进程内 transport 注入 Gateway，无需额外端口即可端到端跑通。
 */
import { randomUUID } from 'node:crypto';
import { ruleBasedExtract } from './extraction-rules';
import type { ChatMessage, ExtractedCandidate, UpstreamTransport } from './types';

export type MockMode = 'auto' | 'text' | 'tool' | 'error' | 'slow' | 'stream';

export interface MockBehavior {
  mode: MockMode;
  status?: number;
  delayMs?: number;
  errorBody?: unknown;
  chunks?: string[];
}

export const MOCK_REPLY_TEXT = '这是 Mock 上游的示例回复，用于验证记忆网关的完整链路。';

function abortError(): Error {
  const error = new Error('上游请求超时或已取消');
  error.name = 'AbortError';
  return error;
}

function delayWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject): void => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    timer = setTimeout((): void => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function baseEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `chatcmpl-mock-${randomUUID().slice(0, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : 'mock-gpt',
  };
}

export class MockUpstream {
  public lastRequest: Record<string, unknown> | null = null;
  public readonly requestLog: Array<Record<string, unknown>> = [];
  public lastExtractionPrompt = '';
  private behavior: MockBehavior = { mode: 'auto' };

  configure(partial: Partial<MockBehavior>): MockBehavior {
    this.behavior = { mode: 'auto', ...partial };
    return { ...this.behavior };
  }

  getBehavior(): MockBehavior {
    return { ...this.behavior };
  }

  reset(): void {
    this.behavior = { mode: 'auto' };
    this.lastRequest = null;
    this.requestLog.length = 0;
    this.lastExtractionPrompt = '';
  }

  getLastRequest(): Record<string, unknown> | null {
    return this.lastRequest;
  }

  /** 处理一次 chat/completions 请求，返回标准 Web Response。 */
  async handle(body: Record<string, unknown>, signal?: AbortSignal | null): Promise<Response> {
    this.lastRequest = body;
    this.requestLog.push(body);
    if (this.requestLog.length > 50) this.requestLog.shift();

    const behavior: MockBehavior = { ...this.behavior };
    if (behavior.delayMs && behavior.delayMs > 0) {
      await delayWithSignal(behavior.delayMs, signal);
    }
    if (behavior.mode === 'slow') {
      await delayWithSignal(behavior.delayMs ?? 5000, signal);
    }
    if (signal?.aborted) throw abortError();

    if (behavior.mode === 'error') {
      return jsonResponse(
        behavior.errorBody ?? {
          error: { message: 'Mock 上游模拟的故障', type: 'upstream_error', code: 'mock_error' },
        },
        behavior.status ?? 500,
      );
    }

    const wantsStream: boolean = body.stream === true || behavior.mode === 'stream';
    if (wantsStream) return this.streamResponse(body, behavior, signal);
    return this.nonStreamResponse(body, behavior);
  }

  private nonStreamResponse(
    body: Record<string, unknown>,
    behavior: MockBehavior,
  ): Response {
    const envelope: Record<string, unknown> = baseEnvelope(body);
    // 只有显式配置 mode=tool 才返回工具调用，避免普通带 tools 的请求被误判。
    const wantsTool: boolean = behavior.mode === 'tool';
    if (wantsTool) {
      return jsonResponse({
        ...envelope,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_mock_${randomUUID().slice(0, 6)}`,
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: JSON.stringify({ city: 'Shenzhen' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    }
    return jsonResponse({
      ...envelope,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: MOCK_REPLY_TEXT },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 16, total_tokens: 28 },
    });
  }

  private streamResponse(
    body: Record<string, unknown>,
    behavior: MockBehavior,
    signal?: AbortSignal | null,
  ): Response {
    const envelope: Record<string, unknown> = baseEnvelope(body);
    const parts: string[] =
      behavior.chunks && behavior.chunks.length > 0
        ? behavior.chunks
        : ['这是 ', 'Mock 上游 ', '的流式逐块回复。'];
    const frames: string[] = [];

    frames.push(
      `data: ${JSON.stringify({
        ...envelope,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })}\n\n`,
    );
    for (const part of parts) {
      frames.push(
        `data: ${JSON.stringify({
          ...envelope,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        })}\n\n`,
      );
    }
    frames.push(
      `data: ${JSON.stringify({
        ...envelope,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 16, total_tokens: 28 },
      })}\n\n`,
    );
    frames.push('data: [DONE]\n\n');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        try {
          for (const frame of frames) {
            if (signal?.aborted) throw abortError();
            controller.enqueue(encoder.encode(frame));
            await delayWithSignal(5, signal);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  /** 供 Gateway 注入的 transport：不经过网络，但完全复用 fetch/Response 语义。 */
  createTransport(): UpstreamTransport {
    return async (url: string, init: RequestInit): Promise<Response> => {
      void url;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      return this.handle(parsed, init.signal ?? undefined);
    };
  }

  /**
   * 模拟「调用模型以 JSON 形式提取记忆」。
   * 真实模型不可用时退化为规则提取，保证本地链路可稳定验证。
   */
  async extract(
    messages: ChatMessage[],
    assistantText: string,
  ): Promise<ExtractedCandidate[]> {
    this.lastExtractionPrompt = [
      '请从以下对话中抽取具有长期价值的信息，以 JSON 返回 memories 数组。',
      JSON.stringify({ messages, assistantText }).slice(0, 4000),
    ].join('\n');
    const extracted: ExtractedCandidate[] = ruleBasedExtract(messages, assistantText);
    const modelJson: string = JSON.stringify({ memories: extracted });
    const parsed = JSON.parse(modelJson) as { memories?: ExtractedCandidate[] };
    return Array.isArray(parsed.memories) ? parsed.memories : [];
  }
}
