/**
 * 统一上游解析：三条链路（Personal AI / OpenAI 代理 / 后台记忆提取）共用同一份
 * 运行期设置，保证设置页一改，所有模型请求立刻指向新的 API 与模型。
 */
import type { AppConfig } from '../config';
import { completionsUrl } from '../config';
import type { Logger } from '../logger';
import type { UpstreamTransport } from '../types';
import { DucxAuth, type DucxStatus } from './ducx-auth';
import {
  DucxReporter,
  type DucxReportInput,
  type DucxReportResult,
  type DucxReportStatus,
} from './ducx-report';
import {
  BAIDU_AVAILABLE_MODELS_PATH,
  DEFAULT_DUCX_EXECUTABLE,
  PROVIDER_PRESETS,
  SettingsStore,
  endpointUrl,
  modelsUrl,
  toPublicSettings,
  validateSettingsPatch,
  type ModelSettings,
  type ProviderPreset,
  type PublicSettings,
  type SettingsPatch,
  normalizeBaseUrl,
} from './model-settings';

export interface ResolvedUpstream {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  authMode: ModelSettings['authMode'];
  onAuthRejected(): void;
}

export type ModelSource = 'openai' | 'baidu';

export interface ModelInfo {
  id: string;
  name?: string;
  owned_by?: string;
  description?: string;
  ratio?: string;
  priceType?: string;
  contextWindow?: number;
  supportsImage?: boolean;
  supportsThinking?: boolean;
  /** false = 上游没有返回 capability 元数据（仍然保留，避免漏模型）。 */
  capabilityKnown?: boolean;
  /** 渠道副本：同模型的 -2 / -3 变体，值为去掉数字后缀的基础 ID。 */
  variantOf?: string;
  /** 只有 -2 / -3 渠道、没有基础版本的模型（不能折叠，否则会消失）。 */
  isolatedVariant?: boolean;
  /** 该模型出现在哪些端点里，用于设置页标注来源。 */
  sources?: ModelSource[];
}

export interface UpstreamServiceOptions {
  store: SettingsStore;
  initial: ModelSettings;
  config: AppConfig;
  transport: UpstreamTransport;
  logger: Logger;
  /** 测试注入：跳过真实 DUCX 进程。 */
  ducxCaptureFn?: () => Promise<Record<string, string>>;
  /** 测试注入：跳过真实 data-report 进程。 */
  reportCaptureFn?: () => Promise<string>;
  /** 测试注入：替换上报 fetch。 */
  reportFetchImpl?: typeof fetch;
  /** 测试 / 私有部署：覆盖上报端点。 */
  reportBaseUrl?: string;
}

export interface TestResult {
  ok: boolean;
  baseUrl: string;
  model: string;
  modelCount: number | null;
  status: number | null;
  latencyMs: number;
  chat: string | null;
  error: string | null;
}

interface ModelCache {
  models: ModelInfo[];
  at: number;
  sources: string[];
}

const MODEL_CACHE_TTL_MS = 60_000;

export interface InitialOverrides {
  baseUrl?: string;
  apiKey?: string;
}

export function initialSettings(
  config: AppConfig,
  active: boolean,
  overrides: InitialOverrides = {},
): ModelSettings {
  const baseUrl: string = overrides.baseUrl || config.upstreamBaseUrl;
  const apiKey: string = overrides.apiKey ?? config.upstreamApiKey;
  return {
    active,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    authMode: apiKey === '' ? 'none' : 'api_key',
    model: config.defaultModel,
    modelsPath: '/models',
    modelsSource: 'auto',
    ducxReport: true,
    ducxExecutable: DEFAULT_DUCX_EXECUTABLE,
    modelOverride: 'settings',
    updatedAt: new Date().toISOString(),
  };
}

export class UpstreamService {
  private readonly store: SettingsStore;
  private readonly initial: ModelSettings;
  private readonly config: AppConfig;
  private readonly transport: UpstreamTransport;
  private readonly logger: Logger;
  private readonly ducxCaptureFn?: () => Promise<Record<string, string>>;
  private readonly reportCaptureFn?: () => Promise<string>;
  private readonly reportFetchImpl?: typeof fetch;
  private readonly reportBaseUrl?: string;
  private readonly ducxRuntimes = new Map<string, DucxAuth>();
  private readonly reportRuntimes = new Map<string, DucxReporter>();
  private modelCache: ModelCache | null = null;

  constructor(options: UpstreamServiceOptions) {
    this.store = options.store;
    this.initial = options.initial;
    this.config = options.config;
    this.transport = options.transport;
    this.logger = options.logger;
    this.ducxCaptureFn = options.ducxCaptureFn;
    this.reportCaptureFn = options.reportCaptureFn;
    this.reportFetchImpl = options.reportFetchImpl;
    this.reportBaseUrl = options.reportBaseUrl;
  }

  view(): PublicSettings & {
    presets: readonly ProviderPreset[];
    ducx: DucxStatus;
    ducxReportStatus: DucxReportStatus;
    envFallback: { baseUrl: string; model: string };
    effectiveBaseUrl: string;
  } {
    const current: ModelSettings = this.store.get();
    return {
      ...toPublicSettings(current),
      presets: PROVIDER_PRESETS,
      ducx: this.ducxFor(current.ducxExecutable).status(),
      ducxReportStatus: this.reporterFor(current.ducxExecutable).status(),
      envFallback: {
        baseUrl: normalizeBaseUrl(this.config.upstreamBaseUrl),
        model: this.config.defaultModel,
      },
      effectiveBaseUrl: normalizeBaseUrl(current.active ? current.baseUrl : this.config.upstreamBaseUrl),
    };
  }

  update(patch: SettingsPatch & { clearApiKey?: boolean }): PublicSettings {
    const errors: string[] = validateSettingsPatch(patch);
    if (errors.length > 0) throw new Error(errors.join('；'));

    const { clearApiKey, ...rest } = patch;
    const next: SettingsPatch = { ...rest };
    if (next.apiKey === undefined || next.apiKey === '') {
      // 表单里留空 = 不修改；只有 clearApiKey=true 才真正清空。
      delete next.apiKey;
      if (clearApiKey === true) next.apiKey = '';
    }
    if (next.ducxExecutable !== undefined && next.ducxExecutable.trim() === '') {
      next.ducxExecutable = DEFAULT_DUCX_EXECUTABLE;
    }
    // 任何一次显式保存都表示「启用运行期设置」。
    next.active = true;
    const saved: ModelSettings = this.store.update(next);
    this.modelCache = null;
    if (patch.ducxExecutable !== undefined || patch.authMode !== undefined) {
      this.ducxFor(saved.ducxExecutable).invalidate();
    }
    this.logger.info(
      `模型服务设置已更新：baseUrl=${saved.baseUrl} auth=${saved.authMode} model=${saved.model}`,
    );
    return toPublicSettings(saved);
  }

  reset(): PublicSettings {
    this.modelCache = null;
    for (const runtime of this.ducxRuntimes.values()) runtime.invalidate();
    return toPublicSettings(this.store.reset(this.initial));
  }

  ducxStatus(): DucxStatus {
    return this.ducxFor(this.store.get().ducxExecutable).status();
  }

  ducxReportStatus(): DucxReportStatus {
    return this.reporterFor(this.store.get().ducxExecutable).status();
  }

  /** 异步来源上报：关闭 / 空 prompt 时直接跳过，失败不抛给调用方。 */
  async reportUsage(input: Omit<DucxReportInput, 'model'>): Promise<DucxReportResult> {
    const current: ModelSettings = this.store.get();
    if (!current.ducxReport) {
      return { ok: true, status: null, error: null, skipped: true };
    }
    return this.reporterFor(current.ducxExecutable).report({
      ...input,
      model: current.model || this.config.defaultModel,
    });
  }

  async testDucxReport(): Promise<DucxReportResult> {
    return this.reportUsage({
      sessionId: 'zhiyi-report-test',
      prompt: 'zhiyi report connectivity test',
      cwd: process.cwd(),
    });
  }

  async refreshDucx(): Promise<DucxStatus> {
    const current: ModelSettings = this.store.get();
    const runtime: DucxAuth = this.ducxFor(current.ducxExecutable);
    runtime.invalidate();
    await runtime.headers(true);
    return runtime.status();
  }

  /** 返回 null 表示「不要覆盖 .env 配置」，供 Mock / 测试保持原行为。 */
  async resolveForRequest(requestModel?: string): Promise<ResolvedUpstream | null> {
    const current: ModelSettings = this.store.get();
    if (!current.active) return null;
    const headers: Record<string, string> = await this.authHeaders();
    const requested: string | undefined =
      typeof requestModel === 'string' && requestModel.trim() !== '' ? requestModel.trim() : undefined;
    const model: string =
      current.modelOverride === 'request' && requested
        ? requested
        : current.model.trim() !== ''
          ? current.model.trim()
          : requested ?? this.config.defaultModel;
    return {
      baseUrl: normalizeBaseUrl(current.baseUrl) || normalizeBaseUrl(this.config.upstreamBaseUrl),
      headers,
      model,
      authMode: current.authMode,
      onAuthRejected: (): void => {
        if (current.authMode === 'ducx') this.ducxFor(current.ducxExecutable).invalidate();
      },
    };
  }

  async authHeaders(): Promise<Record<string, string>> {
    const current: ModelSettings = this.store.get();
    if (current.authMode === 'ducx') {
      return { ...(await this.ducxFor(current.ducxExecutable).headers()) };
    }
    if (current.authMode === 'api_key' && current.apiKey.trim() !== '') {
      return { authorization: `Bearer ${current.apiKey.trim()}` };
    }
    return {};
  }

  /**
   * 模型列表：默认合并两个来源。
   * - /v1/models（OpenAI 兼容，所有上游都有）
   * - /openapi/v2/available_models（Baidu 富信息，含 auto 等特殊模型与能力元数据）
   * 补充端点不存在时静默忽略，不影响主列表；对齐 codex-mixin 的 Baidu 模型发现。
   */
  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (!refresh && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.models;
    }
    const current: ModelSettings = this.store.get();
    const baseUrl: string = normalizeBaseUrl(current.baseUrl) || normalizeBaseUrl(this.config.upstreamBaseUrl);
    const primaryUrl: string = modelsUrl(baseUrl, current.modelsPath);
    const primarySource: ModelSource = primaryUrl.includes('/openapi/') ? 'baidu' : 'openai';
    const primary: ModelInfo[] = normalizeModels(
      await this.fetchModelsPayload(primaryUrl, current),
      primarySource,
    );
    const sources: string[] = [primaryUrl];
    let models: ModelInfo[] = primary;

    if (current.modelsSource === 'auto' && primarySource === 'openai') {
      const extraUrl: string = endpointUrl(baseUrl, BAIDU_AVAILABLE_MODELS_PATH);
      try {
        const extra: ModelInfo[] = normalizeModels(
          await this.fetchModelsPayload(extraUrl, current, true),
          'baidu',
        );
        models = mergeModelLists(primary, extra);
        sources.push(extraUrl);
      } catch (error) {
        this.logger.info(
          `补充模型列表不可用，仅使用主列表：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const marked: ModelInfo[] = markVariants(models);
    this.modelCache = { models: marked, at: Date.now(), sources };
    return marked;
  }

  /** 本次模型列表来自哪些端点，用于设置页展示「已合并」。 */
  modelSources(): string[] {
    return this.modelCache?.sources ?? [];
  }

  private async fetchModelsPayload(
    url: string,
    current: ModelSettings,
    forcePost = false,
  ): Promise<unknown> {
    const usePost: boolean = forcePost || url.includes('/openapi/');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(await this.authHeaders()),
    };
    const init: RequestInit = usePost
      ? { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(15_000) }
      : { method: 'GET', headers, signal: AbortSignal.timeout(15_000) };

    let response: Response = await this.transport(url, init);
    if ((response.status === 401 || response.status === 403) && current.authMode === 'ducx') {
      this.ducxFor(current.ducxExecutable).invalidate();
      const refreshed: Record<string, string> = await this.authHeaders();
      response = await this.transport(url, { ...init, headers: { ...headers, ...refreshed } });
    }
    if (!response.ok) {
      const detail: string = (await response.text().catch((): string => '')).slice(0, 200);
      throw new Error(`模型列表请求失败（HTTP ${response.status}）：${detail}`);
    }
    return response.json();
  }

  async testConnection(withChat: boolean): Promise<TestResult> {
    const started: number = Date.now();
    const current: ModelSettings = this.store.get();
    const baseUrl: string = normalizeBaseUrl(current.baseUrl) || normalizeBaseUrl(this.config.upstreamBaseUrl);
    const result: TestResult = {
      ok: false,
      baseUrl,
      model: current.model || this.config.defaultModel,
      modelCount: null,
      status: null,
      latencyMs: 0,
      chat: null,
      error: null,
    };
    try {
      const models: ModelInfo[] = await this.listModels(true);
      result.modelCount = models.length;
      result.ok = true;
      if (withChat) {
        const resolved: ResolvedUpstream | null = await this.resolveForRequest();
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          ...(resolved?.headers ?? (await this.authHeaders())),
        };
        const response: Response = await this.transport(completionsUrl(baseUrl), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: current.model || this.config.defaultModel,
            messages: [{ role: 'user', content: '只回复两个字：正常' }],
            stream: false,
            max_tokens: 64,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        result.status = response.status;
        const text: string = await response.text();
        if (!response.ok) throw new Error(`对话测试失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
        try {
          const parsed = JSON.parse(text) as {
            choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
          };
          const message = parsed.choices?.[0]?.message;
          result.chat = message?.content || message?.reasoning_content || '(空回复)';
        } catch {
          result.chat = text.slice(0, 120);
        }
      }
    } catch (error) {
      result.ok = false;
      result.error = error instanceof Error ? error.message : String(error);
    }
    result.latencyMs = Date.now() - started;
    return result;
  }

  private ducxFor(executable: string): DucxAuth {
    const key: string = executable || DEFAULT_DUCX_EXECUTABLE;
    let runtime: DucxAuth | undefined = this.ducxRuntimes.get(key);
    if (!runtime) {
      runtime = new DucxAuth({
        executable: key,
        logger: this.logger,
        captureFn: this.ducxCaptureFn,
      });
      this.ducxRuntimes.set(key, runtime);
    }
    return runtime;
  }

  private reporterFor(executable: string): DucxReporter {
    const key: string = executable || DEFAULT_DUCX_EXECUTABLE;
    let reporter: DucxReporter | undefined = this.reportRuntimes.get(key);
    if (!reporter) {
      reporter = new DucxReporter({
        ducxExecutable: key,
        logger: this.logger,
        captureFn: this.reportCaptureFn,
        fetchImpl: this.reportFetchImpl,
        baseUrl: this.reportBaseUrl,
      });
      this.reportRuntimes.set(key, reporter);
    }
    return reporter;
  }
}

function extractModelArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const object = payload as Record<string, unknown>;
  if (Array.isArray(object.data)) return object.data;
  if (Array.isArray(object.models)) return object.models;
  return [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** 只挑出已定义字段，避免合并时把已有信息覆盖成 undefined。 */
function definedFields(info: ModelInfo): Partial<ModelInfo> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<ModelInfo>;
}

/**
 * 解析模型列表。
 * - OpenAI 源：{data:[{id, display_name, description, ...}]}、裸数组、{models:[...]}
 * - Baidu 源：{data:[{model, capability, capability_set, ...}]}
 *   · 剥离 `-内部` 后缀；非内部版本优先覆盖（与 codex-mixin 一致）
 *   · 排除没有 capability 元数据的条目
 *   · 提取描述、倍率、价格类型、上下文长度、图像 / 思考能力
 */
export function normalizeModels(payload: unknown, source: ModelSource = 'openai'): ModelInfo[] {
  const raw: unknown[] = extractModelArray(payload);
  const models: ModelInfo[] = [];
  const index = new Map<string, number>();
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const id: string = entry.trim();
      if (id !== '' && !index.has(id)) {
        index.set(id, models.length);
        models.push({ id, sources: [source] });
      }
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    let id: string = String(item.model ?? item.id ?? item.name ?? '').trim();
    let isInternal = false;
    if (source === 'baidu' && id.endsWith('-内部')) {
      id = id.slice(0, -'-内部'.length).trim();
      isInternal = true;
    }
    if (id === '') continue;

    let info: ModelInfo;
    if (source === 'baidu') {
      const capability = item.capability;
      const hasCapability: boolean = Boolean(capability) && typeof capability === 'object';
      const cap: Record<string, unknown> = hasCapability
        ? (capability as Record<string, unknown>)
        : {};
      const capabilitySet: unknown[] = Array.isArray(item.capability_set) ? item.capability_set : [];
      const declares = (name: string): boolean => capabilitySet.includes(name);
      const name = optionalString(cap.model_description);
      const ratio = optionalString(cap.ratio);
      const priceType = optionalString(item.price_type);
      const contextWindow = optionalNumber(cap.context_window);
      const image = optionalBool(cap.supports_image);
      const thinking = optionalBool(cap.supports_thinking);
      info = {
        id,
        sources: ['baidu'],
        ...(hasCapability ? {} : { capabilityKnown: false }),
        ...(name ? { name } : {}),
        ...(ratio ? { ratio } : {}),
        ...(priceType ? { priceType } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(image !== undefined || declares('image')
          ? { supportsImage: Boolean(image) || declares('image') }
          : {}),
        ...(thinking !== undefined ? { supportsThinking: thinking } : {}),
      };
    } else {
      const name =
        optionalString(item.display_name) ??
        optionalString(item.model_description) ??
        optionalString(item.description);
      const description = optionalString(item.description);
      const ownedBy = optionalString(item.owned_by);
      const ratio = optionalString(item.ratio);
      const priceType = optionalString(item.price_type);
      const contextWindow = optionalNumber(item.context_window);
      const image = optionalBool(item.supports_image);
      const thinking = optionalBool(item.supports_thinking);
      info = {
        id,
        sources: ['openai'],
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(ownedBy ? { owned_by: ownedBy } : {}),
        ...(ratio ? { ratio } : {}),
        ...(priceType ? { priceType } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(image !== undefined ? { supportsImage: image } : {}),
        ...(thinking !== undefined ? { supportsThinking: thinking } : {}),
      };
    }

    const existing: number | undefined = index.get(id);
    if (existing === undefined) {
      index.set(id, models.length);
      models.push(info);
    } else if (!isInternal) {
      models[existing] = { ...models[existing], ...definedFields(info) };
    }
  }
  return models;
}

/**
 * 标记「渠道副本」：上游聚合网关会给同一模型的不同渠道生成 -2 / -3 后缀。
 * 只有基础 ID 也在列表里时才标记，避免把真的以数字结尾的模型误判成副本。
 */
export function markVariants(models: ModelInfo[]): ModelInfo[] {
  const ids = new Set<string>(models.map((model): string => model.id));
  return models.map((model): ModelInfo => {
    const matched: RegExpMatchArray | null = model.id.match(/^(.+)-(\d+)$/);
    if (!matched) return model;
    if (!ids.has(matched[1])) return { ...model, isolatedVariant: true };
    return { ...model, variantOf: matched[1] };
  });
}

/** 合并两个来源：Baidu 富信息覆盖同名字段，来源标签取并集。 */
export function mergeModelLists(primary: ModelInfo[], extra: ModelInfo[]): ModelInfo[] {
  const result: ModelInfo[] = primary.map((model): ModelInfo => ({ ...model }));
  const index = new Map<string, number>(result.map((model, at) => [model.id, at]));
  for (const item of extra) {
    const at: number | undefined = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, result.length);
      result.push({ ...item });
      continue;
    }
    const merged: ModelInfo = { ...result[at], ...definedFields(item) };
    merged.sources = [...new Set([...(result[at].sources ?? []), ...(item.sources ?? [])])];
    result[at] = merged;
  }
  return result;
}
