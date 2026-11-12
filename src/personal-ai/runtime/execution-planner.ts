/** 轻量执行计划：把意图 + 上下文变成可追踪的一次执行决策。 */
import type { PersonalAIConfig } from '../config';
import type { BuiltContext } from './context-builder';
import type { ExecutionMode, IntentResult } from './intent-understanding';

export interface ExecutionPlan {
  mode: ExecutionMode;
  agentId?: string;
  title: string;
  description: string;
  reason: string;
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function planExecution(
  intent: IntentResult,
  context: BuiltContext,
  config: PersonalAIConfig,
): ExecutionPlan {
  const title: string = oneLine(context.taskText, 80) || '知忆任务';
  const memorySummary: string = context.hits
    .slice(0, 3)
    .map((hit): string => `- ${hit.memory.content.slice(0, 160)}`)
    .join('\n');

  if (intent.mode === 'direct_llm') {
    return {
      mode: 'direct_llm',
      title,
      description: context.taskText.slice(0, 2000),
      reason: intent.reason,
    };
  }

  if (!config.multica.enabled) {
    return {
      mode: 'direct_llm',
      title,
      description: context.taskText.slice(0, 2000),
      reason: `本可委派 Agent（${intent.reason}），但 MULTICA_ENABLED=false，降级为直接模型回答`,
    };
  }

  const description: string = [
    `用户任务：${context.taskText.slice(0, 2000)}`,
    memorySummary === '' ? '' : `可参考的用户长期记忆（仅供参考，可能过期，请核实）：\n${memorySummary}`,
    '说明：本任务由知忆（Zhiyi）委派，请返回可复用的结论与依据，不要编造事实。',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 8000);

  return {
    mode: 'agent_delegation',
    agentId: config.multica.defaultAgent || undefined,
    title,
    description,
    reason: `${intent.reason}；目标 Agent=${config.multica.defaultAgent || '未指定（由 MultiCA 默认分配）'}`,
  };
}
