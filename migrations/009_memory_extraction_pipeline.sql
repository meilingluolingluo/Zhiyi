-- Memory Extraction Pipeline & Evolution: entities 实体标签与演进关系持久化
BEGIN TRANSACTION;

ALTER TABLE memory_candidates ADD COLUMN entities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_candidates ADD COLUMN evolution_relation TEXT;

COMMIT;
