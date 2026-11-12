import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config';
import { createHarness, type Harness } from './helpers';

const VALUABLE_TURN = '我们决定采用 PostgreSQL 作为主数据库，以后请记住这个技术栈偏好';

async function withHarness(
  overrides: Partial<AppConfig>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const h: Harness = await createHarness(overrides);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

async function completeTurn(h: Harness): Promise<void> {
  const res = await h.api('/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-session-id': 'sess-4', 'x-task-id': 'task-4', 'x-project-id': 'proj-4' },
    body: { messages: [{ role: 'user', content: VALUABLE_TURN }] },
  });
  expect(res.status).toBe(200);
  await h.waitForBackground();
}

describe('场景四：自动提取 → 候选 → 确认入库', () => {
  it('请求后保存轨迹、异步产生候选，approve 后进入正式记忆库且幂等', async (): Promise<void> => {
    await withHarness({}, async (h: Harness): Promise<void> => {
      await completeTurn(h);

      const trajectories = await h.api('/v1/trajectories');
      expect(trajectories.json.total).toBe(1);
      const trajectory = trajectories.json.items[0];
      expect(trajectory.session_id).toBe('sess-4');
      expect(trajectory.task_id).toBe('task-4');
      expect(trajectory.project_id).toBe('proj-4');
      expect(trajectory.request).toContain('PostgreSQL');
      expect(trajectory.response).toContain('Mock 上游');

      const candidates = await h.api('/v1/memory-candidates');
      expect(candidates.json.count).toBeGreaterThanOrEqual(1);
      const candidate = candidates.json.items.find((c: any) => c.content.includes('PostgreSQL'));
      expect(candidate).toBeDefined();
      expect(candidate.trajectory_id).toBe(trajectory.id);
      expect(candidate.status).toBe('pending');
      expect(candidate.source).toBe('auto-extract');

      const approved = await h.api(`/v1/memory-candidates/${candidate.id}/approve`, {
        method: 'POST',
        body: {},
      });
      expect(approved.status).toBe(200);
      expect(approved.json.ok).toBe(true);
      expect(approved.json.idempotent).toBe(false);
      expect(approved.json.memory.content).toContain('PostgreSQL');
      expect(approved.json.memory.source).toContain('candidate:');

      const memories = await h.api('/v1/memories');
      expect(
        memories.json.items.some((m: any) => m.memory_id === approved.json.memory.memory_id),
      ).toBe(true);

      const again = await h.api(`/v1/memory-candidates/${candidate.id}/approve`, {
        method: 'POST',
        body: {},
      });
      expect(again.json.ok).toBe(true);
      expect(again.json.idempotent).toBe(true);
      expect((await h.api('/v1/memories')).json.total).toBe(1);
    });
  });

  it('其它 Agent 之后可以检索到 approve 后的记忆', async (): Promise<void> => {
    await withHarness({}, async (h: Harness): Promise<void> => {
      await completeTurn(h);
      const candidate = (await h.api('/v1/memory-candidates')).json.items.find((c: any) =>
        c.content.includes('PostgreSQL'),
      );
      await h.api(`/v1/memory-candidates/${candidate.id}/approve`, { method: 'POST', body: {} });
      // 该候选是项目级决策，需在同一 project_id 上下文检索；其它项目上下文不可见。
      const search = await h.api('/v1/memories/search', {
        method: 'POST',
        key: 'dev-key-researcher',
        headers: { 'x-project-id': 'proj-4' },
        body: { query: 'PostgreSQL 主数据库 技术栈' },
      });
      expect(search.json.results.some((r: any) => r.memory.content.includes('PostgreSQL'))).toBe(true);
      const otherProject = await h.api('/v1/memories/search', {
        method: 'POST',
        key: 'dev-key-researcher',
        headers: { 'x-project-id': 'proj-other' },
        body: { query: 'PostgreSQL 主数据库 技术栈' },
      });
      expect(otherProject.json.count).toBe(0);
    });
  });

  it('候选可以 reject，且不会进入正式记忆库', async (): Promise<void> => {
    await withHarness({}, async (h: Harness): Promise<void> => {
      await completeTurn(h);
      const candidate = (await h.api('/v1/memory-candidates')).json.items.find((c: any) =>
        c.content.includes('PostgreSQL'),
      );
      const rejected = await h.api(`/v1/memory-candidates/${candidate.id}/reject`, {
        method: 'POST',
        body: {},
      });
      expect(rejected.status).toBe(200);
      expect(rejected.json.candidate.status).toBe('rejected');
      expect((await h.api('/v1/memory-candidates?status=rejected')).json.count).toBe(1);
      expect((await h.api('/v1/memories')).json.total).toBe(0);
      expect((await h.api(`/v1/memory-candidates/${candidate.id}/approve`, { method: 'POST', body: {} })).status).toBe(409);
    });
  });

  it('低置信度候选不自动写入正式记忆', async (): Promise<void> => {
    await withHarness({ extractMinConfidence: 0.95 }, async (h: Harness): Promise<void> => {
      await completeTurn(h);
      const candidates = await h.api('/v1/memory-candidates');
      expect(candidates.json.items[0].status).toBe('low_confidence');
      expect((await h.api('/v1/memories')).json.total).toBe(0);
    });
  });

  it('MEMORY_AUTO_EXTRACT=false 时不产生候选，但轨迹仍保存', async (): Promise<void> => {
    await withHarness({ memoryAutoExtract: false }, async (h: Harness): Promise<void> => {
      await completeTurn(h);
      expect((await h.api('/v1/memory-candidates')).json.count).toBe(0);
      expect((await h.api('/v1/trajectories')).json.total).toBe(1);
    });
  });
});

describe('轨迹手动补录与隔离', () => {
  it('POST /v1/trajectories 支持补录，相同 request_id 去重', async (): Promise<void> => {
    await withHarness({}, async (h: Harness): Promise<void> => {
      const first = await h.api('/v1/trajectories', {
        method: 'POST',
        body: {
          request_id: 'manual-1',
          request: { messages: [{ role: 'user', content: '补录内容' }] },
          response: '补录响应',
          model: 'manual-model',
        },
      });
      expect(first.status).toBe(201);
      expect(first.json.inserted).toBe(true);
      const second = await h.api('/v1/trajectories', {
        method: 'POST',
        body: { request_id: 'manual-1', request: {}, response: '重复' },
      });
      expect(second.status).toBe(200);
      expect(second.json.inserted).toBe(false);
      const page = await h.api('/v1/trajectories');
      expect(page.json.total).toBe(1);
      expect(page.json.items[0].user_id).toBe('u1');
      expect(page.json.items[0].response).toBe('补录响应');
    });
  });

  it('轨迹与候选按当前用户严格隔离', async (): Promise<void> => {
    await withHarness({}, async (h: Harness): Promise<void> => {
      await completeTurn(h);
      const u2Trajectories = await h.api('/v1/trajectories', { key: 'dev-key-user2' });
      expect(u2Trajectories.json.total).toBe(0);
      const u2Candidates = await h.api('/v1/memory-candidates', { key: 'dev-key-user2' });
      expect(u2Candidates.json.count).toBe(0);
      const candidate = (await h.api('/v1/memory-candidates')).json.items[0];
      expect(
        (await h.api(`/v1/memory-candidates/${candidate.id}/approve`, {
          method: 'POST',
          key: 'dev-key-user2',
          body: {},
        })).status,
      ).toBe(404);
    });
  });
});
