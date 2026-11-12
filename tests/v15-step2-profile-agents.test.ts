/**
 * Step 2 测试：UserProfileStore、AgentStore 扩展/防覆盖、Admin Guard 与 PATCH /v1/agents/:id。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request as ExpressRequest } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { isAdminRequest } from '../src/admin-auth';
import { AgentStore } from '../src/agents';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { Database } from '../src/db';
import { DomainError } from '../src/personal-ai/domain/types';
import { UserProfileStore } from '../src/personal-ai/domain/user-profile-store';
import { loadPersonalAIConfig } from '../src/personal-ai/config';

const dbs: Database[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async (): Promise<void> => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
  while (dbs.length > 0) {
    const db = dbs.pop();
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
});

function openMigratedDb(): Database {
  const db = Database.open(':memory:');
  dbs.push(db);
  db.migrate();
  return db;
}

async function startTestApp(options: { adminToken?: string } = {}): Promise<{
  baseUrl: string;
  created: CreatedApp;
}> {
  const config: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: true,
    logSilent: true,
    settingsToken: options.adminToken ?? '',
  };
  const created = await createApp(config, {
    silent: true,
    adminToken: options.adminToken,
    upstreamSettings: null,
    personalAIConfig: {
      ...loadPersonalAIConfig({}),
      enabled: true,
    },
  });
  const server = http.createServer(created.app);
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', (): void => resolve());
  });
  cleanups.push(async (): Promise<void> => {
    await new Promise<void>((resolve): void => server.close((): void => resolve()));
    await created.close();
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, created };
}

describe('Step 2.1: UserProfileStore', () => {
  it('时区来源优先级严格遵循 user > header > default，且不假设特定地区', () => {
    const db = openMigratedDb();
    const store = new UserProfileStore(db);

    // 1. 无请求头 → default ('UTC')
    const p1 = store.ensureUser('u1');
    expect(p1.timezone).toBe('UTC');
    expect(p1.timezone_source).toBe('default');

    // 2. 非法请求头忽略，保持 default ('UTC')
    const p2 = store.ensureUser('u1', { headerTimezone: 'Mars/Olympus' });
    expect(p2.timezone).toBe('UTC');
    expect(p2.timezone_source).toBe('default');

    // 3. 合法请求头提升为 header
    const p3 = store.ensureUser('u1', { headerTimezone: 'America/New_York' });
    expect(p3.timezone).toBe('America/New_York');
    expect(p3.timezone_source).toBe('header');

    // 4. 后续请求未带请求头或带非法请求头时，不降级已有的 header 时区
    const p4 = store.ensureUser('u1', { headerTimezone: 'Bad/Zone' });
    expect(p4.timezone).toBe('America/New_York');
    expect(p4.timezone_source).toBe('header');

    // 5. 用户显式保存后成为 user 来源，后续合法 header 不再覆盖
    const p5 = store.update('u1', { timezone: 'Europe/London' });
    expect(p5.timezone).toBe('Europe/London');
    expect(p5.timezone_source).toBe('user');

    const p6 = store.ensureUser('u1', { headerTimezone: 'Asia/Tokyo' });
    expect(p6.timezone).toBe('Europe/London');
    expect(p6.timezone_source).toBe('user');

    // 6. 新用户首次带合法 header 直接初始化为 header
    const u2 = store.ensureUser('u2', { headerTimezone: 'Asia/Tokyo', displayName: 'Alice' });
    expect(u2.timezone).toBe('Asia/Tokyo');
    expect(u2.timezone_source).toBe('header');
    expect(u2.display_name).toBe('Alice');
  });

  it('校验非法 IANA 时区、JSON 白名单、原型污染防御、大小上限及 default_project_id 归属', () => {
    const db = openMigratedDb();
    const store = new UserProfileStore(db);
    store.ensureUser('u1');
    store.ensureUser('u2');

    // 非法时区抛 400
    expect(() => store.update('u1', { timezone: 'Invalid/City' })).toThrow(DomainError);

    // work_style 白名单浅合并与非法键拒绝
    const updated = store.update('u1', {
      display_name: 'Bob',
      work_style: { response_style: 'concise', coding_conventions: ['Use TypeScript strict'] },
      preferences: { memory_injection_enabled: true },
    });
    expect(updated.work_style).toEqual({
      response_style: 'concise',
      coding_conventions: ['Use TypeScript strict'],
    });
    expect(updated.preferences).toEqual({ memory_injection_enabled: true });

    const merged = store.update('u1', { work_style: { language: 'zh-CN' } });
    expect(merged.work_style).toEqual({
      response_style: 'concise',
      coding_conventions: ['Use TypeScript strict'],
      language: 'zh-CN',
    });

    // 未知键与 __proto__ 拒绝
    expect(() => store.update('u1', { work_style: { unknown_key: 1 } })).toThrow(DomainError);
    const protoPayload = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => store.update('u1', { work_style: protoPayload })).toThrow(DomainError);

    // 超出 8KB 拒绝
    expect(() =>
      store.update('u1', {
        work_style: { coding_conventions: Array.from({ length: 50 }, () => 'x'.repeat(200)) },
      }),
    ).toThrow(DomainError);

    // default_project_id 只能绑定自己未软删除的 project
    const now = '2026-11-12T00:00:00.000Z';
    db.run(`INSERT INTO projects (id, user_id, title, created_at, updated_at) VALUES ('proj_u1', 'u1', 'P1', ?, ?)`, [now, now]);
    db.run(`INSERT INTO projects (id, user_id, title, created_at, updated_at) VALUES ('proj_u2', 'u2', 'P2', ?, ?)`, [now, now]);
    db.run(`INSERT INTO projects (id, user_id, title, deleted_at, created_at, updated_at) VALUES ('proj_del', 'u1', 'Del', ?, ?, ?)`, [now, now, now]);

    expect(() => store.update('u1', { preferences: { default_project_id: 'proj_u2' } })).toThrow(DomainError);
    expect(() => store.update('u1', { preferences: { default_project_id: 'proj_del' } })).toThrow(DomainError);

    const withProj = store.update('u1', { preferences: { default_project_id: 'proj_u1' } });
    expect(withProj.preferences.default_project_id).toBe('proj_u1');
  });
});

describe('Step 2.2: AgentStore 扩展、seed 防覆盖与 ON CONFLICT 保留配置', () => {
  it('seed() 在空库初始化默认 multica 配置，重启再次 seed() 不覆盖管理员修改', () => {
    const db = openMigratedDb();
    const store = new AgentStore(db);
    store.seed();

    const dev = store.get('developer')!;
    const res = store.get('researcher')!;
    expect(dev.execution_backend).toBe('multica');
    expect(dev.capabilities).toEqual(['code', 'refactor', 'debug', 'architecture', 'test']);
    expect(res.execution_backend).toBe('multica');
    expect(res.capabilities).toEqual(['research', 'analysis', 'evaluation', 'benchmark']);

    // 管理员修改内置 developer 配置
    store.updateAdmin('developer', {
      execution_backend: 'direct_llm',
      model_preference: 'DeepSeek-V4',
      concurrency_limit: 8,
      instructions: 'Always include tests.',
      status: 'disabled',
    });

    // 模拟重启再次调用 seed()，绝不能重置管理员配置
    store.seed();
    const afterReseed = store.get('developer')!;
    expect(afterReseed.execution_backend).toBe('direct_llm');
    expect(afterReseed.model_preference).toBe('DeepSeek-V4');
    expect(afterReseed.concurrency_limit).toBe(8);
    expect(afterReseed.instructions).toBe('Always include tests.');
    expect(afterReseed.status).toBe('disabled');
  });

  it('create() 使用 ON CONFLICT DO UPDATE：新建默认 direct_llm，冲突仅更新基础元数据且不触发外键删除错误', () => {
    const db = openMigratedDb();
    const store = new AgentStore(db);
    const now = '2026-11-12T00:00:00.000Z';

    const created = store.create({ agent_id: 'writer', name: 'Writer', role: 'Doc' });
    expect(created.execution_backend).toBe('direct_llm');

    store.updateAdmin('writer', {
      execution_backend: 'multica',
      backend_config: { assignee: 'Codex' },
      capabilities: ['docs'],
      model_preference: 'gpt-5',
      concurrency_limit: 5,
    });

    // 创建引用该 agent 的业务任务，验证后续 create() 不触发 ON DELETE RESTRICT 报错
    db.run(`INSERT INTO users (user_id, created_at, updated_at) VALUES ('u1', ?, ?)`, [now, now]);
    db.run(
      `INSERT INTO tasks (id, user_id, title, assignee_agent_id, created_at, updated_at)
       VALUES ('btask_1', 'u1', 'Write doc', 'writer', ?, ?)`,
      [now, now],
    );

    const updated = store.create({
      agent_id: 'writer',
      name: 'Senior Writer',
      role: 'Tech Writer',
      description: 'Updated desc',
      core_memory: '关注：文档',
    });
    expect(updated.name).toBe('Senior Writer');
    expect(updated.role).toBe('Tech Writer');
    expect(updated.execution_backend).toBe('multica');
    expect(updated.backend_config).toEqual({ assignee: 'Codex' });
    expect(updated.capabilities).toEqual(['docs']);
    expect(updated.model_preference).toBe('gpt-5');
    expect(updated.concurrency_limit).toBe(5);
  });

  it('updateAdmin() 严格校验后端、assignee 正则、模型偏好与并发上限', () => {
    const db = openMigratedDb();
    const store = new AgentStore(db);
    store.seed();

    expect(() => store.updateAdmin('developer', { execution_backend: 'shell' })).toThrow(DomainError);
    expect(() => store.updateAdmin('developer', { backend_config: { assignee: 'rm -rf;whoami' } })).toThrow(DomainError);
    expect(() => store.updateAdmin('developer', { backend_config: { apiKey: 'sk-123' } })).toThrow(DomainError);
    expect(() => store.updateAdmin('developer', { model_preference: 'https://evil.example/v1' })).toThrow(DomainError);
    expect(() => store.updateAdmin('developer', { concurrency_limit: 0 })).toThrow(DomainError);
    expect(() => store.updateAdmin('developer', { status: 'deleted' })).toThrow(DomainError);
  });
});

describe('Step 2.3: Admin Guard 与 /v1/agents 权限边界', () => {
  it('配置 ZHIYI_SETTINGS_TOKEN 时：普通用户无法 PATCH 或利用 POST 覆盖内置/特权配置，管理员令牌可正常配置', async () => {
    const { baseUrl } = await startTestApp({ adminToken: 'super-secret-admin-token' });

    // 1. 普通用户读取 /v1/agents 返回脱敏视图（不含 backend_config / instructions / model_preference）
    const listRes = await fetch(`${baseUrl}/v1/agents`, {
      headers: { authorization: 'Bearer dev-key-developer' },
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { items: Array<Record<string, unknown>> };
    const devPublic = listJson.items.find((a) => a.agent_id === 'developer')!;
    expect(devPublic.execution_backend).toBe('multica');
    expect(devPublic.backend_config).toBeUndefined();
    expect(devPublic.instructions).toBeUndefined();

    // 2. 普通用户调用 PATCH /v1/agents/developer 被 401 拒绝
    const patchDenied = await fetch(`${baseUrl}/v1/agents/developer`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev-key-developer',
      },
      body: JSON.stringify({ execution_backend: 'direct_llm' }),
    });
    expect(patchDenied.status).toBe(401);

    // 3. 普通用户调用 POST /v1/agents 携带特权字段或试图覆盖内置 developer 被 403 拒绝
    const postPrivilegedDenied = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev-key-developer',
      },
      body: JSON.stringify({
        agent_id: 'custom_user_agent',
        name: 'Sneaky',
        execution_backend: 'multica',
      }),
    });
    expect(postPrivilegedDenied.status).toBe(403);

    const postBuiltinDenied = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev-key-developer',
      },
      body: JSON.stringify({
        agent_id: 'developer',
        name: 'Hijacked Dev',
      }),
    });
    expect(postBuiltinDenied.status).toBe(403);

    // 4. 管理员使用 X-Zhiyi-Admin-Token 或 Bearer adminToken 成功更新，并读到完整配置
    const patchAllowed = await fetch(`${baseUrl}/v1/agents/developer`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-zhiyi-admin-token': 'super-secret-admin-token',
      },
      body: JSON.stringify({
        backend_config: { assignee: 'Codex' },
        model_preference: 'DeepSeek-V4',
        concurrency_limit: 5,
        instructions: 'Follow repo style.',
      }),
    });
    expect(patchAllowed.status).toBe(200);
    const patchJson = (await patchAllowed.json()) as { profile: Record<string, unknown> };
    expect(patchJson.profile.backend_config).toEqual({ assignee: 'Codex' });
    expect(patchJson.profile.model_preference).toBe('DeepSeek-V4');
    expect(patchJson.profile.concurrency_limit).toBe(5);

    // 不存在的 Agent 返回 404
    const patchMissing = await fetch(`${baseUrl}/v1/agents/non_existent`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer super-secret-admin-token',
      },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(patchMissing.status).toBe(404);
  });

  it('未配置 ZHIYI_SETTINGS_TOKEN 时：允许本机 loopback 管理，拒绝非 loopback 请求', async () => {
    const { baseUrl } = await startTestApp({ adminToken: '' });

    // 本机 127.0.0.1 允许 PATCH
    const localPatch = await fetch(`${baseUrl}/v1/agents/researcher`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(localPatch.status).toBe(200);
    const json = (await localPatch.json()) as { profile: { status: string } };
    expect(json.profile.status).toBe('disabled');

    // 非 loopback IP 被 Admin Guard 拒绝
    const remoteReq = {
      ip: '192.168.1.50',
      socket: { remoteAddress: '192.168.1.50' },
      headers: {},
    } as unknown as ExpressRequest;
    expect(isAdminRequest(remoteReq, '')).toBe(false);

    const loopbackReq = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    } as unknown as ExpressRequest;
    expect(isAdminRequest(loopbackReq, '')).toBe(true);
  });
});
