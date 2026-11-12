/**
 * QA 补充用例：覆盖现有 3 个测试文件未命中的缺口。
 * 1) 配置层：环境变量 → AppConfig 的映射、默认值、布尔/数值解析、API_KEYS 解析、URL 拼接
 * 2) 文档一致性：.env.example 与 src/config.ts 的变量集合必须一一对应
 * 3) 纯函数：SSE 帧严格解析、注入消息顺序与不可变性
 * 4) 边界：MEMORY_MAX_ITEMS / MEMORY_TOKEN_BUDGET 约束、无 API Key 兜底身份、流式响应精确拼接
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { completionsUrl, DEFAULT_API_KEYS, loadConfig } from '../src/config';
import { injectMemoryMessages } from '../src/context';
import { parseSseFrame } from '../src/proxy';
import { createHarness } from './helpers';

const ROOT = process.cwd();

describe('配置层：环境变量与默认值', () => {
  it('全部 18 个环境变量都映射到 AppConfig 对应字段', () => {
    const env: NodeJS.ProcessEnv = {
      PORT: '9123',
      DATABASE_URL: './data/qa-config.db',
      MULTICA_BASE_URL: 'https://upstream.example.com',
      MULTICA_API_KEY: 'sk-test',
      DEFAULT_MODEL: 'remote-model',
      MOCK_UPSTREAM: 'false',
      UPSTREAM_TIMEOUT_MS: '4321',
      MEMORY_ENABLED: 'false',
      MEMORY_AUTO_EXTRACT: 'false',
      MEMORY_MAX_ITEMS: '3',
      MEMORY_TOKEN_BUDGET: '99',
      EXTRACT_MIN_CONFIDENCE: '0.75',
      API_KEYS: '{"k1":{"user_id":"alice","agent_id":"codex"}}',
      DEFAULT_USER_ID: 'du',
      DEFAULT_AGENT_ID: 'da',
      LOG_SILENT: 'true',
      ZHIYI_SETTINGS_PATH: './data/qa-settings.json',
      ZHIYI_SETTINGS_TOKEN: 'qa-token',
    };
    const c = loadConfig(env);
    expect(c.port).toBe(9123);
    expect(c.databaseUrl).toBe('./data/qa-config.db');
    expect(c.upstreamBaseUrl).toBe('https://upstream.example.com');
    expect(c.mockUpstream).toBe(false);
    expect(c.upstreamApiKey).toBe('sk-test');
    expect(c.defaultModel).toBe('remote-model');
    expect(c.upstreamTimeoutMs).toBe(4321);
    expect(c.memoryEnabled).toBe(false);
    expect(c.memoryAutoExtract).toBe(false);
    expect(c.memoryMaxItems).toBe(3);
    expect(c.memoryTokenBudget).toBe(99);
    expect(c.extractMinConfidence).toBe(0.75);
    expect(c.apiKeys).toEqual({ k1: { user_id: 'alice', agent_id: 'codex' } });
    expect(c.defaultIdentity).toEqual({ user_id: 'du', agent_id: 'da' });
    expect(c.logSilent).toBe(true);
    expect(c.settingsPath).toBe('./data/qa-settings.json');
    expect(c.settingsToken).toBe('qa-token');
  });

  it('空环境使用内置默认值；非法数值/布尔/JSON 安全回退', () => {
    const defaults = loadConfig({});
    expect(defaults.port).toBe(8787);
    expect(defaults.databaseUrl).toBe('./data/memory.db');
    expect(defaults.mockUpstream).toBe(true);
    expect(defaults.apiKeys).toEqual(DEFAULT_API_KEYS);
    expect(defaults.defaultIdentity).toEqual({ user_id: 'u1', agent_id: 'developer' });

    const quirky = loadConfig({
      MEMORY_ENABLED: 'yes',
      MEMORY_AUTO_EXTRACT: 'off',
      MEMORY_MAX_ITEMS: '-1',
      MEMORY_TOKEN_BUDGET: 'not-a-number',
      API_KEYS: '{invalid-json',
      LOG_SILENT: 'TRUE',
    });
    expect(quirky.memoryEnabled).toBe(true);
    expect(quirky.memoryAutoExtract).toBe(false);
    expect(quirky.memoryMaxItems).toBe(5);
    expect(quirky.memoryTokenBudget).toBe(800);
    expect(quirky.apiKeys).toEqual(DEFAULT_API_KEYS);
    expect(quirky.logSilent).toBe(true);
  });

  it('MULTICA_BASE_URL 为空时自动启用 Mock 上游', () => {
    const c = loadConfig({ MULTICA_BASE_URL: '', MOCK_UPSTREAM: 'false' });
    expect(c.mockUpstream).toBe(true);
    expect(c.upstreamBaseUrl).toBe('http://mock-upstream.local');
  });

  it('completionsUrl 正确处理根地址 /v1 / 完整路径与多余斜杠', () => {
    expect(completionsUrl('https://x.example.com')).toBe('https://x.example.com/v1/chat/completions');
    expect(completionsUrl('https://x.example.com/v1')).toBe('https://x.example.com/v1/chat/completions');
    expect(completionsUrl('https://x.example.com/v1/chat/completions')).toBe('https://x.example.com/v1/chat/completions');
    expect(completionsUrl('https://x.example.com///')).toBe('https://x.example.com/v1/chat/completions');
  });

  it('.env.example 与 src/config.ts 的变量一一对应（防止文档漂移）', () => {
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const config = fs.readFileSync(path.join(ROOT, 'src/config.ts'), 'utf8');
    const exampleVars = example
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && line.includes('='))
      .map((line) => line.split('=')[0]);
    const usedVars = [...new Set([...config.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]))];
    expect(new Set(exampleVars)).toEqual(new Set(usedVars));
    expect(exampleVars).toHaveLength(18);
  });

  it('.env.personal-ai.example 与 src/personal-ai/config.ts 的变量一一对应（新增配置同样防漂移）', () => {
    const example = fs.readFileSync(path.join(ROOT, '.env.personal-ai.example'), 'utf8');
    const config = fs.readFileSync(path.join(ROOT, 'src/personal-ai/config.ts'), 'utf8');
    const exampleVars = example
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && line.includes('='))
      .map((line) => line.split('=')[0]);
    const usedVars = [...new Set([...config.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]))];
    expect(new Set(exampleVars)).toEqual(new Set(usedVars));
    expect(exampleVars).toHaveLength(20);
    // 基础层与 Personal AI 层的变量集合必须互不重叠，避免同名变量被两处各自解析。
    const baseExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const baseVars = baseExample
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && line.includes('='))
      .map((line) => line.split('=')[0]);
    expect(baseVars.filter((name) => exampleVars.includes(name))).toEqual([]);
  });
});

describe('纯函数：SSE 解析与消息注入', () => {
  it('parseSseFrame 逐 data: 行拼接 delta.content，忽略 [DONE]/注释/非法 JSON', () => {
    const frame = [
      'data: {"choices":[{"delta":{"content":"你好 "}}]}',
      ': this is a comment',
      'data: {"choices":[{"delta":{"content":"世界"}}]}',
      'data: [DONE]',
      'data: not-json',
      'data: {"choices":[{"delta":{}}]}',
    ].join('\n');
    expect(parseSseFrame(frame)).toBe('你好 世界');
    expect(parseSseFrame('data: [DONE]\n\n')).toBe('');
    expect(parseSseFrame('')).toBe('');
  });

  it('injectMemoryMessages 插到最后一个 system 之后且不修改原数组', () => {
    const messages = [
      { role: 'user', content: 'u1' },
      { role: 'system', content: 's1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 's2' },
      { role: 'user', content: 'u2' },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    const out = injectMemoryMessages(messages, 'INJECTED');
    expect(out.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'system', 'system', 'user']);
    expect(out[4].content).toBe('INJECTED');
    expect(out[3].content).toBe('s2');
    expect(messages).toEqual(snapshot);
    expect(out[0]).not.toBe(messages[0]);
  });

  it('无 system message 时注入到消息列表最前面', () => {
    const out = injectMemoryMessages([{ role: 'user', content: 'hi' }], 'INJECTED');
    expect(out).toEqual([
      { role: 'system', content: 'INJECTED' },
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('边界：预算约束、兜底身份、流式精确拼接', () => {
  it('MEMORY_MAX_ITEMS=1 且 MEMORY_TOKEN_BUDGET=1 时只注入 1 条且超长内容被截断', async () => {
    const h = await createHarness({ memoryMaxItems: 1, memoryTokenBudget: 1 });
    try {
      for (const marker of ['甲', '乙', '丙']) {
        await h.api('/v1/memories', {
          method: 'POST',
          body: { content: `QA_BUDGET_${marker} 架构设计偏好：优先简单可维护的方案`, scope: 'personal' },
        });
      }
      await h.api('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: '架构设计偏好：优先简单可维护的方案' }] },
      });
      const request = (await h.api('/__mock__/last-request')).json.request;
      const injected = request.messages
        .filter((m: { role: string }) => m.role === 'system')
        .map((m: { content: string }) => String(m.content))
        .join('\n');
      expect(injected).toContain('[Memory Context]');
      expect((injected.match(/^- \[/gm) ?? []).length).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('未提供 API Key 时使用 u1/developer 兜底身份', async () => {
    const h = await createHarness();
    try {
      const saved = await h.api('/v1/trajectories', {
        method: 'POST',
        body: { request_id: 'qa-default-identity', request: { messages: [] }, response: 'r' },
      });
      expect(saved.status).toBe(201);
      expect(saved.json.trajectory.user_id).toBe('u1');
      expect(saved.json.trajectory.agent_id).toBe('developer');
    } finally {
      await h.close();
    }
  });

  it('SSE 每帧严格解析后拼接的文本与轨迹 response 完全一致', async () => {
    const h = await createHarness();
    try {
      const result = await h.stream('/v1/chat/completions', {
        method: 'POST',
        body: { stream: true, messages: [{ role: 'user', content: '请流式回答' }] },
      });
      let assembled = '';
      let done = false;
      let dataFrames = 0;
      for (const frame of result.text.split('\n\n').filter((f) => f.trim() !== '')) {
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '') continue;
          if (data === '[DONE]') { done = true; continue; }
          dataFrames += 1;
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          assembled += parsed.choices?.[0]?.delta?.content ?? '';
        }
      }
      expect(done).toBe(true);
      expect(dataFrames).toBeGreaterThanOrEqual(4);
      expect(assembled).toBe('这是 Mock 上游 的流式逐块回复。');

      await h.waitForBackground();
      const page = await h.api('/v1/trajectories?limit=5');
      expect(page.json.items[0].response).toBe(assembled);
    } finally {
      await h.close();
    }
  });
});
