/** 运行期模型服务设置：自填 API / 自选模型 / DUCX 认证的单元与 HTTP 集成测试。 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { ModelAdapter } from '../src/personal-ai/adapters/model/model-adapter';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import { DucxAuth } from '../src/upstream/ducx-auth';
import { DucxReporter } from '../src/upstream/ducx-report';
import {
  SettingsStore,
  endpointUrl,
  maskApiKey,
  modelsUrl,
  normalizeBaseUrl,
  toPublicSettings,
  validateSettingsPatch,
} from '../src/upstream/model-settings';
import {
  UpstreamService,
  initialSettings,
  markVariants,
  mergeModelLists,
  normalizeModels,
} from '../src/upstream/service';
import type { UpstreamTransport } from '../src/types';

const tempFiles: string[] = [];

afterEach((): void => {
  for (const file of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 忽略清理失败
    }
  }
});

function tempSettingsPath(): string {
  const dir: string = path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file: string = path.join(dir, `test-settings-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  tempFiles.push(file);
  return file;
}

function baseConfig(): AppConfig {
  return {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://env-upstream.invalid/v1',
    upstreamApiKey: 'env-secret-key',
    defaultModel: 'env-model',
    upstreamTimeoutMs: 3000,
    logSilent: true,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks: string[]): Response {
  const body: string =
    chunks
      .map((chunk): string => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Call {
  url: string;
  init: RequestInit;
}

function recordingTransport(handler: (call: Call) => Response): {
  transport: UpstreamTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    transport: async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return handler({ url, init });
    },
  };
}

function makeService(
  options: {
    config?: AppConfig;
    transport?: UpstreamTransport;
    active?: boolean;
    captureFn?: () => Promise<Record<string, string>>;
    reportCaptureFn?: () => Promise<string>;
    reportFetchImpl?: typeof fetch;
    filePath?: string | null;
  } = {},
): { service: UpstreamService; config: AppConfig; store: SettingsStore } {
  const config: AppConfig = options.config ?? baseConfig();
  const initial = initialSettings(config, options.active ?? false);
  const store = new SettingsStore(options.filePath ?? null, initial);
  const service = new UpstreamService({
    store,
    initial,
    config,
    transport: options.transport ?? (async (): Promise<Response> => jsonResponse({ data: [] })),
    logger: createLogger(true),
    ducxCaptureFn: options.captureFn,
    reportCaptureFn: options.reportCaptureFn,
    reportFetchImpl: options.reportFetchImpl,
  });
  return { service, config, store };
}

describe('纯函数：URL 规整、校验与脱敏', () => {
  it('normalizeBaseUrl 去掉尾斜杠与误填的 chat/completions', () => {
    expect(normalizeBaseUrl(' http://127.0.0.1:8787/v1/ ')).toBe('http://127.0.0.1:8787/v1');
    expect(normalizeBaseUrl('https://oneapi.example.com/v1/chat/completions')).toBe(
      'https://oneapi.example.com/v1',
    );
  });

  it('endpointUrl / modelsUrl 正确处理 /v1 与 /openapi 两类路径', () => {
    expect(modelsUrl('http://127.0.0.1:8787/v1', '/models')).toBe('http://127.0.0.1:8787/v1/models');
    expect(modelsUrl('https://oneapi.example.com', '/models')).toBe(
      'https://oneapi.example.com/v1/models',
    );
    expect(endpointUrl('https://oneapi.example.com/v1', '/openapi/v2/available_models')).toBe(
      'https://oneapi.example.com/openapi/v2/available_models',
    );
    expect(endpointUrl('http://a.invalid/v1', 'https://b.invalid/models')).toBe(
      'https://b.invalid/models',
    );
  });

  it('validateSettingsPatch 拒绝非法 URL、协议与认证方式', () => {
    expect(validateSettingsPatch({ baseUrl: 'ftp://x.invalid' })).not.toHaveLength(0);
    expect(validateSettingsPatch({ baseUrl: 'not-a-url' })).not.toHaveLength(0);
    expect(validateSettingsPatch({ authMode: 'oauth' as never })).not.toHaveLength(0);
    expect(validateSettingsPatch({ modelOverride: 'random' as never })).not.toHaveLength(0);
    expect(validateSettingsPatch({ modelsSource: 'all' as never })).not.toHaveLength(0);
    expect(validateSettingsPatch({ modelsPath: 'models' })).not.toHaveLength(0);
    expect(
      validateSettingsPatch({ baseUrl: 'https://oneapi.example.com/v1', authMode: 'ducx' }),
    ).toHaveLength(0);
  });

  it('API Key 只以掩码形式出现在公开视图', () => {
    expect(maskApiKey('sk-abcdefghijk')).not.toContain('abcdefghijk');
    const publicView = toPublicSettings(initialSettings(baseConfig(), true));
    expect(JSON.stringify(publicView)).not.toContain('env-secret-key');
    expect(publicView.apiKeySet).toBe(true);
    expect(publicView.apiKeyMasked).toContain('****');
  });

  it('normalizeModels 兼容 OpenAI / 裸数组 / {models} 并去重', () => {
    expect(normalizeModels({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }).map((m) => m.id)).toEqual([
      'a',
      'b',
    ]);
    expect(normalizeModels(['x', 'y', 'x']).map((m) => m.id)).toEqual(['x', 'y']);
    expect(normalizeModels({ models: [{ id: 'm', display_name: 'M 模型' }] })[0]).toMatchObject({
      id: 'm',
      name: 'M 模型',
      sources: ['openai'],
    });
    expect(
      normalizeModels({ data: [{ id: 'm', supports_image: true, context_window: 128000 }] })[0],
    ).toMatchObject({ supportsImage: true, contextWindow: 128000 });
  });

  it('Baidu 富列表：剥离 -内部、排除无 capability、非内部优先、提取能力字段', () => {
    const payload = {
      data: [
        {
          model: 'GLM-5.3-内部',
          capability: { model_description: '内部版', context_window: 1000, supports_image: false },
        },
        {
          model: 'GLM-5.3',
          capability: {
            model_description: '正式版',
            context_window: 200000,
            supports_image: true,
            supports_thinking: true,
            ratio: '1.2x',
          },
          price_type: '高级模型',
        },
        {
          model: 'auto',
          capability: { model_description: '默认模型', supports_image: false },
          capability_set: ['image'],
        },
        { model: '无能力模型' },
      ],
    };
    const models = normalizeModels(payload, 'baidu');
    // 无 capability 的条目仍然保留（避免像 custom-auto / 自定义模型组 被误删），只做标记。
    expect(models.map((m) => m.id)).toEqual(['GLM-5.3', 'auto', '无能力模型']);
    expect(models[2].capabilityKnown).toBe(false);
    expect(models[0]).toMatchObject({
      name: '正式版',
      contextWindow: 200000,
      supportsImage: true,
      supportsThinking: true,
      ratio: '1.2x',
      priceType: '高级模型',
    });
    expect(models[1].supportsImage).toBe(true);
  });

  it('markVariants 标记渠道副本，但不误伤真实数字结尾的模型', () => {
    const marked = markVariants([
      { id: 'GLM-5.3-baidu-oneapi' },
      { id: 'GLM-5.3-baidu-oneapi-2' },
      { id: 'GLM-5.3-baidu-oneapi-3' },
      { id: 'some-model-2' },
    ]);
    expect(marked[1].variantOf).toBe('GLM-5.3-baidu-oneapi');
    expect(marked[2].variantOf).toBe('GLM-5.3-baidu-oneapi');
    // 没有基础 ID 的 some-model-2 不折叠，但标记为「仅此渠道」，避免误以为重复。
    expect(marked[3].variantOf).toBeUndefined();
    expect(marked[3].isolatedVariant).toBe(true);
  });

  it('mergeModelLists 合并来源标签，富信息覆盖同名字段', () => {
    const merged = mergeModelLists(
      [{ id: 'A', sources: ['openai'] }, { id: 'B', name: '简版', sources: ['openai'] }],
      [{ id: 'B', name: '富版', supportsImage: true, sources: ['baidu'] }, { id: 'auto', sources: ['baidu'] }],
    );
    expect(merged.map((m) => m.id)).toEqual(['A', 'B', 'auto']);
    expect(merged[1]).toMatchObject({ name: '富版', supportsImage: true });
    expect(merged[1].sources).toEqual(['openai', 'baidu']);
  });
});

describe('SettingsStore：内存与文件持久化', () => {
  it('update / reset 正确切换 active 并保留未提交的 API Key', () => {
    const config = baseConfig();
    const initial = initialSettings(config, false);
    const store = new SettingsStore(null, initial);
    const saved = store.update({ baseUrl: 'https://oneapi.example.com/v1', authMode: 'ducx' });
    expect(saved.active).toBe(true);
    expect(saved.baseUrl).toBe('https://oneapi.example.com/v1');
    expect(saved.apiKey).toBe('env-secret-key');
    expect(store.reset(initial).active).toBe(false);
  });

  it('文件持久化以 600 权限保存，重新加载后仍生效', () => {
    const config = baseConfig();
    const initial = initialSettings(config, false);
    const file = tempSettingsPath();
    const first = new SettingsStore(file, initial);
    first.update({ baseUrl: 'https://oneapi.example.com', model: 'Grok-4.6', authMode: 'ducx' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const reloaded = new SettingsStore(file, initial);
    expect(reloaded.get().model).toBe('Grok-4.6');
    expect(reloaded.get().authMode).toBe('ducx');
    expect(reloaded.get().active).toBe(true);
  });
});

describe('DUCX 认证桥', () => {
  it('缓存 60 秒、invalidate 后重新铸造，且状态不泄露 header 值', async () => {
    let calls = 0;
    const auth = new DucxAuth({
      executable: '/does/not/exist',
      logger: createLogger(true),
      captureFn: async (): Promise<Record<string, string>> => {
        calls += 1;
        return { comate_custom_header: 'SECRET-VALUE-123', authorization: 'Bearer SECRET-TOKEN' };
      },
    });
    const first = await auth.headers();
    await auth.headers();
    expect(calls).toBe(1);
    expect(first.comate_custom_header).toBe('SECRET-VALUE-123');
    const status = auth.status();
    expect(status.available).toBe(true);
    expect(JSON.stringify(status)).not.toContain('SECRET-VALUE-123');
    expect(status.cachedKeys).toContain('comate_custom_header');
    auth.invalidate();
    await auth.headers();
    expect(calls).toBe(2);
  });

  it('可执行文件缺失且未注入 captureFn 时明确报错', async () => {
    const auth = new DucxAuth({ executable: '/definitely/missing/ducx', logger: createLogger(true) });
    await expect(auth.headers()).rejects.toThrow(/不存在/);
  });
});

describe('UpstreamService：运行期解析与模型列表', () => {
  it('未启用运行期设置时 resolveForRequest 返回 null（保持 .env 行为）', async () => {
    const { service } = makeService({ active: false });
    expect(await service.resolveForRequest('some-model')).toBeNull();
  });

  it('保存后立即切换到新 Base URL / Key / 模型', async () => {
    const { service } = makeService({ active: false });
    service.update({
      baseUrl: 'https://oneapi.example.com/v1',
      apiKey: 'sk-new-key',
      model: 'GLM-5.3',
      authMode: 'api_key',
    });
    const resolved = await service.resolveForRequest('DeepSeek-from-adp');
    expect(resolved?.baseUrl).toBe('https://oneapi.example.com/v1');
    expect(resolved?.headers.authorization).toBe('Bearer sk-new-key');
    expect(resolved?.model).toBe('GLM-5.3');
  });

  it('留空 apiKey 不覆盖已保存的凭证，clearApiKey 才清空', () => {
    const { service } = makeService({ active: false });
    service.update({ apiKey: 'sk-first' });
    service.update({ model: 'model-a', apiKey: '' });
    expect(service.view().apiKeySet).toBe(true);
    service.update({ clearApiKey: true });
    expect(service.view().apiKeySet).toBe(false);
  });

  it('DUCX 模式注入 native headers，modelOverride=request 时以请求模型为准', async () => {
    const { service } = makeService({
      active: false,
      captureFn: async (): Promise<Record<string, string>> => ({
        comate_custom_header: 'native-header',
        authorization: 'Bearer native-token',
      }),
    });
    service.update({ authMode: 'ducx', model: 'settings-model', modelOverride: 'request' });
    const resolved = await service.resolveForRequest('request-model');
    expect(resolved?.headers.comate_custom_header).toBe('native-header');
    expect(resolved?.headers.authorization).toBe('Bearer native-token');
    expect(resolved?.model).toBe('request-model');
  });

  it('listModels 命中正确端点并解析上游模型列表', async () => {
    const recorder = recordingTransport((): Response =>
      jsonResponse({ data: [{ id: 'Grok-4.6', owned_by: 'custom' }, { id: 'GLM-5.3' }] }),
    );
    const { service } = makeService({ active: false, transport: recorder.transport });
    service.update({
      baseUrl: 'https://oneapi.example.com/v1',
      authMode: 'none',
      modelsSource: 'single',
    });
    const models = await service.listModels(true);
    expect(models.map((m) => m.id)).toEqual(['Grok-4.6', 'GLM-5.3']);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].url).toBe('https://oneapi.example.com/v1/models');
  });

  it('modelsSource=auto 合并两个端点，补齐 /v1/models 之外的特殊模型', async () => {
    const transport: UpstreamTransport = async (url: string): Promise<Response> =>
      url.includes('/openapi/')
        ? jsonResponse({
            data: [
              {
                model: 'GLM-5.3',
                capability: { model_description: 'GLM 5.3', supports_image: true },
              },
              { model: 'auto', capability: { model_description: '默认模型' } },
              { model: '无能力模型' },
            ],
          })
        : jsonResponse({ data: [{ id: 'GLM-5.3' }, { id: 'Grok-4.6' }] });
    const { service } = makeService({ active: false, transport });
    service.update({
      baseUrl: 'https://oneapi.example.com/v1',
      authMode: 'none',
      modelsSource: 'auto',
    });
    const models = await service.listModels(true);
    expect(models.map((m) => m.id)).toEqual(['GLM-5.3', 'Grok-4.6', 'auto', '无能力模型']);
    expect(models[0].name).toBe('GLM 5.3');
    expect(models[0].supportsImage).toBe(true);
    expect(models[0].sources).toEqual(['openai', 'baidu']);
    expect(models[3].capabilityKnown).toBe(false);
    expect(service.modelSources()).toHaveLength(2);
  });

  it('补充端点不可用时静默忽略，主列表照常返回', async () => {
    const transport: UpstreamTransport = async (url: string): Promise<Response> =>
      url.includes('/openapi/')
        ? jsonResponse({ error: 'not found' }, 404)
        : jsonResponse({ data: [{ id: 'A' }] });
    const { service } = makeService({ active: false, transport });
    service.update({ baseUrl: 'http://x.invalid/v1', authMode: 'none', modelsSource: 'auto' });
    expect((await service.listModels(true)).map((m) => m.id)).toEqual(['A']);
    expect(service.modelSources()).toHaveLength(1);
  });

  it('modelsSource=single 只请求主列表', async () => {
    const recorder = recordingTransport((): Response => jsonResponse({ data: [{ id: 'A' }] }));
    const { service } = makeService({ active: false, transport: recorder.transport });
    service.update({ baseUrl: 'http://x.invalid/v1', authMode: 'none', modelsSource: 'single' });
    await service.listModels(true);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].url).toBe('http://x.invalid/v1/models');
  });

  it('DUCX 认证过期（401）时失效缓存并重试一次', async () => {
    let captures = 0;
    let attempts = 0;
    const transport: UpstreamTransport = async (): Promise<Response> => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ error: 'unauthorized' }, 401)
        : jsonResponse({ data: [{ id: 'GLM-5.3' }] });
    };
    const { service } = makeService({
      active: false,
      transport,
      captureFn: async (): Promise<Record<string, string>> => {
        captures += 1;
        return { comate_custom_header: `header-${captures}`, authorization: 'Bearer t' };
      },
    });
    service.update({
      authMode: 'ducx',
      baseUrl: 'https://oneapi.example.com/v1',
      modelsSource: 'single',
    });
    const models = await service.listModels(true);
    expect(models).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(captures).toBe(2);
  });

  it('testConnection 返回模型数量与真实对话结果', async () => {
    const transport: UpstreamTransport = async (url: string): Promise<Response> =>
      url.endsWith('/models')
        ? jsonResponse({ data: [{ id: 'GLM-5.3' }] })
        : jsonResponse({ choices: [{ message: { content: '正常' } }] });
    const { service } = makeService({ active: false, transport });
    service.update({ baseUrl: 'https://oneapi.example.com/v1', model: 'GLM-5.3', authMode: 'none' });
    const result = await service.testConnection(true);
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(result.chat).toBe('正常');
    expect(result.status).toBe(200);
  });
});

describe('ModelAdapter：使用运行期设置的上游与模型', () => {
  it('stream() 把新 Base URL、DUCX 认证头与自选模型带入上游请求', async () => {
    const config = baseConfig();
    const recorder = recordingTransport((): Response => sseResponse(['你', '好']));
    const { service } = makeService({
      config,
      active: false,
      transport: recorder.transport,
      captureFn: async (): Promise<Record<string, string>> => ({
        comate_custom_header: 'native',
        authorization: 'Bearer ducx-token',
      }),
    });
    service.update({
      baseUrl: 'https://oneapi.example.com/v1',
      model: 'Grok-4.6',
      authMode: 'ducx',
    });
    const adapter = new ModelAdapter({
      config,
      personalAI: loadPersonalAIConfig({}),
      transport: recorder.transport,
      logger: createLogger(true),
      upstream: service,
    });
    const chunks: string[] = [];
    for await (const chunk of adapter.stream([{ role: 'user', content: '你好' }], {
      model: 'DeepSeek-from-adp',
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('你好');
    const call = recorder.calls[0];
    expect(call.url).toBe('https://oneapi.example.com/v1/chat/completions');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.comate_custom_header).toBe('native');
    expect(headers.authorization).toBe('Bearer ducx-token');
    expect(JSON.parse(String(call.init.body)).model).toBe('Grok-4.6');
  });
});

describe('DUCX 来源上报（对齐 codex-mixin report hook）', () => {
  function makeReporter(
    fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  ): { reporter: DucxReporter; calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reporter = new DucxReporter({
      ducxExecutable: '/does/not/matter/ducx',
      logger: createLogger(true),
      captureFn: async (): Promise<string> => 'report-token-123',
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(url), init: init ?? {} });
        return fetchImpl(String(url), init ?? {});
      }) as typeof fetch,
      baseUrl: 'http://report.invalid',
    });
    return { reporter, calls };
  }

  it('按 codex-mixin 的 payload 上报 upload/query，token 放在 x-auth-client-token', async () => {
    const { reporter, calls } = makeReporter(
      async (): Promise<Response> => jsonResponse({ code: 200, message: 'success' }),
    );
    const result = await reporter.report({
      sessionId: 's1',
      prompt: '帮我修复 bug',
      model: 'GLM-5.3',
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://report.invalid/api/rest/v1/ducx/upload/query');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-auth-client-token']).toBe('report-token-123');
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      session_id: 's1',
      query: '帮我修复 bug',
      model: 'GLM-5.3',
      os: 'macos',
    });
    expect(typeof body.username).toBe('string');
    expect(reporter.status().lastSuccessAt).not.toBeNull();
  });

  it('空 prompt 直接跳过，不发起请求', async () => {
    const { reporter, calls } = makeReporter(
      async (): Promise<Response> => jsonResponse({ code: 200 }),
    );
    const result = await reporter.report({ sessionId: 's1', prompt: '   ' });
    expect(result.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('上报失败不抛错，返回 ok:false', async () => {
    const { reporter, calls } = makeReporter(
      async (): Promise<Response> => jsonResponse({ error: 'boom' }, 500),
    );
    const result = await reporter.report({ sessionId: 's1', prompt: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(calls).toHaveLength(1);
    expect(reporter.status().lastError).not.toBeNull();
  });

  it('401 时失效 token 并重试一次', async () => {
    let captures = 0;
    let attempts = 0;
    const reporter = new DucxReporter({
      ducxExecutable: '/does/not/matter/ducx',
      logger: createLogger(true),
      captureFn: async (): Promise<string> => {
        captures += 1;
        return `token-${captures}`;
      },
      fetchImpl: (async (): Promise<Response> => {
        attempts += 1;
        return attempts === 1 ? jsonResponse({}, 401) : jsonResponse({ code: 200 });
      }) as typeof fetch,
      baseUrl: 'http://report.invalid',
    });
    const result = await reporter.report({ sessionId: 's1', prompt: 'hello' });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(captures).toBe(2);
  });

  it('ducxReport=false 时 reportUsage 直接跳过', async () => {
    let submissions = 0;
    const { service } = makeService({
      active: false,
      reportCaptureFn: async (): Promise<string> => 't',
      reportFetchImpl: (async (): Promise<Response> => {
        submissions += 1;
        return jsonResponse({ code: 200 });
      }) as typeof fetch,
    });
    service.update({ authMode: 'none', ducxReport: false });
    const result = await service.reportUsage({ sessionId: 's', prompt: 'hi' });
    expect(result.skipped).toBe(true);
    expect(submissions).toBe(0);
  });
});

describe('设置 API（HTTP 集成）', () => {
  async function start(options: { adminToken?: string } = {}): Promise<{
    baseUrl: string;
    created: CreatedApp;
    service: UpstreamService;
    close(): Promise<void>;
  }> {
    const config = baseConfig();
    const transport: UpstreamTransport = async (url: string): Promise<Response> =>
      url.includes('/openapi/')
        ? jsonResponse({
            data: [
              { model: 'GLM-5.3', capability: { model_description: 'GLM 5.3' } },
              { model: 'auto', capability: { model_description: '默认模型' } },
            ],
          })
        : url.endsWith('/models')
          ? jsonResponse({ data: [{ id: 'GLM-5.3' }, { id: 'Grok-4.6' }] })
          : sseResponse(['你好']);
    const { service } = makeService({ config, active: false, transport });
    const created = await createApp(config, {
      silent: true,
      transport,
      upstreamSettings: service,
      adminToken: options.adminToken,
      personalAIConfig: {
        ...loadPersonalAIConfig({}),
        enabled: true,
        apiKeys: { 'dev-key-developer': { user_id: 'u1', agent_id: 'developer' } },
      },
    });
    const server = http.createServer(created.app);
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', (): void => resolve());
    });
    const address = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      created,
      service,
      close: async (): Promise<void> => {
        await created.close();
        server.closeAllConnections();
        await new Promise<void>((resolve): void => server.close((): void => resolve()));
      },
    };
  }

  it('GET /settings 提供知忆设置页，GET 设置视图不泄露 API Key', async () => {
    const h = await start();
    try {
      const page = await fetch(`${h.baseUrl}/settings`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('知忆');
      expect(html).toContain('ducxReport');
      expect(html).toContain('来源上报');
      const view = await fetch(`${h.baseUrl}/v1/zhiyi/settings`);
      expect(view.status).toBe(200);
      const body = await view.text();
      expect(body).not.toContain('env-secret-key');
      const parsed = JSON.parse(body);
      expect(parsed.presets.some((p: { id: string }) => p.id === 'baidu-oneapi-ducx')).toBe(true);
      expect(typeof parsed.ducxReport).toBe('boolean');
      expect(parsed.ducxReportStatus).toHaveProperty('dataReportPath');
    } finally {
      await h.close();
    }
  });

  it('PUT 校验非法配置，合法配置保存后立即作用于 /v1/models', async () => {
    const h = await start();
    try {
      const bad = await fetch(`${h.baseUrl}/v1/zhiyi/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'ftp://bad.invalid' }),
      });
      expect(bad.status).toBe(400);

      const saved = await fetch(`${h.baseUrl}/v1/zhiyi/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'http://127.0.0.1:8787/v1',
          authMode: 'none',
          model: 'GLM-5.3',
        }),
      });
      expect(saved.status).toBe(200);
      expect((await saved.json()).active).toBe(true);

      const models = await fetch(`${h.baseUrl}/v1/models`);
      expect(models.status).toBe(200);
      const list = await models.json();
      expect(list.object).toBe('list');
      expect(list.data.map((m: { id: string }) => m.id)).toEqual(['GLM-5.3', 'Grok-4.6', 'auto']);

      const detail = await (await fetch(`${h.baseUrl}/v1/zhiyi/models`)).json();
      expect(detail.merged).toBe(true);
      expect(detail.sources).toHaveLength(2);
      expect(detail.data.find((m: { id: string }) => m.id === 'GLM-5.3').sources).toEqual([
        'openai',
        'baidu',
      ]);
      expect((await h.service.resolveForRequest('other')).model).toBe('GLM-5.3');
    } finally {
      await h.close();
    }
  });

  it('设置页选中的模型同时作用于上游请求与响应 model 字段', async () => {
    const h = await start();
    try {
      await fetch(`${h.baseUrl}/v1/zhiyi/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'http://custom-upstream.invalid/v1',
          authMode: 'none',
          model: 'GLM-5.3',
          modelOverride: 'settings',
        }),
      });
      const chat = await fetch(`${h.baseUrl}/v1/personal-ai/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev-key-developer',
        },
        body: JSON.stringify({
          model: 'DeepSeek-from-adp',
          messages: [{ role: 'user', content: '你好' }],
          stream: false,
        }),
      });
      expect(chat.status).toBe(200);
      const body = await chat.json();
      expect(body.model).toBe('GLM-5.3');
      expect(body.choices[0].message.content).toBe('你好');
    } finally {
      await h.close();
    }
  });

  it('配置管理令牌后，未带令牌的设置请求被拒绝', async () => {
    const h = await start({ adminToken: 'unit-test-token' });
    try {
      const denied = await fetch(`${h.baseUrl}/v1/zhiyi/settings`);
      expect(denied.status).toBe(401);
      const allowed = await fetch(`${h.baseUrl}/v1/zhiyi/settings`, {
        headers: { authorization: 'Bearer unit-test-token' },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
