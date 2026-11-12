import { isProviderRefusalAssistantError } from "../llm-core/utils/diagnostics.js";
import type { AssistantMessage } from "../llm-core/types.js";

/** Extracted from @openclaw/ai openai-responses-terminal-usage.ts without OpenAI SDK dependency. */
export function isResponsesOutputLimitToolCallError(
  message: Pick<AssistantMessage, "stopReason" | "errorCode" | "diagnostics">,
): boolean {
  return (
    message.stopReason === "error" &&
    message.errorCode === "incomplete_tool_call" &&
    !isProviderRefusalAssistantError(message) &&
    message.diagnostics?.some(
      ({ type, details }) =>
        type === "openai_responses_terminal" &&
        details?.eventType === "response.incomplete" &&
        details.stopReason === "length" &&
        details.incompleteReason === "max_output_tokens",
    ) === true
  );
}
