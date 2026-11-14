/**
 * 全局共享类型定义。字段名与对外 API 保持一致（snake_case），
 * 避免层与层之间反复做字段映射。
 */

export type MemoryType = 'identity' | 'episodic' | 'semantic' | 'procedural' | 'working';
export type MemoryScope = 'personal' | 'agent' | 'project' | 'organization';
export type MemoryStatus = 'active' | 'archived' | 'superseded';
export type MemoryCategory =
  | 'profile_fact'
  | 'preference'
  | 'goal'
  | 'project_fact'
  | 'experience'
  | 'event'
  | 'general';
export type CandidateStatus = 'pending' | 'low_confidence' | 'approved' | 'rejected';

export const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  'pending',
  'low_confidence',
  'approved',
  'rejected',
];

export const MEMORY_TYPES: readonly MemoryType[] = [
  'identity',
  'episodic',
  'semantic',
  'procedural',
  'working',
];

export const MEMORY_SCOPES: readonly MemoryScope[] = [
  'personal',
  'agent',
  'project',
  'organization',
];

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'active',
  'archived',
  'superseded',
];

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'profile_fact',
  'preference',
  'goal',
  'project_fact',
  'experience',
  'event',
  'general',
];

/** 正式记忆记录。 */
export interface Memory {
  memory_id: string;
  user_id: string;
  agent_id: string | null;
  project_id: string | null;
  goal_id: string | null;
  task_id: string | null;
  type: MemoryType;
  scope: MemoryScope;
  category: MemoryCategory;
  status: MemoryStatus;
  content: string;
  source: string;
  confidence: number;
  evidence_trajectory_ids: string[];
  verified_by_user: boolean;
  expires_at: string | null;
  superseded_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 创建记忆的入参，user_id 由服务端解析后注入，客户端不可指定。 */
export interface NewMemory {
  user_id: string;
  agent_id?: string | null;
  project_id?: string | null;
  goal_id?: string | null;
  task_id?: string | null;
  type?: MemoryType;
  scope?: MemoryScope;
  category?: MemoryCategory;
  status?: MemoryStatus;
  content: string;
  source?: string;
  confidence?: number;
  evidence_trajectory_ids?: string[];
  verified_by_user?: boolean;
  expires_at?: string | null;
}

/** 记忆更新入参。 */
export interface MemoryPatch {
  content?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  category?: MemoryCategory;
  status?: MemoryStatus;
  agent_id?: string | null;
  project_id?: string | null;
  goal_id?: string | null;
  task_id?: string | null;
  source?: string;
  confidence?: number;
  evidence_trajectory_ids?: string[];
  verified_by_user?: boolean;
  expires_at?: string | null;
  superseded_by?: string | null;
  archived_at?: string | null;
}

/** 记忆列表过滤条件。 */
export interface MemoryFilters {
  agent_id?: string;
  project_id?: string;
  goal_id?: string;
  task_id?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  category?: MemoryCategory;
  status?: MemoryStatus;
  source?: string;
  include_archived?: boolean;
  limit?: number;
  offset?: number;
}

/** 检索命中项。 */
export interface SearchHit {
  memory: Memory;
  score: number;
  matched_keywords: string[];
  reasons: string[];
}

export type ExecutionBackend = 'direct_llm' | 'multica';
export type AgentStatus = 'active' | 'disabled';

export const EXECUTION_BACKENDS: readonly ExecutionBackend[] = ['direct_llm', 'multica'];
export const AGENT_STATUSES: readonly AgentStatus[] = ['active', 'disabled'];

/** Agent Profile。core_memory 中「关注：」后的词会影响检索加权。 */
export interface AgentProfile {
  agent_id: string;
  name: string;
  role: string;
  description: string;
  core_memory: string;
  capabilities: string[];
  execution_backend: ExecutionBackend;
  backend_config: Record<string, unknown>;
  model_preference: string | null;
  status: AgentStatus;
  instructions: string;
  concurrency_limit: number;
  created_at: string;
  updated_at: string;
}

/** 非管理员读取 Agent 时返回的脱敏视图（隐藏内部 backend_config / instructions / model_preference）。 */
export interface AgentPublicProfile {
  agent_id: string;
  name: string;
  role: string;
  description: string;
  core_memory: string;
  capabilities: string[];
  execution_backend: ExecutionBackend;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
}

export interface NewAgentProfile {
  agent_id: string;
  name: string;
  role?: string;
  description?: string;
  core_memory?: string;
}

export interface AgentAdminPatch {
  name?: string;
  role?: string;
  description?: string;
  core_memory?: string;
  capabilities?: unknown;
  execution_backend?: unknown;
  backend_config?: unknown;
  model_preference?: unknown;
  status?: unknown;
  instructions?: unknown;
  concurrency_limit?: unknown;
}

/** 对话轨迹。request / response 以 JSON 字符串形式存储。 */
export interface Trajectory {
  id: string;
  request_id: string;
  user_id: string;
  agent_id: string;
  session_id: string | null;
  task_id: string | null;
  project_id: string | null;
  model: string;
  request: string;
  response: string;
  status: string;
  created_at: string;
}

export interface NewTrajectory {
  request_id: string;
  user_id: string;
  agent_id: string;
  session_id?: string | null;
  task_id?: string | null;
  project_id?: string | null;
  model?: string;
  request?: string;
  response?: string;
  status?: string;
}

/** 候选记忆（自动提取产物，需人工 approve 才能进入正式记忆库）。 */
export interface MemoryCandidate {
  id: string;
  user_id: string;
  agent_id: string | null;
  project_id: string | null;
  goal_id: string | null;
  task_id: string | null;
  type: MemoryType;
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  source: string;
  trajectory_id: string | null;
  evidence_trajectory_ids?: string[];
  conflict_memory_id: string | null;
  confidence: number;
  status: CandidateStatus;
  created_memory_id: string | null;
  entities?: string[];
  evolution_relation?: string | null;
  created_at: string;
  updated_at: string;
}

/** 模型（或规则兜底）产出的单条提取结果。 */
export interface ExtractedCandidate {
  type: MemoryType;
  scope: MemoryScope;
  category?: MemoryCategory;
  content: string;
  confidence: number;
  reason: string;
  event?: 'ADD' | 'UPDATE' | 'SUPPLEMENT' | 'DELETE' | 'NONE';
  old_memory_id?: string | null;
  entities?: string[];
}

/** OpenAI Chat Completions 消息。保留索引签名以完整透传扩展字段。 */
export interface ChatMessage {
  role: string;
  content: string | null | Array<Record<string, unknown>>;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [key: string]: unknown;
}

/** OpenAI Chat Completions 请求体。 */
export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

/** 上游传输抽象：真实模式走 fetch，Mock 模式走进程内 handler。 */
export type UpstreamTransport = (url: string, init: RequestInit) => Promise<Response>;
