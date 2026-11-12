/**
 * 模型协议适配器：把知忆 `ModelAdapter.openRawStream()` 适配成 OpenClaw Agent Core 的 `StreamFn`。
 *
 * 完整支持：
 * - 普通与流式文本 delta（text_start / text_delta / text_end）
 * - Tool Call 与参数增量（toolcall_start / toolcall_delta / toolcall_end）
 * - 完整 AssistantMessage（stopReason = 'stop' | 'length' | 'toolUse'）
 * - Usage 统计上报
 * - 模型调用异常 / HTTP 错误 / AbortSignal 取消（严格按 StreamFn 契约写入流而不同步抛出）
 */
import type { Logger } from '../../../logger';
import type { ModelAdapter, TokenUsage } from '../../adapters/model/model-adapter';
import {
  createEmptyTransportUsage,
} from '../../vendor/openclaw/ai-compat/transports.js';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type StreamFn,
  type TextContent,
  type ToolCall,
} from '../../vendor/openclaw/llm-core/index.js';
import { contextToOpenAIMessages, toolsToOpenAITools } from './message-adapter';

interface OpenAIStreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamChunk {
  model?: string;
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: OpenAIStreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: Partial<TokenUsage> | null;
}

interface PendingToolState {
  contentIndex: number;
  id: string;
  name: string;
  argsJson: string;
}

function createBaseAssistantMessage(model: Model): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyTransportUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function parseToolArgsSafely(rawJson: string): Record<string, unknown> {
  const trimmed = rawJson.trim();
  if (trimmed === '') return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { __invalid_tool_arguments: parsed };
  } catch {
    // 非法 JSON 不伪装为空对象，以便 TypeBox Schema 校验拦截并把格式错误回传给模型。
    return { __invalid_json_args: trimmed };
  }
}

function mapStopReason(
  finishReason: string | null,
  hasToolCalls: boolean,
): Extract<StopReason, 'stop' | 'length' | 'toolUse'> {
  if (finishReason === 'tool_calls' || (hasToolCalls && (!finishReason || finishReason === 'stop'))) {
    return 'toolUse';
  }
  if (finishReason === 'length') return 'length';
  return 'stop';
}

export function createZhiyiStreamFn(deps: {
  modelAdapter: ModelAdapter;
  logger: Logger;
  onUsage?: (usage: TokenUsage) => void;
}): StreamFn {
  return (
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const eventStream = createAssistantMessageEventStream();

    void (async (): Promise<void> => {
      const partial: AssistantMessage = createBaseAssistantMessage(model);
      let textIndex: number | null = null;
      const toolStates = new Map<number, PendingToolState>();
      let finishReason: string | null = null;

      try {
        if (options?.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new DOMException('Request was aborted', 'AbortError');
        }

        const openAiMessages = contextToOpenAIMessages(context);
        const openAiTools = toolsToOpenAITools(context.tools);

        const { response, model: resolvedModel } = await deps.modelAdapter.openRawStream(
          {
            model: model.id,
            messages: openAiMessages,
            tools: openAiTools,
            temperature: options?.temperature,
            max_tokens: options?.maxTokens,
          },
          { signal: options?.signal },
        );

        partial.model = resolvedModel;
        eventStream.push({ type: 'start', partial: { ...partial, content: [...partial.content] } });

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            if (options?.signal?.aborted) {
              throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new DOMException('Request was aborted', 'AbortError');
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith('data:')) continue;
              const payloadStr = line.slice(5).trim();
              if (payloadStr === '' || payloadStr === '[DONE]') continue;

              let chunk: OpenAIStreamChunk;
              try {
                chunk = JSON.parse(payloadStr) as OpenAIStreamChunk;
              } catch {
                continue;
              }

              if (chunk.id) partial.responseId = chunk.id;
              if (chunk.model) partial.responseModel = chunk.model;
              if (chunk.usage) {
                const input = Number(chunk.usage.prompt_tokens ?? 0);
                const output = Number(chunk.usage.completion_tokens ?? 0);
                const total = Number(chunk.usage.total_tokens ?? input + output);
                partial.usage = {
                  ...partial.usage,
                  input: partial.usage.input + input,
                  output: partial.usage.output + output,
                  totalTokens: partial.usage.totalTokens + total,
                };
                deps.onUsage?.({
                  prompt_tokens: input,
                  completion_tokens: output,
                  total_tokens: total,
                });
              }

              const choice = chunk.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }

              const delta = choice.delta;
              if (!delta) continue;

              if (typeof delta.content === 'string' && delta.content !== '') {
                if (textIndex === null) {
                  textIndex = partial.content.length;
                  partial.content.push({ type: 'text', text: '' });
                  eventStream.push({
                    type: 'text_start',
                    contentIndex: textIndex,
                    partial: { ...partial, content: [...partial.content] },
                  });
                }
                const block = partial.content[textIndex] as TextContent;
                block.text += delta.content;
                eventStream.push({
                  type: 'text_delta',
                  contentIndex: textIndex,
                  delta: delta.content,
                  partial: { ...partial, content: [...partial.content] },
                });
              }

              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const tcIdx = typeof tc.index === 'number' ? tc.index : 0;
                  let state = toolStates.get(tcIdx);
                  if (!state) {
                    const contentIndex = partial.content.length;
                    const callId =
                      typeof tc.id === 'string' && tc.id !== ''
                        ? tc.id
                        : `call_${Date.now()}_${tcIdx}`;
                    const callName = tc.function?.name ?? '';
                    state = {
                      contentIndex,
                      id: callId,
                      name: callName,
                      argsJson: '',
                    };
                    toolStates.set(tcIdx, state);
                    const initialToolCall: ToolCall = {
                      type: 'toolCall',
                      id: callId,
                      name: callName,
                      arguments: {},
                      partialJson: '',
                    };
                    partial.content.push(initialToolCall);
                    eventStream.push({
                      type: 'toolcall_start',
                      contentIndex,
                      partial: { ...partial, content: [...partial.content] },
                    });
                  } else {
                    const currentBlock = partial.content[state.contentIndex] as ToolCall;
                    if (typeof tc.id === 'string' && tc.id !== '') {
                      state.id = tc.id;
                      currentBlock.id = tc.id;
                    }
                    if (typeof tc.function?.name === 'string' && tc.function.name !== '') {
                      state.name = tc.function.name;
                      currentBlock.name = tc.function.name;
                    }
                  }

                  const argDelta = tc.function?.arguments;
                  if (typeof argDelta === 'string' && argDelta !== '') {
                    state.argsJson += argDelta;
                    const currentBlock = partial.content[state.contentIndex] as ToolCall;
                    currentBlock.partialJson = state.argsJson;
                    eventStream.push({
                      type: 'toolcall_delta',
                      contentIndex: state.contentIndex,
                      delta: argDelta,
                      partial: { ...partial, content: [...partial.content] },
                    });
                  }
                }
              }
            }
          }
        } finally {
          await reader.cancel().catch((): void => undefined);
        }

        if (textIndex !== null) {
          const block = partial.content[textIndex] as TextContent;
          eventStream.push({
            type: 'text_end',
            contentIndex: textIndex,
            content: block.text,
            partial: { ...partial, content: [...partial.content] },
          });
        }

        for (const state of toolStates.values()) {
          const parsedArgs = parseToolArgsSafely(state.argsJson);
          const finalToolCall: ToolCall = {
            type: 'toolCall',
            id: state.id,
            name: state.name,
            arguments: parsedArgs,
          };
          partial.content[state.contentIndex] = finalToolCall;
          eventStream.push({
            type: 'toolcall_end',
            contentIndex: state.contentIndex,
            toolCall: finalToolCall,
            partial: { ...partial, content: [...partial.content] },
          });
        }

        const reason = mapStopReason(finishReason, toolStates.size > 0);
        partial.stopReason = reason;
        eventStream.push({ type: 'done', reason, message: partial });
        eventStream.end(partial);
      } catch (error) {
        const aborted =
          Boolean(options?.signal?.aborted) ||
          (error instanceof Error && error.name === 'AbortError');
        const reason: Extract<StopReason, 'aborted' | 'error'> = aborted ? 'aborted' : 'error';
        const message = aborted
          ? '请求已取消'
          : error instanceof Error
            ? error.message
            : String(error);
        if (!aborted) {
          deps.logger.warn(`[openclaw-stream] 模型调用失败: ${message}`);
        }
        partial.stopReason = reason;
        partial.errorMessage = message;
        eventStream.push({ type: 'error', reason, error: partial });
        eventStream.end(partial);
      }
    })();

    return eventStream;
  };
}
