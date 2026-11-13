-- Proactive Assistant: 主动提醒收件箱与持久化调度状态
--
-- 为每个用户保存可追溯的主动提醒记录（支持 dedupe_key 去重防骚扰与已读/忽略管理），
-- 并持久化调度状态（last_run_at / next_run_at），确保服务重启后调度状态连续且不重复打扰。

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS proactive_notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'unread'
              CHECK (status IN ('unread', 'read', 'dismissed')),
  channel     TEXT NOT NULL DEFAULT 'inbox',
  created_at  TEXT NOT NULL,
  read_at     TEXT,
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_proactive_notifications_user_status
  ON proactive_notifications(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proactive_notifications_user_entity
  ON proactive_notifications(user_id, entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proactive_schedule_state (
  user_id      TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  last_run_at  TEXT,
  next_run_at  TEXT,
  last_status  TEXT NOT NULL DEFAULT 'idle',
  last_summary TEXT,
  updated_at   TEXT NOT NULL
);

COMMIT;
