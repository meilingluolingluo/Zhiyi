/**
 * 可信身份管理。
 *
 * ADP Chat Client 的 OpenAICompatible vendor 只在服务端发
 * `Authorization: Bearer <ApiKey>`，并不传浏览器侧的 user_id。
 * 因此身份一律由「服务端配置的 API Key 映射」决定，客户端自定义身份字段
 * （user_id / agent_id / account_id / ...）全部忽略。
 *
 * 可选启用 HMAC-SHA256 请求签名：
 *   X-PersonalAI-Timestamp: 毫秒时间戳
 *   X-PersonalAI-Signature: hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))
 * 配置 PERSONAL_AI_SHARED_SECRET 后强制校验；留空仅用于本地 PoC。
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatMessage } from '../../types';
import type { PersonalAIConfig } from '../config';

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface PersonalAIIdentity {
  user_id: string;
  agent_id: string;
  api_key: string | null;
  from_default: boolean;
  request_id: string;
  session_id: string | null;
  task_id: string | null;
  project_id: string | null;
  conversation_id: string;
  signature_verified: boolean;
}

export interface IdentityResolution {
  ok: boolean;
  identity?: PersonalAIIdentity;
  error?: string;
  status?: number;
}

function header(headers: HeaderBag, name: string): string | null {
  const target: string = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const text: string | undefined = Array.isArray(value) ? value[0] : value;
    return text === undefined ? null : text;
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 200);
  }
  return null;
}

function extractKey(headers: HeaderBag): string | null {
  const authorization: string | null = header(headers, 'authorization');
  if (authorization) {
    const match: RegExpMatchArray | null = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  return header(headers, 'x-api-key')?.trim() ?? null;
}

function verifySignature(
  secret: string,
  maxAgeMs: number,
  headers: HeaderBag,
  rawBody: string,
): string | null {
  if (secret === '') return null; // 本地 PoC：不启用签名
  const timestamp: string | null = header(headers, 'x-personalai-timestamp');
  const signature: string | null = header(headers, 'x-personalai-signature');
  if (!timestamp || !signature) return '缺少 X-PersonalAI-Timestamp / X-PersonalAI-Signature';
  const ts: number = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxAgeMs) return '请求签名已过期';
  const expected: string = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a: Buffer = Buffer.from(expected, 'utf8');
  const b: Buffer = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return '请求签名校验失败';
  return null;
}

/**
 * ADP 的 OpenAICompatible vendor 不传 conversation_id，但会把历史消息
 * 放进 messages（首条 user 消息在多轮中保持稳定）。因此用
 * 「可信 user_id + 首条 user 文本」的稳定哈希推导会话 ID；
 * 显式 X-Conversation-Id / conversation_id 可覆盖。
 */
export function deriveConversationId(
  userId: string,
  messages: ChatMessage[],
  explicit?: string | null,
): string {
  if (explicit && explicit.trim() !== '') return explicit.trim().slice(0, 200);
  const firstUser: ChatMessage | undefined = messages.find(
    (message: ChatMessage): boolean => message.role === 'user',
  );
  const text: string =
    typeof firstUser?.content === 'string' ? firstUser.content : JSON.stringify(firstUser?.content ?? '');
  const digest: string = createHash('sha256')
    .update(`${userId}\u0000${text.trim().slice(0, 500)}`)
    .digest('hex')
    .slice(0, 24);
  return `conv_${digest}`;
}

export function resolvePersonalAIIdentity(
  config: PersonalAIConfig,
  headers: HeaderBag,
  body: Record<string, unknown>,
  rawBody: string,
): IdentityResolution {
  const signatureError: string | null = verifySignature(
    config.sharedSecret,
    config.signatureMaxAgeMs,
    headers,
    rawBody,
  );
  if (signatureError) return { ok: false, error: signatureError, status: 401 };

  const apiKey: string | null = extractKey(headers);
  const mapped = apiKey ? config.apiKeys[apiKey] : undefined;
  const userId: string = mapped?.user_id ?? 'u1';
  const agentId: string = mapped?.agent_id ?? 'developer';

  const rawMessages: unknown = body.messages;
  const messages: ChatMessage[] = Array.isArray(rawMessages)
    ? (rawMessages.filter((item: unknown): boolean => !!item && typeof item === 'object') as ChatMessage[])
    : [];
  const metadata: Record<string, unknown> =
    body.metadata && typeof body.metadata === 'object'
      ? (body.metadata as Record<string, unknown>)
      : {};

  const conversationId: string = deriveConversationId(
    userId,
    messages,
    firstText(
      header(headers, 'x-conversation-id'),
      body.conversation_id,
      metadata.conversation_id,
    ),
  );

  return {
    ok: true,
    identity: {
      user_id: userId,
      agent_id: agentId,
      api_key: apiKey,
      from_default: mapped === undefined,
      request_id:
        firstText(header(headers, 'x-request-id'), body.request_id, metadata.request_id) ??
        `req_${randomUUID()}`,
      session_id: firstText(header(headers, 'x-session-id'), body.session_id, metadata.session_id),
      task_id: firstText(header(headers, 'x-task-id'), body.task_id, metadata.task_id),
      project_id: firstText(header(headers, 'x-project-id'), body.project_id, metadata.project_id),
      conversation_id: conversationId,
      signature_verified: config.sharedSecret !== '',
    },
  };
}
