/**
 * ButlerCoordinator（管家协调器）：实现 Router / Worker 双层协作架构，
 * 负责用户复杂目标的智能理解、子任务拆解、依赖编排、Worker 指派、执行跟进与最终结果交付验收。
 */
import type { AgentStore } from '../../agents';
import type { Logger } from '../../logger';
import type { MemoryStore } from '../../memories';
import { searchMemories } from '../../search';
import type { AgentProfile } from '../../types';
import type { ModelAdapter } from '../adapters/model/model-adapter';
import type { GoalStore } from '../domain/goal-store';
import type { ProjectStore } from '../domain/project-store';
import { DomainError, type BusinessTask } from '../domain/types';
import type { ProactiveStore } from '../proactive/proactive-store';
import type { BusinessTaskManager } from '../task/business-task-manager';
import type { ExecutionEventStore } from '../task/execution-event-store';
import type { TaskAcceptanceManager } from '../task/task-acceptance-manager';
import type { TaskDependencyRepository } from '../task/task-dependency-repository';
import type { TaskRepository } from '../task/task-repository';
import type { AgentSelector } from './agent-selector';
import type { DirectExecutionRunner } from './direct-execution-runner';
import type { PersonalAIIdentity } from '../identity/identity-manager';
import type { OpenClawAgentRunner } from './openclaw/agent-runner';
import { isOpenClawAgent } from './openclaw/types';

export interface PlannedSubtaskSpec {
  step_index: number;
  title: string;
  description: string;
  preferred_agent_id?: string;
  depends_on_indices?: number[];
  acceptance_criteria?: string;
}

export interface ButlerDecompositionPlan {
  goalTitle: string;
  goalDescription: string;
  parentTask: {
    title: string;
    description: string;
    priority: number;
  };
  subtasks: PlannedSubtaskSpec[];
  rationale: string;
}

export interface ButlerExecutionResult {
  parentTask: BusinessTask;
  subtasks: BusinessTask[];
  dispatchedSubtasks: BusinessTask[];
  summaryMessage: string;
}

export interface ButlerCoordinatorDeps {
  agentStore: AgentStore;
  memoryStore?: MemoryStore;
  agentSelector: AgentSelector;
  businessTaskManager: BusinessTaskManager;
  taskRepo: TaskRepository;
  dependencyRepo?: TaskDependencyRepository;
  acceptanceManager?: TaskAcceptanceManager;
  eventStore?: ExecutionEventStore;
  proactiveStore: ProactiveStore;
  goalStore: GoalStore;
  projectStore: ProjectStore;
  modelAdapter: ModelAdapter;
  directRunner: DirectExecutionRunner;
  openClawRunner?: OpenClawAgentRunner;
  logger: Logger;
}

export class ButlerCoordinator {
  constructor(private readonly deps: ButlerCoordinatorDeps) {}

  /** 分析用户输入并生成子任务规划与拆解方案。 */
  async planComplexGoal(
    userId: string,
    goalText: string,
    options: {
      projectId?: string;
      goalId?: string;
      preferredAgents?: string[];
    } = {},
  ): Promise<ButlerDecompositionPlan> {
    const activeAgents = this.deps.agentStore.list().filter((a: AgentProfile) => a.status === 'active');
    const agentSummaries = activeAgents.map(
      (a: AgentProfile) => `${a.agent_id} (${a.name}: ${a.description}; 后端=${a.execution_backend})`,
    );

    let memoryConstraintPrompt = '';
    if (this.deps.memoryStore) {
      const memoryHits = searchMemories(this.deps.memoryStore, {
        user_id: userId,
        query: goalText,
        limit: 5,
      });
      if (memoryHits.length > 0) {
        const memLines = memoryHits.map(
          (h) => `- [${h.memory.scope}/${h.memory.category}] ${h.memory.content}`,
        );
        memoryConstraintPrompt = `用户相关长期记忆约束（规划子任务时必须遵守）：\n${memLines.join('\n')}`;
      }
    }

    const promptParts = [
      '你是指忆（Zhiyi）个人 AI 的总管家（Butler / Router）。用户提出了一个复杂目标，你需要进行结构化规划与拆解。',
      '请根据目标拆解为 2-4 个有先后执行依赖的清晰子任务。',
      `可用 Worker Agent 清单：\n${agentSummaries.join('\n')}`,
    ];
    if (memoryConstraintPrompt) {
      promptParts.push(memoryConstraintPrompt);
    }
    promptParts.push(
      '请直接输出严格的 JSON 对象，不要添加任何额外的 Markdown 代码块或问候语。',
      'JSON Schema 格式：',
      '{',
      '  "parentTask": { "title": string, "description": string, "priority": 1|2|3 },',
      '  "subtasks": [',
      '    {',
      '      "step_index": number (从 0 开始),',
      '      "title": string,',
      '      "description": string,',
      '      "preferred_agent_id": string (必须来自可用 Worker Agent 清单),',
      '      "depends_on_indices": number[] (所依赖的前置步骤 step_index，如第一步为 []，第二步依赖第一步为 [0]),',
      '      "acceptance_criteria": string (该步骤验收准则，如要求代码包含复杂度分析等)',
      '    }',
      '  ],',
      '  "rationale": string',
      '}',
      `用户目标：${goalText.slice(0, 3000)}`,
    );
    const prompt = promptParts.join('\n\n');

    let parsedPlan: ButlerDecompositionPlan | null = null;
    try {
      const raw = await this.deps.modelAdapter.complete([
        { role: 'user', content: prompt },
      ]);
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const obj = JSON.parse(match[0]);
        if (obj && obj.parentTask && Array.isArray(obj.subtasks) && obj.subtasks.length > 0) {
          parsedPlan = {
            goalTitle: obj.parentTask.title,
            goalDescription: obj.parentTask.description || goalText,
            parentTask: {
              title: obj.parentTask.title || '复杂目标拆解任务',
              description: obj.parentTask.description || goalText,
              priority: typeof obj.parentTask.priority === 'number' ? obj.parentTask.priority : 2,
            },
            subtasks: obj.subtasks.map((s: any, idx: number) => ({
              step_index: typeof s.step_index === 'number' ? s.step_index : idx,
              title: String(s.title || `步骤 ${idx + 1}`),
              description: String(s.description || ''),
              preferred_agent_id: s.preferred_agent_id,
              depends_on_indices: Array.isArray(s.depends_on_indices) ? s.depends_on_indices : idx > 0 ? [idx - 1] : [],
              acceptance_criteria: s.acceptance_criteria ? String(s.acceptance_criteria) : undefined,
            })),
            rationale: obj.rationale || '按前后依赖关系线性拆解',
          };
        }
      }
    } catch (err) {
      this.deps.logger.warn('[butler] 模型规划拆解解析异常，启用确定性安全降级规划', err);
    }

    // 确定性保底规划：若模型解析失败，按经典「调研/设计 -> 开发实施 -> 测试验证」三段式拆解
    if (!parsedPlan) {
      const devAgent = activeAgents.find((a: AgentProfile) => a.capabilities.includes('code'))?.agent_id || 'developer';
      const defaultAgent = activeAgents[0]?.agent_id || 'developer';

      parsedPlan = {
        goalTitle: goalText.slice(0, 50),
        goalDescription: goalText,
        parentTask: {
          title: `目标落地：${goalText.slice(0, 40)}`,
          description: goalText,
          priority: 2,
        },
        subtasks: [
          {
            step_index: 0,
            title: `阶段 1：需求梳理与技术方案设计`,
            description: `针对目标【${goalText}】进行可行性分析与方案规划`,
            preferred_agent_id: defaultAgent,
            depends_on_indices: [],
            acceptance_criteria: '产出清晰的技术路径或模块划分方案',
          },
          {
            step_index: 1,
            title: `阶段 2：核心功能开发与代码实现`,
            description: `基于方案完成具体代码实现与模块落地`,
            preferred_agent_id: devAgent,
            depends_on_indices: [0],
            acceptance_criteria: '提供完整代码块与算法复杂度分析',
          },
        ],
        rationale: '两阶段流水线：方案梳理 -> 实施落地',
      };
    }

    return parsedPlan;
  }

  /**
   * 将规划落库为真实父任务与带拓扑依赖的子任务体系，并自动触发首批无前置依赖的子任务。
   */
  async executePlan(
    userId: string,
    plan: ButlerDecompositionPlan,
    options: {
      projectId?: string;
      conversationId?: string;
      multicaEnabled: boolean;
    },
  ): Promise<ButlerExecutionResult> {
    // 1. 创建父任务
    const parentTask = this.deps.businessTaskManager.create(userId, {
      title: plan.parentTask.title,
      description: plan.parentTask.description,
      priority: plan.parentTask.priority,
      project_id: options.projectId,
      status: 'ready',
    });

    const createdSubtasks: BusinessTask[] = [];
    const stepToTaskMap = new Map<number, BusinessTask>();

    // 2. 依次创建各子任务并指派匹配 Worker
    for (const spec of plan.subtasks) {
      // 优选指定 Agent 或通过 AgentSelector 自动选择
      let selectedAgentId = spec.preferred_agent_id;
      if (!selectedAgentId || !this.deps.agentStore.get(selectedAgentId)) {
        const selection = this.deps.agentSelector.select({
          taskText: `${spec.title} ${spec.description}`,
          preferredAgentId: spec.preferred_agent_id,
          multicaEnabled: options.multicaEnabled,
        });
        selectedAgentId = selection?.agent?.agent_id || 'developer';
      }

      const subtask = this.deps.businessTaskManager.create(userId, {
        title: spec.title,
        description: spec.description,
        parent_task_id: parentTask.id,
        project_id: options.projectId,
        assignee_agent_id: selectedAgentId,
        priority: 2,
        acceptance_criteria: spec.acceptance_criteria,
        status: 'ready',
      });

      createdSubtasks.push(subtask);
      stepToTaskMap.set(spec.step_index, subtask);
    }

    // 3. 建立子任务间的前置依赖关系
    if (this.deps.dependencyRepo) {
      for (const spec of plan.subtasks) {
        if (spec.depends_on_indices && spec.depends_on_indices.length > 0) {
          const currentTask = stepToTaskMap.get(spec.step_index)!;
          const prereqIds = spec.depends_on_indices
            .map((idx) => stepToTaskMap.get(idx)?.id)
            .filter((id): id is string => Boolean(id));

          this.deps.dependencyRepo.setDependencies(userId, currentTask.id, prereqIds);
          if (!this.deps.dependencyRepo.areDependenciesSatisfied(userId, currentTask.id)) {
            this.deps.businessTaskManager.update(userId, currentTask.id, { status: 'blocked' });
            const refreshed = this.deps.businessTaskManager.get(userId, currentTask.id);
            if (refreshed) {
              stepToTaskMap.set(spec.step_index, refreshed);
              const idx = createdSubtasks.findIndex((t) => t.id === currentTask.id);
              if (idx >= 0) createdSubtasks[idx] = refreshed;
            }
          }
        }
      }
    }

    // 4. 派发首批就绪的子任务（无前置依赖者）
    const dispatchedSubtasks: BusinessTask[] = [];
    for (const subtask of createdSubtasks) {
      const dependenciesSatisfied = this.deps.dependencyRepo
        ? this.deps.dependencyRepo.areDependenciesSatisfied(userId, subtask.id)
        : true;

      if (dependenciesSatisfied && (subtask.status === 'ready' || subtask.status === 'pending' || subtask.status === 'blocked')) {
        this.deps.businessTaskManager.update(userId, subtask.id, { status: 'ready' });
        dispatchedSubtasks.push(subtask);

        // 异步启动首批 Worker
        void this.runSubtaskWorker(userId, subtask, options).catch((err) => {
          this.deps.logger.error(`[butler] 子任务 ${subtask.id} 自动执行异常`, err);
        });
      }
    }

    // 5. 生成管家答复摘要
    const summaryLines: string[] = [
      `我是你的个人 AI 管家。我已经为你规划并拆解了整体目标：`,
      `**目标任务**：${parentTask.title} (\`${parentTask.id}\`)`,
      '',
      `**规划子任务清单（共 ${createdSubtasks.length} 项）**：`,
    ];
    for (let i = 0; i < createdSubtasks.length; i++) {
      const t = createdSubtasks[i];
      const deps = this.deps.dependencyRepo?.listDependencies(userId, t.id) ?? [];
      const depDesc = deps.length > 0 ? ` (前置依赖: ${deps.join(', ')})` : ' (无前置，立即启动)';
      summaryLines.push(
        `${i + 1}. **${t.title}** -> 负责人: \`${t.assignee_agent_id}\` [${t.status}]${depDesc}`,
      );
    }
    summaryLines.push(
      '',
      `已自动安排 ${dispatchedSubtasks.length} 个就绪子任务给专业 Worker 并行推进，我会持续跟进执行并进行成果验收。`,
    );

    return {
      parentTask,
      subtasks: createdSubtasks,
      dispatchedSubtasks,
      summaryMessage: summaryLines.join('\n'),
    };
  }

  /**
   * 启动单一子任务的 Worker 执行，并在完成后自动触发验收与拓扑推进。
   */
  async runSubtaskWorker(
    userId: string,
    subtask: BusinessTask,
    options: { conversationId?: string; multicaEnabled: boolean },
  ): Promise<void> {
    try {
      const agentId = subtask.assignee_agent_id || 'developer';
      const agent = this.deps.agentStore.get(agentId);
      if (!agent) {
        this.deps.logger.warn(`[butler] 子任务 ${subtask.id} 找不到指定的 Agent ${agentId}`);
        return;
      }

      // 准备执行权
      const prep = this.deps.businessTaskManager.prepareExecution(userId, subtask.id, {
        agentId: agent.agent_id,
        conversationId: options.conversationId,
        inputSummary: `${subtask.title}\n\n${subtask.description}`,
        multicaEnabled: options.multicaEnabled,
      });

      const identity: PersonalAIIdentity = {
        user_id: userId,
        agent_id: agent.agent_id,
        api_key: null,
        from_default: false,
        request_id: `req_butler_${subtask.id}_${Date.now()}`,
        session_id: null,
        task_id: subtask.id,
        project_id: subtask.project_id,
        conversation_id: options.conversationId ?? `conv_butler_${subtask.id}`,
        signature_verified: true,
      };

      // 根据执行后端路由至对应 Runner
      if (isOpenClawAgent(agent) && this.deps.openClawRunner) {
        await this.deps.openClawRunner.run(subtask, prep.execution, prep.agent, identity);
      } else {
        await this.deps.directRunner.run(subtask, prep.execution, prep.agent, identity);
      }

      // 执行完毕后，检查是否需要触发下游子任务
      await this.advanceSubtasksAfterCompletion(userId, subtask);
    } catch (err) {
      this.deps.logger.error(`[butler] Worker 执行子任务 ${subtask.id} 失败`, err);
    }
  }

  /**
   * 子任务完成后，推进拓扑下游就绪任务，若全部子任务完成则推进父任务并汇总交付成果。
   */
  async advanceSubtasksAfterCompletion(userId: string, finishedSubtask: BusinessTask): Promise<void> {
    const parentId = finishedSubtask.parent_task_id;
    if (!parentId) return;

    // 1. 查找并解锁下游就绪任务
    if (this.deps.dependencyRepo) {
      const dependents = this.deps.dependencyRepo.listDependents(userId, finishedSubtask.id);
      for (const depId of dependents) {
        if (this.deps.dependencyRepo.areDependenciesSatisfied(userId, depId)) {
          const depTask = this.deps.businessTaskManager.get(userId, depId);
          if (depTask && depTask.status === 'blocked') {
            this.deps.businessTaskManager.update(userId, depId, { status: 'ready' });
            // 自动调度下游任务
            void this.runSubtaskWorker(userId, depTask, { multicaEnabled: true }).catch((err) => {
              this.deps.logger.error(`[butler] 下游就绪任务 ${depId} 自动调度失败`, err);
            });
          }
        }
      }
    }

    // 2. 检查父任务下的全部子任务是否均已完成
    const allSubtasks = this.deps.businessTaskManager.list(userId, { parent_task_id: parentId }).items;
    const allCompleted = allSubtasks.every((t) => t.status === 'completed');

    if (allCompleted && allSubtasks.length > 0) {
      const parentTask = this.deps.businessTaskManager.get(userId, parentId);
      if (parentTask && parentTask.status !== 'completed') {
        this.deps.businessTaskManager.advanceParentCompleted(userId, parentId);
        this.deps.proactiveStore.createIfNew({
          userId,
          kind: 'task_completed_summary',
          entityType: 'task',
          entityId: parentId,
          dedupeKey: `butler:parent_done:${parentId}`,
          title: `目标交付完成：${parentTask.title}`,
          summary: `管家已协调所有 Worker 完成了【${parentTask.title}】的全部 ${allSubtasks.length} 项子任务，最终验收已通过。`,
          evidence: {
            parent_task_id: parentId,
            subtask_ids: allSubtasks.map((t) => t.id),
          },
        });
      }
    }
  }

  /** 聚合指定父任务下所有子任务的最终成果与交付报告。 */
  formatGoalDeliverableReport(userId: string, parentTaskId: string): string {
    const parent = this.deps.businessTaskManager.get(userId, parentTaskId);
    if (!parent) return '（未找到目标任务）';

    const subtasks = this.deps.businessTaskManager.list(userId, { parent_task_id: parentTaskId }).items;
    const lines: string[] = [
      `# 🎯 管家交付成果报告：${parent.title}`,
      '',
      `- 整体状态：**${parent.status}**`,
      `- 目标描述：${parent.description}`,
      '',
      `## 📋 子任务完成情况（共 ${subtasks.length} 项）`,
    ];

    for (const t of subtasks) {
      const exec = this.deps.taskRepo.getLatestByTaskId(userId, t.id);
      lines.push(
        '',
        `### ▶ ${t.title} [${t.status}]`,
        `- 执行 Worker：\`${t.assignee_agent_id ?? '默认'}\``,
        `- 验收状态：\`${t.review_status}\``,
      );
      if (exec?.result) {
        lines.push('', '```text', exec.result.slice(0, 500) + (exec.result.length > 500 ? '...' : ''), '```');
      }
    }

    return lines.join('\n');
  }
}
