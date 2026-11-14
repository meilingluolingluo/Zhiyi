/**
 * Personal AI Runtime：唯一的智能决策中心与编排入口。
 *
 * 流程：身份 → 用户档案 → 会话 → 统一 Context（记忆 + 目标/项目/任务摘要）→
 *       意图（规则快路径 / 可选单步 LLM 结构化意图）→ 计划 & Agent 选择 →
 *       事务记录创建（Goal/Project/Task）或 Direct/MultiCA 执行 → 统一事件流 → 轨迹/候选记忆。
 *
 * 长时间 MultiCA 任务由后台 Worker 执行；客户端断开（signal aborted）时停止发事件，但后台任务继续。
 */
import type { AgentStore } from '../../agents';
import type { BackgroundTracker } from '../../background';
import type { AppConfig } from '../../config';
import type { ExtractionQueue } from '../../extractor';
import type { Logger } from '../../logger';
import type { MemoryStore } from '../../memories';
import type { TrajectoryStore } from '../../trajectories';
import type { AgentProfile, ChatMessage, UpstreamTransport } from '../../types';
import { lastUserPrompt } from '../../upstream/ducx-report';
import { executeImageGeneration } from '../../upstream/media-handlers';
import { isImageGenerationModel, type MediaStore } from '../../upstream/media-store';
import type { UpstreamService } from '../../upstream/service';
import type { ModelAdapter, TokenUsage } from '../adapters/model/model-adapter';
import type { PersonalAIConfig } from '../config';
import type { ConversationContextStore } from '../conversation/conversation-context';
import type { GoalStore } from '../domain/goal-store';
import type { ProjectStore } from '../domain/project-store';
import type { BusinessTask } from '../domain/types';
import type { UserProfileStore } from '../domain/user-profile-store';
import type { ProactiveStore } from '../proactive/proactive-store';
import {
  createGoalForUser,
  createProjectForUser,
  createTaskForUser,
  extractPriorConversationMessages,
} from '../domain/work-operations';
import type { PersonalAIEvent } from '../events/event-types';
import type { PersonalAIIdentity } from '../identity/identity-manager';
import type { BusinessTaskManager } from '../task/business-task-manager';
import type { TaskManager } from '../task/task-manager';
import type { ExecutionTask } from '../task/task-repository';
import type { TaskWorker } from '../worker/task-worker';
import {
  resolveRequestedAgentReference,
  type AgentSelectionOutcome,
  type AgentSelector,
} from './agent-selector';
import { buildPersonalAIContext, type BuiltContext } from './context-builder';
import type { ButlerCoordinator } from './butler-coordinator';
import type { DirectExecutionRunner } from './direct-execution-runner';
import type { OpenClawAgentRunner } from './openclaw/agent-runner';
import { redactSensitiveText, type ZhiyiToolGateway } from './openclaw/tool-gateway';
import type { ZhiyiToolContext } from './openclaw/types';
import { isOpenClawAgent } from './openclaw/types';
import { planExecution } from './execution-planner';
import {
  buildIntentClassificationPrompt,
  isGreetingOnly,
  parseStructuredIntent,
  understandIntent,
  type StructuredIntent,
} from './intent-understanding';
import { aggregateAgentResult } from './result-aggregator';

export interface RuntimeDeps {
  config: AppConfig;
  personalAI: PersonalAIConfig;
  agentStore: AgentStore;
  memoryStore: MemoryStore;
  trajectoryStore: TrajectoryStore;
  queue: ExtractionQueue;
  background: BackgroundTracker;
  logger: Logger;
  modelAdapter: ModelAdapter;
  worker: TaskWorker;
  taskManager: TaskManager;
  conversationStore: ConversationContextStore;
  /** 运行期模型服务设置；用于 DUCX 来源上报与生图（可选）。 */
  upstream?: UpstreamService;
  mediaStore?: MediaStore;
  transport?: UpstreamTransport;
  /** V1.5 个人事务与执行编排依赖（可选，不传时保持纯粹 V1 兼容行为）。 */
  userProfiles?: UserProfileStore;
  goalStore?: GoalStore;
  projectStore?: ProjectStore;
  businessTaskManager?: BusinessTaskManager;
  proactiveStore?: ProactiveStore;
  agentSelector?: AgentSelector;
  directRunner?: DirectExecutionRunner;
  openClawRunner?: OpenClawAgentRunner;
  butlerCoordinator?: ButlerCoordinator;
  toolGateway?: ZhiyiToolGateway;
}

export interface RunInput {
  identity: PersonalAIIdentity;
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
  /** 可选：来自请求头的 IANA 时区，按 user > header > default 惰性同步。 */
  timezone?: string;
  /** 可选：传入后由 Runtime 回填上游返回的 token usage（非流式响应使用）。 */
  usage?: TokenUsage;
  /** 可选公共访问前缀（用于生成可被浏览器访问的图片 URL）。 */
  publicOrigin?: string;
}

const EXPLICIT_IMAGE_GEN_RE =
  /^(?:(?:请|麻烦|帮我|给我|帮忙|为我)\s*){0,3}(?:(?:画|绘制)(?:(?:一[张幅只条个名组])|.*(?:图|图片|照片|插画|海报|头像|壁纸|漫画|logo|sketch|image|picture))|(?:生成|创作)(?:一?张|一?幅|一?个|张|幅|个)?.*(?:图|图片|照片|插画|海报|头像|壁纸|漫画|logo|image|picture))/i;

function isExplicitImageGenerationRequest(text: string): boolean {
  const cleaned = text.trim();
  if (cleaned === '' || cleaned.length > 500) return false;
  return (
    EXPLICIT_IMAGE_GEN_RE.test(cleaned) ||
    /^(?:draw|generate|create)\s+(?:an?\s+)?(?:image|picture|photo|illustration|avatar|logo|poster)\b/i.test(cleaned)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

export class PersonalAIRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  private scheduleTrajectory(
    identity: PersonalAIIdentity,
    messages: ChatMessage[],
    assistantText: string,
    model: string | undefined,
  ): void {
    if (assistantText.trim() === '') return;
    const prompt = lastUserPrompt(messages);
    if (prompt && isGreetingOnly(prompt)) {
      return;
    }
    this.deps.background.run(async (): Promise<void> => {
      try {
        const sanitizedMessages = messages.map((m) => {
          if (typeof m.content === 'string') {
            return { ...m, content: redactSensitiveText(m.content) };
          }
          return m;
        });
        const sanitizedAssistantText = redactSensitiveText(assistantText);
        const saved = this.deps.trajectoryStore.save({
          request_id: identity.request_id,
          user_id: identity.user_id,
          agent_id: identity.agent_id,
          session_id: identity.session_id,
          task_id: identity.task_id,
          project_id: identity.project_id,
          model: model || this.deps.config.defaultModel,
          request: JSON.stringify({ messages: sanitizedMessages }),
          response: sanitizedAssistantText,
          status: 'ok',
        });
        if (!saved.inserted || !this.deps.config.memoryAutoExtract) return;
        this.deps.queue.enqueue({
          trajectory: saved.record,
          messages: sanitizedMessages,
          assistantText: sanitizedAssistantText,
          source: 'auto-extract',
        });
      } catch (error) {
        this.deps.logger.error('[personal-ai] 轨迹保存失败（不影响对话）', error);
      }
    });
  }

  private async tryClassifyIntent(
    context: BuiltContext,
    model: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<StructuredIntent | null> {
    if (!this.deps.personalAI.llmIntentEnabled || isGreetingOnly(context.taskText)) {
      return null;
    }

    const agents: AgentProfile[] = this.deps.agentStore
      .list()
      .filter((a): boolean => a.status === 'active');
    const agentSummaries: string[] = agents.map(
      (a): string => `${a.agent_id}(${a.role || a.name}; backend=${a.execution_backend}; caps=${a.capabilities.join(',')})`,
    );
    const projectSummaries: string[] = (context.activeProjects ?? []).map(
      (p): string => `${p.id}:${p.title}`,
    );
    const goalSummaries: string[] = (context.activeGoals ?? []).map(
      (g): string => `${g.id}:${g.title}`,
    );

    const prompt: string = buildIntentClassificationPrompt(
      context.taskText,
      agentSummaries,
      projectSummaries,
      goalSummaries,
    );
    try {
      const raw: string = await this.deps.modelAdapter.complete(
        [{ role: 'user', content: prompt }],
        { model, signal },
      );
      const parsed: StructuredIntent | null = parseStructuredIntent(raw);
      if (!parsed) {
        this.deps.logger.info('[personal-ai] LLM 意图解析未通过校验，回退 V1 规则路由');
      }
      return parsed;
    } catch (error) {
      this.deps.logger.warn(
        `[personal-ai] LLM 意图分类调用异常，回退 V1 规则路由: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private resolveExplicitPreferredAgent(identity: PersonalAIIdentity, intentAgent?: string): string | undefined {
    if (intentAgent && intentAgent.trim() !== '') return intentAgent.trim();
    const idAgent: string = (identity.agent_id ?? '').trim();
    if (idAgent !== '' && idAgent !== 'default') return idAgent;
    return undefined;
  }

  private selectAgentOutcome(params: {
    taskText: string;
    identity: PersonalAIIdentity;
    userRequestedAgentId?: string;
    intentAgentId?: string;
    defaultAgentId?: string;
  }): AgentSelectionOutcome | undefined {
    if (!this.deps.agentSelector) return undefined;
    // 用户在对话中显式点名 Agent 时按用户输入严格解析，避免静默转派其他 Agent；未点名时允许回退匹配。
    const preferredAgentId: string | undefined =
      params.userRequestedAgentId ??
      this.resolveExplicitPreferredAgent(params.identity, params.intentAgentId);
    const allowFallback: boolean = !params.userRequestedAgentId;
    return this.deps.agentSelector.selectWithDiagnostics({
      taskText: params.taskText,
      preferredAgentId,
      multicaEnabled: this.deps.personalAI.multica.enabled,
      defaultAgentId: params.defaultAgentId,
      allowFallback,
    });
  }

  private prepareExecutionRecord(
    identity: PersonalAIIdentity,
    title: string,
    description: string,
    selectedAgent: AgentProfile | null,
    explicitProjectId: string | null,
    timezone?: string,
  ): {
    businessTask: BusinessTask | null;
    execution: ExecutionTask;
    agent: AgentProfile | null;
    created: boolean;
  } {
    const targetProjectId: string | null =
      explicitProjectId ??
      (identity.project_id && identity.project_id !== 'default' ? identity.project_id : null);

    if (this.deps.businessTaskManager) {
      const prepared = this.deps.businessTaskManager.prepareAdhocDelegation({
        userId: identity.user_id,
        conversationId: identity.conversation_id,
        requestId: identity.request_id,
        title,
        description,
        agentId: selectedAgent?.agent_id ?? null,
        projectId: targetProjectId,
        multicaEnabled: this.deps.personalAI.multica.enabled,
        userOptions: { headerTimezone: timezone },
      });
      return {
        businessTask: prepared.task,
        execution: prepared.execution,
        agent: prepared.agent,
        created: prepared.created,
      };
    }

    const fallbackCreated = this.deps.taskManager.createIfAbsent({
      user_id: identity.user_id,
      conversation_id: identity.conversation_id,
      request_id: identity.request_id,
      agent_id: selectedAgent?.agent_id ?? (this.deps.personalAI.multica.defaultAgent || null),
      project_id: targetProjectId,
      execution_mode: selectedAgent?.execution_backend === 'direct_llm' ? 'direct_llm' : 'agent_delegation',
      input_summary: description,
    });
    return {
      businessTask: null,
      execution: fallbackCreated.task,
      agent: selectedAgent,
      created: fallbackCreated.created,
    };
  }

  private async *streamOrdinaryDirectLlm(
    context: BuiltContext,
    modelName: string | undefined,
    signal: AbortSignal | undefined,
    usageOut: TokenUsage | undefined,
    capture: { text: string },
    publicOrigin?: string,
    identity?: PersonalAIIdentity,
  ): AsyncGenerator<PersonalAIEvent> {
    const effectiveModel = modelName || this.deps.config.defaultModel;
    const shouldGenerateImage =
      Boolean(this.deps.mediaStore && this.deps.transport) &&
      (isImageGenerationModel(effectiveModel) ||
        (!this.deps.config.mockUpstream &&
          Boolean(this.deps.upstream) &&
          isExplicitImageGenerationRequest(context.taskText)));

    if (shouldGenerateImage && this.deps.mediaStore && this.deps.transport) {
      const imageBody: Record<string, unknown> = { prompt: context.taskText };
      if (isImageGenerationModel(effectiveModel)) {
        imageBody.model = effectiveModel;
      }
      const res = await executeImageGeneration(
        {
          config: this.deps.config,
          transport: this.deps.transport,
          logger: this.deps.logger,
          mediaStore: this.deps.mediaStore,
          upstream: this.deps.upstream,
        },
        imageBody,
        { signal, publicOrigin },
      );
      if (!res.ok) {
        throw new Error(`模型上游返回 ${res.status}：${res.errorText ?? '生图失败'}`);
      }
      const markdown =
        res.savedUrls.length > 0
          ? `已使用模型 \`${res.model}\` 生成图片：\n\n` +
            res.savedUrls
              .map((u, idx) => `![${oneLine(context.taskText, 40) || 'image'}${res.savedUrls.length > 1 ? ` #${idx + 1}` : ''}](${u})`)
              .join('\n\n')
          : '生图接口未返回有效图片。';
      capture.text += markdown;
      yield { type: 'text_delta', content: markdown };
      return;
    }

    if (!this.deps.toolGateway || !identity) {
      for await (const delta of this.deps.modelAdapter.stream(context.messages, {
        model: modelName,
        signal,
        onUsage: (usage: TokenUsage): void => {
          if (usageOut) Object.assign(usageOut, usage);
        },
      })) {
        capture.text += delta;
        yield { type: 'text_delta', content: delta };
      }
      return;
    }

    const memoryToolNames = new Set([
      'recall_memory',
      'remember_memory',
      'update_memory',
      'memory_search',
      'memory_get',
    ]);
    const registeredTools = this.deps.toolGateway
      .listRegisteredTools()
      .filter((tool) => memoryToolNames.has(tool.name));

    if (registeredTools.length === 0) {
      for await (const delta of this.deps.modelAdapter.stream(context.messages, {
        model: modelName,
        signal,
        onUsage: (usage: TokenUsage): void => {
          if (usageOut) Object.assign(usageOut, usage);
        },
      })) {
        capture.text += delta;
        yield { type: 'text_delta', content: delta };
      }
      return;
    }

    const openAiTools = registeredTools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      },
    }));

    const toolCtx: ZhiyiToolContext = {
      userId: identity.user_id,
      identity,
      allowedTools: memoryToolNames,
      publicOrigin,
    };

    const currentMessages: ChatMessage[] = [...context.messages];
    const maxToolTurns = 3;

    for (let turn = 0; turn < maxToolTurns; turn += 1) {
      if (signal?.aborted) break;

      const { response } = await this.deps.modelAdapter.openRawStream(
        {
          model: modelName,
          messages: currentMessages,
          tools: openAiTools,
        },
        { signal },
      );

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let turnAssistantText = '';
      const toolStates = new Map<number, { id: string; name: string; argsJson: string }>();

      try {
        while (true) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '' || data === '[DONE]') continue;

            let parsed: any;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            if (parsed.usage && usageOut) {
              const inTok = Number(parsed.usage.prompt_tokens ?? 0);
              const outTok = Number(parsed.usage.completion_tokens ?? 0);
              const totTok = Number(parsed.usage.total_tokens ?? inTok + outTok);
              usageOut.prompt_tokens += inTok;
              usageOut.completion_tokens += outTok;
              usageOut.total_tokens += totTok;
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            if (typeof delta.content === 'string' && delta.content !== '') {
              turnAssistantText += delta.content;
              capture.text += delta.content;
              yield { type: 'text_delta', content: delta.content };
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                let state = toolStates.get(idx);
                if (!state) {
                  state = {
                    id: typeof tc.id === 'string' && tc.id !== '' ? tc.id : `call_${Date.now()}_${idx}`,
                    name: tc.function?.name ?? '',
                    argsJson: '',
                  };
                  toolStates.set(idx, state);
                }
                if (tc.id && !state.id) state.id = tc.id;
                if (tc.function?.name && !state.name) state.name = tc.function.name;
                if (tc.function?.arguments) state.argsJson += tc.function.arguments;
              }
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }

      if (toolStates.size === 0) {
        return;
      }

      const calls = Array.from(toolStates.values());
      currentMessages.push({
        role: 'assistant',
        content: turnAssistantText !== '' ? turnAssistantText : null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: {
            name: c.name,
            arguments: c.argsJson,
          },
        })),
      });

      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          const trimmed = call.argsJson.trim();
          if (trimmed) args = JSON.parse(trimmed);
        } catch {
          args = {};
        }

        let toolResultText = '';
        try {
          const execRes = await this.deps.toolGateway.executeTool(toolCtx, call.name, args, signal);
          toolResultText = execRes.text;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          toolResultText = `[错误] ${errMsg}`;
          this.deps.logger.warn(`[personal-ai] direct_llm 工具调用 ${call.name} 失败: ${errMsg}`);
        }

        currentMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: toolResultText,
        });
      }
    }
  }

  private async *runMulticaDelegation(
    execution: ExecutionTask,
    created: boolean,
    identity: PersonalAIIdentity,
    signal: AbortSignal | undefined,
    capture: { text: string },
  ): AsyncGenerator<PersonalAIEvent> {
    this.deps.conversationStore.touch(identity, execution.id);
    if (created) {
      yield {
        type: 'task_started',
        taskId: execution.id,
        mode: 'multica',
        agentId: execution.agent_id ?? undefined,
      };
    }
    if (created) await this.deps.worker.dispatch(execution.id);

    let lastStatus = '';
    let agentAnnounced = false;
    const deadline: number = Date.now() + this.deps.personalAI.streamMaxMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      const current = this.deps.taskManager.getForUser(identity.user_id, execution.id);
      if (!current) break;
      if (current.status !== lastStatus) {
        lastStatus = current.status;
        yield {
          type: 'task_progress',
          taskId: execution.id,
          status: current.status,
          message: current.progress_message ?? undefined,
        };
        if (current.status === 'running' && current.agent_id && !agentAnnounced) {
          agentAnnounced = true;
          yield { type: 'agent_started', taskId: execution.id, agentId: current.agent_id };
        }
      }
      if (current.status === 'completed') {
        if (agentAnnounced) {
          yield {
            type: 'agent_completed',
            taskId: execution.id,
            agentId: current.agent_id ?? 'unknown',
          };
        }
        capture.text = aggregateAgentResult({
          taskId: execution.id,
          businessTaskId: current.task_id,
          agentId: current.agent_id ?? undefined,
          content: current.result ?? undefined,
        });
        yield { type: 'final_answer', content: capture.text };
        break;
      }
      if (current.status === 'cancelled') {
        const reason: string = current.error ?? '任务已取消';
        yield { type: 'task_cancelled', taskId: execution.id, reason };
        capture.text = `任务 ${execution.id} 已取消${current.error ? `：${current.error}` : ''}`;
        yield { type: 'final_answer', content: capture.text };
        break;
      }
      if (current.status === 'failed') {
        yield {
          type: 'task_failed',
          taskId: execution.id,
          error: current.error ?? '任务失败',
        };
        capture.text = aggregateAgentResult({
          taskId: execution.id,
          businessTaskId: current.task_id,
          agentId: current.agent_id ?? undefined,
          error: current.error ?? '任务失败',
          errorCategory: current.error_category,
          retryable: current.retryable,
          needsVerification: current.needs_verification,
        });
        yield { type: 'final_answer', content: capture.text };
        break;
      }
      await sleep(Math.max(100, this.deps.personalAI.multica.pollIntervalMs));
    }

    if (capture.text === '') {
      capture.text = aggregateAgentResult({
        taskId: execution.id,
        degraded: true,
        content: `任务已在后台执行，可通过 GET /v1/personal-ai/tasks/${execution.id} 查询进度与结果。`,
      });
      yield { type: 'final_answer', content: capture.text };
    }
  }

  private async *handleDirectDelegationError(
    error: unknown,
    businessTask: BusinessTask,
    execution: ExecutionTask,
    agent: AgentProfile,
    identity: PersonalAIIdentity,
    signal: AbortSignal | undefined,
    capture: { text: string },
  ): AsyncGenerator<PersonalAIEvent> {
    const message: string = error instanceof Error ? error.message : String(error);
    if (signal?.aborted || message === '用户取消任务') {
      yield { type: 'task_cancelled', taskId: execution.id, reason: '用户取消任务' };
      capture.text = `任务 ${execution.id} 已取消`;
      yield { type: 'final_answer', content: capture.text };
      return;
    }
    const latest = this.deps.taskManager.getForUser(identity.user_id, execution.id);
    yield { type: 'task_failed', taskId: execution.id, error: message };
    capture.text = aggregateAgentResult({
      taskId: execution.id,
      businessTaskId: businessTask.id,
      agentId: agent.agent_id,
      error: latest?.error ?? message,
      errorCategory: latest?.error_category,
      retryable: latest?.retryable,
      needsVerification: latest?.needs_verification,
    });
    yield { type: 'final_answer', content: capture.text };
  }

  private async *runDirectAgentDelegation(
    businessTask: BusinessTask,
    execution: ExecutionTask,
    agent: AgentProfile,
    identity: PersonalAIIdentity,
    prebuiltSystemMessage: string,
    modelName: string | undefined,
    signal: AbortSignal | undefined,
    usageOut: TokenUsage | undefined,
    capture: { text: string },
    publicOrigin?: string,
    historyMessages?: ChatMessage[],
  ): AsyncGenerator<PersonalAIEvent> {
    const executionMode: 'openclaw' | 'direct_llm' = isOpenClawAgent(agent)
      ? 'openclaw'
      : 'direct_llm';
    this.deps.conversationStore.touch(identity, execution.id);
    yield { type: 'task_started', taskId: execution.id, mode: executionMode, agentId: agent.agent_id };
    yield { type: 'agent_started', taskId: execution.id, agentId: agent.agent_id };

    if (isOpenClawAgent(agent) && this.deps.openClawRunner) {
      try {
        for await (const event of this.deps.openClawRunner.stream(
          businessTask,
          execution,
          agent,
          identity,
          {
            prebuiltSystemMessage,
            signal,
            modelOverride: modelName,
            publicOrigin,
            historyMessages,
            onUsage: (usage: TokenUsage): void => {
              if (usageOut) {
                usageOut.prompt_tokens += usage.prompt_tokens;
                usageOut.completion_tokens += usage.completion_tokens;
                usageOut.total_tokens += usage.total_tokens;
              }
            },
            rethrowOnError: true,
          },
        )) {
          if (event.type === 'text_delta') {
            capture.text += event.content;
          }
          yield event;
        }
        yield { type: 'agent_completed', taskId: execution.id, agentId: agent.agent_id };
      } catch (error) {
        yield* this.handleDirectDelegationError(
          error,
          businessTask,
          execution,
          agent,
          identity,
          signal,
          capture,
        );
      }
      return;
    }

    if (!this.deps.directRunner) {
      // 无 DirectExecutionRunner 注入时的安全降级
      const fallbackError = 'DirectExecutionRunner 未配置';
      yield { type: 'task_failed', taskId: execution.id, error: fallbackError };
      capture.text = aggregateAgentResult({
        taskId: execution.id,
        businessTaskId: businessTask.id,
        agentId: agent.agent_id,
        error: fallbackError,
      });
      yield { type: 'final_answer', content: capture.text };
      return;
    }

    try {
      for await (const delta of this.deps.directRunner.stream(businessTask, execution, agent, identity, {
        signal,
        modelOverride: modelName,
        onUsage: (usage: TokenUsage): void => {
          if (usageOut) Object.assign(usageOut, usage);
        },
        rethrowOnError: true,
      })) {
        capture.text += delta;
        yield { type: 'text_delta', content: delta };
      }
      yield { type: 'agent_completed', taskId: execution.id, agentId: agent.agent_id };
    } catch (error) {
      yield* this.handleDirectDelegationError(
        error,
        businessTask,
        execution,
        agent,
        identity,
        signal,
        capture,
      );
    }
  }

  private async *dispatchPreparedDelegation(
    prepared: {
      businessTask: BusinessTask | null;
      execution: ExecutionTask;
      agent: AgentProfile | null;
      created: boolean;
    },
    identity: PersonalAIIdentity,
    prebuiltSystemMessage: string,
    modelName: string | undefined,
    signal: AbortSignal | undefined,
    usageOut: TokenUsage | undefined,
    capture: { text: string },
    publicOrigin?: string,
    historyMessages?: ChatMessage[],
  ): AsyncGenerator<PersonalAIEvent> {
    if (prepared.execution.execution_mode === 'direct_llm') {
      if (prepared.created && prepared.businessTask && prepared.agent) {
        yield* this.runDirectAgentDelegation(
          prepared.businessTask,
          prepared.execution,
          prepared.agent,
          identity,
          prebuiltSystemMessage,
          modelName,
          signal,
          usageOut,
          capture,
          publicOrigin,
          historyMessages,
        );
        return;
      }

      if (prepared.execution.status === 'completed') {
        capture.text = prepared.execution.result ?? '';
        yield { type: 'final_answer', content: capture.text };
        return;
      }
      if (prepared.execution.status === 'failed' || prepared.execution.status === 'cancelled') {
        const err: string = prepared.execution.error ?? '任务失败';
        yield { type: 'task_failed', taskId: prepared.execution.id, error: err };
        capture.text = aggregateAgentResult({ taskId: prepared.execution.id, error: err });
        yield { type: 'final_answer', content: capture.text };
        return;
      }
      capture.text = aggregateAgentResult({
        taskId: prepared.execution.id,
        degraded: true,
        content: `任务正在执行中，可通过 GET /v1/personal-ai/tasks/${prepared.execution.id} 查询结果。`,
      });
      yield { type: 'final_answer', content: capture.text };
      return;
    }

    yield* this.runMulticaDelegation(
      prepared.execution,
      prepared.created,
      identity,
      signal,
      capture,
    );
  }

  private handleStructuredDomainCreate(
    intent: StructuredIntent,
    identity: PersonalAIIdentity,
    timezone?: string,
  ): string | null {
    const userOptions = { headerTimezone: timezone };
    if (intent.action === 'create_goal' && this.deps.goalStore && this.deps.projectStore) {
      const goal = createGoalForUser(
        { goalStore: this.deps.goalStore, projectStore: this.deps.projectStore },
        identity.user_id,
        {
          title: intent.title as string,
          description: intent.description ?? '',
          priority: intent.priority,
          target_date: intent.target_date ?? null,
        },
        { filterForeignProjects: true, userOptions },
      );
      return `[知忆] 已为你创建目标：「${goal.title}」（ID: \`${goal.id}\`，优先级 P${goal.priority}）。`;
    }

    if (intent.action === 'create_project' && this.deps.projectStore && this.deps.goalStore) {
      const project = createProjectForUser(
        { projectStore: this.deps.projectStore, goalStore: this.deps.goalStore },
        identity.user_id,
        {
          title: intent.title as string,
          description: intent.description ?? '',
          goal_ids: intent.goal_ids,
        },
        { filterForeignGoals: true, userOptions },
      );
      return `[知忆] 已为你创建项目：「${project.title}」（ID: \`${project.id}\`）。`;
    }

    if (
      intent.action === 'create_task' &&
      this.deps.businessTaskManager &&
      this.deps.projectStore
    ) {
      const task = createTaskForUser(
        {
          businessTaskManager: this.deps.businessTaskManager,
          projectStore: this.deps.projectStore,
          agentStore: this.deps.agentStore,
        },
        identity.user_id,
        {
          title: intent.title as string,
          description: intent.description ?? '',
          project_id: intent.project_id,
          priority: intent.priority,
          assignee_agent_id: intent.preferred_agent_id,
        },
        { sanitizeForeignRefs: true, userOptions },
      );
      const assigneeNote: string = task.assignee_agent_id ? `，指派给 ${task.assignee_agent_id}` : '';
      return `[知忆] 已记录待办任务：「${task.title}」（ID: \`${task.id}\`，状态 ${task.status}${assigneeNote}）。`;
    }

    return null;
  }

  async *run(input: RunInput): AsyncGenerator<PersonalAIEvent> {
    const { identity, messages } = input;
    const capture = { text: '' };
    let modelName: string | undefined = input.model;
    const userPrompt: string = lastUserPrompt(messages);
    if (userPrompt !== '' && this.deps.upstream) {
      void this.deps.upstream
        .reportUsage({
          sessionId: identity.session_id ?? identity.conversation_id,
          prompt: userPrompt,
          cwd: process.cwd(),
        })
        .catch((error: unknown): void => {
          this.deps.logger.warn('[personal-ai] DUCX 来源上报失败（不影响对话）', error);
        });
    }

    try {
      this.deps.userProfiles?.ensureUser(identity.user_id, { headerTimezone: input.timezone });
      this.deps.conversationStore.touch(identity);
      yield { type: 'message_start', conversationId: identity.conversation_id };

      // 只要运行时模型配置尚未加载过（首次请求前），预先解析一次，确保 DUCX 模型名可用。
      if (this.deps.upstream) {
        const resolved = await this.deps.upstream.resolveForRequest(modelName);
        if (resolved) modelName = resolved.model;
      }

      const context = buildPersonalAIContext(
        {
          config: this.deps.config,
          memoryStore: this.deps.memoryStore,
          agentStore: this.deps.agentStore,
          userProfiles: this.deps.userProfiles,
          goalStore: this.deps.goalStore,
          projectStore: this.deps.projectStore,
          businessTaskManager: this.deps.businessTaskManager,
          proactiveStore: this.deps.proactiveStore,
        },
        identity,
        messages,
      );

      const structured: StructuredIntent | null = await this.tryClassifyIntent(
        context,
        modelName,
        input.signal,
      );

      if (
        structured &&
        (structured.action === 'create_goal' ||
          structured.action === 'create_project' ||
          structured.action === 'create_task')
      ) {
        const confirmation: string | null = this.handleStructuredDomainCreate(
          structured,
          identity,
          input.timezone,
        );
        if (confirmation !== null) {
          this.deps.logger.info(
            `[personal-ai] intent=${structured.action} reason=${structured.reason}`,
          );
          capture.text = confirmation;
          yield { type: 'text_delta', content: confirmation };
          return;
        }
      }

      if (structured && structured.action === 'direct_llm') {
        this.deps.logger.info(
          `[personal-ai] mode=direct_llm reason=${structured.reason} memory=${context.memoryInjected ? 'on' : 'off'}`,
        );
        yield* this.streamOrdinaryDirectLlm(
          context,
          modelName,
          input.signal,
          input.usage,
          capture,
          input.publicOrigin,
          identity,
        );
        return;
      }

      const currentTurnPrompt: string = userPrompt !== '' ? userPrompt : context.taskText;
      const historyMessages = extractPriorConversationMessages(messages);
      const registeredAgents: AgentProfile[] = this.deps.agentStore.list();
      const userRequestedAgentId: string | undefined = resolveRequestedAgentReference(
        currentTurnPrompt,
        registeredAgents,
      )?.agentId;

      const isComplexDecomposeRequest =
        (structured && structured.action === 'plan_complex_goal') ||
        (/(先.*再.*|拆解.*任务|多步骤|规划并|调研并开发|分步实施|阶段性推进)/i.test(currentTurnPrompt) &&
          !/(查询|怎么做|什么是|解释)/i.test(currentTurnPrompt) &&
          structured?.action !== 'direct_llm');

      if (isComplexDecomposeRequest && this.deps.butlerCoordinator) {
        const planText = [structured?.title, structured?.description, currentTurnPrompt]
          .filter(Boolean)
          .join('\n');
        yield { type: 'text_delta', content: '🤖 知忆管家正在规划目标并拆解任务体系...\n\n' };
        const plan = await this.deps.butlerCoordinator.planComplexGoal(
          identity.user_id,
          planText,
          {
            projectId: structured?.project_id,
            preferredAgents: structured?.preferred_agent_id ? [structured.preferred_agent_id] : undefined,
          },
        );
        const executionResult = await this.deps.butlerCoordinator.executePlan(
          identity.user_id,
          plan,
          {
            projectId: structured?.project_id,
            conversationId: identity.conversation_id,
            multicaEnabled: this.deps.personalAI.multica.enabled,
          },
        );
        capture.text = executionResult.summaryMessage;
        yield { type: 'text_delta', content: executionResult.summaryMessage };
        return;
      }

      if (structured && structured.action === 'delegate_task') {
        const delegationText = [structured.title, structured.description, currentTurnPrompt]
          .filter(Boolean)
          .join('\n');
        const outcome = this.selectAgentOutcome({
          taskText: delegationText,
          identity,
          userRequestedAgentId,
          intentAgentId: structured.preferred_agent_id,
          defaultAgentId: this.deps.personalAI.multica.defaultAgent || undefined,
        });
        if (outcome?.unavailable) {
          const unavailableText = `[知忆] 无法委派任务：${outcome.unavailable.message}。`;
          capture.text = unavailableText;
          yield { type: 'text_delta', content: unavailableText };
          return;
        }
        const pickedAgent: AgentProfile | null = outcome?.selected?.agent ?? null;

        if (!pickedAgent && !this.deps.personalAI.multica.enabled) {
          this.deps.logger.info(
            '[personal-ai] mode=direct_llm reason=无可用Agent且MULTICA_ENABLED=false，降级直接回答',
          );
          yield* this.streamOrdinaryDirectLlm(
            context,
            modelName,
            input.signal,
            input.usage,
            capture,
            input.publicOrigin,
            identity,
          );
          return;
        }

        const ownedProjectId: string | null =
          structured.project_id && this.deps.projectStore?.get(identity.user_id, structured.project_id)
            ? structured.project_id
            : null;
        const prepared = this.prepareExecutionRecord(
          identity,
          structured.title ?? (oneLine(currentTurnPrompt, 80) || '知忆任务'),
          structured.description ?? currentTurnPrompt.slice(0, 2000),
          pickedAgent,
          ownedProjectId,
          input.timezone,
        );
        this.deps.logger.info(
          `[personal-ai] mode=${prepared.execution.execution_mode} agent=${prepared.agent?.agent_id ?? 'default'} reason=${outcome?.selected?.reason ?? structured.reason}`,
        );

        yield* this.dispatchPreparedDelegation(
          prepared,
          identity,
          context.systemMessage,
          modelName,
          input.signal,
          input.usage,
          capture,
          input.publicOrigin,
          historyMessages,
        );
        return;
      }

      // 显式指定了 OpenClaw Agent 且有明确操作意图时，进入 OpenClaw 工具调用分支；
      // 纯想法探讨与可行性咨询直接调用模型直接生成建议，不落库委派任务；
      // 任务负责人指派（如“把某任务交给某 Agent”）仍由 OpenClaw 工具网关执行 task_update。
      const explicitAgentId: string | undefined = this.resolveExplicitPreferredAgent(identity);
      const isTaskAssignmentOnly: boolean =
        /(?:把|将).+?(?:交给|指派给|分配给|委托给|派给)/.test(currentTurnPrompt) &&
        !/(?:开始|执行|启动|跑|运行)/.test(currentTurnPrompt);
      const isIdeaDiscussion: boolean =
        !isTaskAssignmentOnly &&
        /(?:是否值得|你怎么看|可行吗|有什么建议|好不好|值得做吗|要不要)/.test(currentTurnPrompt) &&
        /(?:考虑|想要|打算|想法|方向)/.test(currentTurnPrompt);
      const explicitOpenClawAgent: AgentProfile | undefined =
        explicitAgentId &&
        !isGreetingOnly(currentTurnPrompt) &&
        !isIdeaDiscussion &&
        (!userRequestedAgentId || userRequestedAgentId === explicitAgentId || isTaskAssignmentOnly)
          ? this.deps.agentStore.get(explicitAgentId)
          : undefined;
      if (
        explicitOpenClawAgent &&
        isOpenClawAgent(explicitOpenClawAgent) &&
        explicitOpenClawAgent.status !== 'active'
      ) {
        const disabledMsg = `Agent ${explicitOpenClawAgent.agent_id} 已禁用，禁止继续调用工具或执行任务`;
        capture.text = `[错误] ${disabledMsg}`;
        yield { type: 'error', message: disabledMsg };
        return;
      }
      if (
        explicitOpenClawAgent &&
        explicitOpenClawAgent.status === 'active' &&
        isOpenClawAgent(explicitOpenClawAgent) &&
        this.deps.openClawRunner
      ) {
        const prepared = this.prepareExecutionRecord(
          identity,
          oneLine(currentTurnPrompt, 80) || '知忆 OpenClaw 任务',
          currentTurnPrompt.slice(0, 2000),
          explicitOpenClawAgent,
          null,
          input.timezone,
        );
        this.deps.logger.info(
          `[personal-ai] mode=openclaw_agent agent=${explicitOpenClawAgent.agent_id}`,
        );
        yield* this.dispatchPreparedDelegation(
          prepared,
          identity,
          context.systemMessage,
          modelName,
          input.signal,
          input.usage,
          capture,
          input.publicOrigin,
          historyMessages,
        );
        return;
      }

      // V1 规则路由（默认或 LLM 意图不可用/未命中时的安全回退）
      const hasDirectBackendAgents: boolean = registeredAgents.some(
        (agent): boolean => agent.status === 'active' && agent.execution_backend === 'direct_llm',
      );
      const intent = understandIntent(
        currentTurnPrompt,
        this.deps.personalAI.agentKeywords,
        registeredAgents,
      );
      const plan = planExecution(
        intent,
        { ...context, taskText: currentTurnPrompt },
        this.deps.personalAI,
        { hasDirectBackendAgents },
      );

      if (plan.mode === 'direct_llm') {
        this.deps.logger.info(
          `[personal-ai] mode=direct_llm reason=${plan.reason} memory=${context.memoryInjected ? 'on' : 'off'}`,
        );
        yield* this.streamOrdinaryDirectLlm(
          context,
          modelName,
          input.signal,
          input.usage,
          capture,
          input.publicOrigin,
          identity,
        );
        return;
      }

      const outcome = this.selectAgentOutcome({
        taskText: currentTurnPrompt,
        identity,
        userRequestedAgentId: intent.requestedAgentId,
        defaultAgentId: plan.agentId,
      });
      if (outcome?.unavailable) {
        const unavailableText = `[知忆] 无法委派任务：${outcome.unavailable.message}。`;
        capture.text = unavailableText;
        yield { type: 'text_delta', content: unavailableText };
        return;
      }
      const pickedAgent: AgentProfile | null = outcome?.selected?.agent ?? null;
      if (!pickedAgent && !this.deps.personalAI.multica.enabled) {
        this.deps.logger.info(
          '[personal-ai] mode=direct_llm reason=无可用本地Agent且MULTICA_ENABLED=false，回退直接回答',
        );
        yield* this.streamOrdinaryDirectLlm(
          context,
          modelName,
          input.signal,
          input.usage,
          capture,
          input.publicOrigin,
          identity,
        );
        return;
      }

      const prepared = this.prepareExecutionRecord(
        identity,
        plan.title,
        plan.description,
        pickedAgent,
        null,
        input.timezone,
      );
      this.deps.logger.info(
        `[personal-ai] mode=${prepared.execution.execution_mode} agent=${prepared.agent?.agent_id ?? 'default'} reason=${outcome?.selected?.reason ?? plan.reason}`,
      );

      yield* this.dispatchPreparedDelegation(
        prepared,
        identity,
        context.systemMessage,
        modelName,
        input.signal,
        input.usage,
        capture,
        input.publicOrigin,
        historyMessages,
      );
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`[personal-ai] 执行失败: ${message}`);
      capture.text = `[错误] ${message}`;
      yield { type: 'error', message };
    } finally {
      this.scheduleTrajectory(identity, messages, capture.text, modelName);
      yield { type: 'message_end' };
    }
  }
}
