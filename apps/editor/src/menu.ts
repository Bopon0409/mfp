// Dropdown menus: main (with submenus), tools, zoom, plugins.
// A submenu opens on hover; clicking outside or Esc closes them all.
// Keyboard: arrows move between items, → and ← enter and leave a submenu, Enter selects, a first
// letter jumps to the item starting with it; a closed menu returns focus to where it was opened from.

import { ICON } from './icons.ts';

export interface MenuItem {
  label: string;
  hint?: string;
  /** SVG string from our own icons. */
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  run?: () => void;
  /** Hover preview: apply and return a revert (removed on leave, selection and close). */
  preview?: () => () => void;
  submenu?: MenuEntry[] | (() => MenuEntry[] | Promise<MenuEntry[]>);
  /** Input field instead of an item (e.g. custom zoom): Enter — submit, the menu closes. */
  field?: { value: string; placeholder?: string; submit: (value: string) => void };
}
export type MenuEntry = MenuItem | 'sep';

type Side = 'below' | 'above' | 'right' | 'at';

let open: { el: HTMLElement; anchor: HTMLElement | null }[] = [];
/** Invisible anchor point for the context menu. */
let pointAnchor: HTMLElement | null = null;
/** Where to return focus when the menu closes (from the keyboard or by choosing an item). */
let returnFocus: HTMLElement | null = null;
/** Last input was from the keyboard: then focus goes straight to the first item. */
let keyboardInput = false;
addEventListener('keydown', () => (keyboardInput = true), true);
addEventListener('pointerdown', () => (keyboardInput = false), true);

/** Input fields in the menu and their Enter action. */
const fields = new WeakMap<HTMLInputElement, (value: string) => void>();

/** Remove the preview of the item under the pointer. */
let stopPreview: (() => void) | null = null;

/** Close all menus; restore — return focus to where it was before the menu. */
export function closeMenus(restore = false) {
  stopPreview?.();
  for (const m of open) {
    m.el.remove();
    setOpen(m.anchor, false);
  }
  open = [];
  pointAnchor?.remove();
  pointAnchor = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  const back = returnFocus;
  returnFocus = null;
  if (restore && back?.isConnected) back.focus({ preventScroll: true });
}

function setOpen(anchor: HTMLElement | null, on: boolean) {
  anchor?.classList.toggle('open', on);
  if (anchor?.getAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', String(on));
}

/** Close submenus deeper than level. */
function closeFrom(level: number) {
  for (const m of open.splice(level)) {
    m.el.remove();
    setOpen(m.anchor, false);
  }
}

function onOutside(e: PointerEvent) {
  const t = e.target as Node;
  if (open.some((m) => m.el.contains(t) || m.anchor?.contains(t))) return;
  closeMenus();
}

/** Menu items available for selection. */
const itemsOf = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')];

/** Close the submenu, focus the item that opened it. */
function back(level: number) {
  const parent = open[level]?.anchor ?? null;
  closeFrom(level);
  parent?.focus({ preventScroll: true });
}

function onKey(e: KeyboardEvent) {
  const level = open.length - 1;
  const menu = open[level]?.el;
  if (!menu) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    e.preventDefault();
    if (level > 0) back(level);
    else closeMenus(true);
    return;
  }
  // Typing in a field next to the menu — the keys belong to it.
  const active = document.activeElement as HTMLElement | null;
  // Field inside the menu: Enter applies, ↓ goes to the items, everything else goes to the field.
  if (active instanceof HTMLInputElement && menu.contains(active)) {
    const submit = fields.get(active);
    if (e.key === 'Enter' && submit) {
      e.preventDefault();
      e.stopPropagation();
      const value = active.value;
      closeMenus(true);
      submit(value);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      itemsOf(menu)[0]?.focus({ preventScroll: true });
    } else e.stopPropagation();
    return;
  }
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !menu.contains(active)) return;
  const items = itemsOf(menu);
  const i = items.indexOf(active as HTMLButtonElement);
  const focus = (b: HTMLButtonElement | undefined) => b?.focus({ preventScroll: true });
  switch (e.key) {
    case 'ArrowDown':
      focus(items[(i + 1) % items.length]);
      break;
    case 'ArrowUp':
      focus(items[i <= 0 ? items.length - 1 : i - 1]);
      break;
    case 'Home':
      focus(items[0]);
      break;
    case 'End':
      focus(items[items.length - 1]);
      break;
    case 'ArrowRight':
      if (i >= 0 && items[i]!.getAttribute('aria-haspopup')) items[i]!.click();
      break;
    case 'ArrowLeft':
      if (level > 0) back(level);
      break;
    case 'Enter':
    case ' ':
      if (i >= 0) items[i]!.click();
      break;
    case 'Tab':
      closeMenus(true);
      break;
    default: {
      // A first letter moves to the next item starting with it; other keys don't reach the canvas while the menu is open.
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const ch = e.key.toLowerCase();
      const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
      focus(order.find((b) => b.querySelector('.lbl')?.textContent?.trim().toLowerCase().startsWith(ch)));
    }
  }
  e.preventDefault();
  e.stopPropagation();
}

/** Start the menu session: close previous ones, remember focus, listen for outside clicks and keys. */
function begin() {
  // One menu replaced by another — focus returns to where it was before the first one.
  const keep = open.length ? returnFocus : null;
  closeMenus();
  returnFocus = keep ?? (document.activeElement as HTMLElement | null);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}

/** Show a menu at an element. Clicking the same element again closes it. */
export function showMenu(anchor: HTMLElement, items: MenuEntry[], side: Side = 'below'): void {
  if (open[0]?.anchor === anchor) {
    closeMenus(true);
    return;
  }
  begin();
  place(anchor, items, side, 0);
}

/** Show a menu at a point in the window (right-click context menu). */
export function showMenuAt(x: number, y: number, items: MenuEntry[]): void {
  begin();
  const anchor = document.createElement('div');
  anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;pointer-events:none`;
  document.body.append(anchor);
  pointAnchor = anchor;
  place(anchor, items, 'at', 0);
}

function place(anchor: HTMLElement, items: MenuEntry[], side: Side, level: number) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  const label = anchor.getAttribute('aria-label') ?? anchor.getAttribute('title') ?? anchor.querySelector('.lbl')?.textContent;
  if (label) menu.setAttribute('aria-label', label);
  for (const it of items) {
    if (it === 'sep') {
      const hr = document.createElement('hr');
      hr.setAttribute('role', 'separator');
      menu.append(hr);
      continue;
    }
    if (it.field) {
      const input = document.createElement('input');
      input.className = 'menu-field';
      input.value = it.field.value;
      input.placeholder = it.field.placeholder ?? '';
      input.setAttribute('aria-label', it.label);
      input.spellcheck = false;
      fields.set(input, it.field.submit);
      menu.append(input);
      requestAnimationFrame(() => {
        input.focus({ preventScroll: true });
        input.select();
      });
      continue;
    }
    const b = document.createElement('button');
    b.disabled = !!it.disabled;
    b.tabIndex = -1;
    b.setAttribute('role', it.checked !== undefined && !it.submenu ? 'menuitemcheckbox' : 'menuitem');
    if (it.checked !== undefined && !it.submenu) b.setAttribute('aria-checked', String(!!it.checked));
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = it.checked ? ICON.check : it.icon ?? '';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = it.label;
    const hint = document.createElement('span');
    hint.className = 'hint';
    if (it.submenu) {
      hint.innerHTML = ICON.chevronRight;
      hint.setAttribute('aria-hidden', 'true');
    } else hint.textContent = it.hint ?? '';
    if (it.hint && !it.submenu) b.setAttribute('aria-keyshortcuts', it.hint.replace(/Ctrl/g, 'Control'));
    b.append(mark, lbl, hint);
    // Hover also moves focus (if the menu has focus): the keyboard continues from this item.
    const follow = () => {
      if (menu.contains(document.activeElement) || document.activeElement === menu) b.focus({ preventScroll: true });
    };
    if (it.submenu) {
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      const openSub = async () => {
        if (b.classList.contains('open')) return;
        closeFrom(level + 1);
        const sub = typeof it.submenu === 'function' ? await it.submenu() : it.submenu!;
        if (!menu.isConnected) return;
        const el = place(b, sub, 'right', level + 1);
        if (keyboardInput) itemsOf(el)[0]?.focus({ preventScroll: true });
      };
      b.addEventListener('pointerenter', () => {
        follow();
        void openSub();
      });
      b.addEventListener('click', () => void openSub());
    } else {
      // Preview: while the pointer is over an item, its action is visible on the canvas.
      let undo: (() => void) | null = null;
      const stop = () => {
        undo?.();
        undo = null;
        if (stopPreview === stop) stopPreview = null;
      };
      b.addEventListener('pointerenter', () => {
        follow();
        closeFrom(level + 1);
        if (it.preview && !it.disabled) {
          stopPreview?.();
          undo = it.preview();
          stopPreview = stop;
        }
      });
      b.addEventListener('pointerleave', stop);
      b.addEventListener('click', () => {
        stop();
        closeMenus(true);
        it.run?.();
      });
    }
    menu.append(b);
  }
  document.body.append(menu);
  setOpen(anchor, true);
  open[level] = { el: menu, anchor };
  // Position: below the element, above it (toolbar at the bottom) or to the right (submenu).
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let x = side === 'right' ? r.right + 4 : side === 'at' ? r.left + 2 : r.left;
  let y = side === 'below' ? r.bottom + 6 : side === 'above' ? r.top - h - 8 : side === 'at' ? r.top + 2 : r.top - 6;
  if (side === 'right' && x + w > innerWidth - 8) x = r.left - w - 4;
  // Context menu near the window edge — opens to the other side of the cursor.
  if (side === 'at' && x + w > innerWidth - 8) x = r.left - w - 2;
  if (side === 'at' && y + h > innerHeight - 8) y = r.top - h - 2;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  y = Math.max(8, Math.min(y, innerHeight - h - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  // The top-level menu gets focus: from the keyboard — the first item, with the mouse — the menu itself
  // (arrows start from the top). If the user was typing in a field, leave focus alone (the field
  // would apply the edit prematurely).
  if (level === 0) {
    const a = document.activeElement;
    const typing = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement;
    if (keyboardInput) (itemsOf(menu)[0] ?? menu).focus({ preventScroll: true });
    else if (!typing) menu.focus({ preventScroll: true });
  }
  return menu;
}
