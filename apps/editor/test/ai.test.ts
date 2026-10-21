import { afterEach, describe, expect, it, vi } from 'vitest';
import { complete, type Message } from '../src/ai/providers.ts';

const tools = [{ name: 'rename', description: 'Переименовать', input_schema: { type: 'object', properties: {} } }];

afterEach(() => vi.unstubAllGlobals());

function stubFetch(reply: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

describe('AI: providers', () => {
  it('Anthropic: headers, system and tools; calls as blocks', async () => {
    const calls = stubFetch({ content: [{ type: 'tool_use', id: 't1', name: 'rename', input: { a: 1 } }], stop_reason: 'tool_use' });
    const r = await complete({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5-5' }, 'сис', [{ role: 'user', content: [{ type: 'text', text: 'привет' }] }], tools);
    expect(r.stop).toBe('tool');
    expect(r.content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'rename', input: { a: 1 } });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('k');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.system).toBe('сис');
    expect(body.tools[0].input_schema).toBeTruthy();
  });

  it('OpenAI: tool results as role tool, images as a user message; function calls → blocks', async () => {
    const calls = stubFetch({ choices: [{ message: { role: 'assistant', content: 'ок', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'rename', arguments: '{"x":2}' } }] }, finish_reason: 'tool_calls' }] });
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'сделай' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'смотрю' }, { type: 'tool_use', id: 'c1', name: 'screenshot', input: { id: '1:2' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }] },
    ];
    const r = await complete({ provider: 'openai', apiKey: 'sk', model: 'gpt-5', baseUrl: 'http://local/v1/' }, 'сис', history, tools);
    expect(calls[0]!.url).toBe('http://local/v1/chat/completions');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: 'screenshot', arguments: '{"id":"1:2"}' });
    expect(body.messages[4].content[0].image_url.url).toBe('data:image/png;base64,AAA');
    expect(body.tools[0].function.name).toBe('rename');
    expect(r.content).toEqual([{ type: 'text', text: 'ок' }, { type: 'tool_use', id: 'c9', name: 'rename', input: { x: 2 } }]);
    expect(r.stop).toBe('tool');
  });

  it('API error — as text from the response', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }));
    await expect(complete({ provider: 'anthropic', apiKey: 'bad', model: 'm' }, '', [], [])).rejects.toThrow('401: invalid x-api-key');
  });
});
