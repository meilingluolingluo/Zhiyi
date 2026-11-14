/**
 * execution_tasks 持久化。所有对用户可见的读写都强制携带 user_id，
 * 只有后台 Worker 使用不带用户条件的内部方法（按主键更新）。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db';
import type { ExecutionStatus } from '../config';

export interface ExecutionTask {
  id: string;
  task_id: string | null;
  user_id: string;
  conversation_id: string;
  request_id: string;
  idempotency_key: string;
  agent_id: string | null;
  project_id: string | null;
  execution_mode: string;
  external_task_id: string | null;
  external_run_id: string | null;
  status: ExecutionStatus;
  input_summary: string | null;
  result: string | null;
  error: string | null;
  error_category: string | null;
  error_code: string | null;
  retryable: boolean;
  needs_verification: boolean;
  retry_of_execution_id: string | null;
  last_progress_at: string | null;
  progress_message: string | null;
  poll_count: number;
  attempt_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface RawExecutionTaskRow extends Omit<ExecutionTask, 'retryable' | 'needs_verification'> {
  retryable: number | boolean;
  needs_verification: number | boolean;
}

function rowToExecutionTask(row: RawExecutionTaskRow): ExecutionTask {
  return {
    ...row,
    error_category: row.error_category ?? null,
    error_code: row.error_code ?? null,
    retryable: Boolean(row.retryable),
    needs_verification: Boolean(row.needs_verification),
    retry_of_execution_id: row.retry_of_execution_id ?? null,
    last_progress_at: row.last_progress_at ?? null,
  };
}

export interface NewExecutionTask {
  task_id?: string | null;
  user_id: string;
  conversation_id: string;
  request_id: string;
  agent_id?: string | null;
  project_id?: string | null;
  execution_mode: 'direct_llm' | 'agent_delegation';
  input_summary: string;
  initial_status?: 'pending' | 'running';
  started_at?: string | null;
  retry_of_execution_id?: string | null;
}

export interface TaskPatch {
  status?: ExecutionStatus;
  external_task_id?: string | null;
  external_run_id?: string | null;
  result?: string | null;
  error?: string | null;
  error_category?: string | null;
  error_code?: string | null;
  retryable?: boolean;
  needs_verification?: boolean;
  last_progress_at?: string | null;
  progress_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  increment_poll?: boolean;
  increment_attempt?: boolean;
}

const PATCH_COLUMNS: Readonly<Record<keyof TaskPatch, string>> = {
  status: 'status',
  external_task_id: 'external_task_id',
  external_run_id: 'external_run_id',
  result: 'result',
  error: 'error',
  error_category: 'error_category',
  error_code: 'error_code',
  retryable: 'retryable',
  needs_verification: 'needs_verification',
  last_progress_at: 'last_progress_at',
  progress_message: 'progress_message',
  started_at: 'started_at',
  completed_at: 'completed_at',
  increment_poll: '',
  increment_attempt: '',
};

/**
 * 「活动态」枚举（可直接拼进 SQL 的 IN 列表）。
 * 与 ExecutionStatus 的终态（completed / failed / cancelled）互斥，
 * 用于保障后台旧快照轮询不得覆盖已终结记录。
 */
const ACTIVE_STATUS_SQL = "'pending','dispatching','running'";

export interface RecoveryOutcome {
  resetToPending: ExecutionTask[];
  resumedRunning: ExecutionTask[];
  exhausted: ExecutionTask[];
}

export class TaskRepository {
  constructor(private readonly db: Database) {}

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  /** 幂等创建：同一 (user_id, request_id) 只产生一个任务。 */
  create(input: NewExecutionTask): { task: ExecutionTask; created: boolean } {
    const now: string = new Date().toISOString();
    const id: string = `task_${randomUUID()}`;
    const idempotencyKey: string = `${input.user_id}:${input.request_id}`;
    const initialStatus: 'pending' | 'running' =
      input.initial_status === 'running' ? 'running' : 'pending';
    const startedAt: string | null =
      initialStatus === 'running' ? (input.started_at ?? now) : null;
    const lastProgressAt: string | null = initialStatus === 'running' ? startedAt : null;
    const attemptCount: number = initialStatus === 'running' ? 1 : 0;
    const result = this.db.run(
      `INSERT OR IGNORE INTO execution_tasks
         (id, task_id, user_id, conversation_id, request_id, idempotency_key, agent_id, project_id,
          execution_mode, status, input_summary, retry_of_execution_id, attempt_count,
          started_at, last_progress_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.task_id ?? null,
        input.user_id,
        input.conversation_id,
        input.request_id,
        idempotencyKey,
        input.agent_id ?? null,
        input.project_id ?? null,
        input.execution_mode,
        initialStatus,
        input.input_summary.slice(0, 2000),
        input.retry_of_execution_id ?? null,
        attemptCount,
        startedAt,
        lastProgressAt,
        now,
        now,
      ],
    );
    const row = this.db.get<RawExecutionTaskRow>(
      'SELECT * FROM execution_tasks WHERE idempotency_key = ?',
      [idempotencyKey],
    ) as RawExecutionTaskRow;
    return { task: rowToExecutionTask(row), created: result.changes > 0 };
  }

  get(userId: string, id: string): ExecutionTask | undefined {
    const row = this.db.get<RawExecutionTaskRow>(
      'SELECT * FROM execution_tasks WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    return row ? rowToExecutionTask(row) : undefined;
  }

  /** Worker 内部使用：按主键读取，不暴露给用户路由。 */
  getById(id: string): ExecutionTask | undefined {
    const row = this.db.get<RawExecutionTaskRow>('SELECT * FROM execution_tasks WHERE id = ?', [id]);
    return row ? rowToExecutionTask(row) : undefined;
  }

  getByRequestId(userId: string, requestId: string): ExecutionTask | undefined {
    const row = this.db.get<RawExecutionTaskRow>(
      'SELECT * FROM execution_tasks WHERE user_id = ? AND idempotency_key = ?',
      [userId, `${userId}:${requestId}`],
    );
    return row ? rowToExecutionTask(row) : undefined;
  }

  listForUser(userId: string, limit = 50): ExecutionTask[] {
    return this.db
      .all<RawExecutionTaskRow>(
        'SELECT * FROM execution_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        [userId, Math.min(Math.max(1, limit), 200)],
      )
      .map(rowToExecutionTask);
  }

  listActive(limit: number): ExecutionTask[] {
    return this.db
      .all<RawExecutionTaskRow>(
        `SELECT * FROM execution_tasks
          WHERE execution_mode != 'direct_llm'
            AND status IN (${ACTIVE_STATUS_SQL})
          ORDER BY updated_at ASC LIMIT ?`,
        [Math.max(1, limit)],
      )
      .map(rowToExecutionTask);
  }

  /** 查询所有活动中的执行（包含 direct_llm 与外部异步任务），供 Watchdog 全局巡检 */
  listAllActive(limit: number): ExecutionTask[] {
    return this.db
      .all<RawExecutionTaskRow>(
        `SELECT * FROM execution_tasks
          WHERE status IN (${ACTIVE_STATUS_SQL})
          ORDER BY updated_at ASC LIMIT ?`,
        [Math.max(1, limit)],
      )
      .map(rowToExecutionTask);
  }

  listByTaskId(
    userId: string,
    taskId: string,
    limit = 50,
    offset = 0,
  ): { items: ExecutionTask[]; total: number } {
    const safeLimit: number = Math.min(Math.max(limit, 1), 200);
    const safeOffset: number = Math.max(offset, 0);
    const totalRow = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM execution_tasks WHERE user_id = ? AND task_id = ?',
      [userId, taskId],
    );
    const items = this.db
      .all<RawExecutionTaskRow>(
        `SELECT * FROM execution_tasks
          WHERE user_id = ? AND task_id = ?
          ORDER BY created_at DESC, rowid DESC, id DESC
          LIMIT ? OFFSET ?`,
        [userId, taskId, safeLimit, safeOffset],
      )
      .map(rowToExecutionTask);
    return { items, total: Number(totalRow?.total ?? 0) };
  }

  getLatestByTaskId(userId: string, taskId: string): ExecutionTask | undefined {
    const row = this.db.get<RawExecutionTaskRow>(
      `SELECT * FROM execution_tasks
        WHERE user_id = ? AND task_id = ?
        ORDER BY created_at DESC, rowid DESC, id DESC
        LIMIT 1`,
      [userId, taskId],
    );
    return row ? rowToExecutionTask(row) : undefined;
  }

  listActiveByTaskId(userId: string, taskId: string): ExecutionTask[] {
    return this.db
      .all<RawExecutionTaskRow>(
        `SELECT * FROM execution_tasks
          WHERE user_id = ? AND task_id = ? AND status IN (${ACTIVE_STATUS_SQL})
          ORDER BY created_at DESC, rowid DESC, id DESC`,
        [userId, taskId],
      )
      .map(rowToExecutionTask);
  }

  hasActiveByTaskId(taskId: string): boolean {
    const row = this.db.get<{ hit: number }>(
      `SELECT 1 AS hit FROM execution_tasks
        WHERE task_id = ? AND status IN (${ACTIVE_STATUS_SQL})
        LIMIT 1`,
      [taskId],
    );
    return row !== undefined;
  }

  hasAnyByTaskId(taskId: string): boolean {
    const row = this.db.get<{ hit: number }>(
      'SELECT 1 AS hit FROM execution_tasks WHERE task_id = ? LIMIT 1',
      [taskId],
    );
    return row !== undefined;
  }

  countActiveByAgent(agentId: string): number {
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM execution_tasks
        WHERE agent_id = ? AND status IN (${ACTIVE_STATUS_SQL})`,
      [agentId],
    );
    return Number(row?.total ?? 0);
  }

  /** 把 TaskPatch 编译成 SET 片段（updated_at 恒更新；有进度变化时同步推进心跳时间）。 */
  private buildPatch(patch: TaskPatch): { sets: string[]; params: unknown[] } {
    const sets: string[] = [];
    const params: unknown[] = [];
    const now: string = new Date().toISOString();
    let hasExplicitLastProgress = false;
    let shouldTouchProgress = false;

    for (const [key, value] of Object.entries(patch) as Array<[keyof TaskPatch, unknown]>) {
      if (key === 'increment_poll') {
        if (value === true) sets.push('poll_count = poll_count + 1');
        continue;
      }
      if (key === 'increment_attempt') {
        if (value === true) sets.push('attempt_count = attempt_count + 1');
        continue;
      }
      if (key === 'last_progress_at') {
        hasExplicitLastProgress = true;
      }
      if (
        (key === 'progress_message' && typeof value === 'string' && value.trim() !== '') ||
        (key === 'status' && value === 'running')
      ) {
        shouldTouchProgress = true;
      }
      const column: string = PATCH_COLUMNS[key];
      if (!column) continue;
      sets.push(`${column} = ?`);
      if (key === 'retryable' || key === 'needs_verification') {
        params.push(value ? 1 : 0);
      } else {
        params.push(value ?? null);
      }
    }

    if (!hasExplicitLastProgress && shouldTouchProgress) {
      sets.push('last_progress_at = ?');
      params.push(now);
    }
    sets.push('updated_at = ?');
    params.push(now);
    return { sets, params };
  }

  /** 无条件更新：仅供后台 Worker 的「首次进入活动态」与内部维护使用。 */
  update(id: string, patch: TaskPatch): void {
    const { sets, params } = this.buildPatch(patch);
    this.db.run(`UPDATE execution_tasks SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }

  /**
   * 终态保护更新（CAS）：仅当任务仍处于活动态（pending / dispatching / running）时写入。
   * 保证后台轮询旧快照回写不可覆盖已写入的 completed / failed / cancelled 终态。
   */
  updateIfActive(id: string, patch: TaskPatch): boolean {
    const { sets, params } = this.buildPatch(patch);
    const result = this.db.run(
      `UPDATE execution_tasks SET ${sets.join(', ')} WHERE id = ? AND status IN (${ACTIVE_STATUS_SQL})`,
      [...params, id],
    );
    return result.changes > 0;
  }

  /** 原子抢占派发权：仅当任务仍是 pending 时切到 dispatching，防止覆盖已取消状态。 */
  claimForDispatch(id: string, startedAt: string): boolean {
    const now: string = new Date().toISOString();
    const result = this.db.run(
      `UPDATE execution_tasks
          SET status = 'dispatching',
              started_at = COALESCE(started_at, ?),
              last_progress_at = COALESCE(last_progress_at, ?),
              attempt_count = attempt_count + 1,
              updated_at = ?
        WHERE id = ? AND status = 'pending'`,
      [startedAt, now, now, id],
    );
    return result.changes > 0;
  }

  /**
   * 服务重启恢复：
   * - 已持有 external_task_id 的 dispatching 记录恢复为 running（直接续轮询，不重复建外部任务）；
   * - 未超出重试上限且无 external_task_id 的 dispatching 记录回退为 pending；
   * - 超出上限的记录收敛为 failed + needs_verification，避免无限死循环。
   */
  recoverDetailed(maxAttempts = 3): RecoveryOutcome {
    const now: string = new Date().toISOString();
    const rows = this.db
      .all<RawExecutionTaskRow>(`SELECT * FROM execution_tasks WHERE status = 'dispatching'`)
      .map(rowToExecutionTask);

    const resetToPending: ExecutionTask[] = [];
    const resumedRunning: ExecutionTask[] = [];
    const exhausted: ExecutionTask[] = [];

    for (const row of rows) {
      if (row.external_task_id) {
        const res = this.db.run(
          `UPDATE execution_tasks
              SET status = 'running',
                  last_progress_at = COALESCE(last_progress_at, ?),
                  updated_at = ?
            WHERE id = ? AND status = 'dispatching'`,
          [now, now, row.id],
        );
        if (res.changes > 0) resumedRunning.push(this.getById(row.id) ?? row);
      } else if (row.attempt_count < maxAttempts) {
        const res = this.db.run(
          `UPDATE execution_tasks
              SET status = 'pending',
                  updated_at = ?
            WHERE id = ? AND status = 'dispatching'`,
          [now, row.id],
        );
        if (res.changes > 0) resetToPending.push(this.getById(row.id) ?? row);
      } else {
        const res = this.db.run(
          `UPDATE execution_tasks
              SET status = 'failed',
                  error = COALESCE(error, '派发重试次数超过上限，结果未确认，请核实后重试'),
                  error_category = 'needs_verification',
                  error_code = 'dispatch_retry_limit_exceeded',
                  retryable = 1,
                  needs_verification = 1,
                  completed_at = COALESCE(completed_at, ?),
                  updated_at = ?
            WHERE id = ? AND status = 'dispatching'`,
          [now, now, row.id],
        );
        if (res.changes > 0) exhausted.push(this.getById(row.id) ?? row);
      }
    }

    return { resetToPending, resumedRunning, exhausted };
  }

  /** 服务重启后恢复：把上一进程遗留的 dispatching 恢复或安全收敛，返回处理的记录数。 */
  recover(maxAttempts = 3): number {
    const outcome = this.recoverDetailed(maxAttempts);
    return (
      outcome.resetToPending.length +
      outcome.resumedRunning.length +
      outcome.exhausted.length
    );
  }

  /** 服务重启后清理：direct_llm 内存流不可跨重启续跑，标为 failed 且标记需人工核实，返回受影响记录。 */
  failStaleDirectExecutionsAndList(reason: string): ExecutionTask[] {
    const now: string = new Date().toISOString();
    const candidates = this.db
      .all<RawExecutionTaskRow>(
        `SELECT * FROM execution_tasks
          WHERE execution_mode = 'direct_llm'
            AND status IN (${ACTIVE_STATUS_SQL})`,
      )
      .map(rowToExecutionTask);

    if (candidates.length === 0) return [];

    this.db.run(
      `UPDATE execution_tasks
          SET status = 'failed',
              error = COALESCE(error, ?),
              error_category = 'needs_verification',
              error_code = 'process_restarted',
              retryable = 1,
              needs_verification = 1,
              completed_at = COALESCE(completed_at, ?),
              updated_at = ?
        WHERE execution_mode = 'direct_llm'
          AND status IN (${ACTIVE_STATUS_SQL})`,
      [reason, now, now],
    );
    return candidates
      .map((item) => this.getById(item.id))
      .filter((item): item is ExecutionTask => item !== undefined);
  }

  failStaleDirectExecutions(reason: string): number {
    return this.failStaleDirectExecutionsAndList(reason).length;
  }

  /** 检测长时间无进展的外部 Agent Execution 并标为 failed + needs_verification，避免静默假定成功。 */
  failStalledExternalExecutions(staleBeforeIso: string): ExecutionTask[] {
    const candidates = this.db
      .all<RawExecutionTaskRow>(
        `SELECT * FROM execution_tasks
          WHERE execution_mode != 'direct_llm'
            AND status = 'running'
            AND COALESCE(last_progress_at, started_at, created_at) < ?`,
        [staleBeforeIso],
      )
      .map(rowToExecutionTask);

    if (candidates.length === 0) return [];
    const now: string = new Date().toISOString();
    const updated: ExecutionTask[] = [];
    for (const item of candidates) {
      const res = this.db.run(
        `UPDATE execution_tasks
            SET status = 'failed',
                error = '执行长时间无进展，结果无法确认，请核实后重试',
                error_category = 'needs_verification',
                error_code = 'execution_stalled',
                retryable = 1,
                needs_verification = 1,
                completed_at = COALESCE(completed_at, ?),
                updated_at = ?
          WHERE id = ? AND status = 'running'`,
        [now, now, item.id],
      );
      if (res.changes > 0) {
        const latest = this.getById(item.id);
        if (latest) updated.push(latest);
      }
    }
    return updated;
  }
}
