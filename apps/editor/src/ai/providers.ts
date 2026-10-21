// AI with your own key: requests to the model directly from the browser (the key does not go to our server).
// Anthropic (Messages API, header allowing browser requests) and OpenAI-compatible
// (OpenAI, local Ollama and LM Studio — /v1/chat/completions). Messages are blocks internally,
// as in Anthropic; for OpenAI — converted both ways (function calls, result images —
// as a separate user message).

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: ToolContent[]; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AiConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  /** Custom API address (proxy, local model); empty — the provider's default. */
  baseUrl?: string;
}

export const DEFAULT_MODELS: Record<AiConfig['provider'], string[]> = {
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-5-mini', 'llama3.1', 'qwen2.5-coder'],
};

const STORE = 'mfp-ai';

export function loadConfig(): AiConfig {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<AiConfig> | null;
    if (v?.provider) return { provider: v.provider, apiKey: v.apiKey ?? '', model: v.model || DEFAULT_MODELS[v.provider][0]!, baseUrl: v.baseUrl ?? '' };
  } catch {
    // No storage or corrupted — defaults.
  }
  return { provider: 'anthropic', apiKey: '', model: DEFAULT_MODELS.anthropic[0]!, baseUrl: '' };
}

export function saveConfig(c: AiConfig) {
  try {
    localStorage.setItem(STORE, JSON.stringify(c));
  } catch {
    // Storage unavailable — the setting lasts only until reload.
  }
}

export interface Reply {
  content: Block[];
  stop: 'end' | 'tool' | 'length';
}

/** One model turn: the answer is text and/or tool calls. */
export async function complete(c: AiConfig, system: string, messages: Message[], tools: ToolSpec[], signal?: AbortSignal): Promise<Reply> {
  if (!c.apiKey && c.provider === 'anthropic' && !c.baseUrl) throw new Error('Нет ключа API: откройте настройки ассистента');
  return c.provider === 'anthropic' ? anthropic(c, system, messages, tools, signal) : openai(c, system, messages, tools, signal);
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string };
    const m = typeof j.error === 'string' ? j.error : j.error?.message;
    if (m) return `${res.status}: ${m}`;
  } catch {
    // not JSON
  }
  return `${res.status}: ${body.slice(0, 200) || res.statusText}`;
}

async function anthropic(c: AiConfig, system: string, messages: Message[], tools: ToolSpec[], signal?: AbortSignal): Promise<Reply> {
  const base = (c.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': c.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: c.model, max_tokens: 8192, system, messages, tools }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const j = (await res.json()) as { content: Block[]; stop_reason: string };
  return { content: j.content ?? [], stop: j.stop_reason === 'tool_use' ? 'tool' : j.stop_reason === 'max_tokens' ? 'length' : 'end' };
}

interface OaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | { type: string; text?: string; image_url?: { url: string } }[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

async function openai(c: AiConfig, system: string, messages: Message[], tools: ToolSpec[], signal?: AbortSignal): Promise<Reply> {
  const base = (c.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const out: OaMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      const calls = m.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((u) => ({ id: u.id, type: 'function' as const, function: { name: u.name, arguments: JSON.stringify(u.input) } })) } : {}) });
      continue;
    }
    const images: string[] = [];
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const t = b.content.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'Ошибка: ' : '') + (t || 'ok') });
        for (const x of b.content) if (x.type === 'image') images.push(`data:${x.source.media_type};base64,${x.source.data}`);
      } else if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'image') images.push(`data:${b.source.media_type};base64,${b.source.data}`);
    }
    if (texts.length || images.length) out.push({ role: 'user', content: [...texts.map((t) => ({ type: 'text', text: t })), ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] });
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
    body: JSON.stringify({ model: c.model, messages: out, tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const j = (await res.json()) as { choices: { message: OaMessage; finish_reason: string }[] };
  const msg = j.choices?.[0]?.message;
  const content: Block[] = [];
  if (typeof msg?.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const call of msg?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = { _raw: call.function.arguments };
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  const finish = j.choices?.[0]?.finish_reason;
  return { content, stop: content.some((b) => b.type === 'tool_use') ? 'tool' : finish === 'length' ? 'length' : 'end' };
}
