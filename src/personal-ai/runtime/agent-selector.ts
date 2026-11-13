/**
 * AgentSelector：基于 AgentStore 能力元数据（capabilities / description / role / execution_backend）、
 * 运行状态与并发负载选择逻辑 Agent，并在用户显式指定不可用 Agent 时给出明确诊断。
 * MultiCA 具体 assignee 由 resolveMulticaAssignee() 映射，未配置时平滑回退到全局 defaultAgent。
 */
import type { AgentStore } from '../../agents';
import type { AgentProfile } from '../../types';
import type { TaskRepository } from '../task/task-repository';

export interface SelectAgentOptions {
  taskText: string;
  preferredAgentId?: string | null;
  multicaEnabled: boolean;
  defaultAgentId?: string;
  /** 指定 preferredAgentId 但不可用（不存在/disabled/超并发/multica关闭）时是否回退候选池，默认 true。 */
  allowFallback?: boolean;
}

export interface SelectedAgentResult {
  agent: AgentProfile;
  score: number;
  reason: string;
  activeCount: number;
}

export type AgentUnavailableCode =
  | 'not_found'
  | 'disabled'
  | 'multica_disabled'
  | 'concurrency_limit';

export interface AgentUnavailableReason {
  agentId: string;
  code: AgentUnavailableCode;
  message: string;
}

export interface AgentSelectionOutcome {
  selected?: SelectedAgentResult;
  unavailable?: AgentUnavailableReason;
}

const ROLE_HINTS: Readonly<Record<string, readonly string[]>> = {
  developer: [
    '代码', '实现', '重构', '修复', '调试', '测试', '架构', '编码', '程序员', '开发', 'bug', 'refactor',
    'implement', 'fix', 'debug', 'test', 'code', 'build', 'deploy',
  ],
  researcher: [
    '调研', '研究', '分析', '评估', '对比', '基准', '选型', '报告', '主流', 'research',
    'analysis', 'analyze', 'evaluate', 'evaluation', 'benchmark', 'compare',
  ],
};

const BUILTIN_ROLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  developer: ['程序员', '研发', '开发', '后端研发', '前端研发', '工程师', 'coder', 'dev'],
  researcher: ['研究', '调研', '调研员', '研究员', '分析员', 'research'],
};

const STOP_FRAGMENTS: ReadonlySet<string> = new Set([
  '帮我', '帮忙', '请', '一下', '目前', '现在', '这个', '那个', '一个', '一些', '进行', '以及',
  '并且', '或者', '可以', '需要', '想要', '如何', '怎么', '什么', '为什么', '关于', '方面', '整理',
  '出', '的', '了', '和', '与', '在', '把', '给', '让', '由', '向', '对', '任务', '项目',
  'agent', '智能体',
]);

function extractSearchTerms(normalizedText: string): string[] {
  const terms = new Set<string>();
  const asciiMatches = normalizedText.match(/[a-z0-9][a-z0-9_-]{1,31}/g) ?? [];
  for (const word of asciiMatches) {
    if (!STOP_FRAGMENTS.has(word)) terms.add(word);
  }

  const cjkRuns = normalizedText.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    if (!STOP_FRAGMENTS.has(run) && run.length <= 8) {
      terms.add(run);
    }
    for (let i = 0; i <= run.length - 2; i += 1) {
      const gram2 = run.slice(i, i + 2);
      if (!STOP_FRAGMENTS.has(gram2)) terms.add(gram2);
      if (i <= run.length - 3) {
        const gram3 = run.slice(i, i + 3);
        if (!STOP_FRAGMENTS.has(gram3)) terms.add(gram3);
      }
    }
  }
  return Array.from(terms);
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unavailableMessage(agentId: string, code: AgentUnavailableCode): string {
  switch (code) {
    case 'not_found':
      return `指定的 Agent「${agentId}」不存在`;
    case 'disabled':
      return `指定的 Agent「${agentId}」当前已禁用`;
    case 'multica_disabled':
      return `指定的 Agent「${agentId}」依赖 MultiCA 执行后端，但当前未启用 MultiCA`;
    case 'concurrency_limit':
      return `指定的 Agent「${agentId}」已达到并发上限，请稍后再试`;
  }
}

/**
 * 从自然语言任务描述中识别用户显式指定的 Agent（仅匹配明确的委派/指派语句）。
 * 优先匹配已注册 Agent 的 ID、名称、角色及内置角色别名，若明确写出“xxx Agent”但不存在也返回原始标识供上层报错。
 */
export function resolveRequestedAgentReference(
  taskText: string,
  agents: readonly AgentProfile[],
): { agentId: string; rawMention: string } | undefined {
  const text = (taskText ?? '').trim();
  if (text === '') return undefined;

  const delegateCue =
    '(?:交给|指派给|分配给|委托给|派给|让|请|由)';

  // 1) 精确命中已注册 Agent 的 agent_id / name
  for (const agent of agents) {
    const candidates = [agent.agent_id, agent.name, agent.role]
      .map((v) => v.trim())
      .filter((v) => v.length >= 2);
    for (const label of candidates) {
      const re = new RegExp(`${delegateCue}\\s*${escapeRegExp(label)}(?:\\s*(?:agent|智能体))?`, 'i');
      if (re.test(text)) {
        return { agentId: agent.agent_id, rawMention: label };
      }
    }
  }

  // 2) 匹配内置角色常用称呼（例如“程序员 Agent”、“研究 Agent”）
  for (const [agentId, aliases] of Object.entries(BUILTIN_ROLE_ALIASES)) {
    for (const alias of aliases) {
      const re = new RegExp(`${delegateCue}\\s*${escapeRegExp(alias)}\\s*(?:agent|智能体)`, 'i');
      const matched = text.match(re);
      if (matched) {
        return { agentId, rawMention: matched[0] };
      }
    }
  }

  // 3) 明确说出“交给/让 <X> Agent/智能体”但未命中任何已有别名/ID -> 保留给调用方给出“不存在”诊断
  const explicitTagRe = new RegExp(
    `${delegateCue}\\s*(?:一个|这[个位]|那[个位])?\\s*([A-Za-z0-9_.-]{2,40}|[\\u4e00-\\u9fa5A-Za-z0-9_.-]{1,16})\\s*(?:Agent|agent|智能体)`,
  );
  const genericMatch = text.match(explicitTagRe);
  if (genericMatch && genericMatch[1]) {
    const candidate = genericMatch[1].trim();
    if (candidate !== '' && candidate !== '合适' && candidate !== '专业') {
      // 检查是否有 Agent 的 description/role 包含该简称
      const matchedAgent = agents.find(
        (a) =>
          a.agent_id.toLowerCase() === candidate.toLowerCase() ||
          a.name.toLowerCase() === candidate.toLowerCase() ||
          a.role.toLowerCase().includes(candidate.toLowerCase()),
      );
      return {
        agentId: matchedAgent ? matchedAgent.agent_id : candidate,
        rawMention: genericMatch[0],
      };
    }
  }

  return undefined;
}

function scoreAgent(
  agent: AgentProfile,
  normalizedText: string,
  searchTerms: readonly string[],
  activeCount: number,
  defaultAgentId?: string,
): { score: number; matchedCapabilities: string[] } {
  let score = 0;
  const matchedCapabilities: string[] = [];

  for (const cap of agent.capabilities) {
    const needle: string = cap.trim().toLowerCase();
    if (needle !== '' && normalizedText.includes(needle)) {
      score += 3;
      matchedCapabilities.push(cap);
    }
  }

  const hints: readonly string[] = ROLE_HINTS[agent.agent_id] ?? [];
  let hintHits = 0;
  for (const hint of hints) {
    if (normalizedText.includes(hint)) {
      hintHits += 1;
    }
  }
  if (hintHits > 0) {
    score += Math.min(hintHits, 3) * 2;
  }

  const roleText = `${agent.name} ${agent.role}`.toLowerCase();
  for (const token of roleText.split(/[\s,，/、;；]+/)) {
    if (token.length >= 2 && normalizedText.includes(token)) {
      score += 1.5;
    }
  }

  const descText = `${agent.description} ${agent.core_memory}`.toLowerCase();
  if (descText.trim() !== '' && searchTerms.length > 0) {
    let descHits = 0;
    for (const term of searchTerms) {
      if (descText.includes(term)) {
        descHits += 1;
        if (descHits >= 4) break;
      }
    }
    score += descHits;
  }

  if (defaultAgentId && agent.agent_id === defaultAgentId) {
    score += 0.5;
  }

  score += Math.max(0, agent.concurrency_limit - activeCount) * 0.01;
  return { score, matchedCapabilities };
}

export class AgentSelector {
  constructor(
    private readonly agentStore: AgentStore,
    private readonly taskRepo: TaskRepository,
  ) {}

  private isEligible(
    agent: AgentProfile,
    multicaEnabled: boolean,
  ): { ok: boolean; activeCount: number; skipReason?: Exclude<AgentUnavailableCode, 'not_found'> } {
    if (agent.status !== 'active') {
      return { ok: false, activeCount: 0, skipReason: 'disabled' };
    }
    if (agent.execution_backend === 'multica' && !multicaEnabled) {
      return { ok: false, activeCount: 0, skipReason: 'multica_disabled' };
    }
    const activeCount: number = this.taskRepo.countActiveByAgent(agent.agent_id);
    if (activeCount >= agent.concurrency_limit) {
      return { ok: false, activeCount, skipReason: 'concurrency_limit' };
    }
    return { ok: true, activeCount };
  }

  selectWithDiagnostics(options: SelectAgentOptions): AgentSelectionOutcome {
    const allowFallback: boolean = options.allowFallback ?? true;
    const preferred: string | undefined =
      typeof options.preferredAgentId === 'string' && options.preferredAgentId.trim() !== ''
        ? options.preferredAgentId.trim()
        : undefined;

    if (preferred) {
      const explicit: AgentProfile | undefined = this.agentStore.get(preferred);
      if (!explicit) {
        const unavailable: AgentUnavailableReason = {
          agentId: preferred,
          code: 'not_found',
          message: unavailableMessage(preferred, 'not_found'),
        };
        if (!allowFallback) return { unavailable };
      } else {
        const check = this.isEligible(explicit, options.multicaEnabled);
        if (check.ok) {
          return {
            selected: {
              agent: explicit,
              score: 100,
              reason: `命中指定 Agent ${explicit.agent_id}（backend=${explicit.execution_backend}）`,
              activeCount: check.activeCount,
            },
          };
        }
        const code = check.skipReason ?? 'disabled';
        const unavailable: AgentUnavailableReason = {
          agentId: explicit.agent_id,
          code,
          message: unavailableMessage(explicit.agent_id, code),
        };
        if (!allowFallback) return { unavailable };
      }
    }

    const normalizedText: string = (options.taskText ?? '').toLowerCase();
    const searchTerms: string[] = extractSearchTerms(normalizedText);
    const candidates: Array<{
      agent: AgentProfile;
      score: number;
      activeCount: number;
      matchedCapabilities: string[];
    }> = [];

    for (const agent of this.agentStore.list()) {
      const check = this.isEligible(agent, options.multicaEnabled);
      if (!check.ok) continue;
      const evaluated = scoreAgent(
        agent,
        normalizedText,
        searchTerms,
        check.activeCount,
        options.defaultAgentId,
      );
      candidates.push({
        agent,
        score: evaluated.score,
        activeCount: check.activeCount,
        matchedCapabilities: evaluated.matchedCapabilities,
      });
    }

    if (candidates.length === 0) return {};

    candidates.sort((a, b): number => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.activeCount !== b.activeCount) return a.activeCount - b.activeCount;
      return a.agent.agent_id.localeCompare(b.agent.agent_id);
    });

    const winner = candidates[0];
    const capNote: string =
      winner.matchedCapabilities.length > 0
        ? `能力匹配[${winner.matchedCapabilities.join(',')}]`
        : winner.score > 0.5
          ? '描述与角色匹配'
          : '按状态与并发余量选择';
    return {
      selected: {
        agent: winner.agent,
        score: winner.score,
        reason: `选择 Agent ${winner.agent.agent_id}（${capNote}，backend=${winner.agent.execution_backend}）`,
        activeCount: winner.activeCount,
      },
    };
  }

  select(options: SelectAgentOptions): SelectedAgentResult | undefined {
    return this.selectWithDiagnostics(options).selected;
  }
}

/** 从逻辑 Agent 提取 MultiCA 真实 assignee；未配置时回退全局默认。 */
export function resolveMulticaAssignee(
  agent: Pick<AgentProfile, 'backend_config'> | undefined,
  configDefaultAgent?: string,
): string | undefined {
  const configured: unknown = agent?.backend_config?.assignee;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim();
  }
  const fallback: string = (configDefaultAgent ?? '').trim();
  return fallback !== '' ? fallback : undefined;
}
