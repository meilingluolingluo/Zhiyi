/** Personal AI Runtime 装配入口：把新模块挂到现有 Gateway 上，不改动原有路由实现。 */
import express, { type Router } from 'express';
import type { AppDeps } from '../app';
import { ModelAdapter } from './adapters/model/model-adapter';
import {
  createCliRunner,
  MulticaAdapter,
} from './adapters/agent/multica-adapter';
import type { AgentExecutionAdapter } from './adapters/agent/agent-adapter';
import { loadPersonalAIConfig, type PersonalAIConfig } from './config';
import { ConversationContextStore } from './conversation/conversation-context';
import { GoalStore } from './domain/goal-store';
import { ProjectStore } from './domain/project-store';
import { UserProfileStore } from './domain/user-profile-store';
import { recordTaskCompletionCandidate } from './domain/work-operations';
import { ProactiveEngine } from './proactive/proactive-engine';
import { ProactiveScheduler } from './proactive/proactive-scheduler';
import { ProactiveStore } from './proactive/proactive-store';
import { createPersonalAIDomainRouter } from './routes-domain';
import { AgentSelector } from './runtime/agent-selector';
import { DirectExecutionRunner } from './runtime/direct-execution-runner';
import { OpenClawAgentRunner } from './runtime/openclaw/agent-runner';
import { ZhiyiToolGateway } from './runtime/openclaw/tool-gateway';
import { PersonalAIRuntime } from './runtime/personal-ai-runtime';
import { createPersonalAIRouter } from './routes';
import { executeImageGeneration } from '../upstream/media-handlers';
import { BusinessTaskManager } from './task/business-task-manager';
import { BusinessTaskRepository } from './task/business-task-repository';
import { ExecutionEventStore } from './task/execution-event-store';
import { TaskManager } from './task/task-manager';
import { TaskRepository } from './task/task-repository';
import { TaskWorker } from './worker/task-worker';

export interface PersonalAIAssembly {
  router: Router;
  worker: TaskWorker;
  config: PersonalAIConfig;
  adapter: AgentExecutionAdapter | null;
  runtime: PersonalAIRuntime;
  taskManager: TaskManager;
  executionEventStore: ExecutionEventStore;
  proactiveStore: ProactiveStore;
  proactiveEngine: ProactiveEngine;
  proactiveScheduler: ProactiveScheduler;
  userProfiles: UserProfileStore;
  goalStore: GoalStore;
  projectStore: ProjectStore;
  businessTaskManager: BusinessTaskManager;
  directRunner: DirectExecutionRunner;
  openClawRunner: OpenClawAgentRunner;
  toolGateway: ZhiyiToolGateway;
  agentSelector: AgentSelector;
}

export function createPersonalAI(
  base: AppDeps,
  configOverride?: PersonalAIConfig,
): PersonalAIAssembly {
  const baseConfig: PersonalAIConfig = configOverride ?? loadPersonalAIConfig();
  const config: PersonalAIConfig =
    configOverride?.llmIntentEnabled !== undefined
      ? baseConfig
      : {
          ...baseConfig,
          llmIntentEnabled: process.env.PHASE1_LLM_INTENT_ENABLED === 'true',
        };
  const repo: TaskRepository = new TaskRepository(base.db);
  const executionEventStore: ExecutionEventStore = new ExecutionEventStore(base.db);
  const userProfiles: UserProfileStore = new UserProfileStore(base.db);
  const goalStore: GoalStore = new GoalStore(base.db, userProfiles);
  const projectStore: ProjectStore = new ProjectStore(base.db, userProfiles);
  const businessRepo: BusinessTaskRepository = new BusinessTaskRepository(
    base.db,
    userProfiles,
    repo,
  );
  const onTaskCompleted = (params: {
    userId: string;
    taskId: string;
    agentId: string | null;
    result: string;
  }): void => {
    recordTaskCompletionCandidate(
      {
        businessTaskManager,
        projectStore,
        candidateStore: base.candidateStore,
        memoryStore: base.memoryStore,
      },
      params,
    );
  };

  const businessTaskManager: BusinessTaskManager = new BusinessTaskManager(
    base.db,
    businessRepo,
    repo,
    base.agentStore,
    executionEventStore,
    onTaskCompleted,
  );
  const taskManager: TaskManager = new TaskManager(
    repo,
    (taskId: string): void => {
      businessTaskManager.onExecutionCancelledInTx(taskId);
    },
    executionEventStore,
  );
  const conversationStore: ConversationContextStore = new ConversationContextStore(base.db);

  const adapter: AgentExecutionAdapter | null = config.multica.enabled
    ? new MulticaAdapter(
        config.multica,
        createCliRunner(config.multica, base.logger),
        base.logger,
      )
    : null;

  const worker: TaskWorker = new TaskWorker({
    config,
    multica: config.multica,
    repo,
    adapter,
    logger: base.logger,
    agentStore: base.agentStore,
    eventStore: executionEventStore,
    onExecutionTerminalInTx: (
      taskId: string,
      status: 'completed' | 'failed' | 'cancelled',
    ): void => {
      businessTaskManager.onExecutionTerminalInTx(taskId, status);
    },
    onStartupRecoverInTx: (): void => {
      businessTaskManager.reconcileOrphanedInProgressInTx();
    },
    onTaskCompleted,
  });

  const modelAdapter: ModelAdapter = new ModelAdapter({
    config: base.config,
    personalAI: config,
    transport: base.transport,
    logger: base.logger,
    upstream: base.upstream,
  });

  const directRunner: DirectExecutionRunner = new DirectExecutionRunner({
    config: base.config,
    memoryStore: base.memoryStore,
    agentStore: base.agentStore,
    modelAdapter,
    businessTaskManager,
    logger: base.logger,
  });

  const proactiveStore: ProactiveStore = new ProactiveStore(base.db);
  const proactiveEngine: ProactiveEngine = new ProactiveEngine({
    userProfiles,
    goalStore,
    projectStore,
    businessTaskManager,
    taskRepo: repo,
    proactiveStore,
    candidateStore: base.candidateStore,
  });
  const proactiveScheduler: ProactiveScheduler = new ProactiveScheduler({
    store: proactiveStore,
    engine: proactiveEngine,
    logger: base.logger,
  });

  const toolGateway: ZhiyiToolGateway = new ZhiyiToolGateway({
    memoryStore: base.memoryStore,
    candidateStore: base.candidateStore,
    businessTaskManager,
    goalStore,
    projectStore,
    agentStore: base.agentStore,
    taskRepo: repo,
    proactiveStore,
    logger: base.logger,
    generateImages: (body, options) =>
      executeImageGeneration(
        {
          config: base.config,
          transport: base.transport,
          logger: base.logger,
          mediaStore: base.mediaStore,
          upstream: base.upstream,
        },
        body,
        options,
      ),
  });

  const openClawRunner: OpenClawAgentRunner = new OpenClawAgentRunner({
    config: base.config,
    modelAdapter,
    businessTaskManager,
    toolGateway,
    logger: base.logger,
  });

  const agentSelector: AgentSelector = new AgentSelector(base.agentStore, repo);

  const runtime: PersonalAIRuntime = new PersonalAIRuntime({
    config: base.config,
    personalAI: config,
    agentStore: base.agentStore,
    memoryStore: base.memoryStore,
    trajectoryStore: base.trajectoryStore,
    queue: base.queue,
    background: base.background,
    logger: base.logger,
    modelAdapter,
    worker,
    taskManager,
    conversationStore,
    upstream: base.upstream,
    mediaStore: base.mediaStore,
    transport: base.transport,
    userProfiles,
    goalStore,
    projectStore,
    businessTaskManager,
    proactiveStore,
    agentSelector,
    directRunner,
    openClawRunner,
  });

  const router: Router = express.Router();
  router.use(
    createPersonalAIRouter({
      base,
      config,
      multica: config.multica,
      runtime,
      taskManager,
      worker,
      adapter,
      directRunner,
      openClawRunner,
    }),
  );
  router.use(
    createPersonalAIDomainRouter({
      db: base.db,
      config,
      appConfig: base.config,
      agentStore: base.agentStore,
      memoryStore: base.memoryStore,
      candidateStore: base.candidateStore,
      userProfiles,
      goalStore,
      projectStore,
      businessTaskManager,
      taskManager,
      taskRepo: repo,
      proactiveStore,
      proactiveEngine,
      worker,
      adapter,
      directRunner,
      openClawRunner,
    }),
  );

  worker.start();
  proactiveScheduler.start();
  return {
    router,
    worker,
    config,
    adapter,
    runtime,
    taskManager,
    executionEventStore,
    proactiveStore,
    proactiveEngine,
    proactiveScheduler,
    userProfiles,
    goalStore,
    projectStore,
    businessTaskManager,
    directRunner,
    openClawRunner,
    toolGateway,
    agentSelector,
  };
}

export type { PersonalAIConfig } from './config';
