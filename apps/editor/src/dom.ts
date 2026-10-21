// Small DOM helpers for panels: an element with attributes and children, an icon button,
// a popup at an anchor (closed by clicking outside and Esc).

import { ICON, type IconName } from './icons.ts';
import { draggableWindow } from './draggable-window.ts';

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | undefined | false)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'class') el.className = String(v);
    // list and form on inputs — only as attributes (the property is read-only: assignment throws).
    else if (k === 'style' || k === 'role' || k === 'list' || k === 'form' || k.startsWith('data-') || k.startsWith('aria-')) el.setAttribute(k, String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
};

/** Element with an SVG icon from our own set (or text). */
export const svgEl = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown>, content: string) => {
  const el = h(tag, props);
  if (content.startsWith('<svg')) el.innerHTML = content;
  else el.textContent = content;
  return el;
};

/** Icon button (as in section headers). */
export const iconBtn = (icon: IconName, title: string, run: (e: MouseEvent) => void, cls = 'icon-btn') =>
  svgEl('button', { class: cls, title, onclick: (e: MouseEvent) => run(e) }, ICON[icon]) as HTMLButtonElement;

/** An input that doesn't pass keys to the canvas; Enter — apply, Esc — cancel. */
export function textInput(value: string, commit: (v: string) => void, opts: { placeholder?: string; cls?: string; multiline?: boolean } = {}): HTMLInputElement | HTMLTextAreaElement {
  const el = (opts.multiline ? h('textarea', { value, placeholder: opts.placeholder ?? '', class: opts.cls ?? '' }) : h('input', { value, placeholder: opts.placeholder ?? '', class: opts.cls ?? '' })) as HTMLInputElement | HTMLTextAreaElement;
  el.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    ke.stopPropagation();
    if (ke.key === 'Enter' && !(opts.multiline && ke.shiftKey)) {
      ke.preventDefault();
      el.blur();
    }
    if (ke.key === 'Escape') {
      el.value = value;
      el.blur();
    }
  });
  el.addEventListener('change', () => {
    if (el.value !== value) commit(el.value);
  });
  return el;
}

let openPopover: { close(): void; anchor: HTMLElement; box: HTMLElement } | null = null;

/** Close the open popup. */
export function closePopover() {
  openPopover?.close();
}

/**
 * Popup at an anchor: below it (or above if it doesn't fit). Clicking outside, Esc and
 * clicking the anchor again close it. Returns the popup and the close function.
 */
export function popover(anchor: HTMLElement, cls: string, opts: { width?: number; onClose?: () => void; side?: 'left' | 'below'; leftOf?: HTMLElement | null } = {}): { box: HTMLElement; close: () => void } {
  if (openPopover?.anchor === anchor) {
    openPopover.close();
    return { box: h('div'), close: () => {} };
  }
  openPopover?.close();
  const box = h('div', { class: `popover ${cls}` });
  if (opts.width) box.style.width = `${opts.width}px`;
  document.body.append(box);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth;
    const hgt = box.offsetHeight;
    if (opts.side === 'left') {
      // leftOf — position to the left of this element (e.g. the whole right panel), not of the button.
      const x = opts.leftOf?.getBoundingClientRect().left ?? r.left;
      box.style.left = `${Math.max(8, x - w - 8)}px`;
      box.style.top = `${Math.max(8, Math.min(r.top, innerHeight - hgt - 8))}px`;
    } else {
      box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
      box.style.top = `${r.bottom + 4 + hgt > innerHeight - 8 ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
    }
  };
  requestAnimationFrame(place);
  const onDown = (e: PointerEvent) => {
    // The paint window and menus opened from this popup are part of it (clicks in them don't close it).
    if ((e.target as Element).closest?.('.paint-editor, .menu')) return;
    if (!box.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  anchor.classList.add('open');
  const close = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    anchor.classList.remove('open');
    box.remove();
    if (openPopover?.box === box) openPopover = null;
    opts.onClose?.();
  };
  const handle = { close, anchor, box };
  openPopover = handle;
  // Re-layout once the content is in place.
  setTimeout(place, 0);
  return { box, close };
}

/** Search field for lists in popups (arrows and Enter are handled by the caller). */
export function searchInput(placeholder: string, onInput: (q: string) => void): HTMLInputElement {
  const input = h('input', { class: 'pop-search', placeholder }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('input', () => onInput(input.value.trim().toLowerCase()));
  return input;
}

/**
 * Modal over everything with a backdrop (sign-in, file access, team): title and close button; Esc and
 * clicking the backdrop close it. Keys inside don't reach the canvas; focus is restored afterwards.
 */
export function modal(title: string, opts: { cls?: string; onClose?: () => void } = {}): { box: HTMLElement; body: HTMLElement; close: () => void; setTitle: (t: string) => void } {
  let stopDrag = () => {};
  const prev = document.activeElement as HTMLElement | null;
  const back = h('div', { class: 'modal-back' });
  const head = h('div', { class: 'modal-title' }, title);
  const body = h('div', { class: 'modal-body' });
  const close = () => {
    if (!back.isConnected) return;
    stopDrag();
    back.remove();
    prev?.focus?.();
    opts.onClose?.();
  };
  const box = h('div', { class: `modal ${opts.cls ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div', { class: 'modal-head' }, head, iconBtn('close', 'Закрыть (Esc)', () => close())), body);
  back.append(box);
  back.addEventListener('pointerdown', (e) => e.target === back && close());
  back.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  document.body.append(back);
  stopDrag = draggableWindow(box, box.querySelector<HTMLElement>('.modal-head')!);
  return {
    box,
    body,
    close,
    setTitle: (t) => {
      head.textContent = t;
      box.setAttribute('aria-label', t);
    },
  };
}

/** Circle with the first letter of the name in the person's color. */
export function avatar(name: string, color: string, cls = 'avatar'): HTMLElement {
  return h('span', { class: cls, style: `background:${color}`, title: name, 'aria-hidden': 'true' }, (name.trim()[0] ?? '?').toUpperCase());
}

/** Replace the element's contents (empty — null, false — are skipped). */
export function fill(el: HTMLElement, ...children: (Node | string | null | undefined | false)[]) {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}
