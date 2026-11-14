-- Universal Memory Gateway MVP：初始 schema（幂等）
-- 所有与用户相关的查询都必须带 user_id 条件，memories 表按用户严格隔离。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  memory_id                TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  agent_id                 TEXT,
  project_id               TEXT,
  type                     TEXT NOT NULL DEFAULT 'semantic',
  scope                    TEXT NOT NULL DEFAULT 'personal',
  content                  TEXT NOT NULL,
  source                   TEXT NOT NULL DEFAULT 'api',
  confidence               REAL NOT NULL DEFAULT 0.8,
  evidence_trajectory_ids  TEXT NOT NULL DEFAULT '[]',
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON memories(user_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_user_project ON memories(user_id, project_id);

CREATE TABLE IF NOT EXISTS agents (
  agent_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  core_memory TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trajectories (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL UNIQUE,
  user_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  session_id  TEXT,
  task_id     TEXT,
  project_id  TEXT,
  model       TEXT NOT NULL DEFAULT '',
  request     TEXT NOT NULL DEFAULT '{}',
  response    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'ok',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trajectories_user ON trajectories(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trajectories_session ON trajectories(user_id, session_id);

CREATE TABLE IF NOT EXISTS memory_candidates (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  agent_id                 TEXT,
  project_id               TEXT,
  type                     TEXT NOT NULL DEFAULT 'semantic',
  scope                    TEXT NOT NULL DEFAULT 'personal',
  content                  TEXT NOT NULL,
  source                   TEXT NOT NULL DEFAULT 'auto-extract',
  trajectory_id            TEXT,
  evidence_trajectory_ids  TEXT NOT NULL DEFAULT '[]',
  confidence               REAL NOT NULL DEFAULT 0.5,
  status                   TEXT NOT NULL DEFAULT 'pending',
  created_memory_id        TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_user ON memory_candidates(user_id, status);
CREATE INDEX IF NOT EXISTS idx_candidates_trajectory ON memory_candidates(trajectory_id);
