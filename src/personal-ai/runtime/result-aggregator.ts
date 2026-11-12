/** 结果聚合：把 Agent 原始输出整理成给用户的一段最终回答。 */

export interface AggregateInput {
  taskId: string;
  agentId?: string;
  content?: string;
  error?: string;
  degraded?: boolean;
}

export function aggregateAgentResult(input: AggregateInput): string {
  if (input.error) {
    return [
      '抱歉，本次 Agent 执行未能完成。',
      '',
      `- 任务：\`${input.taskId}\``,
      `- 原因：${input.error}`,
      '',
      '你可以换一种描述重试，或让我直接基于已有知识回答。',
    ].join('\n');
  }
  const header: string[] = [
    '## Agent 执行结果',
    '',
    `- 任务：\`${input.taskId}\``,
  ];
  if (input.agentId) header.push(`- 执行 Agent：${input.agentId}`);
  if (input.degraded) {
    header.push('', '> 任务仍在后台执行，以上为当前进度；完成后可通过任务接口查询结果。');
  }
  return [...header, '', input.content?.trim() || '（Agent 未返回内容）'].join('\n');
}
