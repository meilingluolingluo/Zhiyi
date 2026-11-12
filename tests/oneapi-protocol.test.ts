/**
 * OneAPI 直连（方案 A）协议路由、出站/入站双向转换与全链路集成测试：
 * 覆盖：
 * 1. resolveOneApiRoute 路由决策与 `-baidu-oneapi` 后缀剥离 / 8787 代理透传边界
 * 2. Anthropic Messages（/v1/messages）出站转换与流式/非流式 Tool Calling 还原（含 DUCX 401 重试）
 * 3. OpenAI Responses（/v1/responses）出站转换、流式 SSE 与 non-stream 聚合响应
 * 4. 端到端集成：/v1/personal-ai/chat/completions（OpenClaw 多轮 Tool Calling 对接 Anthropic & Responses）、
 *    /v1/zhiyi/settings（upstreamProtocol 校验/持久化 + POST /v1/zhiyi/test）、
 *    透明代理 /v1/chat/completions 与异步记忆提取 ExtractionQueue
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import {
  buildUpstreamRequestForRoute,
  resolveOneApiRoute,
  translateUpstreamResponse,
} from '../src/upstream/oneapi-protocol';
import type { UpstreamTransport } from '../src/types';

const active: Array<{ close: () => Promise<void> }> = [];

afterEach(async (): Promise<void> => {
  while (active.length > 0) {
    await active.pop()?.close();
  }
});

function rawSseResponse(blocks: Array<{ event?: string; data: unknown }>): Response {
  const payload = blocks
    .map((b) => `${b.event ? `event: ${b.event}\n` : ''}data: ${typeof b.data === 'string' ? b.data : JSON.stringify(b.data)}\n\n`)
    .join('');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

async function startOneApiTestServer(options: {
  transport: UpstreamTransport;
  ducxCaptureFn?: () => Promise<Record<string, string>>;
}) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'https://oneapi-comate.baidu-int.com/v1',
    upstreamApiKey: '',
    defaultModel: 'Grok-4.7-baidu-oneapi',
    upstreamTimeoutMs: 2500,
    logSilent: true,
  };
  const basePersonal = loadPersonalAIConfig({});
  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    settingsPath: null,
    adminToken: 'oneapi-admin-token',
    transport: options.transport,
    ducxCaptureFn: options.ducxCaptureFn,
    personalAIConfig: {
      ...basePersonal,
      apiKeys: {
        ...basePersonal.apiKeys,
        'openclaw-key-oneapi': { user_id: 'developer', agent_id: 'openclaw-oneapi' },
      },
    },
  });
  // 将运行期默认设定切至百度的 Baidu OneAPI + DUCX（无真实子进程，走注入 ducxCaptureFn）
  created.upstream?.update({
    baseUrl: 'https://oneapi-comate.baidu-int.com/v1',
    authMode: 'ducx',
    ducxReport: false,
    upstreamProtocol: 'auto',
    model: 'Grok-4.7-baidu-oneapi',
    modelOverride: 'request',
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
  active.push(handle);
  return handle;
}

describe('OneAPI 直连（方案 A）协议路由与转换', () => {
  it('resolveOneApiRoute：Baidu OneAPI 按模型路由且剥离 -baidu-oneapi，本地 8787 原样透传', () => {
    const grok = resolveOneApiRoute('https://oneapi-comate.baidu-int.com/v1', 'Grok-4.7-baidu-oneapi');
    expect(grok.isBaiduOneApi).toBe(true);
    expect(grok.protocol).toBe('anthropic_messages');
    expect(grok.url).toBe('https://oneapi-comate.baidu-int.com/v1/messages');
    expect(grok.upstreamModel).toBe('Grok-4.7');

    const claude = resolveOneApiRoute('https://oneapi-comate.baidu-int.com/v1', 'Claude Sonnet 5.5');
    expect(claude.protocol).toBe('anthropic_messages');
    expect(claude.url).toBe('https://oneapi-comate.baidu-int.com/v1/messages');
    expect(claude.upstreamModel).toBe('Claude Sonnet 5.5');

    const gpt = resolveOneApiRoute('https://oneapi-comate.baidu-int.com/v1', 'gpt-5.6-sol-baidu-oneapi');
    expect(gpt.protocol).toBe('openai_responses');
    expect(gpt.url).toBe('https://oneapi-comate.baidu-int.com/v1/responses');
    expect(gpt.upstreamModel).toBe('gpt-5.6-sol');

    // 本机 8787 codex-mixin 代理：保留 chat/completions 且保留完整展示后缀
    const localProxy = resolveOneApiRoute('http://127.0.0.1:8787/v1', 'Grok-4.7-baidu-oneapi');
    expect(localProxy.isBaiduOneApi).toBe(false);
    expect(localProxy.protocol).toBe('openai_chat');
    expect(localProxy.url).toBe('http://127.0.0.1:8787/v1/chat/completions');
    expect(localProxy.upstreamModel).toBe('Grok-4.7-baidu-oneapi');

    // 显式 protocolOverride 生效
    const forced = resolveOneApiRoute(
      'https://custom-gateway.example.com/v1',
      'DeepSeek-V3-baidu-oneapi',
      'anthropic_messages',
    );
    expect(forced.protocol).toBe('anthropic_messages');
    expect(forced.url).toBe('https://custom-gateway.example.com/v1/messages');
    expect(forced.upstreamModel).toBe('DeepSeek-V3');
  });

  it('Anthropic Messages 出站请求与非流式 JSON / 流式 SSE（含 Tool Calling）双向转换', async () => {
    const route = resolveOneApiRoute('https://oneapi-comate.baidu-int.com/v1', 'Grok-4.7-baidu-oneapi');
    const built = buildUpstreamRequestForRoute(
      route,
      {
        model: 'Grok-4.7-baidu-oneapi',
        stream: true,
        messages: [
          { role: 'system', content: '系统指令A' },
          { role: 'developer', content: '开发者指令B' },
          { role: 'user', content: '查天气' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":22}' },
          { role: 'tool', tool_call_id: 'call_2', content: '{"wind":"3"}' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '查询城市天气',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          },
        ],
        tool_choice: 'auto',
      },
      { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    );

    expect(built.url).toBe('https://oneapi-comate.baidu-int.com/v1/messages');
    expect(built.headers['anthropic-version']).toBe('2023-06-01');
    const sent = JSON.parse(built.body) as Record<string, unknown>;
    expect(sent.model).toBe('Grok-4.7');
    expect(sent.system).toBe('系统指令A\n\n开发者指令B');
    const sentMsgs = sent.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // 连续两条 tool 结果被合并进同属 user 角色的消息块
    expect(sentMsgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sentMsgs[1].content[0]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'get_weather',
      input: { city: 'Beijing' },
    });
    expect(sentMsgs[2].content).toHaveLength(2);
    expect(sentMsgs[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: '{"temp":22}',
    });

    // 非流式 Anthropic JSON -> OpenAI Chat Completion JSON
    const jsonResp = await translateUpstreamResponse(
      'anthropic_messages',
      new Response(
        JSON.stringify({
          id: 'msg_123',
          model: 'Grok-4.7',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: '正在查询' },
            { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: { city: 'Shanghai' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      { requestedModel: 'Grok-4.7', wantsStream: false },
    );
    const jsonData = (await jsonResp.json()) as {
      object: string;
      choices: Array<{
        finish_reason: string;
        message: { content: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(jsonData.object).toBe('chat.completion');
    expect(jsonData.choices[0].finish_reason).toBe('tool_calls');
    expect(jsonData.choices[0].message.content).toBe('正在查询');
    expect(jsonData.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
    expect(JSON.parse(jsonData.choices[0].message.tool_calls![0].function.arguments)).toEqual({
      city: 'Shanghai',
    });
    expect(jsonData.usage.total_tokens).toBe(15);

    // 流式 Anthropic SSE -> OpenAI Chat Completions SSE
    const sseUpstream = rawSseResponse([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { id: 'msg_sse_1', model: 'Grok-4.7', usage: { input_tokens: 8 } } },
      },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '北京' } } },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'get_weather' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ci' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ty":"BJ"}' } },
      },
      {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const translatedSse = await translateUpstreamResponse('anthropic_messages', sseUpstream, {
      requestedModel: 'Grok-4.7',
      wantsStream: true,
    });
    const sseText = await translatedSse.text();
    expect(sseText).toContain('"content":"北京"');
    expect(sseText).toContain('"name":"get_weather"');
    expect(sseText).toContain('"arguments":"{\\"ci"');
    expect(sseText).toContain('"finish_reason":"tool_calls"');
    expect(sseText).toContain('data: [DONE]');
  });

  it('OpenAI Responses 出站请求（强制 stream:true）与流式/非流式聚合还原', async () => {
    const route = resolveOneApiRoute('https://oneapi-comate.baidu-int.com/v1', 'gpt-5.6-sol-baidu-oneapi');
    const built = buildUpstreamRequestForRoute(
      route,
      {
        model: 'gpt-5.6-sol-baidu-oneapi',
        stream: false,
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '我查一下',
            tool_calls: [{ id: 'call_r1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_r1', content: 'ok' },
        ],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      },
      { 'content-type': 'application/json' },
    );
    expect(built.url).toBe('https://oneapi-comate.baidu-int.com/v1/responses');
    const payload = JSON.parse(built.body) as Record<string, unknown>;
    expect(payload.model).toBe('gpt-5.6-sol');
    expect(payload.stream).toBe(true);
    expect(payload.store).toBe(false);
    expect(payload.instructions).toBe('你是助手');
    const input = payload.input as Array<Record<string, unknown>>;
    expect(input.map((i) => i.type)).toEqual(['message', 'message', 'function_call', 'function_call_output']);

    // non-stream 聚合：Responses SSE 转为标准 OpenAI chat.completion JSON
    const sseBody = rawSseResponse([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-sol' } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Hello ' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'OneAPI!' } },
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'function_call', call_id: 'call_resp_1', name: 'lookup' },
        },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"q":"done"}' },
      },
      {
        event: 'response.completed',
        data: { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } },
      },
    ]);
    const aggregatedResp = await translateUpstreamResponse('openai_responses', sseBody, {
      requestedModel: 'gpt-5.6-sol',
      wantsStream: false,
    });
    const aggregatedJson = (await aggregatedResp.json()) as {
      choices: Array<{
        finish_reason: string;
        message: { content: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
      usage: { total_tokens: number };
    };
    expect(aggregatedJson.choices[0].message.content).toBe('Hello OneAPI!');
    expect(aggregatedJson.choices[0].message.tool_calls?.[0]).toEqual({
      id: 'call_resp_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"done"}' },
    });
    expect(aggregatedJson.choices[0].finish_reason).toBe('tool_calls');
    expect(aggregatedJson.usage.total_tokens).toBe(10);
  });
});

describe('OneAPI 直连端到端全链路集成（OpenClaw / Proxy / Settings / Extractor）', () => {
  it('Personal AI OpenClaw Agent Loop 直连 Baidu OneAPI Anthropic（含 DUCX 401 刷新重试与两轮 Tool Calling）', async () => {
    let ducxCaptureCount = 0;
    const seenRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    let messagesTurn = 0;

    const h = await startOneApiTestServer({
      ducxCaptureFn: async (): Promise<Record<string, string>> => {
        ducxCaptureCount += 1;
        return {
          authorization: `Bearer ducx-tok-${ducxCaptureCount}`,
          comate_custom_header: `custom-hdr-${ducxCaptureCount}`,
        };
      },
      transport: async (url: string, init: RequestInit): Promise<Response> => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        seenRequests.push({ url, headers, body });

        if (url.endsWith('/v1/messages')) {
          // 首次认证故意返回 401，验证 UpstreamService.sendChat 失效 DUCX 缓存并自动重抓凭证重试
          if (headers.authorization === 'Bearer ducx-tok-1') {
            return new Response(JSON.stringify({ error: { message: 'token expired' } }), { status: 401 });
          }
          messagesTurn += 1;
          if (messagesTurn === 1) {
            return rawSseResponse([
              { event: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'Grok-4.7', usage: { input_tokens: 15 } } } },
              {
                event: 'content_block_start',
                data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mem_1', name: 'memory_search' } },
              },
              {
                event: 'content_block_delta',
                data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"PostgreSQL","limit":3}' } },
              },
              { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } } },
              { event: 'message_stop', data: { type: 'message_stop' } },
            ]);
          }
          return rawSseResponse([
            { event: 'message_start', data: { type: 'message_start', message: { id: 'm2', model: 'Grok-4.7', usage: { input_tokens: 25 } } } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OneAPI记忆结果=5433' } } },
            { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } } },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]);
        }

        // Extractor 会复用同一条 sendChat 链路
        if (url.endsWith('/v1/responses') || url.endsWith('/v1/chat/completions')) {
          return rawSseResponse([
            { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '{"memories":[]}' } },
            { event: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } } },
          ]);
        }
        return new Response('{}', { status: 404 });
      },
    });

    h.created.deps.memoryStore.create({
      user_id: 'developer',
      content: '本地开发 PostgreSQL 固定运行在 5433 端口',
      type: 'semantic',
      scope: 'personal',
    });
    h.created.deps.agentStore.create({
      agent_id: 'openclaw-oneapi',
      name: 'OpenClaw OneAPI',
      role: '通用工具 Agent',
      description: 'OpenClaw + OneAPI 端到端集成',
      core_memory: '记忆检索',
    });
    h.created.deps.agentStore.updateAdmin('openclaw-oneapi', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'openclaw', allowed_tools: ['memory_search'], max_turns: 4 },
      instructions: '优先调用知忆工具获取事实。',
      capabilities: ['memory', 'openclaw'],
    });

    const resp = await fetch(`${h.baseUrl}/v1/personal-ai/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer openclaw-key-oneapi',
      },
      body: JSON.stringify({
        model: 'Grok-4.7-baidu-oneapi',
        messages: [{ role: 'user', content: '查一下本地 PostgreSQL 端口配置' }],
        stream: false,
      }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0].message.content).toContain('正在调用工具 memory_search');
    expect(body.choices[0].message.content).toContain('OneAPI记忆结果=5433');
    expect(ducxCaptureCount).toBe(2);

    const msgCalls = seenRequests.filter((r) => r.url === 'https://oneapi-comate.baidu-int.com/v1/messages');
    // 1 次 401 失效 + 第 1 轮 tool_use + 第 2 轮最终总结
    expect(msgCalls.length).toBeGreaterThanOrEqual(3);
    expect(msgCalls[0].headers.comate_custom_header).toBe('custom-hdr-1');
    expect(msgCalls[1].headers.comate_custom_header).toBe('custom-hdr-2');
    expect(msgCalls[1].headers['anthropic-version']).toBe('2023-06-01');
    expect(msgCalls[1].body.model).toBe('Grok-4.7');

    // 验证第二轮回填了包含 5433 的 tool_result
    const secondTurnMessages = msgCalls[2].body.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(secondTurnMessages)).toContain('5433');
  });

  it('设置接口校验 upstreamProtocol 并支持 /v1/chat/completions 与 /v1/zhiyi/settings/test 路由至 Responses', async () => {
    const seenChatUrls: string[] = [];
    const seenChatModels: string[] = [];
    const h = await startOneApiTestServer({
      ducxCaptureFn: async (): Promise<Record<string, string>> => ({
        authorization: 'Bearer ducx-ok',
        comate_custom_header: 'hdr-ok',
      }),
      transport: async (url: string, init: RequestInit): Promise<Response> => {
        if (url.endsWith('/v1/models') || url.includes('/openapi/v2/available_models')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'gpt-5.6-sol-baidu-oneapi' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        seenChatUrls.push(url);
        const parsed = init.body ? (JSON.parse(String(init.body)) as { model?: string; stream?: boolean }) : {};
        if (parsed.model) seenChatModels.push(parsed.model);
        if (url.endsWith('/v1/responses')) {
          expect(parsed.stream).toBe(true);
          return rawSseResponse([
            { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_gpt', model: parsed.model } } },
            { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'PONG-GPT' } },
            { event: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } } },
          ]);
        }
        return new Response(
          JSON.stringify({
            id: 'msg_extract',
            model: parsed.model,
            content: [{ type: 'text', text: '{"memories":[]}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const badProtocol = await fetch(`${h.baseUrl}/v1/zhiyi/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer oneapi-admin-token',
      },
      body: JSON.stringify({ upstreamProtocol: 'invalid_proto' }),
    });
    expect(badProtocol.status).toBe(400);

    const saved = await fetch(`${h.baseUrl}/v1/zhiyi/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer oneapi-admin-token',
      },
      body: JSON.stringify({
        upstreamProtocol: 'auto',
        model: 'gpt-5.6-sol-baidu-oneapi',
        modelOverride: 'settings',
      }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).upstreamProtocol).toBe('auto');

    // 设置页连通性测试（chat: true）自动命中 /v1/responses
    const connTest = await fetch(`${h.baseUrl}/v1/zhiyi/settings/test`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer oneapi-admin-token',
      },
      body: JSON.stringify({ chat: true }),
    });
    expect(connTest.status).toBe(200);
    const connJson = (await connTest.json()) as { ok: boolean; chat: string | null; latencyMs: number };
    expect(connJson.ok).toBe(true);
    expect(connJson.chat).toBe('PONG-GPT');

    // 透明 OpenAI /v1/chat/completions 代理也自动通过 sendChat 走 /v1/responses 并聚合返回
    const proxyResp = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev-key-developer',
      },
      body: JSON.stringify({
        model: 'gpt-5.6-sol-baidu-oneapi',
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      }),
    });
    expect(proxyResp.status).toBe(200);
    const proxyJson = (await proxyResp.json()) as { choices: Array<{ message: { content: string } }> };
    expect(proxyJson.choices[0].message.content).toBe('PONG-GPT');
    await h.created.waitForBackground();

    expect(seenChatUrls.length).toBeGreaterThanOrEqual(2);
    expect(seenChatUrls.every((u) => u === 'https://oneapi-comate.baidu-int.com/v1/responses')).toBe(true);
    expect(seenChatModels.every((m) => m === 'gpt-5.6-sol')).toBe(true);
  });
});
