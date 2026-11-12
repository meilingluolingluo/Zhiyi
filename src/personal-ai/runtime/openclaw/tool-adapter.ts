/**
 * Tool 适配器：把知忆 `ZhiyiToolGateway` 的安全工具转换为 OpenClaw `AgentTool[]`，
 * 并提供 `beforeToolCall` 与 `resolveDeferredTool` 策略拦截钩子，确保：
 * - 模型仅看到白名单允许的工具定义
 * - 模型即使尝试调用未授权工具或恶意参数，也会被 PolicyChecker / TypeBox Schema 拦截并回传错误 ToolResult
 */
import type {
  AgentLoopConfig,
  AgentTool,
  AgentToolResult,
} from '../../vendor/openclaw/agent-core/types.js';
import type { TSchema } from 'typebox';
import {
  redactSensitiveText,
  ToolPolicyDeniedError,
  type ZhiyiToolGateway,
} from './tool-gateway';
import type { ZhiyiToolContext, ZhiyiToolDefinition } from './types';

function toOpenClawAgentTool(
  gateway: ZhiyiToolGateway,
  toolDef: ZhiyiToolDefinition,
  ctx: ZhiyiToolContext,
): AgentTool<TSchema, Record<string, unknown>> {
  return {
    name: toolDef.name,
    label: toolDef.label,
    description: toolDef.description,
    parameters: toolDef.parameters,
    ...(toolDef.executionMode ? { executionMode: toolDef.executionMode } : {}),
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      const normalizedParams: Record<string, unknown> =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      try {
        const result = await gateway.executeTool(ctx, toolDef.name, normalizedParams, signal);
        return {
          content: [{ type: 'text', text: result.text }],
          details: result.details ?? {},
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        const rawMsg = error instanceof Error ? error.message : String(error);
        throw new Error(redactSensitiveText(rawMsg));
      }
    },
  };
}

export interface OpenClawToolBindings {
  tools: AgentTool[];
  beforeToolCall: NonNullable<AgentLoopConfig['beforeToolCall']>;
  resolveDeferredTool: NonNullable<AgentLoopConfig['resolveDeferredTool']>;
}

export function createOpenClawToolBindings(
  gateway: ZhiyiToolGateway,
  ctx: ZhiyiToolContext,
  options: { maxTurns: number; getTurnCount: () => number },
): OpenClawToolBindings {
  const visibleTools: AgentTool[] = [];
  for (const def of gateway.listRegisteredTools()) {
    const decision = gateway.checkPolicy(ctx, def.name);
    if (decision.allowed) {
      visibleTools.push(toOpenClawAgentTool(gateway, def, ctx));
    }
  }

  const resolveDeferredTool: NonNullable<AgentLoopConfig['resolveDeferredTool']> = async ({
    toolCall,
  }) => {
    const decision = gateway.checkPolicy(ctx, toolCall.name, toolCall.arguments);
    if (!decision.allowed) {
      throw new ToolPolicyDeniedError(decision.reason ?? `无权调用工具 ${toolCall.name}`);
    }
    const registered = gateway.getTool(toolCall.name);
    return registered ? toOpenClawAgentTool(gateway, registered, ctx) : undefined;
  };

  const beforeToolCall: NonNullable<AgentLoopConfig['beforeToolCall']> = async ({
    toolCall,
    args,
  }) => {
    if (options.getTurnCount() >= options.maxTurns) {
      return {
        block: true,
        reason: `已达到最大推理轮次上限（${options.maxTurns}），请停止调用工具并基于已有结果直接回复。`,
      };
    }
    const decision = gateway.checkPolicy(ctx, toolCall.name, args);
    if (!decision.allowed) {
      return {
        block: true,
        reason: decision.reason ?? `权限不足：无法调用工具 ${toolCall.name}`,
      };
    }
    return undefined;
  };

  return {
    tools: visibleTools,
    beforeToolCall,
    resolveDeferredTool,
  };
}
