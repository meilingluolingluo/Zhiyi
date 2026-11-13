/**
 * Execution 生命周期辅助：失败分类（可重试 / 不可重试 / 取消 / 需核实）、
 * 元数据脱敏及任务执行状态可读摘要构建。
 */
import type { BusinessTask } from '../domain/types';
import type { ExecutionTask } from './task-repository';

export type ExecutionFailureCategory =
  | 'retryable'
  | 'non_retryable'
  | 'cancelled'
  | 'needs_verification';

export type ExecutionEventType =
  | 'created'
  | 'started'
  | 'progress'
  | 'tool_call'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retried'
  | 'recovered'
  | 'verification_required';

export interface ClassifyFailureInput {
  message?: string | null;
  statusCode?: number;
  errorKind?: 'validation' | 'timeout' | 'exit' | 'parse';
  aborted?: boolean;
  interruptedOnRestart?: boolean;
  stalled?: boolean;
  categoryOverride?: ExecutionFailureCategory;
  codeOverride?: string;
}

export interface ClassifiedExecutionFailure {
  category: ExecutionFailureCategory;
  code: string;
  retryable: boolean;
  needsVerification: boolean;
  message: string;
}

const SENSITIVE_KEY_RE = /(api[_-]?key|token|secret|password|authorization|cookie|credential)/i;

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

/** 统一把各类执行异常归类为标准失败语义，避免各执行后端分散硬编码判断。 */
export function classifyExecutionFailure(input: ClassifyFailureInput): ClassifiedExecutionFailure {
  const rawMessage: string = (input.message ?? '').trim();
  const normalized: string = rawMessage.toLowerCase();

  if (input.categoryOverride) {
    const cat = input.categoryOverride;
    return {
      category: cat,
      code: input.codeOverride ?? cat,
      retryable: cat === 'retryable' || cat === 'needs_verification',
      needsVerification: cat === 'needs_verification',
      message: rawMessage || '执行未完成',
    };
  }

  if (input.aborted || rawMessage === '用户取消任务' || normalized.includes('cancelled_by_user')) {
    return {
      category: 'cancelled',
      code: input.codeOverride ?? 'cancelled_by_user',
      retryable: false,
      needsVerification: false,
      message: rawMessage || '用户取消任务',
    };
  }

  if (input.interruptedOnRestart) {
    return {
      category: 'needs_verification',
      code: input.codeOverride ?? 'process_restarted',
      retryable: true,
      needsVerification: true,
      message: rawMessage || '服务重启导致执行中断，结果未能确认，请核实后重试',
    };
  }

  if (input.stalled) {
    return {
      category: 'needs_verification',
      code: input.codeOverride ?? 'execution_stalled',
      retryable: true,
      needsVerification: true,
      message: rawMessage || '执行长时间无进展，结果无法确认，请核实后重试',
    };
  }

  if (
    normalized.includes('轮询次数超过上限') ||
    normalized.includes('轮询超时') ||
    normalized.includes('poll_limit_exceeded')
  ) {
    return {
      category: 'needs_verification',
      code: input.codeOverride ?? 'poll_limit_exceeded',
      retryable: true,
      needsVerification: true,
      message: rawMessage || '外部执行轮询超时，结果尚未确认，请核实后重试',
    };
  }

  if (input.errorKind === 'validation') {
    return {
      category: 'non_retryable',
      code: input.codeOverride ?? 'validation_error',
      retryable: false,
      needsVerification: false,
      message: rawMessage || '参数校验失败',
    };
  }

  if (typeof input.statusCode === 'number') {
    if (NON_RETRYABLE_HTTP_STATUSES.has(input.statusCode)) {
      const code =
        input.statusCode === 401 || input.statusCode === 403 ? 'auth_failed' : 'invalid_request';
      return {
        category: 'non_retryable',
        code: input.codeOverride ?? code,
        retryable: false,
        needsVerification: false,
        message: rawMessage || `上游拒绝请求（${input.statusCode}）`,
      };
    }
    if (RETRYABLE_HTTP_STATUSES.has(input.statusCode) || input.statusCode >= 500) {
      const code =
        input.statusCode === 429
          ? 'rate_limited'
          : input.statusCode === 408 || input.statusCode === 504
            ? 'upstream_timeout'
            : 'upstream_unavailable';
      return {
        category: 'retryable',
        code: input.codeOverride ?? code,
        retryable: true,
        needsVerification: false,
        message: rawMessage || `上游临时错误（${input.statusCode}）`,
      };
    }
  }

  if (
    input.errorKind === 'timeout' ||
    /timeout|timed out|超时|etimedout|timeouterror/i.test(rawMessage)
  ) {
    return {
      category: 'retryable',
      code: input.codeOverride ?? 'execution_timeout',
      retryable: true,
      needsVerification: false,
      message: rawMessage || '执行请求超时',
    };
  }

  if (
    /econnreset|econnrefused|enotfound|ehostunreach|epipe|fetch failed|socket hang up|network|断开|429|rate limit|temporarily unavailable|502|503|504/i.test(
      rawMessage,
    )
  ) {
    return {
      category: 'retryable',
      code: input.codeOverride ?? 'transient_network_or_upstream',
      retryable: true,
      needsVerification: false,
      message: rawMessage || '网络或上游服务临时不可用',
    };
  }

  if (
    /已禁用|不存在|无权|permission|unauthorized|forbidden|multica 未启用|invalid_status|schema|参数不合法|格式非法/i.test(
      rawMessage,
    )
  ) {
    return {
      category: 'non_retryable',
      code: input.codeOverride ?? 'non_retryable_config_or_permission',
      retryable: false,
      needsVerification: false,
      message: rawMessage || '配置或权限不满足执行条件',
    };
  }

  return {
    category: 'retryable',
    code: input.codeOverride ?? 'execution_error',
    retryable: true,
    needsVerification: false,
    message: rawMessage || '执行失败',
  };
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactValue(item, depth + 1);
      }
    }
    return out;
  }
  return String(value).slice(0, 500);
}

/** 清理事件附带元数据，脱敏敏感键并限制序列化长度，避免泄露密钥或撑爆存储。 */
export function sanitizeEventMetadata(metadata?: Record<string, unknown>): string {
  if (!metadata || Object.keys(metadata).length === 0) return '{}';
  try {
    const cleaned = redactValue(metadata);
    const json = JSON.stringify(cleaned);
    if (json.length <= 4000) return json;
    return JSON.stringify({ truncated: true, preview: json.slice(0, 3800) });
  } catch {
    return '{}';
  }
}

/** 把业务任务、最近一次执行与历史次数组装为对用户可读的执行状态摘要。 */
export function formatTaskLifecycleSummary(
  task: BusinessTask,
  latestExecution: ExecutionTask | null,
  totalExecutions: number,
): string {
  if (!latestExecution) {
    return `任务「${task.title}」当前状态为 ${task.status}，负责人=${task.assignee_agent_id ?? '未指定'}，尚未创建执行记录。`;
  }

  const parts: string[] = [
    `任务「${task.title}」（${task.id}）状态=${task.status}`,
    `负责 Agent=${latestExecution.agent_id ?? task.assignee_agent_id ?? '未指定'}`,
    `最近执行=${latestExecution.id}（状态=${latestExecution.status}，模式=${latestExecution.execution_mode}，累计执行次数=${totalExecutions}）`,
  ];

  if (latestExecution.status === 'completed') {
    const preview = (latestExecution.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (preview) parts.push(`结果摘要=${preview}`);
  } else if (latestExecution.status === 'failed') {
    const retryHint = latestExecution.needs_verification
      ? '结果未确认，需人工核实后可重试或更换 Agent'
      : latestExecution.retryable
        ? '属于可重试失败，可直接重试或更换 Agent 重新执行'
        : '属于不可重试失败（请先修正参数/配置或更换其他 Agent 后重试）';
    parts.push(
      `失败原因=${latestExecution.error ?? '未知错误'}（分类=${latestExecution.error_category ?? 'unknown'}，${retryHint}）`,
    );
  } else if (latestExecution.status === 'cancelled') {
    parts.push(`取消原因=${latestExecution.error ?? '用户取消任务'}`);
  } else if (latestExecution.progress_message) {
    parts.push(`当前进度=${latestExecution.progress_message}`);
  }

  return parts.join('；');
}
