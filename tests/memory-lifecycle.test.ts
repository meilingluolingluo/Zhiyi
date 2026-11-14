/**
 * 长期记忆生命周期闭环测试套件（Memory Lifecycle Closed Loop）。
 *
 * 覆盖全流程：
 * 1. 证据生成（Evidence Trajectory）：普通对话沉淀、问候过滤、凭据脱敏、任务完成证据链
 * 2. 记忆提取与候选（Memory Extractor & Candidate）：关联证据、状态流转
 * 3. 记忆演化（Memory Evolution）：新记忆、重复、冲突、补充关系分析
 * 4. 候选审批闭环（Candidate Review & Desk API）：查看证据与分析、编辑候选、带改写审批、拒绝流转、多租户隔离
 * 5. 正式记忆检索与运行时注入（Memory Retrieval & Context Provider）：实时可见性、版本追溯、一致性
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContentHash } from '../src/candidates';
import { findEvolutionRelation } from '../src/memory-evolution';
import {
  MemoryContextProvider,
  MemoryService,
} from '../src/personal-ai/runtime/memory';
import { searchMemories } from '../src/search';
import { createHarness, type Harness } from './helpers';

describe('Memory Lifecycle Closed Loop (全生命周期闭环)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  describe('1. 交互与证据生成（Evidence Trajectory）', () => {
    it('普通有效对话自动记录证据轨迹，凭据与敏感信息自动脱敏', async () => {
      const res = await harness.api('/v1/personal-ai/chat/completions', {
        method: 'POST',
        key: 'dev-key-developer',
        body: {
          messages: [
            {
              role: 'user',
              content: '我的生产密钥是 sk-proj-1234567890abcdef1234567890abcdef，部署在内网',
            },
          ],
        },
      });
      expect(res.status).toBe(200);

      // 等待后台异步队列写入
      await harness.waitForBackground();

      // 查询轨迹存储
      const trajectories = harness.deps.trajectoryStore.list('u1', { limit: 10 }).items;
      expect(trajectories.length).toBeGreaterThan(0);
      const latest = trajectories[0];
      expect(latest.user_id).toBe('u1');
      // 敏感凭据脱敏入库
      expect(latest.request).toContain('[REDACTED_CREDENTIAL]');
      expect(latest.request).not.toContain('sk-proj-1234567890abcdef');
    });

    it('纯问候无价值交互不沉淀噪音轨迹', async () => {
      const beforeCount = harness.deps.trajectoryStore.list('u1', { limit: 10 }).total;

      const res = await harness.api('/v1/personal-ai/chat/completions', {
        method: 'POST',
        key: 'dev-key-developer',
        body: {
          messages: [{ role: 'user', content: '你好，在吗？' }],
        },
      });
      expect(res.status).toBe(200);

      await harness.waitForBackground();

      const afterCount = harness.deps.trajectoryStore.list('u1', { limit: 10 }).total;
      expect(afterCount).toBe(beforeCount);
    });

    it('后台任务完成时自动记录证据轨迹并挂载到候选记忆', async () => {
      // 通过业务任务管理器创建初始状态为 pending 的任务
      const task = harness.personalAI.businessTaskManager.create('u1', {
        title: '优化 PostgreSQL 索引',
        status: 'pending',
      });
      expect(task).toBeDefined();

      // 调用任务完成沉淀候选记忆
      const { recordTaskCompletionCandidate } = await import(
        '../src/personal-ai/domain/work-operations'
      );
      recordTaskCompletionCandidate(
        {
          businessTaskManager: harness.personalAI.businessTaskManager,
          projectStore: harness.personalAI.projectStore,
          candidateStore: harness.deps.candidateStore,
          memoryStore: harness.deps.memoryStore,
          trajectoryStore: harness.deps.trajectoryStore,
        },
        {
          userId: 'u1',
          taskId: task.id,
          agentId: 'developer',
          result: '将查询耗时从 450ms 降至 12ms，添加了复合联合索引 (user_id, created_at)',
        },
      );

      // 验证候选记忆存在，且强绑定 evidence trajectory
      const candidates = harness.deps.candidateStore.list('u1');
      expect(candidates.length).toBe(1);
      const cand = candidates[0];
      expect(cand.source).toBe('work-completion');
      expect(cand.trajectory_id).toBeTruthy();
      expect(cand.evidence_trajectory_ids).toHaveLength(1);

      // 验证对应的证据轨迹确实已入库且可追溯
      const traj = harness.deps.trajectoryStore.getById('u1', cand.trajectory_id!);
      expect(traj).toBeDefined();
      expect(traj?.task_id).toBe(task.id);
      expect(traj?.response).toContain('复合联合索引');
    });
  });

  describe('2. 记忆演化与关系分析（Memory Evolution）', () => {
    it('精准分析全新记忆、重复记忆、补充记忆和冲突记忆', async () => {
      const userId = 'u1';
      const bucket = { scope: 'project' as const, category: 'project_rule' as const };

      // 1. 全新记忆 (new)
      const emptyMemories = harness.deps.memoryStore.list(userId);
      const relNew = findEvolutionRelation(
        '用户习惯每天早晨 8 点做站会',
        bucket,
        emptyMemories,
      );
      expect(relNew.relation).toBe('new');

      // 插入一条基准正式记忆
      const baseMem = harness.deps.memoryStore.create({
        user_id: userId,
        content: '项目统一采用 pnpm 作为包管理器',
        category: 'project_rule',
        scope: 'project',
        type: 'rule',
        confidence: 1.0,
      });

      const currentMemories = harness.deps.memoryStore.list(userId);

      // 2. 重复记忆 (duplicate)
      const relDup = findEvolutionRelation(
        '项目统一采用 pnpm 作为包管理器',
        bucket,
        currentMemories,
      );
      expect(relDup.relation).toBe('duplicate');
      expect(relDup.relatedMemory?.memory_id).toBe(baseMem.memory_id);

      // 3. 补充记忆 (supplement)
      const relSupp = findEvolutionRelation(
        '项目统一采用 pnpm 作为包管理器，并开启 corepack 自动管理版本',
        bucket,
        currentMemories,
      );
      expect(relSupp.relation).toBe('supplement');
      expect(relSupp.relatedMemory?.memory_id).toBe(baseMem.memory_id);

      // 4. 冲突记忆 (conflict)
      const relConflict = findEvolutionRelation(
        '项目不再使用 pnpm，全面改用 yarn 作为包管理器',
        bucket,
        currentMemories,
      );
      expect(relConflict.relation).toBe('conflict');
      expect(relConflict.relatedMemory?.memory_id).toBe(baseMem.memory_id);

      // 5. 过时废弃 (outdated)
      const relOutdated = findEvolutionRelation(
        '旧的 pnpm 包管理器配置已废弃下线，全面清理配置文件',
        bucket,
        currentMemories,
      );
      expect(relOutdated.relation).toBe('outdated');
      expect(relOutdated.action).toBe('archive');
      expect(relOutdated.relatedMemory?.memory_id).toBe(baseMem.memory_id);

      // 6. 融合合并 (merge)
      const relMerge = findEvolutionRelation(
        '整合汇总：项目统一采用 pnpm 作为包管理器，开启严格依赖与自动锁机制',
        bucket,
        currentMemories,
      );
      expect(relMerge.relation).toBe('merge');
      expect(relMerge.action).toBe('merge');
      expect(relMerge.relatedMemory?.memory_id).toBe(baseMem.memory_id);
    });
  });

  describe('3. 候选记忆审核与编辑闭环（Candidate Review & Approval）', () => {
    it('候选详情返回演化分析结果；支持在审批前 PATCH 编辑候选；支持带改写审批入库并建立版本链', async () => {
      const userId = 'u1';
      const key = 'dev-key-developer';

      // 预先建立一条冲突基准正式记忆
      const oldMem = harness.deps.memoryStore.create({
        user_id: userId,
        content: '团队数据接口统一使用 RESTful 规范',
        category: 'project_rule',
        scope: 'project',
        type: 'rule',
        confidence: 0.95,
      });

      // 保存证据轨迹
      const traj = harness.deps.trajectoryStore.save({
        request_id: 'req_traj_evolve_1',
        user_id: userId,
        agent_id: 'architect',
        request: JSON.stringify({ messages: [{ role: 'user', content: '我们决定重构为 GraphQL' }] }),
        response: '收到，团队决定放弃 RESTful，以后所有数据接口强制使用 GraphQL。',
      });

      // 自动提取产生的候选记忆
      const candResult = harness.deps.candidateStore.create(
        {
          user_id: userId,
          agent_id: 'architect',
          content: '团队技术方案裁决，数据接口全面改用 GraphQL 规范',
          category: 'project_rule',
          scope: 'project',
          type: 'rule',
          confidence: 0.88,
          status: 'pending',
          trajectory_id: traj.record.id,
          evidence_trajectory_ids: [traj.record.id],
        },
        harness.deps.memoryStore,
      );
      expect(candResult.created).toBe(true);
      const cand = candResult.candidate!;

      // 1. GET 候选详情，验证返回 evolution_analysis 与 conflict_memory
      const detailRes = await harness.api(`/v1/memory-desk/candidates/${cand.id}`, { key });
      expect(detailRes.status).toBe(200);
      expect(detailRes.json.candidate.id).toBe(cand.id);
      expect(detailRes.json.evolution_analysis).toBeDefined();
      expect(detailRes.json.evolution_analysis.relation).toBe('conflict');
      expect(detailRes.json.conflict_memory).toBeDefined();
      expect(detailRes.json.conflict_memory.memory_id).toBe(oldMem.memory_id);

      // 2. PATCH 编辑候选记忆（修正描述与置信度，且证据轨迹不可篡改）
      const patchRes = await harness.api(`/v1/memory-desk/candidates/${cand.id}`, {
        method: 'PATCH',
        key,
        body: {
          content: '团队技术方案已裁决：所有业务数据接口强制使用 GraphQL 规范（保留原有证据）',
          confidence: 0.98,
        },
      });
      expect(patchRes.status).toBe(200);
      expect(patchRes.json.candidate.content).toBe(
        '团队技术方案已裁决：所有业务数据接口强制使用 GraphQL 规范（保留原有证据）',
      );
      // 证据轨迹保持原样未被破坏
      expect(patchRes.json.candidate.trajectory_id).toBe(traj.record.id);
      expect(patchRes.json.candidate.evidence_trajectory_ids).toEqual([traj.record.id]);

      // 3. POST approve 审批入库（带 overrides 微调）
      const approveRes = await harness.api(`/v1/memory-desk/candidates/${cand.id}/approve`, {
        method: 'POST',
        key,
        body: {
          overrides: {
            content: '团队技术决策：业务接口强制使用 GraphQL 规范',
          },
        },
      });
      expect(approveRes.status).toBe(200);
      expect(approveRes.json.candidate.status).toBe('approved');
      expect(approveRes.json.memory.memory_id).toBeDefined();

      const newMemId = approveRes.json.memory.memory_id;
      const approvedMem = harness.deps.memoryStore.getById(userId, newMemId);
      expect(approvedMem).toBeDefined();
      expect(approvedMem?.content).toBe('团队技术决策：业务接口强制使用 GraphQL 规范');

      // 检查旧版本记忆是否标记 superseded_by
      const oldMemAfter = harness.deps.memoryStore.getById(userId, oldMem.memory_id);
      expect(oldMemAfter?.superseded_by).toBe(newMemId);

      // 检查 GET /memories/:id 的 previous_versions 版本链
      const newMemDetailRes = await harness.api(`/v1/memory-desk/memories/${newMemId}`, { key });
      expect(newMemDetailRes.status).toBe(200);
      expect(newMemDetailRes.json.memory.memory_id).toBe(newMemId);
      expect(newMemDetailRes.json.previous_versions).toBeDefined();
      expect(newMemDetailRes.json.previous_versions.length).toBeGreaterThan(0);
      expect(newMemDetailRes.json.previous_versions[0].memory_id).toBe(oldMem.memory_id);

      // 4. 幂等审批验证
      const reApproveRes = await harness.api(`/v1/memory-desk/candidates/${cand.id}/approve`, {
        method: 'POST',
        key,
      });
      expect(reApproveRes.status).toBe(200);
      expect(reApproveRes.json.candidate.status).toBe('approved');
      expect(reApproveRes.json.memory.memory_id).toBe(newMemId);

      // 5. 跨租户越权隔离（u2 无法访问 u1 的候选或正式记忆）
      const unauthorizedGet = await harness.api(`/v1/memory-desk/candidates/${cand.id}`, {
        key: 'dev-key-user2',
      });
      expect(unauthorizedGet.status).toBe(404);

      const unauthorizedApprove = await harness.api(
        `/v1/memory-desk/candidates/${cand.id}/approve`,
        {
          method: 'POST',
          key: 'dev-key-user2',
        },
      );
      expect(unauthorizedApprove.status).toBe(404);
    });

    it('拒绝流程与保护：拒绝后状态置为 rejected，再次审批被拒绝', async () => {
      const userId = 'u1';
      const key = 'dev-key-developer';

      const traj = harness.deps.trajectoryStore.save({
        request_id: 'req_traj_reject_1',
        user_id: userId,
        agent_id: 'developer',
        request: JSON.stringify({ messages: [{ role: 'user', content: '测试临时想法' }] }),
        response: '这是临时想法，不需要长期记住。',
      });

      const candResult = harness.deps.candidateStore.create(
        {
          user_id: userId,
          agent_id: 'developer',
          content: '临时想法：测试自动化代码生成',
          category: 'preference',
          scope: 'personal',
          type: 'declarative',
          confidence: 0.5,
          status: 'pending',
          trajectory_id: traj.record.id,
          evidence_trajectory_ids: [traj.record.id],
        },
        harness.deps.memoryStore,
      );
      expect(candResult.created).toBe(true);
      const cand = candResult.candidate!;

      // 拒绝候选
      const rejectRes = await harness.api(`/v1/memory-desk/candidates/${cand.id}/reject`, {
        method: 'POST',
        key,
        body: { reason: '只是临时讨论，无长期价值' },
      });
      expect(rejectRes.status).toBe(200);
      expect(rejectRes.json.candidate.status).toBe('rejected');

      // 幂等拒绝
      const reReject = await harness.api(`/v1/memory-desk/candidates/${cand.id}/reject`, {
        method: 'POST',
        key,
      });
      expect(reReject.status).toBe(200);
      expect(reReject.json.candidate.status).toBe('rejected');

      // 已拒绝的候选不可再审批入库
      const tryApprove = await harness.api(`/v1/memory-desk/candidates/${cand.id}/approve`, {
        method: 'POST',
        key,
      });
      expect(tryApprove.status).toBe(409);
    });
  });

  describe('4. 正式记忆检索与运行时注入闭环（Runtime & Retrieval Consistency）', () => {
    it('审批通过后立即被 MemoryContextProvider 与 searchMemories 检索注入；拒绝的候选绝不注入；编辑后即时生效', async () => {
      const userId = 'u1';
      const key = 'dev-key-developer';

      const traj = harness.deps.trajectoryStore.save({
        request_id: 'req_traj_runtime_1',
        user_id: userId,
        agent_id: 'developer',
        request: JSON.stringify({
          messages: [{ role: 'user', content: '我日常最习惯用中文回复' }],
        }),
        response: '收到，已为您设定为中文回复。',
      });

      const candResult = harness.deps.candidateStore.create(
        {
          user_id: userId,
          agent_id: 'developer',
          content: '用户日常沟通习惯以中文为主',
          category: 'preference',
          scope: 'personal',
          type: 'preference',
          confidence: 0.9,
          status: 'pending',
          trajectory_id: traj.record.id,
          evidence_trajectory_ids: [traj.record.id],
        },
        harness.deps.memoryStore,
      );
      expect(candResult.created).toBe(true);
      const cand = candResult.candidate!;

      // 1. 在审批前，检索和 ContextProvider 均查不到此正式记忆
      const beforeResults = searchMemories(harness.deps.memoryStore, {
        user_id: userId,
        query: '中文回复沟通',
      });
      expect(beforeResults.length).toBe(0);

      const memoryService = new MemoryService({
        memoryStore: harness.deps.memoryStore,
        candidateStore: harness.deps.candidateStore,
      });
      const contextProvider = new MemoryContextProvider({
        config: harness.deps.config,
        memoryService,
      });

      const beforeContext = contextProvider.buildContext({
        identity: {
          user_id: userId,
          agent_id: 'developer',
          request_id: 'req_test_1',
          session_id: null,
          task_id: null,
          project_id: null,
        },
        queryText: '请帮我写一段自我介绍',
      });
      expect(beforeContext.injected).toBe(false);

      // 2. 审批入库
      const approveRes = await harness.api(`/v1/memory-desk/candidates/${cand.id}/approve`, {
        method: 'POST',
        key,
      });
      expect(approveRes.status).toBe(200);
      expect(approveRes.json.memory).toBeDefined();
      const memoryId = approveRes.json.memory.memory_id;

      // 3. 审批后立即被 searchMemories 检索
      const afterResults = searchMemories(harness.deps.memoryStore, {
        user_id: userId,
        query: '中文沟通',
      });
      expect(afterResults.length).toBeGreaterThan(0);
      expect(afterResults[0].memory.memory_id).toBe(memoryId);
      expect(afterResults[0].memory.content).toContain('中文');

      // 4. MemoryContextProvider 自动检索并注入上下文
      const afterContext = contextProvider.buildContext({
        identity: {
          user_id: userId,
          agent_id: 'developer',
          request_id: 'req_test_2',
          session_id: null,
          task_id: null,
          project_id: null,
        },
        queryText: '请帮我写一段中文回复',
      });
      expect(afterContext.injected).toBe(true);
      expect(afterContext.hits.length).toBeGreaterThan(0);
      expect(afterContext.hits[0].memory.memory_id).toBe(memoryId);
      expect(afterContext.text).toContain('中文');

      // 5. 编辑正式记忆，新内容即时反映在检索与注入中
      const patchMemRes = await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
        method: 'PATCH',
        key,
        body: {
          content: '用户沟通习惯优先使用简体中文与清晰结构',
        },
      });
      expect(patchMemRes.status).toBe(200);

      const updatedResults = searchMemories(harness.deps.memoryStore, {
        user_id: userId,
        query: '简体中文结构',
      });
      expect(updatedResults.length).toBeGreaterThan(0);
      expect(updatedResults[0].memory.content).toBe('用户沟通习惯优先使用简体中文与清晰结构');

      // 6. 删除正式记忆，不再被检索与注入
      const deleteMemRes = await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
        method: 'DELETE',
        key,
      });
      expect(deleteMemRes.status).toBe(200);

      const deletedResults = searchMemories(harness.deps.memoryStore, {
        user_id: userId,
        query: '简体中文结构',
      });
      expect(deletedResults.length).toBe(0);

      const deletedContext = contextProvider.buildContext({
        identity: {
          user_id: userId,
          agent_id: 'developer',
          request_id: 'req_test_3',
          session_id: null,
          task_id: null,
          project_id: null,
        },
        queryText: '请帮我写一段中文回复',
      });
      expect(deletedContext.injected).toBe(false);
      expect(deletedContext.hits.length).toBe(0);
    });
  });

  describe('5. Mem0 V3 批处理流水线、防幻觉索引与 Butler 记忆规划', () => {
    it('批内 SHA-256 哈希精确去重与 entities 实体元数据持久化', async () => {
      const userId = 'u1';
      const key = 'dev-key-developer';

      // 验证 createContentHash 幂等与规整
      const hash1 = createContentHash('用户 偏好 使用 Vue 3 开发前端！');
      const hash2 = createContentHash('用户偏好使用Vue3开发前端');
      expect(hash1).toBe(hash2);

      // 提取器产出两个同义高重复事实与实体标签
      const createdCount = harness.deps.candidateStore.createFromExtraction(
        [
          {
            type: 'semantic',
            scope: 'personal',
            category: 'preference',
            content: '用户偏好使用 Vue 3 开发前端',
            confidence: 0.9,
            reason: '明确陈述',
            entities: ['Vue3', '前端'],
            event: 'ADD',
          },
          {
            type: 'semantic',
            scope: 'personal',
            category: 'preference',
            content: '用户偏好使用 Vue 3 开发前端',
            confidence: 0.85,
            reason: '重复表述',
            entities: ['Vue3'],
            event: 'ADD',
          },
        ],
        {
          user_id: userId,
          agent_id: 'developer',
          project_id: null,
          trajectory_id: null,
          source: 'auto-extract',
          minConfidence: 0.7,
        },
        harness.deps.memoryStore,
      );

      // 批内精确去重，只落库一条
      expect(createdCount).toBe(1);

      const list = harness.deps.candidateStore.list(userId);
      expect(list.length).toBe(1);
      const cand = list[0];
      expect(cand.content).toBe('用户偏好使用 Vue 3 开发前端');
      expect(cand.entities).toEqual(['Vue3', '前端']);
      expect(cand.evolution_relation).toBe('new');

      // 通过 Memory Desk API 读取候选详情，验证 entities 与 evolution_relation 正确返回
      const detailRes = await harness.api(`/v1/memory-desk/candidates/${cand.id}`, { key });
      expect(detailRes.status).toBe(200);
      expect(detailRes.json.candidate.entities).toEqual(['Vue3', '前端']);
      expect(detailRes.json.candidate.evolution_relation).toBe('new');
    });

    it('审批通过 outdated 候选记忆时，自动归档旧版本正式记忆', async () => {
      const userId = 'u1';
      const key = 'dev-key-developer';

      // 建立一条即将废弃的旧正式记忆
      const oldMem = harness.deps.memoryStore.create({
        user_id: userId,
        content: '接口开发采用 Swagger 2.0 文档规范',
        category: 'project_rule',
        scope: 'project',
        type: 'rule',
        confidence: 0.9,
      });
      expect(oldMem.status).toBe('active');

      const traj = harness.deps.trajectoryStore.save({
        request_id: 'req_traj_outdated_1',
        user_id: userId,
        agent_id: 'developer',
        request: JSON.stringify({ messages: [{ role: 'user', content: '我们已经不再用 Swagger 2.0 了' }] }),
        response: '收到，已确认废弃 Swagger 2.0 文档规范。',
      });

      // 产生一条声明废弃该记忆的候选
      const candRes = harness.deps.candidateStore.create(
        {
          user_id: userId,
          agent_id: 'developer',
          content: '团队已废弃 Swagger 2.0 文档规范，不再维护旧接口文档',
          category: 'project_rule',
          scope: 'project',
          type: 'rule',
          confidence: 0.95,
          evolution_relation: 'outdated',
          conflict_memory_id: oldMem.memory_id,
          trajectory_id: traj.record.id,
          evidence_trajectory_ids: [traj.record.id],
        },
        harness.deps.memoryStore,
      );
      expect(candRes.created).toBe(true);
      const cand = candRes.candidate!;

      // 审批该候选
      const approveRes = await harness.api(`/v1/memory-desk/candidates/${cand.id}/approve`, {
        method: 'POST',
        key,
      });
      expect(approveRes.status).toBe(200);
      expect(approveRes.json.candidate.status).toBe('approved');

      // 验证旧正式记忆已被归档
      const oldMemAfter = harness.deps.memoryStore.getById(userId, oldMem.memory_id);
      expect(oldMemAfter?.status).toBe('archived');
      expect(oldMemAfter?.archived_at).toBeTruthy();
    });

    it('管家 ButlerCoordinator 规划复杂目标时自动检索并注入用户长期记忆约束', async () => {
      const userId = 'u1';

      // 建立一条用户强偏好与约束记忆
      harness.deps.memoryStore.create({
        user_id: userId,
        content: '团队技术栈强制要求：后端一律使用 Node.js 与 Fastify，禁止使用 Java',
        category: 'preference',
        scope: 'personal',
        type: 'rule',
        confidence: 1.0,
      });

      // 捕获模型请求的提示词
      let capturedPrompt = '';
      harness.deps.mock?.configure({
        mode: 'text',
      });

      // 使用 ButlerCoordinator 规划复杂目标
      const plan = await harness.personalAI.butlerCoordinator.planComplexGoal(
        userId,
        '为我们的微服务系统设计并搭建后端用户服务',
      );

      expect(plan).toBeDefined();
      expect(plan.subtasks.length).toBeGreaterThan(0);

      // 检查 MockUpstream 接收到的最后一次规划请求是否包含了长期记忆约束
      const lastReq = harness.deps.mock?.getLastRequest();
      if (lastReq && Array.isArray(lastReq.messages)) {
        const userMsg = lastReq.messages.find((m: any) => m.role === 'user');
        capturedPrompt = String(userMsg?.content || '');
      }

      expect(capturedPrompt).toContain('用户相关长期记忆约束');
      expect(capturedPrompt).toContain('Fastify');
    });
  });
});
