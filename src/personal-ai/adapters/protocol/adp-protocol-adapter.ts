/**
 * ADP Protocol Adapter：内部 PersonalAIEvent → 目标 SSE 协议。
 *
 * 源码核实依据（adp-chat-client commit e88e811）：
 * - server/vendor/openai_compatible/openai_compatible.py:202-276
 *   上游（本 Gateway）必须返回标准 OpenAI `data: {"choices":[{"delta":{"content":...}}]}`，
 *   以 `data: [DONE]` 结束；ADP server 自己把它转换成前端 V2 事件。
 * - server/util/helper.py:67-154  `to_event()` 输出 `data: {json}\n\n`，
 *   payload 首字段为 `Type`，其余为 PascalCase。
 * - server/vendor/interface.py:86-112  EventType 只有 11 个固定值，
 *   `to_event` 对其它类型直接抛 ValueError → **不支持自定义事件**。
 *
 * 因此：
 * 1) 默认 `openai` 协议用于真实链路（ADP OpenAICompatible vendor）；
 * 2) `adp-v2` 协议按源码枚举输出，供直连/扩展；
 * 3) 任务进度、Agent 事件一律降级为**纯文本** text.delta / delta.content，
 *    绝不向前端发送未经验证的自定义事件类型。
 */
import { randomUUID } from 'node:crypto';
import type { PersonalAIProtocol } from '../../config';
import type { PersonalAIEvent } from '../../events/event-types';

export interface ProtocolContext {
  protocol: PersonalAIProtocol;
  model: string;
  id: string;
  created: number;
  conversationId: string;
  recordId: string;
  userRecordId: string;
  messageId: string;
  accumulated: string;
}

export function createProtocolContext(
  protocol: PersonalAIProtocol,
  model: string,
  conversationId: string,
): ProtocolContext {
  return {
    protocol,
    model,
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    conversationId,
    recordId: randomUUID(),
    userRecordId: randomUUID(),
    messageId: randomUUID(),
    accumulated: '',
  };
}

function openaiChunk(
  ctx: ProtocolContext,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  const payload = {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function v2(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function v2Record(ctx: ProtocolContext, role: 'user' | 'assistant', status: string, text: string): Record<string, unknown> {
  const message: Record<string, unknown> = {
    Type: 'reply',
    MessageId: role === 'assistant' ? ctx.messageId : `${ctx.userRecordId}_msg`,
    Name: '',
    Title: '',
    Status: status,
    Contents: [{ Type: 'text', Text: text }],
  };
  const record: Record<string, unknown> = {
    Role: role,
    RecordId: role === 'assistant' ? ctx.recordId : ctx.userRecordId,
    ConversationId: ctx.conversationId,
    Status: status,
    StatusDesc: '',
    Messages: [message],
    Procedures: [],
  };
  if (role === 'assistant') {
    record.RelatedRecordId = ctx.userRecordId;
    record.ExtraInfo = { IsFromSelf: false, CanRating: false };
  } else {
    record.ExtraInfo = { IsFromSelf: true };
  }
  return record;
}

function v2StartFrames(ctx: ProtocolContext): string[] {
  return [
    v2({ Type: 'request_ack', RequestAck: v2Record(ctx, 'user', 'completed', '') }),
    v2({ Type: 'response.created', Response: v2Record(ctx, 'assistant', 'processing', '') }),
    v2({
      Type: 'message.added',
      Message: {
        Type: 'reply',
        MessageId: ctx.messageId,
        Name: '',
        Title: '',
        Status: 'processing',
        Contents: [{ Type: 'text', Text: '' }],
      },
    }),
  ];
}

function v2EndFrames(ctx: ProtocolContext): string[] {
  return [
    v2({
      Type: 'message.done',
      MessageId: ctx.messageId,
      Message: {
        Type: 'reply',
        MessageId: ctx.messageId,
        Name: '',
        Title: '',
        Status: 'completed',
        Contents: [{ Type: 'text', Text: ctx.accumulated }],
      },
    }),
    v2({ Type: 'response.completed', Response: v2Record(ctx, 'assistant', 'completed', ctx.accumulated) }),
  ];
}

/** 把非文本事件降级为可读的纯文本进度反馈（不发明自定义事件）。 */
export function progressText(event: PersonalAIEvent): string | null {
  switch (event.type) {
    case 'task_started':
      return `\n[知忆] 任务 ${event.taskId} 已提交至 MultiCA，等待本地 daemon 领取。\n`;
    case 'task_progress':
      return `\n[知忆] 任务进度 ${event.status}${event.message ? `：${event.message}` : ''}\n`;
    case 'agent_started':
      return `\n[知忆] Agent ${event.agentId} 已开始执行。\n`;
    case 'agent_completed':
      return `\n[知忆] Agent ${event.agentId} 执行完成，正在整理结果。\n`;
    case 'task_failed':
      return `\n[知忆] 任务失败：${event.error}\n`;
    default:
      return null;
  }
}

export function encodeEvent(event: PersonalAIEvent, ctx: ProtocolContext): string[] {
  if (ctx.protocol === 'adp-v2') {
    switch (event.type) {
      case 'message_start':
        return v2StartFrames(ctx);
      case 'text_delta':
      case 'final_answer':
        ctx.accumulated += event.content;
        return [v2({ Type: 'text.delta', MessageId: ctx.messageId, ContentIndex: 0, Text: event.content })];
      case 'error': {
        const text: string = `\n[错误] ${event.message}\n`;
        ctx.accumulated += text;
        return [v2({ Type: 'error', Error: { Code: -1, Message: event.message } })];
      }
      case 'message_end':
        return v2EndFrames(ctx);
      default: {
        const text: string | null = progressText(event);
        if (!text) return [];
        ctx.accumulated += text;
        return [v2({ Type: 'text.delta', MessageId: ctx.messageId, ContentIndex: 0, Text: text })];
      }
    }
  }

  // 默认 openai 协议：ADP OpenAICompatible vendor 的真实输入契约。
  switch (event.type) {
    case 'message_start':
      return [openaiChunk(ctx, { role: 'assistant' })];
    case 'text_delta':
    case 'final_answer':
      ctx.accumulated += event.content;
      return [openaiChunk(ctx, { content: event.content })];
    case 'error': {
      const text: string = `\n[错误] ${event.message}\n`;
      ctx.accumulated += text;
      return [openaiChunk(ctx, { content: text })];
    }
    case 'message_end':
      return [openaiChunk(ctx, {}, 'stop'), 'data: [DONE]\n\n'];
    default: {
      const text: string | null = progressText(event);
      if (!text) return [];
      ctx.accumulated += text;
      return [openaiChunk(ctx, { content: text })];
    }
  }
}

/** 供测试与文档说明：ADP V2 允许的事件类型（源码枚举，禁止扩展）。 */
export const ADP_V2_EVENT_TYPES: readonly string[] = [
  'request_ack',
  'response.created',
  'response.processing',
  'response.completed',
  'message.added',
  'message.processing',
  'message.done',
  'content.added',
  'text.delta',
  'error',
  'conversation',
];

/**
 * 取一个 SSE 帧的**顶层**事件类型。
 *
 * 不能用正则扫 `"Type":"…"`：V2 报文里还有合法的嵌套取值
 * （`Message.Type` ∈ MessageType：reply / thought / tool_call …，
 *  `Contents[].Type` ∈ ContentType：text / image / widget …，见 interface.py:55-84），
 * 正则会把它们误当成事件类型。必须解析 JSON 后只读顶层 `Type`。
 *
 * @param frame 完整的 SSE 帧，形如 `data: {json}\n\n`
 * @returns 顶层 Type；帧不含 JSON 负载（如 `data: [DONE]`）或字段缺失时返回 null
 */
export function frameEventType(frame: string): string | null {
  for (const line of frame.split('\n')) {
    const trimmed: string = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload: string = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload.startsWith('[')) return null; // [DONE] 等非 JSON 负载
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const type: unknown = (parsed as Record<string, unknown>).Type;
      return typeof type === 'string' ? type : null;
    } catch {
      return null;
    }
  }
  return null;
}
