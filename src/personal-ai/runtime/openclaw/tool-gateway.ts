/**
 * 知忆 Tool Gateway 与 PolicyChecker 安全边界：
 * - 工具白名单校验（仅允许已注册的受控工具，且每次执行均实时读取 AgentStore 最新状态与授权列表）
 * - 用户身份强绑定（服务端 identity.user_id 注入查询与写入，拒绝跨用户参数）
 * - TypeBox 参数校验、AbortSignal 取消传播与敏感凭据脱敏
 * - 所有 Goal / Project / BusinessTask 操作统一经 work-operations 复用知忆业务层与状态机
 */
import { Type } from 'typebox';
import type { AgentStore } from '../../../agents';
import type { CandidateStore } from '../../../candidates';
import type { Logger } from '../../../logger';
import type { MemoryStore } from '../../../memories';
import {
  evolveMemoryWrite,
  MemoryConflictError,
  mutateMemoryWithGuard,
} from '../../../memory-evolution';
import { searchMemories } from '../../../search';
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type Memory,
  type MemoryCategory,
  type MemoryPatch,
  type MemoryScope,
  type MemoryType,
} from '../../../types';
import type { ImageGenerationResult } from '../../../upstream/service';
import type { WebFetchResult, WebSearchResult } from '../../../upstream/web-search';
import { DomainError } from '../../domain/types';
import type { GoalStore } from '../../domain/goal-store';
import type { ProjectStore } from '../../domain/project-store';
import {
  BUSINESS_TASK_STATUSES,
  GOAL_STATUSES,
  INITIAL_TASK_STATUSES,
  PROJECT_STATUSES,
} from '../../domain/types';
import {
  createGoalForUser,
  createProjectForUser,
  createTaskForUser,
  getTaskDetailForUser,
  listGoalsForUser,
  listProjectsForUser,
  listTasksForUser,
  updateGoalForUser,
  updateProjectForUser,
  updateTaskForUser,
  type WorkOperationsDeps,
} from '../../domain/work-operations';
import type { BusinessTaskManager } from '../../task/business-task-manager';
import type { TaskRepository } from '../../task/task-repository';
import { buildProjectProgressSummary } from '../../proactive/project-summary';
import type { ProactiveStore } from '../../proactive/proactive-store';
import type {
  ZhiyiPolicyDecision,
  ZhiyiToolContext,
  ZhiyiToolDefinition,
  ZhiyiToolExecutionResult,
} from './types';
import { isOpenClawAgent } from './types';

export const DEFAULT_SAFE_OPENCLAW_TOOLS: readonly string[] = [
  'memory_search',
  'memory_get',
  'memory_create',
  'memory_update',
  'memory_archive',
  'goal_list',
  'goal_create',
  'goal_update',
  'project_list',
  'project_create',
  'project_update',
  'project_summary',
  'proactive_notifications',
  'task_list',
  'task_detail',
  'task_executions',
  'task_create',
  'task_update',
  'image_generate',
  'web_search',
  'web_fetch',
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
  candidateStore?: CandidateStore;
  businessTaskManager: BusinessTaskManager;
  goalStore: GoalStore;
  projectStore: ProjectStore;
  agentStore: AgentStore;
  taskRepo?: TaskRepository;
  proactiveStore?: ProactiveStore;
  logger: Logger;
  /** 生图执行函数（经知忆统一生图链路直连上游，不暴露凭据）。 */
  generateImages?: (
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; publicOrigin?: string },
  ) => Promise<ImageGenerationResult>;
  /** 网络搜索执行函数（经知忆统一搜索链路，兼容 DeepSeek Tools 协议）。 */
  searchWeb?: (
    params: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<WebSearchResult>;
  /** 网页抓取执行函数（经知忆统一抓取链路，兼容 DeepSeek Tools 协议）。 */
  fetchWeb?: (
    params: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<WebFetchResult>;
  /** 扩展工具注入（仍受 allowlist 与 PolicyChecker 约束）。 */
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

  private workDeps(): WorkOperationsDeps {
    return {
      goalStore: this.deps.goalStore,
      projectStore: this.deps.projectStore,
      businessTaskManager: this.deps.businessTaskManager,
      agentStore: this.deps.agentStore,
      candidateStore: this.deps.candidateStore,
      memoryStore: this.deps.memoryStore,
    };
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
   * 动态策略校验（PolicyChecker）：
   * 1. 必须存在合法服务端 userId
   * 2. 每次均实时读取 AgentStore，确保管理员禁用 Agent 或收回工具权限后立即生效
   * 3. Agent 必须为 active 且启用 OpenClaw 运行时
   * 4. 工具必须已注册且同时被初始上下文与当前最新白名单允许
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

    const liveAgent = this.deps.agentStore.get(ctx.agent.agent_id);
    if (!liveAgent) {
      return { allowed: false, reason: `权限不足：Agent ${ctx.agent.agent_id} 不存在` };
    }
    if (liveAgent.status !== 'active') {
      return { allowed: false, reason: `权限不足：Agent ${liveAgent.agent_id} 已禁用` };
    }
    if (!isOpenClawAgent(liveAgent)) {
      return { allowed: false, reason: `权限不足：Agent ${liveAgent.agent_id} 未授权使用 OpenClaw` };
    }
    if (!this.registry.has(toolName)) {
      return { allowed: false, reason: `工具拒绝：${toolName} 不在知忆安全工具白名单内` };
    }

    const liveAllowedTools = resolveAgentAllowedTools({ agent: liveAgent });
    if (!ctx.allowedTools.has(toolName) || !liveAllowedTools.has(toolName)) {
      return {
        allowed: false,
        reason: `权限不足：Agent ${liveAgent.agent_id} 无权调用工具 ${toolName}`,
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
    const assertOwnedMemoryRefs = (
      ctx: ZhiyiToolContext,
      refs: { projectId?: string | null; goalId?: string | null; taskId?: string | null },
    ): void => {
      if (refs.projectId && !this.deps.projectStore.get(ctx.userId, refs.projectId)) {
        throw new DomainError(404, 'project_not_found', `Project ${refs.projectId} 不存在或无权访问`);
      }
      if (refs.goalId && !this.deps.goalStore.get(ctx.userId, refs.goalId)) {
        throw new DomainError(404, 'goal_not_found', `Goal ${refs.goalId} 不存在或无权访问`);
      }
      if (refs.taskId && !this.deps.businessTaskManager.get(ctx.userId, refs.taskId)) {
        throw new DomainError(404, 'task_not_found', `Task ${refs.taskId} 不存在或无权访问`);
      }
    };

    const assertReadableMemoryScope = (ctx: ZhiyiToolContext, memory: Memory): void => {
      if (memory.scope === 'agent' && memory.agent_id && memory.agent_id !== ctx.agent.agent_id) {
        throw new ToolPolicyDeniedError('无权访问其他 Agent 专属记忆');
      }
    };

    this.registerTool({
      name: 'memory_search',
      label: '检索个人记忆',
      description: '检索当前用户的知忆长期记忆（支持按项目、目标、任务和分类检索，自动过滤过期与归档条目）。',
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 500, description: '检索关键词或问题' }),
          project_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          goal_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          categories: Type.Optional(
            Type.Array(Type.String({ enum: [...MEMORY_CATEGORIES] }), { maxItems: 7 }),
          ),
          include_archived: Type.Optional(Type.Boolean()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: '返回条数上限' })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const query = String(params.query ?? '').trim();
        const limit = typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), 10) : 5;
        const rawCats = Array.isArray(params.categories) ? params.categories : [];
        const categories = rawCats.filter((c): c is MemoryCategory =>
          MEMORY_CATEGORIES.includes(c as MemoryCategory),
        );
        const hits = searchMemories(this.deps.memoryStore, {
          query,
          user_id: ctx.userId,
          agent_id: ctx.agent.agent_id,
          project_id:
            typeof params.project_id === 'string' && params.project_id.trim() !== ''
              ? params.project_id.trim()
              : ctx.task.project_id ?? undefined,
          goal_id: typeof params.goal_id === 'string' ? params.goal_id.trim() : undefined,
          task_id: typeof params.task_id === 'string' ? params.task_id.trim() : undefined,
          categories: categories.length > 0 ? categories : undefined,
          include_archived: params.include_archived === true,
          limit,
        });
        if (hits.length === 0) {
          return {
            text: '未检索到匹配的用户长期记忆。',
            details: { count: 0 },
          };
        }
        const summary = hits
          .map((hit, idx) => {
            const m = hit.memory;
            const trust = m.verified_by_user ? '已确认' : '推断参考';
            const link = [
              m.goal_id ? `goal=${m.goal_id}` : '',
              m.project_id ? `project=${m.project_id}` : '',
              m.task_id ? `task=${m.task_id}` : '',
            ]
              .filter(Boolean)
              .join(',');
            return `${idx + 1}. (${m.memory_id}) [${m.scope}/${m.category}/${m.type}，${trust}，置信度 ${m.confidence.toFixed(2)}${link ? `，${link}` : ''}] ${m.content.slice(0, 300)}`;
          })
          .join('\n');
        return {
          text: summary,
          details: { count: hits.length, items: hits.map((h) => h.memory) },
        };
      },
    });

    this.registerTool({
      name: 'memory_get',
      label: '读取单条记忆详情',
      description: '根据 memory_id 读取当前用户指定的长期记忆完整详情、来源、确认状态及工作空间关联。',
      parameters: Type.Object(
        {
          memory_id: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const memoryId = String(params.memory_id ?? '').trim();
        const memory = this.deps.memoryStore.getById(ctx.userId, memoryId);
        if (!memory) {
          throw new DomainError(404, 'memory_not_found', `记忆 ${memoryId} 不存在或无权访问`);
        }
        assertReadableMemoryScope(ctx, memory);
        return {
          text: `记忆 ${memory.memory_id} [${memory.scope}/${memory.category}/${memory.type}，status=${memory.status}，${memory.verified_by_user ? '用户已确认' : '推断/未确认'}，置信度=${memory.confidence.toFixed(2)}，来源=${memory.source}]：${memory.content}`,
          details: { memory },
        };
      },
    });

    this.registerTool({
      name: 'memory_create',
      label: '记录长期记忆',
      description:
        '记录用户的长期偏好、稳定属性、长期目标、项目关键决策或已验证经验（禁止保存寒暄或临时废话；不得覆盖用户已确认记忆）。',
      parameters: Type.Object(
        {
          content: Type.String({ minLength: 6, maxLength: 2000, description: '精炼准确的记忆正文' }),
          category: Type.Optional(Type.String({ enum: [...MEMORY_CATEGORIES] })),
          scope: Type.Optional(Type.String({ enum: [...MEMORY_SCOPES] })),
          type: Type.Optional(Type.String({ enum: [...MEMORY_TYPES] })),
          project_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          goal_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          confidence: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1 })),
          expires_at: Type.Optional(Type.String({ minLength: 4, maxLength: 64 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const content = String(params.content ?? '').trim();
        const scope: MemoryScope = MEMORY_SCOPES.includes(params.scope as MemoryScope)
          ? (params.scope as MemoryScope)
          : 'personal';
        const category: MemoryCategory = MEMORY_CATEGORIES.includes(params.category as MemoryCategory)
          ? (params.category as MemoryCategory)
          : 'general';
        const type: MemoryType = MEMORY_TYPES.includes(params.type as MemoryType)
          ? (params.type as MemoryType)
          : 'semantic';
        const projectId =
          typeof params.project_id === 'string' && params.project_id.trim() !== ''
            ? params.project_id.trim()
            : scope === 'project'
              ? ctx.task.project_id
              : null;
        const goalId =
          typeof params.goal_id === 'string' && params.goal_id.trim() !== ''
            ? params.goal_id.trim()
            : null;
        const taskId =
          typeof params.task_id === 'string' && params.task_id.trim() !== ''
            ? params.task_id.trim()
            : null;

        assertOwnedMemoryRefs(ctx, { projectId, goalId, taskId });

        const confidence = typeof params.confidence === 'number' ? params.confidence : 0.78;
        const expiresAt =
          typeof params.expires_at === 'string' && params.expires_at.trim() !== ''
            ? params.expires_at.trim()
            : null;

        const evolved = evolveMemoryWrite(
          this.deps.memoryStore,
          {
            user_id: ctx.userId,
            agent_id: scope === 'agent' ? ctx.agent.agent_id : null,
            project_id: projectId,
            goal_id: goalId,
            task_id: taskId,
            type,
            scope,
            category,
            content,
            source: `agent:${ctx.agent.agent_id}`,
            confidence,
            expires_at: expiresAt,
          },
          { actor: 'model', supersedeConflicts: true },
        );

        if (evolved.action === 'conflict_blocked') {
          if (this.deps.candidateStore) {
            this.deps.candidateStore.create(
              {
                user_id: ctx.userId,
                agent_id: ctx.agent.agent_id,
                project_id: projectId,
                goal_id: goalId,
                task_id: taskId,
                type,
                scope,
                category,
                content,
                source: `agent:${ctx.agent.agent_id}:conflict`,
                confidence,
                status: 'pending',
              },
              this.deps.memoryStore,
            );
          }
          return {
            text: `检测到与用户已确认记忆 ${evolved.conflictWith.memory_id}（「${evolved.conflictWith.content}」）存在冲突，已禁止模型自动覆盖；已提示需向用户核实。`,
            details: { action: evolved.action, conflict_with: evolved.conflictWith },
          };
        }

        if (evolved.action === 'merged') {
          return {
            text: `已合并至现有记忆 ${evolved.memory.memory_id}（${evolved.note}）。`,
            details: { action: evolved.action, memory: evolved.memory },
          };
        }
        if (evolved.action === 'superseded') {
          return {
            text: `已创建新记忆 ${evolved.memory.memory_id}，并替代旧记忆 ${evolved.superseded.map((m) => m.memory_id).join(', ')}。`,
            details: { action: evolved.action, memory: evolved.memory, superseded: evolved.superseded },
          };
        }
        return {
          text: `已记录记忆 ${evolved.memory.memory_id} [${category}/${scope}]：${evolved.memory.content}`,
          details: { action: evolved.action, memory: evolved.memory },
        };
      },
    });

    this.registerTool({
      name: 'memory_update',
      label: '更新或纠正记忆',
      description:
        '更新已有记忆的内容、分类、过期时间或工作空间关联；修改用户已确认记忆时必须获得用户明确纠正指令（user_confirmed_correction=true）。',
      parameters: Type.Object(
        {
          memory_id: Type.String({ minLength: 1, maxLength: 100 }),
          content: Type.Optional(Type.String({ minLength: 6, maxLength: 2000 })),
          category: Type.Optional(Type.String({ enum: [...MEMORY_CATEGORIES] })),
          project_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
          goal_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
          task_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
          expires_at: Type.Optional(Type.Union([Type.String({ minLength: 4, maxLength: 64 }), Type.Null()])),
          user_confirmed_correction: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const memoryId = String(params.memory_id ?? '').trim();
        const existing = this.deps.memoryStore.getById(ctx.userId, memoryId);
        if (!existing) {
          throw new DomainError(404, 'memory_not_found', `记忆 ${memoryId} 不存在或无权访问`);
        }
        assertReadableMemoryScope(ctx, existing);

        const nextProject =
          'project_id' in params
            ? (typeof params.project_id === 'string' ? params.project_id.trim() : null)
            : undefined;
        const nextGoal =
          'goal_id' in params
            ? (typeof params.goal_id === 'string' ? params.goal_id.trim() : null)
            : undefined;
        const nextTask =
          'task_id' in params
            ? (typeof params.task_id === 'string' ? params.task_id.trim() : null)
            : undefined;

        assertOwnedMemoryRefs(ctx, {
          projectId: nextProject,
          goalId: nextGoal,
          taskId: nextTask,
        });

        const patch: MemoryPatch = {};
        if (typeof params.content === 'string') patch.content = params.content.trim();
        if (typeof params.category === 'string') patch.category = params.category as MemoryCategory;
        if ('project_id' in params) patch.project_id = nextProject ?? null;
        if ('goal_id' in params) patch.goal_id = nextGoal ?? null;
        if ('task_id' in params) patch.task_id = nextTask ?? null;
        if ('expires_at' in params) {
          patch.expires_at = typeof params.expires_at === 'string' ? params.expires_at.trim() : null;
        }
        if (params.user_confirmed_correction === true) {
          patch.source = 'user-correction';
          patch.confidence = 1;
        }

        try {
          const updated = mutateMemoryWithGuard(
            this.deps.memoryStore,
            ctx.userId,
            memoryId,
            { kind: 'update', patch },
            {
              actor: 'model',
              userConfirmedCorrection: params.user_confirmed_correction === true,
            },
          );
          return {
            text: `已更新记忆 ${updated.memory_id}：${updated.content}`,
            details: { memory: updated },
          };
        } catch (error) {
          if (error instanceof MemoryConflictError) {
            throw new DomainError(error.status, error.code, error.message);
          }
          throw error;
        }
      },
    });

    this.registerTool({
      name: 'memory_archive',
      label: '归档过期或废弃记忆',
      description:
        '将不再适用的记忆归档（不硬删保留追溯）；归档用户已确认记忆时必须先经过用户明确确认。',
      parameters: Type.Object(
        {
          memory_id: Type.String({ minLength: 1, maxLength: 100 }),
          user_confirmed_correction: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const memoryId = String(params.memory_id ?? '').trim();
        const existing = this.deps.memoryStore.getById(ctx.userId, memoryId);
        if (!existing) {
          throw new DomainError(404, 'memory_not_found', `记忆 ${memoryId} 不存在或无权访问`);
        }
        assertReadableMemoryScope(ctx, existing);
        try {
          const archived = mutateMemoryWithGuard(
            this.deps.memoryStore,
            ctx.userId,
            memoryId,
            { kind: 'archive' },
            {
              actor: 'model',
              userConfirmedCorrection: params.user_confirmed_correction === true,
            },
          );
          return {
            text: `已归档记忆 ${archived.memory_id}（status=${archived.status}）。`,
            details: { memory: archived },
          };
        } catch (error) {
          if (error instanceof MemoryConflictError) {
            throw new DomainError(error.status, error.code, error.message);
          }
          throw error;
        }
      },
    });

    this.registerTool({
      name: 'goal_list',
      label: '查看个人目标',
      description: '查询当前用户的个人目标列表，支持按状态过滤和分页。',
      parameters: Type.Object(
        {
          status: Type.Optional(
            Type.String({ enum: [...GOAL_STATUSES], description: '按目标状态过滤' }),
          ),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const page = listGoalsForUser(this.workDeps(), ctx.userId, {
          status: typeof params.status === 'string' ? (params.status as never) : undefined,
          limit: typeof params.limit === 'number' ? params.limit : 20,
          offset: typeof params.offset === 'number' ? params.offset : 0,
        });
        if (page.items.length === 0) {
          return { text: '当前没有符合条件的个人目标。', details: { total: page.total, count: 0 } };
        }
        const text = page.items
          .map(
            (g) =>
              `- ${g.id}: ${g.title} [status=${g.status}, P${g.priority}${g.target_date ? `, target=${g.target_date}` : ''}]`,
          )
          .join('\n');
        return {
          text: `共 ${page.total} 个目标（当前显示 ${page.items.length} 个）：\n${text}`,
          details: { total: page.total, count: page.items.length, items: page.items },
        };
      },
    });

    this.registerTool({
      name: 'goal_create',
      label: '创建个人目标',
      description: '为用户创建新的长期目标（仅当用户明确要求创建目标时调用）。',
      parameters: Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 200, description: '目标名称' }),
          description: Type.Optional(Type.String({ maxLength: 4000 })),
          status: Type.Optional(Type.String({ enum: [...GOAL_STATUSES] })),
          priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4, description: '0-4，数值越大优先级越高' })),
          target_date: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
          project_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const goal = createGoalForUser(this.workDeps(), ctx.userId, {
          title: String(params.title),
          description: typeof params.description === 'string' ? params.description : undefined,
          status: typeof params.status === 'string' ? (params.status as never) : undefined,
          priority: typeof params.priority === 'number' ? params.priority : undefined,
          target_date: params.target_date === null || typeof params.target_date === 'string' ? params.target_date : undefined,
          project_ids: Array.isArray(params.project_ids) ? (params.project_ids as string[]) : undefined,
        });
        return {
          text: `已创建目标 ${goal.id}：「${goal.title}」（状态：${goal.status}，优先级：P${goal.priority}）。`,
          details: { goal },
        };
      },
    });

    this.registerTool({
      name: 'goal_update',
      label: '更新个人目标',
      description: '修改当前用户已有目标的标题、描述、状态、优先级或目标日期。',
      parameters: Type.Object(
        {
          goal_id: Type.String({ minLength: 1, maxLength: 100 }),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          description: Type.Optional(Type.String({ maxLength: 4000 })),
          status: Type.Optional(Type.String({ enum: [...GOAL_STATUSES] })),
          priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
          target_date: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const goalId = String(params.goal_id ?? '').trim();
        const patch: Record<string, unknown> = {};
        if ('title' in params) patch.title = params.title;
        if ('description' in params) patch.description = params.description;
        if ('status' in params) patch.status = params.status;
        if ('priority' in params) patch.priority = params.priority;
        if ('target_date' in params) patch.target_date = params.target_date;
        const goal = updateGoalForUser(this.workDeps(), ctx.userId, goalId, patch);
        return {
          text: `已更新目标 ${goal.id}：「${goal.title}」（状态：${goal.status}，优先级：P${goal.priority}）。`,
          details: { goal },
        };
      },
    });

    this.registerTool({
      name: 'project_list',
      label: '查看个人项目',
      description: '查询当前用户本人名下的项目列表，支持按状态、关联 Goal 过滤以及分页。',
      parameters: Type.Object(
        {
          status: Type.Optional(
            Type.String({ enum: [...PROJECT_STATUSES], description: '项目状态过滤' }),
          ),
          goal_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: '按关联目标 ID 过滤' })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const page = listProjectsForUser(this.workDeps(), ctx.userId, {
          status: typeof params.status === 'string' ? (params.status as never) : undefined,
          goal_id: typeof params.goal_id === 'string' ? params.goal_id : undefined,
          limit: typeof params.limit === 'number' ? params.limit : 20,
          offset: typeof params.offset === 'number' ? params.offset : 0,
        });
        if (page.items.length === 0) {
          return { text: '当前没有符合条件的项目。', details: { total: page.total, count: 0 } };
        }
        const text = page.items
          .map(
            (p) =>
              `- ${p.id}: ${p.title} [status=${p.status}]${p.description ? ` — ${p.description.slice(0, 80)}` : ''}`,
          )
          .join('\n');
        return {
          text: `共 ${page.total} 个项目（当前显示 ${page.items.length} 个）：\n${text}`,
          details: { total: page.total, count: page.items.length, items: page.items },
        };
      },
    });

    this.registerTool({
      name: 'project_create',
      label: '创建个人项目',
      description: '为当前用户创建新项目（仅在用户明确要求新建项目时调用）。',
      parameters: Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 200, description: '项目名称' }),
          description: Type.Optional(Type.String({ maxLength: 4000 })),
          status: Type.Optional(Type.String({ enum: [...PROJECT_STATUSES] })),
          goal_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const project = createProjectForUser(this.workDeps(), ctx.userId, {
          title: String(params.title),
          description: typeof params.description === 'string' ? params.description : undefined,
          status: typeof params.status === 'string' ? (params.status as never) : undefined,
          goal_ids: Array.isArray(params.goal_ids) ? (params.goal_ids as string[]) : undefined,
        });
        return {
          text: `已创建项目 ${project.id}：「${project.title}」（状态：${project.status}）。`,
          details: { project },
        };
      },
    });

    this.registerTool({
      name: 'project_update',
      label: '更新个人项目',
      description: '修改当前用户已有项目的标题、描述或状态。',
      parameters: Type.Object(
        {
          project_id: Type.String({ minLength: 1, maxLength: 100 }),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          description: Type.Optional(Type.String({ maxLength: 4000 })),
          status: Type.Optional(Type.String({ enum: [...PROJECT_STATUSES] })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const projectId = String(params.project_id ?? '').trim();
        const patch: Record<string, unknown> = {};
        if ('title' in params) patch.title = params.title;
        if ('description' in params) patch.description = params.description;
        if ('status' in params) patch.status = params.status;
        const project = updateProjectForUser(this.workDeps(), ctx.userId, projectId, patch);
        return {
          text: `已更新项目 ${project.id}：「${project.title}」（状态：${project.status}）。`,
          details: { project },
        };
      },
    });

    this.registerTool({
      name: 'project_summary',
      label: '项目进度汇总',
      description: '基于当前用户真实业务任务与执行记录生成指定项目的进度摘要、阻塞失败项及下一步建议。',
      parameters: Type.Object(
        {
          project_id: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        if (!this.deps.taskRepo) {
          throw new Error('当前网关未配置 TaskRepository');
        }
        const projectId = String(params.project_id ?? '').trim();
        const summary = buildProjectProgressSummary(
          {
            projectStore: this.deps.projectStore,
            businessTaskManager: this.deps.businessTaskManager,
            taskRepo: this.deps.taskRepo,
          },
          ctx.userId,
          projectId,
        );
        if (!summary) {
          throw new DomainError(404, 'not_found', `Project ${projectId} 不存在或无权访问`);
        }
        return {
          text: summary.narrative,
          details: { summary },
        };
      },
    });

    this.registerTool({
      name: 'proactive_notifications',
      label: '查看主动提醒收件箱',
      description: '只读查询当前用户收件箱中的主动提醒（逾期/停滞任务、失败通知、待确认决策与项目进度摘要）。',
      parameters: Type.Object(
        {
          status: Type.Optional(Type.String({ enum: ['unread', 'read', 'dismissed', 'all'] })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        if (!this.deps.proactiveStore) {
          return { text: '当前未启用主动提醒存储。', details: { items: [], unread_count: 0 } };
        }
        const status =
          typeof params.status === 'string'
            ? (params.status as 'unread' | 'read' | 'dismissed' | 'all')
            : 'unread';
        const limit = typeof params.limit === 'number' ? params.limit : 15;
        const page = this.deps.proactiveStore.list(ctx.userId, { status, limit, offset: 0 });
        if (page.items.length === 0) {
          return {
            text: `当前没有状态为 ${status} 的主动提醒（未读总数 ${page.unread_count}）。`,
            details: page,
          };
        }
        const lines = page.items.map(
          (item) => `- [${item.kind}/${item.status}] ${item.title} (${item.id})：${item.summary.slice(0, 180)}`,
        );
        return {
          text: `共 ${page.total} 条（未读 ${page.unread_count}）：\n${lines.join('\n')}`,
          details: page,
        };
      },
    });

    this.registerTool({
      name: 'task_list',
      label: '查看个人业务任务',
      description: '查询当前用户本人的业务任务列表，支持按状态、项目 ID 或父任务过滤，以及分页。',
      parameters: Type.Object(
        {
          status: Type.Optional(Type.String({ enum: [...BUSINESS_TASK_STATUSES] })),
          project_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          parent_task_id: Type.Optional(
            Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
          ),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const page = listTasksForUser(this.workDeps(), ctx.userId, {
          status: typeof params.status === 'string' ? (params.status as never) : undefined,
          project_id: typeof params.project_id === 'string' ? params.project_id : undefined,
          parent_task_id:
            params.parent_task_id === null || typeof params.parent_task_id === 'string'
              ? params.parent_task_id
              : undefined,
          limit: typeof params.limit === 'number' ? params.limit : 20,
          offset: typeof params.offset === 'number' ? params.offset : 0,
        });
        if (page.items.length === 0) {
          return { text: '当前没有符合条件的业务任务。', details: { total: page.total, count: 0 } };
        }
        const text = page.items
          .map(
            (item) =>
              `- ${item.id}: ${item.title} [${item.status}, P${item.priority}${item.project_id ? `, project=${item.project_id}` : ''}${item.assignee_agent_id ? `, agent=${item.assignee_agent_id}` : ''}]`,
          )
          .join('\n');
        return {
          text: `共 ${page.total} 条任务（当前显示 ${page.items.length} 条）：\n${text}`,
          details: { total: page.total, count: page.items.length, items: page.items },
        };
      },
    });

    this.registerTool({
      name: 'task_detail',
      label: '查询任务详情',
      description: '查询当前用户指定任务的完整详情，包括状态、优先级、负责人、所属项目、子任务和最近一次 Execution 执行进展。',
      parameters: Type.Object(
        {
          task_id: Type.String({ minLength: 1, maxLength: 100, description: '业务任务 ID（如 btask_...）' }),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const taskId = String(params.task_id ?? '').trim();
        const detail = getTaskDetailForUser(this.workDeps(), ctx.userId, taskId);
        const t = detail.task;
        const lines: string[] = [
          `任务 ${t.id}：「${t.title}」`,
          `状态：${t.status} | 优先级：P${t.priority} | 负责人：${t.assignee_agent_id ?? '未指定'}`,
          `所属项目：${detail.project ? `${detail.project.title} (${detail.project.id})` : t.project_id ?? '无'}${t.parent_task_id ? ` | 父任务：${t.parent_task_id}` : ''}${t.due_at ? ` | 截止：${t.due_at}` : ''}`,
        ];
        if (t.description) {
          lines.push(`描述：${t.description.slice(0, 600)}`);
        }
        if (detail.subtasks.length > 0) {
          const st = detail.subtask_stats;
          lines.push(
            `子任务（共 ${st.total}，完成 ${st.completed}，进行中 ${st.in_progress}，待办 ${st.pending}）：`,
          );
          for (const sub of detail.subtasks.slice(0, 10)) {
            lines.push(`  - ${sub.id}: ${sub.title} [${sub.status}, P${sub.priority}]`);
          }
        } else {
          lines.push('子任务：无');
        }
        if (detail.latest_execution) {
          const ex = detail.latest_execution;
          const failureHint = ex.needs_verification
            ? '（需核实结果后重试）'
            : ex.status === 'failed'
              ? ex.retryable
                ? '（可重试/更换 Agent）'
                : '（不可重试，需改参数或更换 Agent）'
              : '';
          const summary = ex.error
            ? `错误：${ex.error}${failureHint}`
            : ex.result
              ? `结果：${ex.result.slice(0, 300)}`
              : ex.progress_message
                ? `进度：${ex.progress_message}`
                : '暂无摘要';
          lines.push(
            `最近 Execution（累计 ${detail.execution_count} 次）：${ex.id} [status=${ex.status}, mode=${ex.execution_mode}, agent=${ex.agent_id ?? 'default'}, attempts=${ex.attempt_count}${ex.retry_of_execution_id ? `, retry_of=${ex.retry_of_execution_id}` : ''}, updated=${ex.updated_at}] · ${summary}`,
          );
          if (detail.recent_events.length > 0) {
            const eventSummary = detail.recent_events
              .slice(-5)
              .map((ev) => `[${ev.event_type}] ${ev.message ?? ev.status ?? ''}`)
              .join(' -> ');
            lines.push(`最近事件轨迹：${eventSummary}`);
          }
        } else {
          lines.push('最近 Execution：尚未执行');
        }
        return {
          text: lines.join('\n'),
          details: {
            task: detail.task,
            project: detail.project,
            subtasks: detail.subtasks,
            subtask_stats: detail.subtask_stats,
            latest_execution: detail.latest_execution,
            execution_count: detail.execution_count,
            recent_events: detail.recent_events,
            lifecycle_summary: detail.lifecycle_summary,
          },
        };
      },
    });

    this.registerTool({
      name: 'task_executions',
      label: '查询任务执行历史与事件轨迹',
      description:
        '查询当前用户指定业务任务的历史 Execution 列表、失败分类与完整事件轨迹（创建、开始、工具调用、重试、恢复、取消、结果）。',
      parameters: Type.Object(
        {
          task_id: Type.String({ minLength: 1, maxLength: 100, description: '业务任务 ID（如 btask_...）' }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const taskId = String(params.task_id ?? '').trim();
        const detail = getTaskDetailForUser(this.workDeps(), ctx.userId, taskId);
        const limit = typeof params.limit === 'number' ? params.limit : 20;
        const execPage = this.deps.businessTaskManager.listExecutions(
          ctx.userId,
          taskId,
          limit,
          0,
        ) ?? { items: [], total: 0 };
        const eventPage = this.deps.businessTaskManager.listExecutionEvents(
          ctx.userId,
          taskId,
          Math.min(limit * 5, 100),
          0,
        ) ?? { items: [], total: 0 };

        const lines: string[] = [detail.lifecycle_summary];
        if (execPage.items.length > 0) {
          lines.push(`历史 Execution（共 ${execPage.total} 次，按最新排序）：`);
          for (const ex of execPage.items) {
            const note = ex.error
              ? `错误=${ex.error} (${ex.error_category ?? 'unknown'}, retryable=${ex.retryable}, needs_verification=${ex.needs_verification})`
              : ex.result
                ? `结果=${ex.result.slice(0, 160)}`
                : ex.progress_message ?? ex.status;
            lines.push(
              `- ${ex.id} [status=${ex.status}, agent=${ex.agent_id ?? 'default'}, mode=${ex.execution_mode}${ex.retry_of_execution_id ? `, retry_of=${ex.retry_of_execution_id}` : ''}] · ${note}`,
            );
          }
        }
        if (eventPage.items.length > 0) {
          lines.push(`生命周期事件（最近 ${Math.min(eventPage.items.length, 15)} 条）：`);
          for (const ev of eventPage.items.slice(-15)) {
            lines.push(
              `  - [${ev.created_at}] ${ev.event_type} (${ev.execution_id}): ${ev.message ?? ev.status ?? ''}`,
            );
          }
        }
        return {
          text: lines.join('\n'),
          details: {
            task: detail.task,
            executions: execPage,
            events: eventPage,
          },
        };
      },
    });

    this.registerTool({
      name: 'task_create',
      label: '创建业务任务',
      description: '为当前用户创建待办业务任务（默认仅记录落库，不自动执行；仅在用户明确要求创建任务时调用）。',
      parameters: Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 200, description: '任务标题' }),
          description: Type.Optional(Type.String({ maxLength: 8000 })),
          priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4, description: '0-4，默认 2，数值越大优先级越高' })),
          status: Type.Optional(
            Type.String({ enum: [...INITIAL_TASK_STATUSES], description: '仅允许 draft/pending/ready/assigned，默认 pending' }),
          ),
          project_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          parent_task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          assignee_agent_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          due_at: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const task = createTaskForUser(this.workDeps(), ctx.userId, {
          title: String(params.title),
          description: typeof params.description === 'string' ? params.description : undefined,
          priority: typeof params.priority === 'number' ? params.priority : undefined,
          status: typeof params.status === 'string' ? (params.status as never) : undefined,
          project_id: typeof params.project_id === 'string' ? params.project_id : undefined,
          parent_task_id: typeof params.parent_task_id === 'string' ? params.parent_task_id : undefined,
          assignee_agent_id: typeof params.assignee_agent_id === 'string' ? params.assignee_agent_id : undefined,
          due_at: typeof params.due_at === 'string' ? params.due_at : undefined,
        });
        return {
          text: `已创建任务 ${task.id}：「${task.title}」（状态：${task.status}，优先级：P${task.priority}${task.project_id ? `，所属项目：${task.project_id}` : ''}${task.assignee_agent_id ? `，负责人：${task.assignee_agent_id}` : ''}；未自动执行）。`,
          details: { task },
        };
      },
    });

    this.registerTool({
      name: 'task_update',
      label: '修改业务任务',
      description: '修改当前用户已有任务的标题、描述、优先级、所属项目、负责人、截止时间或合法过渡状态（严格遵循任务状态机，不支持通过本工具直接改为 completed/failed/cancelled/in_progress）。',
      parameters: Type.Object(
        {
          task_id: Type.String({ minLength: 1, maxLength: 100 }),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          description: Type.Optional(Type.String({ maxLength: 8000 })),
          priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
          status: Type.Optional(Type.String({ enum: [...BUSINESS_TASK_STATUSES] })),
          project_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
          parent_task_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
          assignee_agent_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
          due_at: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
        },
        { additionalProperties: false },
      ),
      execute: async (ctx, params) => {
        const taskId = String(params.task_id ?? '').trim();
        const patch: Record<string, unknown> = {};
        if ('title' in params) patch.title = params.title;
        if ('description' in params) patch.description = params.description;
        if ('priority' in params) patch.priority = params.priority;
        if ('status' in params) patch.status = params.status;
        if ('project_id' in params) patch.project_id = params.project_id;
        if ('parent_task_id' in params) patch.parent_task_id = params.parent_task_id;
        if ('assignee_agent_id' in params) patch.assignee_agent_id = params.assignee_agent_id;
        if ('due_at' in params) patch.due_at = params.due_at;
        const task = updateTaskForUser(this.workDeps(), ctx.userId, taskId, patch);
        return {
          text: `已更新任务 ${task.id}：「${task.title}」（状态：${task.status}，优先级：P${task.priority}${task.project_id ? `，所属项目：${task.project_id}` : ''}${task.assignee_agent_id ? `，负责人：${task.assignee_agent_id}` : ''}）。`,
          details: { task },
        };
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

    this.registerTool({
      name: 'web_search',
      label: '实时网页搜索',
      description: '按 query 实时搜索互联网并返回权威结果、结构化摘要与正文（兼容 DeepSeek Tools 协议）。',
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 128, description: '搜索关键词，支持 site:、-、"..."、lang: 等语法' }),
          count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: '返回条数（1～50，默认 10）' })),
          need_content: Type.Optional(Type.Boolean({ description: '是否在 content 中返回网页正文（默认 false）' })),
        },
        { additionalProperties: false },
      ),
      execute: async (_ctx, params, signal) => {
        if (!this.deps.searchWeb) {
          throw new Error('当前网关未配置网络搜索能力');
        }
        const res = await this.deps.searchWeb(params, { signal });
        if (!res.results || res.results.length === 0) {
          return { text: '未检索到相关网页结果。', details: { query: params.query, count: 0, results: [] } };
        }
        const lines = res.results.map(
          (item, idx) =>
            `${idx + 1}. [${item.title}](${item.url})\n   摘要: ${item.summary || item.snippet}${item.site_name ? ` (${item.site_name})` : ''}`,
        );
        return {
          text: `检索到 ${res.results.length} 条相关结果：\n\n${lines.join('\n\n')}`,
          details: res,
        };
      },
    });

    this.registerTool({
      name: 'web_fetch',
      label: '抓取网页正文',
      description: '抓取指定 HTTP/HTTPS 网页内容并以 Markdown 文本返回页面正文。',
      parameters: Type.Object(
        {
          url: Type.String({ minLength: 1, maxLength: 8192, description: '要抓取的网页有效 HTTP/HTTPS 地址' }),
        },
        { additionalProperties: false },
      ),
      execute: async (_ctx, params, signal) => {
        if (!this.deps.fetchWeb) {
          throw new Error('当前网关未配置网页抓取能力');
        }
        const res = await this.deps.fetchWeb(params, { signal });
        return {
          text: `# ${res.title || '网页正文'}\n\n${res.content}`,
          details: res,
        };
      },
    });
  }
}
