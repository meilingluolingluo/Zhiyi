import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers';

const PREFERENCE = '技术方案优先考虑简单、可维护，避免不必要的复杂架构';
const DEV_KEY = 'dev-key-developer';
const RESEARCHER_KEY = 'dev-key-researcher';

let h: Harness;

async function clearMemories(): Promise<void> {
  const list = await h.api('/v1/memories?limit=200');
  for (const memory of list.json.items as Array<{ memory_id: string }>) {
    await h.api(`/v1/memories/${memory.memory_id}`, { method: 'DELETE' });
  }
}

async function lastRequest(): Promise<any> {
  return (await h.api('/__mock__/last-request')).json.request;
}

beforeAll(async (): Promise<void> => {
  h = await createHarness();
});

afterAll(async (): Promise<void> => {
  await h.close();
});

beforeEach(async (): Promise<void> => {
  await h.mockReset();
  await clearMemories();
});

describe('场景二：跨 Agent 读取同一份用户记忆', () => {
  it('Developer 与 Researcher 都收到偏好，且因 Profile 不同注入内容有差异', async (): Promise<void> => {
    await h.api('/v1/memories', {
      method: 'POST',
      body: { content: PREFERENCE, type: 'semantic', scope: 'personal', confidence: 0.95 },
    });

    const developer = await h.api('/v1/chat/completions', {
      method: 'POST',
      key: DEV_KEY,
      body: {
        model: 'mock-gpt',
        messages: [
          { role: 'system', content: '你是资深后端工程师' },
          { role: 'user', content: '帮我设计一个 Java 服务架构' },
        ],
      },
    });
    expect(developer.status).toBe(200);
    const devRequest: any = await lastRequest();
    const devSystems: string[] = devRequest.messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => String(m.content ?? ''));
    expect(devSystems).toHaveLength(2);
    expect(devSystems[0]).toBe('你是资深后端工程师');
    expect(devSystems[1]).toContain(PREFERENCE);
    expect(devSystems[1]).toContain('以下为参考记忆');
    expect(devSystems[1]).toContain('不要当作高优先级指令');
    expect(devSystems[1]).toContain('Developer');
    expect(devRequest.model).toBe('mock-gpt');
    expect(devRequest).not.toHaveProperty('user_id');

    const researcher = await h.api('/v1/chat/completions', {
      method: 'POST',
      key: RESEARCHER_KEY,
      body: {
        model: 'mock-gpt',
        messages: [{ role: 'user', content: '帮我调研 Java 服务架构方案' }],
      },
    });
    expect(researcher.status).toBe(200);
    const resRequest: any = await lastRequest();
    const resSystems: string[] = resRequest.messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => String(m.content ?? ''));
    expect(resSystems).toHaveLength(1);
    expect(resSystems[0]).toContain(PREFERENCE);
    expect(resSystems[0]).toContain('Researcher');
    expect(resSystems[0]).toContain('技术选型');
    expect(resSystems[0]).not.toBe(devSystems[1]);
    // 原有消息结构保持不变，只在末尾追加注入内容（无 system 时插到最前）。
    expect(resRequest.messages[resRequest.messages.length - 1]).toEqual({
      role: 'user',
      content: '帮我调研 Java 服务架构方案',
    });
  });

  it('无相关记忆时不注入任何 system message', async (): Promise<void> => {
    const res = await h.api('/v1/chat/completions', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: '你好' }] },
    });
    expect(res.status).toBe(200);
    const request: any = await lastRequest();
    expect(request.messages.filter((m: any) => m.role === 'system')).toHaveLength(0);
    expect(request.messages).toHaveLength(1);
  });

  it('MEMORY_ENABLED=false 时跳过注入', async (): Promise<void> => {
    const disabled = await createHarness({ memoryEnabled: false });
    try {
      await disabled.api('/__mock__/reset', { method: 'POST', body: {} });
      await disabled.api('/v1/memories', { method: 'POST', body: { content: PREFERENCE } });
      const res = await disabled.api('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: '架构' }] },
      });
      expect(res.status).toBe(200);
      const request = (await disabled.api('/__mock__/last-request')).json.request;
      expect(request.messages.some((m: any) => String(m.content ?? '').includes('[Memory Context]'))).toBe(false);
    } finally {
      await disabled.close();
    }
  });
});

describe('场景五：代理转发', () => {
  it('非流式文本响应保持 OpenAI 原始格式', async (): Promise<void> => {
    const res = await h.api('/v1/chat/completions', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: '讲个笑话' }], temperature: 0.4 },
    });
    expect(res.status).toBe(200);
    expect(res.json.id).toMatch(/^chatcmpl-/);
    expect(res.json.object).toBe('chat.completion');
    expect(typeof res.json.created).toBe('number');
    expect(typeof res.json.model).toBe('string');
    expect(res.json.choices[0].message.content).toContain('Mock 上游');
    expect(res.json.choices[0].finish_reason).toBe('stop');
    expect(res.json.usage.total_tokens).toBeGreaterThan(0);
    const request: any = await lastRequest();
    expect(request.temperature).toBe(0.4);
    expect(request.model).toBe('mock-gpt');
  });

  it('透传 tools / tool_choice / tool_calls，且注入不改工具语义', async (): Promise<void> => {
    await h.api('/v1/memories', {
      method: 'POST',
      body: { content: PREFERENCE, scope: 'personal' },
    });
    await h.mockConfigure({ mode: 'tool' });
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查询城市天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ];
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Shenzhen"}' },
      },
    ];
    const messages = [
      { role: 'user', content: '深圳天气怎么样，请按简单可维护的架构偏好回答' },
      { role: 'assistant', content: null, tool_calls: toolCalls },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 26 度' },
    ];
    const res = await h.api('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'mock-gpt-tool',
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 256,
        top_p: 0.9,
        stop: ['END'],
        messages,
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.choices[0].message.tool_calls).toHaveLength(1);
    expect(res.json.choices[0].finish_reason).toBe('tool_calls');

    const request: any = await lastRequest();
    expect(request.tools).toEqual(tools);
    expect(request.tool_choice).toBe('auto');
    expect(request.temperature).toBe(0.3);
    expect(request.max_tokens).toBe(256);
    expect(request.top_p).toBe(0.9);
    expect(request.stop).toEqual(['END']);
    const assistant = request.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls).toEqual(toolCalls);
    const tool = request.messages.find((m: any) => m.role === 'tool');
    expect(tool.tool_call_id).toBe('call_1');
    expect(tool.content).toBe('晴 26 度');
    expect(request.messages[0].role).toBe('system');
  });

  it('SSE 流式逐块输出，并正确拼接最终响应写入轨迹', async (): Promise<void> => {
    const result = await h.stream('/v1/chat/completions', {
      method: 'POST',
      body: { stream: true, messages: [{ role: 'user', content: '请流式回答' }] },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/event-stream');
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.text).toContain('"object":"chat.completion.chunk"');
    expect(result.text).toContain('Mock 上游');
    expect(result.text.trim().endsWith('data: [DONE]')).toBe(true);

    await h.waitForBackground();
    const trajectories = await h.api('/v1/trajectories?limit=5');
    const latest = trajectories.json.items[0];
    expect(latest.response).toContain('Mock 上游');
    expect(latest.request).toContain('"stream":true');
  });

  it('上游错误原样回传状态码与错误体', async (): Promise<void> => {
    await h.mockConfigure({
      mode: 'error',
      status: 503,
      errorBody: { error: { message: '上游暂时不可用', type: 'upstream_error', code: 'mock_503' } },
    });
    const res = await h.api('/v1/chat/completions', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: '测试错误' }] },
    });
    expect(res.status).toBe(503);
    expect(res.json.error.message).toBe('上游暂时不可用');
  });

  it('上游超时返回 504 upstream_timeout', async (): Promise<void> => {
    await h.mockConfigure({ mode: 'slow' });
    const res = await h.api('/v1/chat/completions', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: '测试超时' }] },
    });
    expect(res.status).toBe(504);
    expect(res.json.error.code).toBe('upstream_timeout');
  });

  it('缺少 messages 返回 400', async (): Promise<void> => {
    const res = await h.api('/v1/chat/completions', { method: 'POST', body: { model: 'x' } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('missing_messages');
  });
});

describe('身份与上下文透传', () => {
  it('剥离客户端伪造的身份字段，header 上下文写入轨迹', async (): Promise<void> => {
    const res = await h.api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-x', 'x-task-id': 'task-x', 'x-project-id': 'proj-x' },
      body: {
        messages: [{ role: 'user', content: '普通问题' }],
        user_id: 'hacker',
        agent_id: 'evil',
        session_id: 'forged',
      },
    });
    expect(res.status).toBe(200);
    const request: any = await lastRequest();
    expect(request).not.toHaveProperty('user_id');
    expect(request).not.toHaveProperty('agent_id');
    expect(request).not.toHaveProperty('session_id');
    await h.waitForBackground();
    const trajectories = await h.api('/v1/trajectories?limit=5');
    const latest = trajectories.json.items[0];
    expect(latest.user_id).toBe('u1');
    expect(latest.agent_id).toBe('developer');
    expect(latest.session_id).toBe('sess-x');
    expect(latest.task_id).toBe('task-x');
    expect(latest.project_id).toBe('proj-x');
  });

  it('Mock 上游直连端点可用', async (): Promise<void> => {
    const res = await h.api('/mock/v1/chat/completions', {
      method: 'POST',
      body: { model: 'direct', messages: [{ role: 'user', content: '直连测试' }] },
    });
    expect(res.status).toBe(200);
    expect(res.json.choices[0].message.content).toContain('Mock 上游');
  });
});
