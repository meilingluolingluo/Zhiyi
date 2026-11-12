#!/usr/bin/env node
/**
 * Personal AI Gateway 真实 HTTP 冒烟脚本（编译产物 + 真文件库 + MultiCA CLI stub）。
 *
 * 与 vitest 用例的区别：
 * - 这里启动的是 `node dist/src/server.js` 真实进程（不是进程内 app），
 *   走真实端口、真实 SQLite 文件、真实 child_process.spawn；
 * - MultiCA 用 scripts/mock-multica-cli.mjs 替身（本机 CLI 未连接 server）；
 * - 模型上游用内置 Mock（MOCK_UPSTREAM=true），不依赖任何凭证。
 *
 * 两阶段：
 * - 阶段 1：Direct LLM（非流式 / 流式 SSE）、Agent Delegation 全链路、用户隔离、MVP 代理回归；
 * - 阶段 2：重启一个「任务永不完成」的实例（MULTICA_STUB_STUCK=1），
 *   验证取消未完成任务、以及流式降级提示。
 *
 * 用法：
 *   npm run build && node scripts/smoke-personal-ai.mjs
 * 退出码：0 = 全部通过；1 = 有检查失败或超时。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STAMP = `${Date.now()}`;
const STUB_CLI = path.join(ROOT, 'scripts', 'mock-multica-cli.mjs');
const KEY = 'dev-key-developer';
const KEY_U2 = 'dev-key-user2';

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取一个空闲端口，避免与本地其它服务冲突。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHealthy(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      // 服务还没起来，继续等
    }
    await sleep(150);
  }
  return false;
}

/** 启动真实服务进程（dist 编译产物）。 */
async function startServer({ label, dbName, extraEnv = {} }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbFile = path.join(ROOT, 'data', `${dbName}.db`);
  const log = [];
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: dbFile,
      MOCK_UPSTREAM: 'true',
      MULTICA_BASE_URL: '',
      DEFAULT_MODEL: 'mock-gpt',
      MEMORY_ENABLED: 'true',
      MEMORY_AUTO_EXTRACT: 'true',
      LOG_SILENT: 'false',
      PERSONAL_AI_ENABLED: 'true',
      PERSONAL_AI_PROTOCOL: 'openai',
      MULTICA_ENABLED: 'true',
      MULTICA_CLI_PATH: STUB_CLI,
      MULTICA_CLI_CWD: ROOT,
      MULTICA_POLL_INTERVAL_MS: '250',
      MULTICA_COMMAND_TIMEOUT_MS: '15000',
      MULTICA_MAX_CONCURRENT_TASKS: '3',
      MULTICA_MAX_POLLS: '60',
      MULTICA_DEFAULT_AGENT: 'Codex',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => log.push(chunk));
  child.stderr.on('data', (chunk) => log.push(chunk));

  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 6000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  process.stdout.write(`\n== ${label}：${baseUrl}（DB=${path.relative(ROOT, dbFile)}）==\n`);
  return { baseUrl, port, dbFile, log, stop, stubState: path.join(ROOT, 'data', `${dbName}-stub.json`) };
}

/** 解析 SSE 帧（`data: {json}` 与 `data: [DONE]`）。 */
function parseSse(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((item) => item.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '') continue;
    if (payload === '[DONE]') {
      frames.push({ done: true });
      continue;
    }
    try {
      frames.push({ json: JSON.parse(payload) });
    } catch {
      frames.push({ raw: payload });
    }
  }
  return frames;
}

async function post(baseUrl, route, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function get(baseUrl, route, key) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${baseUrl}${route}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

const DELEGATE_MESSAGE = {
  role: 'user',
  content: '帮我分析这个 Java 代码仓库的架构实现，给出重构建议',
};

/** 阶段 1：正常链路（stub 三跳 queued → running → completed）。 */
async function phaseOne() {
  const server = await startServer({
    label: '阶段 1：正常链路',
    dbName: `qa-smoke-${STAMP}`,
    extraEnv: { MULTICA_STUB_STATE: path.join(ROOT, 'data', `qa-smoke-${STAMP}-stub.json`) },
  });
  try {
    const healthy = await waitHealthy(server.baseUrl);
    check('服务启动并 /health 可达', healthy, healthy ? `port=${server.port}` : '20s 内未就绪');
    if (!healthy) return null;

    const health = await get(server.baseUrl, '/health/personal-ai');
    check(
      '/health/personal-ai 返回 ok 且暴露 personal_ai / memory_core / multica / tasks',
      health.status === 200
        && health.json?.status === 'ok'
        && !!health.json?.personal_ai
        && !!health.json?.memory_core
        && !!health.json?.multica
        && typeof health.json?.tasks?.active === 'number',
      `status=${health.status} protocol=${health.json?.personal_ai?.protocol} active=${health.json?.tasks?.active}`,
    );
    check(
      'MultiCA stub daemon 报告 running',
      health.json?.multica?.daemon?.status === 'running',
      `daemon=${JSON.stringify(health.json?.multica?.daemon)}`,
    );

    // Direct LLM 非流式
    const direct = await post(server.baseUrl, '/v1/personal-ai/chat/completions', {
      messages: [{ role: 'user', content: '解释一下 CAP 定理' }],
      stream: false,
    }, KEY);
    check(
      'Direct LLM 非流式返回 chat.completion',
      direct.status === 200 && direct.json?.object === 'chat.completion'
        && typeof direct.json?.choices?.[0]?.message?.content === 'string',
      `status=${direct.status} len=${direct.json?.choices?.[0]?.message?.content?.length ?? 0}`,
    );

    // Direct LLM 流式
    const streamed = await post(server.baseUrl, '/v1/personal-ai/chat/completions', {
      messages: [{ role: 'user', content: '请流式解释一下 BASE 理论' }],
      stream: true,
    }, KEY);
    const sseFrames = parseSse(streamed.text);
    const sseText = sseFrames
      .filter((frame) => frame.json?.choices?.[0]?.delta?.content)
      .map((frame) => frame.json.choices[0].delta.content)
      .join('');
    check(
      'Direct LLM 流式为 text/event-stream 并以 [DONE] 结束',
      streamed.headers.get('content-type')?.includes('text/event-stream') === true
        && sseFrames.some((frame) => frame.done === true),
      `frames=${sseFrames.length}`,
    );
    check('流式 chunk 符合 OpenAI chat.completion.chunk', sseFrames.some((f) => f.json?.object === 'chat.completion.chunk'),
      `chunks=${sseFrames.filter((f) => f.json?.object === 'chat.completion.chunk').length}`);
    check('流式拼接出非空助手文本', sseText.trim() !== '', JSON.stringify(sseText.slice(0, 40)));

    // Agent Delegation（非流式，等待任务闭环）
    const delegate = await post(server.baseUrl, '/v1/personal-ai/chat/completions', {
      messages: [DELEGATE_MESSAGE],
      stream: false,
    }, KEY);
    const delegateText = delegate.json?.choices?.[0]?.message?.content ?? '';
    check(
      'Agent Delegation 响应包含进度反馈与最终结果',
      delegate.status === 200 && delegateText.includes('任务进度') && delegateText.includes('Agent 执行结果'),
      `len=${delegateText.length}`,
    );

    const tasks = await get(server.baseUrl, '/v1/personal-ai/tasks', KEY);
    const latest = tasks.json?.items?.[0];
    check('任务落库且状态 completed', tasks.status === 200 && latest?.status === 'completed',
      `id=${latest?.id} status=${latest?.status}`);
    check('external_task_id 来自 MultiCA CLI（issue create）',
      typeof latest?.external_task_id === 'string' && /^MUL-/.test(latest.external_task_id),
      `external_task_id=${latest?.external_task_id} external_run_id=${latest?.external_run_id}`);
    check('任务 result 保存 Agent 原始输出（run-messages）',
      typeof latest?.result === 'string' && latest.result.includes('Agent 已完成分析'),
      `result_len=${latest?.result?.length ?? 0}`);

    // 用户隔离
    const u2list = await get(server.baseUrl, '/v1/personal-ai/tasks', KEY_U2);
    check('u2 任务列表为空（严格隔离）', u2list.status === 200 && u2list.json?.items?.length === 0,
      `items=${u2list.json?.items?.length}`);
    const u2read = await get(server.baseUrl, `/v1/personal-ai/tasks/${latest.id}`, KEY_U2);
    check('u2 读取 u1 任务返回 404', u2read.status === 404, `status=${u2read.status}`);

    // MVP 代理回归
    const legacy = await post(server.baseUrl, '/v1/chat/completions', {
      messages: [{ role: 'user', content: '你好' }],
    }, KEY);
    check('原有 /v1/chat/completions 代理回归可用',
      legacy.status === 200 && !!legacy.json?.choices, `status=${legacy.status}`);

    process.stdout.write(`\n  关键证据（阶段 1）：\n`);
    process.stdout.write(`    - task.id               = ${latest?.id}\n`);
    process.stdout.write(`    - task.external_task_id = ${latest?.external_task_id}\n`);
    process.stdout.write(`    - task.external_run_id  = ${latest?.external_run_id}\n`);
    process.stdout.write(`    - task.status           = ${latest?.status}\n`);
    process.stdout.write(`    - task.result(前 80 字) = ${JSON.stringify((latest?.result ?? '').slice(0, 80))}\n`);
    process.stdout.write(`    - SSE 首帧              = ${streamed.text.split('\n\n')[0].slice(0, 220)}\n`);
    process.stdout.write(`    - SSE 末帧              = ${JSON.stringify(streamed.text.trimEnd().split('\n\n').slice(-1)[0])}\n`);
    process.stdout.write(`    - Delegation 回复(前240)= ${JSON.stringify(delegateText.slice(0, 240))}\n`);
    return { latest };
  } finally {
    await server.stop();
    process.stdout.write(`  阶段 1 服务已停止，端口 ${server.port} 已释放。\n`);
  }
}

/** 阶段 2：任务永不完成 → 验证降级提示与取消未完成任务。 */
async function phaseTwo() {
  const server = await startServer({
    label: '阶段 2：取消未完成任务',
    dbName: `qa-smoke-cancel-${STAMP}`,
    extraEnv: {
      // stub 永远返回 queued，任务停留在 running
      MULTICA_STUB_STUCK: '1',
      MULTICA_STUB_STATE: path.join(ROOT, 'data', `qa-smoke-cancel-${STAMP}-stub.json`),
      // 缩短 SSE 保持时间，让响应快速返回降级提示
      PERSONAL_AI_STREAM_MAX_MS: '1200',
    },
  });
  try {
    const healthy = await waitHealthy(server.baseUrl);
    check('阶段 2 服务启动', healthy, `port=${server.port}`);
    if (!healthy) return;

    const degraded = await post(server.baseUrl, '/v1/personal-ai/chat/completions', {
      messages: [DELEGATE_MESSAGE],
      stream: false,
    }, KEY);
    const text = degraded.json?.choices?.[0]?.message?.content ?? '';
    check(
      '任务长时间未完成时返回降级提示（含任务查询接口）',
      degraded.status === 200 && text.includes('/v1/personal-ai/tasks/'),
      `len=${text.length}`,
    );

    const list = await get(server.baseUrl, '/v1/personal-ai/tasks', KEY);
    const running = (list.json?.items ?? []).find((item) => item.status === 'running' || item.status === 'dispatching');
    check('任务停留在 running/dispatching', !!running, `status=${running?.status} external=${running?.external_task_id}`);

    const cancel = await post(server.baseUrl, `/v1/personal-ai/tasks/${running.id}/cancel`, {}, KEY);
    check(
      '取消未完成任务返回 200 且状态为 cancelled',
      cancel.status === 200 && cancel.json?.task?.status === 'cancelled',
      `status=${cancel.status} task_status=${cancel.json?.task?.status} external_cancelled=${cancel.json?.external_cancelled}`,
    );

    const after = await get(server.baseUrl, `/v1/personal-ai/tasks/${running.id}`, KEY);
    check('取消后任务状态持久化为 cancelled', after.json?.status === 'cancelled', `status=${after.json?.status}`);

    // 终态保护回归：stub 仍持续返回 queued，Worker 还会继续轮询数次；
    // 若没有终态保护，这几轮会把 cancelled 覆盖回 running（P1 竞态）。
    await sleep(900);
    const settled = await get(server.baseUrl, `/v1/personal-ai/tasks/${running.id}`, KEY);
    check(
      '跨过一个轮询周期后仍为 cancelled（终态不被旧快照覆盖）',
      settled.json?.status === 'cancelled',
      `status=${settled.json?.status} poll_count=${settled.json?.poll_count}`,
    );

    const again = await post(server.baseUrl, `/v1/personal-ai/tasks/${running.id}/cancel`, {}, KEY);
    check('重复取消已取消任务返回 409', again.status === 409, `status=${again.status}`);

    process.stdout.write(`\n  关键证据（阶段 2）：\n`);
    process.stdout.write(`    - degraded 回复(前 200) = ${JSON.stringify(text.slice(0, 200))}\n`);
    process.stdout.write(`    - cancelled task.id     = ${running.id}\n`);
  } finally {
    await server.stop();
    process.stdout.write(`  阶段 2 服务已停止，端口 ${server.port} 已释放。\n`);
  }
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.chmodSync(STUB_CLI, 0o755);

  if (!fs.existsSync(path.join(ROOT, 'dist', 'src', 'server.js'))) {
    process.stderr.write('未找到 dist/src/server.js，请先执行 npm run build\n');
    return 1;
  }

  await phaseOne();
  await phaseTwo();

  process.stdout.write(`\n== 冒烟结果：${results.length - failures}/${results.length} 通过 ==\n`);
  if (failures > 0) {
    process.stdout.write('失败项：\n');
    for (const item of results.filter((entry) => !entry.ok)) {
      process.stdout.write(`  - ${item.name} (${item.detail})\n`);
    }
  }
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write(`冒烟脚本异常：${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
