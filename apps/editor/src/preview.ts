// Prototype preview over the canvas (Shift+Space): a floating window with the presentation in an
// iframe (its own CanvasKit copy — it doesn't interfere with the editor canvas). Drag it by the
// title bar, resize by the corner; “↗” opens the presentation in a tab.

import type { Editor } from './editor.ts';
import { ICON } from './icons.ts';
import { playerUrl, present } from './present.ts';

let win: HTMLDivElement | null = null;

export function togglePreview(ed: Editor, name: () => string) {
  if (win) {
    closePreview();
    return;
  }
  const doc = ed.doc;
  const stage = document.getElementById('stage')!;
  win = document.createElement('div');
  win.className = 'preview-win';
  const head = document.createElement('div');
  head.className = 'preview-head';
  const title = document.createElement('span');
  title.className = 'preview-title';
  const sel = ed.selection.find((id) => doc.has(id));
  title.textContent = `Предпросмотр${sel ? ` — ${doc.get(sel, 'name') ?? ''}` : ''}`;
  const button = (html: string, hint: string, run: () => void) => {
    const b = document.createElement('button');
    b.innerHTML = html;
    b.title = hint;
    b.addEventListener('click', run);
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return b;
  };
  const frame = document.createElement('iframe');
  frame.src = playerUrl(ed, name, { embed: true });
  frame.allow = 'fullscreen';
  head.append(
    title,
    button('↺', 'Сначала', () => (frame.src = playerUrl(ed, name, { embed: true }))),
    button('↗', 'Открыть показ во вкладке (Ctrl+Alt+Enter)', () => {
      closePreview();
      present(ed, name);
    }),
    button(ICON.close, 'Закрыть (Shift+Space)', closePreview),
  );
  win.append(head, frame);
  stage.append(win);
  // Dragging by the title bar (within the canvas).
  head.addEventListener('pointerdown', (e) => {
    if (!win) return;
    const w = win;
    const r = w.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    frame.style.pointerEvents = 'none';
    const move = (ev: PointerEvent) => {
      w.style.left = `${Math.min(Math.max(0, ev.clientX - dx - s.left), s.width - 80)}px`;
      w.style.top = `${Math.min(Math.max(0, ev.clientY - dy - s.top), s.height - 32)}px`;
      w.style.right = 'auto';
    };
    const up = () => {
      frame.style.pointerEvents = '';
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  frame.addEventListener('load', () => frame.focus());
}

/**
 * Full-page presentation (the “on phone” link: #file=…&present=1): presentation in an iframe over
 * the editor; “×” returns to the file.
 */
export function presentInPage(ed: Editor, name: () => string, opts: { start?: string | null; device?: boolean } = {}) {
  document.querySelector('.present-page')?.remove();
  const page = document.createElement('div');
  page.className = 'present-page';
  const frame = document.createElement('iframe');
  // On a phone a device frame is pointless: the screen is the device.
  frame.src = `${playerUrl(ed, name, { embed: true, start: opts.start })}${opts.device ? '' : '&frame=0'}`;
  frame.allow = 'fullscreen';
  const close = document.createElement('button');
  close.className = 'present-close';
  close.innerHTML = ICON.close;
  close.title = 'Закрыть показ';
  close.addEventListener('click', () => page.remove());
  page.append(frame, close);
  document.body.append(page);
  frame.addEventListener('load', () => frame.focus());
}

export function closePreview() {
  win?.remove();
  win = null;
  document.getElementById('canvas')?.focus();
}
