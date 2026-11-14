/**
 * 网页搜索（Search）与网页抓取（Fetch）服务及端点集成测试。
 * 验证参数校验、DeepSeek Tools 协议兼容性、错误格式与 OpenClaw 工具链闭环。
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import type { UpstreamTransport } from '../src/types';
import {
  validateFetchParams,
  validateSearchParams,
  WebToolError,
} from '../src/upstream/web-search';

const activeApps: Array<{ close: () => Promise<void> }> = [];

afterEach(async (): Promise<void> => {
  while (activeApps.length > 0) {
    await activeApps.pop()?.close();
  }
});

async function startSearchTestServer(options: {
  transport?: UpstreamTransport;
  mockUpstream?: boolean;
  upstreamApiKey?: string;
}) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: options.mockUpstream ?? true,
    upstreamBaseUrl: 'https://api.deepseek.com/v1',
    upstreamApiKey: options.upstreamApiKey ?? '',
    defaultModel: 'deepseek-chat',
    logSilent: true,
  };
  const basePersonal = loadPersonalAIConfig({});
  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    settingsPath: null,
    adminToken: 'test-admin-token',
    transport: options.transport,
    personalAIConfig: {
      ...basePersonal,
    },
  });

  const server = http.createServer(created.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const handle = {
    baseUrl,
    created,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await created.close();
    },
  };
  activeApps.push(handle);
  return handle;
}

describe('网页搜索与抓取参数校验', () => {
  describe('validateSearchParams', () => {
    it('正确解析合法搜索参数并应用默认值', () => {
      const res = validateSearchParams({ query: 'DeepSeek V4 模型 发布' });
      expect(res.query).toBe('DeepSeek V4 模型 发布');
      expect(res.count).toBe(10);
      expect(res.need_content).toBe(false);
      expect(res.ori_question).toBeNull();
      expect(res.localization).toBe('');
    });

    it('支持自定义 count、ori_question、localization 与 need_content', () => {
      const res = validateSearchParams({
        query: 'DeepSeek site:github.com',
        count: 5,
        ori_question: '原始提问',
        localization: '1.1.1.1',
        need_content: true,
      });
      expect(res.query).toBe('DeepSeek site:github.com');
      expect(res.count).toBe(5);
      expect(res.ori_question).toBe('原始提问');
      expect(res.localization).toBe('1.1.1.1');
      expect(res.need_content).toBe(true);
    });

    it('拒绝缺失或全空白 query', () => {
      expect(() => validateSearchParams({})).toThrowError(WebToolError);
      expect(() => validateSearchParams({ query: '   ' })).toThrowError(
        "'query' 字段必须为 1~128 字符且非空",
      );
    });

    it('拒绝超过 128 字符的 query', () => {
      const longQuery = 'a'.repeat(129);
      expect(() => validateSearchParams({ query: longQuery })).toThrowError(
        "'query' 字段长度不能超过 128 个字符",
      );
    });

    it('拒绝非法 count 数值（< 1 或 > 50 或非整数）', () => {
      expect(() => validateSearchParams({ query: 'test', count: 0 })).toThrowError(
        "'count' must be between 1 and 50",
      );
      expect(() => validateSearchParams({ query: 'test', count: 51 })).toThrowError(
        "'count' must be between 1 and 50",
      );
      expect(() => validateSearchParams({ query: 'test', count: 2.5 })).toThrowError(
        "'count' must be between 1 and 50",
      );
    });
  });

  describe('validateFetchParams', () => {
    it('正确解析合法的 HTTP/HTTPS 链接', () => {
      const res = validateFetchParams({ url: 'https://example.com/article' });
      expect(res.url).toBe('https://example.com/article');
    });

    it('拒绝非法协议或缺失 URL', () => {
      expect(() => validateFetchParams({})).toThrowError(WebToolError);
      expect(() => validateFetchParams({ url: 'ftp://example.com' })).toThrowError(
        "'url' 格式非法，必须为包含 host 的有效 HTTP/HTTPS 地址",
      );
      expect(() => validateFetchParams({ url: 'not-a-valid-url' })).toThrowError(
        "'url' 格式非法，必须为包含 host 的有效 HTTP/HTTPS 地址",
      );
    });

    it('拒绝携带用户名或密码的 URL', () => {
      expect(() =>
        validateFetchParams({ url: 'https://user:pass@example.com/article' }),
      ).toThrowError('url 不能携带用户名或密码');
    });

    it('拒绝超过 8192 字符的 URL', () => {
      const longUrl = `https://example.com/${'a'.repeat(8200)}`;
      expect(() => validateFetchParams({ url: longUrl })).toThrowError(
        "'url' 长度不能超过 8192 字符",
      );
    });
  });
});

describe('DeepSeek 兼容 Tools HTTP 接口', () => {
  it('POST /v1/tools/search 与 /tools/search 返回结构化搜索结果', async () => {
    const s = await startSearchTestServer({ mockUpstream: true });

    // 测试 /v1/tools/search
    const res1 = await fetch(`${s.baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
      },
      body: JSON.stringify({ query: 'DeepSeek V4 模型 发布', count: 3, need_content: true }),
    });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { results: Array<Record<string, unknown>> };
    expect(Array.isArray(json1.results)).toBe(true);
    expect(json1.results.length).toBe(3);
    const first = json1.results[0];
    expect(first.title).toContain('DeepSeek V4');
    expect(first.url).toBeTruthy();
    expect(first.summary).toBeTruthy();
    expect(first.content).toContain('DeepSeek V4');
    expect(typeof first.rerank_score).toBe('number');
    expect(typeof first.authority).toBe('number');

    // 测试 /tools/search 别名路径
    const res2 = await fetch(`${s.baseUrl}/tools/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
      },
      body: JSON.stringify({ query: '测试短路径', count: 2 }),
    });
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as { results: Array<Record<string, unknown>> };
    expect(json2.results.length).toBe(2);
  });

  it('POST /v1/tools/fetch 与 /tools/fetch 返回抓取的 Markdown 正文', async () => {
    const s = await startSearchTestServer({ mockUpstream: true });

    // 测试 /v1/tools/fetch
    const res1 = await fetch(`${s.baseUrl}/v1/tools/fetch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
      },
      body: JSON.stringify({ url: 'https://example.com/deepseek-article' }),
    });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { title: string; content: string };
    expect(typeof json1.title).toBe('string');
    expect(json1.content).toContain('https://example.com/deepseek-article');

    // 测试 /tools/fetch 别名路径
    const res2 = await fetch(`${s.baseUrl}/tools/fetch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
      },
      body: JSON.stringify({ url: 'https://example.com/another-page' }),
    });
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as { title: string; content: string };
    expect(json2.content).toContain('https://example.com/another-page');
  });

  it('参数非法时返回标准 OpenAI 格式的 400 错误体', async () => {
    const s = await startSearchTestServer({ mockUpstream: true });

    // 搜索参数校验失败
    const resSearch = await fetch(`${s.baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'test', count: 99 }),
    });
    expect(resSearch.status).toBe(400);
    const errSearch = (await resSearch.json()) as { error: { message: string; type: string; param: null; code: string } };
    expect(errSearch.error.message).toBe("'count' must be between 1 and 50");
    expect(errSearch.error.type).toBe('invalid_request_error');
    expect(errSearch.error.param).toBeNull();

    // 抓取参数校验失败
    const resFetch = await fetch(`${s.baseUrl}/v1/tools/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://bad-url' }),
    });
    expect(resFetch.status).toBe(400);
    const errFetch = (await resFetch.json()) as { error: { message: string; type: string; param: null; code: string } };
    expect(errFetch.error.type).toBe('invalid_request_error');
    expect(errFetch.error.param).toBeNull();
  });

  it('非 mockUpstream 模式下缺少 API Key 时返回 401 鉴权失败', async () => {
    const s = await startSearchTestServer({
      mockUpstream: false,
      upstreamApiKey: '',
    });

    const res = await fetch(`${s.baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { message: string; type: string; param: null } };
    expect(json.error.message).toContain('API Key');
    expect(json.error.type).toBe('invalid_request_error');
    expect(json.error.param).toBeNull();
  });

  it('非 mockUpstream 模式下携带 Authorization Bearer 能够透传给上游', async () => {
    let capturedAuth = '';
    let capturedBody: Record<string, unknown> = {};

    const s = await startSearchTestServer({
      mockUpstream: false,
      upstreamApiKey: '',
      transport: async (url, init) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        capturedAuth = headers.authorization ?? '';
        capturedBody = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            results: [
              {
                rerank_score: 2.9,
                title: '上游透传成功',
                url: 'https://example.com/ok',
                snippet: '测试摘要',
                summary: '测试长摘要',
                content: '',
                site_name: 'Test',
                site_icon: null,
                date: null,
                authority: 3,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const res = await fetch(`${s.baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-remote-upstream-key',
      },
      body: JSON.stringify({ query: '透传关键词', count: 5 }),
    });
    expect(res.status).toBe(200);
    expect(capturedAuth).toBe('Bearer sk-remote-upstream-key');
    expect(capturedBody.query).toBe('透传关键词');
  });

  it('OpenClaw Tool Gateway 支持 web_search 与 web_fetch 工具调用', async () => {
    const s = await startSearchTestServer({ mockUpstream: true });
    const personalAI = s.created.personalAI;
    s.created.deps.agentStore.create({
      agent_id: 'test_openclaw_agent',
      name: 'OpenClaw Agent',
    });
    const agent = s.created.deps.agentStore.updateAdmin('test_openclaw_agent', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'openclaw' },
    })!;
    const dummyTask = personalAI.businessTaskManager.create('test_user', { title: '测试任务' });
    const dummyExec = { id: 'exec_1' };

    const ctx = {
      userId: 'test_user',
      agent,
      task: dummyTask,
      execution: dummyExec as never,
      identity: {
        user_id: 'test_user',
        agent_id: agent.agent_id,
        project_id: null,
        api_key: 'test',
        from_default: false,
        request_id: 'req_1',
        session_id: 'sess_1',
        task_id: null,
      },
      allowedTools: new Set(personalAI.toolGateway.listRegisteredTools().map((t) => t.name)),
    };

    // 执行 web_search 工具
    const searchRes = await personalAI.toolGateway.executeTool(ctx, 'web_search', {
      query: 'TypeScript 5.8 新特性',
      count: 2,
    });
    expect(searchRes.text).toContain('TypeScript 5.8 新特性');
    expect(searchRes.details).toBeTruthy();

    // 执行 web_fetch 工具
    const fetchRes = await personalAI.toolGateway.executeTool(ctx, 'web_fetch', {
      url: 'https://devblogs.microsoft.com/typescript',
    });
    expect(fetchRes.text).toContain('网页正文');
    expect(fetchRes.details).toBeTruthy();
  });
});
