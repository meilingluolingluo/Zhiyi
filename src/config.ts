/** 应用配置：全部从环境变量读取，敏感信息不落盘、不硬编码。 */

export interface Identity {
  user_id: string;
  agent_id: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  defaultModel: string;
  memoryEnabled: boolean;
  memoryAutoExtract: boolean;
  memoryMaxItems: number;
  memoryTokenBudget: number;
  extractMinConfidence: number;
  apiKeys: Record<string, Identity>;
  mockUpstream: boolean;
  upstreamTimeoutMs: number;
  defaultIdentity: Identity;
  logSilent: boolean;
  /** 运行期模型服务设置文件路径。 */
  settingsPath: string;
  /** 设置接口管理令牌；为空时仅允许 loopback 访问。 */
  settingsToken: string;
}

/** 开箱即用的开发 Key，README 中有完整清单。 */
export const DEFAULT_API_KEYS: Record<string, Identity> = {
  'dev-key-developer': { user_id: 'u1', agent_id: 'developer' },
  'dev-key-researcher': { user_id: 'u1', agent_id: 'researcher' },
  'dev-key-user2': { user_id: 'u2', agent_id: 'developer' },
};

function asBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function asNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed: number = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function asString(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function parseApiKeys(raw: string | undefined): Record<string, Identity> {
  if (!raw || raw.trim() === '') return { ...DEFAULT_API_KEYS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_API_KEYS };
    }
    const result: Record<string, Identity> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const userId: unknown = item.user_id;
      const agentId: unknown = item.agent_id;
      if (typeof userId === 'string' && userId && typeof agentId === 'string' && agentId) {
        result[key] = { user_id: userId, agent_id: agentId };
      }
    }
    return Object.keys(result).length > 0 ? result : { ...DEFAULT_API_KEYS };
  } catch {
    return { ...DEFAULT_API_KEYS };
  }
}

/** 把 base URL 规整为完整的 /v1/chat/completions 端点。 */
export function completionsUrl(baseUrl: string): string {
  const base: string = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/v1/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * 读取配置。env 参数可显式传入空对象，避免测试受宿主环境变量干扰。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawBaseUrl: string = asString(env.MULTICA_BASE_URL, '');
  const explicitMock: boolean = asBoolean(env.MOCK_UPSTREAM, false);
  const mockUpstream: boolean = explicitMock || rawBaseUrl === '';

  return {
    port: asNumber(env.PORT, 8787),
    databaseUrl: asString(env.DATABASE_URL, './data/memory.db'),
    upstreamBaseUrl: rawBaseUrl === '' ? 'http://mock-upstream.local' : rawBaseUrl,
    upstreamApiKey: asString(env.MULTICA_API_KEY, ''),
    defaultModel: asString(env.DEFAULT_MODEL, 'mock-gpt'),
    memoryEnabled: asBoolean(env.MEMORY_ENABLED, true),
    memoryAutoExtract: asBoolean(env.MEMORY_AUTO_EXTRACT, true),
    memoryMaxItems: asNumber(env.MEMORY_MAX_ITEMS, 5),
    memoryTokenBudget: asNumber(env.MEMORY_TOKEN_BUDGET, 800),
    extractMinConfidence: asNumber(env.EXTRACT_MIN_CONFIDENCE, 0.6),
    apiKeys: parseApiKeys(env.API_KEYS),
    mockUpstream,
    upstreamTimeoutMs: asNumber(env.UPSTREAM_TIMEOUT_MS, 30000),
    defaultIdentity: {
      user_id: asString(env.DEFAULT_USER_ID, 'u1'),
      agent_id: asString(env.DEFAULT_AGENT_ID, 'developer'),
    },
    logSilent: asBoolean(env.LOG_SILENT, false),
    settingsPath: asString(env.ZHIYI_SETTINGS_PATH, './data/model-settings.json'),
    settingsToken: asString(env.ZHIYI_SETTINGS_TOKEN, ''),
  };
}
