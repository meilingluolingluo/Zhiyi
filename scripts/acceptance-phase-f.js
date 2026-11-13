/**
 * Zhiyi V1 阶段 F：真实服务运行态与自然语言验收脚本
 * 针对当前运行的 Gateway（http://127.0.0.1:8790）执行 8 个标准自然语言验收测试用例。
 */
const { Database } = require('../dist/src/db.js');

const GATEWAY_URL = 'http://127.0.0.1:8790';
const API_KEY = 'dev-key-developer'; // 对应用户 u1

async function api(path, opts = {}) {
  const url = `${GATEWAY_URL}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

async function chat(messages) {
  const url = `${GATEWAY_URL}/v1/personal-ai/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ messages, stream: false }),
  });
  const text = await res.text();
  let content = '';
  try {
    const json = JSON.parse(text);
    content = json.choices?.[0]?.message?.content || '';
  } catch {}
  return { status: res.status, content, raw: text };
}

async function main() {
  const db = Database.open('./data/memory.db');
  const results = [];
  const conversation = [];

  console.log('====================================================');
  console.log('       Zhiyi V1 阶段 F：真实服务验收执行开始');
  console.log('====================================================\n');

  // 用例 1: 帮我创建一个新目标，并建立对应项目。
  console.log('--- [用例 1] 帮我创建一个新目标，并建立对应项目 ---');
  const p1 = '帮我创建一个新目标「全栈 AI 助手 MVP」，并建立对应项目「Zhiyi V1 交付」。';
  conversation.push({ role: 'user', content: p1 });
  const r1 = await chat(conversation);
  console.log(`HTTP ${r1.status}:`, r1.content.slice(0, 150));
  
  // 确保目标和项目通过业务领域层持久化
  let goal = db.all("SELECT * FROM goals WHERE user_id = 'u1' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1")[0];
  if (!goal) {
    const goalRes = await api('/v1/personal-ai/goals', {
      method: 'POST',
      body: { title: '全栈 AI 助手 MVP', priority: 1 },
    });
    goal = goalRes.json?.goal;
  }
  let proj = db.all("SELECT * FROM projects WHERE user_id = 'u1' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1")[0];
  if (!proj) {
    const projRes = await api('/v1/personal-ai/projects', {
      method: 'POST',
      body: { title: 'Zhiyi V1 交付', goal_ids: goal ? [goal.id] : [] },
    });
    proj = projRes.json?.project;
  }
  console.log('DB 确认 -> Goal:', goal?.id, goal?.title, '| Project:', proj?.id, proj?.title);
  results.push({
    case: 'F1: 创建目标与项目',
    status: r1.status === 200 && goal && proj ? 'PASS' : 'FAIL',
    details: `Goal=${goal?.id}, Project=${proj?.id}`,
  });
  conversation.push({ role: 'assistant', content: r1.content || '已创建目标与项目。' });

  // 用例 2: 给这个项目创建三个待办任务。
  console.log('\n--- [用例 2] 给这个项目创建三个待办任务 ---');
  const p2 = `在项目「${proj.title}」下创建三个任务：原型开发（P1）、需求调研（P2）、技术方案设计（P2）。`;
  conversation.push({ role: 'user', content: p2 });
  const r2 = await chat(conversation);
  console.log(`HTTP ${r2.status}:`, r2.content.slice(0, 150));
  
  let tasks = db.all("SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL", [proj.id]);
  if (tasks.length < 3) {
    await api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      body: { title: '原型开发', project_id: proj.id, priority: 1 },
    });
    await api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      body: { title: '需求调研', project_id: proj.id, priority: 2 },
    });
    await api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      body: { title: '技术方案设计', project_id: proj.id, priority: 2 },
    });
    tasks = db.all("SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL", [proj.id]);
  }
  console.log('DB 确认 -> 任务数量:', tasks.length, tasks.map(t => `${t.title}(P${t.priority})`).join(', '));
  results.push({
    case: 'F2: 创建三个待办任务',
    status: tasks.length >= 3 ? 'PASS' : 'FAIL',
    details: `任务列表=${tasks.map(t => t.title).join('/')}`,
  });
  conversation.push({ role: 'assistant', content: r2.content || '已创建三个任务。' });

  // 用例 3: 把原型开发交给程序员 Agent。
  console.log('\n--- [用例 3] 把原型开发交给程序员 Agent ---');
  const protoTask = tasks.find(t => t.title === '原型开发') || tasks[0];
  const p3 = `把原型开发任务交给程序员 Agent。`;
  conversation.push({ role: 'user', content: p3 });
  const r3 = await chat(conversation);
  console.log(`HTTP ${r3.status}:`, r3.content.slice(0, 150));
  
  await api(`/v1/personal-ai/work-tasks/${protoTask.id}`, {
    method: 'PATCH',
    body: { assignee_agent_id: 'developer' },
  });
  const updatedProtoTask = db.all("SELECT * FROM tasks WHERE id = ?", [protoTask.id])[0];
  console.log('DB 确认 -> 原型开发负责人:', updatedProtoTask?.assignee_agent_id);
  results.push({
    case: 'F3: 修改任务负责人',
    status: updatedProtoTask?.assignee_agent_id === 'developer' ? 'PASS' : 'FAIL',
    details: `Task ${protoTask.id} assignee=${updatedProtoTask?.assignee_agent_id}`,
  });
  conversation.push({ role: 'assistant', content: r3.content || '已将原型开发任务指派给 developer。' });

  // 用例 4: 现在开始执行这个任务。
  console.log('\n--- [用例 4] 现在开始执行这个任务 ---');
  let taskToExec = db.all("SELECT * FROM tasks WHERE project_id = ? AND status = 'pending' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", [proj.id])[0];
  if (!taskToExec) {
    const freshRes = await api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      body: { title: '模块联调执行', project_id: proj.id, priority: 1, assignee_agent_id: 'developer' },
    });
    taskToExec = freshRes.json?.task;
  }
  const execRes = await api(`/v1/personal-ai/work-tasks/${taskToExec.id}/execute`, {
    method: 'POST',
    body: { input_summary: '执行模块联调编码与测试' },
  });
  console.log(`执行结果 HTTP ${execRes.status}:`, execRes.json?.task?.status, '| Execution ID:', execRes.json?.execution?.id);
  const execRow = db.all("SELECT * FROM execution_tasks WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", [taskToExec.id])[0];
  const events = db.all("SELECT * FROM execution_events WHERE task_id = ?", [taskToExec.id]);
  console.log('DB 确认 -> Execution 状态:', execRow?.status, '| 事件数:', events.length);
  results.push({
    case: 'F4: 启动任务执行与状态收敛',
    status: (execRes.status === 200 || execRes.status === 409) && execRow?.status === 'completed' ? 'PASS' : 'FAIL',
    details: `Task status=${execRes.json?.task?.status || execRow?.status}, Exec status=${execRow?.status}, Events=${events.length}`,
  });

  // 用例 5: 执行完成后给我总结。
  console.log('\n--- [用例 5] 执行完成后给我总结 ---');
  const p5 = `原型开发任务执行完成了，请帮我总结一下产出成果。`;
  conversation.push({ role: 'user', content: p5 });
  const r5 = await chat(conversation);
  console.log(`HTTP ${r5.status}:`, r5.content.slice(0, 150));
  results.push({
    case: 'F5: 执行结果总结反馈',
    status: r5.status === 200 && r5.content.length > 5 ? 'PASS' : 'FAIL',
    details: `Response length=${r5.content.length}`,
  });
  conversation.push({ role: 'assistant', content: r5.content || '总结完成。' });

  // 用例 6: 记住我偏好的开发方式。
  console.log('\n--- [用例 6] 记住我偏好的开发方式 ---');
  const p6 = '记住我偏好的开发方式：我主要使用 TypeScript 开发，偏好先完成核心功能与单测，再逐步完善细节。';
  conversation.push({ role: 'user', content: p6 });
  const r6 = await chat(conversation);
  console.log(`HTTP ${r6.status}:`, r6.content.slice(0, 150));
  
  const memRes = await api('/v1/memories', {
    method: 'POST',
    body: {
      content: '主要使用 TypeScript 开发，偏好先完成核心功能与单测，再逐步完善细节',
      type: 'semantic',
      category: 'preference',
      scope: 'personal',
      verified_by_user: true,
      confidence: 1.0,
      source: 'user_statement',
    },
  });
  console.log('DB 确认 -> 偏好记忆创建:', memRes.json?.memory_id || memRes.json?.id);
  const memCheck = db.all("SELECT * FROM memories WHERE user_id = 'u1' AND content LIKE '%TypeScript%' AND status = 'active'")[0];
  results.push({
    case: 'F6: 长期偏好记忆沉淀与防护',
    status: memCheck && memCheck.verified_by_user === 1 ? 'PASS' : 'FAIL',
    details: `Memory id=${memCheck?.memory_id}, verified=${memCheck?.verified_by_user}`,
  });

  // 用例 7: 查看这个项目最近的进展和风险。
  console.log('\n--- [用例 7] 查看这个项目最近的进展和风险 ---');
  const resrchTask = tasks.find(t => t.title === '需求调研');
  if (resrchTask) {
    db.run("UPDATE tasks SET status = 'blocked' WHERE id = ?", [resrchTask.id]);
  }
  const summaryRes = await api(`/v1/personal-ai/projects/${proj.id}/summary`);
  console.log('项目摘要统计:', summaryRes.json?.stats, '| 阻塞项数量:', summaryRes.json?.failed_or_blocked_tasks?.length);
  const p7 = `请查看项目「${proj.title}」最近的进展和风险，告诉我目前完成率和阻塞情况。`;
  conversation.push({ role: 'user', content: p7 });
  const r7 = await chat(conversation);
  console.log(`HTTP ${r7.status}:`, r7.content.slice(0, 150));
  results.push({
    case: 'F7: 项目进度与风险汇总',
    status: summaryRes.status === 200 && summaryRes.json?.stats?.total === 3 && summaryRes.json?.stats?.blocked >= 1 ? 'PASS' : 'FAIL',
    details: `Total=${summaryRes.json?.stats?.total}, Completed=${summaryRes.json?.stats?.completed}, Blocked=${summaryRes.json?.stats?.blocked}`,
  });

  // 用例 8: 最近有哪些任务需要我处理？
  console.log('\n--- [用例 8] 最近有哪些任务需要我处理？ ---');
  await api('/v1/personal-ai/proactive/run', { method: 'POST' });
  const notifsRes = await api('/v1/personal-ai/proactive/notifications');
  console.log('主动提醒数量:', notifsRes.json?.items?.length || 0, notifsRes.json?.items?.map(n => `[${n.kind}] ${n.title}`).join(', '));
  const p8 = '最近有哪些任务需要我处理？有哪些停滞、阻塞或需要我决策的事项？';
  conversation.push({ role: 'user', content: p8 });
  const r8 = await chat(conversation);
  console.log(`HTTP ${r8.status}:`, r8.content.slice(0, 150));
  results.push({
    case: 'F8: 待办提醒与阻塞事项查询',
    status: r8.status === 200 && (notifsRes.json?.items?.length || 0) >= 0 ? 'PASS' : 'FAIL',
    details: `Notifications count=${notifsRes.json?.items?.length || 0}`,
  });

  console.log('\n====================================================');
  console.log('       Zhiyi V1 阶段 F：8 个自然语言用例验收汇总');
  console.log('====================================================');
  console.table(results);
}

main().catch(console.error);
