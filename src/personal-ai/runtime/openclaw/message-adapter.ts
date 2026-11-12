/**
 * 消息协议适配器：OpenClaw Context / AgentMessage <-> 知忆 OpenAI ChatMessage[]。
 * 同时也负责在 transformContext 阶段借助 OpenClaw CJK token 估算工具执行轻量化上下文压缩。
 */
import type { ChatMessage } from '../../../types';
import { estimateStringChars } from '../../vendor/openclaw/normalization-core/cjk-chars.js';
import { resolveCompactionThreshold } from '../../vendor/openclaw/agent-core/harness/compaction/compaction-threshold.js';
import type { AgentMessage } from '../../vendor/openclaw/agent-core/types.js';
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
} from '../../vendor/openclaw/llm-core/types.js';

function textPartsToString(content: string | ReadonlyArray<TextContent | ImageContent>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block): string => block.text)
    .join('\n');
}

function userMessageToChatMessage(msg: Extract<Message, { role: 'user' }>): ChatMessage {
  if (typeof msg.content === 'string') {
    return { role: 'user', content: msg.content };
  }
  const hasImage = msg.content.some((part) => part.type === 'image');
  if (!hasImage) {
    return { role: 'user', content: textPartsToString(msg.content) };
  }
  const parts: Array<Record<string, unknown>> = msg.content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: { url: `data:${part.mimeType};base64,${part.data}` },
        },
  );
  return { role: 'user', content: parts };
}

function assistantMessageToChatMessage(msg: AssistantMessage): ChatMessage {
  const texts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  for (const block of msg.content) {
    if (block.type === 'text' && block.text !== '') {
      texts.push(block.text);
    } else if (block.type === 'toolCall') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.arguments ?? {}),
        },
      });
    }
  }

  const text = texts.join('');
  if (toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: text !== '' ? text : null,
      tool_calls: toolCalls,
    };
  }
  return {
    role: 'assistant',
    content: text,
  };
}

export function contextToOpenAIMessages(context: Context): ChatMessage[] {
  const result: ChatMessage[] = [];
  if (context.systemPrompt && context.systemPrompt.trim() !== '') {
    result.push({ role: 'system', content: context.systemPrompt });
  }
  for (const msg of context.messages) {
    if (msg.role === 'user') {
      result.push(userMessageToChatMessage(msg));
    } else if (msg.role === 'assistant') {
      result.push(assistantMessageToChatMessage(msg));
    } else if (msg.role === 'toolResult') {
      const body = textPartsToString(msg.content);
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
        content: msg.isError && !body.startsWith('[错误]') ? `[错误] ${body}` : body,
      });
    }
  }
  return result;
}

export function toolsToOpenAITools(tools?: readonly Tool[]): Array<Record<string, unknown>> {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function extractTextFromAssistantMessage(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block): string => block.text)
    .join('');
}

export function findLastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate && candidate.role === 'assistant') {
      return candidate as AssistantMessage;
    }
  }
  return undefined;
}

function estimateMessageTokens(msg: AgentMessage): number {
  const raw = JSON.stringify(msg);
  return Math.max(16, Math.ceil(estimateStringChars(raw) / 4));
}

/**
 * 上下文裁剪（在 OpenClaw transformContext 中执行，不依赖 OpenClaw Session 持久化）：
 * 当消息总估算 token 超过阈值时，保留首条 user 请求与最近若干组不破坏 toolCall/toolResult 配对的尾段消息。
 */
export function compactAgentMessagesIfNeeded(
  messages: AgentMessage[],
  contextWindowTokens = 64_000,
): AgentMessage[] {
  if (messages.length <= 4) return messages;
  const threshold = resolveCompactionThreshold({
    contextWindowTokens,
    reserveTokensFloor: 4_000,
    minimumThresholdTokens: 8_000,
  });

  let totalTokens = 0;
  const costs = messages.map((m): number => {
    const t = estimateMessageTokens(m);
    totalTokens += t;
    return t;
  });
  if (totalTokens <= threshold) return messages;

  const keptHead = messages[0];
  let budget = threshold - costs[0] - 64;
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 1; i -= 1) {
    if (budget - costs[i] < 0) break;
    budget -= costs[i];
    cutIndex = i;
  }

  // 避免从 toolResult 中间切开，破坏 assistant(toolCall) <-> toolResult 配对
  while (cutIndex < messages.length && messages[cutIndex]?.role === 'toolResult') {
    cutIndex += 1;
  }

  if (cutIndex <= 1 || cutIndex >= messages.length) {
    return messages;
  }

  const omittedCount = cutIndex - 1;
  const notice: AgentMessage = {
    role: 'user',
    synthetic: true,
    content: `[上下文压缩提示] 为保持在模型上下文预算内，已省略中间 ${omittedCount} 条历史推理/工具消息。`,
    timestamp: Date.now(),
  };

  return [keptHead, notice, ...messages.slice(cutIndex)];
}

export function extractToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === 'toolCall');
}
