/**
 * Personal AI 侧的会话上下文元数据。
 * 不重复存储完整消息历史（由 ADP Chat Client 负责），只记录
 * 用户、Agent、项目、最近任务与轮次，用于隔离与上下文关联。
 */
import type { Database } from '../../db';
import type { PersonalAIIdentity } from '../identity/identity-manager';

export interface ConversationContext {
  user_id: string;
  conversation_id: string;
  agent_id: string;
  project_id: string | null;
  last_task_id: string | null;
  turn_count: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export class ConversationContextStore {
  constructor(private readonly db: Database) {}

  get(userId: string, conversationId: string): ConversationContext | undefined {
    return this.db.get<ConversationContext>(
      'SELECT * FROM conversation_contexts WHERE user_id = ? AND conversation_id = ?',
      [userId, conversationId],
    );
  }

  /** 每轮对话推进一次；同一用户 + 会话维度隔离。 */
  touch(identity: PersonalAIIdentity, taskId: string | null = null): ConversationContext {
    const now: string = new Date().toISOString();
    const existing: ConversationContext | undefined = this.get(
      identity.user_id,
      identity.conversation_id,
    );
    if (existing) {
      this.db.run(
        `UPDATE conversation_contexts
            SET agent_id = ?, project_id = ?, last_task_id = ?, turn_count = turn_count + 1, updated_at = ?
          WHERE user_id = ? AND conversation_id = ?`,
        [
          identity.agent_id,
          identity.project_id,
          taskId ?? existing.last_task_id,
          now,
          identity.user_id,
          identity.conversation_id,
        ],
      );
      return this.get(identity.user_id, identity.conversation_id) as ConversationContext;
    }
    this.db.run(
      `INSERT OR IGNORE INTO conversation_contexts
         (user_id, conversation_id, agent_id, project_id, last_task_id, turn_count, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [
        identity.user_id,
        identity.conversation_id,
        identity.agent_id,
        identity.project_id,
        taskId,
        now,
        now,
      ],
    );
    return this.get(identity.user_id, identity.conversation_id) as ConversationContext;
  }
}
