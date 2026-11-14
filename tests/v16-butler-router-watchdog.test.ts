/**
 * Zhiyi 下一阶段：Personal AI 管家增强（Router / Worker + Watchdog）
 *
 * 完整验收与自动化测试套件：
 * 1. 任务依赖 DAG 拓扑、循环依赖检测与前置完成条件校验
 * 2. 依赖阻塞与级联解锁：前置完成自动就绪，前置失败下游自动阻塞
 * 3. 任务验收机制（Task Acceptance）：代码/准则校验、返工次数限制与人工决策上报
 * 4. Watchdog 执行监督：停滞超时检测、死循环熔断、父任务自动收敛与重复告警去重
 * 5. Butler Coordinator 管家协调：目标理解、子任务拆解、Worker 指派与交付成果汇编
 * 6. 多用户严格数据隔离与安全防护
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentStore } from '../src/agents';
import { Database } from '../src/db';
import { createLogger } from '../src/logger';
import { MemoryStore } from '../src/memories';
import { GoalStore } from '../src/personal-ai/domain/goal-store';
import { ProjectStore } from '../src/personal-ai/domain/project-store';
import { DomainError } from '../src/personal-ai/domain/types';
import { UserProfileStore } from '../src/personal-ai/domain/user-profile-store';
import { ProactiveStore } from '../src/personal-ai/proactive/proactive-store';
import { AgentSelector } from '../src/personal-ai/runtime/agent-selector';
import { ButlerCoordinator } from '../src/personal-ai/runtime/butler-coordinator';
import { DirectExecutionRunner } from '../src/personal-ai/runtime/direct-execution-runner';
import { BusinessTaskManager } from '../src/personal-ai/task/business-task-manager';
import { BusinessTaskRepository } from '../src/personal-ai/task/business-task-repository';
import { ExecutionEventStore } from '../src/personal-ai/task/execution-event-store';
import { TaskAcceptanceManager } from '../src/personal-ai/task/task-acceptance-manager';
import { TaskDependencyRepository } from '../src/personal-ai/task/task-dependency-repository';
import { TaskRepository } from '../src/personal-ai/task/task-repository';
import { Watchdog } from '../src/personal-ai/worker/watchdog';

describe('Zhiyi Butler Router / Worker & Watchdog 测试套件', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let userProfiles: UserProfileStore;
  let taskRepo: TaskRepository;
  let eventStore: ExecutionEventStore;
  let proactiveStore: ProactiveStore;
  let dependencyRepo: TaskDependencyRepository;
  let businessRepo: BusinessTaskRepository;
  let businessTaskManager: BusinessTaskManager;
  let acceptanceManager: TaskAcceptanceManager;
  let watchdog: Watchdog;
  let agentStore: AgentStore;
  let goalStore: GoalStore;
  let projectStore: ProjectStore;
  let agentSelector: AgentSelector;

  const USER_A = 'u_alice';
  const USER_B = 'u_bob';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyi-v16-test-'));
    dbPath = path.join(tempDir, 'test.db');
    db = Database.open(dbPath);
    db.migrate();

    userProfiles = new UserProfileStore(db);
    userProfiles.ensureUser(USER_A);
    userProfiles.ensureUser(USER_B);

    taskRepo = new TaskRepository(db);
    eventStore = new ExecutionEventStore(db);
    proactiveStore = new ProactiveStore(db);
    dependencyRepo = new TaskDependencyRepository(db);
    businessRepo = new BusinessTaskRepository(db, userProfiles, taskRepo);

    agentStore = new AgentStore(db);
    agentStore.seed();
    agentStore.updateAdmin('developer', { execution_backend: 'direct_llm' });

    goalStore = new GoalStore(db, userProfiles);
    projectStore = new ProjectStore(db, userProfiles);
    agentSelector = new AgentSelector(agentStore, taskRepo);

    acceptanceManager = new TaskAcceptanceManager({
      db,
      businessRepo,
      taskRepo,
      eventStore,
      onDecisionNeeded: ({ userId, taskId, reason, reworkCount }) => {
        proactiveStore.createIfNew({
          userId,
          kind: 'decision_needed',
          entityType: 'task',
          entityId: taskId,
          dedupeKey: `acceptance:decision:${taskId}:${reworkCount}`,
          title: '任务验收未通过需人工决策',
          summary: `任务【${taskId}】在经过 ${reworkCount} 次返工后仍未通过验收（${reason}）。`,
          evidence: { task_id: taskId, reason, rework_count: reworkCount },
        });
      },
    });

    businessTaskManager = new BusinessTaskManager(
      db,
      businessRepo,
      taskRepo,
      agentStore,
      eventStore,
      undefined,
      dependencyRepo,
      acceptanceManager,
    );

    watchdog = new Watchdog({
      db,
      taskRepo,
      businessRepo,
      businessTaskManager,
      proactiveStore,
      logger: createLogger(true),
      dependencyRepo,
      eventStore,
      thresholds: {
        directStallMs: 50,
        externalStallMs: 100,
        repetitionThreshold: 3,
      },
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('1. 任务依赖 DAG 拓扑与循环依赖防御', () => {
    it('能够成功建立依赖关系，并阻止自依赖与循环依赖', () => {
      const taskA = businessTaskManager.create(USER_A, { title: '模块 A 设计' });
      const taskB = businessTaskManager.create(USER_A, { title: '模块 B 编码' });
      const taskC = businessTaskManager.create(USER_A, { title: '集成测试 C' });

      // 任务不能自依赖
      expect(() => {
        dependencyRepo.addDependency(USER_A, taskA.id, taskA.id);
      }).toThrowError(/不能依赖自身/);

      // B 依赖 A
      dependencyRepo.addDependency(USER_A, taskB.id, taskA.id);
      expect(dependencyRepo.listDependencies(USER_A, taskB.id)).toEqual([taskA.id]);
      expect(dependencyRepo.listDependents(USER_A, taskA.id)).toEqual([taskB.id]);

      // C 依赖 B
      dependencyRepo.addDependency(USER_A, taskC.id, taskB.id);

      // 循环依赖检查：若让 A 依赖 C 则形成 A -> C -> B -> A 环路
      expect(() => {
        dependencyRepo.addDependency(USER_A, taskA.id, taskC.id);
      }).toThrowError(/循环依赖/);

      // 前置完成度检查：A 尚未 completed 时，B 的前置条件未满足
      expect(dependencyRepo.areDependenciesSatisfied(USER_A, taskB.id)).toBe(false);
      const unfinished = dependencyRepo.getUnfinishedDependencies(USER_A, taskB.id);
      expect(unfinished.length).toBe(1);
      expect(unfinished[0].id).toBe(taskA.id);
    });

    it('有未完成依赖时禁止准备执行，前置完成后下游自动解锁为 ready', () => {
      const taskA = businessTaskManager.create(USER_A, { title: '数据库设计' });
      const taskB = businessTaskManager.create(USER_A, {
        title: 'API 实现',
        depends_on_task_ids: [taskA.id],
      });

      // Task B 初始有前置依赖，状态应被置为 blocked
      expect(taskB.status).toBe('blocked');

      // 试图执行未满足前置的 Task B 必须被阻断
      expect(() => {
        businessTaskManager.prepareExecution(USER_A, taskB.id, {
          agentId: 'developer',
          multicaEnabled: false,
        });
      }).toThrowError(/前置依赖任务尚未完成/);

      // 准备并执行 Task A 至完成
      const prepA = businessTaskManager.prepareExecution(USER_A, taskA.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });
      businessTaskManager.completeExecution(prepA.execution.id, {
        status: 'completed',
        result: '数据表设计已就绪',
      });

      // Task A 完成后，下游 Task B 应该被自动解锁为 ready 状态
      const refreshedB = businessTaskManager.get(USER_A, taskB.id)!;
      expect(refreshedB.status).toBe('ready');

      // 现在 Task B 的依赖已满足，可以正常进入执行
      const prepB = businessTaskManager.prepareExecution(USER_A, taskB.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });
      expect(prepB.execution.status).toBe('running');
    });

    it('前置任务执行失败时，下游任务自动被置为 blocked', () => {
      const taskA = businessTaskManager.create(USER_A, { title: '基础设施部署' });
      const taskB = businessTaskManager.create(USER_A, {
        title: '应用发布',
        depends_on_task_ids: [taskA.id],
      });

      const prepA = businessTaskManager.prepareExecution(USER_A, taskA.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });
      businessTaskManager.completeExecution(prepA.execution.id, {
        status: 'failed',
        error: '云主机配额不足',
      });

      // Task A 失败后，Task B 自动保持/收敛为 blocked
      const refreshedB = businessTaskManager.get(USER_A, taskB.id)!;
      expect(refreshedB.status).toBe('blocked');
    });
  });

  describe('2. 任务验收机制（Task Acceptance & Review Loop）', () => {
    it('开发任务验收未通过时自动触发返工，未满足条件严禁标记为 completed', () => {
      const task = businessTaskManager.create(USER_A, {
        title: 'TypeScript 快速排序算法开发',
        description: '请实现快速排序并包含复杂度分析',
        acceptance_criteria: '必须包含时间/空间复杂度分析',
      });

      const prep = businessTaskManager.prepareExecution(USER_A, task.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });

      // Worker 返回的代码中缺少「复杂度分析」
      const imperfectResult = '```typescript\nfunction quicksort(arr) {}\n```';
      businessTaskManager.completeExecution(prep.execution.id, {
        status: 'completed',
        result: imperfectResult,
      });

      // 验收未通过：任务绝不能变成 completed，而是被置为 ready 且 rework_count 增加
      const afterRework1 = businessTaskManager.get(USER_A, task.id)!;
      expect(afterRework1.status).toBe('ready');
      expect(afterRework1.review_status).toBe('rejected');
      expect(afterRework1.rework_count).toBe(1);

      // 验证事件流中有 retried 记录
      const events = eventStore.listByTask(USER_A, task.id).items;
      expect(events.some((e) => e.event_type === 'retried' && e.message.includes('返工'))).toBe(true);
    });

    it('超过最大返工次数后转为 blocked 并生成人工决策通知，绝不盲目假定成功', () => {
      const task = businessTaskManager.create(USER_A, {
        title: '关键数据迁移脚本实现',
        description: '编写迁移逻辑',
        acceptance_criteria: '必须提供单测用例',
      });

      // 模拟两次不合格的产出
      const prep1 = businessTaskManager.prepareExecution(USER_A, task.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });
      businessTaskManager.completeExecution(prep1.execution.id, {
        status: 'completed',
        result: '代码片段 TODO: 暂未实现单测',
      });

      const prep2 = businessTaskManager.prepareExecution(USER_A, task.id, {
        agentId: 'developer',
        multicaEnabled: false,
        forceRetry: true,
      });
      businessTaskManager.completeExecution(prep2.execution.id, {
        status: 'completed',
        result: '第二版实现 TODO: FIXME: 单测待补充',
      });

      // 经过 2 次返工未通过（达到上限），任务转为 blocked，等待人工决策
      const escalatedTask = businessTaskManager.get(USER_A, task.id)!;
      expect(escalatedTask.status).toBe('blocked');
      expect(escalatedTask.review_status).toBe('rejected');
      expect(escalatedTask.rework_count).toBeGreaterThanOrEqual(2);

      // 检查主动提醒中是否生成了 decision_needed 通知
      const notifications = proactiveStore.list(USER_A).items;
      const decisionNotice = notifications.find((n) => n.kind === 'decision_needed' && n.entity_id === task.id);
      expect(decisionNotice).toBeDefined();
      expect(decisionNotice?.title).toContain('人工决策');

      // 用户人工审批通过验收
      const approvedTask = acceptanceManager.manualApprove(USER_A, task.id, '经架构师复核无风险，特批上线');
      expect(approvedTask.status).toBe('completed');
      expect(approvedTask.review_status).toBe('approved');
    });

    it('合规产出能顺利通过轻量验收并收敛为 completed', () => {
      const task = businessTaskManager.create(USER_A, {
        title: '用户身份校验函数编写',
        description: '实现 JWT 验签逻辑',
        acceptance_criteria: '要求包含复杂度分析与测试用例',
      });

      const prep = businessTaskManager.prepareExecution(USER_A, task.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });

      const qualifiedResult = `
## 实现
\`\`\`typescript
export function verifyJwt(token: string): boolean { return true; }
\`\`\`
## 复杂度与测试
- 时间复杂度 O(1)，空间复杂度 O(1)
- 单元测试：it('should verify valid token', () => expect(verifyJwt('abc')).toBe(true));
`;
      businessTaskManager.completeExecution(prep.execution.id, {
        status: 'completed',
        result: qualifiedResult,
      });

      const finalTask = businessTaskManager.get(USER_A, task.id)!;
      expect(finalTask.status).toBe('completed');
      expect(finalTask.review_status).toBe('approved');
    });
  });

  describe('3. Watchdog 执行监督与异常收敛', () => {
    it('能够识别长时间无进展的停滞任务，标记为 failed + 需核实，且去重告警不重复骚扰', async () => {
      const task = businessTaskManager.create(USER_A, { title: '长时间外部同步任务' });
      const prep = businessTaskManager.prepareExecution(USER_A, task.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });

      // 故意将 started_at 和 last_progress_at 调为很久以前（模拟停滞超过 50ms）
      const past = new Date(Date.now() - 1000).toISOString();
      taskRepo.updateIfActive(prep.execution.id, {
        started_at: past,
        last_progress_at: past,
      });

      // 触发 Watchdog 巡检
      const scan1 = await watchdog.tick();
      expect(scan1.stalledExecutionsCount).toBe(1);

      // Execution 状态安全收敛为 failed + needs_verification
      const exec = taskRepo.getById(prep.execution.id)!;
      expect(exec.status).toBe('failed');
      expect(exec.needs_verification).toBe(true);

      // BusinessTask 同步收敛为 failed，不假定成功
      const t = businessTaskManager.get(USER_A, task.id)!;
      expect(t.status).toBe('failed');

      // 再次巡检，确认 dedupe_key 去重生效，不会重复产生通知
      const scan2 = await watchdog.tick();
      expect(scan2.stalledExecutionsCount).toBe(0);

      const verifyNotices = proactiveStore.list(USER_A).items.filter(
        (n) => n.kind === 'task_verification' && n.entity_id === task.id,
      );
      expect(verifyNotices.length).toBe(1);
    });

    it('检测到连续重复工具调用（死循环）时实施保护性熔断', async () => {
      const task = businessTaskManager.create(USER_A, { title: '递归分析循环任务' });
      const prep = businessTaskManager.prepareExecution(USER_A, task.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });

      // 注入 3 条参数完全相同的连续 tool_call 事件，模拟模型死循环
      for (let i = 0; i < 3; i++) {
        eventStore.record({
          executionId: prep.execution.id,
          taskId: task.id,
          userId: USER_A,
          eventType: 'tool_call',
          status: 'running',
          message: '调用 search 工具',
          metadata: { tool: 'search', query: '相同查询词' },
        });
      }

      const scan = await watchdog.tick();
      expect(scan.loopsDetectedCount).toBe(1);

      const exec = taskRepo.getById(prep.execution.id)!;
      expect(exec.status).toBe('failed');
      expect(exec.error_code).toBe('repetition_loop_detected');

      const t = businessTaskManager.get(USER_A, task.id)!;
      expect(t.status).toBe('blocked');
    });

    it('当所有子任务完成后，Watchdog 自动推进父任务为 completed', async () => {
      const parent = businessTaskManager.create(USER_A, {
        title: '大型系统重构专项',
        status: 'ready',
      });
      const sub1 = businessTaskManager.create(USER_A, {
        title: '模块 1 迁移',
        parent_task_id: parent.id,
      });
      const sub2 = businessTaskManager.create(USER_A, {
        title: '模块 2 迁移',
        parent_task_id: parent.id,
      });

      // 执行完成两项子任务
      const prep1 = businessTaskManager.prepareExecution(USER_A, sub1.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });
      businessTaskManager.completeExecution(prep1.execution.id, {
        status: 'completed',
        result: '模块 1 迁移就绪',
      });
      const prep2 = businessTaskManager.prepareExecution(USER_A, sub2.id, {
        agentId: 'developer',
        multicaEnabled: false,
      });
      businessTaskManager.completeExecution(prep2.execution.id, {
        status: 'completed',
        result: '模块 2 迁移就绪',
      });

      // Watchdog 巡检应该自动发现并推进父任务
      const scan = await watchdog.tick();
      expect(scan.parentTasksAdvancedCount).toBe(1);

      const refreshedParent = businessTaskManager.get(USER_A, parent.id)!;
      expect(refreshedParent.status).toBe('completed');

      // 验证收件箱收到父任务完成的主动汇总提醒
      const parentDoneNotice = proactiveStore.list(USER_A).items.find(
        (n) => n.kind === 'task_completed_summary' && n.entity_id === parent.id,
      );
      expect(parentDoneNotice).toBeDefined();
      expect(parentDoneNotice?.title).toContain('全部子任务已完成');
    });
  });

  describe('4. Butler Coordinator（管家 Router / Worker 编排）', () => {
    it('能够将复杂目标结构化拆解为带先后拓扑依赖的子任务体系', async () => {
      const mockModelAdapter: any = {
        complete: async () => JSON.stringify({
          parentTask: { title: '知识库向量化升级落地', description: '全面改造', priority: 2 },
          subtasks: [
            {
              step_index: 0,
              title: '阶段 1：向量模型调研与选型',
              description: '对比 BAAI 与 OpenAI Embedding',
              preferred_agent_id: 'developer',
              depends_on_indices: [],
            },
            {
              step_index: 1,
              title: '阶段 2：向量数据库接入与检索实现',
              description: '编写向量写入与召回接口',
              preferred_agent_id: 'developer',
              depends_on_indices: [0],
              acceptance_criteria: '要求代码块与复杂度分析',
            },
          ],
          rationale: '两阶段流水线',
        }),
      };

      const directRunner = new DirectExecutionRunner({
        config: {} as any,
        memoryStore: new MemoryStore(db),
        agentStore,
        modelAdapter: mockModelAdapter,
        businessTaskManager,
        logger: createLogger(true),
      });

      const butler = new ButlerCoordinator({
        agentStore,
        agentSelector,
        businessTaskManager,
        taskRepo,
        dependencyRepo,
        acceptanceManager,
        eventStore,
        proactiveStore,
        goalStore,
        projectStore,
        modelAdapter: mockModelAdapter,
        directRunner,
        logger: createLogger(true),
      });

      const plan = await butler.planComplexGoal(USER_A, '帮我调研并完成知识库向量化升级');
      expect(plan.subtasks.length).toBe(2);
      expect(plan.subtasks[1].depends_on_indices).toEqual([0]);

      // 执行落库
      const execResult = await butler.executePlan(USER_A, plan, { multicaEnabled: false });
      expect(execResult.parentTask).toBeDefined();
      expect(execResult.subtasks.length).toBe(2);

      // 第一步无前置，状态为 ready
      expect(execResult.subtasks[0].status).toBe('ready');
      // 第二步有前置依赖，状态为 blocked
      expect(execResult.subtasks[1].status).toBe('blocked');

      // 检查依赖关系已正确入库
      const sub1Deps = dependencyRepo.listDependencies(USER_A, execResult.subtasks[1].id);
      expect(sub1Deps).toEqual([execResult.subtasks[0].id]);
    });
  });

  describe('5. 多用户严格数据与权限隔离', () => {
    it('用户 A 无法访问或篡改用户 B 的任务、依赖与提醒', () => {
      const taskB = businessTaskManager.create(USER_B, { title: '用户 B 的机密任务' });

      // 用户 A 试图查询用户 B 的任务详情返回 undefined
      expect(businessTaskManager.get(USER_A, taskB.id)).toBeUndefined();
      expect(businessTaskManager.getDetail(USER_A, taskB.id)).toBeUndefined();

      // 用户 A 试图给用户 B 的任务注入依赖返回 404
      expect(() => {
        dependencyRepo.addDependency(USER_A, taskB.id, 'any_task');
      }).toThrowError(/任务不存在/);

      // 用户 A 试图执行用户 B 的任务被阻断
      expect(() => {
        businessTaskManager.prepareExecution(USER_A, taskB.id, {
          agentId: 'developer',
          multicaEnabled: false,
        });
      }).toThrowError(/业务任务不存在/);

      // 提醒记录严格隔离
      proactiveStore.createIfNew({
        userId: USER_B,
        kind: 'task_due_soon',
        entityType: 'task',
        entityId: taskB.id,
        dedupeKey: `due:${taskB.id}`,
        title: 'B 的到期提醒',
        summary: '请注意按时交付',
      });

      expect(proactiveStore.list(USER_A).items.length).toBe(0);
      expect(proactiveStore.list(USER_B).items.length).toBe(1);
    });
  });
});
