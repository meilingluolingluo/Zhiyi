/**
 * 知忆 Tool Gateway 与最小 PolicyChecker 安全边界：
 * - 工具白名单校验（仅允许已注册的安全只读工具，且受 Agent.backend_config.allowed_tools 约束）
 * - Agent 身份与状态校验
 * - 用户与资源归属强约束（工具查询强制注入服务端 identity.user_id，忽略外部传入用户字段）
 * - AbortSignal 取消传播
 * - 敏感凭据与内部错误脱敏，绝不回传上游 API Key / Secret / Token 给模型
 */
import { Type } from 'typebox';
import type { Logger } from '../../../logger';
import type { MemoryStore } from '../../../memories';
import { searchMemories } from '../../../search';
import type { GoalStore } from '../../domain/goal-store';
import type { BusinessTaskManager } from '../../task/business-task-manager';
import type { ImageGenerationResult } from '../../../upstream/service';
import type {
  ZhiyiPolicyDecision,
  ZhiyiToolContext,
  ZhiyiToolDefinition,
  ZhiyiToolExecutionResult,
} from './types';
import { isOpenClawAgent } from './types';

export const DEFAULT_SAFE_OPENCLAW_TOOLS: readonly string[] = [
  'memory_search',
  'task_list',
  'goal_list',
  'image_generate',
];

const SECRET_VALUE_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{12,}|bce-[A-Za-z0-9/_-]{12,}|gh[po]_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{10,})\b/gi;

export function redactSensitiveText(text: string): string {
  return text.replace(SECRET_VALUE_PATTERN, '[REDACTED_CREDENTIAL]');
}

export class ToolPolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolPolicyDeniedError';
  }
}

export function resolveAgentAllowedTools(ctx: Pick<ZhiyiToolContext, 'agent'>): ReadonlySet<string> {
  const configured = ctx.agent.backend_config?.allowed_tools;
  if (Array.isArray(configured)) {
    return new Set(
      configured.filter((item): item is string => typeof item === 'string' && item.trim() !== ''),
    );
  }
  return new Set(DEFAULT_SAFE_OPENCLAW_TOOLS);
}

export interface ZhiyiToolGatewayDeps {
  memoryStore: MemoryStore;
  businessTaskManager: BusinessTaskManager;
  goalStore: GoalStore;
  logger: Logger;
  /** 可选生图执行函数（经知忆统一生图链路直连 OneAPI，不暴露上游凭据）。 */
  generateImages?: (
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; publicOrigin?: string },
  ) => Promise<ImageGenerationResult>;
  /** 可选扩展：测试或显式受控工具注入（仍受 allowlist 与 PolicyChecker 约束）。 */
  extraTools?: ZhiyiToolDefinition[];
}

export class ZhiyiToolGateway {
  private readonly registry = new Map<string, ZhiyiToolDefinition>();

  constructor(private readonly deps: ZhiyiToolGatewayDeps) {
    this.registerBuiltinSafeTools();
    for (const tool of deps.extraTools ?? []) {
      this.registerTool(tool);
    }
  }

  registerTool(tool: ZhiyiToolDefinition): void {
    this.registry.set(tool.name, tool);
  }

  getTool(name: string): ZhiyiToolDefinition | undefined {
    return this.registry.get(name);
  }

  listRegisteredTools(): ZhiyiToolDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * 策略校验（PolicyChecker）：
   * 1. Agent 必须为 active 且启用 OpenClaw 运行时
   * 2. 必须存在合法服务端 userId
   * 3. 工具必须存在于知忆安全工具注册表
   * 4. 工具必须在 Agent 白名单 allowedTools 内
   * 5. 若参数携带 user_id 且与服务端身份不符，直接拒绝跨用户访问
   */
  checkPolicy(
    ctx: ZhiyiToolContext,
    toolName: string,
    rawArgs?: unknown,
  ): ZhiyiPolicyDecision {
    if (!ctx.userId || ctx.userId.trim() === '') {
      return { allowed: false, reason: '权限不足：缺少有效的服务端用户身份' };
    }
    if (ctx.agent.status !== 'active') {
      return { allowed: false, reason: `权限不足：Agent ${ctx.agent.agent_id} 已禁用` };
    }
    if (!isOpenClawAgent(ctx.agent)) {
      return { allowed: false, reason: `权限不足：Agent ${ctx.agent.agent_id} 未授权使用 OpenClaw` };
    }
    if (!this.registry.has(toolName)) {
      return { allowed: false, reason: `工具拒绝：${toolName} 不在知忆安全工具白名单内` };
    }
    if (!ctx.allowedTools.has(toolName)) {
      return {
        allowed: false,
        reason: `权限不足：Agent ${ctx.agent.agent_id} 无权调用工具 ${toolName}`,
      };
    }
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      const candidate = rawArgs as Record<string, unknown>;
      if (
        typeof candidate.user_id === 'string' &&
        candidate.user_id.trim() !== '' &&
        candidate.user_id.trim() !== ctx.userId
      ) {
        return { allowed: false, reason: '权限不足：禁止跨用户访问他人资源' };
      }
    }
    return { allowed: true };
  }

  async executeTool(
    ctx: ZhiyiToolContext,
    toolName: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ZhiyiToolExecutionResult> {
    if (signal?.aborted) {
      throw new DOMException('工具执行已取消', 'AbortError');
    }
    const decision = this.checkPolicy(ctx, toolName, params);
    if (!decision.allowed) {
      this.deps.logger.warn(
        `[openclaw-tool-gateway] 拒绝工具调用 user=${ctx.userId} agent=${ctx.agent.agent_id} tool=${toolName}: ${decision.reason}`,
      );
      throw new ToolPolicyDeniedError(decision.reason ?? '权限不足');
    }

    const tool = this.registry.get(toolName);
    if (!tool) {
      throw new ToolPolicyDeniedError(`工具 ${toolName} 未注册`);
    }

    const result = await tool.execute(ctx, params, signal);
    if (signal?.aborted) {
      throw new DOMException('工具执行已取消', 'AbortError');
    }

    return {
      text: redactSensitiveText(result.text),
      details: result.details,
    };
  }

  private registerBuiltinSafeTools(): void {
    this.registerTool({
      name: 'memory_search',
      label: '检索个人记忆',
      description: '检索当前用户的知忆长期记忆（仅限本人有权限可见的记忆条目）。',
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 500, description: '检索关键词或问题' }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: '返回条数上限' })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const query = String(params.query ?? '').trim();
        const limit = typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), 10) : 5;
        const hits = searchMemories(this.deps.memoryStore, {
          query,
          user_id: ctx.userId,
          agent_id: ctx.agent.agent_id,
          project_id: ctx.task.project_id ?? undefined,
          limit,
        });
        if (hits.length === 0) {
          return {
            text: '未检索到匹配的用户长期记忆。',
            details: { count: 0 },
          };
        }
        const summary = hits
          .map(
            (hit, idx) =>
              `${idx + 1}. [${hit.memory.type}/${hit.memory.scope}] ${hit.memory.content.slice(0, 300)}`,
          )
          .join('\n');
        return {
          text: summary,
          details: { count: hits.length },
        };
      },
    });

    this.registerTool({
      name: 'task_list',
      label: '查看个人业务任务',
      description: '读取当前用户本人的个人业务任务列表，用于了解待办与在途工作。',
      parameters: Type.Object(
        {
          status: Type.Optional(
            Type.String({
              enum: [
                'draft',
                'pending',
                'ready',
                'assigned',
                'in_progress',
                'blocked',
                'completed',
                'failed',
                'cancelled',
              ],
            }),
          ),
          project_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const limit = typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), 20) : 10;
        const page = this.deps.businessTaskManager.list(ctx.userId, {
          status: typeof params.status === 'string' ? (params.status as never) : undefined,
          project_id: typeof params.project_id === 'string' ? params.project_id : undefined,
          limit,
        });
        if (page.items.length === 0) {
          return { text: '当前没有符合条件的业务任务。', details: { total: 0 } };
        }
        const text = page.items
          .map((item) => `- ${item.id}: ${item.title} [${item.status}, P${item.priority}]`)
          .join('\n');
        return { text, details: { total: page.total } };
      },
    });

    this.registerTool({
      name: 'goal_list',
      label: '查看个人目标',
      description: '读取当前用户本人的活跃目标列表。',
      parameters: Type.Object(
        {
          status: Type.Optional(
            Type.String({ enum: ['draft', 'active', 'paused', 'achieved', 'abandoned'] }),
          ),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const limit = typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), 20) : 10;
        const page = this.deps.goalStore.list(ctx.userId, {
          status: typeof params.status === 'string' ? (params.status as never) : 'active',
          limit,
        });
        if (page.items.length === 0) {
          return { text: '当前没有匹配的目标。', details: { total: 0 } };
        }
        const text = page.items
          .map((item) => `- ${item.id}: ${item.title} [${item.status}, P${item.priority}]`)
          .join('\n');
        return { text, details: { total: page.total } };
      },
    });

    this.registerTool({
      name: 'image_generate',
      label: '文生图 / 图像生成',
      description: '根据文本描述生成图片并返回可直接展示的 Markdown 图片链接。',
      parameters: Type.Object(
        {
          prompt: Type.String({ minLength: 1, maxLength: 4000 }),
          model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          size: Type.Optional(
            Type.String({ enum: ['auto', '1024x1024', '1536x1024', '1024x1536'] }),
          ),
          quality: Type.Optional(Type.String({ enum: ['auto', 'low', 'medium', 'high'] })),
          n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
          output_format: Type.Optional(Type.String({ enum: ['png', 'jpeg', 'webp'] })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params, signal) => {
        if (!this.deps.generateImages) {
          throw new Error('当前网关未配置生图执行能力');
        }
        const promptText = String(params.prompt ?? '').trim();
        const body: Record<string, unknown> = {
          prompt: promptText,
          n: typeof params.n === 'number' ? params.n : 1,
          size: typeof params.size === 'string' ? params.size : '1024x1024',
          quality: typeof params.quality === 'string' ? params.quality : 'medium',
          output_format: typeof params.output_format === 'string' ? params.output_format : 'png',
        };
        if (typeof params.model === 'string' && params.model.trim() !== '') {
          body.model = params.model.trim();
        }
        const res = await this.deps.generateImages(body, {
          signal,
          publicOrigin: ctx.publicOrigin,
        });
        if (!res.ok) {
          throw new Error(
            redactSensitiveText(`生图失败（HTTP ${res.status}）：${res.errorText ?? ''}`.slice(0, 300)),
          );
        }
        if (res.savedUrls.length === 0) {
          return { text: '上游未返回有效图片 URL 或 base64 数据。', details: { model: res.model, count: 0 } };
        }
        const markdown = res.savedUrls
          .map((u, idx) => `![${promptText.slice(0, 60)}${res.savedUrls.length > 1 ? ` #${idx + 1}` : ''}](${u})`)
          .join('\n\n');
        return {
          text: `已使用模型 ${res.model} 生成 ${res.savedUrls.length} 张图片，请在最终回复中原样包含以下 Markdown 图片：\n\n${markdown}`,
          details: { model: res.model, urls: res.savedUrls },
        };
      },
    });
  }
}
