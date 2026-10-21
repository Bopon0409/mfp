// Cursor chat: “/” — a field at your own cursor; others see what you type right away
// (in presence, collab.ts). Enter — the message stays for another 4 s, Esc — remove. The field follows
// the cursor.

import type { Collab } from './collab.ts';
import type { Editor } from './editor.ts';

export class CursorChat {
  private ed: Editor;
  private collab: Collab;
  private stage: HTMLElement;
  private box: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Cursor (window CSS px); on the canvas — minus its corner (computed only while the field is open). */
  private client: [number, number] | null = null;

  constructor(ed: Editor, collab: Collab, stage: HTMLElement) {
    this.ed = ed;
    this.collab = collab;
    this.stage = stage;
    ed.canvasEl.addEventListener('pointermove', (e) => {
      // Coordinates only: getBoundingClientRect on every move is an extra layout
      // (after panel edits), and it is only needed while the field is open.
      this.client = [e.clientX, e.clientY];
      if (this.box) this.place();
    });
  }

  get open() {
    return !!this.box;
  }

  start() {
    if (this.input) {
      this.input.focus();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const input = document.createElement('input');
    input.className = 'chat-input';
    input.placeholder = 'Сообщение — видно у курсора';
    input.maxLength = 160;
    input.setAttribute('aria-label', 'Чат у курсора');
    const box = document.createElement('div');
    box.className = 'chat-box';
    box.style.setProperty('--c', this.collab.me.color);
    box.append(input);
    input.addEventListener('input', () => this.collab.setChat(input.value));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.finish(false);
      }
    });
    input.addEventListener('blur', () => this.finish(true));
    this.stage.append(box);
    this.box = box;
    this.input = input;
    this.place();
    input.focus();
  }

  private finish(keep: boolean) {
    if (!this.box || !this.input) return;
    const text = this.input.value.trim();
    const box = this.box;
    this.box = null;
    this.input = null;
    box.remove();
    this.ed.canvasEl.focus();
    if (keep && text) this.timer = setTimeout(() => this.collab.setChat(null), 4000);
    else this.collab.setChat(null);
  }

  private place() {
    if (!this.box) return;
    const r = this.ed.canvasEl.getBoundingClientRect();
    const [x, y] = this.client ? [this.client[0] - r.left, this.client[1] - r.top] : [40, 40];
    this.box.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 16)}px)`;
  }
}
