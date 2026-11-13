/**
 * Personal AI 内部事件模型。
 *
 * 完全独立于任何前端协议：ADP Chat Client 的 V2 SSE 与 OpenAI chunk
 * 都由 adapters/protocol 负责转换。运行时只产出这些事件。
 */
export type PersonalAIEvent =
  | { type: 'message_start'; conversationId: string }
  | { type: 'text_delta'; content: string }
  | { type: 'task_started'; taskId: string; mode?: 'multica' | 'openclaw' | 'direct_llm'; agentId?: string }
  | { type: 'task_progress'; taskId: string; status: string; message?: string }
  | { type: 'agent_started'; taskId: string; agentId: string }
  | { type: 'agent_completed'; taskId: string; agentId: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_cancelled'; taskId: string; reason?: string }
  | { type: 'final_answer'; content: string }
  | { type: 'error'; message: string }
  | { type: 'message_end' };

export const PERSONAL_AI_EVENT_TYPES: readonly PersonalAIEvent['type'][] = [
  'message_start',
  'text_delta',
  'task_started',
  'task_progress',
  'agent_started',
  'agent_completed',
  'task_failed',
  'task_cancelled',
  'final_answer',
  'error',
  'message_end',
];
