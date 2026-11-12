#!/usr/bin/env node
/**
 * MultiCA CLI 测试替身（仅用于本地 E2E，绝不用于生产）。
 *
 * 只模拟 `multica <cmd> --output json` 的输出形状；命令与参数与
 * CLI 0.6.1-overlay.13 的 --help 一致。真实环境未配置 server
 * （auth status = No server configured），故用它验证 Adapter 的
 * spawn / JSON 解析 / 状态映射 / 轮询 / 取消链路。
 *
 * 状态文件：MULTICA_STUB_STATE（默认 ./data/multica-stub-state.json）
 * 调试开关：
 * - MULTICA_STUB_SLEEP_MS：每次调用先延迟，用于超时与并发测试；
 * - MULTICA_STUB_STUCK=1：`issue runs` 永远返回 queued，
 *   用于「任务长时间无法完成 → 取消 / 降级提示」的真实链路验证。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const stateFile = process.env.MULTICA_STUB_STATE
  || path.resolve(process.cwd(), 'data/multica-stub-state.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { seq: 1000, issues: {} };
  }
}
function save(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// 供超时测试注入延迟；生产未使用。
const sleepMs = Number(process.env.MULTICA_STUB_SLEEP_MS || 0);
if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
// 供「任务永远不完成」场景使用；生产未使用。
const stuck = process.env.MULTICA_STUB_STUCK === '1';

const state = load();
const [group, command, ...rest] = args;

if (group === 'daemon' && command === 'status') {
  out({ status: 'running' });
} else if (group === 'issue' && command === 'create') {
  state.seq += 1;
  const id = `MUL-${state.seq}`;
  state.issues[id] = {
    step: 0,
    title: flag('--title') || '',
    description: flag('--description') || '',
    agent: flag('--assignee') || flag('--assignee-id') || null,
  };
  save(state);
  out({
    id,
    identifier: id,
    title: state.issues[id].title,
    status: 'todo',
    assignee_id: state.issues[id].agent,
  });
} else if (group === 'issue' && command === 'assign') {
  const id = rest[0];
  const agent = flag('--to') || flag('--to-id') || null;
  if (state.issues[id]) {
    state.issues[id].agent = agent;
    save(state);
    out({ id, status: 'assigned', assignee_id: agent });
  } else {
    process.stderr.write(`unknown issue ${id}\n`);
    process.exitCode = 1;
  }
} else if (group === 'issue' && command === 'get') {
  const id = rest[0];
  const issue = state.issues[id];
  if (!issue) {
    process.stderr.write(`unknown issue ${id}\n`);
    process.exitCode = 1;
  } else {
    // 故意不返回 done：完成判定由 runs 状态驱动，与真实 CLI 语义一致。
    out({ id, identifier: id, status: issue.status || 'in_progress' });
  }
} else if (group === 'issue' && command === 'runs') {
  const id = rest[0];
  const issue = state.issues[id];
  if (!issue) {
    process.stderr.write(`unknown issue ${id}\n`);
    process.exitCode = 1;
  } else {
    issue.step = Math.min((issue.step || 0) + 1, 3);
    save(state);
    const statuses = ['queued', 'running', 'completed'];
    out([{
      task_id: `run-${id}-0001`,
      issue_id: id,
      agent_id: issue.agent,
      status: stuck ? 'queued' : statuses[issue.step - 1],
      started_at: new Date().toISOString(),
    }]);
  }
} else if (group === 'issue' && command === 'run-messages') {
  const runId = rest[0];
  out([
    { seq: 1, type: 'thinking', content: '读取任务上下文' },
    { seq: 2, type: 'text', content: 'Agent 已完成分析：建议优先采用简单可维护的方案，避免不必要的复杂架构。' },
  ].map((item) => ({ ...item, run_id: runId })));
} else if (group === 'issue' && command === 'cancel-task') {
  const id = flag('--issue');
  if (state.issues[id]) {
    state.issues[id].status = 'cancelled';
    save(state);
  }
  out({ status: 'cancelled' });
} else {
  process.stderr.write(`unsupported stub command: ${args.join(' ')}\n`);
  process.exitCode = 2;
}
