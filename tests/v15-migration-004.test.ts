/**
 * Step 1 测试：Migration 004_v1_5_phase1 的表结构、历史回填、数据库级隔离约束、
 * 单活跃 Execution 并发防重、确定性排序与安全回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStore } from '../src/agents';
import { Database } from '../src/db';

const dbs: Database[] = [];

afterEach((): void => {
  while (dbs.length > 0) {
    const db = dbs.pop();
    try {
      db?.close();
    } catch {
      // ignore close errors in cleanup
    }
  }
});

function openMemoryDb(): Database {
  const db: Database = Database.open(':memory:');
  dbs.push(db);
  return db;
}

function applyLegacyMigrations(db: Database): void {
  const dir: string = path.resolve(process.cwd(), 'migrations');
  const versions = ['001_init', '002_trajectory_request_scope', '003_personal_ai'] as const;
  for (const version of versions) {
    db.exec(fs.readFileSync(path.join(dir, `${version}.sql`), 'utf8'));
    db.run('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
      version,
      '2026-01-01T00:00:00.000Z',
    ]);
  }
}

describe('Migration 004 (V1.5 Phase 1)', () => {
  it('全新空库幂等迁移并登记 004_v1_5_phase1，新建 Agent 默认 direct_llm', () => {
    const db = openMemoryDb();
    db.migrate();
    // 再次执行 migrate() 应幂等跳过，不报错
    db.migrate();

    const versions = db
      .all<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version ASC')
      .map((r) => r.version);
    expect(versions).toEqual(
      expect.arrayContaining([
        '001_init',
        '002_trajectory_request_scope',
        '003_personal_ai',
        '004_v1_5_phase1',
      ]),
    );

    const tables = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
      )
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'users',
        'goals',
        'projects',
        'goal_projects',
        'tasks',
        'execution_tasks',
        'agents',
      ]),
    );

    const agentStore = new AgentStore(db);
    agentStore.seed();
    agentStore.create({ agent_id: 'custom_writer', name: 'Writer', role: 'Doc' });

    const custom = db.get<{ execution_backend: string; status: string; concurrency_limit: number }>(
      'SELECT execution_backend, status, concurrency_limit FROM agents WHERE agent_id = ?',
      ['custom_writer'],
    );
    expect(custom).toEqual({
      execution_backend: 'direct_llm',
      status: 'active',
      concurrency_limit: 3,
    });
  });

  it('旧库升级：自动回填历史 user_id，developer/researcher 回填为 multica，既有自定义 Agent 与历史 execution_tasks 兼容保留', () => {
    const db = openMemoryDb();
    applyLegacyMigrations(db);

    // 写入 V1 历史数据（各表不同用户 + 自由文本 project_id + 历史 Agent + V1 execution_tasks）
    db.run(
      `INSERT INTO agents (agent_id, name, role, description, core_memory, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '2026-01-01', '2026-01-01')`,
      ['developer', 'Developer', '后端研发工程师'],
    );
    db.run(
      `INSERT INTO agents (agent_id, name, role, description, core_memory, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '2026-01-01', '2026-01-01')`,
      ['researcher', 'Researcher', '技术调研员'],
    );
    db.run(
      `INSERT INTO agents (agent_id, name, role, description, core_memory, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '2026-01-01', '2026-01-01')`,
      ['legacy_custom', 'Legacy Custom', '自定义记忆角色'],
    );
    db.run(
      `INSERT INTO memories (memory_id, user_id, project_id, content, created_at, updated_at)
       VALUES ('mem_1', 'u1', 'legacy-free-project', 'prefers Rust', '2026-01-01', '2026-01-01')`,
    );
    db.run(
      `INSERT INTO trajectories (id, request_id, user_id, agent_id, created_at)
       VALUES ('traj_1', 'req_1', 'u2', 'developer', '2026-01-01')`,
    );
    db.run(
      `INSERT INTO memory_candidates (id, user_id, content, created_at, updated_at)
       VALUES ('cand_1', 'u3', 'candidate note', '2026-01-01', '2026-01-01')`,
    );
    db.run(
      `INSERT INTO execution_tasks (id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
       VALUES ('task_v1', 'u1', 'conv_1', 'req_v1', 'u1:req_v1', 'agent_delegation', 'completed', '2026-01-01', '2026-01-01')`,
    );
    db.run(
      `INSERT INTO conversation_contexts (user_id, conversation_id, agent_id, turn_count, created_at, updated_at)
       VALUES ('u4', 'conv_4', 'developer', 1, '2026-01-01', '2026-01-01')`,
    );

    // 执行增量迁移 004
    db.migrate();

    const userIds = db
      .all<{ user_id: string; timezone: string; timezone_source: string }>(
        'SELECT user_id, timezone, timezone_source FROM users ORDER BY user_id ASC',
      );
    expect(userIds).toEqual([
      { user_id: 'u1', timezone: 'UTC', timezone_source: 'default' },
      { user_id: 'u2', timezone: 'UTC', timezone_source: 'default' },
      { user_id: 'u3', timezone: 'UTC', timezone_source: 'default' },
      { user_id: 'u4', timezone: 'UTC', timezone_source: 'default' },
    ]);

    const agents = db.all<{ agent_id: string; execution_backend: string; capabilities: string }>(
      'SELECT agent_id, execution_backend, capabilities FROM agents ORDER BY agent_id ASC',
    );
    expect(agents).toEqual([
      {
        agent_id: 'developer',
        execution_backend: 'multica',
        capabilities: '["code","refactor","debug","architecture","test"]',
      },
      {
        agent_id: 'legacy_custom',
        execution_backend: 'direct_llm',
        capabilities: '[]',
      },
      {
        agent_id: 'researcher',
        execution_backend: 'multica',
        capabilities: '["research","analysis","evaluation","benchmark"]',
      },
    ]);

    const legacyExec = db.get<{ id: string; status: string; task_id: string | null }>(
      'SELECT id, status, task_id FROM execution_tasks WHERE id = ?',
      ['task_v1'],
    );
    expect(legacyExec).toEqual({ id: 'task_v1', status: 'completed', task_id: null });

    const legacyMem = db.get<{ project_id: string | null }>(
      'SELECT project_id FROM memories WHERE memory_id = ?',
      ['mem_1'],
    );
    expect(legacyMem?.project_id).toBe('legacy-free-project');
  });

  it('数据库层约束：时区来源 CHECK、复合外键同用户隔离、触发器防越权与软删除绑定、单活跃 Execution 唯一索引', () => {
    const db = openMemoryDb();
    db.migrate();
    const now = '2026-11-12T00:00:00.000Z';

    // 1. users.timezone_source 禁止 'system'
    expect(() =>
      db.run(
        `INSERT INTO users (user_id, timezone, timezone_source, created_at, updated_at)
         VALUES ('u_sys', 'Asia/Shanghai', 'system', ?, ?)`,
        [now, now],
      ),
    ).toThrow();

    db.run(`INSERT INTO users (user_id, created_at, updated_at) VALUES ('u1', ?, ?)`, [now, now]);
    db.run(
      `INSERT INTO users (user_id, timezone, timezone_source, created_at, updated_at)
       VALUES ('u2', 'America/New_York', 'header', ?, ?)`,
      [now, now],
    );

    // 2. goals / projects 与 goal_projects 复合外键防跨用户
    db.run(`INSERT INTO goals (id, user_id, title, created_at, updated_at) VALUES ('goal_1', 'u1', 'G1', ?, ?)`, [now, now]);
    db.run(`INSERT INTO projects (id, user_id, title, created_at, updated_at) VALUES ('proj_1', 'u1', 'P1', ?, ?)`, [now, now]);
    db.run(`INSERT INTO projects (id, user_id, title, created_at, updated_at) VALUES ('proj_2', 'u2', 'P2', ?, ?)`, [now, now]);

    db.run(`INSERT INTO goal_projects (goal_id, project_id, user_id, created_at) VALUES ('goal_1', 'proj_1', 'u1', ?)`, [now]);
    expect(() =>
      db.run(`INSERT INTO goal_projects (goal_id, project_id, user_id, created_at) VALUES ('goal_1', 'proj_2', 'u1', ?)`, [now]),
    ).toThrow();

    // 3. tasks 复合外键：允许独立任务(project_id=NULL)和同用户项目/父任务，拒绝跨用户和自环
    db.run(`INSERT INTO tasks (id, user_id, project_id, title, created_at, updated_at) VALUES ('btask_standalone', 'u1', NULL, 'Solo', ?, ?)`, [now, now]);
    db.run(`INSERT INTO tasks (id, user_id, project_id, parent_task_id, title, created_at, updated_at) VALUES ('btask_child', 'u1', 'proj_1', 'btask_standalone', 'Child', ?, ?)`, [now, now]);

    expect(() =>
      db.run(`INSERT INTO tasks (id, user_id, project_id, title, created_at, updated_at) VALUES ('btask_cross_proj', 'u1', 'proj_2', 'Bad', ?, ?)`, [now, now]),
    ).toThrow();
    expect(() =>
      db.run(`INSERT INTO tasks (id, user_id, parent_task_id, title, created_at, updated_at) VALUES ('btask_cross_parent', 'u2', 'btask_standalone', 'Bad', ?, ?)`, [now, now]),
    ).toThrow();
    expect(() =>
      db.run(`INSERT INTO tasks (id, user_id, parent_task_id, title, created_at, updated_at) VALUES ('btask_self', 'u1', 'btask_self', 'Self', ?, ?)`, [now, now]),
    ).toThrow();

    // 4. execution_tasks 触发器拒绝跨用户 task_id 及已软删除 task_id
    expect(() =>
      db.run(
        `INSERT INTO execution_tasks (id, task_id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
         VALUES ('task_cross', 'btask_standalone', 'u2', 'c2', 'r_cross', 'u2:r_cross', 'direct_llm', 'running', ?, ?)`,
        [now, now],
      ),
    ).toThrow(/CROSS_USER_OR_DELETED_TASK/);

    db.run(`INSERT INTO tasks (id, user_id, title, deleted_at, created_at, updated_at) VALUES ('btask_deleted', 'u1', 'Deleted', ?, ?, ?)`, [now, now, now]);
    expect(() =>
      db.run(
        `INSERT INTO execution_tasks (id, task_id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
         VALUES ('task_del', 'btask_deleted', 'u1', 'c1', 'r_del', 'u1:r_del', 'direct_llm', 'running', ?, ?)`,
        [now, now],
      ),
    ).toThrow(/CROSS_USER_OR_DELETED_TASK/);

    // 4b. execution_tasks UPDATE 触发器也禁止事后篡改为他人或已软删除 task_id；NULL task_id 允许并存多条活跃行
    db.run(
      `INSERT INTO execution_tasks (id, task_id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
       VALUES ('task_null_1', NULL, 'u1', 'c1', 'rn1', 'u1:rn1', 'agent_delegation', 'running', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO execution_tasks (id, task_id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
       VALUES ('task_null_2', NULL, 'u1', 'c1', 'rn2', 'u1:rn2', 'agent_delegation', 'running', ?, ?)`,
      [now, now],
    );
    expect(() =>
      db.run(`UPDATE execution_tasks SET task_id = 'btask_standalone', user_id = 'u2' WHERE id = 'task_null_1'`),
    ).toThrow(/CROSS_USER_OR_DELETED_TASK/);
    expect(() =>
      db.run(`UPDATE execution_tasks SET task_id = 'btask_deleted' WHERE id = 'task_null_1'`),
    ).toThrow(/CROSS_USER_OR_DELETED_TASK/);

    // 5. 部分唯一索引阻止同一业务任务并发双活跃 Execution，但允许终态后重试及历史 NULL task_id 多条并发
    db.run(
      `INSERT INTO execution_tasks (id, task_id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
       VALUES ('task_e1', 'btask_standalone', 'u1', 'c1', 'exec_1', 'u1:exec_1', 'direct_llm', 'running', ?, ?)`,
      [now, now],
    );
    expect(() =>
      db.run(
        `INSERT INTO execution_tasks (id, task_id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
         VALUES ('task_e2', 'btask_standalone', 'u1', 'c1', 'exec_2', 'u1:exec_2', 'agent_delegation', 'pending', ?, ?)`,
        [now, now],
      ),
    ).toThrow();

    // 旧记录进入 failed 后，允许插入新重试记录，且同时间戳下按 created_at DESC, id DESC 确定性选出最新一条
    db.run(`UPDATE execution_tasks SET status = 'failed' WHERE id = 'task_e1'`);
    db.run(
      `INSERT INTO execution_tasks (id, task_id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
       VALUES ('task_e2', 'btask_standalone', 'u1', 'c1', 'exec_2', 'u1:exec_2', 'agent_delegation', 'completed', ?, ?)`,
      [now, now],
    );
    const latest = db.get<{ id: string; status: string }>(
      `SELECT id, status FROM execution_tasks WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      ['btask_standalone'],
    );
    expect(latest).toEqual({ id: 'task_e2', status: 'completed' });
  });

  it('支持按逆序脚本安全回滚 004，且不丢失 V1 历史数据', () => {
    const db = openMemoryDb();
    applyLegacyMigrations(db);
    db.run(
      `INSERT INTO agents (agent_id, name, role, description, core_memory, created_at, updated_at)
       VALUES ('developer', 'Developer', 'dev', '', '', '2026-01-01', '2026-01-01')`,
    );
    db.run(
      `INSERT INTO execution_tasks (id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
       VALUES ('task_keep', 'u1', 'c1', 'r_keep', 'u1:r_keep', 'agent_delegation', 'completed', '2026-01-01', '2026-01-01')`,
    );

    db.migrate();

    db.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE memory_candidates DROP COLUMN entities;
      ALTER TABLE memory_candidates DROP COLUMN evolution_relation;
      DELETE FROM schema_migrations WHERE version = '009_memory_extraction_pipeline';
      DROP INDEX IF EXISTS idx_task_deps_depends_on;
      DROP INDEX IF EXISTS idx_task_deps_task;
      DROP TABLE IF EXISTS task_dependencies;
      ALTER TABLE tasks DROP COLUMN acceptance_criteria;
      ALTER TABLE tasks DROP COLUMN review_status;
      ALTER TABLE tasks DROP COLUMN rework_count;
      ALTER TABLE tasks DROP COLUMN max_rework;
      DELETE FROM schema_migrations WHERE version = '008_butler_router_watchdog';
      DROP INDEX IF EXISTS idx_proactive_notifications_user_status;
      DROP INDEX IF EXISTS idx_proactive_notifications_user_entity;
      DROP TABLE IF EXISTS proactive_notifications;
      DROP TABLE IF EXISTS proactive_schedule_state;
      DELETE FROM schema_migrations WHERE version = '007_proactive_assistant';
      DROP INDEX IF EXISTS idx_memories_user_status;
      ALTER TABLE memories DROP COLUMN status;
      ALTER TABLE memories DROP COLUMN category;
      ALTER TABLE memories DROP COLUMN verified_by_user;
      ALTER TABLE memories DROP COLUMN goal_id;
      ALTER TABLE memories DROP COLUMN task_id;
      ALTER TABLE memories DROP COLUMN expires_at;
      ALTER TABLE memories DROP COLUMN superseded_by;
      ALTER TABLE memories DROP COLUMN archived_at;
      ALTER TABLE memory_candidates DROP COLUMN category;
      ALTER TABLE memory_candidates DROP COLUMN goal_id;
      ALTER TABLE memory_candidates DROP COLUMN task_id;
      ALTER TABLE memory_candidates DROP COLUMN conflict_memory_id;
      DELETE FROM schema_migrations WHERE version = '006_memory_evolution';
      DROP INDEX IF EXISTS idx_execution_events_execution;
      DROP INDEX IF EXISTS idx_execution_events_task;
      DROP TABLE IF EXISTS execution_events;
      ALTER TABLE execution_tasks DROP COLUMN error_category;
      ALTER TABLE execution_tasks DROP COLUMN error_code;
      ALTER TABLE execution_tasks DROP COLUMN retryable;
      ALTER TABLE execution_tasks DROP COLUMN needs_verification;
      ALTER TABLE execution_tasks DROP COLUMN retry_of_execution_id;
      ALTER TABLE execution_tasks DROP COLUMN last_progress_at;
      DELETE FROM schema_migrations WHERE version = '005_execution_lifecycle';
      DROP TRIGGER IF EXISTS trg_execution_tasks_task_owner_insert;
      DROP TRIGGER IF EXISTS trg_execution_tasks_task_owner_update;
      DROP INDEX IF EXISTS idx_execution_tasks_one_active_per_task;
      DROP INDEX IF EXISTS idx_execution_tasks_task;
      ALTER TABLE execution_tasks DROP COLUMN task_id;
      ALTER TABLE agents DROP COLUMN capabilities;
      ALTER TABLE agents DROP COLUMN execution_backend;
      ALTER TABLE agents DROP COLUMN backend_config;
      ALTER TABLE agents DROP COLUMN model_preference;
      ALTER TABLE agents DROP COLUMN status;
      ALTER TABLE agents DROP COLUMN instructions;
      ALTER TABLE agents DROP COLUMN concurrency_limit;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS goal_projects;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS goals;
      DROP TABLE IF EXISTS users;
      DELETE FROM schema_migrations WHERE version = '004_v1_5_phase1';
      COMMIT;
    `);

    const kept = db.get<{ id: string; status: string }>(
      'SELECT id, status FROM execution_tasks WHERE id = ?',
      ['task_keep'],
    );
    expect(kept).toEqual({ id: 'task_keep', status: 'completed' });

    const versions = db
      .all<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version ASC')
      .map((r) => r.version);
    expect(versions).toEqual(['001_init', '002_trajectory_request_scope', '003_personal_ai']);
  });
});
