-- Personal AI V1.5 Phase 1: 用户档案、目标、项目、业务任务与 Agent 注册表基础扩展
--
-- 设计原则：
-- 1. 保留现有 execution_tasks 表名、task_ 主键语义与 6 种状态值，只增量增加 task_id 外键与索引/触发器；
-- 2. 所有业务实体通过 (entity_id, user_id) 复合外键或触发器在数据库层强制同用户归属；
-- 3. 复合外键统一使用 ON DELETE RESTRICT + 业务软删除（deleted_at），避免 SQLite SET NULL 误清 user_id；
-- 4. 新建 Agent 默认 execution_backend = 'direct_llm'，历史预置 developer/researcher 回填为 'multica'。

BEGIN TRANSACTION;

-- ============================================================
-- 1. users（User Profile：时区默认 UTC，来源仅限 default/header/user）
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  user_id         TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL DEFAULT '',
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  timezone_source TEXT NOT NULL DEFAULT 'default'
                  CHECK (timezone_source IN ('default', 'header', 'user')),
  work_style      TEXT NOT NULL DEFAULT '{}',
  preferences     TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 回填历史表中的所有已知 user_id，确保 PRAGMA foreign_keys = ON 下旧用户可直接使用 V1.5 表
INSERT OR IGNORE INTO users (user_id, created_at, updated_at)
SELECT DISTINCT user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT user_id FROM memories
  UNION
  SELECT user_id FROM trajectories
  UNION
  SELECT user_id FROM memory_candidates
  UNION
  SELECT user_id FROM execution_tasks
  UNION
  SELECT user_id FROM conversation_contexts
)
WHERE user_id IS NOT NULL AND user_id != '';

-- ============================================================
-- 2. goals（用户长期或阶段性目标）
-- ============================================================
CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('draft', 'active', 'paused', 'achieved', 'abandoned')),
  priority    INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  target_date TEXT,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_goals_user_active
  ON goals(user_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

-- ============================================================
-- 3. projects（围绕目标的工作空间）
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_projects_user_active
  ON projects(user_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

-- ============================================================
-- 4. goal_projects（同用户 Goal ↔ Project 多对多关联）
-- ============================================================
CREATE TABLE IF NOT EXISTS goal_projects (
  goal_id    TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, project_id),
  FOREIGN KEY (goal_id, user_id) REFERENCES goals(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, user_id) REFERENCES projects(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goal_projects_user_project
  ON goal_projects(user_id, project_id);

-- ============================================================
-- 5. tasks（业务任务，支持独立任务与父子任务）
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  project_id        TEXT,
  parent_task_id    TEXT,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'draft', 'pending', 'ready', 'assigned',
                      'in_progress', 'blocked', 'completed', 'failed', 'cancelled'
                    )),
  priority          INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  assignee_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  due_at            TEXT,
  deleted_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (id, user_id),
  CHECK (parent_task_id IS NULL OR parent_task_id != id),
  FOREIGN KEY (project_id, user_id) REFERENCES projects(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_task_id, user_id) REFERENCES tasks(id, user_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status
  ON tasks(user_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_user_project
  ON tasks(user_id, project_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_user_parent
  ON tasks(user_id, parent_task_id)
  WHERE deleted_at IS NULL;

-- ============================================================
-- 6. execution_tasks 扩展（保留 V1 表结构与状态，增加 task_id 关联与防并发/防越权保护）
-- ============================================================
ALTER TABLE execution_tasks ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT;

-- 确定性排序索引：选取最新 Execution 一律使用 ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_execution_tasks_task
  ON execution_tasks(task_id, created_at DESC, id DESC);

-- 同一业务任务同一时刻最多只允许一条活跃 Execution
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_tasks_one_active_per_task
  ON execution_tasks(task_id)
  WHERE task_id IS NOT NULL AND status IN ('pending', 'dispatching', 'running');

-- 数据库级归属保护：禁止将 execution_tasks 绑定到他人或已软删除的业务任务
CREATE TRIGGER IF NOT EXISTS trg_execution_tasks_task_owner_insert
BEFORE INSERT ON execution_tasks
WHEN NEW.task_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'CROSS_USER_OR_DELETED_TASK')
  WHERE NOT EXISTS (
    SELECT 1 FROM tasks
     WHERE id = NEW.task_id
       AND user_id = NEW.user_id
       AND deleted_at IS NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_execution_tasks_task_owner_update
BEFORE UPDATE OF task_id, user_id ON execution_tasks
WHEN NEW.task_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'CROSS_USER_OR_DELETED_TASK')
  WHERE NOT EXISTS (
    SELECT 1 FROM tasks
     WHERE id = NEW.task_id
       AND user_id = NEW.user_id
       AND deleted_at IS NULL
  );
END;

-- ============================================================
-- 7. agents 扩展（新建默认 direct_llm；历史内置 developer/researcher 回填为 multica）
-- ============================================================
ALTER TABLE agents ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN execution_backend TEXT NOT NULL DEFAULT 'direct_llm'
  CHECK (execution_backend IN ('direct_llm', 'multica'));
ALTER TABLE agents ADD COLUMN backend_config TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN model_preference TEXT;
ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'disabled'));
ALTER TABLE agents ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN concurrency_limit INTEGER NOT NULL DEFAULT 3
  CHECK (concurrency_limit >= 1);

UPDATE agents
   SET execution_backend = 'multica',
       capabilities = '["code","refactor","debug","architecture","test"]'
 WHERE agent_id = 'developer';

UPDATE agents
   SET execution_backend = 'multica',
       capabilities = '["research","analysis","evaluation","benchmark"]'
 WHERE agent_id = 'researcher';

COMMIT;
