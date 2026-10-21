// Comments in prototype presentation: the “Comments” button (C) shows thread badges for this
// screen; clicking the screen starts a new thread at that point, clicking a badge opens the thread
// with replies. The comments themselves live in the editor (its source: document or server); they
// come here through the presentation channel.

import type { Player } from './player.ts';
import type { PlayerThread, ToEditor, ToPlayer } from './protocol.ts';

const PIN = 26;
const CSS = `
  .pc-layer { position: fixed; left: 0; top: 0; width: 100%; height: calc(100% - 44px); pointer-events: none; z-index: 2; overflow: hidden; }
  body.full .pc-layer, body.embed .pc-layer { height: 100%; }
  .pc-layer.on { pointer-events: auto; cursor: crosshair; }
  .pc-pin { position: absolute; left: 0; top: 0; width: ${PIN}px; height: ${PIN}px; padding: 0; border: 2px solid #fff; border-radius: 50%; background: var(--c, var(--accent, #4d7bfd)); color: #fff; font: 600 11px/22px Inter, system-ui, sans-serif; text-align: center; cursor: pointer; box-shadow: 0 2px 6px #0007; pointer-events: auto; }
  .pc-pin::after { content: ''; position: absolute; left: 50%; bottom: -8px; transform: translateX(-50%); border: 5px solid transparent; border-top: 6px solid #fff; border-bottom: 0; }
  .pc-pin.on { box-shadow: 0 0 0 2px var(--accent, #4d7bfd), 0 2px 8px #0009; }
  .pc-box { position: absolute; left: 0; top: 0; width: 280px; max-height: 60vh; display: flex; flex-direction: column; background: var(--panel, #22242a); border-radius: 10px; box-shadow: 0 8px 28px #000a, 0 0 0 1px #0008; color: var(--text, #eceef2); cursor: default; pointer-events: auto; }
  .pc-list { overflow: auto; padding: 4px 0; }
  .pc-item { padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
  .pc-item + .pc-item { border-top: 1px solid var(--line, #2f3238); }
  .pc-head { display: flex; align-items: center; gap: 8px; }
  .pc-av { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; flex: none; }
  .pc-name { font-weight: 600; }
  .pc-time { color: var(--muted, #9c9ea4); margin-left: auto; font-size: 11px; }
  .pc-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .pc-form { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 10px; border-top: 1px solid var(--line, #2f3238); }
  .pc-box.draft .pc-form { border-top: none; }
  .pc-form textarea { width: 100%; box-sizing: border-box; resize: none; min-height: 34px; border: 1px solid var(--border, #3d4046); border-radius: 6px; background: var(--menu, #1d1f25); color: var(--text, #eceef2); padding: 6px 8px; font: 12px/18px Inter, system-ui, sans-serif; outline: none; }
  .pc-form textarea:focus { border-color: var(--accent, #4d7bfd); }
  .pc-acts { display: flex; justify-content: flex-end; gap: 6px; }
  .pc-acts button { height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--border, #3d4046); background: none; color: var(--text, #eceef2); cursor: pointer; font: inherit; }
  .pc-acts button.primary { background: var(--accent, #4d7bfd); border-color: var(--accent, #4d7bfd); font-weight: 600; }
  .pc-acts button:disabled { opacity: .45; cursor: default; }
  .pc-note { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); background: var(--menu, #1d1f25); color: #fff; padding: 6px 12px; border-radius: 8px; box-shadow: 0 0 0 1px #00000080, 0 6px 20px #00000080; z-index: 3; }
`;

const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();
const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'только что' : s < 3600 ? `${Math.floor(s / 60)} мин` : s < 86400 ? `${Math.floor(s / 3600)} ч` : new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

export class PlayerComments {
  private send: (m: ToEditor) => void;
  private me: string;
  private player: () => Player | null;
  private layer: HTMLElement;
  private button: HTMLButtonElement;
  private on = false;
  private screen: string | null = null;
  private threads: PlayerThread[] = [];
  private canWrite = false;
  private pins = new Map<string, HTMLButtonElement>();
  /** Open popup: a thread (id) or a new one (id null — at point at). */
  private box: { id: string | null; at: [number, number]; el: HTMLElement } | null = null;
  private raf = 0;
  /** New thread sent: the editor's response closes the popup (or shows an error). */
  private sending = false;

  constructor(send: (m: ToEditor) => void, me: string, player: () => Player | null, button: HTMLButtonElement) {
    this.send = send;
    this.me = me;
    this.player = player;
    this.button = button;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.layer = el('div', 'pc-layer');
    document.body.append(this.layer);
    // Clicking the screen in comment mode starts a new thread (the popup and badges handle their own clicks).
    this.layer.addEventListener('pointerdown', (e) => {
      if (e.target !== this.layer || e.button !== 0) return;
      e.preventDefault();
      if (this.box) {
        this.close();
        return;
      }
      if (!this.canWrite) {
        this.note('Комментировать этот файл нельзя');
        return;
      }
      const r = this.layer.getBoundingClientRect();
      const at = this.player()?.fromCanvas(e.clientX - r.left, e.clientY - r.top);
      if (at) this.compose(at);
    });
  }

  get active() {
    return this.on;
  }

  toggle() {
    this.on = !this.on;
    this.layer.classList.toggle('on', this.on);
    this.button.classList.toggle('on', this.on);
    if (this.on) {
      this.request();
      const loop = () => {
        if (!this.on) return;
        this.place();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(this.raf);
      this.close();
      this.render();
    }
  }

  /** The screen changed. */
  setScreen(screen: string | null) {
    if (screen === this.screen) return;
    this.screen = screen;
    this.close();
    this.threads = [];
    this.render();
    if (this.on) this.request();
  }

  /** Comments in the editor changed. */
  changed() {
    if (this.on) this.request();
  }

  receive(m: Extract<ToPlayer, { type: 'comments' }>) {
    if (m.screen !== this.screen) return;
    this.threads = m.threads;
    this.canWrite = m.canWrite;
    if (m.error) this.note(m.error);
    if (this.sending && !this.box?.id) {
      this.sending = false;
      if (!m.error) this.close();
    }
    this.render();
    // The open thread — with new replies (a new one is already sent: close it).
    if (this.box?.id) {
      const t = this.threads.find((x) => x.id === this.box!.id);
      if (t) this.showThread(t);
      else this.close();
    }
  }

  private request() {
    if (this.screen) this.send({ type: 'comments', from: this.me, screen: this.screen });
  }

  private note(text: string) {
    const n = el('div', 'pc-note', text);
    document.body.append(n);
    setTimeout(() => n.remove(), 3000);
  }

  private render() {
    const want = new Set(this.on ? this.threads.map((t) => t.id) : []);
    for (const [id, pin] of this.pins) {
      if (want.has(id)) continue;
      pin.remove();
      this.pins.delete(id);
    }
    if (!this.on) return;
    for (const t of this.threads) {
      let pin = this.pins.get(t.id);
      if (!pin) {
        pin = el('button', 'pc-pin');
        pin.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = this.threads.find((x) => x.id === t.id);
          if (this.box?.id === t.id) this.close();
          else if (cur) this.showThread(cur);
        });
        this.layer.append(pin);
        this.pins.set(t.id, pin);
      }
      pin.textContent = initial(t.author.name);
      pin.style.setProperty('--c', t.author.color);
      pin.title = `${t.author.name}: ${t.text.slice(0, 80)}${t.replies.length ? ` (ответов: ${t.replies.length})` : ''}`;
      pin.classList.toggle('on', this.box?.id === t.id);
    }
    this.place();
  }

  /** Badges and popup follow the screen (scroll, zoom). */
  private place() {
    const p = this.player();
    if (!p) return;
    for (const t of this.threads) {
      const pin = this.pins.get(t.id);
      if (!pin) continue;
      const [x, y] = p.toCanvas(t.at[0], t.at[1]);
      pin.style.transform = `translate(${Math.round(x - PIN / 2)}px, ${Math.round(y - PIN - 6)}px)`;
    }
    if (this.box) {
      const [x, y] = p.toCanvas(this.box.at[0], this.box.at[1]);
      const W = this.layer.clientWidth;
      const H = this.layer.clientHeight;
      const w = this.box.el.offsetWidth;
      const h = this.box.el.offsetHeight;
      let left = x + PIN / 2 + 8;
      if (left + w > W - 8) left = Math.max(8, x - PIN / 2 - 8 - w);
      const top = Math.max(8, Math.min(y - PIN - 6, H - h - 8));
      this.box.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }
  }

  private close() {
    this.box?.el.remove();
    this.box = null;
    for (const pin of this.pins.values()) pin.classList.remove('on');
  }

  /** Input field: Enter — send, Shift+Enter — new line, Esc — close. */
  private form(placeholder: string, submit: (text: string) => void): HTMLElement {
    const text = el('textarea', '');
    text.placeholder = placeholder;
    text.rows = 1;
    const send = el('button', 'primary', 'Отправить');
    send.disabled = true;
    const go = () => {
      const v = text.value.trim();
      if (!v) return;
      text.value = '';
      send.disabled = true;
      submit(v);
    };
    text.addEventListener('input', () => (send.disabled = !text.value.trim()));
    text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        go();
      } else if (e.key === 'Escape') this.close();
    });
    send.addEventListener('click', go);
    const cancel = el('button', '', 'Отмена');
    cancel.addEventListener('click', () => this.close());
    setTimeout(() => text.focus());
    return el('div', 'pc-form', text, el('div', 'pc-acts', cancel, send));
  }

  private compose(at: [number, number]) {
    this.close();
    const screen = this.screen;
    if (!screen) return;
    const box = el(
      'div',
      'pc-box draft',
      this.form('Комментарий к этому экрану', (text) => {
        this.sending = true;
        this.send({ type: 'comment', from: this.me, screen, at, thread: null, text });
      }),
    );
    this.layer.append(box);
    this.box = { id: null, at, el: box };
    this.place();
  }

  private showThread(t: PlayerThread) {
    const keep = this.box?.id === t.id ? this.box.el.querySelector('textarea')?.value : undefined;
    this.box?.el.remove();
    const item = (a: { name: string; color: string }, text: string, created: number) => {
      const av = el('span', 'pc-av', initial(a.name));
      av.style.background = a.color;
      return el('div', 'pc-item', el('div', 'pc-head', av, el('span', 'pc-name', a.name), el('span', 'pc-time', ago(created))), el('div', 'pc-text', text));
    };
    const screen = this.screen!;
    const box = el(
      'div',
      'pc-box',
      el('div', 'pc-list', item(t.author, t.text, t.created), ...t.replies.map((r) => item(r.author, r.text, r.created))),
      this.canWrite ? this.form('Ответить…', (text) => this.send({ type: 'comment', from: this.me, screen, at: null, thread: t.id, text })) : null,
    );
    if (keep) {
      const ta = box.querySelector('textarea');
      if (ta) ta.value = keep;
    }
    this.layer.append(box);
    this.box = { id: t.id, at: t.at, el: box };
    for (const [id, pin] of this.pins) pin.classList.toggle('on', id === t.id);
    this.place();
  }
}
