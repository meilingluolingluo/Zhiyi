/**
 * 项目进度真实汇总：基于 Project、BusinessTask 与 Execution 数据库记录生成结构化进度报告与下一步建议。
 * 所有统计、任务名称、失败原因与执行摘要严格来自真实业务记录，不由模型臆测。
 */
import type { ProjectStore } from '../domain/project-store';
import type { BusinessTask, Goal, Project } from '../domain/types';
import type { BusinessTaskManager } from '../task/business-task-manager';
import type { ExecutionTask, TaskRepository } from '../task/task-repository';

export interface ProjectTaskSnapshot {
  id: string;
  title: string;
  status: BusinessTask['status'];
  priority: number;
  assignee_agent_id: string | null;
  due_at: string | null;
  updated_at: string;
}

export interface ProjectExecutionSnapshot {
  execution_id: string;
  task_id: string;
  task_title: string;
  agent_id: string | null;
  execution_mode: string;
  status: ExecutionTask['status'];
  error: string | null;
  result_preview: string | null;
  updated_at: string;
}

export interface ProjectProgressSummary {
  project: Project;
  goals: Goal[];
  stats: {
    total: number;
    completed: number;
    in_progress: number;
    pending: number;
    blocked: number;
    failed: number;
    cancelled: number;
  };
  completed_tasks: ProjectTaskSnapshot[];
  in_progress_tasks: ProjectTaskSnapshot[];
  failed_or_blocked_tasks: ProjectTaskSnapshot[];
  pending_tasks: ProjectTaskSnapshot[];
  recent_executions: ProjectExecutionSnapshot[];
  next_steps: string[];
  narrative: string;
}

function toSnapshot(task: BusinessTask): ProjectTaskSnapshot {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee_agent_id: task.assignee_agent_id,
    due_at: task.due_at,
    updated_at: task.updated_at,
  };
}

export function buildProjectProgressSummary(
  deps: {
    projectStore: ProjectStore;
    businessTaskManager: BusinessTaskManager;
    taskRepo: TaskRepository;
  },
  userId: string,
  projectId: string,
): ProjectProgressSummary | undefined {
  const project = deps.projectStore.get(userId, projectId);
  if (!project) return undefined;

  const goals = deps.projectStore.listGoalsForProject(userId, project.id);
  const tasks = deps.businessTaskManager.list(userId, { project_id: project.id, limit: 200 }).items;

  const stats = {
    total: tasks.length,
    completed: 0,
    in_progress: 0,
    pending: 0,
    blocked: 0,
    failed: 0,
    cancelled: 0,
  };
  const completedTasks: ProjectTaskSnapshot[] = [];
  const inProgressTasks: ProjectTaskSnapshot[] = [];
  const failedOrBlockedTasks: ProjectTaskSnapshot[] = [];
  const pendingTasks: ProjectTaskSnapshot[] = [];
  const recentExecutions: ProjectExecutionSnapshot[] = [];

  for (const task of tasks) {
    const snap = toSnapshot(task);
    if (task.status === 'completed') {
      stats.completed += 1;
      completedTasks.push(snap);
    } else if (task.status === 'in_progress') {
      stats.in_progress += 1;
      inProgressTasks.push(snap);
    } else if (task.status === 'failed') {
      stats.failed += 1;
      failedOrBlockedTasks.push(snap);
    } else if (task.status === 'blocked') {
      stats.blocked += 1;
      failedOrBlockedTasks.push(snap);
    } else if (task.status === 'cancelled') {
      stats.cancelled += 1;
    } else {
      stats.pending += 1;
      pendingTasks.push(snap);
    }

    const latestExec = deps.taskRepo.getLatestByTaskId(userId, task.id);
    if (latestExec) {
      recentExecutions.push({
        execution_id: latestExec.id,
        task_id: task.id,
        task_title: task.title,
        agent_id: latestExec.agent_id,
        execution_mode: latestExec.execution_mode,
        status: latestExec.status,
        error: latestExec.error,
        result_preview: latestExec.result
          ? latestExec.result.replace(/\s+/g, ' ').trim().slice(0, 180)
          : null,
        updated_at: latestExec.updated_at,
      });
    }
  }

  recentExecutions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const topRecentExecutions = recentExecutions.slice(0, 6);

  const nextSteps: string[] = [];
  const failedItems = failedOrBlockedTasks.filter((t) => t.status === 'failed');
  const blockedItems = failedOrBlockedTasks.filter((t) => t.status === 'blocked');
  if (failedItems.length > 0) {
    nextSteps.push(
      `优先处理失败任务：「${failedItems[0].title}」（可重试或更换执行 Agent）。`,
    );
  }
  if (blockedItems.length > 0) {
    nextSteps.push(
      `确认阻塞事项：「${blockedItems[0].title}」正在等待决策或前置条件解除。`,
    );
  }
  if (pendingTasks.length > 0) {
    const sortedPending = [...pendingTasks].sort((a, b) => b.priority - a.priority);
    const dueFirst = sortedPending.find((t) => t.due_at !== null) ?? sortedPending[0];
    nextSteps.push(
      `推进下一项高优待办：「${dueFirst.title}」（P${dueFirst.priority}${dueFirst.due_at ? `，截止 ${dueFirst.due_at}` : ''}）。`,
    );
  }
  if (stats.total > 0 && stats.completed === stats.total && project.status === 'active') {
    nextSteps.push('项目下全部任务均已完成，可将项目状态更新为 completed 并沉淀复盘经验。');
  }
  if (nextSteps.length === 0) {
    nextSteps.push(
      stats.total === 0
        ? '当前项目暂无任务，可根据目标拆解并补充首期任务清单。'
        : '继续跟进进行中的任务执行进度。',
    );
  }

  const lines: string[] = [
    `项目「${project.title}」（${project.id}，状态=${project.status}）共有 ${stats.total} 项任务：已完成 ${stats.completed}，进行中 ${stats.in_progress}，待办 ${stats.pending}，失败/阻塞 ${stats.failed + stats.blocked}。`,
  ];
  if (completedTasks.length > 0) {
    lines.push(`已完成：${completedTasks.slice(0, 5).map((t) => t.title).join('、')}。`);
  }
  if (inProgressTasks.length > 0) {
    lines.push(`进行中：${inProgressTasks.slice(0, 5).map((t) => t.title).join('、')}。`);
  }
  if (failedOrBlockedTasks.length > 0) {
    lines.push(
      `失败或阻塞：${failedOrBlockedTasks.slice(0, 5).map((t) => `${t.title}(${t.status})`).join('、')}。`,
    );
  }
  if (topRecentExecutions.length > 0) {
    const latest = topRecentExecutions[0];
    const outcome = latest.error
      ? `失败：${latest.error}`
      : latest.result_preview
        ? `结果：${latest.result_preview}`
        : latest.status;
    lines.push(
      `近期执行进展：${latest.task_title}（Agent=${latest.agent_id ?? 'default'}，${outcome}）。`,
    );
  }
  lines.push(`建议下一步：${nextSteps[0]}`);

  return {
    project,
    goals,
    stats,
    completed_tasks: completedTasks,
    in_progress_tasks: inProgressTasks,
    failed_or_blocked_tasks: failedOrBlockedTasks,
    pending_tasks: pendingTasks,
    recent_executions: topRecentExecutions,
    next_steps: nextSteps,
    narrative: lines.join('\n'),
  };
}
