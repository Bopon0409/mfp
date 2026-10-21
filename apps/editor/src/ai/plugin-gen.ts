// Generative plugins ([β], our own): a model with your own key writes a plugin from a description —
// code for the plugin API (Figma-compatible) and, if needed, a window. The plugin runs immediately;
// “Save” puts it into “My plugins” (the “Plugins” menu and Ctrl+K); “Refine” — another conversation
// turn with the previous code. The key does not go to our server (the request goes straight to the provider).

import type { PluginBundle } from '@mfp/plugin-host';
import { h, modal } from '../dom.ts';
import { installBundle, launch, type PluginUiDeps } from '../plugins-ui.ts';
import { complete, loadConfig, type Message, type ToolSpec } from './providers.ts';

export interface GeneratedPlugin {
  name: string;
  code: string;
  ui?: string;
  summary: string;
}

const SYSTEM = `You write plugins for MFP, a design editor whose plugin API is compatible with the Figma Plugin API (global \`figma\`).
Reply ONLY by calling the write_plugin tool with the complete plugin.

Plugin code (code):
- Runs in a sandbox (ES2020, no DOM, no fetch). Use the \`figma\` global like in Figma plugins.
- Available: figma.currentPage (children, selection, findAll/findOne), figma.createRectangle/createEllipse/createFrame/createText/createLine/createPolygon/createStar/createComponent, figma.group, figma.union/subtract/flatten, node properties (name, x, y, resize(w, h), rotation, fills, strokes, strokeWeight, cornerRadius, opacity, effects, layoutMode and other auto layout properties, characters), figma.loadFontAsync({ family: 'Inter', style: 'Regular' }) before setting text, figma.viewport.scrollAndZoomIntoView(nodes), figma.notify(text), figma.clientStorage, figma.variables, figma.closePlugin().
- Colors are { r, g, b } in 0..1. Fills are arrays: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }].
- Wrap async work in (async () => { ... })(). Always call figma.closePlugin() at the end unless the plugin shows a UI.
- With a UI: figma.showUI(__html__, { width, height }); talk through figma.ui.postMessage / figma.ui.onmessage; the UI page uses parent.postMessage({ pluginMessage: … }, '*') and window.onmessage (event.data.pluginMessage). Close with figma.closePlugin() on a "Close" or "Done" message.

UI (ui, optional): one self-contained HTML page (inline CSS and JS, no external resources), compact, readable on dark and light backgrounds.
Use the language of the user's request for all user-facing text (names, notifications, UI). Keep code short and robust: check the selection and explain with figma.notify when there is nothing to work with.`;

const WRITE: ToolSpec = {
  name: 'write_plugin',
  description: 'The complete plugin: short name, main code, optional UI page, one-sentence summary of what it does.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short plugin name (2–4 words) in the language of the request' },
      code: { type: 'string', description: 'Plugin main code (JavaScript)' },
      ui: { type: 'string', description: 'Optional HTML page for figma.showUI(__html__)' },
      summary: { type: 'string', description: 'What the plugin does, one sentence, language of the request' },
    },
    required: ['name', 'code', 'summary'],
  },
};

/** Model turn: conversation history → plugin (or an error with its text). */
export async function generatePlugin(history: Message[], signal?: AbortSignal): Promise<{ plugin: GeneratedPlugin; reply: Message }> {
  const r = await complete(loadConfig(), SYSTEM, history, [WRITE], signal);
  const call = r.content.find((b) => b.type === 'tool_use' && b.name === 'write_plugin');
  if (!call || call.type !== 'tool_use') {
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ').trim();
    throw new Error(text || 'Модель не прислала плагин');
  }
  const i = call.input as Partial<GeneratedPlugin>;
  if (typeof i.code !== 'string' || !i.code.trim()) throw new Error('Модель прислала пустой код');
  return {
    plugin: { name: String(i.name ?? 'Плагин').slice(0, 60), code: i.code, ui: typeof i.ui === 'string' && i.ui.trim() ? i.ui : undefined, summary: String(i.summary ?? '') },
    reply: { role: 'assistant', content: r.content },
  };
}

/** Plugin package: manifest (id derived from the name and code) and files. */
export function bundleOf(p: GeneratedPlugin): PluginBundle {
  let hash = 0;
  for (const ch of p.name + p.code) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0;
  return {
    manifest: { name: p.name, id: `gen-${(hash >>> 0).toString(36)}`, api: '1.0.0', main: 'code.js', editorType: ['figma'], ...(p.ui ? { ui: 'ui.html' } : {}) },
    code: p.code,
    ...(p.ui ? { html: p.ui } : {}),
  };
}

/** The “Create plugin from description” window. */
export function openPluginGenerator(d: PluginUiDeps, openAiSettings: () => void) {
  const m = modal('Плагин по описанию', { cls: 'gen-modal' });
  const cfg = loadConfig();
  if (!cfg.apiKey && !cfg.baseUrl) {
    m.body.append(
      h('p', { class: 'm-note' }, 'Плагин пишет модель со своим ключом (Anthropic, OpenAI или локальная — Ollama, LM Studio). Ключ хранится только на этом компьютере.'),
      h('div', { class: 'm-row end' }, h('button', { class: 'm-btn primary', onclick: () => (m.close(), openAiSettings()) }, 'Настроить ассистента')),
    );
    return;
  }
  const ask = h('textarea', { class: 'gen-ask', rows: '3', placeholder: 'Что должен делать плагин? Например: «Расставь выделенные слои сеткой по 4 в ряд с промежутком 24» или «Окно с полем: сколько звёзд нарисовать»' }) as HTMLTextAreaElement;
  const status = h('div', { class: 'gen-status' });
  const code = h('textarea', { class: 'gen-code', spellcheck: false, readOnly: false }) as HTMLTextAreaElement;
  const result = h('div', { class: 'gen-result', hidden: true });
  const go = h('button', { class: 'm-btn primary' }, 'Создать') as HTMLButtonElement;
  const run = h('button', { class: 'm-btn' }, 'Запустить') as HTMLButtonElement;
  const save = h('button', { class: 'm-btn' }, 'Сохранить в мои плагины') as HTMLButtonElement;
  let history: Message[] = [];
  /** The answer to the previous turn's tool call goes at the start of the next message (roles alternate). */
  let pending: Message['content'] = [];
  let current: GeneratedPlugin | null = null;
  let abort: AbortController | null = null;

  const edited = (): GeneratedPlugin | null => (current ? { ...current, code: code.value } : null);
  const request = async () => {
    const text = ask.value.trim();
    if (!text || abort) return;
    const msg = current ? `Доработай плагин: ${text}\n\nТекущий код:\n${code.value}${current.ui ? `\n\nТекущее окно:\n${current.ui}` : ''}` : text;
    history = [...history, { role: 'user', content: [...pending, { type: 'text', text: msg }] }];
    abort = new AbortController();
    go.disabled = true;
    status.textContent = current ? 'Дорабатываю…' : 'Пишу плагин…';
    status.classList.remove('err');
    try {
      const { plugin, reply } = await generatePlugin(history, abort.signal);
      // Model turn; the result of its call goes into the next user message.
      const call = reply.content.find((b) => b.type === 'tool_use');
      history = [...history, reply];
      pending = call && call.type === 'tool_use' ? [{ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: 'Плагин показан пользователю и запущен' }] }] : [];
      current = plugin;
      code.value = plugin.code;
      result.hidden = false;
      status.textContent = `${plugin.name}: ${plugin.summary}${plugin.ui ? ' · с окном' : ''}`;
      go.textContent = 'Доработать';
      ask.value = '';
      ask.placeholder = 'Что изменить? Например: «добавь отступ 8 между рядами»';
      launch(d, bundleOf(plugin), '');
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
      status.classList.add('err');
      history = history.slice(0, -1);
    } finally {
      abort = null;
      go.disabled = false;
    }
  };
  go.addEventListener('click', () => void request());
  ask.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void request();
  });
  code.addEventListener('keydown', (e) => e.stopPropagation());
  run.addEventListener('click', () => {
    const p = edited();
    if (p) launch(d, bundleOf(p), '');
  });
  save.addEventListener('click', async () => {
    const p = edited();
    if (!p) return;
    await installBundle(d, bundleOf(p), 'local');
    m.close();
  });
  result.append(code, h('div', { class: 'm-row end' }, run, save));
  m.body.append(ask, status, result, h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => (abort?.abort(), m.close()) }, 'Закрыть'), go));
  setTimeout(() => ask.focus(), 0);
}
