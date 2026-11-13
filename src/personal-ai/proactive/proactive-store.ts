/**
 * 主动提醒收件箱与调度状态持久化存储（proactive_notifications / proactive_schedule_state）。
 * 所有用户级查询和变更严格携带 user_id 条件，支持 dedupe_key 去重与跨重启调度恢复。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db';
import type { ProactiveNotificationKind } from '../domain/types';

export type ProactiveNotificationStatus = 'unread' | 'read' | 'dismissed';

export interface ProactiveNotification {
  id: string;
  user_id: string;
  kind: ProactiveNotificationKind;
  entity_type: 'task' | 'project' | 'goal' | 'execution' | 'memory_candidate';
  entity_id: string;
  dedupe_key: string;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  status: ProactiveNotificationStatus;
  channel: string;
  created_at: string;
  read_at: string | null;
}

export interface NewProactiveNotificationInput {
  userId: string;
  kind: ProactiveNotificationKind;
  entityType: ProactiveNotification['entity_type'];
  entityId: string;
  dedupeKey: string;
  title: string;
  summary: string;
  evidence?: Record<string, unknown>;
  channel?: string;
  createdAt?: string;
}

export interface ProactiveScheduleState {
  user_id: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string;
  last_summary: string | null;
  updated_at: string;
}

interface RawNotificationRow extends Omit<ProactiveNotification, 'evidence'> {
  evidence: string;
}

function parseEvidence(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToNotification(row: RawNotificationRow): ProactiveNotification {
  return {
    ...row,
    evidence: parseEvidence(row.evidence),
  };
}

export class ProactiveStore {
  constructor(private readonly db: Database) {}

  createIfNew(
    input: NewProactiveNotificationInput,
  ): { created: boolean; notification: ProactiveNotification } {
    const now = input.createdAt ?? new Date().toISOString();
    const id = `pnotif_${randomUUID()}`;
    const evidenceJson = JSON.stringify(input.evidence ?? {});
    const res = this.db.run(
      `INSERT OR IGNORE INTO proactive_notifications
         (id, user_id, kind, entity_type, entity_id, dedupe_key, title, summary, evidence, status, channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)`,
      [
        id,
        input.userId,
        input.kind,
        input.entityType,
        input.entityId,
        input.dedupeKey,
        input.title.slice(0, 200),
        input.summary.slice(0, 2000),
        evidenceJson.slice(0, 4000),
        input.channel ?? 'inbox',
        now,
      ],
    );
    const row = this.db.get<RawNotificationRow>(
      'SELECT * FROM proactive_notifications WHERE user_id = ? AND dedupe_key = ?',
      [input.userId, input.dedupeKey],
    ) as RawNotificationRow;
    return {
      created: res.changes > 0,
      notification: rowToNotification(row),
    };
  }

  getById(userId: string, id: string): ProactiveNotification | undefined {
    const row = this.db.get<RawNotificationRow>(
      'SELECT * FROM proactive_notifications WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    return row ? rowToNotification(row) : undefined;
  }

  list(
    userId: string,
    filters: {
      status?: ProactiveNotificationStatus | 'all';
      kind?: ProactiveNotificationKind;
      limit?: number;
      offset?: number;
    } = {},
  ): {
    items: ProactiveNotification[];
    total: number;
    unread_count: number;
    limit: number;
    offset: number;
  } {
    const conditions: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    const statusFilter = filters.status ?? 'all';
    if (statusFilter !== 'all') {
      conditions.push('status = ?');
      params.push(statusFilter);
    }
    if (filters.kind) {
      conditions.push('kind = ?');
      params.push(filters.kind);
    }
    const where = conditions.join(' AND ');
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const totalRow = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM proactive_notifications WHERE ${where}`,
      params,
    );
    const unreadRow = this.db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM proactive_notifications WHERE user_id = ? AND status = 'unread'",
      [userId],
    );
    const rows = this.db.all<RawNotificationRow>(
      `SELECT * FROM proactive_notifications WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return {
      items: rows.map(rowToNotification),
      total: Number(totalRow?.total ?? 0),
      unread_count: Number(unreadRow?.cnt ?? 0),
      limit,
      offset,
    };
  }

  markRead(userId: string, id: string): ProactiveNotification | undefined {
    const existing = this.getById(userId, id);
    if (!existing) return undefined;
    if (existing.status === 'unread') {
      const now = new Date().toISOString();
      this.db.run(
        `UPDATE proactive_notifications
            SET status = 'read', read_at = COALESCE(read_at, ?)
          WHERE id = ? AND user_id = ? AND status = 'unread'`,
        [now, id, userId],
      );
    }
    return this.getById(userId, id);
  }

  dismiss(userId: string, id: string): ProactiveNotification | undefined {
    const existing = this.getById(userId, id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE proactive_notifications
          SET status = 'dismissed', read_at = COALESCE(read_at, ?)
        WHERE id = ? AND user_id = ?`,
      [now, id, userId],
    );
    return this.getById(userId, id);
  }

  getScheduleState(userId: string): ProactiveScheduleState | undefined {
    return this.db.get<ProactiveScheduleState>(
      'SELECT * FROM proactive_schedule_state WHERE user_id = ?',
      [userId],
    );
  }

  upsertScheduleState(
    userId: string,
    patch: {
      last_run_at?: string | null;
      next_run_at?: string | null;
      last_status: string;
      last_summary?: string | null;
    },
  ): ProactiveScheduleState {
    const now = new Date().toISOString();
    const existing = this.getScheduleState(userId);
    const nextLastRun =
      'last_run_at' in patch ? (patch.last_run_at ?? null) : (existing?.last_run_at ?? null);
    const nextRunAt =
      'next_run_at' in patch ? (patch.next_run_at ?? null) : (existing?.next_run_at ?? null);
    const nextSummary =
      'last_summary' in patch ? (patch.last_summary ?? null) : (existing?.last_summary ?? null);

    this.db.run(
      `INSERT INTO proactive_schedule_state (user_id, last_run_at, next_run_at, last_status, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         next_run_at = excluded.next_run_at,
         last_status = excluded.last_status,
         last_summary = excluded.last_summary,
         updated_at = excluded.updated_at`,
      [userId, nextLastRun, nextRunAt, patch.last_status, nextSummary, now],
    );
    return this.getScheduleState(userId) as ProactiveScheduleState;
  }

  /** 查找已到调度窗口或尚未初始化调度的用户列表（按 user_id 升序）。 */
  listDueUserIds(nowIso: string, limit = 100): string[] {
    const rows = this.db.all<{ user_id: string }>(
      `SELECT u.user_id
         FROM users u
         LEFT JOIN proactive_schedule_state s ON s.user_id = u.user_id
        WHERE s.next_run_at IS NULL OR s.next_run_at <= ?
        ORDER BY COALESCE(s.next_run_at, '') ASC, u.user_id ASC
        LIMIT ?`,
      [nowIso, Math.min(Math.max(limit, 1), 500)],
    );
    return rows.map((r) => r.user_id);
  }
}
