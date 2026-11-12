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
  progress_message: string | null;
  poll_count: number;
  attempt_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
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
}

export interface TaskPatch {
  status?: ExecutionStatus;
  external_task_id?: string | null;
  external_run_id?: string | null;
  result?: string | null;
  error?: string | null;
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
  progress_message: 'progress_message',
  started_at: 'started_at',
  completed_at: 'completed_at',
  increment_poll: '',
  increment_attempt: '',
};

/**
 * 「活动态」枚举（可直接拼进 SQL 的 IN 列表）。
 *
 * 与 `ExecutionStatus` 的终态互补：completed / failed / cancelled 一旦写入，
 * 后台 Worker 的旧快照轮询结果不得再覆盖它（见 ARCHITECTURE.md §9）。
 */
const ACTIVE_STATUS_SQL = "'pending','dispatching','running'";

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
    const initialStatus: 'pending' | 'running' = input.initial_status === 'running' ? 'running' : 'pending';
    const startedAt: string | null = initialStatus === 'running' ? (input.started_at ?? now) : null;
    const attemptCount: number = initialStatus === 'running' ? 1 : 0;
    const result = this.db.run(
      `INSERT OR IGNORE INTO execution_tasks
         (id, task_id, user_id, conversation_id, request_id, idempotency_key, agent_id, project_id,
          execution_mode, status, input_summary, attempt_count, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        attemptCount,
        startedAt,
        now,
        now,
      ],
    );
    const task: ExecutionTask = this.db.get<ExecutionTask>(
      'SELECT * FROM execution_tasks WHERE idempotency_key = ?',
      [idempotencyKey],
    ) as ExecutionTask;
    return { task, created: result.changes > 0 };
  }

  get(userId: string, id: string): ExecutionTask | undefined {
    return this.db.get<ExecutionTask>(
      'SELECT * FROM execution_tasks WHERE id = ? AND user_id = ?',
      [id, userId],
    );
  }

  /** Worker 内部使用：按主键读取，不暴露给用户路由。 */
  getById(id: string): ExecutionTask | undefined {
    return this.db.get<ExecutionTask>('SELECT * FROM execution_tasks WHERE id = ?', [id]);
  }

  getByRequestId(userId: string, requestId: string): ExecutionTask | undefined {
    return this.db.get<ExecutionTask>(
      'SELECT * FROM execution_tasks WHERE user_id = ? AND idempotency_key = ?',
      [userId, `${userId}:${requestId}`],
    );
  }

  listForUser(userId: string, limit = 50): ExecutionTask[] {
    return this.db.all<ExecutionTask>(
      'SELECT * FROM execution_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, Math.min(Math.max(1, limit), 200)],
    );
  }

  listActive(limit: number): ExecutionTask[] {
    return this.db.all<ExecutionTask>(
      `SELECT * FROM execution_tasks
        WHERE execution_mode != 'direct_llm'
          AND status IN ('pending', 'dispatching', 'running')
        ORDER BY updated_at ASC LIMIT ?`,
      [Math.max(1, limit)],
    );
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
    const items = this.db.all<ExecutionTask>(
      `SELECT * FROM execution_tasks
        WHERE user_id = ? AND task_id = ?
        ORDER BY created_at DESC, rowid DESC, id DESC
        LIMIT ? OFFSET ?`,
      [userId, taskId, safeLimit, safeOffset],
    );
    return { items, total: Number(totalRow?.total ?? 0) };
  }

  getLatestByTaskId(userId: string, taskId: string): ExecutionTask | undefined {
    return this.db.get<ExecutionTask>(
      `SELECT * FROM execution_tasks
        WHERE user_id = ? AND task_id = ?
        ORDER BY created_at DESC, rowid DESC, id DESC
        LIMIT 1`,
      [userId, taskId],
    );
  }

  listActiveByTaskId(userId: string, taskId: string): ExecutionTask[] {
    return this.db.all<ExecutionTask>(
      `SELECT * FROM execution_tasks
        WHERE user_id = ? AND task_id = ? AND status IN (${ACTIVE_STATUS_SQL})
        ORDER BY created_at DESC, rowid DESC, id DESC`,
      [userId, taskId],
    );
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

  /** 把 TaskPatch 编译成 SET 片段（`updated_at` 恒更新，排除在参数末尾之外）。 */
  private buildPatch(patch: TaskPatch): { sets: string[]; params: unknown[] } {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(patch) as Array<[keyof TaskPatch, unknown]>) {
      if (key === 'increment_poll') {
        if (value === true) sets.push('poll_count = poll_count + 1');
        continue;
      }
      if (key === 'increment_attempt') {
        if (value === true) sets.push('attempt_count = attempt_count + 1');
        continue;
      }
      const column: string = PATCH_COLUMNS[key];
      if (!column) continue;
      sets.push(`${column} = ?`);
      params.push(value ?? null);
    }
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    return { sets, params };
  }

  /** 无条件更新：仅供后台 Worker 的「首次进入活动态」与内部维护使用。 */
  update(id: string, patch: TaskPatch): void {
    const { sets, params } = this.buildPatch(patch);
    this.db.run(`UPDATE execution_tasks SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }

  /**
   * 终态保护更新（CAS）：仅当任务仍处于活动态（pending / dispatching / running）时写入。
   *
   * 后台 Worker 的轮询是「快照 → 异步 CLI → 回写」，中间窗口内用户可能取消任务。
   * 用带 `status IN (...)` 条件的单条 SQL 回写，保证终态不可被旧快照覆盖
   * （SQLite 单语句原子执行，不存在读-改-写丢更新）。
   *
   * @returns true = 已写入；false = 任务已是终态或不存在，调用方应放弃回写。
   */
  updateIfActive(id: string, patch: TaskPatch): boolean {
    const { sets, params } = this.buildPatch(patch);
    const result = this.db.run(
      `UPDATE execution_tasks SET ${sets.join(', ')} WHERE id = ? AND status IN (${ACTIVE_STATUS_SQL})`,
      [...params, id],
    );
    return result.changes > 0;
  }

  /**
   * 原子抢占派发权：仅当任务仍是 `pending` 时切到 `dispatching`。
   *
   * 用一条 UPDATE 完成「校验 + 状态流转」，避免「读到 pending → 用户取消 →
   * 写入 dispatching」把 cancelled 覆盖掉。成功时累加 attempt_count。
   *
   * @returns true = 抢占成功；false = 任务已被取消、已被别的轮次派发或不存在。
   */
  claimForDispatch(id: string, startedAt: string): boolean {
    const result = this.db.run(
      `UPDATE execution_tasks
          SET status = 'dispatching',
              started_at = COALESCE(started_at, ?),
              attempt_count = attempt_count + 1,
              updated_at = ?
        WHERE id = ? AND status = 'pending'`,
      [startedAt, new Date().toISOString(), id],
    );
    return result.changes > 0;
  }

  /** 服务重启后恢复：把上一进程遗留的 dispatching 回退为 pending 重新派发。 */
  recover(): number {
    const result = this.db.run(
      `UPDATE execution_tasks SET status = 'pending', updated_at = ? WHERE status = 'dispatching'`,
      [new Date().toISOString()],
    );
    return result.changes;
  }

  /** 服务重启后清理：direct_llm 内存流不可跨重启续跑，将遗留活跃项标为 failed。 */
  failStaleDirectExecutions(reason: string): number {
    const now: string = new Date().toISOString();
    const result = this.db.run(
      `UPDATE execution_tasks
          SET status = 'failed',
              error = COALESCE(error, ?),
              completed_at = COALESCE(completed_at, ?),
              updated_at = ?
        WHERE execution_mode = 'direct_llm'
          AND status IN (${ACTIVE_STATUS_SQL})`,
      [reason, now, now],
    );
    return result.changes;
  }
}
