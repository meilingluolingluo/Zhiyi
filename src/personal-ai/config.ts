/**
 * Personal AI Runtime 独立配置。
 *
 * 刻意与 src/config.ts 分开：现有 .env.example / AppConfig 的 16 个变量契约
 * 由回归测试锁定，不因本次升级变动。新增变量放在 .env.personal-ai.example。
 *
 * 重要澄清：历史变量 MULTICA_BASE_URL 实际是「模型代理上游地址」，
 * 与 MultiCA CLI 无关。模型配置沿用 AppConfig，CLI 配置全部在下面的 multica 段。
 */
import { DEFAULT_API_KEYS, type Identity } from '../config';

export type PersonalAIProtocol = 'openai' | 'adp-v2';
export type ExecutionStatus =
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MulticaConfig {
  enabled: boolean;
  cliPath: string;
  workspace: string;
  cwd: string;
  daemonRequired: boolean;
  pollIntervalMs: number;
  commandTimeoutMs: number;
  maxConcurrentTasks: number;
  maxPolls: number;
  defaultAgent: string;
}

export interface PersonalAIConfig {
  enabled: boolean;
  protocol: PersonalAIProtocol;
  sharedSecret: string;
  signatureMaxAgeMs: number;
  apiKeys: Record<string, Identity>;
  streamMaxMs: number;
  agentKeywords: string[];
  adpHealthUrl: string;
  modelBaseUrlOverride: string;
  modelApiKeyOverride: string;
  multica: MulticaConfig;
  /** 可选：启用单步结构化 LLM 意图分类（不从 .env.personal-ai 强制要求新字段）。 */
  llmIntentEnabled?: boolean;
}

const DEFAULT_AGENT_KEYWORDS: readonly string[] = [
  '代码', '仓库', 'repo', '代码库', '重构', '实现', '修复', 'debug', '编程',
  '写代码', '测试', '单测', '分析代码', '架构分析', '提交', 'pr', 'pull request',
  '调研', '评估', 'benchmark', '扫描', '排查', '故障', '部署脚本', '自动化任务',
  'code review', '重构建议', '性能分析',
];

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed: number = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function str(value: string | undefined, fallback = ''): string {
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function parseKeys(raw: string | undefined): Record<string, Identity> {
  if (!raw || raw.trim() === '') return { ...DEFAULT_API_KEYS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_API_KEYS };
    const result: Record<string, Identity> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      if (typeof item.user_id === 'string' && item.user_id && typeof item.agent_id === 'string' && item.agent_id) {
        result[key] = { user_id: item.user_id, agent_id: item.agent_id };
      }
    }
    return Object.keys(result).length > 0 ? result : { ...DEFAULT_API_KEYS };
  } catch {
    return { ...DEFAULT_API_KEYS };
  }
}

function parseKeywords(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [...DEFAULT_AGENT_KEYWORDS];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const items: string[] = parsed
        .filter((item: unknown): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item: string): string => item.trim());
      if (items.length > 0) return items;
    }
  } catch {
    // 非 JSON 时按逗号分隔的纯文本处理
  }
  return raw.split(',').map((item: string): string => item.trim()).filter(Boolean);
}

export function loadPersonalAIConfig(env: NodeJS.ProcessEnv = process.env): PersonalAIConfig {
  const protocol: string = str(env.PERSONAL_AI_PROTOCOL, 'openai').toLowerCase();
  return {
    enabled: bool(env.PERSONAL_AI_ENABLED, true),
    protocol: protocol === 'adp-v2' ? 'adp-v2' : 'openai',
    sharedSecret: str(env.PERSONAL_AI_SHARED_SECRET),
    signatureMaxAgeMs: num(env.PERSONAL_AI_SIGNATURE_MAX_AGE_MS, 300000),
    apiKeys: parseKeys(env.PERSONAL_AI_API_KEYS),
    streamMaxMs: num(env.PERSONAL_AI_STREAM_MAX_MS, 120000),
    agentKeywords: parseKeywords(env.PERSONAL_AI_AGENT_KEYWORDS),
    adpHealthUrl: str(env.PERSONAL_AI_ADP_HEALTH_URL),
    modelBaseUrlOverride: str(env.MODEL_BASE_URL),
    modelApiKeyOverride: str(env.MODEL_API_KEY),
    multica: {
      enabled: bool(env.MULTICA_ENABLED, false),
      // 默认通过 PATH 查找，不硬编码本机绝对路径。
      cliPath: str(env.MULTICA_CLI_PATH, 'multica'),
      workspace: str(env.MULTICA_WORKSPACE),
      cwd: str(env.MULTICA_CLI_CWD, process.cwd()),
      daemonRequired: bool(env.MULTICA_DAEMON_REQUIRED, true),
      pollIntervalMs: num(env.MULTICA_POLL_INTERVAL_MS, 3000),
      commandTimeoutMs: num(env.MULTICA_COMMAND_TIMEOUT_MS, 30000),
      maxConcurrentTasks: Math.max(1, num(env.MULTICA_MAX_CONCURRENT_TASKS, 3)),
      maxPolls: Math.max(1, num(env.MULTICA_MAX_POLLS, 200)),
      defaultAgent: str(env.MULTICA_DEFAULT_AGENT),
    },
    llmIntentEnabled: false,
  };
}
