/**
 * execution_events 持久化存储：记录每次 Execution 从创建、运行、工具调用到重试/恢复/终态的完整时间线。
 * 所有查询均按 user_id 强制隔离。
 */
import type { Database } from '../../db';
import { sanitizeEventMetadata, type ExecutionEventType } from './execution-lifecycle';

export interface ExecutionEventRecord {
  id: number;
  execution_id: string;
  task_id: string | null;
  user_id: string;
  event_type: ExecutionEventType;
  agent_id: string | null;
  status: string | null;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface NewExecutionEventInput {
  executionId: string;
  taskId?: string | null;
  userId: string;
  eventType: ExecutionEventType;
  agentId?: string | null;
  status?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown>;
}

interface RawExecutionEventRow {
  id: number;
  execution_id: string;
  task_id: string | null;
  user_id: string;
  event_type: ExecutionEventType;
  agent_id: string | null;
  status: string | null;
  message: string | null;
  metadata: string;
  created_at: string;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToRecord(row: RawExecutionEventRow): ExecutionEventRecord {
  return {
    id: Number(row.id),
    execution_id: row.execution_id,
    task_id: row.task_id,
    user_id: row.user_id,
    event_type: row.event_type,
    agent_id: row.agent_id,
    status: row.status,
    message: row.message,
    metadata: parseMetadata(row.metadata),
    created_at: row.created_at,
  };
}

export class ExecutionEventStore {
  constructor(private readonly db: Database) {}

  record(input: NewExecutionEventInput): ExecutionEventRecord {
    const now: string = new Date().toISOString();
    const safeMessage: string | null =
      input.message === undefined || input.message === null
        ? null
        : String(input.message).slice(0, 2000);
    const serializedMeta: string = sanitizeEventMetadata(input.metadata);
    const res = this.db.run(
      `INSERT INTO execution_events
         (execution_id, task_id, user_id, event_type, agent_id, status, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.executionId,
        input.taskId ?? null,
        input.userId,
        input.eventType,
        input.agentId ?? null,
        input.status ?? null,
        safeMessage,
        serializedMeta,
        now,
      ],
    );
    const row = this.db.get<RawExecutionEventRow>(
      'SELECT * FROM execution_events WHERE id = ?',
      [res.lastInsertRowid],
    ) as RawExecutionEventRow;
    return rowToRecord(row);
  }

  listByExecution(
    userId: string,
    executionId: string,
    limit = 100,
    offset = 0,
  ): { items: ExecutionEventRecord[]; total: number } {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    const safeOffset = Math.max(0, offset);
    const totalRow = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM execution_events WHERE user_id = ? AND execution_id = ?',
      [userId, executionId],
    );
    const rows = this.db.all<RawExecutionEventRow>(
      `SELECT * FROM execution_events
        WHERE user_id = ? AND execution_id = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?`,
      [userId, executionId, safeLimit, safeOffset],
    );
    return {
      items: rows.map(rowToRecord),
      total: Number(totalRow?.total ?? 0),
    };
  }

  listByTask(
    userId: string,
    taskId: string,
    limit = 100,
    offset = 0,
  ): { items: ExecutionEventRecord[]; total: number } {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    const safeOffset = Math.max(0, offset);
    const totalRow = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM execution_events WHERE user_id = ? AND task_id = ?',
      [userId, taskId],
    );
    const rows = this.db.all<RawExecutionEventRow>(
      `SELECT * FROM execution_events
        WHERE user_id = ? AND task_id = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?`,
      [userId, taskId, safeLimit, safeOffset],
    );
    return {
      items: rows.map(rowToRecord),
      total: Number(totalRow?.total ?? 0),
    };
  }
}
