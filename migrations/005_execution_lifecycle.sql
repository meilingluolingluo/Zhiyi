-- Personal AI Execution 生命周期扩展与事件历史追踪
--
-- 为 execution_tasks 增加结构化失败分类、可重试标记、需核实标记、重试血缘与心跳时间；
-- 新增 execution_events 表用于持久记录创建、开始、进度、工具调用、重试、恢复与终态事件。

BEGIN TRANSACTION;

ALTER TABLE execution_tasks ADD COLUMN error_category TEXT;
ALTER TABLE execution_tasks ADD COLUMN error_code TEXT;
ALTER TABLE execution_tasks ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE execution_tasks ADD COLUMN needs_verification INTEGER NOT NULL DEFAULT 0;
ALTER TABLE execution_tasks ADD COLUMN retry_of_execution_id TEXT;
ALTER TABLE execution_tasks ADD COLUMN last_progress_at TEXT;

CREATE TABLE IF NOT EXISTS execution_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES execution_tasks(id) ON DELETE CASCADE,
  task_id      TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  user_id      TEXT NOT NULL,
  event_type   TEXT NOT NULL CHECK (event_type IN (
    'created',
    'started',
    'progress',
    'tool_call',
    'completed',
    'failed',
    'cancelled',
    'retried',
    'recovered',
    'verification_required'
  )),
  agent_id     TEXT,
  status       TEXT,
  message      TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_events_execution
  ON execution_events(user_id, execution_id, id ASC);

CREATE INDEX IF NOT EXISTS idx_execution_events_task
  ON execution_events(user_id, task_id, id ASC)
  WHERE task_id IS NOT NULL;

COMMIT;
