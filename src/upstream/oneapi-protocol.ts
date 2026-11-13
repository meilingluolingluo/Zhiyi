/**
 * OneAPI / 多协议出站适配层（参考 codex-mixin 的 provider/registry + protocol/convert + openai_events）：
 *
 * 让知忆直接调用 Baidu OneAPI（https://oneapi-comate.baidu-int.com）或标准 OpenAI 端点，
 * 无需再经过本机 8787 codex-mixin 代理：
 * - `openai_chat`        -> /v1/chat/completions（默认兼容端点与 8787 代理）
 * - `anthropic_messages` -> /v1/messages（Baidu OneAPI 非 GPT 模型：Claude / Grok / DeepSeek / Opus / Kimi / MiniMax / auto）
 * - `openai_responses`   -> /v1/responses（Baidu OneAPI GPT 系列模型）
 *
 * 所有对外返回统一规整为标准 OpenAI Chat Completions 格式（流式 SSE 与非流式 JSON），
 * 以便知忆 ModelAdapter、OpenClaw Agent Core、ExtractionQueue、proxy 与设置页测试复用同一条链路。
 */
import type { ChatMessage } from '../types';
import { endpointUrl, normalizeBaseUrl } from './model-settings';

export type UpstreamProtocolMode =
  | 'auto'
  | 'openai_chat'
  | 'anthropic_messages'
  | 'openai_responses';

export type ResolvedUpstreamProtocol =
  | 'openai_chat'
  | 'anthropic_messages'
  | 'openai_responses';

export interface OneApiRoute {
  protocol: ResolvedUpstreamProtocol;
  url: string;
  upstreamModel: string;
  isBaiduOneApi: boolean;
}

const BAIDU_ONEAPI_SLUG_SUFFIX = '-baidu-oneapi';

export function isBaiduOneApiUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(normalizeBaseUrl(baseUrl));
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'oneapi-comate.baidu-int.com' ||
      (host.endsWith('.baidu-int.com') && host.includes('oneapi'))
    );
  } catch {
    return false;
  }
}

/**
 * 若启用了直连 Baidu OneAPI（或显式多协议模式），剥离 codex-mixin 风格的 `-baidu-oneapi` 展示后缀，
 * 还原真实上游模型名（如 `Grok-4.7-baidu-oneapi` -> `Grok-4.7`）；标准代理地址则原样透传。
 */
export function resolveUpstreamModelId(
  baseUrl: string,
  model: string,
  override?: UpstreamProtocolMode,
): string {
  const trimmed = (model ?? '').trim();
  const shouldStrip =
    isBaiduOneApiUrl(baseUrl) || (override !== undefined && override !== 'auto' && override !== 'openai_chat');
  if (shouldStrip && trimmed.toLowerCase().endsWith(BAIDU_ONEAPI_SLUG_SUFFIX)) {
    return trimmed.slice(0, -BAIDU_ONEAPI_SLUG_SUFFIX.length).trim() || trimmed;
  }
  return trimmed;
}

export function resolveOneApiRoute(
  baseUrl: string,
  requestedModel: string,
  protocolOverride: UpstreamProtocolMode = 'auto',
): OneApiRoute {
  const isBaidu = isBaiduOneApiUrl(baseUrl);
  const upstreamModel = resolveUpstreamModelId(baseUrl, requestedModel, protocolOverride);

  let protocol: ResolvedUpstreamProtocol;
  if (protocolOverride !== 'auto') {
    protocol = protocolOverride;
  } else if (isBaidu) {
    const lower = upstreamModel.toLowerCase();
    if (lower.startsWith('gpt-')) {
      protocol = 'openai_responses';
    } else if (
      lower.startsWith('ernie-') ||
      lower.startsWith('deepseek-') ||
      lower.startsWith('glm-') ||
      lower.startsWith('qwen-')
    ) {
      protocol = 'openai_chat';
    } else {
      protocol = 'anthropic_messages';
    }
  } else {
    protocol = 'openai_chat';
  }

  const pathname =
    protocol === 'anthropic_messages'
      ? '/v1/messages'
      : protocol === 'openai_responses'
        ? '/v1/responses'
        : '/v1/chat/completions';

  return {
    protocol,
    url: endpointUrl(baseUrl, pathname),
    upstreamModel,
    isBaiduOneApi: isBaidu,
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part): string => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function safeJsonParseObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toAnthropicUserBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }];
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const item = part as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text });
    } else if (item.type === 'image_url' && item.image_url && typeof item.image_url === 'object') {
      const url = String((item.image_url as { url?: unknown }).url ?? '');
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        });
      }
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

function convertOpenAIToAnthropicBody(
  openAiBody: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const rawMessages = Array.isArray(openAiBody.messages)
    ? (openAiBody.messages as ChatMessage[])
    : [];
  const systemParts: string[] = [];
  const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  const pushMessage = (role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>): void => {
    if (blocks.length === 0) return;
    const prev = anthropicMessages[anthropicMessages.length - 1];
    if (prev && prev.role === role) {
      prev.content.push(...blocks);
    } else {
      anthropicMessages.push({ role, content: [...blocks] });
    }
  };

  for (const msg of rawMessages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = contentToText(msg.content).trim();
      if (text !== '') systemParts.push(text);
      continue;
    }

    if (msg.role === 'user') {
      pushMessage('user', toAnthropicUserBlocks(msg.content));
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      const text = contentToText(msg.content);
      if (text !== '') blocks.push({ type: 'text', text });
      if (Array.isArray(msg.tool_calls)) {
        for (const rawTc of msg.tool_calls) {
          if (!rawTc || typeof rawTc !== 'object') continue;
          const tc = rawTc as {
            id?: string;
            function?: { name?: string; arguments?: string };
          };
          if (tc.function?.name) {
            blocks.push({
              type: 'tool_use',
              id: tc.id || `toolu_${anthropicMessages.length}_${blocks.length}`,
              name: tc.function.name,
              input: safeJsonParseObject(tc.function.arguments),
            });
          }
        }
      }
      pushMessage('assistant', blocks);
      continue;
    }

    if (msg.role === 'tool') {
      pushMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || '',
          content: contentToText(msg.content),
        },
      ]);
    }
  }

  const out: Record<string, unknown> = {
    model: upstreamModel,
    messages: anthropicMessages,
    max_tokens:
      typeof openAiBody.max_tokens === 'number' && Number.isFinite(openAiBody.max_tokens)
        ? openAiBody.max_tokens
        : 4096,
    stream: Boolean(openAiBody.stream),
  };
  if (systemParts.length > 0) {
    out.system = systemParts.join('\n\n');
  }
  if (typeof openAiBody.temperature === 'number') {
    out.temperature = openAiBody.temperature;
  }

  if (Array.isArray(openAiBody.tools) && openAiBody.tools.length > 0) {
    const tools: Array<Record<string, unknown>> = [];
    for (const rawTool of openAiBody.tools) {
      if (!rawTool || typeof rawTool !== 'object') continue;
      const t = rawTool as {
        type?: string;
        function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
      };
      if (t.function?.name) {
        tools.push({
          name: t.function.name,
          description: t.function.description ?? '',
          input_schema: t.function.parameters ?? { type: 'object', properties: {} },
        });
      }
    }
    if (tools.length > 0) out.tools = tools;
  }

  if (openAiBody.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (openAiBody.tool_choice === 'required') out.tool_choice = { type: 'any' };
  else if (openAiBody.tool_choice && typeof openAiBody.tool_choice === 'object') {
    const fnName = (openAiBody.tool_choice as { function?: { name?: string } }).function?.name;
    if (fnName) out.tool_choice = { type: 'tool', name: fnName };
  }

  return out;
}

function convertOpenAIToResponsesBody(
  openAiBody: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const rawMessages = Array.isArray(openAiBody.messages)
    ? (openAiBody.messages as ChatMessage[])
    : [];
  const systemParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const msg of rawMessages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = contentToText(msg.content).trim();
      if (text !== '') systemParts.push(text);
      continue;
    }

    if (msg.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: contentToText(msg.content),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const text = contentToText(msg.content);
      if (text !== '') {
        input.push({
          type: 'message',
          role: 'assistant',
          content: text,
        });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const rawTc of msg.tool_calls) {
          if (!rawTc || typeof rawTc !== 'object') continue;
          const tc = rawTc as {
            id?: string;
            function?: { name?: string; arguments?: string };
          };
          if (tc.function?.name) {
            input.push({
              type: 'function_call',
              call_id: tc.id || `call_${input.length}`,
              name: tc.function.name,
              arguments:
                typeof tc.function.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments ?? {}),
            });
          }
        }
      }
      continue;
    }

    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output: contentToText(msg.content),
      });
    }
  }

  const out: Record<string, unknown> = {
    model: upstreamModel,
    input,
    // Baidu / Codex Responses 端点固定按 SSE 流式返回，非流式调用由适配层聚合后再返回 JSON
    stream: true,
    store: false,
  };
  if (systemParts.length > 0) {
    out.instructions = systemParts.join('\n\n');
  }
  if (typeof openAiBody.max_tokens === 'number' && Number.isFinite(openAiBody.max_tokens)) {
    out.max_output_tokens = openAiBody.max_tokens;
  }
  if (typeof openAiBody.temperature === 'number') {
    out.temperature = openAiBody.temperature;
  }
  if (Array.isArray(openAiBody.tools) && openAiBody.tools.length > 0) {
    const tools: Array<Record<string, unknown>> = [];
    for (const rawTool of openAiBody.tools) {
      if (!rawTool || typeof rawTool !== 'object') continue;
      const t = rawTool as {
        function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
      };
      if (t.function?.name) {
        tools.push({
          type: 'function',
          name: t.function.name,
          description: t.function.description ?? '',
          parameters: t.function.parameters ?? { type: 'object', properties: {} },
        });
      }
    }
    if (tools.length > 0) out.tools = tools;
  }

  return out;
}

export function buildUpstreamRequestForRoute(
  route: OneApiRoute,
  openAiBody: Record<string, unknown>,
  baseHeaders: Record<string, string>,
): { url: string; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { ...baseHeaders };

  if (route.protocol === 'anthropic_messages') {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'anthropic-version')) {
      headers['anthropic-version'] = '2023-06-01';
    }
    return {
      url: route.url,
      headers,
      body: JSON.stringify(convertOpenAIToAnthropicBody(openAiBody, route.upstreamModel)),
    };
  }

  if (route.protocol === 'openai_responses') {
    return {
      url: route.url,
      headers,
      body: JSON.stringify(convertOpenAIToResponsesBody(openAiBody, route.upstreamModel)),
    };
  }

  const normalizedBody =
    route.upstreamModel !== openAiBody.model
      ? { ...openAiBody, model: route.upstreamModel }
      : openAiBody;
  return {
    url: route.url,
    headers,
    body: JSON.stringify(normalizedBody),
  };
}

function mapAnthropicStopReason(stopReason: unknown, hasTools: boolean): string {
  if (stopReason === 'tool_use' || hasTools) return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  return 'stop';
}

function convertAnthropicJsonToOpenAI(
  raw: Record<string, unknown>,
  requestedModel: string,
): Record<string, unknown> {
  const contentBlocks = Array.isArray(raw.content)
    ? (raw.content as Array<Record<string, unknown>>)
    : [];
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of contentBlocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const usageRaw = (raw.usage && typeof raw.usage === 'object' ? raw.usage : {}) as Record<
    string,
    unknown
  >;
  const promptTokens = Number(usageRaw.input_tokens ?? 0);
  const completionTokens = Number(usageRaw.output_tokens ?? 0);

  return {
    id: typeof raw.id === 'string' ? raw.id : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof raw.model === 'string' ? raw.model : requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.join(''),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapAnthropicStopReason(raw.stop_reason, toolCalls.length > 0),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function sseDataLine(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function translateAnthropicSseStream(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = body.getReader();

  let buffer = '';
  let msgId = `chatcmpl-${Date.now()}`;
  let modelName = requestedModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: unknown = 'end_turn';
  let toolSeq = 0;
  const blockToToolIdx = new Map<number, number>();
  let finalized = false;

  const flushTerminal = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (finalized) return;
    finalized = true;
    const totalTokens = inputTokens + outputTokens;
    controller.enqueue(
      sseDataLine({
        id: msgId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: mapAnthropicStopReason(stopReason, blockToToolIdx.size > 0),
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: totalTokens,
        },
      }),
    );
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            flushTerminal(controller);
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const dataLines = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim());
            if (dataLines.length === 0) continue;
            const rawData = dataLines.join('\n');
            if (rawData === '' || rawData === '[DONE]') continue;

            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(rawData) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (evt.type === 'message_start' && evt.message && typeof evt.message === 'object') {
              const msg = evt.message as Record<string, unknown>;
              if (typeof msg.id === 'string') msgId = msg.id;
              if (typeof msg.model === 'string') modelName = msg.model;
              const u = msg.usage as Record<string, unknown> | undefined;
              if (u && typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
              continue;
            }

            if (
              evt.type === 'content_block_start' &&
              typeof evt.index === 'number' &&
              evt.content_block &&
              typeof evt.content_block === 'object'
            ) {
              const block = evt.content_block as Record<string, unknown>;
              if (block.type === 'tool_use') {
                const toolIdx = toolSeq;
                toolSeq += 1;
                blockToToolIdx.set(evt.index, toolIdx);
                controller.enqueue(
                  sseDataLine({
                    id: msgId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: toolIdx,
                              id:
                                typeof block.id === 'string'
                                  ? block.id
                                  : `call_${Date.now()}_${toolIdx}`,
                              type: 'function',
                              function: {
                                name: typeof block.name === 'string' ? block.name : '',
                                arguments: '',
                              },
                            },
                          ],
                        },
                      },
                    ],
                  }),
                );
              }
              continue;
            }

            if (
              evt.type === 'content_block_delta' &&
              typeof evt.index === 'number' &&
              evt.delta &&
              typeof evt.delta === 'object'
            ) {
              const delta = evt.delta as Record<string, unknown>;
              if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
                controller.enqueue(
                  sseDataLine({
                    id: msgId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [{ index: 0, delta: { content: delta.text } }],
                  }),
                );
              } else if (
                delta.type === 'input_json_delta' &&
                typeof delta.partial_json === 'string' &&
                delta.partial_json !== ''
              ) {
                const toolIdx = blockToToolIdx.get(evt.index) ?? 0;
                controller.enqueue(
                  sseDataLine({
                    id: msgId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: toolIdx,
                              function: { arguments: delta.partial_json },
                            },
                          ],
                        },
                      },
                    ],
                  }),
                );
              }
              continue;
            }

            if (evt.type === 'message_delta') {
              const d = evt.delta as Record<string, unknown> | undefined;
              if (d && 'stop_reason' in d) stopReason = d.stop_reason;
              const u = evt.usage as Record<string, unknown> | undefined;
              if (u && typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
              continue;
            }

            if (evt.type === 'message_stop') {
              flushTerminal(controller);
              controller.close();
              await reader.cancel().catch((): void => undefined);
              return;
            }

            if (evt.type === 'error') {
              const errObj = evt.error as Record<string, unknown> | undefined;
              const msg =
                typeof errObj?.message === 'string' ? errObj.message : JSON.stringify(evt);
              controller.error(new Error(`Anthropic 上游错误: ${msg}`));
              return;
            }
          }
          if (frames.length > 0) return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(): void {
      void reader.cancel().catch((): void => undefined);
    },
  });
}

function translateResponsesSseStream(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = body.getReader();

  let buffer = '';
  let respId = `chatcmpl-${Date.now()}`;
  let modelName = requestedModel;
  let toolSeq = 0;
  const outputIndexToToolIdx = new Map<number, number>();
  let finalized = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!finalized) {
              finalized = true;
              controller.enqueue(
                sseDataLine({
                  id: respId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: outputIndexToToolIdx.size > 0 ? 'tool_calls' : 'stop',
                    },
                  ],
                }),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const dataLines = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim());
            if (dataLines.length === 0) continue;
            const rawData = dataLines.join('\n');
            if (rawData === '' || rawData === '[DONE]') continue;

            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(rawData) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (evt.type === 'response.created' && evt.response && typeof evt.response === 'object') {
              const r = evt.response as Record<string, unknown>;
              if (typeof r.id === 'string') respId = r.id;
              if (typeof r.model === 'string') modelName = r.model;
              continue;
            }

            if (
              evt.type === 'response.output_item.added' &&
              evt.item &&
              typeof evt.item === 'object'
            ) {
              const item = evt.item as Record<string, unknown>;
              if (item.type === 'function_call') {
                const outIdx = typeof evt.output_index === 'number' ? evt.output_index : toolSeq;
                const toolIdx = toolSeq;
                toolSeq += 1;
                outputIndexToToolIdx.set(outIdx, toolIdx);
                controller.enqueue(
                  sseDataLine({
                    id: respId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: toolIdx,
                              id:
                                typeof item.call_id === 'string'
                                  ? item.call_id
                                  : typeof item.id === 'string'
                                    ? item.id
                                    : `call_${toolIdx}`,
                              type: 'function',
                              function: {
                                name: typeof item.name === 'string' ? item.name : '',
                                arguments: '',
                              },
                            },
                          ],
                        },
                      },
                    ],
                  }),
                );
              }
              continue;
            }

            if (
              evt.type === 'response.output_text.delta' &&
              typeof evt.delta === 'string' &&
              evt.delta !== ''
            ) {
              controller.enqueue(
                sseDataLine({
                  id: respId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [{ index: 0, delta: { content: evt.delta } }],
                }),
              );
              continue;
            }

            if (
              evt.type === 'response.function_call_arguments.delta' &&
              typeof evt.delta === 'string' &&
              evt.delta !== ''
            ) {
              const outIdx = typeof evt.output_index === 'number' ? evt.output_index : 0;
              const toolIdx = outputIndexToToolIdx.get(outIdx) ?? 0;
              controller.enqueue(
                sseDataLine({
                  id: respId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolIdx,
                            function: { arguments: evt.delta },
                          },
                        ],
                      },
                    },
                  ],
                }),
              );
              continue;
            }

            if (evt.type === 'response.completed') {
              const r = (evt.response ?? {}) as Record<string, unknown>;
              const u = (r.usage ?? {}) as Record<string, unknown>;
              const inputTokens = Number(u.input_tokens ?? 0);
              const outputTokens = Number(u.output_tokens ?? 0);
              const totalTokens = Number(u.total_tokens ?? inputTokens + outputTokens);
              finalized = true;
              controller.enqueue(
                sseDataLine({
                  id: respId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: outputIndexToToolIdx.size > 0 ? 'tool_calls' : 'stop',
                    },
                  ],
                  usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: totalTokens,
                  },
                }),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              await reader.cancel().catch((): void => undefined);
              return;
            }

            if (evt.type === 'response.failed' || evt.type === 'error') {
              const errMsg = JSON.stringify(evt.error ?? evt);
              controller.error(new Error(`Responses 上游错误: ${errMsg}`));
              return;
            }
          }
          if (frames.length > 0) return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(): void {
      void reader.cancel().catch((): void => undefined);
    },
  });
}

async function collectOpenAiSseToJson(
  sseStream: ReadableStream<Uint8Array>,
  requestedModel: string,
): Promise<Record<string, unknown>> {
  const reader = sseStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let id = `chatcmpl-${Date.now()}`;
  let model = requestedModel;
  let content = '';
  let finishReason = 'stop';
  let usage: Record<string, unknown> = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCalls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payloadStr = line.slice(5).trim();
        if (payloadStr === '' || payloadStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payloadStr) as {
            id?: string;
            model?: string;
            usage?: Record<string, unknown>;
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          };
          if (parsed.id) id = parsed.id;
          if (parsed.model) model = parsed.model;
          if (parsed.usage) usage = parsed.usage;
          const c = parsed.choices?.[0];
          if (c?.finish_reason) finishReason = c.finish_reason;
          if (typeof c?.delta?.content === 'string') content += c.delta.content;
          if (Array.isArray(c?.delta?.tool_calls)) {
            for (const tc of c.delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCalls.get(idx) ?? {
                id: tc.id || `call_${idx}`,
                type: 'function' as const,
                function: { name: tc.function?.name ?? '', arguments: '' },
              };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') {
                existing.function.arguments += tc.function.arguments;
              }
              toolCalls.set(idx, existing);
            }
          }
        } catch {
          // 忽略非 JSON 行
        }
      }
    }
  } finally {
    await reader.cancel().catch((): void => undefined);
  }

  const tcArray = Array.from(toolCalls.values());
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(tcArray.length > 0 ? { tool_calls: tcArray } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

export async function translateUpstreamResponse(
  protocol: ResolvedUpstreamProtocol,
  response: Response,
  options: { requestedModel: string; wantsStream: boolean },
): Promise<Response> {
  if (!response.ok || protocol === 'openai_chat') {
    return response;
  }

  if (protocol === 'anthropic_messages') {
    if (!options.wantsStream) {
      const rawJson = (await response.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify(convertAnthropicJsonToOpenAI(rawJson, options.requestedModel)),
        { status: response.status, headers: { 'content-type': 'application/json' } },
      );
    }
    if (!response.body) return response;
    return new Response(translateAnthropicSseStream(response.body, options.requestedModel), {
      status: response.status,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  }

  // protocol === 'openai_responses'
  if (!response.body) return response;
  const openAiSse = translateResponsesSseStream(response.body, options.requestedModel);
  if (options.wantsStream) {
    return new Response(openAiSse, {
      status: response.status,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  }

  const aggregatedJson = await collectOpenAiSseToJson(openAiSse, options.requestedModel);
  return new Response(JSON.stringify(aggregatedJson), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
