/** 结果聚合：把 Agent 原始输出、失败分类、重试建议及需核实状态整理为清晰的用户反馈。 */

export interface AggregateInput {
  taskId: string;
  businessTaskId?: string | null;
  agentId?: string;
  content?: string;
  error?: string;
  errorCategory?: string | null;
  retryable?: boolean;
  needsVerification?: boolean;
  degraded?: boolean;
}

export function aggregateAgentResult(input: AggregateInput): string {
  if (input.error) {
    const lines: string[] = [
      '抱歉，本次 Agent 执行未能完成。',
      '',
      `- Execution：\`${input.taskId}\``,
    ];
    if (input.businessTaskId) lines.push(`- 业务任务：\`${input.businessTaskId}\``);
    if (input.agentId) lines.push(`- 执行 Agent：${input.agentId}`);
    lines.push(`- 原因：${input.error}`);

    if (input.needsVerification) {
      lines.push(
        '- 状态说明：执行中断或超时，系统无法确认外部/工具侧是否已产生结果，未假定完成。请核实后重试。',
      );
    } else if (input.retryable === true) {
      lines.push('- 处理建议：属于可重试错误，可直接重跑或更换其他 Agent 后重试。');
    } else if (input.retryable === false && input.errorCategory === 'non_retryable') {
      lines.push('- 处理建议：属于不可重试错误，请先修正参数/权限或更换其他 Agent 后再试。');
    }

    lines.push('', '你可以换一种描述重试，或让我直接基于已有知识回答。');
    return lines.join('\n');
  }

  const header: string[] = [
    '## Agent 执行结果',
    '',
    `- 任务：\`${input.taskId}\``,
  ];
  if (input.businessTaskId) header.push(`- 业务任务：\`${input.businessTaskId}\``);
  if (input.agentId) header.push(`- 执行 Agent：${input.agentId}`);
  if (input.degraded) {
    header.push('', '> 任务仍在后台执行，以上为当前进度；完成后可通过任务接口查询结果。');
  }
  return [...header, '', input.content?.trim() || '（Agent 未返回内容）'].join('\n');
}
