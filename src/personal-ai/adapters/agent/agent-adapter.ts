/**
 * Agent 执行适配器统一接口。
 * 第一版只有 MultiCA CLI 实现；内部状态与 ADP / 前端协议无关。
 */
export interface CreateTaskInput {
  userId: string;
  conversationId: string;
  taskId: string;
  title: string;
  description: string;
  agentId?: string;
  projectId?: string;
}

export interface CreateTaskResult {
  externalTaskId: string;
  status: string;
}

export interface TaskStatus {
  status: string;
  progress?: number;
  message?: string;
  /** 以下为 MultiCA CLI 实测字段的适配扩展，非用户可伪造输入。 */
  externalRunId?: string;
  agentId?: string;
  rawStatus?: string;
}

export interface TaskResult {
  status: 'completed' | 'failed';
  content?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentExecutionAdapter {
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  assignAgent(input: { externalTaskId: string; agentId: string }): Promise<void>;
  getTaskStatus(externalTaskId: string): Promise<TaskStatus>;
  getTaskResult(externalTaskId: string, externalRunId?: string): Promise<TaskResult>;
  /** 未提供可靠取消能力时返回 false，由调用方明确报告限制。 */
  cancelTask?(externalTaskId: string, externalRunId?: string): Promise<boolean>;
  /** daemon 健康状态，用于 /health/personal-ai。 */
  daemonStatus?(): Promise<{ status: string; available: boolean }>;
}
