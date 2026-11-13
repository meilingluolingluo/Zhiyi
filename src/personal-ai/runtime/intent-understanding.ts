/**
 * 轻量意图识别：区分普通问答、讨论想法与需要委派 Agent 执行的明确工作请求。
 */
import type { AgentProfile } from '../../types';
import { resolveRequestedAgentReference } from './agent-selector';

export type ExecutionMode = 'direct_llm' | 'agent_delegation';

export interface IntentResult {
  mode: ExecutionMode;
  reason: string;
  confidence: number;
  matched: string[];
  /** 若用户在自然语言中明确指定了目标 Agent，记录其标识供调度校验。 */
  requestedAgentId?: string;
}

const GREETING_ONLY: RegExp = /^(你好|hi|hello|hey|在吗|谢谢|thanks|再见)[\s!！。,.~]*$/i;

export function isGreetingOnly(text: string): boolean {
  return GREETING_ONLY.test((text ?? '').toLowerCase().trim());
}

export type StructuredIntentAction =
  | 'direct_llm'
  | 'delegate_task'
  | 'create_goal'
  | 'create_project'
  | 'create_task';

const STRUCTURED_ACTIONS: ReadonlySet<string> = new Set([
  'direct_llm',
  'delegate_task',
  'create_goal',
  'create_project',
  'create_task',
]);

export interface StructuredIntent {
  action: StructuredIntentAction;
  confidence: number;
  reason: string;
  title?: string;
  description?: string;
  priority?: number;
  target_date?: string;
  preferred_agent_id?: string;
  project_id?: string;
  goal_ids?: string[];
}

export function buildIntentClassificationPrompt(
  taskText: string,
  agentSummaries: string[],
  projectSummaries: string[],
  goalSummaries: string[],
): string {
  return [
    '你是知忆（Zhiyi）的意图路由器。请分析用户最后一条消息，仅输出一个合法 JSON 对象，不要包含额外解释或 Markdown。',
    '允许的 action：',
    '- "direct_llm": 普通问答、概念解释、日常对话或无需持久化追踪的一次性文本生成',
    '- "delegate_task": 需要由专业 Agent 立即执行的实质任务（如代码分析/修复/调研评估等）',
    '- "create_goal": 用户明确要求创建或记录一个长期目标（Goal）',
    '- "create_project": 用户明确要求创建一个项目（Project）',
    '- "create_task": 用户明确要求记录一条待办业务任务（暂不立即执行）',
    agentSummaries.length > 0 ? `可用 Agent：${agentSummaries.join('；')}` : '可用 Agent：默认',
    projectSummaries.length > 0 ? `用户当前项目：${projectSummaries.join('；')}` : '用户当前项目：无',
    goalSummaries.length > 0 ? `用户当前目标：${goalSummaries.join('；')}` : '用户当前目标：无',
    '输出 JSON schema: {"action":string,"confidence":number(0-1),"reason":string,"title"?:string,"description"?:string,"priority"?:0|1|2|3|4,"target_date"?:string,"preferred_agent_id"?:string,"project_id"?:string,"goal_ids"?:string[]}',
    `用户输入：${taskText.slice(0, 2000)}`,
  ].join('\n');
}

export function parseStructuredIntent(raw: string, minConfidence = 0.6): StructuredIntent | null {
  const trimmed: string = (raw ?? '').trim();
  if (trimmed === '') return null;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate: string = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const start: number = candidate.indexOf('{');
  const end: number = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.action !== 'string' || !STRUCTURED_ACTIONS.has(obj.action)) return null;
  if (
    typeof obj.confidence !== 'number' ||
    !Number.isFinite(obj.confidence) ||
    obj.confidence < minConfidence ||
    obj.confidence > 1
  ) {
    return null;
  }

  const action = obj.action as StructuredIntentAction;
  const reason: string =
    typeof obj.reason === 'string' && obj.reason.trim() !== ''
      ? obj.reason.trim().slice(0, 300)
      : `LLM 分类为 ${action}`;

  const title: string | undefined =
    typeof obj.title === 'string' && obj.title.trim() !== ''
      ? obj.title.trim().slice(0, 200)
      : undefined;

  if (action !== 'direct_llm' && !title) {
    return null;
  }

  const result: StructuredIntent = {
    action,
    confidence: obj.confidence,
    reason,
    title,
  };

  if (typeof obj.description === 'string' && obj.description.trim() !== '') {
    result.description = obj.description.trim().slice(0, 4000);
  }
  if (typeof obj.priority === 'number' && Number.isInteger(obj.priority) && obj.priority >= 0 && obj.priority <= 4) {
    result.priority = obj.priority;
  }
  if (typeof obj.target_date === 'string' && obj.target_date.trim() !== '') {
    result.target_date = obj.target_date.trim().slice(0, 64);
  }
  if (typeof obj.preferred_agent_id === 'string' && obj.preferred_agent_id.trim() !== '') {
    result.preferred_agent_id = obj.preferred_agent_id.trim().slice(0, 64);
  }
  if (typeof obj.project_id === 'string' && obj.project_id.trim() !== '') {
    result.project_id = obj.project_id.trim().slice(0, 100);
  }
  if (Array.isArray(obj.goal_ids)) {
    result.goal_ids = obj.goal_ids
      .filter((id: unknown): id is string => typeof id === 'string' && id.trim() !== '')
      .map((id: string): string => id.trim().slice(0, 100))
      .slice(0, 20);
  }

  return result;
}

const EXECUTION_WORK_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: '深度研究/调研',
    pattern: /(?:帮我|帮忙|请|麻烦)?(?:研究一下|调研一下|做(?:一次|个).*?调研|深入研究|调研主流|研究.*?主流)/i,
  },
  {
    label: '项目分析与改进整理',
    pattern: /(?:帮我|帮忙|请|麻烦)?(?:分析|评估|梳理|盘点)(?:一下)?(?:这个|当前|整个|本)?(?:项目|系统|工程|服务|方案).*?(?:改进建议|优化建议|问题|报告|清单|方案)/i,
  },
  {
    label: '明确委派执行',
    pattern: /(?:交给|指派给|委托给|派给|让).{1,30}(?:agent|智能体|处理|执行|调研|开发|实现|排查)/i,
  },
];

export function understandIntent(
  text: string,
  keywords: readonly string[],
  registeredAgents: readonly AgentProfile[] = [],
): IntentResult {
  const normalized: string = (text ?? '').toLowerCase();
  if (isGreetingOnly(text)) {
    return { mode: 'direct_llm', reason: '普通问候/寒暄，无需外部 Agent', confidence: 0.95, matched: [] };
  }

  const requestedRef = resolveRequestedAgentReference(text, registeredAgents);
  if (requestedRef) {
    return {
      mode: 'agent_delegation',
      reason: `用户明确指派 Agent「${requestedRef.agentId}」执行任务`,
      confidence: 0.92,
      matched: [requestedRef.rawMention],
      requestedAgentId: requestedRef.agentId,
    };
  }

  const matched: string[] = [];
  for (const keyword of keywords) {
    const needle: string = keyword.toLowerCase().trim();
    if (needle !== '' && normalized.includes(needle) && !matched.includes(keyword)) {
      matched.push(keyword);
    }
  }

  // 需要真实执行/工具/仓库上下文的请求才委派 Agent；单纯咨询或探讨想法不误触发。
  const actionVerbs: readonly string[] = [
    '帮我', '请', '实现', '修复', '重构', '分析', '检查', '排查', '调研', '研究', '编写',
    '写代码', '跑', '执行', '扫描', '生成代码', '提交', '部署', '评估', '整理',
    'implement', 'fix', 'refactor', 'analyze', 'investigate', 'research', 'build', 'run',
  ];
  const hasAction: boolean = actionVerbs.some((verb: string): boolean => normalized.includes(verb));

  const patternHits = EXECUTION_WORK_PATTERNS.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.label,
  );

  if (patternHits.length > 0 && hasAction) {
    return {
      mode: 'agent_delegation',
      reason: `识别到明确工作执行诉求（${patternHits.join('、')}），交由合适 Agent 执行`,
      confidence: 0.86,
      matched: [...matched, ...patternHits],
    };
  }

  if (matched.length > 0 && hasAction) {
    const confidence: number = Math.min(0.95, 0.55 + matched.length * 0.12);
    return {
      mode: 'agent_delegation',
      reason: `命中可执行任务关键词（${matched.slice(0, 4).join('、')}）且包含动作诉求，委派 Agent`,
      confidence,
      matched,
    };
  }

  return {
    mode: 'direct_llm',
    reason: matched.length > 0
      ? `命中关键词（${matched.slice(0, 4).join('、')}）但缺少执行动作，按普通问答处理`
      : '普通问答/解释/文本生成，直接调用模型',
    confidence: 0.8,
    matched,
  };
}
