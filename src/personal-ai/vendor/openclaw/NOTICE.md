# Vendored OpenClaw Agent Core (Minimal Extraction)

- **Source Repository**: `https://github.com/openclaw/openclaw`
- **Pinned Commit SHA**: `26bd0ebfb33417362f32d362bec941bc830390d6`
- **License**: MIT License (see `LICENSE` in this directory; Copyright (c) 2026 OpenClaw Foundation)

## Extracted Scope (Minimum Agent Loop Only)

1. `agent-core/` (24 core root modules + `harness/session/uuid.ts` + `harness/compaction/compaction-threshold.ts`):
   - `Agent`, `runAgentLoop`, tool execution / batch admission / sequential & parallel scheduling, tool argument validation, tool-loop recovery & repetition guard, steering/follow-up queues, abort/turn interruption, taint tracking.
   - Excluded: `harness/session/session.ts`, OpenClaw Gateway, Config, Plugin SDK, Channel adapters, full compaction session tree.
2. `llm-core/` (11 core modules):
   - Core message/tool/stream contracts (`Context`, `AssistantMessage`, `AssistantMessageEventStream`, `Tool`, `ToolCall`, `ToolResultMessage`, `Model`), `validateToolArguments`, `validateToolCall`, `EventStream`.
3. `normalization-core/` (10 pure-TS helper modules):
   - `cjk-chars`, `error-coercion`, `json-schema`, `number-coercion`, `record-coerce`, `result`, `string-coerce`, `string-normalization`, `stringified-error`, `utf16-slice`.
4. `ai-compat/`:
   - Extracted pure helpers from `@openclaw/ai` (`prepareSystemPrompt`, `sanitizeSurrogates`, `prompt-cache-stability`, `isResponsesOutputLimitToolCallError`, `createEmptyTransportUsage`, `replaceCompactionReplayOwnerContent`) without any provider SDK (`openai`, `@anthropic-ai/sdk`, etc.). All model HTTP/auth/credentials stay inside Zhiyi's `ModelAdapter`.

## Minimal Build Adaptations

- Rewrote `@openclaw/*` workspace package specifiers to local relative imports for TypeScript compilation inside `universal-memory-gateway`.
- In `llm-core/validation.ts`, replaced external `../../../standalone-runtime-profile.mjs` import with an inline `getRuntimeExecutionProfile()` helper preserving identical runtime behavior.
- Replaced `ai/transports` compaction checkpoint dependency with a pass-through `replaceCompactionReplayOwnerContent` stub because Zhiyi manages context/tasks/sessions directly.
- Added runtime dependency `typebox@1.4.3` (exact OpenClaw version) in `universal-memory-gateway/package.json`.
