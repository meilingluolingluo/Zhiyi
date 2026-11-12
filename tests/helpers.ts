/** 测试基础设施：临时 SQLite 文件 + 真实 HTTP 服务 + 内置 Mock 上游。 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig, type MulticaConfig, type PersonalAIConfig } from '../src/personal-ai/config';

export interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  raw: Response;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  key?: string | null;
  headers?: Record<string, string>;
}

export interface StreamResult {
  status: number;
  headers: Headers;
  chunks: string[];
  text: string;
}

export type PersonalAIHarnessOverride = Partial<Omit<PersonalAIConfig, 'multica'>> & {
  multica?: Partial<MulticaConfig>;
};

export interface Harness {
  baseUrl: string;
  created: CreatedApp;
  deps: CreatedApp['deps'];
  /** Personal AI 装配结果（TaskManager / Worker / Router），便于断言内部状态。 */
  personalAI: CreatedApp['personalAI'];
  api(route: string, options?: ApiOptions): Promise<ApiResult>;
  stream(route: string, options?: ApiOptions): Promise<StreamResult>;
  waitForBackground(): Promise<void>;
  mockReset(): Promise<void>;
  mockConfigure(behavior: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

function requestInit(options: ApiOptions): RequestInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  };
  const key: string | null | undefined = options.key;
  if (key !== null && key !== undefined) headers.authorization = `Bearer ${key}`;
  return {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15000),
  };
}

export async function createHarness(
  overrides: Partial<AppConfig> = {},
  personalAIOptions: { personalAI?: PersonalAIHarnessOverride } = {},
): Promise<Harness> {
  const config: AppConfig = {
    ...loadConfig({}),
    // 纯内存数据库：各 harness 天然隔离，且不触碰受限的临时文件目录。
    databaseUrl: ':memory:',
    mockUpstream: true,
    memoryEnabled: true,
    memoryAutoExtract: true,
    memoryMaxItems: 5,
    memoryTokenBudget: 800,
    extractMinConfidence: 0.6,
    upstreamTimeoutMs: 1500,
    logSilent: true,
    ...overrides,
  };
  let personalAIConfig: PersonalAIConfig | undefined;
  if (personalAIOptions.personalAI) {
    const defaults: PersonalAIConfig = loadPersonalAIConfig({});
    const override: PersonalAIHarnessOverride = personalAIOptions.personalAI;
    const multica: MulticaConfig = { ...defaults.multica, ...(override.multica ?? {}) };
    const { multica: _ignored, ...rest } = override;
    personalAIConfig = { ...defaults, ...rest, multica } as PersonalAIConfig;
  }
  const created: CreatedApp = await createApp(config, { silent: true, personalAIConfig });
  const server = http.createServer(created.app);
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', (): void => resolve());
  });
  const address = server.address() as AddressInfo;
  const baseUrl: string = `http://127.0.0.1:${address.port}`;

  const api = async (route: string, options: ApiOptions = {}): Promise<ApiResult> => {
    const response: Response = await fetch(`${baseUrl}${route}`, requestInit(options));
    const text: string = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json, raw: response };
  };

  const stream = async (route: string, options: ApiOptions = {}): Promise<StreamResult> => {
    const response: Response = await fetch(`${baseUrl}${route}`, requestInit(options));
    const chunks: string[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(decoder.decode(result.value, { stream: true }));
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      chunks,
      text: chunks.join(''),
    };
  };

  return {
    baseUrl,
    created,
    deps: created.deps,
    personalAI: created.personalAI,
    api,
    stream,
    waitForBackground: async (): Promise<void> => {
      await created.waitForBackground();
    },
    mockReset: async (): Promise<void> => {
      await api('/__mock__/reset', { method: 'POST', body: {} });
    },
    mockConfigure: async (behavior: Record<string, unknown>): Promise<void> => {
      await api('/__mock__/configure', { method: 'POST', body: behavior });
    },
    close: async (): Promise<void> => {
      await created.close();
      server.closeAllConnections();
      await new Promise<void>((resolve): void => {
        server.close((): void => resolve());
      });
    },
  };
}
