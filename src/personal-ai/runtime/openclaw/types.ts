/**
 * 知忆与 OpenClaw Agent Core 集成层的共享类型定义。
 */
import type { TSchema } from 'typebox';
import type { AppConfig } from '../../../config';
import type { Logger } from '../../../logger';
import type { AgentProfile } from '../../../types';
import type { ModelAdapter, TokenUsage } from '../../adapters/model/model-adapter';
import type { BusinessTask } from '../../domain/types';
import type { PersonalAIIdentity } from '../../identity/identity-manager';
import type { BusinessTaskManager } from '../../task/business-task-manager';
import type { ExecutionTask } from '../../task/task-repository';

export interface OpenClawBackendConfig {
  runtime: 'openclaw' | 'simple_llm';
  allowed_tools?: string[];
  max_turns?: number;
  tool_execution?: 'sequential' | 'parallel';
}

export interface ZhiyiToolContext {
  userId: string;
  agent: AgentProfile;
  task: BusinessTask;
  execution: ExecutionTask;
  identity: PersonalAIIdentity;
  allowedTools: ReadonlySet<string>;
}

export interface ZhiyiToolExecutionResult {
  text: string;
  details?: Record<string, unknown>;
}

export interface ZhiyiToolDefinition<TParams extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  executionMode?: 'sequential' | 'parallel';
  execute: (
    ctx: ZhiyiToolContext,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ZhiyiToolExecutionResult>;
}

export interface ZhiyiPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface OpenClawRunOptions {
  /** 已由 ContextBuilder/Runtime 构建好的系统消息或上下文（Agent Runner 不自行查业务 DB）。 */
  prebuiltSystemMessage?: string;
  signal?: AbortSignal;
  modelOverride?: string;
  onUsage?: (usage: TokenUsage) => void;
  rethrowOnError?: boolean;
  /** 可选上下文裁剪上限（估计 token 数）。 */
  maxContextTokens?: number;
}

export interface OpenClawAgentRunnerDeps {
  config: AppConfig;
  modelAdapter: ModelAdapter;
  businessTaskManager: BusinessTaskManager;
  toolGateway: import('./tool-gateway').ZhiyiToolGateway;
  logger: Logger;
}

export function isOpenClawAgent(agent: Pick<AgentProfile, 'execution_backend' | 'backend_config'>): boolean {
  return (
    agent.execution_backend === 'direct_llm' &&
    agent.backend_config?.runtime === 'openclaw'
  );
}
