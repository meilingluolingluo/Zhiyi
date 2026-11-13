/**
 * 统一业务操作门面：供 PersonalAIRuntime（结构化意图）与 OpenClaw Tool Gateway 共用，
 * 避免同一 Goal / Project / Task 操作出现多套实现或绕过领域校验与状态机。
 */
import type { AgentStore } from '../../agents';
import type { CandidateStore } from '../../candidates';
import type { MemoryStore } from '../../memories';
import type { AgentProfile, ChatMessage } from '../../types';
import type { BusinessTaskDetail, BusinessTaskManager } from '../task/business-task-manager';
import type { GoalStore } from './goal-store';
import type { ProjectStore } from './project-store';
import {
  DomainError,
  type BusinessTask,
  type BusinessTaskFilters,
  type BusinessTaskPatch,
  type EnsureUserOptions,
  type Goal,
  type GoalFilters,
  type GoalPatch,
  type NewBusinessTaskInput,
  type NewGoalInput,
  type NewProjectInput,
  type PageResult,
  type Project,
  type ProjectFilters,
  type ProjectPatch,
} from './types';

export interface WorkOperationsDeps {
  goalStore: GoalStore;
  projectStore: ProjectStore;
  businessTaskManager: BusinessTaskManager;
  agentStore: AgentStore;
  candidateStore?: CandidateStore;
  memoryStore?: MemoryStore;
}

/**
 * 任务完成后沉淀经验与结论到候选记忆（不复制易变业务状态，仅保留有实质产出的总结）。
 */
export function recordTaskCompletionCandidate(
  deps: Pick<WorkOperationsDeps, 'businessTaskManager' | 'projectStore' | 'candidateStore' | 'memoryStore'>,
  params: { userId: string; taskId: string; agentId?: string | null; result: string },
): void {
  if (!deps.candidateStore || !deps.memoryStore) return;
  const cleanedResult = params.result.replace(/\s+/g, ' ').trim();
  if (cleanedResult.length < 20) return;

  const task = deps.businessTaskManager.get(params.userId, params.taskId);
  if (!task) return;

  const goalIds = task.project_id
    ? deps.projectStore.listGoalsForProject(params.userId, task.project_id).map((g) => g.id)
    : [];
  const snippet = `任务「${task.title}」结论与经验：${cleanedResult.slice(0, 260)}`;
  deps.candidateStore.create(
    {
      user_id: params.userId,
      agent_id: params.agentId ?? task.assignee_agent_id,
      project_id: task.project_id,
      goal_id: goalIds[0] ?? null,
      task_id: task.id,
      type: 'procedural',
      scope: task.project_id ? 'project' : 'personal',
      category: 'experience',
      content: snippet,
      source: 'work-completion',
      confidence: 0.78,
      status: 'pending',
    },
    deps.memoryStore,
  );
}

/** 项目完成时提炼项目级关键结论候选，供后续同类项目或关联目标参考。 */
export function recordProjectCompletionCandidate(
  deps: Pick<WorkOperationsDeps, 'projectStore' | 'businessTaskManager' | 'candidateStore' | 'memoryStore'>,
  userId: string,
  project: Project,
): void {
  if (!deps.candidateStore || !deps.memoryStore) return;
  const goals = deps.projectStore.listGoalsForProject(userId, project.id);
  const tasks = deps.businessTaskManager.list(userId, { project_id: project.id, limit: 10 }).items;
  const descPart = project.description.trim();
  const completedTitles = tasks
    .filter((t) => t.status === 'completed')
    .slice(0, 3)
    .map((t) => t.title)
    .join('、');

  const summary =
    descPart.length >= 12
      ? `项目「${project.title}」交付要点与经验：${descPart.slice(0, 220)}${completedTitles ? `（关键工作：${completedTitles}）` : ''}`
      : completedTitles
        ? `项目「${project.title}」完成的关键事项包括：${completedTitles}`
        : '';
  if (summary.length < 18) return;

  deps.candidateStore.create(
    {
      user_id: userId,
      project_id: project.id,
      goal_id: goals[0]?.id ?? null,
      type: 'semantic',
      scope: 'project',
      category: 'project_fact',
      content: summary,
      source: 'project-completion',
      confidence: 0.8,
      status: 'pending',
    },
    deps.memoryStore,
  );
}

export function listGoalsForUser(
  deps: Pick<WorkOperationsDeps, 'goalStore'>,
  userId: string,
  filters: GoalFilters = {},
): PageResult<Goal> {
  return deps.goalStore.list(userId, filters);
}

export function createGoalForUser(
  deps: Pick<WorkOperationsDeps, 'goalStore' | 'projectStore'>,
  userId: string,
  input: NewGoalInput,
  options: { filterForeignProjects?: boolean; userOptions?: EnsureUserOptions } = {},
): Goal {
  const projectIds = Array.isArray(input.project_ids)
    ? options.filterForeignProjects
      ? input.project_ids.filter((pid): boolean => deps.projectStore.get(userId, pid) !== undefined)
      : input.project_ids
    : undefined;

  return deps.goalStore.create(
    userId,
    {
      ...input,
      project_ids: projectIds,
    },
    options.userOptions,
  );
}

export function updateGoalForUser(
  deps: Pick<WorkOperationsDeps, 'goalStore'>,
  userId: string,
  goalId: string,
  patch: GoalPatch,
): Goal {
  const updated = deps.goalStore.update(userId, goalId, patch);
  if (!updated) {
    throw new DomainError(404, 'not_found', `Goal ${goalId} 不存在或无权访问`);
  }
  return updated;
}

export function listProjectsForUser(
  deps: Pick<WorkOperationsDeps, 'projectStore'>,
  userId: string,
  filters: ProjectFilters = {},
): PageResult<Project> {
  return deps.projectStore.list(userId, filters);
}

export function createProjectForUser(
  deps: Pick<WorkOperationsDeps, 'projectStore' | 'goalStore'>,
  userId: string,
  input: NewProjectInput,
  options: { filterForeignGoals?: boolean; userOptions?: EnsureUserOptions } = {},
): Project {
  const goalIds = Array.isArray(input.goal_ids)
    ? options.filterForeignGoals
      ? input.goal_ids.filter((gid): boolean => deps.goalStore.get(userId, gid) !== undefined)
      : input.goal_ids
    : undefined;

  return deps.projectStore.create(
    userId,
    {
      ...input,
      goal_ids: goalIds,
    },
    options.userOptions,
  );
}

export function updateProjectForUser(
  deps: Pick<
    WorkOperationsDeps,
    'projectStore' | 'businessTaskManager' | 'candidateStore' | 'memoryStore'
  >,
  userId: string,
  projectId: string,
  patch: ProjectPatch,
): Project {
  const before = deps.projectStore.get(userId, projectId);
  if (!before) {
    throw new DomainError(404, 'not_found', `Project ${projectId} 不存在或无权访问`);
  }
  const updated = deps.projectStore.update(userId, projectId, patch);
  if (!updated) {
    throw new DomainError(404, 'not_found', `Project ${projectId} 不存在或无权访问`);
  }
  if (before.status !== 'completed' && updated.status === 'completed') {
    recordProjectCompletionCandidate(deps, userId, updated);
  }
  return updated;
}

export function listTasksForUser(
  deps: Pick<WorkOperationsDeps, 'businessTaskManager'>,
  userId: string,
  filters: BusinessTaskFilters = {},
): PageResult<BusinessTask> {
  return deps.businessTaskManager.list(userId, filters);
}

export function getTaskDetailForUser(
  deps: Pick<WorkOperationsDeps, 'businessTaskManager' | 'projectStore'>,
  userId: string,
  taskId: string,
): BusinessTaskDetail & { project: Project | null } {
  const detail = deps.businessTaskManager.getDetail(userId, taskId);
  if (!detail) {
    throw new DomainError(404, 'not_found', `Task ${taskId} 不存在或无权访问`);
  }
  const project = detail.task.project_id
    ? deps.projectStore.get(userId, detail.task.project_id) ?? null
    : null;
  return { ...detail, project };
}

export function createTaskForUser(
  deps: Pick<WorkOperationsDeps, 'businessTaskManager' | 'projectStore' | 'agentStore'>,
  userId: string,
  input: NewBusinessTaskInput,
  options: { sanitizeForeignRefs?: boolean; userOptions?: EnsureUserOptions } = {},
): BusinessTask {
  let projectId: string | null | undefined = input.project_id;
  let assigneeAgentId: string | null | undefined = input.assignee_agent_id;
  let status = input.status;

  if (options.sanitizeForeignRefs) {
    projectId =
      projectId && deps.projectStore.get(userId, projectId) !== undefined ? projectId : null;
    const requestedAgent: AgentProfile | undefined = assigneeAgentId
      ? deps.agentStore.get(assigneeAgentId)
      : undefined;
    assigneeAgentId =
      requestedAgent && requestedAgent.status === 'active' ? requestedAgent.agent_id : null;
    if (status === undefined) {
      status = assigneeAgentId ? 'assigned' : 'pending';
    } else if (status === 'assigned' && !assigneeAgentId) {
      status = 'pending';
    }
  }

  return deps.businessTaskManager.create(
    userId,
    {
      ...input,
      project_id: projectId,
      assignee_agent_id: assigneeAgentId,
      status,
    },
    options.userOptions,
  );
}

export function updateTaskForUser(
  deps: Pick<WorkOperationsDeps, 'businessTaskManager'>,
  userId: string,
  taskId: string,
  patch: BusinessTaskPatch,
): BusinessTask {
  const updated = deps.businessTaskManager.update(userId, taskId, patch);
  if (!updated) {
    throw new DomainError(404, 'not_found', `Task ${taskId} 不存在或无权访问`);
  }
  return updated;
}

/** 从完整消息列表拆分出「最后一条 user 消息之前的历史轮次」，供进程内多轮 Agent Loop 注入历史上下文。 */
export function extractPriorConversationMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx <= 0) return [];
  return messages.slice(0, lastUserIdx);
}
