-- Butler Router & Watchdog: 任务依赖关系拓扑与任务验收治理支持
--
-- 1. 新增 task_dependencies 表，支持任务间前置依赖关系（finish_to_start），支持 DAG 拓扑执行；
-- 2. tasks 扩展验收准则、验收评审状态（review_status）与返工次数控制（rework_count / max_rework）。

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS task_dependencies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'finish_to_start'
                  CHECK (dependency_type IN ('finish_to_start')),
  created_at      TEXT NOT NULL,
  UNIQUE (user_id, task_id, depends_on_id),
  CHECK (task_id != depends_on_id),
  FOREIGN KEY (task_id, user_id) REFERENCES tasks(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id, user_id) REFERENCES tasks(id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_deps_task
  ON task_dependencies(user_id, task_id);

CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on
  ON task_dependencies(user_id, depends_on_id);

ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;
ALTER TABLE tasks ADD COLUMN review_status TEXT NOT NULL DEFAULT 'none'
  CHECK (review_status IN ('none', 'pending_review', 'approved', 'rejected'));
ALTER TABLE tasks ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN max_rework INTEGER NOT NULL DEFAULT 2;

COMMIT;
