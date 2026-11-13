-- Personal Memory Evolution: 记忆分类、状态归档/替代、用户确认标识与工作空间关联
--
-- 为 memories 与 memory_candidates 增加生命周期状态、知识分类、过期时间、
-- 冲突替代链路与 goal/task 归属字段；保留既有行全部兼容默认值。

BEGIN TRANSACTION;

ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE memories ADD COLUMN verified_by_user INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN goal_id TEXT;
ALTER TABLE memories ADD COLUMN task_id TEXT;
ALTER TABLE memories ADD COLUMN expires_at TEXT;
ALTER TABLE memories ADD COLUMN superseded_by TEXT;
ALTER TABLE memories ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_user_status
  ON memories(user_id, status, updated_at DESC);

ALTER TABLE memory_candidates ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE memory_candidates ADD COLUMN goal_id TEXT;
ALTER TABLE memory_candidates ADD COLUMN task_id TEXT;
ALTER TABLE memory_candidates ADD COLUMN conflict_memory_id TEXT;

COMMIT;
