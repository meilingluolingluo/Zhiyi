/**
 * MultiCA CLI 适配器（CLI 0.6.1-overlay.13 实测命令）。
 *
 * 安全约束：
 * - 只用 child_process.spawn + 参数数组，永不拼接 shell 命令；
 * - 所有外部标识走白名单正则校验，标题/描述去除控制字符并限长；
 * - 命令超时、stdout/stderr 长度、非 0 退出、非 JSON 输出均显式处理；
 * - 日志只记录子命令名与耗时，不记录描述正文、密钥或用户敏感信息。
 *
 * 字段说明：命令与参数来自 `multica <cmd> --help`；`runs` 返回的
 * task_id / agent_id / status / started_at 来自 CLI_AND_DAEMON.md 的
 * Execution History 小节。当前本机 CLI 未连接 server
 * （`auth status` = No server configured，`daemon status` = stopped），
 * 因此输出字段采用「多候选键 + 严格类型校验」的适配方式，
 * 找不到必需字段时明确报错，不猜测、不伪造。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../../../logger';
import type { ExecutionStatus, MulticaConfig } from '../../config';
import type {
  AgentExecutionAdapter,
  CreateTaskInput,
  CreateTaskResult,
  TaskResult,
  TaskStatus,
} from './agent-adapter';

const SAFE_ID: RegExp = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_AGENT: RegExp = /^[A-Za-z0-9_ .+\-]{1,128}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CONTROL_CHARS: RegExp = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

export class MultiCAError extends Error {
  constructor(message: string, readonly kind: 'validation' | 'timeout' | 'exit' | 'parse') {
    super(message);
    this.name = 'MultiCAError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: string, max: number, label: string): string {
  const text: string = value.replace(CONTROL_CHARS, ' ').slice(0, max);
  if (text.trim() === '') throw new MultiCAError(`${label} 不能为空`, 'validation');
  return text;
}

function checkId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new MultiCAError(`${label} 格式非法`, 'validation');
  return value;
}

function checkAgent(value: string): string {
  if (!SAFE_AGENT.test(value)) throw new MultiCAError('agentId 格式非法', 'validation');
  return value;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value: unknown = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function asArray(value: unknown, keys: readonly string[] = ['runs', 'tasks', 'items', 'messages', 'data']): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) {
    for (const key of keys) {
      const nested: unknown = value[key];
      if (Array.isArray(nested)) return nested.filter(isRecord);
    }
  }
  return [];
}

/** 把 MultiCA 的 run / board 状态映射到内部状态机。 */
export function mapExternalStatus(raw: string, boardStatus?: string): ExecutionStatus {
  const board: string = (boardStatus ?? '').toLowerCase();
  // in_review = Agent 已交付结果、等待人工验收；对自动化委派视为完成（结果取 run-messages）。
  if (['done', 'completed', 'complete', 'in_review', 'review', 'approved'].includes(board)) {
    return 'completed';
  }
  if (['cancelled', 'canceled'].includes(board)) return 'cancelled';

  const value: string = raw.toLowerCase();
  if (['completed', 'succeeded', 'success', 'done', 'finished', 'in_review', 'review'].includes(value)) {
    return 'completed';
  }
  if (['failed', 'error', 'errored', 'failure', 'timed_out'].includes(value)) return 'failed';
  if (['cancelled', 'canceled', 'interrupted'].includes(value)) return 'cancelled';
  if (['queued', 'waiting_local_directory', 'dispatched', 'pending'].includes(value)) return 'dispatching';
  if (['running', 'in_progress', 'processing', 'active'].includes(value)) return 'running';
  return 'running';
}

export interface CliRunner {
  run(args: string[]): Promise<unknown>;
}

/** 可注入的 CLI 执行器：测试时用 stub 替换，生产用真实 spawn。 */
export function createCliRunner(config: MulticaConfig, logger: Logger): CliRunner {
  return {
    run(args: string[]): Promise<unknown> {
      const started: number = Date.now();
      const label: string = args.slice(0, 2).join(' ');
      return new Promise<unknown>((resolve, reject): void => {
        let child: ChildProcess;
        try {
          child = spawn(config.cliPath, args, {
            cwd: config.cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
          });
        } catch (error) {
          reject(new MultiCAError(`CLI 启动失败: ${String(error)}`, 'exit'));
          return;
        }

        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          timedOut = true;
          child.kill('SIGKILL');
        }, config.commandTimeoutMs);
        timer.unref?.();

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (part: string): void => {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += part;
          else truncated = true;
        });
        child.stderr?.on('data', (part: string): void => {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += part;
        });
        child.on('error', (error: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new MultiCAError(`CLI 进程异常: ${error.message}`, 'exit'));
        });
        child.on('close', (code: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const durationMs: number = Date.now() - started;
          logger.info(`[multica] ${label} 耗时 ${durationMs}ms，退出码 ${String(code)}`);
          if (timedOut) {
            reject(new MultiCAError(`CLI 执行超时（${config.commandTimeoutMs}ms）`, 'timeout'));
            return;
          }
          if (truncated) {
            reject(new MultiCAError('CLI 输出超过大小限制', 'parse'));
            return;
          }
          if (code !== 0) {
            // 不回显可能含密钥的 stderr 全文，只保留首行摘要。
            const summary: string = stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
            reject(new MultiCAError(`CLI 退出码 ${String(code)}: ${summary}`, 'exit'));
            return;
          }
          const trimmed: string = stdout.trim();
          if (trimmed === '') {
            reject(new MultiCAError('CLI 未返回 JSON 输出', 'parse'));
            return;
          }
          const start: number = ((): number => {
            const obj: number = trimmed.indexOf('{');
            const arr: number = trimmed.indexOf('[');
            if (obj < 0) return arr;
            if (arr < 0) return obj;
            return Math.min(obj, arr);
          })();
          if (start < 0) {
            reject(new MultiCAError(`CLI 输出不是 JSON: ${trimmed.slice(0, 120)}`, 'parse'));
            return;
          }
          try {
            resolve(JSON.parse(trimmed.slice(start)) as unknown);
          } catch {
            reject(new MultiCAError('CLI 输出 JSON 解析失败', 'parse'));
          }
        });
      });
    },
  };
}

export class MulticaAdapter implements AgentExecutionAdapter {
  constructor(
    private readonly config: MulticaConfig,
    private readonly runner: CliRunner,
    private readonly logger: Logger,
  ) {}

  private async json(args: string[]): Promise<unknown> {
    return this.runner.run([...args, '--output', 'json']);
  }

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const title: string = cleanText(input.title, 300, 'title');
    const description: string = cleanText(input.description, 8000, 'description');
    checkId(input.taskId, 'taskId');
    const args: string[] = [
      'issue', 'create',
      '--title', title,
      '--description', description,
      '--allow-duplicate',
    ];
    if (input.agentId) args.push('--assignee', checkAgent(input.agentId));
    const parsed: unknown = await this.json(args);
    const record: Record<string, unknown> = isRecord(parsed) ? parsed : {};
    const externalTaskId: string | undefined = pickString(record, [
      'id', 'ID', 'issue_id', 'issueId', 'identifier', 'key',
    ]);
    if (!externalTaskId || !SAFE_ID.test(externalTaskId)) {
      throw new MultiCAError('创建任务成功但返回中缺少合法的 issue id', 'parse');
    }
    return {
      externalTaskId,
      status: pickString(record, ['status']) ?? 'created',
    };
  }

  async assignAgent(input: { externalTaskId: string; agentId: string }): Promise<void> {
    await this.json([
      'issue', 'assign',
      checkId(input.externalTaskId, 'externalTaskId'),
      '--to', checkAgent(input.agentId),
    ]);
  }

  async getTaskStatus(externalTaskId: string): Promise<TaskStatus> {
    const id: string = checkId(externalTaskId, 'externalTaskId');
    let runs: unknown = await this.json(['issue', 'runs', id, '--active']);
    let rows: Record<string, unknown>[] = asArray(runs);
    if (rows.length === 0) {
      // run 结束后 `--active` 不再返回；回退全量 runs，优先活跃状态，否则取最近一条。
      const all: Record<string, unknown>[] = asArray(await this.json(['issue', 'runs', id]));
      const active: Record<string, unknown>[] = all.filter((row): boolean =>
        ['queued', 'waiting_local_directory', 'dispatched', 'pending', 'running', 'in_progress', 'processing', 'active'].includes(
          (pickString(row, ['status', 'run_status', 'state']) ?? '').toLowerCase(),
        ),
      );
      rows = active.length > 0 ? active : all;
    }
    const row: Record<string, unknown> | undefined = rows[0] ?? {};
    const rawStatus: string = pickString(row, ['status', 'run_status', 'state']) ?? '';
    const externalRunId: string | undefined = pickString(row, ['task_id', 'run_id', 'id']);
    const agentId: string | undefined = pickString(row, ['agent_id', 'agentId']);

    let boardStatus: string | undefined;
    try {
      const issue: unknown = await this.json(['issue', 'get', id]);
      if (isRecord(issue)) boardStatus = pickString(issue, ['status']);
    } catch (error) {
      this.logger.warn(`[multica] issue get 失败，状态仅依据 runs: ${String(error)}`);
    }

    const mapped: ExecutionStatus = mapExternalStatus(rawStatus, boardStatus);
    return {
      status: mapped,
      rawStatus: rawStatus || boardStatus || 'unknown',
      message: rows.length > 0
        ? `MultiCA run=${externalRunId ?? 'n/a'} status=${rawStatus || 'unknown'}`
        : '等待本地 daemon 领取任务',
      externalRunId,
      agentId,
    };
  }

  async getTaskResult(externalTaskId: string, externalRunId?: string): Promise<TaskResult> {
    const id: string = checkId(externalTaskId, 'externalTaskId');
    let runId: string | undefined = externalRunId;
    if (!runId) {
      const status: TaskStatus = await this.getTaskStatus(id);
      runId = status.externalRunId;
    }
    if (!runId) {
      return { status: 'failed', error: '未找到执行 run id，无法获取 Agent 结果' };
    }
    const parsed: unknown = await this.json([
      'issue', 'run-messages', checkId(runId, 'runId'), '--issue', id,
    ]);
    const rows: Record<string, unknown>[] = asArray(parsed);
    // 只聚合 Agent 的叙述文本（type=text），按 seq 顺序拼接；
    // tool_use / tool_result 是中间过程，混入会污染结论。
    const textRows: Record<string, unknown>[] = rows
      .filter((row): boolean => String(row.type ?? 'text').toLowerCase() === 'text')
      .sort((a, b): number => Number(a.seq ?? 0) - Number(b.seq ?? 0));
    const source: Record<string, unknown>[] = textRows.length > 0 ? textRows : rows;
    const texts: string[] = [];
    for (const row of source) {
      const text: string | undefined = pickString(row, [
        'content', 'text', 'message', 'delta', 'body', 'output',
      ]);
      if (text && text.trim() !== '') texts.push(text.trim());
    }
    const content: string = texts.join('').slice(0, 20000);
    if (content.trim() === '') {
      return { status: 'failed', error: '执行消息为空，未取得 Agent 结果' };
    }
    return {
      status: 'completed',
      content,
      metadata: {
        external_run_id: runId,
        message_count: rows.length,
        text_message_count: textRows.length,
      },
    };
  }

  async cancelTask(externalTaskId: string, externalRunId?: string): Promise<boolean> {
    if (!externalRunId) return false; // CLI 的 cancel-task 需要 run id
    try {
      await this.json([
        'issue', 'cancel-task', checkId(externalRunId, 'runId'),
        '--issue', checkId(externalTaskId, 'externalTaskId'),
      ]);
      return true;
    } catch (error) {
      this.logger.warn(`[multica] 取消任务失败: ${String(error)}`);
      return false;
    }
  }

  async daemonStatus(): Promise<{ status: string; available: boolean }> {
    try {
      const parsed: unknown = await this.json(['daemon', 'status']);
      const record: Record<string, unknown> = isRecord(parsed) ? parsed : {};
      const status: string = pickString(record, ['status']) ?? 'unknown';
      return { status, available: status === 'running' };
    } catch (error) {
      return { status: `unavailable: ${String(error)}`, available: false };
    }
  }
}
