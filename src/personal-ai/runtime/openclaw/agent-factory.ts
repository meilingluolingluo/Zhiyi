/**
 * OpenClaw Agent 工厂：使用知忆配置的模型描述、系统指令、StreamFn 与 Tool 策略钩子装配 Agent 实例。
 * 不启用 OpenClaw Session 持久化，由知忆 BusinessTask/Execution/ContextBuilder 掌控上下文与状态。
 */
import type { Logger } from '../../../logger';
import type { AgentProfile } from '../../../types';
import type { ModelAdapter, TokenUsage } from '../../adapters/model/model-adapter';
import { Agent } from '../../vendor/openclaw/agent-core/agent.js';
import type { Model } from '../../vendor/openclaw/llm-core/types.js';
import { compactAgentMessagesIfNeeded } from './message-adapter';
import { createZhiyiStreamFn } from './model-stream-adapter';
import { createOpenClawToolBindings } from './tool-adapter';
import type { ZhiyiToolGateway } from './tool-gateway';
import { resolveAgentAllowedTools } from './tool-gateway';
import type { BusinessTask } from '../../domain/types';
import type { ExecutionTask } from '../../task/task-repository';
import type { PersonalAIIdentity } from '../../identity/identity-manager';
import type { ZhiyiToolContext } from './types';

export interface CreateOpenClawAgentParams {
  modelName: string;
  systemPrompt: string;
  agentProfile: AgentProfile;
  task: BusinessTask;
  execution: ExecutionTask;
  identity: PersonalAIIdentity;
  modelAdapter: ModelAdapter;
  toolGateway: ZhiyiToolGateway;
  logger: Logger;
  onUsage?: (usage: TokenUsage) => void;
  maxContextTokens?: number;
  getTurnCount: () => number;
}

export function buildZhiyiModelDescriptor(modelName: string): Model {
  return {
    id: modelName,
    name: modelName,
    api: 'openai-completions',
    provider: 'zhiyi-model-adapter',
    baseUrl: 'managed-by-zhiyi-model-adapter',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

export function createZhiyiOpenClawAgent(params: CreateOpenClawAgentParams): Agent {
  const allowedTools = resolveAgentAllowedTools({ agent: params.agentProfile });
  const toolCtx: ZhiyiToolContext = {
    userId: params.identity.user_id,
    agent: params.agentProfile,
    task: params.task,
    execution: params.execution,
    identity: params.identity,
    allowedTools,
  };

  const configuredMaxTurns = params.agentProfile.backend_config?.max_turns;
  const maxTurns: number =
    typeof configuredMaxTurns === 'number' && Number.isInteger(configuredMaxTurns)
      ? Math.min(Math.max(configuredMaxTurns, 1), 20)
      : 6;

  const configuredToolExec = params.agentProfile.backend_config?.tool_execution;
  const toolExecution =
    configuredToolExec === 'sequential' || configuredToolExec === 'parallel'
      ? configuredToolExec
      : 'parallel';

  const toolBindings = createOpenClawToolBindings(params.toolGateway, toolCtx, {
    maxTurns,
    getTurnCount: params.getTurnCount,
  });

  const streamFn = createZhiyiStreamFn({
    modelAdapter: params.modelAdapter,
    logger: params.logger,
    onUsage: params.onUsage,
  });

  const contextBudget = params.maxContextTokens ?? 64_000;

  return new Agent({
    initialState: {
      systemPrompt: params.systemPrompt,
      model: buildZhiyiModelDescriptor(params.modelName),
      thinkingLevel: 'off',
      tools: toolBindings.tools,
    },
    streamFn,
    toolExecution,
    beforeToolCall: toolBindings.beforeToolCall,
    resolveDeferredTool: toolBindings.resolveDeferredTool,
    transformContext: async (messages) =>
      compactAgentMessagesIfNeeded(messages, contextBudget),
  });
}
