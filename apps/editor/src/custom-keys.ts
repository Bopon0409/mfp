// Custom keyboard shortcuts (no equivalent): any menu command (the same as in Ctrl+K) can get its own shortcut;
// custom ones override built-in ones. Stored on this computer (localStorage). Window — “Custom keyboard shortcuts…”.

import type { Action } from './actions.ts';
import { h, modal } from './dom.ts';

const STORE = 'mfp-custom-keys';

/** Command → shortcut; the command key is “Section|Name” (as in the actions menu). */
export type Bindings = Record<string, string>;

export const actionKey = (a: Pick<Action, 'path' | 'label'>) => `${a.path}|${a.label}`;

let cache: Bindings | null = null;

export function loadBindings(): Bindings {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Bindings;
  } catch {
    cache = {};
  }
  return cache;
}

function saveBindings(b: Bindings) {
  cache = b;
  try {
    localStorage.setItem(STORE, JSON.stringify(b));
  } catch {
    // Storage unavailable — shortcuts live until reload.
  }
}

const NAMED: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
  Escape: 'Esc',
};

/** Shortcut from a keypress: “Ctrl+Shift+K” (letters and digits — by physical key); null — a lone modifier. */
export function comboOf(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : (NAMED[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key));
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+');
}

/** The command this keypress is assigned to (key “Section|Name”), or null. */
export function boundAction(e: KeyboardEvent): string | null {
  const b = loadBindings();
  if (!Object.keys(b).length) return null;
  const combo = comboOf(e);
  if (!combo) return null;
  return Object.keys(b).find((k) => b[k] === combo) ?? null;
}

/** Command hint: the custom shortcut, otherwise the built-in one. */
export const hintOf = (a: Action) => loadBindings()[actionKey(a)] ?? a.hint;

/** “Custom keyboard shortcuts” window: command search, “Assign” — press a shortcut; Backspace — remove. */
export async function openKeysDialog(actions: () => Promise<Action[]>) {
  const m = modal('Свои сочетания клавиш', { cls: 'keys-modal' });
  const list = await actions();
  const search = h('input', { class: 'm-input', placeholder: 'Найти команду…', 'aria-label': 'Найти команду' }) as HTMLInputElement;
  const rows = h('div', { class: 'keys-list' });
  const note = h('p', { class: 'm-note' }, 'Свои сочетания главнее встроенных и работают на этом компьютере. Esc — отменить ввод, Backspace — убрать сочетание.');
  let listening: { key: string; btn: HTMLElement } | null = null;
  const builtIn = new Map(list.filter((a) => a.hint).map((a) => [a.hint!, a]));

  const render = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const b = loadBindings();
    const shown = list.filter((a) => words.every((w) => `${a.label} ${a.path}`.toLowerCase().includes(w))).slice(0, 200);
    rows.replaceChildren(
      ...shown.map((a) => {
        const key = actionKey(a);
        const mine = b[key];
        const btn = h('button', { class: `keys-btn${mine ? ' set' : ''}`, title: mine ? 'Изменить сочетание' : 'Назначить сочетание' }, mine ?? 'Назначить');
        btn.addEventListener('click', () => {
          if (listening) listening.btn.textContent = loadBindings()[listening.key] ?? 'Назначить';
          listening = { key, btn };
          btn.textContent = 'Нажмите сочетание…';
          btn.classList.add('wait');
        });
        return h(
          'div',
          { class: 'keys-row' },
          h('span', { class: 'keys-name' }, a.label, a.path ? h('span', { class: 'keys-path' }, a.path) : ''),
          h('span', { class: 'keys-builtin', title: 'Встроенное сочетание' }, a.hint ?? ''),
          btn,
        );
      }),
    );
  };

  // Shortcut input: intercept keys while waiting.
  const onKey = (e: KeyboardEvent) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    const b = { ...loadBindings() };
    if (e.key === 'Escape') {
      listening = null;
      return render();
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      delete b[listening.key];
      saveBindings(b);
      listening = null;
      return render();
    }
    const combo = comboOf(e);
    if (!combo) return;
    // The shortcut already belongs to another custom command — it moves to this one.
    for (const k of Object.keys(b)) if (b[k] === combo) delete b[k];
    b[listening.key] = combo;
    saveBindings(b);
    const clash = builtIn.get(combo);
    note.textContent = clash && actionKey(clash) !== listening.key ? `«${combo}» теперь вместо встроенного: ${clash.label}.` : `Назначено: ${combo}.`;
    listening = null;
    render();
  };
  m.box.addEventListener('keydown', onKey, true);
  search.addEventListener('input', render);
  const reset = h('button', { class: 'm-btn', onclick: () => (saveBindings({}), render()) }, 'Сбросить все');
  m.body.append(search, rows, note, h('div', { class: 'm-row end' }, reset, h('button', { class: 'm-btn primary', onclick: () => m.close() }, 'Готово')));
  render();
  setTimeout(() => search.focus(), 0);
}
