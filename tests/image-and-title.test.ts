/**
 * 生图模型（OneAPI /v1/images/generations + OpenClaw image_generate + 直接对话绘图 + /v1/images/files）
 * 与会话标题生成（/v1/personal-ai/titles + /v1/titles + 设置项校验与降级回退）完整集成测试。
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import type { UpstreamTransport } from '../src/types';

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z2lQAAAAASUVORK5CYII=';

const active: Array<{ close: () => Promise<void> }> = [];

afterEach(async (): Promise<void> => {
  while (active.length > 0) {
    await active.pop()?.close();
  }
});

function rawSse(blocks: Array<{ event?: string; data: unknown }>): Response {
  const payload = blocks
    .map(
      (b) =>
        `${b.event ? `event: ${b.event}\n` : ''}data: ${typeof b.data === 'string' ? b.data : JSON.stringify(b.data)}\n\n`,
    )
    .join('');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

async function startTestApp(options: {
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
    adminToken: 'img-title-admin',
    transport: options.transport,
    ducxCaptureFn: options.ducxCaptureFn,
    personalAIConfig: {
      ...basePersonal,
      apiKeys: {
        ...basePersonal.apiKeys,
        'openclaw-img-key': { user_id: 'developer', agent_id: 'openclaw-painter' },
      },
    },
  });
  created.upstream?.update({
    baseUrl: 'https://oneapi-comate.baidu-int.com/v1',
    authMode: 'ducx',
    ducxReport: false,
    upstreamProtocol: 'auto',
    model: 'Grok-4.7-baidu-oneapi',
    imageModel: 'gpt-image-2',
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

describe('生图能力与会话标题生成', () => {
  it('POST /v1/images/generations 与 /v1/personal-ai/images/generations 支持 DUCX 401 重试与本地图片读取，并拒绝路径穿越', async () => {
    let ducxCount = 0;
    const imageCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

    const h = await startTestApp({
      ducxCaptureFn: async (): Promise<Record<string, string>> => {
        ducxCount += 1;
        return {
          authorization: `Bearer ducx-${ducxCount}`,
          comate_custom_header: `hdr-${ducxCount}`,
        };
      },
      transport: async (url, init) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        imageCalls.push({ url, headers, body });

        if (headers.authorization === 'Bearer ducx-1') {
          return new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            created: 1730000000,
            data: [{ b64_json: PNG_1X1_BASE64, revised_prompt: 'A pixel cat wearing sunglasses' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const resp = await fetch(`${h.baseUrl}/v1/personal-ai/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev-key-developer',
      },
      body: JSON.stringify({
        model: 'gpt-image-2-baidu-oneapi',
        prompt: '画一只戴墨镜的猫',
        size: '1024x1024',
      }),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      data: Array<{ url: string; local_url: string; b64_json: string; revised_prompt: string }>;
    };
    expect(ducxCount).toBe(2);
    expect(imageCalls).toHaveLength(2);
    expect(imageCalls[1].url).toBe('https://oneapi-comate.baidu-int.com/v1/images/generations');
    expect(imageCalls[1].body.model).toBe('gpt-image-2');
    expect(imageCalls[1].headers.comate_custom_header).toBe('hdr-2');

    expect(json.data[0].b64_json).toBe(PNG_1X1_BASE64);
    expect(json.data[0].local_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/images\/files\/[a-f0-9-]+\.png$/);

    // 浏览器直接访问图片 URL 应正常返回 binary PNG
    const fileRes = await fetch(json.data[0].local_url);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-type')).toBe('image/png');
    expect(fileRes.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    expect(bytes.equals(Buffer.from(PNG_1X1_BASE64, 'base64'))).toBe(true);

    // 路径穿越 / 非法文件名返回 400
    const badFile = await fetch(`${h.baseUrl}/v1/images/files/bad..name.png`);
    expect(badFile.status).toBe(400);

    // 标准 /v1/images/generations 也可用
    const stdResp = await fetch(`${h.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'sunrise over mountains' }),
    });
    expect(stdResp.status).toBe(200);
    expect(imageCalls[2].body.model).toBe('gpt-image-2');
  });

  it('OpenClaw image_generate 工具与普通对话显式画图都能生成并返回可渲染 Markdown 图片', async () => {
    let messageTurn = 0;
    const h = await startTestApp({
      ducxCaptureFn: async (): Promise<Record<string, string>> => ({
        authorization: 'Bearer ducx-ok',
        comate_custom_header: 'hdr-ok',
      }),
      transport: async (url, init) => {
        if (url.endsWith('/v1/images/generations')) {
          return new Response(
            JSON.stringify({ created: 1, data: [{ b64_json: PNG_1X1_BASE64 }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/v1/messages')) {
          const parsed = JSON.parse(String(init.body ?? '{}')) as {
            messages: Array<{ content: unknown }>;
          };
          const serialized = JSON.stringify(parsed.messages);
          // 后台提取器请求直接忽略
          if (serialized.includes('candidate') || serialized.includes('记忆')) {
            return new Response(
              JSON.stringify({
                id: 'm_ext',
                model: 'Grok-4.7',
                content: [{ type: 'text', text: '{"memories":[]}' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          messageTurn += 1;
          if (messageTurn === 1) {
            return rawSse([
              { event: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'Grok-4.7', usage: { input_tokens: 10 } } } },
              {
                event: 'content_block_start',
                data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_img_1', name: 'image_generate' } },
              },
              {
                event: 'content_block_delta',
                data: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'input_json_delta', partial_json: '{"prompt":"赛博朋克风格的城市夜景"}' },
                },
              },
              { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } },
              { event: 'message_stop', data: { type: 'message_stop' } },
            ]);
          }
          // 提取 tool_result 中回填的图片 URL 拼进最终回复
          const match = serialized.match(/http:\/\/127\.0\.0\.1:\d+\/v1\/images\/files\/[a-f0-9-]+\.png/);
          const imgUrl = match ? match[0] : '';
          return rawSse([
            { event: 'message_start', data: { type: 'message_start', message: { id: 'm2', model: 'Grok-4.7', usage: { input_tokens: 20 } } } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            {
              event: 'content_block_delta',
              data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `画好了：\n\n![城市夜景](${imgUrl})` } },
            },
            { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } } },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]);
        }
        return new Response('{}', { status: 404 });
      },
    });

    h.created.deps.agentStore.create({
      agent_id: 'openclaw-painter',
      name: 'OpenClaw 绘图助手',
      role: '视觉生成助手',
      description: '调用安全工具画图',
      core_memory: '支持文生图',
    });
    h.created.deps.agentStore.updateAdmin('openclaw-painter', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'openclaw', allowed_tools: ['image_generate'], max_turns: 4 },
      capabilities: ['image', 'openclaw'],
    });

    // 1) OpenClaw Agent Tool Calling 绘图
    const openClawRes = await fetch(`${h.baseUrl}/v1/personal-ai/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer openclaw-img-key',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '帮我生成一张赛博朋克城市夜景图' }],
        stream: false,
      }),
    });
    expect(openClawRes.status).toBe(200);
    const openClawJson = (await openClawRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(openClawJson.choices[0].message.content).toMatch(
      /!\[.*\]\(http:\/\/127\.0\.0\.1:\d+\/v1\/images\/files\/[a-f0-9-]+\.png\)/,
    );

    // 2) 普通 ADP 对话入口（dev-key-developer）显式说“画一张...”或选用生图模型时也能直接出图
    const directDrawRes = await fetch(`${h.baseUrl}/v1/personal-ai/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev-key-developer',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '请帮我画一张蓝色鲸鱼插画图片' }],
        stream: false,
      }),
    });
    expect(directDrawRes.status).toBe(200);
    const directDrawJson = (await directDrawRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(directDrawJson.choices[0].message.content).toMatch(
      /!\[.*\]\(http:\/\/127\.0\.0\.1:\d+\/v1\/images\/files\/[a-f0-9-]+\.png\)/,
    );
    await h.created.waitForBackground();
  });

  it('会话标题生成支持配置 titleModel、清洗标点引号，并在上游异常时平滑回退截断', async () => {
    let failMode = false;
    const capturedModels: string[] = [];

    const h = await startTestApp({
      ducxCaptureFn: async (): Promise<Record<string, string>> => ({
        authorization: 'Bearer ducx-ok',
        comate_custom_header: 'hdr-ok',
      }),
      transport: async (url, init) => {
        if (url.endsWith('/v1/messages')) {
          const parsed = JSON.parse(String(init.body ?? '{}')) as { model: string };
          capturedModels.push(parsed.model);
          if (failMode) {
            return new Response('upstream unavailable', { status: 502 });
          }
          return new Response(
            JSON.stringify({
              id: 'msg_title_1',
              model: parsed.model,
              content: [{ type: 'text', text: '《PostgreSQL 端口故障排查》。' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 12, output_tokens: 6 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 404 });
      },
    });

    // 通过设置接口保存 titleModel 和 imageModel
    const saveRes = await fetch(`${h.baseUrl}/v1/zhiyi/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer img-title-admin',
      },
      body: JSON.stringify({
        titleModel: 'Claude Haiku 5.5',
        imageModel: 'gpt-image-2',
      }),
    });
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as { titleModel: string; imageModel: string };
    expect(saved.titleModel).toBe('Claude Haiku 5.5');
    expect(saved.imageModel).toBe('gpt-image-2');

    // 正常提炼标题：清理书名号与句号
    const titleRes = await fetch(`${h.baseUrl}/v1/personal-ai/titles`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev-key-developer',
      },
      body: JSON.stringify({
        prompt: '我的本地 PostgreSQL 为什么一直连不上，帮我看一下 5433 端口监听',
        assistant_reply: '已为你检查 5433 端口监听配置。',
        max_length: 20,
      }),
    });
    expect(titleRes.status).toBe(200);
    const titleJson = (await titleRes.json()) as { title: string; model: string; fallback: boolean };
    expect(titleJson).toEqual({
      title: 'PostgreSQL 端口故障排查',
      model: 'Claude Haiku 5.5',
      fallback: false,
    });
    expect(capturedModels).toEqual(['Claude Haiku 5.5']);

    // 上游异常时 /v1/titles 与 /v1/personal-ai/titles 平滑回退规则截断
    failMode = true;
    const fallbackRes = await fetch(`${h.baseUrl}/v1/titles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '这是一个超过二十个字的长问题用来测试自动回退规则截断逻辑是否正确',
        max_length: 12,
      }),
    });
    expect(fallbackRes.status).toBe(200);
    const fallbackJson = (await fallbackRes.json()) as { title: string; fallback: boolean };
    expect(fallbackJson.fallback).toBe(true);
    expect(fallbackJson.title).toBe('这是一个超过二十个字的长...');
  });
});
