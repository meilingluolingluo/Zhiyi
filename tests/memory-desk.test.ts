/**
 * 记忆台管理 API（Memory Desk）测试套件。
 *
 * 覆盖：
 * 1. 严格 API Key 身份认证与未授权 401
 * 2. 多用户数据隔离与越权 404
 * 3. 候选记忆过滤、分页与关联证据轨迹摘要展示
 * 4. 审批强校验（无证据拒绝 400）、幂等审批与正式入库
 * 5. 候选拒绝与状态冲突防护（409）
 * 6. 手动创建记忆（source='manual'，可挂载证据）与正式记忆检索过滤
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers';

describe('Memory Desk API (/v1/memory-desk)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('1. 鉴权：未提供 API Key 或无效 Key 时返回 401', async () => {
    // 无 header
    const noKey = await harness.api('/v1/memory-desk/candidates', { key: null });
    expect(noKey.status).toBe(401);
    expect(noKey.json?.error?.type).toBe('unauthorized');

    // 无效 key
    const invalidKey = await harness.api('/v1/memory-desk/candidates', { key: 'invalid-secret-key' });
    expect(invalidKey.status).toBe(401);
    expect(invalidKey.json?.error?.type).toBe('unauthorized');

    // 支持 x-api-key 请求头
    const xApiKey = await harness.api('/v1/memory-desk/candidates', {
      key: null,
      headers: { 'x-api-key': 'dev-key-developer' },
    });
    expect(xApiKey.status).toBe(200);
  });

  it('2. 越权访问一律返回 404', async () => {
    const db = harness.deps.db;

    // 先为 u1 插入一条轨迹和候选记忆
    harness.deps.trajectoryStore.save({
      request_id: 'req_u1_iso_1',
      user_id: 'u1',
      agent_id: 'developer',
      request: JSON.stringify({ messages: [{ role: 'user', content: '我偏好用 TypeScript 开发' }] }),
      response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的，已记住。' } }] }),
    });

    const candResult = harness.deps.candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        content: '用户首选编程语言是 TypeScript',
        trajectory_id: 'req_u1_iso_1',
        confidence: 0.95,
      },
      harness.deps.memoryStore,
    );
    expect(candResult.created).toBe(true);
    const candId = candResult.candidate!.id;

    // u2 (使用 dev-key-user2) 试图查看 u1 的候选
    const getOther = await harness.api(`/v1/memory-desk/candidates/${candId}`, { key: 'dev-key-user2' });
    expect(getOther.status).toBe(404);
    expect(getOther.json?.error?.type).toBe('not_found');

    // u2 试图 approve u1 的候选
    const approveOther = await harness.api(`/v1/memory-desk/candidates/${candId}/approve`, {
      method: 'POST',
      key: 'dev-key-user2',
    });
    expect(approveOther.status).toBe(404);

    // u2 试图 reject u1 的候选
    const rejectOther = await harness.api(`/v1/memory-desk/candidates/${candId}/reject`, {
      method: 'POST',
      key: 'dev-key-user2',
    });
    expect(rejectOther.status).toBe(404);

    // u2 列表查询正式记忆，查不到 u1 的数据
    const listOther = await harness.api('/v1/memory-desk/memories', { key: 'dev-key-user2' });
    expect(listOther.status).toBe(200);
    expect(listOther.json.items).toEqual([]);
    expect(listOther.json.total).toBe(0);
  });

  it('3. 候选列表：默认 pending，支持 status 过滤与分页', async () => {
    const memoryStore = harness.deps.memoryStore;
    const candidateStore = harness.deps.candidateStore;

    candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        content: '前端构建工具统一采用 Vite',
        confidence: 0.9,
        status: 'pending',
      },
      memoryStore,
    );
    candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        content: '测试框架选用 Vitest 并开启严格模式',
        confidence: 0.85,
        status: 'pending',
      },
      memoryStore,
    );
    candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        content: '临时备选方案暂定为 Webpack',
        confidence: 0.4,
        status: 'low_confidence',
      },
      memoryStore,
    );

    // 默认查 pending
    const resDefault = await harness.api('/v1/memory-desk/candidates', { key: 'dev-key-developer' });
    expect(resDefault.status).toBe(200);
    expect(resDefault.json.items.length).toBe(2);
    expect(resDefault.json.total).toBe(2);
    expect(resDefault.json.items.every((c: any) => c.status === 'pending')).toBe(true);

    // 查 low_confidence
    const resLow = await harness.api('/v1/memory-desk/candidates?status=low_confidence', {
      key: 'dev-key-developer',
    });
    expect(resLow.status).toBe(200);
    expect(resLow.json.items.length).toBe(1);
    expect(resLow.json.total).toBe(1);
    expect(resLow.json.items[0].content).toBe('临时备选方案暂定为 Webpack');

    // 查全部 status=all
    const resAll = await harness.api('/v1/memory-desk/candidates?status=all', {
      key: 'dev-key-developer',
    });
    expect(resAll.status).toBe(200);
    expect(resAll.json.items.length).toBe(3);
    expect(resAll.json.total).toBe(3);

    // 分页 limit=1
    const resPaged = await harness.api('/v1/memory-desk/candidates?limit=1&offset=0', {
      key: 'dev-key-developer',
    });
    expect(resPaged.status).toBe(200);
    expect(resPaged.json.items.length).toBe(1);
    expect(resPaged.json.total).toBe(2);
    expect(resPaged.json.limit).toBe(1);
    expect(resPaged.json.offset).toBe(0);
  });

  it('4. 候选详情：返回候选信息与人机对话证据轨迹摘要', async () => {
    // 插入真实证据轨迹
    const trajRes = harness.deps.trajectoryStore.save({
      request_id: 'req_evidence_401',
      user_id: 'u1',
      agent_id: 'developer',
      model: 'deepseek-chat',
      request: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: '我们以后统一用 pnpm 管理前端依赖，不要用 npm。' },
        ],
      }),
      response: JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '好的，后续项目命令均使用 pnpm。',
            },
          },
        ],
      }),
    });

    const cand = harness.deps.candidateStore.create(
      {
        user_id: 'u1',
        type: 'procedural',
        scope: 'personal',
        content: '包管理工具统一使用 pnpm',
        trajectory_id: 'req_evidence_401',
        confidence: 0.95,
      },
      harness.deps.memoryStore,
    );

    const res = await harness.api(`/v1/memory-desk/candidates/${cand.candidate!.id}`, {
      key: 'dev-key-developer',
    });
    expect(res.status).toBe(200);
    expect(res.json.candidate.id).toBe(cand.candidate!.id);
    expect(res.json.evidence_trajectory_ids).toContain('req_evidence_401');
    expect(res.json.evidence_trajectories.length).toBe(1);

    const summary = res.json.evidence_trajectories[0];
    expect(summary.request_id).toBe('req_evidence_401');
    expect(summary.agent_id).toBe('developer');
    expect(summary.model).toBe('deepseek-chat');
    expect(summary.user_prompt).toBe('我们以后统一用 pnpm 管理前端依赖，不要用 npm。');
    expect(summary.assistant_response).toBe('好的，后续项目命令均使用 pnpm。');
  });

  it('5. 审批校验与幂等：无有效证据失败 400，有证据入库成功且支持幂等', async () => {
    // 场景 A: 候选完全没有关联证据 -> 400 missing_evidence
    const candNoEvidence = harness.deps.candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        content: '一条毫无由来的凭空记忆',
        confidence: 0.8,
      },
      harness.deps.memoryStore,
    );

    const approveNoEvidence = await harness.api(
      `/v1/memory-desk/candidates/${candNoEvidence.candidate!.id}/approve`,
      { method: 'POST', key: 'dev-key-developer' },
    );
    expect(approveNoEvidence.status).toBe(400);
    expect(approveNoEvidence.json?.error?.type).toBe('missing_evidence');

    // 场景 B: 候选关联了不存在的证据 ID -> 400 invalid_evidence
    const candInvalidEvidence = harness.deps.candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        content: '关联虚假 ID 的记忆',
        trajectory_id: 'req_non_existent',
        confidence: 0.8,
      },
      harness.deps.memoryStore,
    );

    const approveInvalidEvidence = await harness.api(
      `/v1/memory-desk/candidates/${candInvalidEvidence.candidate!.id}/approve`,
      { method: 'POST', key: 'dev-key-developer' },
    );
    expect(approveInvalidEvidence.status).toBe(400);
    expect(approveInvalidEvidence.json?.error?.type).toBe('invalid_evidence');

    // 场景 C: 候选有关联且存在的真实证据 -> 审批成功入库
    harness.deps.trajectoryStore.save({
      request_id: 'req_valid_trace_5',
      user_id: 'u1',
      agent_id: 'developer',
      request: JSON.stringify({ messages: [{ role: 'user', content: '我喜欢深色主题' }] }),
      response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已为你切换为深色模式。' } }] }),
    });

    const candValid = harness.deps.candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        category: 'preference',
        content: '界面主题偏好使用深色主题',
        trajectory_id: 'req_valid_trace_5',
        confidence: 0.95,
      },
      harness.deps.memoryStore,
    );
    const validId = candValid.candidate!.id;

    // 首次审批
    const approveRes1 = await harness.api(`/v1/memory-desk/candidates/${validId}/approve`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(approveRes1.status).toBe(200);
    expect(approveRes1.json.ok).toBe(true);
    expect(approveRes1.json.idempotent).toBe(false);
    expect(approveRes1.json.candidate.status).toBe('approved');
    expect(approveRes1.json.memory).toBeDefined();
    expect(approveRes1.json.memory.verified_by_user).toBe(true);
    expect(approveRes1.json.memory.content).toBe('界面主题偏好使用深色主题');

    const createdMemId = approveRes1.json.memory.memory_id;

    // 二次审批（幂等）
    const approveRes2 = await harness.api(`/v1/memory-desk/candidates/${validId}/approve`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(approveRes2.status).toBe(200);
    expect(approveRes2.json.ok).toBe(true);
    expect(approveRes2.json.idempotent).toBe(true);
    expect(approveRes2.json.memory.memory_id).toBe(createdMemId);

    // 审批后可在正式记忆列表中查到
    const memoriesRes = await harness.api('/v1/memory-desk/memories', { key: 'dev-key-developer' });
    expect(memoriesRes.status).toBe(200);
    expect(memoriesRes.json.total).toBe(1);
    expect(memoriesRes.json.items[0].memory_id).toBe(createdMemId);
    expect(memoriesRes.json.items[0].verified_by_user).toBe(true);
  });

  it('6. 拒绝流程与状态冲突保护', async () => {
    const cand = harness.deps.candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        content: '这是一条会被拒绝的候选记录',
        confidence: 0.7,
      },
      harness.deps.memoryStore,
    );
    const id = cand.candidate!.id;

    // 首次拒绝
    const rejectRes1 = await harness.api(`/v1/memory-desk/candidates/${id}/reject`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(rejectRes1.status).toBe(200);
    expect(rejectRes1.json.ok).toBe(true);
    expect(rejectRes1.json.idempotent).toBe(false);
    expect(rejectRes1.json.candidate.status).toBe('rejected');

    // 二次拒绝（幂等）
    const rejectRes2 = await harness.api(`/v1/memory-desk/candidates/${id}/reject`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(rejectRes2.status).toBe(200);
    expect(rejectRes2.json.ok).toBe(true);
    expect(rejectRes2.json.idempotent).toBe(true);

    // 试图审批已被拒绝的候选 -> 409
    const approveRejected = await harness.api(`/v1/memory-desk/candidates/${id}/approve`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(approveRejected.status).toBe(409);
  });

  it('7. 手动创建正式记忆 (POST /v1/memory-desk/memories)', async () => {
    harness.deps.trajectoryStore.save({
      request_id: 'req_manual_evidence',
      user_id: 'u1',
      agent_id: 'developer',
      request: JSON.stringify({ prompt: '用户口述：我是后端架构师' }),
      response: '收到',
    });

    // 校验 content 为空
    const emptyRes = await harness.api('/v1/memory-desk/memories', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { content: '   ' },
    });
    expect(emptyRes.status).toBe(400);

    // 创建成功
    const createRes = await harness.api('/v1/memory-desk/memories', {
      method: 'POST',
      key: 'dev-key-developer',
      body: {
        content: '职业角色是资深后端架构师',
        type: 'semantic',
        scope: 'personal',
        category: 'profile',
        confidence: 1.0,
        evidence_trajectory_ids: ['req_manual_evidence'],
      },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.json.memory).toBeDefined();
    expect(createRes.json.memory.source).toBe('manual');
    expect(createRes.json.memory.verified_by_user).toBe(true);
    expect(createRes.json.memory.evidence_trajectory_ids).toContain('req_manual_evidence');

    // 列表查询支持按 scope / type 过滤
    const filterRes = await harness.api('/v1/memory-desk/memories?scope=personal&type=semantic', {
      key: 'dev-key-developer',
    });
    expect(filterRes.status).toBe(200);
    expect(filterRes.json.total).toBe(1);
    expect(filterRes.json.items[0].content).toBe('职业角色是资深后端架构师');

    // 不匹配的 filter 查不到
    const mismatchRes = await harness.api('/v1/memory-desk/memories?scope=project', {
      key: 'dev-key-developer',
    });
    expect(mismatchRes.status).toBe(200);
    expect(mismatchRes.json.total).toBe(0);
    expect(mismatchRes.json.items).toEqual([]);
  });
});
