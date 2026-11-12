import type { AssistantMessage, Usage } from "../llm-core/index.js";

export function createEmptyTransportUsage(): Pick<
  Usage,
  "input" | "output" | "cacheRead" | "cacheWrite" | "contextUsage" | "totalTokens"
> & {
  cost: Pick<Usage["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "total">;
} {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

/**
 * Minimal pure-TS compat adapter for replaceCompactionReplayOwnerContent
 * (stripped of external provider-compaction-replay checkpoints since Zhiyi owns context).
 */
export function replaceCompactionReplayOwnerContent(
  message: AssistantMessage,
  content: AssistantMessage["content"],
): AssistantMessage {
  return { ...message, content };
}
