-- Personal AI Runtime V1
-- 只保存 Gateway 自身需要的任务执行状态与会话元数据；
-- 完整消息历史由 ADP Chat Client 负责，不在此重复建表。

CREATE TABLE IF NOT EXISTS execution_tasks (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL UNIQUE,
  agent_id            TEXT,
  project_id          TEXT,
  execution_mode      TEXT NOT NULL,
  external_task_id    TEXT,
  external_run_id     TEXT,
  status              TEXT NOT NULL,
  input_summary       TEXT,
  result              TEXT,
  error               TEXT,
  progress_message    TEXT,
  poll_count          INTEGER NOT NULL DEFAULT 0,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  updated_at          TEXT NOT NULL
);

-- 同一用户同一请求只允许创建一个任务（防止重复派发）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_tasks_user_request
  ON execution_tasks (user_id, request_id);
CREATE INDEX IF NOT EXISTS idx_execution_tasks_user_created
  ON execution_tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_tasks_status
  ON execution_tasks (status, updated_at);

CREATE TABLE IF NOT EXISTS conversation_contexts (
  user_id           TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  project_id        TEXT,
  last_task_id      TEXT,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  metadata          TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);
