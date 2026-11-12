-- 002：把 trajectories.request_id 的全局 UNIQUE 改为 (user_id, request_id) 复合唯一。
--
-- 背景：跨用户携带相同 X-Request-Id（或手动补录同一 request_id）时，全局唯一约束
--       会让去重查询误命中他人轨迹，既泄漏他人响应内容，又静默丢弃当前用户轨迹。
-- 做法：建新表 → 复制全部历史数据 → 删旧表 → 改名 → 重建索引，全程置于事务中，
--       旧库升级不丢任何一条轨迹。
-- 幂等：由 schema_migrations 记录版本，db.ts 按序且仅执行一次；即使重复执行，
--       开头的 DROP TABLE IF EXISTS 也会清掉中间表并重新从当前表复制，数据不丢。

BEGIN TRANSACTION;

DROP TABLE IF EXISTS trajectories_v2;

CREATE TABLE trajectories_v2 (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  session_id  TEXT,
  task_id     TEXT,
  project_id  TEXT,
  model       TEXT NOT NULL DEFAULT '',
  request     TEXT NOT NULL DEFAULT '{}',
  response    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'ok',
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);

INSERT OR IGNORE INTO trajectories_v2
  (id, request_id, user_id, agent_id, session_id, task_id, project_id,
   model, request, response, status, created_at)
SELECT id, request_id, user_id, agent_id, session_id, task_id, project_id,
       model, request, response, status, created_at
FROM trajectories;

DROP TABLE trajectories;
ALTER TABLE trajectories_v2 RENAME TO trajectories;

CREATE INDEX IF NOT EXISTS idx_trajectories_user ON trajectories(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trajectories_session ON trajectories(user_id, session_id);

COMMIT;
