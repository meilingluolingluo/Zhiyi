/** Agent Profile 存储、幂等种子与管理员运行配置管理。 */
import { Database } from './db';
import { DomainError } from './personal-ai/domain/types';
import {
  AGENT_STATUSES,
  EXECUTION_BACKENDS,
  type AgentAdminPatch,
  type AgentProfile,
  type AgentPublicProfile,
  type AgentStatus,
  type ExecutionBackend,
  type NewAgentProfile,
} from './types';

const SAFE_MULTICA_ASSIGNEE: RegExp = /^[A-Za-z0-9_ .+\-]{1,128}$/;
const SAFE_TOOL_NAME: RegExp = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_CHARS: RegExp = /[\u0000-\u001f\u007f]/;
const DIRECT_RUNTIMES: ReadonlySet<string> = new Set(['simple_llm', 'openclaw']);
const TOOL_EXEC_MODES: ReadonlySet<string> = new Set(['sequential', 'parallel']);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_CAPABILITIES = 30;
const MAX_CAPABILITY_LEN = 64;
const MAX_INSTRUCTIONS_LEN = 8000;
const MAX_MODEL_PREF_LEN = 200;
const MAX_CONCURRENCY_LIMIT = 100;

export const BUILTIN_AGENT_IDS: readonly string[] = ['developer', 'researcher'];

export const AGENT_PRIVILEGED_FIELDS: readonly string[] = [
  'capabilities',
  'execution_backend',
  'backend_config',
  'model_preference',
  'status',
  'instructions',
  'concurrency_limit',
];

interface SeedProfile {
  agent_id: string;
  name: string;
  role: string;
  description: string;
  core_memory: string;
  capabilities: string[];
  execution_backend: ExecutionBackend;
}

interface AgentRow {
  agent_id: string;
  name: string;
  role: string;
  description: string;
  core_memory: string;
  capabilities?: string;
  execution_backend?: string;
  backend_config?: string;
  model_preference?: string | null;
  status?: string;
  instructions?: string;
  concurrency_limit?: number;
  created_at: string;
  updated_at: string;
}

/** 内置两个角色；空库首次 seed 与 Migration 004 历史回填保持完全一致。 */
export const SEED_AGENTS: readonly SeedProfile[] = [
  {
    agent_id: 'developer',
    name: 'Developer',
    role: '后端研发工程师',
    description: '负责服务设计与编码实现，侧重技术栈、架构决策与历史 Bug 复盘',
    core_memory:
      '关注：技术栈、架构决策、可维护性、历史 Bug、故障复盘、代码规范。该 Agent 处理实现细节与工程落地。',
    capabilities: ['code', 'refactor', 'debug', 'architecture', 'test'],
    execution_backend: 'multica',
  },
  {
    agent_id: 'researcher',
    name: 'Researcher',
    role: '技术调研员',
    description: '负责技术方案调研与评估，侧重技术选型、方案对比与评估标准',
    core_memory:
      '关注：技术选型、方案对比、评估标准、性能数据、成本、最佳实践。该 Agent 处理调研与客观评估。',
    capabilities: ['research', 'analysis', 'evaluation', 'benchmark'],
    execution_backend: 'multica',
  },
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseCapabilities(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item: unknown): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseBackendConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rowToAgent(row: AgentRow): AgentProfile {
  const backend: ExecutionBackend = EXECUTION_BACKENDS.includes(
    row.execution_backend as ExecutionBackend,
  )
    ? (row.execution_backend as ExecutionBackend)
    : 'direct_llm';
  const status: AgentStatus = AGENT_STATUSES.includes(row.status as AgentStatus)
    ? (row.status as AgentStatus)
    : 'active';
  const concurrency: number = Number(row.concurrency_limit);

  return {
    agent_id: row.agent_id,
    name: row.name,
    role: row.role,
    description: row.description,
    core_memory: row.core_memory,
    capabilities: parseCapabilities(row.capabilities),
    execution_backend: backend,
    backend_config: parseBackendConfig(row.backend_config),
    model_preference: row.model_preference ?? null,
    status,
    instructions: row.instructions ?? '',
    concurrency_limit: Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 3,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toPublicAgentProfile(profile: AgentProfile): AgentPublicProfile {
  return {
    agent_id: profile.agent_id,
    name: profile.name,
    role: profile.role,
    description: profile.description,
    core_memory: profile.core_memory,
    capabilities: profile.capabilities,
    execution_backend: profile.execution_backend,
    status: profile.status,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

function validateCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new DomainError(
      400,
      'invalid_capabilities',
      `capabilities 必须为最多 ${MAX_CAPABILITIES} 项的字符串数组`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new DomainError(400, 'invalid_capabilities', 'capabilities 项必须为字符串');
    }
    const trimmed: string = item.trim();
    if (trimmed === '' || trimmed.length > MAX_CAPABILITY_LEN || CONTROL_CHARS.test(trimmed)) {
      throw new DomainError(
        400,
        'invalid_capabilities',
        `capabilities 项长度必须为 1-${MAX_CAPABILITY_LEN} 且不含控制字符`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function validateBackendConfig(value: unknown, backend: ExecutionBackend): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new DomainError(400, 'invalid_backend_config', 'backend_config 必须为普通 JSON 对象');
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new DomainError(400, 'invalid_backend_config', `backend_config 包含非法字段: ${key}`);
    }
  }
  const allowedKeys: ReadonlySet<string> =
    backend === 'multica'
      ? new Set(['assignee'])
      : new Set(['runtime', 'allowed_tools', 'max_turns', 'tool_execution']);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowedKeys.has(key)) {
      throw new DomainError(
        400,
        'invalid_backend_config',
        `${backend} 后端不支持 backend_config.${key}`,
      );
    }
  }
  if (backend === 'multica' && 'assignee' in value) {
    const assignee: unknown = value.assignee;
    if (assignee === null || assignee === '') return {};
    if (typeof assignee !== 'string' || !SAFE_MULTICA_ASSIGNEE.test(assignee.trim())) {
      throw new DomainError(400, 'invalid_backend_config', 'backend_config.assignee 格式非法');
    }
    return { assignee: assignee.trim() };
  }
  if (backend === 'direct_llm') {
    const cleaned: Record<string, unknown> = {};
    if ('runtime' in value && value.runtime !== undefined) {
      if (typeof value.runtime !== 'string' || !DIRECT_RUNTIMES.has(value.runtime)) {
        throw new DomainError(
          400,
          'invalid_backend_config',
          'backend_config.runtime 必须为 simple_llm | openclaw',
        );
      }
      cleaned.runtime = value.runtime;
    }
    if ('allowed_tools' in value && value.allowed_tools !== undefined) {
      if (!Array.isArray(value.allowed_tools) || value.allowed_tools.length > MAX_CAPABILITIES) {
        throw new DomainError(
          400,
          'invalid_backend_config',
          `backend_config.allowed_tools 必须为最多 ${MAX_CAPABILITIES} 项的工具名数组`,
        );
      }
      const seenTools = new Set<string>();
      const normalizedTools: string[] = [];
      for (const item of value.allowed_tools) {
        if (typeof item !== 'string' || !SAFE_TOOL_NAME.test(item.trim())) {
          throw new DomainError(
            400,
            'invalid_backend_config',
            'backend_config.allowed_tools 工具名格式非法（仅允许小写字母、数字和下划线）',
          );
        }
        const trimmed = item.trim();
        if (!seenTools.has(trimmed)) {
          seenTools.add(trimmed);
          normalizedTools.push(trimmed);
        }
      }
      cleaned.allowed_tools = normalizedTools;
    }
    if ('max_turns' in value && value.max_turns !== undefined) {
      if (
        typeof value.max_turns !== 'number' ||
        !Number.isInteger(value.max_turns) ||
        value.max_turns < 1 ||
        value.max_turns > 20
      ) {
        throw new DomainError(
          400,
          'invalid_backend_config',
          'backend_config.max_turns 必须为 1-20 的整数',
        );
      }
      cleaned.max_turns = value.max_turns;
    }
    if ('tool_execution' in value && value.tool_execution !== undefined) {
      if (typeof value.tool_execution !== 'string' || !TOOL_EXEC_MODES.has(value.tool_execution)) {
        throw new DomainError(
          400,
          'invalid_backend_config',
          'backend_config.tool_execution 必须为 sequential | parallel',
        );
      }
      cleaned.tool_execution = value.tool_execution;
    }
    return cleaned;
  }
  return {};
}

function validateModelPreference(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new DomainError(400, 'invalid_model_preference', 'model_preference 必须为字符串或 null');
  }
  const trimmed: string = value.trim();
  if (trimmed === '') return null;
  if (
    trimmed.length > MAX_MODEL_PREF_LEN ||
    CONTROL_CHARS.test(trimmed) ||
    /^https?:\/\//i.test(trimmed) ||
    /\s/.test(trimmed)
  ) {
    throw new DomainError(400, 'invalid_model_preference', 'model_preference 格式非法（仅允许模型标识名）');
  }
  return trimmed;
}

export class AgentStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 幂等写入内置 Profile。
   * 严格使用 INSERT OR IGNORE：只在空库首次初始化时写入默认 multica 配置，
   * 重启时绝不覆盖管理员已修改的 execution_backend / backend_config / capabilities 等运行配置。
   */
  seed(): void {
    const now: string = new Date().toISOString();
    for (const item of SEED_AGENTS) {
      this.db.run(
        `INSERT OR IGNORE INTO agents
         (agent_id, name, role, description, core_memory,
          capabilities, execution_backend, backend_config, model_preference,
          status, instructions, concurrency_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', NULL, 'active', '', 3, ?, ?)`,
        [
          item.agent_id,
          item.name,
          item.role,
          item.description,
          item.core_memory,
          JSON.stringify(item.capabilities),
          item.execution_backend,
          now,
          now,
        ],
      );
    }
  }

  /**
   * 兼容 V1 的基础 Profile 创建/同步：
   * - 新建时走表级默认（execution_backend = 'direct_llm'）；
   * - 冲突时仅更新 V1 基础元数据，绝不删除行，也不覆盖运行配置字段。
   */
  create(input: NewAgentProfile): AgentProfile {
    const now: string = new Date().toISOString();
    this.db.run(
      `INSERT INTO agents
       (agent_id, name, role, description, core_memory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         description = excluded.description,
         core_memory = excluded.core_memory,
         updated_at = excluded.updated_at`,
      [
        input.agent_id,
        input.name,
        input.role ?? '',
        input.description ?? '',
        input.core_memory ?? '',
        now,
        now,
      ],
    );
    return this.get(input.agent_id) as AgentProfile;
  }

  /** 管理员更新 Agent 元数据与运行配置（须由路由层 Admin Guard 鉴权后调用）。 */
  updateAdmin(agentId: string, patch: AgentAdminPatch): AgentProfile | undefined {
    return this.db.transaction((): AgentProfile | undefined => {
      const existing: AgentProfile | undefined = this.get(agentId);
      if (!existing) return undefined;

      const assignments: string[] = [];
      const params: unknown[] = [];

      const textFields: Array<['name' | 'role' | 'description' | 'core_memory', number, boolean]> = [
        ['name', 120, true],
        ['role', 120, false],
        ['description', 2000, false],
        ['core_memory', 4000, false],
      ];
      for (const [field, maxLen, nonEmpty] of textFields) {
        if (!(field in patch)) continue;
        const val: unknown = patch[field];
        if (typeof val !== 'string') {
          throw new DomainError(400, 'invalid_agent_field', `${field} 必须为字符串`);
        }
        const trimmed: string = val.trim();
        if (nonEmpty && trimmed === '') {
          throw new DomainError(400, 'invalid_agent_field', `${field} 不能为空`);
        }
        if (trimmed.length > maxLen) {
          throw new DomainError(400, 'invalid_agent_field', `${field} 长度不能超过 ${maxLen}`);
        }
        assignments.push(`${field} = ?`);
        params.push(trimmed);
      }

      if ('capabilities' in patch) {
        assignments.push('capabilities = ?');
        params.push(JSON.stringify(validateCapabilities(patch.capabilities)));
      }

      let nextBackend: ExecutionBackend = existing.execution_backend;
      if ('execution_backend' in patch) {
        const val: unknown = patch.execution_backend;
        if (typeof val !== 'string' || !EXECUTION_BACKENDS.includes(val as ExecutionBackend)) {
          throw new DomainError(
            400,
            'invalid_execution_backend',
            `execution_backend 必须为 ${EXECUTION_BACKENDS.join(' | ')}`,
          );
        }
        nextBackend = val as ExecutionBackend;
        assignments.push('execution_backend = ?');
        params.push(nextBackend);
        if (!('backend_config' in patch) && nextBackend !== existing.execution_backend) {
          assignments.push('backend_config = ?');
          params.push('{}');
        }
      }

      if ('backend_config' in patch) {
        const cleaned = validateBackendConfig(patch.backend_config, nextBackend);
        assignments.push('backend_config = ?');
        params.push(JSON.stringify(cleaned));
      }

      if ('model_preference' in patch) {
        assignments.push('model_preference = ?');
        params.push(validateModelPreference(patch.model_preference));
      }

      if ('status' in patch) {
        const val: unknown = patch.status;
        if (typeof val !== 'string' || !AGENT_STATUSES.includes(val as AgentStatus)) {
          throw new DomainError(400, 'invalid_status', `status 必须为 ${AGENT_STATUSES.join(' | ')}`);
        }
        assignments.push('status = ?');
        params.push(val);
      }

      if ('instructions' in patch) {
        const val: unknown = patch.instructions;
        if (typeof val !== 'string' || val.length > MAX_INSTRUCTIONS_LEN) {
          throw new DomainError(
            400,
            'invalid_instructions',
            `instructions 必须为不超过 ${MAX_INSTRUCTIONS_LEN} 字符的字符串`,
          );
        }
        assignments.push('instructions = ?');
        params.push(val);
      }

      if ('concurrency_limit' in patch) {
        const val: unknown = patch.concurrency_limit;
        if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > MAX_CONCURRENCY_LIMIT) {
          throw new DomainError(
            400,
            'invalid_concurrency_limit',
            `concurrency_limit 必须为 1-${MAX_CONCURRENCY_LIMIT} 的整数`,
          );
        }
        assignments.push('concurrency_limit = ?');
        params.push(val);
      }

      if (assignments.length === 0) return existing;

      assignments.push('updated_at = ?');
      params.push(new Date().toISOString(), agentId);
      this.db.run(`UPDATE agents SET ${assignments.join(', ')} WHERE agent_id = ?`, params);
      return this.get(agentId);
    });
  }

  list(): AgentProfile[] {
    return this.db.all<AgentRow>('SELECT * FROM agents ORDER BY agent_id ASC').map(rowToAgent);
  }

  get(agentId: string): AgentProfile | undefined {
    const row = this.db.get<AgentRow>('SELECT * FROM agents WHERE agent_id = ?', [agentId]);
    return row ? rowToAgent(row) : undefined;
  }
}
