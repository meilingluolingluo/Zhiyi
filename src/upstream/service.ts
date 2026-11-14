/**
 * 统一上游解析：三条链路（Personal AI / OpenAI 代理 / 后台记忆提取）共用同一份
 * 运行期设置，保证设置页一改，所有模型请求立刻指向新的 API 与模型。
 */
import type { AppConfig } from '../config';
import {
  buildUpstreamRequestForRoute,
  resolveOneApiRoute,
  resolveUpstreamModelId,
  translateUpstreamResponse,
  type ResolvedUpstreamProtocol,
} from './oneapi-protocol';
import type { Logger } from '../logger';
import type { ChatMessage, UpstreamTransport } from '../types';
import { DucxAuth, type DucxStatus } from './ducx-auth';
import {
  DucxReporter,
  type DucxReportInput,
  type DucxReportResult,
  type DucxReportStatus,
} from './ducx-report';
import {
  MediaStore,
  normalizeImageResponsePayload,
} from './media-store';
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
  type ModelsSource,
  type ProviderPreset,
  type PublicSettings,
  type SettingsPatch,
  normalizeBaseUrl,
} from './model-settings';
import {
  executeWebFetch,
  executeWebSearch,
  validateFetchParams,
  validateSearchParams,
  type WebFetchResult,
  type WebSearchResult,
} from './web-search';

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
  /** 可选图片媒体存储。 */
  mediaStore?: MediaStore;
}

export interface ImageGenerationResult {
  ok: boolean;
  status: number;
  model: string;
  payload: Record<string, unknown>;
  savedUrls: string[];
  errorText?: string;
}

export interface TitleGenerationInput {
  prompt?: string;
  assistantReply?: string;
  messages?: ChatMessage[];
  model?: string;
  maxLength?: number;
  signal?: AbortSignal;
}

export interface TitleGenerationResult {
  title: string;
  model: string;
  fallback: boolean;
}

export interface TestGroupDiagnostic {
  ok: boolean;
  baseUrl: string;
  model: string;
  status: number | null;
  latencyMs: number;
  error: string | null;
  reused?: boolean;
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
  proxyGroup?: TestGroupDiagnostic;
  memoryGroup?: TestGroupDiagnostic;
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
    upstreamProtocol: 'auto',
    imageModel: 'gpt-image-2',
    titleModel: '',
    ducxReport: true,
    ducxExecutable: DEFAULT_DUCX_EXECUTABLE,
    modelOverride: 'settings',
    memoryReuseProxy: true,
    memoryBaseUrl: '',
    memoryApiKey: '',
    memoryAuthMode: 'api_key',
    memoryModel: '',
    memoryProtocol: 'auto',
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
  private readonly mediaStore: MediaStore;
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
    this.mediaStore = options.mediaStore ?? new MediaStore(null);
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

  update(
    patch: SettingsPatch & { clearApiKey?: boolean; clearMemoryApiKey?: boolean },
  ): PublicSettings {
    const errors: string[] = validateSettingsPatch(patch);
    if (errors.length > 0) throw new Error(errors.join('；'));

    const { clearApiKey, clearMemoryApiKey, ...rest } = patch;
    const next: SettingsPatch = { ...rest };
    if (next.apiKey === undefined || next.apiKey === '') {
      // 表单里留空 = 不修改；只有 clearApiKey=true 才真正清空。
      delete next.apiKey;
      if (clearApiKey === true) next.apiKey = '';
    }
    if (next.memoryApiKey === undefined || next.memoryApiKey === '') {
      delete next.memoryApiKey;
      if (clearMemoryApiKey === true) next.memoryApiKey = '';
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
    try {
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
    } catch (error) {
      this.logger.error('解析上游服务请求配置失败', error);
      return null;
    }
  }

  async authHeaders(forMemory = false): Promise<Record<string, string>> {
    const current: ModelSettings = this.store.get();
    if (forMemory && current.memoryReuseProxy === false) {
      if (current.memoryAuthMode === 'ducx') {
        try {
          return { ...(await this.ducxFor(current.ducxExecutable).headers()) };
        } catch (err) {
          this.logger.warn('获取 Memory 组 DUCX 认证头失败', err);
          if (current.memoryApiKey && current.memoryApiKey.trim() !== '') {
            return { authorization: `Bearer ${current.memoryApiKey.trim()}` };
          }
          return {};
        }
      }
      if (current.memoryAuthMode === 'api_key' && current.memoryApiKey && current.memoryApiKey.trim() !== '') {
        return { authorization: `Bearer ${current.memoryApiKey.trim()}` };
      }
      return {};
    }

    if (current.authMode === 'ducx') {
      try {
        return { ...(await this.ducxFor(current.ducxExecutable).headers()) };
      } catch (err) {
        this.logger.warn('获取 Proxy 组 DUCX 认证头失败', err);
        if (current.apiKey.trim() !== '') {
          return { authorization: `Bearer ${current.apiKey.trim()}` };
        }
        return {};
      }
    }
    if (current.authMode === 'api_key' && current.apiKey.trim() !== '') {
      return { authorization: `Bearer ${current.apiKey.trim()}` };
    }
    return {};
  }

  /**
   * 模型列表：默认合并两个来源。
   * - /v1/models（OpenAI 兼容端点）
   * - /openapi/v2/available_models（Baidu 扩展信息，含 auto 等特殊模型与能力元数据）
   * 补充端点不存在时静默忽略，不影响主列表。
   */
  async listModels(
    refresh = false,
    override?: { baseUrl?: string; apiKey?: string; modelsPath?: string; modelsSource?: ModelsSource },
  ): Promise<ModelInfo[]> {
    if (!refresh && !override && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.models;
    }
    const current: ModelSettings = override
      ? { ...this.store.get(), ...override }
      : this.store.get();
    const baseUrl: string =
      normalizeBaseUrl(current.baseUrl) || normalizeBaseUrl(this.config.upstreamBaseUrl);
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
    if (!override) {
      this.modelCache = { models: marked, at: Date.now(), sources };
    }
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

  private async dispatchWithAuthRetry(
    resolved: ResolvedUpstream | null,
    requestedModel: string | undefined,
    apiKeyOverride: string | undefined,
    sender: (headers: Record<string, string>) => Promise<Response>,
  ): Promise<Response> {
    const buildHeaders = (resolvedHeaders?: Record<string, string>): Record<string, string> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (resolvedHeaders) {
        Object.assign(headers, resolvedHeaders);
      } else {
        const key: string = apiKeyOverride || this.config.upstreamApiKey;
        if (!this.config.mockUpstream && key !== '') {
          headers.authorization = `Bearer ${key}`;
        }
      }
      return headers;
    };

    let response: Response = await sender(buildHeaders(resolved?.headers));
    if ((response.status === 401 || response.status === 403) && resolved?.authMode === 'ducx') {
      resolved.onAuthRejected();
      const refreshed: ResolvedUpstream | null = await this.resolveForRequest(requestedModel);
      if (refreshed) {
        response = await sender(buildHeaders(refreshed.headers));
      }
    }
    return response;
  }

  /**
   * 统一多协议对话发送入口（OpenAI Chat / Anthropic Messages / OpenAI Responses）：
   * - 按设置页配置与模型名自动选路（支持 Baidu OneAPI 直连 + `-baidu-oneapi` slug 剥离）
   * - 支持 DUCX 401/403 自动刷新重试
   * - 将响应与 SSE 流统一规整为标准 OpenAI Chat Completions 格式返回给调用方
   */
  async sendChat(
    openAiBody: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      modelOverride?: string;
      baseUrlOverride?: string;
      apiKeyOverride?: string;
      forMemory?: boolean;
    } = {},
  ): Promise<{ response: Response; model: string; protocol: ResolvedUpstreamProtocol }> {
    const requestedModel =
      typeof options.modelOverride === 'string' && options.modelOverride.trim() !== ''
        ? options.modelOverride.trim()
        : typeof openAiBody.model === 'string' && openAiBody.model.trim() !== ''
          ? openAiBody.model.trim()
          : undefined;
    const current: ModelSettings = this.store.get();
    const resolved: ResolvedUpstream | null = await this.resolveForRequest(requestedModel);

    const isMemoryCall = Boolean(
      options.forMemory && current.memoryReuseProxy === false && current.memoryBaseUrl,
    );
    const baseUrl: string = isMemoryCall
      ? normalizeBaseUrl(current.memoryBaseUrl!)
      : (resolved?.baseUrl ??
        (normalizeBaseUrl(options.baseUrlOverride ?? '') ||
          normalizeBaseUrl(this.config.upstreamBaseUrl)));
    const modelName: string = isMemoryCall
      ? (current.memoryModel?.trim() || resolved?.model || requestedModel || this.config.defaultModel)
      : (resolved?.model || requestedModel || this.config.defaultModel);
    const route = resolveOneApiRoute(
      baseUrl,
      modelName,
      isMemoryCall ? (current.memoryProtocol ?? 'auto') : (current.upstreamProtocol ?? 'auto'),
    );

    const response: Response = await this.dispatchWithAuthRetry(
      resolved,
      requestedModel,
      options.apiKeyOverride,
      async (headers: Record<string, string>): Promise<Response> => {
        const built = buildUpstreamRequestForRoute(route, openAiBody, headers);
        return this.transport(built.url, {
          method: 'POST',
          headers: built.headers,
          body: built.body,
          signal: options.signal,
        });
      },
    );

    const translated: Response = await translateUpstreamResponse(route.protocol, response, {
      requestedModel: route.upstreamModel,
      wantsStream: openAiBody.stream === true,
    });
    return { response: translated, model: modelName, protocol: route.protocol };
  }

  /**
   * 统一生图出站调用：转发至 ${baseUrl}/v1/images/generations（如 Baidu OneAPI），
   * 自动注入认证与 DUCX 401/403 重试，并将返回 base64 落盘/存库以生成可直接预览的 URL。
   */
  async generateImages(
    openAiImageBody: Record<string, unknown>,
    options: { signal?: AbortSignal; publicOrigin?: string } = {},
  ): Promise<ImageGenerationResult> {
    const current: ModelSettings = this.store.get();
    const requestedModel =
      typeof openAiImageBody.model === 'string' && openAiImageBody.model.trim() !== ''
        ? openAiImageBody.model.trim()
        : current.imageModel?.trim() || 'gpt-image-2';

    const resolved: ResolvedUpstream | null = await this.resolveForRequest(requestedModel);
    const baseUrl: string =
      resolved?.baseUrl ?? normalizeBaseUrl(this.config.upstreamBaseUrl);
    const upstreamModel: string = resolveUpstreamModelId(baseUrl, requestedModel);
    const url: string = endpointUrl(baseUrl, '/v1/images/generations');

    const prompt: string =
      typeof openAiImageBody.prompt === 'string' ? openAiImageBody.prompt.trim() : '';
    if (prompt !== '') {
      void this.reportUsage({
        sessionId: 'image-gen',
        prompt,
        cwd: process.cwd(),
      }).catch((): void => undefined);
    }

    const bodyPayload: Record<string, unknown> = {
      ...openAiImageBody,
      model: upstreamModel,
    };

    const response: Response = await this.dispatchWithAuthRetry(
      resolved,
      requestedModel,
      undefined,
      async (headers: Record<string, string>): Promise<Response> =>
        this.transport(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyPayload),
          signal: options.signal,
        }),
    );

    if (!response.ok) {
      const errorText: string = await response.text().catch((): string => '');
      return {
        ok: false,
        status: response.status,
        model: upstreamModel,
        payload: {},
        savedUrls: [],
        errorText,
      };
    }

    const rawJson = (await response.json()) as Record<string, unknown>;
    const normalized = normalizeImageResponsePayload(rawJson, this.mediaStore, {
      outputFormat: openAiImageBody.output_format,
      publicOrigin: options.publicOrigin,
      onError: (err): void => {
        this.logger.warn('保存生成图片失败（保留原始 b64_json）', err);
      },
    });

    return {
      ok: true,
      status: response.status,
      model: upstreamModel,
      payload: normalized.payload,
      savedUrls: normalized.savedUrls,
    };
  }

  /**
   * 统一会话标题生成：优先调用轻量/当前模型总结简洁标题；异常或超时时自动平滑回退规则截断。
   */
  async generateTitle(input: TitleGenerationInput): Promise<TitleGenerationResult> {
    const maxLen = Math.min(Math.max(4, input.maxLength ?? 20), 60);
    const current: ModelSettings = this.store.get();
    const resolved: ResolvedUpstream | null = await this.resolveForRequest(input.model);
    const targetModel: string =
      input.model?.trim() ||
      current.titleModel?.trim() ||
      resolved?.model ||
      this.config.defaultModel;

    const promptText: string = extractTitleSourceText(input);
    const fallbackTitle: string = buildFallbackTitle(promptText, maxLen);
    if (promptText === '' && (!input.assistantReply || input.assistantReply.trim() === '')) {
      return { title: fallbackTitle, model: targetModel, fallback: true };
    }

    const userContext: string = [
      promptText ? `用户消息：${promptText.slice(0, 600)}` : '',
      input.assistantReply ? `助手回复：${input.assistantReply.slice(0, 800)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const { response } = await this.sendChat(
        {
          model: targetModel,
          messages: [
            {
              role: 'system',
              content:
                `你是对话标题提炼助手。请根据对话内容生成一个简洁、直观的标题（不超过 ${maxLen} 个字），` +
                '保持与用户输入相同的语言，只输出标题本身，不要加引号、书名号、序号或句末标点。',
            },
            { role: 'user', content: userContext },
          ],
          stream: false,
          temperature: 0.2,
          max_tokens: 48,
        },
        {
          modelOverride: targetModel,
          signal: input.signal ?? AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) {
        return { title: fallbackTitle, model: targetModel, fallback: true };
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const rawTitle = data.choices?.[0]?.message?.content ?? '';
      const cleaned = sanitizeGeneratedTitle(rawTitle, maxLen);
      if (cleaned === '') {
        return { title: fallbackTitle, model: targetModel, fallback: true };
      }
      return { title: cleaned, model: targetModel, fallback: false };
    } catch {
      return { title: fallbackTitle, model: targetModel, fallback: true };
    }
  }

  /** 执行网络搜索请求（兼容 DeepSeek Tools Search 协议）。 */
  async searchWeb(
    params: unknown,
    options: { signal?: AbortSignal; apiKeyOverride?: string } = {},
  ): Promise<WebSearchResult> {
    const validated = validateSearchParams(params);
    const resolved = await this.resolveForRequest();
    const baseUrl =
      resolved?.baseUrl ||
      this.store.get().baseUrl ||
      this.config.upstreamBaseUrl ||
      'https://api.deepseek.com/v1';
    const apiKey =
      (options.apiKeyOverride && options.apiKeyOverride.trim()) ||
      this.store.get().apiKey ||
      this.config.upstreamApiKey;
    return executeWebSearch(this.transport, {
      baseUrl,
      apiKey,
      params: validated,
      mockUpstream: this.config.mockUpstream,
      signal: options.signal,
    });
  }

  /** 执行网页抓取请求（兼容 DeepSeek Tools Fetch 协议）。 */
  async fetchWeb(
    params: unknown,
    options: { signal?: AbortSignal; apiKeyOverride?: string } = {},
  ): Promise<WebFetchResult> {
    const validated = validateFetchParams(params);
    const resolved = await this.resolveForRequest();
    const baseUrl =
      resolved?.baseUrl ||
      this.store.get().baseUrl ||
      this.config.upstreamBaseUrl ||
      'https://api.deepseek.com/v1';
    const apiKey =
      (options.apiKeyOverride && options.apiKeyOverride.trim()) ||
      this.store.get().apiKey ||
      this.config.upstreamApiKey;
    return executeWebFetch(this.transport, {
      baseUrl,
      apiKey,
      params: validated,
      mockUpstream: this.config.mockUpstream,
      signal: options.signal,
    });
  }

  async testConnection(withChat: boolean): Promise<TestResult> {
    const started: number = Date.now();
    const current: ModelSettings = this.store.get();
    const proxyBaseUrl: string =
      normalizeBaseUrl(current.baseUrl) || normalizeBaseUrl(this.config.upstreamBaseUrl);
    const proxyModel: string = current.model || this.config.defaultModel;

    const proxyDiag: TestGroupDiagnostic = {
      ok: false,
      baseUrl: proxyBaseUrl,
      model: proxyModel,
      status: null,
      latencyMs: 0,
      error: null,
    };

    let modelCount: number | null = null;
    let chatReply: string | null = null;

    // 1. 预检 Proxy 组 (面向客户端的主对话上游)
    const proxyStart = Date.now();
    try {
      const models: ModelInfo[] = await this.listModels(true);
      modelCount = models.length;
      proxyDiag.ok = true;
      proxyDiag.status = 200;

      if (withChat) {
        const { response } = await this.sendChat(
          {
            model: proxyModel,
            messages: [{ role: 'user', content: '只回复两个字：正常' }],
            stream: false,
            max_tokens: 64,
          },
          { signal: AbortSignal.timeout(30_000), modelOverride: proxyModel },
        );
        proxyDiag.status = response.status;
        const text: string = await response.text();
        if (!response.ok) {
          throw new Error(`对话测试失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
        }
        try {
          const parsed = JSON.parse(text) as {
            choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
          };
          const message = parsed.choices?.[0]?.message;
          chatReply = message?.content || message?.reasoning_content || '(空回复)';
        } catch {
          chatReply = text.slice(0, 120);
        }
      }
    } catch (error) {
      proxyDiag.ok = false;
      proxyDiag.error = error instanceof Error ? error.message : String(error);
    }
    proxyDiag.latencyMs = Date.now() - proxyStart;

    // 2. 预检 Memory 组 (内核记忆处理模型)
    let memoryDiag: TestGroupDiagnostic;
    if (current.memoryReuseProxy !== false) {
      memoryDiag = {
        reused: true,
        ok: proxyDiag.ok,
        baseUrl: proxyBaseUrl,
        model: proxyModel,
        status: proxyDiag.status,
        latencyMs: proxyDiag.latencyMs,
        error: proxyDiag.error,
      };
    } else {
      const memStart = Date.now();
      const memBaseUrl = normalizeBaseUrl(current.memoryBaseUrl || proxyBaseUrl);
      const memModel = current.memoryModel || proxyModel;
      memoryDiag = {
        reused: false,
        ok: false,
        baseUrl: memBaseUrl,
        model: memModel,
        status: null,
        latencyMs: 0,
        error: null,
      };
      try {
        const memUrl = modelsUrl(memBaseUrl, current.modelsPath || '/models');
        const memHeaders: Record<string, string> = {
          'content-type': 'application/json',
          ...(await this.authHeaders(true)),
        };
        const resp = await this.transport(memUrl, {
          method: 'GET',
          headers: memHeaders,
          signal: AbortSignal.timeout(15_000),
        });
        memoryDiag.status = resp.status;
        if (!resp.ok) {
          const errDetail = await resp.text().catch(() => '');
          throw new Error(`Memory 组列表请求失败（HTTP ${resp.status}）：${errDetail.slice(0, 200)}`);
        }
        memoryDiag.ok = true;
      } catch (err) {
        memoryDiag.ok = false;
        memoryDiag.error = err instanceof Error ? err.message : String(err);
      }
      memoryDiag.latencyMs = Date.now() - memStart;
    }

    const overallOk = proxyDiag.ok && memoryDiag.ok;

    return {
      ok: overallOk,
      baseUrl: proxyBaseUrl,
      model: proxyModel,
      modelCount,
      status: proxyDiag.status,
      latencyMs: Date.now() - started,
      chat: chatReply,
      error: proxyDiag.error || memoryDiag.error || null,
      proxyGroup: proxyDiag,
      memoryGroup: memoryDiag,
    };
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
 *   · 剥离 `-内部` 后缀；非内部版本优先覆盖
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

export function extractTitleSourceText(input: Pick<TitleGenerationInput, 'prompt' | 'messages'>): string {
  if (typeof input.prompt === 'string' && input.prompt.trim() !== '') {
    return input.prompt.trim();
  }
  if (!Array.isArray(input.messages)) return '';
  for (const msg of input.messages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text !== '') return text;
    }
  }
  return '';
}

export function buildFallbackTitle(sourceText: string, maxLength = 20): string {
  const singleLine = sourceText.replace(/\s+/g, ' ').trim();
  if (singleLine === '') return '新对话';
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}...` : singleLine;
}

export function sanitizeGeneratedTitle(raw: string, maxLength = 20): string {
  let cleaned = (raw ?? '')
    .split(/\r?\n/)[0]
    .replace(/^#+\s*/, '')
    .replace(/^标题[:：]\s*/i, '')
    .replace(/^["'“”‘’《》【】\[\]]+|["'“”‘’《》【】\[\]。.！!？?：:；;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength).trim();
  }
  return cleaned;
}
