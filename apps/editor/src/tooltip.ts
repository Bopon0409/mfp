// Tooltips: a dark plate with a name and a keyboard shortcut (dimmed) instead of the
// native title. Delegated over the whole document: title moves to data-tip (and to
// aria-label if there is no label — for screen readers), the plate appears after half a second; between adjacent
// buttons — immediately. The shortcut is taken from the parentheses at the end of the title: “Pen (P)”, “Scale (Ctrl+…)”.

const DELAY = 500;
const SWAP = 300;
const MOD = /^(?:Ctrl|Shift|Alt|Cmd)\+/;
const SINGLE = /^(?:(?:Ctrl|Shift|Alt|Cmd)\+)*(?:[A-Za-zА-Яа-яЁё0-9]|F\d{1,2}|Esc|Enter|Delete|Backspace|Tab|Space|Пробел|[[\]\\/,.;'=+−-]|←|→|↑|↓)$/;

let tip: HTMLElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;
let hiddenAt = 0;

/** Name and shortcut from “Name (Shortcut)”. */
export function splitTip(text: string): { label: string; keys: string } {
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(text);
  const keys = m?.[2]?.trim() ?? '';
  if (m && keys.length <= 24 && (SINGLE.test(keys) || MOD.test(keys))) return { label: m[1]!, keys };
  return { label: text, keys: '' };
}

function target(e: Event): HTMLElement | null {
  const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title], [data-tip]');
  if (!el || el.closest('.menu, .tip')) return null;
  // Input fields and dropdowns — no tooltips of their own (they get in the way of typing and opening the list).
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return null;
  const title = el.getAttribute('title');
  if (title) {
    el.dataset.tip = title;
    if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
    el.removeAttribute('title');
  }
  return el.dataset.tip ? el : null;
}

function show(el: HTMLElement) {
  const { label, keys } = splitTip(el.dataset.tip ?? '');
  if (!label) return;
  tip ??= Object.assign(document.createElement('div'), { className: 'tip', role: 'tooltip' });
  tip.replaceChildren(Object.assign(document.createElement('span'), { textContent: label }), ...(keys ? [Object.assign(document.createElement('kbd'), { textContent: keys })] : []));
  document.body.append(tip);
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  // For the bottom toolbar — above the button, otherwise — below it (or above if there is no room below).
  const above = !!el.closest('#toolbar, #vector-bar, .help-btn') || r.bottom + 8 + h > innerHeight - 4;
  const x = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2));
  tip.style.left = `${x}px`;
  tip.style.top = `${above ? r.top - h - 8 : r.bottom + 8}px`;
}

function hide() {
  clearTimeout(timer);
  if (tip?.isConnected) {
    tip.remove();
    hiddenAt = performance.now();
  }
  current = null;
}

export function installTooltips() {
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    const el = target(e);
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    const wait = performance.now() - hiddenAt < SWAP ? 0 : DELAY;
    timer = window.setTimeout(() => current === el && el.isConnected && show(el), wait);
  });
  document.addEventListener('pointerout', (e) => {
    if (current && !current.contains((e as PointerEvent).relatedTarget as Node | null)) hide();
  });
  for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll'] as const) document.addEventListener(type, () => current && hide(), true);
}
