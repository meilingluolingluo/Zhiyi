/**
 * 隔离缺陷回归用例（QA 定向验证发现的两个问题）。
 * 1) 跨用户相同 request_id 不得泄漏他人轨迹、不得静默丢数据（含聊天代理路径）。
 * 2) POST /v1/memories/search 必须忽略 body.agent_id，无法越权读取其它 Agent 专属记忆。
 */
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config';
import { createHarness, type Harness } from './helpers';

const DEVELOPER_KEY = 'dev-key-developer';
const RESEARCHER_KEY = 'dev-key-researcher';
const USER2_KEY = 'dev-key-user2';

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

describe('Bug A：跨用户 request_id 碰撞', () => {
  it('手动补录相同 request_id 时各自保存成功，且不回传他人轨迹', async (): Promise<void> => {
    await withHarness({}, async (h: Harness): Promise<void> => {
      const payload = (response: string): Record<string, unknown> => ({
        request_id: 'qa-leak-req',
        request: { messages: [{ role: 'user', content: 'u1 私有内容' }] },
        response,
      });

      const u1 = await h.api('/v1/trajectories', {
        method: 'POST',
        key: DEVELOPER_KEY,
        body: payload('QA_U1_PRIVATE_DATA'),
      });
      expect(u1.status).toBe(201);
      expect(u1.json.inserted).toBe(true);
      expect(u1.json.trajectory.user_id).toBe('u1');

      const u2 = await h.api('/v1/trajectories', {
        method: 'POST',
        key: USER2_KEY,
        body: payload('QA_U2_PRIVATE_DATA'),
      });
      expect(u2.status).toBe(201);
      expect(u2.json.inserted).toBe(true);
      expect(u2.json.trajectory.user_id).toBe('u2');
      expect(u2.json.trajectory.response).toBe('QA_U2_PRIVATE_DATA');
      expect(JSON.stringify(u2.json)).not.toContain('QA_U1_PRIVATE_DATA');

      const u1List = await h.api('/v1/trajectories', { key: DEVELOPER_KEY });
      const u2List = await h.api('/v1/trajectories', { key: USER2_KEY });
      expect(u1List.json.total).toBe(1);
      expect(u2List.json.total).toBe(1);
      expect(u1List.json.items[0].response).toBe('QA_U1_PRIVATE_DATA');
      expect(u2List.json.items[0].response).toBe('QA_U2_PRIVATE_DATA');

      // 同一用户重复提交同一 request_id 仍然去重。
      const again = await h.api('/v1/trajectories', {
        method: 'POST',
        key: USER2_KEY,
        body: payload('重复提交'),
      });
      expect(again.status).toBe(200);
      expect(again.json.inserted).toBe(false);
      expect(again.json.trajectory.user_id).toBe('u2');
      expect((await h.api('/v1/trajectories', { key: USER2_KEY })).json.total).toBe(1);
    });
  });

  it('聊天代理路径 X-Request-Id 跨用户碰撞时各自轨迹均正常保存', async (): Promise<void> => {
    await withHarness({}, async (h: Harness): Promise<void> => {
      for (const key of [DEVELOPER_KEY, USER2_KEY]) {
        const res = await h.api('/v1/chat/completions', {
          method: 'POST',
          key,
          headers: { 'x-request-id': 'shared-chat-req' },
          body: { messages: [{ role: 'user', content: '你好' }] },
        });
        expect(res.status).toBe(200);
      }
      await h.waitForBackground();

      const u1 = await h.api('/v1/trajectories?limit=200', { key: DEVELOPER_KEY });
      const u2 = await h.api('/v1/trajectories?limit=200', { key: USER2_KEY });
      expect(u1.json.total).toBe(1);
      expect(u2.json.total).toBe(1);
      expect(u1.json.items[0].request_id).toBe('shared-chat-req');
      expect(u2.json.items[0].request_id).toBe('shared-chat-req');
      expect(u1.json.items[0].user_id).toBe('u1');
      expect(u2.json.items[0].user_id).toBe('u2');
    });
  });
});

describe('Bug B：search 端点忽略 body.agent_id', () => {
  it('伪造 agent_id 无法越权读取其它 Agent 专属记忆，chat 中 agent_id 仍被剥离', async (): Promise<void> => {
    await withHarness({}, async (h: Harness): Promise<void> => {
      const secret = 'QA_AGENT_SECRET_开发人员内部代码规范与架构约定';
      const created = await h.api('/v1/memories', {
        method: 'POST',
        key: DEVELOPER_KEY,
        body: { content: secret, scope: 'agent' },
      });
      expect(created.status).toBe(201);
      expect(created.json.memory.agent_id).toBe('developer');

      const query = { query: '开发人员内部代码规范与架构约定' };
      const normal = await h.api('/v1/memories/search', {
        method: 'POST',
        key: RESEARCHER_KEY,
        body: query,
      });
      expect(normal.json.count).toBe(0);

      const forged = await h.api('/v1/memories/search', {
        method: 'POST',
        key: RESEARCHER_KEY,
        body: { ...query, agent_id: 'developer', user_id: 'hacker' },
      });
      expect(forged.status).toBe(200);
      expect(forged.json.count).toBe(0);
      expect(JSON.stringify(forged.json)).not.toContain('QA_AGENT_SECRET');

      const own = await h.api('/v1/memories/search', {
        method: 'POST',
        key: DEVELOPER_KEY,
        body: query,
      });
      expect(own.json.count).toBe(1);
      expect(own.json.results[0].memory.content).toBe(secret);

      // body 中的身份字段在聊天请求里仍被剥离。
      const chat = await h.api('/v1/chat/completions', {
        method: 'POST',
        key: DEVELOPER_KEY,
        body: {
          messages: [{ role: 'user', content: '普通问题' }],
          user_id: 'hacker',
          agent_id: 'evil',
        },
      });
      expect(chat.status).toBe(200);
      const upstream = (await h.api('/__mock__/last-request')).json.request;
      expect(upstream).not.toHaveProperty('user_id');
      expect(upstream).not.toHaveProperty('agent_id');
    });
  });
});
