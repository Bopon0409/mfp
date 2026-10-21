// Agent: a conversation with the model and tool calls on the document until the model answers
// with text (no more than 30 steps). All edits of one answer are one undo step. Layer snapshots from
// previous steps are replaced with a marker in requests (images are expensive and already seen by the model).

import type { Editor } from '../editor.ts';
import { complete, loadConfig, type Block, type Message } from './providers.ts';
import { editorTools, type Tool } from './tools.ts';

const SYSTEM = `Ты — ассистент в графическом редакторе MFP. Работаешь с документом через инструменты.
Документ — дерево слоёв: страницы, фреймы, группы, фигуры, тексты, компоненты и инстансы. Единицы — пиксели, ось y вниз; x, y слоя — относительно родителя.
Свойства — как в Plugin API Figma: цвета 0…1 ({ r, g, b }), прозрачность заливки — opacity у краски, шрифт — fontName { family, style } (например Inter, Regular / Bold).
Сначала посмотри (get_selection, get_tree, get_node), потом меняй. Пакетные правки — одним вызовом. После заметных правок проверь результат снимком (screenshot).
Новые экраны создавай справа от существующих, не поверх. Для своих компонентов используй list_components и create_tree с componentId.
Отвечай по-русски, коротко: что сделано и что стоит проверить.`;

export class Agent {
  private ed: Editor;
  messages: Message[] = [];
  running = false;
  error = '';
  private abort: AbortController | null = null;
  private tools: Tool[];
  onUpdate: (() => void) | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    this.tools = editorTools(ed);
  }

  reset() {
    if (this.running) this.stop();
    this.messages = [];
    this.error = '';
    this.onUpdate?.();
  }

  stop() {
    this.abort?.abort();
  }

  /** Canvas info for the model: page and selection. */
  private context(): string {
    const d = this.ed.doc;
    const sel = this.ed.selection.filter((id) => d.has(id));
    return `\nСейчас открыта страница «${d.get(this.ed.pageId, 'name') ?? ''}» (id ${this.ed.pageId}); выделено слоёв: ${sel.length}${sel.length ? ` (${sel.slice(0, 5).join(', ')}${sel.length > 5 ? '…' : ''})` : ''}.`;
  }

  /** History for the request: images only from the last message. */
  private request(): Message[] {
    const last = this.messages.length - 1;
    return this.messages.map((m, i) =>
      i === last
        ? m
        : {
            role: m.role,
            content: m.content.map((b) =>
              b.type === 'tool_result' && b.content.some((c) => c.type === 'image')
                ? { ...b, content: [...b.content.filter((c) => c.type !== 'image'), { type: 'text' as const, text: '[снимок слоя — показан раньше]' }] }
                : b,
            ),
          },
    );
  }

  async send(text: string) {
    if (this.running || !text.trim()) return;
    const config = loadConfig();
    this.running = true;
    this.error = '';
    this.abort = new AbortController();
    const signal = this.abort.signal;
    // The previous answer ended on tool results — text goes into the same message (roles alternate).
    const prev = this.messages[this.messages.length - 1];
    if (prev?.role === 'user') prev.content.push({ type: 'text', text });
    else this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    this.onUpdate?.();
    const doc = this.ed.doc;
    let grouped = false;
    try {
      for (let step = 0; step < 30; step++) {
        const reply = await complete(config, SYSTEM + this.context(), this.request(), this.tools, signal);
        this.messages.push({ role: 'assistant', content: reply.content.length ? reply.content : [{ type: 'text', text: '…' }] });
        this.onUpdate?.();
        const uses = reply.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
        if (!uses.length) break;
        const results: Block[] = [];
        for (const u of uses) {
          if (signal.aborted) throw new DOMException('Остановлено', 'AbortError');
          const tool = this.tools.find((t) => t.name === u.name);
          try {
            if (!tool) throw new Error(`Нет инструмента ${u.name}`);
            if (tool.edits && !grouped && doc === this.ed.doc) {
              doc.beginGroup();
              grouped = true;
            }
            results.push({ type: 'tool_result', tool_use_id: u.id, content: await tool.run(u.input ?? {}) });
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], is_error: true });
          }
        }
        this.messages.push({ role: 'user', content: results });
        this.onUpdate?.();
        if (reply.stop === 'length') break;
      }
    } catch (e) {
      this.error = signal.aborted ? 'Остановлено' : e instanceof Error ? e.message : String(e);
      // Calls without results — the model won't accept such a history: remove the unfinished turn.
      const last = this.messages[this.messages.length - 1];
      if (last?.role === 'assistant' && last.content.some((b) => b.type === 'tool_use')) this.messages.pop();
    } finally {
      if (grouped) doc.endGroup();
      this.running = false;
      this.abort = null;
      this.onUpdate?.();
    }
  }
}
