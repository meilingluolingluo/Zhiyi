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
import { searchMemories } from '../src/search';
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

  it('8. 正式记忆详情 (GET /v1/memory-desk/memories/:id)：字段完整、证据状态识别与越权 404', async () => {
    // 场景 A: 手动创建记忆无证据 -> evidence_status: manual_no_evidence
    const manualMem = await harness.api('/v1/memory-desk/memories', {
      method: 'POST',
      key: 'dev-key-developer',
      body: {
        content: '个人偏好使用 VS Code 编辑器',
        type: 'semantic',
        scope: 'personal',
      },
    });
    expect(manualMem.status).toBe(201);
    const manualId = manualMem.json.memory.memory_id;

    const detailManual = await harness.api(`/v1/memory-desk/memories/${manualId}`, {
      key: 'dev-key-developer',
    });
    expect(detailManual.status).toBe(200);
    expect(detailManual.json.memory.memory_id).toBe(manualId);
    expect(detailManual.json.memory.source).toBe('manual');
    expect(detailManual.json.evidence_status).toBe('manual_no_evidence');
    expect(detailManual.json.evidence_trajectories).toEqual([]);

    // 场景 B: 携带真实证据的记忆 -> evidence_status: available
    harness.deps.trajectoryStore.save({
      request_id: 'req_detail_evidence_1',
      user_id: 'u1',
      agent_id: 'developer',
      model: 'deepseek-chat',
      request: JSON.stringify({ messages: [{ role: 'user', content: '我习惯写 Rust 代码' }] }),
      response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已记住偏好 Rust' } }] }),
    });

    const memWithEvidence = await harness.api('/v1/memory-desk/memories', {
      method: 'POST',
      key: 'dev-key-developer',
      body: {
        content: '编程语言首选 Rust',
        type: 'semantic',
        scope: 'personal',
        evidence_trajectory_ids: ['req_detail_evidence_1'],
      },
    });
    const withEvId = memWithEvidence.json.memory.memory_id;

    const detailWithEv = await harness.api(`/v1/memory-desk/memories/${withEvId}`, {
      key: 'dev-key-developer',
    });
    expect(detailWithEv.status).toBe(200);
    expect(detailWithEv.json.evidence_status).toBe('available');
    expect(detailWithEv.json.evidence_trajectories.length).toBe(1);
    expect(detailWithEv.json.evidence_trajectories[0].user_prompt).toBe('我习惯写 Rust 代码');
    expect(detailWithEv.json.evidence_trajectories[0].assistant_response).toBe('已记住偏好 Rust');
    expect(detailWithEv.json.evidence_trajectories[0].status).toBe('available');
    expect(detailWithEv.json.evidence_trajectories[0].content_type).toBe('raw');

    // 场景 C: 证据记录存在但轨迹不存在 -> evidence_status: missing
    // 直接在数据库插入一条挂载了不存在轨迹的记录
    const memoryStore = harness.deps.memoryStore;
    const missingMem = memoryStore.create({
      user_id: 'u1',
      content: '记忆挂载了不存在的证据',
      source: 'candidate:cand_fake',
      evidence_trajectory_ids: ['req_gone_404'],
    });

    const detailMissing = await harness.api(`/v1/memory-desk/memories/${missingMem.memory_id}`, {
      key: 'dev-key-developer',
    });
    expect(detailMissing.status).toBe(200);
    expect(detailMissing.json.evidence_status).toBe('missing');
    expect(detailMissing.json.evidence_trajectories[0].status).toBe('missing');
    expect(detailMissing.json.evidence_trajectories[0].content_type).toBe('unavailable');

    // 场景 D: 不存在的 ID -> 404
    const notFoundRes = await harness.api('/v1/memory-desk/memories/mem_not_exist', {
      key: 'dev-key-developer',
    });
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.json?.error?.type).toBe('not_found');

    // 场景 E: 越权访问（用户 2 查用户 1 的记忆详情） -> 404
    const crossUserRes = await harness.api(`/v1/memory-desk/memories/${manualId}`, {
      key: 'dev-key-user2',
    });
    expect(crossUserRes.status).toBe(404);
    expect(crossUserRes.json?.error?.type).toBe('not_found');
  });

  it('9. 正式记忆编辑 (PATCH /v1/memory-desk/memories/:id)：字段校验、权限保护与防篡改', async () => {
    // 先创建一条基准记忆
    const created = await harness.api('/v1/memory-desk/memories', {
      method: 'POST',
      key: 'dev-key-developer',
      body: {
        content: '最初的规范描述：前端使用 React 框架',
        type: 'semantic',
        scope: 'personal',
        category: 'preference',
      },
    });
    expect(created.status).toBe(201);
    const memId = created.json.memory.memory_id;

    // 1. 正常编辑 content 与 category
    const editOk = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: {
        content: '更新后的规范描述：前端全面迁移至 Vue 3 与 Vite',
        category: 'experience',
      },
    });
    expect(editOk.status).toBe(200);
    expect(editOk.json.memory.content).toBe('更新后的规范描述：前端全面迁移至 Vue 3 与 Vite');
    expect(editOk.json.memory.category).toBe('experience');
    expect(editOk.json.memory.source).toBe('manual');

    // 2. 防篡改：禁止修改 memory_id
    const tamperId = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { memory_id: 'mem_tampered_id' },
    });
    expect(tamperId.status).toBe(400);
    expect(tamperId.json?.error?.message).toContain('不允许修改记忆 ID');

    // 3. 防篡改：禁止修改 user_id
    const tamperUser = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { user_id: 'u2' },
    });
    expect(tamperUser.status).toBe(400);
    expect(tamperUser.json?.error?.message).toContain('不允许修改所属用户');

    // 4. 防篡改：禁止修改 source
    const tamperSource = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { source: 'candidate:cand_spoof' },
    });
    expect(tamperSource.status).toBe(400);
    expect(tamperSource.json?.error?.message).toContain('不允许篡改记忆原始来源');

    // 5. 校验：非法枚举值
    const invalidType = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { type: 'invalid_type' },
    });
    expect(invalidType.status).toBe(400);
    expect(invalidType.json?.error?.type).toBe('invalid_enum');

    const invalidScope = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { scope: 'super_scope' },
    });
    expect(invalidScope.status).toBe(400);
    expect(invalidScope.json?.error?.type).toBe('invalid_enum');

    // 6. 校验：空 content
    const emptyContent = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { content: '   ' },
    });
    expect(emptyContent.status).toBe(400);
    expect(emptyContent.json?.error?.type).toBe('bad_request');

    // 7. 越权编辑：用户 2 尝试编辑用户 1 的记忆 -> 404
    const crossEdit = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'PATCH',
      key: 'dev-key-user2',
      body: { content: '试图越权篡改他人记忆' },
    });
    expect(crossEdit.status).toBe(404);
    expect(crossEdit.json?.error?.type).toBe('not_found');
  });

  it('10. 正式记忆删除 (DELETE /v1/memory-desk/memories/:id)：防误删证据、幂等404与索引清理', async () => {
    // 创建真实轨迹作为证据
    harness.deps.trajectoryStore.save({
      request_id: 'req_delete_safe_trace',
      user_id: 'u1',
      agent_id: 'developer',
      request: JSON.stringify({ prompt: '测试保留底层轨迹' }),
      response: '收到',
    });

    const mem = await harness.api('/v1/memory-desk/memories', {
      method: 'POST',
      key: 'dev-key-developer',
      body: {
        content: '这是一条待删除的临时记忆',
        evidence_trajectory_ids: ['req_delete_safe_trace'],
      },
    });
    const memId = mem.json.memory.memory_id;

    // 越权删除：用户 2 尝试删除 -> 404
    const crossDelete = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'DELETE',
      key: 'dev-key-user2',
    });
    expect(crossDelete.status).toBe(404);
    expect(crossDelete.json?.error?.type).toBe('not_found');

    // 首次正常删除
    const deleteRes1 = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'DELETE',
      key: 'dev-key-developer',
    });
    expect(deleteRes1.status).toBe(200);
    expect(deleteRes1.json.ok).toBe(true);
    expect(deleteRes1.json.deleted).toBe(true);
    expect(deleteRes1.json.memory_id).toBe(memId);

    // 重复删除返回 404
    const deleteRes2 = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      method: 'DELETE',
      key: 'dev-key-developer',
    });
    expect(deleteRes2.status).toBe(404);
    expect(deleteRes2.json?.error?.type).toBe('not_found');

    // 详情再查返回 404
    const detailAfterDel = await harness.api(`/v1/memory-desk/memories/${memId}`, {
      key: 'dev-key-developer',
    });
    expect(detailAfterDel.status).toBe(404);

    // 列表再查查不到
    const listAfterDel = await harness.api('/v1/memory-desk/memories', {
      key: 'dev-key-developer',
    });
    expect(listAfterDel.json.items.some((m: any) => m.memory_id === memId)).toBe(false);

    // 验证：底层轨迹未被误删
    const traj = harness.deps.trajectoryStore.getById('u1', 'req_delete_safe_trace');
    expect(traj).toBeDefined();
    expect(traj?.request_id).toBe('req_delete_safe_trace');
  });

  it('11. 分页规范与参数校验：默认 limit=20、上限 100 与非法数值拒绝 400', async () => {
    // 1. 默认分页参数测试
    const defaultCandidates = await harness.api('/v1/memory-desk/candidates', {
      key: 'dev-key-developer',
    });
    expect(defaultCandidates.status).toBe(200);
    expect(defaultCandidates.json.limit).toBe(20);
    expect(defaultCandidates.json.offset).toBe(0);

    const defaultMemories = await harness.api('/v1/memory-desk/memories', {
      key: 'dev-key-developer',
    });
    expect(defaultMemories.status).toBe(200);
    expect(defaultMemories.json.limit).toBe(20);
    expect(defaultMemories.json.offset).toBe(0);

    // 2. 超限截断测试 (limit=500 -> 截断为 100)
    const cappedMemories = await harness.api('/v1/memory-desk/memories?limit=500', {
      key: 'dev-key-developer',
    });
    expect(cappedMemories.status).toBe(200);
    expect(cappedMemories.json.limit).toBe(100);

    // 3. 非法 limit 校验 (<=0 或非正整数 -> 400)
    const invalidLimit1 = await harness.api('/v1/memory-desk/memories?limit=0', {
      key: 'dev-key-developer',
    });
    expect(invalidLimit1.status).toBe(400);
    expect(invalidLimit1.json?.error?.message).toContain('limit 必须是大于 0 的有效正整数');

    const invalidLimit2 = await harness.api('/v1/memory-desk/candidates?limit=-5', {
      key: 'dev-key-developer',
    });
    expect(invalidLimit2.status).toBe(400);
    expect(invalidLimit2.json?.error?.message).toContain('limit 必须是大于 0 的有效正整数');

    const invalidLimit3 = await harness.api('/v1/memory-desk/memories?limit=abc', {
      key: 'dev-key-developer',
    });
    expect(invalidLimit3.status).toBe(400);

    // 4. 非法 offset 校验 (<0 或非负整数 -> 400)
    const invalidOffset1 = await harness.api('/v1/memory-desk/memories?offset=-1', {
      key: 'dev-key-developer',
    });
    expect(invalidOffset1.status).toBe(400);
    expect(invalidOffset1.json?.error?.message).toContain('offset 必须是非负整数');

    const invalidOffset2 = await harness.api('/v1/memory-desk/candidates?offset=xyz', {
      key: 'dev-key-developer',
    });
    expect(invalidOffset2.status).toBe(400);

    // 5. 非法候选 status 校验
    const invalidStatus = await harness.api('/v1/memory-desk/candidates?status=not_a_status', {
      key: 'dev-key-developer',
    });
    expect(invalidStatus.status).toBe(400);
    expect(invalidStatus.json?.error?.type).toBe('invalid_enum');
  });

  it('12. Memory Core 检索一致性：创建、审批、修改、删除在检索中即时同步', async () => {
    // 1. 录入轨迹与候选
    harness.deps.trajectoryStore.save({
      request_id: 'req_retrieval_flow_1',
      user_id: 'u1',
      agent_id: 'developer',
      request: JSON.stringify({ messages: [{ role: 'user', content: '我们数据库采用 PostgreSQL 分布式集群' }] }),
      response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的，记住了数据库选型。' } }] }),
    });

    const cand = harness.deps.candidateStore.create(
      {
        user_id: 'u1',
        type: 'semantic',
        scope: 'personal',
        content: '数据库选型确定为 PostgreSQL 分布式集群',
        trajectory_id: 'req_retrieval_flow_1',
        confidence: 0.95,
      },
      harness.deps.memoryStore,
    );
    const candId = cand.candidate!.id;

    // 此时未审批，Memory Retrieval 搜不到
    let hits = searchMemories(harness.deps.memoryStore, {
      query: 'PostgreSQL 数据库',
      user_id: 'u1',
    });
    expect(hits.length).toBe(0);

    // 2. 审批通过
    const approveRes = await harness.api(`/v1/memory-desk/candidates/${candId}/approve`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(approveRes.status).toBe(200);
    const memoryId = approveRes.json.memory.memory_id;

    // 审批后，立即能检索出来
    hits = searchMemories(harness.deps.memoryStore, {
      query: 'PostgreSQL 数据库',
      user_id: 'u1',
    });
    expect(hits.length).toBe(1);
    expect(hits[0].memory.memory_id).toBe(memoryId);
    expect(hits[0].memory.content).toBe('数据库选型确定为 PostgreSQL 分布式集群');

    // 用户 2 检索不到
    const u2Hits = searchMemories(harness.deps.memoryStore, {
      query: 'PostgreSQL 数据库',
      user_id: 'u2',
    });
    expect(u2Hits.length).toBe(0);

    // 3. 修改内容
    const editRes = await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: {
        content: '数据库架构最终升级为 TiDB 现代化分布式存储',
      },
    });
    expect(editRes.status).toBe(200);

    // 检索旧关键字不再命中（或新关键字优先命中最新内容）
    const newHits = searchMemories(harness.deps.memoryStore, {
      query: 'TiDB 现代化存储',
      user_id: 'u1',
    });
    expect(newHits.length).toBe(1);
    expect(newHits[0].memory.memory_id).toBe(memoryId);
    expect(newHits[0].memory.content).toBe('数据库架构最终升级为 TiDB 现代化分布式存储');

    // 4. 修改状态为 archived -> active 检索自动剔除
    await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: {
        status: 'archived',
      },
    });
    const archivedHits = searchMemories(harness.deps.memoryStore, {
      query: 'TiDB 现代化存储',
      user_id: 'u1',
    });
    expect(archivedHits.length).toBe(0);

    // 恢复为 active
    await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: {
        status: 'active',
      },
    });
    const restoredHits = searchMemories(harness.deps.memoryStore, {
      query: 'TiDB 现代化存储',
      user_id: 'u1',
    });
    expect(restoredHits.length).toBe(1);

    // 5. 删除记忆
    const deleteRes = await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
      method: 'DELETE',
      key: 'dev-key-developer',
    });
    expect(deleteRes.status).toBe(200);

    // 检索彻底搜不到
    const finalHits = searchMemories(harness.deps.memoryStore, {
      query: 'TiDB 现代化存储',
      user_id: 'u1',
    });
    expect(finalHits.length).toBe(0);
  });

  it('13. 完整端到端生命周期全闭环验证（验收标准）', async () => {
    // 步骤 1：系统产生对话轨迹
    harness.deps.trajectoryStore.save({
      request_id: 'req_lifecycle_e2e',
      user_id: 'u1',
      agent_id: 'developer',
      model: 'deepseek-chat',
      request: JSON.stringify({
        messages: [{ role: 'user', content: '我们接口返回一律使用统一 JSON Envelope 格式包装' }],
      }),
      response: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '收到，接口统一返回规范已明确。' } }],
      }),
    });

    // 步骤 2：生成候选记忆
    const cand = harness.deps.candidateStore.create(
      {
        user_id: 'u1',
        type: 'procedural',
        scope: 'personal',
        category: 'pattern',
        content: 'API 接口响应统一采用规范的 JSON Envelope 格式',
        trajectory_id: 'req_lifecycle_e2e',
        confidence: 0.95,
      },
      harness.deps.memoryStore,
    );
    const candId = cand.candidate!.id;

    // 步骤 3：用户查看候选记忆详情与证据摘要
    const candDetail = await harness.api(`/v1/memory-desk/candidates/${candId}`, {
      key: 'dev-key-developer',
    });
    expect(candDetail.status).toBe(200);
    expect(candDetail.json.evidence_status).toBe('available');
    expect(candDetail.json.evidence_trajectories[0].user_prompt).toBe(
      '我们接口返回一律使用统一 JSON Envelope 格式包装',
    );

    // 步骤 4：用户批准入库
    const approveRes = await harness.api(`/v1/memory-desk/candidates/${candId}/approve`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(approveRes.status).toBe(200);
    const memoryId = approveRes.json.memory.memory_id;
    expect(approveRes.json.memory.verified_by_user).toBe(true);

    // 步骤 5：正式记忆详情查询
    const memDetail = await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
      key: 'dev-key-developer',
    });
    expect(memDetail.status).toBe(200);
    expect(memDetail.json.memory.content).toBe('API 接口响应统一采用规范的 JSON Envelope 格式');
    expect(memDetail.json.evidence_status).toBe('available');

    // 步骤 6：Memory Retrieval 可以检索
    const hitsBeforeEdit = searchMemories(harness.deps.memoryStore, {
      query: 'JSON Envelope 接口响应',
      user_id: 'u1',
    });
    expect(hitsBeforeEdit.length).toBe(1);
    expect(hitsBeforeEdit[0].memory.memory_id).toBe(memoryId);

    // 步骤 7：用户修改记忆
    const patchRes = await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: {
        content: 'API 接口响应统一采用规范的 Protobuf 与 gRPC 协议传输',
      },
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.json.memory.content).toBe('API 接口响应统一采用规范的 Protobuf 与 gRPC 协议传输');

    // 步骤 8：Memory Retrieval 返回最新修改内容
    const hitsAfterEdit = searchMemories(harness.deps.memoryStore, {
      query: 'Protobuf gRPC 接口',
      user_id: 'u1',
    });
    expect(hitsAfterEdit.length).toBe(1);
    expect(hitsAfterEdit[0].memory.memory_id).toBe(memoryId);
    expect(hitsAfterEdit[0].memory.content).toBe('API 接口响应统一采用规范的 Protobuf 与 gRPC 协议传输');

    // 步骤 9：用户删除记忆
    const delRes = await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
      method: 'DELETE',
      key: 'dev-key-developer',
    });
    expect(delRes.status).toBe(200);
    expect(delRes.json.deleted).toBe(true);

    // 步骤 10：Memory Retrieval 不再返回该记忆，详情为 404
    const hitsAfterDel = searchMemories(harness.deps.memoryStore, {
      query: 'Protobuf gRPC 接口',
      user_id: 'u1',
    });
    expect(hitsAfterDel.length).toBe(0);

    const detailAfterDel = await harness.api(`/v1/memory-desk/memories/${memoryId}`, {
      key: 'dev-key-developer',
    });
    expect(detailAfterDel.status).toBe(404);
  });
});
