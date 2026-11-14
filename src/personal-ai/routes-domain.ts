/**
 * Personal AI V1.5 领域接口路由（Step 4）：
 * - GET/PATCH /v1/personal-ai/profile
 * - /v1/personal-ai/goals...
 * - /v1/personal-ai/projects...
 * - /v1/personal-ai/work-tasks...（含 /execute、/executions、/cancel）
 */
import express, {
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type Router,
} from 'express';
import type { AgentStore } from '../agents';
import type { CandidateStore } from '../candidates';
import type { AppConfig } from '../config';
import type { Database } from '../db';
import { errorBody } from '../errors';
import type { MemoryStore } from '../memories';
import { updateProjectForUser } from './domain/work-operations';
import type { AgentExecutionAdapter } from './adapters/agent/agent-adapter';
import type { PersonalAIConfig } from './config';
import type { GoalStore } from './domain/goal-store';
import type { ProjectStore } from './domain/project-store';
import {
  DomainError,
  PROACTIVE_NOTIFICATION_KINDS,
  type GoalFilters,
  type GoalPatch,
  type GoalStatus,
  type NewBusinessTaskInput,
  type NewGoalInput,
  type NewProjectInput,
  type ProactiveNotificationKind,
  type ProjectFilters,
  type ProjectPatch,
  type ProjectStatus,
  type BusinessTaskFilters,
  type BusinessTaskPatch,
  type BusinessTaskStatus,
  type UserProfilePatch,
} from './domain/types';
import type { UserProfileStore } from './domain/user-profile-store';
import {
  resolvePersonalAIIdentity,
  type HeaderBag,
  type PersonalAIIdentity,
} from './identity/identity-manager';
import { buildProjectProgressSummary } from './proactive/project-summary';
import type { ProactiveEngine } from './proactive/proactive-engine';
import type {
  ProactiveNotificationStatus,
  ProactiveStore,
} from './proactive/proactive-store';
import { buildPersonalAIContext } from './runtime/context-builder';
import type { DirectExecutionRunner } from './runtime/direct-execution-runner';
import type { OpenClawAgentRunner } from './runtime/openclaw/agent-runner';
import { isOpenClawAgent } from './runtime/openclaw/types';
import type { BusinessTaskManager } from './task/business-task-manager';
import type { TaskManager } from './task/task-manager';
import type { TaskRepository } from './task/task-repository';
import type { TaskWorker } from './worker/task-worker';

export interface DomainRouterDeps {
  db: Database;
  config: PersonalAIConfig;
  appConfig?: AppConfig;
  agentStore?: AgentStore;
  memoryStore?: MemoryStore;
  candidateStore?: CandidateStore;
  userProfiles: UserProfileStore;
  goalStore: GoalStore;
  projectStore: ProjectStore;
  businessTaskManager: BusinessTaskManager;
  taskManager: TaskManager;
  taskRepo?: TaskRepository;
  proactiveStore?: ProactiveStore;
  proactiveEngine?: ProactiveEngine;
  worker: TaskWorker;
  adapter: AgentExecutionAdapter | null;
  directRunner: DirectExecutionRunner;
  openClawRunner?: OpenClawAgentRunner;
}

interface RawBodyRequest extends ExpressRequest {
  rawBody?: string;
}

function bodyOf(req: ExpressRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function isPlainObjectBody(req: ExpressRequest): boolean {
  return !!req.body && typeof req.body === 'object' && !Array.isArray(req.body);
}

function headerText(req: ExpressRequest, name: string): string | null {
  const raw = req.headers[name.toLowerCase()];
  const text: string | undefined = Array.isArray(raw) ? raw[0] : raw;
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function queryInt(value: unknown, fallback: number): number {
  const raw: string | undefined = queryString(value);
  if (!raw) return fallback;
  const parsed: number = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function identify(
  req: ExpressRequest,
  config: PersonalAIConfig,
): { ok: true; identity: PersonalAIIdentity } | { ok: false; status: number; error: string } {
  const body: Record<string, unknown> = bodyOf(req);
  const rawBody: string = (req as RawBodyRequest).rawBody ?? JSON.stringify(body);
  const result = resolvePersonalAIIdentity(config, req.headers as HeaderBag, body, rawBody);
  if (!result.ok || !result.identity) {
    return { ok: false, status: result.status ?? 401, error: result.error ?? '身份解析失败' };
  }
  return { ok: true, identity: result.identity };
}

function requireIdentity(
  req: ExpressRequest,
  res: ExpressResponse,
  config: PersonalAIConfig,
): PersonalAIIdentity | null {
  const auth = identify(req, config);
  if (!auth.ok) {
    res.status(auth.status).json(errorBody(auth.error, auth.status === 401 ? 'unauthorized' : 'bad_request'));
    return null;
  }
  return auth.identity;
}

function handleDomainError(res: ExpressResponse, error: unknown): void {
  if (error instanceof DomainError) {
    res.status(error.status).json(errorBody(error.message, error.code, error.type));
    return;
  }
  throw error;
}

interface TaskStatusAggregate {
  total: number;
  completed: number;
  in_progress: number;
  failed: number;
  cancelled: number;
  pending: number;
}

function aggregateStatusRows(rows: Array<{ status: string; cnt: number }>): TaskStatusAggregate {
  const stats: TaskStatusAggregate = {
    total: 0,
    completed: 0,
    in_progress: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
  };
  for (const row of rows) {
    const count: number = Number(row.cnt);
    stats.total += count;
    if (row.status === 'completed') stats.completed += count;
    else if (row.status === 'in_progress') stats.in_progress += count;
    else if (row.status === 'failed') stats.failed += count;
    else if (row.status === 'cancelled') stats.cancelled += count;
    else stats.pending += count;
  }
  return stats;
}

export function createPersonalAIDomainRouter(deps: DomainRouterDeps): Router {
  const router: Router = express.Router();

  // ===== User Profile =====
  router.get('/v1/personal-ai/profile', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    try {
      const profile = deps.userProfiles.ensureUser(identity.user_id, {
        headerTimezone: headerText(req, 'x-timezone'),
      });
      res.json({ profile });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.patch('/v1/personal-ai/profile', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!isPlainObjectBody(req)) {
      res.status(400).json(errorBody('请求体必须为 JSON 对象', 'bad_request'));
      return;
    }
    try {
      const profile = deps.userProfiles.update(
        identity.user_id,
        req.body as UserProfilePatch,
        { headerTimezone: headerText(req, 'x-timezone') },
      );
      res.json({ profile });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  // ===== Goals =====
  router.post('/v1/personal-ai/goals', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!isPlainObjectBody(req)) {
      res.status(400).json(errorBody('请求体必须为 JSON 对象', 'bad_request'));
      return;
    }
    try {
      const goal = deps.goalStore.create(
        identity.user_id,
        req.body as NewGoalInput,
        { headerTimezone: headerText(req, 'x-timezone') },
      );
      res.status(201).json({ goal });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.get('/v1/personal-ai/goals', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    try {
      const filters: GoalFilters = {
        status: queryString(req.query.status) as GoalStatus | undefined,
        limit: queryInt(req.query.limit, 50),
        offset: queryInt(req.query.offset, 0),
      };
      res.json(deps.goalStore.list(identity.user_id, filters));
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.get('/v1/personal-ai/goals/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const goal = deps.goalStore.get(identity.user_id, req.params.id);
    if (!goal) {
      res.status(404).json(errorBody('Goal 不存在或无权访问', 'not_found'));
      return;
    }
    const projects = deps.goalStore.listProjectsForGoal(identity.user_id, goal.id);
    const statRows = deps.db.all<{ status: string; cnt: number }>(
      `SELECT t.status, COUNT(DISTINCT t.id) AS cnt
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.user_id = t.user_id
         JOIN goal_projects gp ON gp.project_id = p.id AND gp.user_id = p.user_id
        WHERE gp.goal_id = ? AND gp.user_id = ? AND p.deleted_at IS NULL AND t.deleted_at IS NULL
        GROUP BY t.status`,
      [goal.id, identity.user_id],
    );
    res.json({ goal, projects, task_stats: aggregateStatusRows(statRows) });
  });

  router.patch('/v1/personal-ai/goals/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!isPlainObjectBody(req)) {
      res.status(400).json(errorBody('请求体必须为 JSON 对象', 'bad_request'));
      return;
    }
    try {
      const goal = deps.goalStore.update(
        identity.user_id,
        req.params.id,
        req.body as GoalPatch,
      );
      if (!goal) {
        res.status(404).json(errorBody('Goal 不存在或无权访问', 'not_found'));
        return;
      }
      res.json({ goal });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.delete('/v1/personal-ai/goals/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const deleted: boolean = deps.goalStore.softDelete(identity.user_id, req.params.id);
    if (!deleted) {
      res.status(404).json(errorBody('Goal 不存在或无权访问', 'not_found'));
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  router.post('/v1/personal-ai/goals/:id/projects', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const body = bodyOf(req);
    if (typeof body.project_id !== 'string' || body.project_id.trim() === '') {
      res.status(400).json(errorBody('project_id 不能为空', 'bad_request'));
      return;
    }
    const projectId: string = body.project_id.trim();
    try {
      deps.goalStore.linkProject(identity.user_id, req.params.id, projectId);
      res.json({ linked: true, goal_id: req.params.id, project_id: projectId });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.delete('/v1/personal-ai/goals/:id/projects/:projectId', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const unlinked: boolean = deps.goalStore.unlinkProject(
      identity.user_id,
      req.params.id,
      req.params.projectId,
    );
    if (!unlinked) {
      res.status(404).json(errorBody('Goal 与 Project 关联不存在或无权访问', 'not_found'));
      return;
    }
    res.json({ unlinked: true, goal_id: req.params.id, project_id: req.params.projectId });
  });

  // ===== Projects =====
  router.post('/v1/personal-ai/projects', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!isPlainObjectBody(req)) {
      res.status(400).json(errorBody('请求体必须为 JSON 对象', 'bad_request'));
      return;
    }
    try {
      const project = deps.projectStore.create(
        identity.user_id,
        req.body as NewProjectInput,
        { headerTimezone: headerText(req, 'x-timezone') },
      );
      res.status(201).json({ project });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.get('/v1/personal-ai/projects', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    try {
      const filters: ProjectFilters = {
        status: queryString(req.query.status) as ProjectStatus | undefined,
        goal_id: queryString(req.query.goal_id),
        limit: queryInt(req.query.limit, 50),
        offset: queryInt(req.query.offset, 0),
      };
      res.json(deps.projectStore.list(identity.user_id, filters));
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.get('/v1/personal-ai/projects/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const project = deps.projectStore.get(identity.user_id, req.params.id);
    if (!project) {
      res.status(404).json(errorBody('Project 不存在或无权访问', 'not_found'));
      return;
    }
    const goals = deps.projectStore.listGoalsForProject(identity.user_id, project.id);
    const statRows = deps.db.all<{ status: string; cnt: number }>(
      `SELECT status, COUNT(*) AS cnt
         FROM tasks
        WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL
        GROUP BY status`,
      [project.id, identity.user_id],
    );
    res.json({ project, goals, task_stats: aggregateStatusRows(statRows) });
  });

  router.patch('/v1/personal-ai/projects/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!isPlainObjectBody(req)) {
      res.status(400).json(errorBody('请求体必须为 JSON 对象', 'bad_request'));
      return;
    }
    try {
      const project = updateProjectForUser(
        {
          projectStore: deps.projectStore,
          businessTaskManager: deps.businessTaskManager,
          candidateStore: deps.candidateStore,
          memoryStore: deps.memoryStore,
        },
        identity.user_id,
        req.params.id,
        req.body as ProjectPatch,
      );
      res.json({ project });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.delete('/v1/personal-ai/projects/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const deleted: boolean = deps.projectStore.softDelete(identity.user_id, req.params.id);
    if (!deleted) {
      res.status(404).json(errorBody('Project 不存在或无权访问', 'not_found'));
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ===== Business Tasks (/v1/personal-ai/work-tasks) =====
  router.post('/v1/personal-ai/work-tasks', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!isPlainObjectBody(req)) {
      res.status(400).json(errorBody('请求体必须为 JSON 对象', 'bad_request'));
      return;
    }
    try {
      const task = deps.businessTaskManager.create(
        identity.user_id,
        req.body as NewBusinessTaskInput,
        { headerTimezone: headerText(req, 'x-timezone') },
      );
      res.status(201).json({ task });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.get('/v1/personal-ai/work-tasks', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    try {
      const rawParent = req.query.parent_task_id;
      const parentTaskId: string | null | undefined =
        rawParent === 'null'
          ? null
          : queryString(rawParent);
      const filters: BusinessTaskFilters = {
        project_id: queryString(req.query.project_id),
        status: queryString(req.query.status) as BusinessTaskStatus | undefined,
        parent_task_id: parentTaskId,
        limit: queryInt(req.query.limit, 50),
        offset: queryInt(req.query.offset, 0),
      };
      res.json(deps.businessTaskManager.list(identity.user_id, filters));
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.get('/v1/personal-ai/work-tasks/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const detail = deps.businessTaskManager.getDetail(identity.user_id, req.params.id);
    if (!detail) {
      res.status(404).json(errorBody('业务任务不存在或无权访问', 'not_found'));
      return;
    }
    res.json(detail);
  });

  router.patch('/v1/personal-ai/work-tasks/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!isPlainObjectBody(req)) {
      res.status(400).json(errorBody('请求体必须为 JSON 对象', 'bad_request'));
      return;
    }
    try {
      const task = deps.businessTaskManager.update(
        identity.user_id,
        req.params.id,
        req.body as BusinessTaskPatch,
      );
      if (!task) {
        res.status(404).json(errorBody('业务任务不存在或无权访问', 'not_found'));
        return;
      }
      res.json({ task });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.delete('/v1/personal-ai/work-tasks/:id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const cascade: boolean = String(req.query.cascade ?? '').toLowerCase() === 'true';
    try {
      const deleted: boolean = deps.businessTaskManager.softDelete(
        identity.user_id,
        req.params.id,
        cascade,
      );
      if (!deleted) {
        res.status(404).json(errorBody('业务任务不存在或无权访问', 'not_found'));
        return;
      }
      res.json({ deleted: true, id: req.params.id });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.post('/v1/personal-ai/work-tasks/:id/approve', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const acceptanceManager = deps.businessTaskManager.getAcceptanceManager();
    if (!acceptanceManager) {
      res.status(501).json(errorBody('TaskAcceptanceManager 未配置', 'not_implemented'));
      return;
    }
    const body = bodyOf(req);
    const note = typeof body.note === 'string' ? body.note : undefined;
    try {
      const task = acceptanceManager.manualApprove(identity.user_id, req.params.id, note);
      res.json({ task });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.get('/v1/personal-ai/work-tasks/:id/dependencies', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const dependencyRepo = deps.businessTaskManager.getDependencyRepo();
    if (!dependencyRepo) {
      res.status(501).json(errorBody('TaskDependencyRepository 未配置', 'not_implemented'));
      return;
    }
    try {
      const dependencies = dependencyRepo.listDependencies(identity.user_id, req.params.id);
      const dependents = dependencyRepo.listDependents(identity.user_id, req.params.id);
      res.json({ dependencies, dependents });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.post('/v1/personal-ai/work-tasks/:id/dependencies', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const dependencyRepo = deps.businessTaskManager.getDependencyRepo();
    if (!dependencyRepo) {
      res.status(501).json(errorBody('TaskDependencyRepository 未配置', 'not_implemented'));
      return;
    }
    const body = bodyOf(req);
    const dependsOnId = typeof body.depends_on_id === 'string' ? body.depends_on_id.trim() : '';
    if (!dependsOnId) {
      res.status(400).json(errorBody('depends_on_id 不能为空', 'invalid_request'));
      return;
    }
    try {
      const dep = dependencyRepo.addDependency(identity.user_id, req.params.id, dependsOnId);
      res.status(201).json({ dependency: dep });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.delete('/v1/personal-ai/work-tasks/:id/dependencies/:depends_on_id', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const dependencyRepo = deps.businessTaskManager.getDependencyRepo();
    if (!dependencyRepo) {
      res.status(501).json(errorBody('TaskDependencyRepository 未配置', 'not_implemented'));
      return;
    }
    try {
      const removed = dependencyRepo.removeDependency(identity.user_id, req.params.id, req.params.depends_on_id);
      res.json({ removed });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  async function handleExecuteOrRetry(
    req: ExpressRequest,
    res: ExpressResponse,
  ): Promise<void> {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const body = bodyOf(req);
    const agentId: string | undefined =
      typeof body.agent_id === 'string' && body.agent_id.trim() !== ''
        ? body.agent_id.trim()
        : undefined;
    const forceRetry: boolean = body.force_retry === true;

    try {
      const prepared = deps.businessTaskManager.prepareExecution(
        identity.user_id,
        req.params.id,
        {
          agentId,
          conversationId: identity.conversation_id,
          multicaEnabled: deps.config.multica.enabled,
          defaultAgentId: 'developer',
          forceRetry,
        },
      );

      if (prepared.agent.execution_backend === 'direct_llm') {
        if (isOpenClawAgent(prepared.agent) && deps.openClawRunner) {
          const taskPrompt = [prepared.task.title, prepared.task.description]
            .filter(Boolean)
            .join('\n\n');
          const builtContext =
            deps.appConfig && deps.memoryStore && deps.agentStore
              ? buildPersonalAIContext(
                  {
                    config: deps.appConfig,
                    memoryStore: deps.memoryStore,
                    agentStore: deps.agentStore,
                    userProfiles: deps.userProfiles,
                    goalStore: deps.goalStore,
                    projectStore: deps.projectStore,
                    businessTaskManager: deps.businessTaskManager,
                  },
                  identity,
                  [{ role: 'user', content: taskPrompt || prepared.task.title }],
                )
              : undefined;
          await deps.openClawRunner.run(
            prepared.task,
            prepared.execution,
            prepared.agent,
            identity,
            { prebuiltSystemMessage: builtContext?.systemMessage },
          );
        } else {
          await deps.directRunner.run(
            prepared.task,
            prepared.execution,
            prepared.agent,
            identity,
          );
        }
        const latestTask = deps.businessTaskManager.get(identity.user_id, prepared.task.id);
        const latestExecution = deps.taskManager.getForUser(
          identity.user_id,
          prepared.execution.id,
        );
        res.status(200).json({ task: latestTask, execution: latestExecution });
        return;
      }

      await deps.worker.dispatch(prepared.execution.id);
      const latestTask = deps.businessTaskManager.get(identity.user_id, prepared.task.id);
      const latestExecution = deps.taskManager.getForUser(
        identity.user_id,
        prepared.execution.id,
      );
      res.status(202).json({ task: latestTask, execution: latestExecution });
    } catch (error) {
      handleDomainError(res, error);
    }
  }

  router.post('/v1/personal-ai/work-tasks/:id/execute', handleExecuteOrRetry);
  router.post('/v1/personal-ai/work-tasks/:id/retry', handleExecuteOrRetry);

  router.get('/v1/personal-ai/work-tasks/:id/executions', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const limit: number = queryInt(req.query.limit, 50);
    const offset: number = queryInt(req.query.offset, 0);
    const page = deps.businessTaskManager.listExecutions(
      identity.user_id,
      req.params.id,
      limit,
      offset,
    );
    if (!page) {
      res.status(404).json(errorBody('业务任务不存在或无权访问', 'not_found'));
      return;
    }
    res.json({ ...page, limit: Math.min(Math.max(limit, 1), 200), offset });
  });

  router.get('/v1/personal-ai/work-tasks/:id/events', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const limit: number = queryInt(req.query.limit, 100);
    const offset: number = queryInt(req.query.offset, 0);
    const page = deps.businessTaskManager.listExecutionEvents(
      identity.user_id,
      req.params.id,
      limit,
      offset,
    );
    if (!page) {
      res.status(404).json(errorBody('业务任务不存在或无权访问', 'not_found'));
      return;
    }
    res.json({ ...page, limit: Math.min(Math.max(limit, 1), 200), offset });
  });

  router.post('/v1/personal-ai/work-tasks/:id/cancel', async (req, res): Promise<void> => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    try {
      const outcome = deps.businessTaskManager.cancelTask(identity.user_id, req.params.id);
      let externalCancelled = false;
      for (const exec of outcome.cancelled_executions) {
        if (exec.execution_mode === 'direct_llm') {
          if (deps.directRunner.abort(exec.id)) externalCancelled = true;
          if (deps.openClawRunner?.abort(exec.id)) externalCancelled = true;
        } else if (exec.external_task_id && deps.adapter?.cancelTask) {
          const ok: boolean = await deps.adapter.cancelTask(
            exec.external_task_id,
            exec.external_run_id ?? undefined,
          );
          if (ok) externalCancelled = true;
        }
      }
      res.json({
        ok: true,
        task: outcome.task,
        cancelled_executions: outcome.cancelled_executions,
        external_cancelled: externalCancelled,
      });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  // ===== 项目进度真实汇总与主动提醒收件箱 =====
  router.get('/v1/personal-ai/projects/:id/summary', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!deps.taskRepo) {
      res.status(503).json(errorBody('TaskRepository 未配置', 'service_unavailable'));
      return;
    }
    const summary = buildProjectProgressSummary(
      {
        projectStore: deps.projectStore,
        businessTaskManager: deps.businessTaskManager,
        taskRepo: deps.taskRepo,
      },
      identity.user_id,
      req.params.id,
    );
    if (!summary) {
      res.status(404).json(errorBody('Project 不存在或无权访问', 'not_found'));
      return;
    }
    res.json(summary);
  });

  router.get('/v1/personal-ai/proactive/notifications', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!deps.proactiveStore) {
      res.json({ items: [], total: 0, unread_count: 0, limit: 50, offset: 0 });
      return;
    }
    const rawStatus = queryString(req.query.status);
    const status: ProactiveNotificationStatus | 'all' =
      rawStatus === 'unread' || rawStatus === 'read' || rawStatus === 'dismissed'
        ? rawStatus
        : 'all';
    const rawKind = queryString(req.query.kind);
    const kind =
      rawKind && PROACTIVE_NOTIFICATION_KINDS.includes(rawKind as ProactiveNotificationKind)
        ? (rawKind as ProactiveNotificationKind)
        : undefined;
    const limit = queryInt(req.query.limit, 50);
    const offset = queryInt(req.query.offset, 0);
    res.json(deps.proactiveStore.list(identity.user_id, { status, kind, limit, offset }));
  });

  router.post('/v1/personal-ai/proactive/notifications/:id/read', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!deps.proactiveStore) {
      res.status(404).json(errorBody('主动提醒功能未启用', 'not_found'));
      return;
    }
    const updated = deps.proactiveStore.markRead(identity.user_id, req.params.id);
    if (!updated) {
      res.status(404).json(errorBody('主动提醒不存在或无权访问', 'not_found'));
      return;
    }
    res.json({ notification: updated });
  });

  router.post('/v1/personal-ai/proactive/notifications/:id/dismiss', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!deps.proactiveStore) {
      res.status(404).json(errorBody('主动提醒功能未启用', 'not_found'));
      return;
    }
    const updated = deps.proactiveStore.dismiss(identity.user_id, req.params.id);
    if (!updated) {
      res.status(404).json(errorBody('主动提醒不存在或无权访问', 'not_found'));
      return;
    }
    res.json({ notification: updated });
  });

  router.get('/v1/personal-ai/proactive/status', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    const profile = deps.userProfiles.ensureUser(identity.user_id, {
      headerTimezone: headerText(req, 'x-timezone'),
    });
    const schedule = deps.proactiveStore?.getScheduleState(identity.user_id) ?? null;
    const unreadCount =
      deps.proactiveStore?.list(identity.user_id, { status: 'unread', limit: 1 }).unread_count ?? 0;
    res.json({
      proactive_enabled: profile.preferences.proactive_enabled !== false,
      preferences: {
        proactive_enabled: profile.preferences.proactive_enabled ?? true,
        proactive_frequency: profile.preferences.proactive_frequency ?? 'balanced',
        proactive_types: profile.preferences.proactive_types ?? null,
        proactive_quiet_hours: profile.preferences.proactive_quiet_hours ?? null,
        proactive_paused_until: profile.preferences.proactive_paused_until ?? null,
      },
      timezone: profile.timezone,
      schedule,
      unread_count: unreadCount,
    });
  });

  router.patch('/v1/personal-ai/proactive/preferences', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!isPlainObjectBody(req)) {
      res.status(400).json(errorBody('请求体必须为 JSON 对象', 'bad_request'));
      return;
    }
    try {
      const profile = deps.userProfiles.update(
        identity.user_id,
        { preferences: req.body },
        { headerTimezone: headerText(req, 'x-timezone') },
      );
      res.json({ profile });
    } catch (error) {
      handleDomainError(res, error);
    }
  });

  router.post('/v1/personal-ai/proactive/run', (req, res): void => {
    const identity = requireIdentity(req, res, deps.config);
    if (!identity) return;
    if (!deps.proactiveEngine) {
      res.status(503).json(errorBody('ProactiveEngine 未配置', 'service_unavailable'));
      return;
    }
    const body = bodyOf(req);
    const outcome = deps.proactiveEngine.evaluateUser(identity.user_id, {
      respectCooldown: body.respect_cooldown === true,
      ignoreQuietHours: body.ignore_quiet_hours === true,
    });
    res.json(outcome);
  });

  return router;
}
