/**
 * 知忆 · 运行期模型服务设置。
 *
 * 目标：API 地址 / Key / 认证方式 / 模型都可以在设置页自填，保存后立即生效，
 * 无需重启、无需改 .env。配置落盘到 data/model-settings.json（权限 600，不进 Git）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AuthMode = 'api_key' | 'ducx' | 'none';
/** settings = 以设置页选中的模型为准（忽略 ADP 固定的 ModelName）；request = 请求体优先。 */
export type ModelOverride = 'settings' | 'request';
/** auto = 合并 /v1/models 与 Baidu /openapi/v2/available_models；single = 只用 modelsPath。 */
export type ModelsSource = 'auto' | 'single';
export type UpstreamProtocol = 'auto' | 'openai_chat' | 'anthropic_messages' | 'openai_responses';

export interface ModelSettings {
  /** 是否覆盖 .env 中的静态上游配置。Mock 模式与测试默认 false。 */
  active: boolean;
  baseUrl: string;
  apiKey: string;
  authMode: AuthMode;
  model: string;
  /** 模型列表端点，相对 /v1；以 /openapi/ 或 /v1/ 开头时按根路径拼接。 */
  modelsPath: string;
  /** 是否额外合并 Baidu 富信息模型列表（可以拿到 /v1/models 之外的 auto 等模型）。 */
  modelsSource: ModelsSource;
  /** 上游出站协议：auto 按 URL/模型自动选路（Baidu OneAPI 走 /v1/messages 或 /v1/responses）。 */
  upstreamProtocol?: UpstreamProtocol;
  /** 可选生图模型（如 gpt-image-2）；为空时默认 gpt-image-2。 */
  imageModel?: string;
  /** 可选标题生成模型；为空时沿用当前默认对话模型。 */
  titleModel?: string;
  /** 是否向 DUCX data-report 上报来源（避免 OneAPI 判定未知来源）。 */
  ducxReport: boolean;
  ducxExecutable: string;
  modelOverride: ModelOverride;
  updatedAt: string;

  /** 内核记忆处理模型配置（提取、候选生成与演进） */
  memoryReuseProxy?: boolean;
  memoryBaseUrl?: string;
  memoryApiKey?: string;
  memoryAuthMode?: AuthMode;
  memoryModel?: string;
  memoryProtocol?: UpstreamProtocol;
}

export type SettingsPatch = Partial<Omit<ModelSettings, 'updatedAt'>>;

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  authMode: AuthMode;
  modelsPath: string;
  modelsSource: ModelsSource;
  description: string;
  defaultModel?: string;
  upstreamProtocol?: UpstreamProtocol;
}

export const DEFAULT_DUCX_EXECUTABLE: string = path.join(
  os.homedir(),
  '.baidu-cx/baidu-cx/bin/ducx',
);

/** Baidu OneAPI 扩展模型发现端点：包含 auto 等模型与能力元数据。 */
export const BAIDU_AVAILABLE_MODELS_PATH = '/openapi/v2/available_models';

/** 常用上游提供商预设配置。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'local-proxy',
    label: '百度 OneAPI (本机代理)',
    baseUrl: 'http://127.0.0.1:8787/v1',
    authMode: 'api_key',
    modelsPath: '/models',
    modelsSource: 'single',
    defaultModel: 'DeepSeek-V4-Flash-baidu-oneapi',
    upstreamProtocol: 'auto',
    description: '本机 8787 端口代理服务，零延迟直连',
  },
  {
    id: 'baidu-oneapi-ducx',
    label: '百度 OneAPI (企业统一服务)',
    baseUrl: 'https://oneapi-comate.baidu-int.com/v1',
    authMode: 'ducx',
    modelsPath: '/models',
    modelsSource: 'auto',
    defaultModel: 'DeepSeek-V4-Flash-baidu-oneapi',
    upstreamProtocol: 'auto',
    description: '企业统一接口，支持本机 DUCX 免密登录态或 API 令牌',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    authMode: 'api_key',
    modelsPath: '/models',
    modelsSource: 'auto',
    defaultModel: 'deepseek-chat',
    upstreamProtocol: 'openai_chat',
    description: 'DeepSeek 官方 API，高性价比推理与代码能力',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    authMode: 'api_key',
    modelsPath: '/models',
    modelsSource: 'auto',
    defaultModel: 'gpt-4o',
    upstreamProtocol: 'openai_chat',
    description: 'OpenAI 官方标准 API 服务',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    authMode: 'api_key',
    modelsPath: '/models',
    modelsSource: 'auto',
    defaultModel: 'claude-3-5-sonnet-20241022',
    upstreamProtocol: 'anthropic_messages',
    description: 'Anthropic 官方 Messages 协议 API',
  },
  {
    id: 'custom',
    label: '通用 OpenAI 兼容接口',
    baseUrl: '',
    authMode: 'api_key',
    modelsPath: '/models',
    modelsSource: 'auto',
    defaultModel: '',
    upstreamProtocol: 'auto',
    description: '适配任意标准第三方中转、Ollama、vLLM 或本地模型',
  },
];

/** 规整 Base URL：去掉尾部斜杠与误填的 /chat/completions 后缀。 */
export function normalizeBaseUrl(raw: string): string {
  let value: string = (raw ?? '').trim().replace(/\/+$/, '');
  if (value.endsWith('/chat/completions')) {
    value = value.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  return value;
}

/**
 * 拼接上游端点。
 * - modelsPath 以 http(s) 开头：原样使用；
 * - 以 /openapi/ 或 /v1/ 开头：拼到 origin 根（Baidu 的 available_models 走 /openapi/）；
 * - 其它（如 /models）：拼到 baseUrl 的 /v1 下。
 */
export function endpointUrl(baseUrl: string, pathname: string): string {
  const target: string = (pathname || '/models').trim();
  if (/^https?:\/\//i.test(target)) return target;
  const url: URL = new URL(normalizeBaseUrl(baseUrl));
  const root: string = `${url.protocol}//${url.host}`;
  const suffix: string = target.startsWith('/') ? target : `/${target}`;
  if (/^\/(openapi|v1)\//.test(suffix)) return `${root}${suffix}`;
  const basePath: string = url.pathname.replace(/\/+$/, '');
  if (basePath.endsWith('/v1')) return `${root}${basePath}${suffix}`;
  return `${root}/v1${suffix}`;
}

export function modelsUrl(baseUrl: string, modelsPath: string): string {
  return endpointUrl(baseUrl, modelsPath || '/models');
}

const AUTH_MODES: readonly AuthMode[] = ['api_key', 'ducx', 'none'];
const OVERRIDES: readonly ModelOverride[] = ['settings', 'request'];
const MODELS_SOURCES: readonly ModelsSource[] = ['auto', 'single'];
const UPSTREAM_PROTOCOLS: readonly UpstreamProtocol[] = [
  'auto',
  'openai_chat',
  'anthropic_messages',
  'openai_responses',
];

export function validateSettingsPatch(patch: SettingsPatch): string[] {
  const errors: string[] = [];
  if (patch.baseUrl !== undefined) {
    const value: string = normalizeBaseUrl(patch.baseUrl);
    if (value === '') errors.push('API Base URL 不能为空');
    else {
      try {
        const parsed: URL = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push('API Base URL 必须是 http(s) 地址');
        }
      } catch {
        errors.push('API Base URL 不是合法 URL');
      }
    }
  }
  if (patch.authMode !== undefined && !AUTH_MODES.includes(patch.authMode)) {
    errors.push('认证方式必须是 api_key / ducx / none');
  }
  if (patch.modelOverride !== undefined && !OVERRIDES.includes(patch.modelOverride)) {
    errors.push('模型覆盖策略必须是 settings / request');
  }
  if (patch.modelsSource !== undefined && !MODELS_SOURCES.includes(patch.modelsSource)) {
    errors.push('模型列表来源必须是 auto / single');
  }
  if (
    patch.upstreamProtocol !== undefined &&
    !UPSTREAM_PROTOCOLS.includes(patch.upstreamProtocol)
  ) {
    errors.push('上游协议必须是 auto / openai_chat / anthropic_messages / openai_responses');
  }
  if (patch.imageModel !== undefined && typeof patch.imageModel === 'string' && patch.imageModel.trim().length > 200) {
    errors.push('生图模型名称不能超过 200 字符');
  }
  if (patch.titleModel !== undefined && typeof patch.titleModel === 'string' && patch.titleModel.trim().length > 200) {
    errors.push('标题生成模型名称不能超过 200 字符');
  }
  if (patch.modelsPath !== undefined) {
    const value: string = patch.modelsPath.trim();
    if (value === '' || (!value.startsWith('/') && !/^https?:\/\//i.test(value))) {
      errors.push('模型列表路径必须以 / 开头，或填写完整 URL');
    }
  }
  if (patch.ducxExecutable !== undefined) {
    const value: string = patch.ducxExecutable.trim();
    if (value !== '' && !path.isAbsolute(value) && !value.startsWith('~')) {
      errors.push('DUCX 路径必须为绝对路径');
    }
  }
  if (patch.memoryReuseProxy !== undefined && typeof patch.memoryReuseProxy !== 'boolean') {
    errors.push('memoryReuseProxy 必须为布尔值');
  }
  if (patch.memoryBaseUrl !== undefined && patch.memoryBaseUrl.trim() !== '') {
    const value: string = normalizeBaseUrl(patch.memoryBaseUrl);
    try {
      const parsed: URL = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push('Memory API Base URL 必须是 http(s) 地址');
      }
    } catch {
      errors.push('Memory API Base URL 不是合法 URL');
    }
  }
  if (patch.memoryAuthMode !== undefined && !AUTH_MODES.includes(patch.memoryAuthMode)) {
    errors.push('Memory 认证方式必须是 api_key / ducx / none');
  }
  if (
    patch.memoryProtocol !== undefined &&
    !UPSTREAM_PROTOCOLS.includes(patch.memoryProtocol)
  ) {
    errors.push('Memory 上游协议必须是 auto / openai_chat / anthropic_messages / openai_responses');
  }
  return errors;
}

export function maskApiKey(key: string): string {
  const value: string = key ?? '';
  if (value === '') return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 3)}****${value.slice(-2)}`;
}

export interface PublicSettings {
  active: boolean;
  baseUrl: string;
  authMode: AuthMode;
  model: string;
  modelsPath: string;
  modelsSource: ModelsSource;
  upstreamProtocol: UpstreamProtocol;
  imageModel: string;
  titleModel: string;
  ducxReport: boolean;
  ducxExecutable: string;
  modelOverride: ModelOverride;
  updatedAt: string;
  apiKeySet: boolean;
  apiKeyMasked: string;

  // 内核记忆处理模型
  memoryReuseProxy: boolean;
  memoryBaseUrl: string;
  memoryAuthMode: AuthMode;
  memoryModel: string;
  memoryProtocol: UpstreamProtocol;
  memoryApiKeySet: boolean;
  memoryApiKeyMasked: string;
}

export function toPublicSettings(settings: ModelSettings): PublicSettings {
  return {
    active: settings.active,
    baseUrl: settings.baseUrl,
    authMode: settings.authMode,
    model: settings.model,
    modelsPath: settings.modelsPath,
    modelsSource: settings.modelsSource,
    upstreamProtocol: settings.upstreamProtocol ?? 'auto',
    imageModel: settings.imageModel ?? 'gpt-image-2',
    titleModel: settings.titleModel ?? '',
    ducxReport: settings.ducxReport,
    ducxExecutable: settings.ducxExecutable,
    modelOverride: settings.modelOverride,
    updatedAt: settings.updatedAt,
    apiKeySet: settings.apiKey.trim() !== '',
    apiKeyMasked: maskApiKey(settings.apiKey),

    memoryReuseProxy: settings.memoryReuseProxy !== false,
    memoryBaseUrl: settings.memoryBaseUrl ?? '',
    memoryAuthMode: settings.memoryAuthMode ?? 'api_key',
    memoryModel: settings.memoryModel ?? '',
    memoryProtocol: settings.memoryProtocol ?? 'auto',
    memoryApiKeySet: (settings.memoryApiKey ?? '').trim() !== '',
    memoryApiKeyMasked: maskApiKey(settings.memoryApiKey ?? ''),
  };
}

/** 文件持久化；filePath 为 null 时纯内存（测试 / Mock 模式）。 */
export class SettingsStore {
  private state: ModelSettings;

  constructor(
    private readonly filePath: string | null,
    initial: ModelSettings,
  ) {
    this.state = { ...initial };
    if (filePath && fs.existsSync(filePath)) {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const stored = raw as Partial<ModelSettings>;
          this.state = {
            ...initial,
            ...stored,
            // 避免历史文件把运行时字段写成非预期类型
            active: typeof stored.active === 'boolean' ? stored.active : initial.active,
            authMode: AUTH_MODES.includes(stored.authMode as AuthMode)
              ? (stored.authMode as AuthMode)
              : initial.authMode,
            modelOverride: OVERRIDES.includes(stored.modelOverride as ModelOverride)
              ? (stored.modelOverride as ModelOverride)
              : initial.modelOverride,
            modelsSource: MODELS_SOURCES.includes(stored.modelsSource as ModelsSource)
              ? (stored.modelsSource as ModelsSource)
              : initial.modelsSource,
            upstreamProtocol: UPSTREAM_PROTOCOLS.includes(stored.upstreamProtocol as UpstreamProtocol)
              ? (stored.upstreamProtocol as UpstreamProtocol)
              : (initial.upstreamProtocol ?? 'auto'),
            imageModel:
              typeof stored.imageModel === 'string'
                ? stored.imageModel.trim()
                : (initial.imageModel ?? 'gpt-image-2'),
            titleModel:
              typeof stored.titleModel === 'string'
                ? stored.titleModel.trim()
                : (initial.titleModel ?? ''),
            ducxReport: typeof stored.ducxReport === 'boolean' ? stored.ducxReport : initial.ducxReport,
            memoryReuseProxy:
              typeof stored.memoryReuseProxy === 'boolean'
                ? stored.memoryReuseProxy
                : (initial.memoryReuseProxy ?? true),
            memoryBaseUrl:
              typeof stored.memoryBaseUrl === 'string'
                ? normalizeBaseUrl(stored.memoryBaseUrl)
                : (initial.memoryBaseUrl ?? ''),
            memoryApiKey:
              typeof stored.memoryApiKey === 'string'
                ? stored.memoryApiKey
                : (initial.memoryApiKey ?? ''),
            memoryAuthMode:
              AUTH_MODES.includes(stored.memoryAuthMode as AuthMode)
                ? (stored.memoryAuthMode as AuthMode)
                : (initial.memoryAuthMode ?? 'api_key'),
            memoryModel:
              typeof stored.memoryModel === 'string'
                ? stored.memoryModel.trim()
                : (initial.memoryModel ?? ''),
            memoryProtocol:
              UPSTREAM_PROTOCOLS.includes(stored.memoryProtocol as UpstreamProtocol)
                ? (stored.memoryProtocol as UpstreamProtocol)
                : (initial.memoryProtocol ?? 'auto'),
          };
        }
      } catch {
        // 损坏的配置文件不应阻止网关启动，回落到 .env 初始值。
      }
    }
  }

  get(): ModelSettings {
    return { ...this.state };
  }

  update(patch: SettingsPatch): ModelSettings {
    const next: ModelSettings = {
      ...this.state,
      ...patch,
      // 任意一次显式写入都表示启用运行期覆盖；停用只能通过 reset()。
      active: patch.active ?? true,
      baseUrl: patch.baseUrl === undefined ? this.state.baseUrl : normalizeBaseUrl(patch.baseUrl),
      memoryReuseProxy:
        patch.memoryReuseProxy !== undefined
          ? patch.memoryReuseProxy
          : (this.state.memoryReuseProxy ?? true),
      memoryBaseUrl:
        patch.memoryBaseUrl === undefined
          ? (this.state.memoryBaseUrl ?? '')
          : normalizeBaseUrl(patch.memoryBaseUrl),
      memoryApiKey:
        patch.memoryApiKey === undefined
          ? (this.state.memoryApiKey ?? '')
          : patch.memoryApiKey,
      memoryAuthMode:
        patch.memoryAuthMode !== undefined && AUTH_MODES.includes(patch.memoryAuthMode)
          ? patch.memoryAuthMode
          : (this.state.memoryAuthMode ?? 'api_key'),
      memoryModel:
        patch.memoryModel === undefined
          ? (this.state.memoryModel ?? '')
          : patch.memoryModel.trim(),
      memoryProtocol:
        patch.memoryProtocol !== undefined && UPSTREAM_PROTOCOLS.includes(patch.memoryProtocol)
          ? patch.memoryProtocol
          : (this.state.memoryProtocol ?? 'auto'),
      updatedAt: new Date().toISOString(),
    };
    this.state = next;
    this.persist();
    return this.get();
  }

  /** 恢复到 .env 初始值，并停用运行期覆盖。 */
  reset(initial: ModelSettings): ModelSettings {
    this.state = { ...initial, active: false, updatedAt: new Date().toISOString() };
    this.persist();
    return this.get();
  }

  private persist(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows 或特殊文件系统可能不支持 chmod，文件仍在 data/ 下且不进 Git。
    }
  }
}
