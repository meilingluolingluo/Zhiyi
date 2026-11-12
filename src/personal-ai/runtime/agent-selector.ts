/**
 * AgentSelector：基于 AgentStore 能力元数据、状态、Backend 可用性与并发负载选择逻辑 Agent。
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
  /** 指定 preferredAgentId 但不可用（disabled/超并发/multica关闭）时是否回退候选池，默认 true。 */
  allowFallback?: boolean;
}

export interface SelectedAgentResult {
  agent: AgentProfile;
  score: number;
  reason: string;
  activeCount: number;
}

const ROLE_HINTS: Readonly<Record<string, readonly string[]>> = {
  developer: [
    '代码', '实现', '重构', '修复', '调试', '测试', '架构', 'bug', 'refactor',
    'implement', 'fix', 'debug', 'test', 'code', 'build', 'deploy',
  ],
  researcher: [
    '调研', '分析', '评估', '对比', '基准', '选型', '报告', 'research',
    'analysis', 'analyze', 'evaluate', 'evaluation', 'benchmark', 'compare',
  ],
};

function scoreAgent(
  agent: AgentProfile,
  normalizedText: string,
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

  const roleText: string = `${agent.name} ${agent.role}`.toLowerCase();
  for (const token of roleText.split(/[\s,，/、;；]+/)) {
    if (token.length >= 2 && normalizedText.includes(token)) {
      score += 1;
    }
  }

  if (defaultAgentId && agent.agent_id === defaultAgentId) {
    score += 0.5;
  }

  // 轻微偏好剩余并发余量更高的 Agent
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
  ): { ok: boolean; activeCount: number; skipReason?: string } {
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

  select(options: SelectAgentOptions): SelectedAgentResult | undefined {
    const allowFallback: boolean = options.allowFallback ?? true;
    const preferred: string | undefined =
      typeof options.preferredAgentId === 'string' && options.preferredAgentId.trim() !== ''
        ? options.preferredAgentId.trim()
        : undefined;

    if (preferred) {
      const explicit: AgentProfile | undefined = this.agentStore.get(preferred);
      if (explicit) {
        const check = this.isEligible(explicit, options.multicaEnabled);
        if (check.ok) {
          return {
            agent: explicit,
            score: 100,
            reason: `命中指定 Agent ${explicit.agent_id}（backend=${explicit.execution_backend}）`,
            activeCount: check.activeCount,
          };
        }
      }
      if (!allowFallback) {
        return undefined;
      }
    }

    const normalizedText: string = (options.taskText ?? '').toLowerCase();
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

    if (candidates.length === 0) return undefined;

    candidates.sort((a, b): number => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.activeCount !== b.activeCount) return a.activeCount - b.activeCount;
      return a.agent.agent_id.localeCompare(b.agent.agent_id);
    });

    const winner = candidates[0];
    const capNote: string =
      winner.matchedCapabilities.length > 0
        ? `能力匹配[${winner.matchedCapabilities.join(',')}]`
        : '按状态与并发余量选择';
    return {
      agent: winner.agent,
      score: winner.score,
      reason: `选择 Agent ${winner.agent.agent_id}（${capNote}，backend=${winner.agent.execution_backend}）`,
      activeCount: winner.activeCount,
    };
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
