/**
 * 事件适配器：把 OpenClaw `AgentEvent` 生命周期事件映射为知忆统一 `PersonalAIEvent`，
 * 同时记录多轮推理轮次、工具调用统计与最终结果文本。
 */
import type { PersonalAIEvent } from '../../events/event-types';
import type { AgentEvent } from '../../vendor/openclaw/agent-core/types.js';

export interface OpenClawRunMetrics {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  streamedText: string;
}

export function createOpenClawEventTranslator(
  executionId: string,
  emit: (event: PersonalAIEvent) => void,
): {
  metrics: OpenClawRunMetrics;
  handleEvent: (event: AgentEvent) => void;
} {
  const metrics: OpenClawRunMetrics = {
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    streamedText: '',
  };

  const handleEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'turn_start':
        metrics.turns += 1;
        break;
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          const delta = event.assistantMessageEvent.delta;
          if (delta !== '') {
            metrics.streamedText += delta;
            emit({ type: 'text_delta', content: delta });
          }
        }
        break;
      case 'tool_execution_start':
        metrics.toolCalls += 1;
        emit({
          type: 'task_progress',
          taskId: executionId,
          status: 'running',
          message: `正在调用工具 ${event.toolName}`,
        });
        break;
      case 'tool_execution_end':
        if (event.isError) {
          metrics.toolErrors += 1;
        }
        break;
      default:
        break;
    }
  };

  return { metrics, handleEvent };
}
