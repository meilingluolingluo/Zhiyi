/**
 * 管理员鉴权辅助：与 src/upstream/routes.ts 的 ZHIYI_SETTINGS_TOKEN / loopback 策略一致。
 *
 * - 配置了 adminToken 时：强制校验 `Authorization: Bearer <token>` 或 `X-Zhiyi-Admin-Token: <token>`；
 * - 未配置 adminToken 时：仅允许本机 loopback IP（127.0.0.1 / ::1）执行管理操作。
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request as ExpressRequest } from 'express';

const LOOPBACK_RE: RegExp = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1|0:0:0:0:0:0:0:1)$/;

export function isLoopbackRequest(req: ExpressRequest): boolean {
  const address: string = req.ip ?? req.socket?.remoteAddress ?? '';
  return LOOPBACK_RE.test(address);
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const a: Buffer = Buffer.from(actual, 'utf8');
  const b: Buffer = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractAdminToken(req: ExpressRequest): string | null {
  const explicit: string | string[] | undefined = req.headers['x-zhiyi-admin-token'];
  const headerToken: string | undefined = Array.isArray(explicit) ? explicit[0] : explicit;
  if (typeof headerToken === 'string' && headerToken.trim() !== '') {
    return headerToken.trim();
  }
  const authorization: string | undefined = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match: RegExpMatchArray | null = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

export function isAdminRequest(req: ExpressRequest, adminToken: string): boolean {
  if (adminToken !== '') {
    const supplied: string | null = extractAdminToken(req);
    return supplied !== null && safeTokenEqual(supplied, adminToken);
  }
  return isLoopbackRequest(req);
}
