import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers';

const PREFERENCE = '技术方案优先考虑简单、可维护，避免不必要的复杂架构';

let h: Harness;

async function clearMemories(key = 'dev-key-developer'): Promise<void> {
  const list = await h.api('/v1/memories?limit=200', { key });
  for (const memory of list.json.items as Array<{ memory_id: string }>) {
    await h.api(`/v1/memories/${memory.memory_id}`, { method: 'DELETE', key });
  }
}

beforeAll(async (): Promise<void> => {
  h = await createHarness();
});

afterAll(async (): Promise<void> => {
  await h.close();
});

beforeEach(async (): Promise<void> => {
  await h.mockReset();
  await clearMemories();
  await clearMemories('dev-key-user2');
});

describe('基础能力', () => {
  it('GET /health 返回服务与上游状态', async (): Promise<void> => {
    const res = await h.api('/health');
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('ok');
    expect(res.json.db).toBe('ok');
    expect(res.json.upstream.mode).toBe('mock');
    expect(res.json.memory.enabled).toBe(true);
  });

  it('内置 Developer 与 Researcher Profile 可直接读取', async (): Promise<void> => {
    const list = await h.api('/v1/agents');
    expect(list.json.items.map((a: { agent_id: string }) => a.agent_id)).toEqual(
      expect.arrayContaining(['developer', 'researcher']),
    );
    const profile = await h.api('/v1/agents/researcher/profile');
    expect(profile.json.profile.role).toContain('调研');
    const custom = await h.api('/v1/agents', {
      method: 'POST',
      body: { agent_id: 'writer', name: 'Writer', role: '文档工程师', core_memory: '关注：文档、规范' },
    });
    expect(custom.status).toBe(201);
    expect(custom.json.profile.name).toBe('Writer');
  });
});

describe('场景一：记忆写入与 CRUD', () => {
  it('创建偏好记忆后可通过 GET / 列表查询', async (): Promise<void> => {
    const created = await h.api('/v1/memories', {
      method: 'POST',
      body: { content: PREFERENCE, type: 'semantic', scope: 'personal', confidence: 0.95 },
    });
    expect(created.status).toBe(201);
    expect(created.json.memory.user_id).toBe('u1');
    expect(created.json.memory.content).toBe(PREFERENCE);

    const id: string = created.json.memory.memory_id;
    const one = await h.api(`/v1/memories/${id}`);
    expect(one.status).toBe(200);
    expect(one.json.memory.content).toBe(PREFERENCE);

    const list = await h.api('/v1/memories');
    expect(list.json.items.some((m: { memory_id: string }) => m.memory_id === id)).toBe(true);
  });

  it('支持 PATCH 更新与 DELETE 删除', async (): Promise<void> => {
    const created = await h.api('/v1/memories', {
      method: 'POST',
      body: { content: '旧内容：使用 MySQL' },
    });
    const id: string = created.json.memory.memory_id;

    const patched = await h.api(`/v1/memories/${id}`, {
      method: 'PATCH',
      body: { content: '新内容：使用 PostgreSQL', type: 'semantic', scope: 'project', project_id: 'p1' },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.memory.content).toBe('新内容：使用 PostgreSQL');
    expect(patched.json.memory.scope).toBe('project');

    const removed = await h.api(`/v1/memories/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await h.api(`/v1/memories/${id}`)).status).toBe(404);
  });

  it('客户端传入的 user_id 被忽略，以服务端 Key 解析为准', async (): Promise<void> => {
    const created = await h.api('/v1/memories', {
      method: 'POST',
      body: { content: '用户身份不可伪造', user_id: 'hacker', agent_id: 'evil' },
    });
    expect(created.json.memory.user_id).toBe('u1');
    expect(created.json.memory.agent_id).toBeNull();
  });

  it('参数非法时返回 400，不存在的记忆返回 404', async (): Promise<void> => {
    expect((await h.api('/v1/memories', { method: 'POST', body: { content: '' } })).status).toBe(400);
    expect((await h.api('/v1/memories/not-exist')).status).toBe(404);
    expect((await h.api('/v1/memories/not-exist', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('检索能力', () => {
  it('POST /v1/memories/search 按关键词加权返回命中与分数', async (): Promise<void> => {
    await h.api('/v1/memories', {
      method: 'POST',
      body: { content: PREFERENCE, scope: 'personal', confidence: 0.95 },
    });
    const res = await h.api('/v1/memories/search', {
      method: 'POST',
      body: { query: '技术方案优先考虑简单可维护架构', limit: 5 },
    });
    expect(res.status).toBe(200);
    expect(res.json.count).toBeGreaterThanOrEqual(1);
    expect(res.json.results[0].memory.content).toBe(PREFERENCE);
    expect(res.json.results[0].score).toBeGreaterThan(0);
    expect(res.json.results[0].matched_keywords.length).toBeGreaterThan(0);
  });

  it('scopes 过滤生效', async (): Promise<void> => {
    await h.api('/v1/memories', {
      method: 'POST',
      body: { content: PREFERENCE, scope: 'personal' },
    });
    const res = await h.api('/v1/memories/search', {
      method: 'POST',
      body: { query: '架构', scopes: ['project'] },
    });
    expect(res.json.count).toBe(0);
  });
});

describe('场景三：不同 user_id 严格隔离', () => {
  it('u2 无法通过 GET / search 读取 u1 的个人记忆', async (): Promise<void> => {
    const created = await h.api('/v1/memories', {
      method: 'POST',
      body: { content: PREFERENCE, scope: 'personal' },
    });
    const id: string = created.json.memory.memory_id;

    expect((await h.api(`/v1/memories/${id}`, { key: 'dev-key-user2' })).status).toBe(404);
    expect((await h.api(`/v1/memories/${id}`, { method: 'PATCH', key: 'dev-key-user2', body: { content: '篡改' } })).status).toBe(404);
    expect((await h.api(`/v1/memories/${id}`, { method: 'DELETE', key: 'dev-key-user2' })).status).toBe(404);

    const u2List = await h.api('/v1/memories', { key: 'dev-key-user2' });
    expect(u2List.json.items.some((m: { content: string }) => m.content === PREFERENCE)).toBe(false);
    const u2Search = await h.api('/v1/memories/search', {
      method: 'POST',
      key: 'dev-key-user2',
      body: { query: '技术方案优先考虑简单可维护架构' },
    });
    expect(u2Search.json.count).toBe(0);

    await h.api('/v1/memories', {
      method: 'POST',
      key: 'dev-key-user2',
      body: { content: 'u2 的私有偏好：只用 Go' },
    });
    const u1List = await h.api('/v1/memories');
    expect(u1List.json.items.some((m: { content: string }) => m.content.includes('u2 的私有偏好'))).toBe(false);
  });
});
