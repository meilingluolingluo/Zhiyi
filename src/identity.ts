/** 身份解析：user_id / agent_id 只由服务端 API Key 决定，绝不信任客户端。 */
import { randomUUID } from 'node:crypto';
import type { AppConfig, Identity } from './config';

export type HeaderBag = Record<string, string | string[] | undefined>;

/** 需要从转发给上游的请求体中剥离的上下文字段（不是 OpenAI 协议字段）。 */
export const STRIPPED_BODY_FIELDS: readonly string[] = [
  'user_id',
  'agent_id',
  'session_id',
  'task_id',
  'project_id',
  'request_id',
];

export interface ResolvedIdentity extends Identity {
  api_key: string | null;
  from_default: boolean;
  request_id: string;
  session_id: string | null;
  task_id: string | null;
  project_id: string | null;
}

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const target: string = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const raw: string | string[] | undefined = value;
    const text: string | undefined = Array.isArray(raw) ? raw[0] : raw;
    return text === undefined ? undefined : text;
  }
  return undefined;
}

function firstNonEmpty(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function extractApiKey(headers: HeaderBag): string | null {
  const authorization: string | undefined = headerValue(headers, 'authorization');
  if (authorization) {
    const match: RegExpMatchArray | null = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  return headerValue(headers, 'x-api-key')?.trim() ?? null;
}

/**
 * 解析请求身份。
 * - API Key 未命中映射表或缺失时，使用默认开发身份（保证本地 PoC 可跑）。
 * - session_id / task_id / project_id 支持 header 或 body 扩展字段。
 * - body 中的 user_id / agent_id 一律忽略。
 */
export function resolveIdentity(
  config: AppConfig,
  headers: HeaderBag,
  body: Record<string, unknown>,
): ResolvedIdentity {
  const apiKey: string | null = extractApiKey(headers);
  const mapped: Identity | undefined = apiKey ? config.apiKeys[apiKey] : undefined;
  const identity: Identity = mapped ?? config.defaultIdentity;

  return {
    user_id: identity.user_id,
    agent_id: identity.agent_id,
    api_key: apiKey,
    from_default: mapped === undefined,
    request_id:
      firstNonEmpty(headerValue(headers, 'x-request-id')) ?? `req_${randomUUID()}`,
    session_id: firstNonEmpty(
      headerValue(headers, 'x-session-id'),
      body.session_id,
      (body.metadata as Record<string, unknown> | undefined)?.session_id,
    ),
    task_id: firstNonEmpty(
      headerValue(headers, 'x-task-id'),
      body.task_id,
      (body.metadata as Record<string, unknown> | undefined)?.task_id,
    ),
    project_id: firstNonEmpty(
      headerValue(headers, 'x-project-id'),
      body.project_id,
      (body.metadata as Record<string, unknown> | undefined)?.project_id,
    ),
  };
}
