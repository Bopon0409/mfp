// Actions menu (Ctrl+K or Ctrl+/): search across all main menu commands,
// plugins and page layers. Arrows — select, Enter — run, Esc — close.

import type { MenuEntry } from './menu.ts';

export interface Action {
  label: string;
  /** Menu section (“Object › Group”) or the kind of the found item. */
  path: string;
  hint?: string;
  run: () => void;
}

/** Commands from the menu: submenus are expanded (including lazily loaded ones), disabled ones are skipped. */
export async function actionsFromMenu(entries: MenuEntry[], path = ''): Promise<Action[]> {
  const out: Action[] = [];
  for (const e of entries) {
    if (e === 'sep' || e.disabled) continue;
    if (e.submenu) {
      const sub = typeof e.submenu === 'function' ? await e.submenu() : e.submenu;
      out.push(...(await actionsFromMenu(sub, path ? `${path} › ${e.label}` : e.label)));
    } else if (e.run) out.push({ label: e.label.replace(/…$/, ''), path, hint: e.hint, run: e.run });
  }
  return out;
}

const RECENT_KEY = 'mfp-recent-actions';
function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function remember(a: Action) {
  try {
    const key = `${a.path}|${a.label}`;
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...recent().filter((k) => k !== key)].slice(0, 8)));
  } catch {
    // Storage unavailable — no history.
  }
}

/** How well a string matches the query: all query words must be found; higher — a match at the start. */
function score(a: Action, words: string[]): number {
  const label = a.label.toLowerCase();
  const all = `${label} ${a.path.toLowerCase()}`;
  let s = 0;
  for (const w of words) {
    const i = all.indexOf(w);
    if (i < 0) return -1;
    s += label.startsWith(w) ? 30 : label.includes(` ${w}`) ? 20 : label.includes(w) ? 10 : 2;
  }
  return s;
}

let box: HTMLElement | null = null;
/** Close the open window in its own way (parameter input — with plugin cancellation). */
let boxClose: (() => void) | null = null;

export function closeActions() {
  const close = boxClose;
  boxClose = null;
  if (close) return close();
  box?.remove();
  box = null;
}

export type ActionsTab = 'all' | 'assets' | 'plugins';
const TABS: [ActionsTab, string][] = [
  ['all', 'Все'],
  ['assets', 'Ассеты'],
  ['plugins', 'Плагины и виджеты'],
];
const PLACEHOLDER: Record<ActionsTab, string> = { all: 'Поиск команд, плагинов и слоёв', assets: 'Поиск компонентов', plugins: 'Поиск плагинов и виджетов' };

export interface ActionsSources {
  /** Components of the file and libraries matching the query (empty — all). */
  assets?: (query: string) => Action[];
  /** Plugins and widgets (collected when the tab opens). */
  plugins?: () => Promise<Action[]>;
  /** Which tab to open on (Shift+I — “Assets”). */
  tab?: ActionsTab;
}

/**
 * Open the actions menu. commands — commands (collected on open), layers — layer search by
 * name (called for every query, no more than limit results).
 */
export async function openActions(commands: () => Promise<Action[]>, layers: (query: string, limit: number) => Action[], sources: ActionsSources = {}) {
  if (box) return closeActions();
  const list = await commands();
  let tab: ActionsTab = sources.tab ?? 'all';
  let plugins: Action[] | null = null;
  const root = document.createElement('div');
  root.id = 'actions';
  root.innerHTML = '<div class="act-card"><input spellcheck="false" /><div class="act-tabs" role="tablist"></div><div class="act-list"></div><div class="act-foot">↑↓ — выбор · Enter — выполнить · Ctrl+← → — вкладки · Esc — закрыть</div></div>';
  document.body.append(root);
  box = root;
  const input = root.querySelector('input')!;
  const listEl = root.querySelector('.act-list') as HTMLElement;
  const tabsEl = root.querySelector('.act-tabs') as HTMLElement;
  const tabs = TABS.filter(([t]) => t === 'all' || (t === 'assets' ? !!sources.assets : !!sources.plugins));
  const setTab = (t: ActionsTab) => {
    tab = t;
    input.placeholder = PLACEHOLDER[t];
    active = 0;
    if (t === 'plugins' && !plugins && sources.plugins) {
      void sources.plugins().then((p) => {
        plugins = p;
        if (tab === 'plugins') render();
      });
    }
    tabsEl.replaceChildren(
      ...tabs.map(([id, name]) => {
        const b = document.createElement('button');
        b.textContent = name;
        b.className = id === tab ? 'on' : '';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(id === tab));
        b.addEventListener('click', () => {
          setTab(id);
          input.focus();
        });
        return b;
      }),
    );
    render();
  };
  let shown: Action[] = [];
  let active = 0;
  const run = (a: Action | undefined) => {
    if (!a) return;
    closeActions();
    remember(a);
    a.run();
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (tab === 'assets') shown = sources.assets?.(q) ?? [];
    else if (tab === 'plugins') {
      const words = q ? q.split(/\s+/) : [];
      shown = (plugins ?? []).filter((a) => !words.length || score(a, words) >= 0);
    } else if (!q) {
      // Empty query — recent ones, then all commands.
      const keys = recent();
      const byKey = new Map(list.map((a) => [`${a.path}|${a.label}`, a]));
      const rec = keys.map((k) => byKey.get(k)).filter((a): a is Action => !!a);
      shown = [...rec, ...list.filter((a) => !rec.includes(a))].slice(0, 60);
    } else {
      const words = q.split(/\s+/);
      const cmds = list
        .map((a) => [a, score(a, words)] as const)
        .filter(([, s]) => s >= 0)
        .sort((a, b) => b[1] - a[1])
        .map(([a]) => a);
      shown = [...cmds.slice(0, 40), ...layers(q, 20)];
    }
    active = Math.min(active, Math.max(0, shown.length - 1));
    listEl.replaceChildren(
      ...(shown.length
        ? shown.map((a, i) => {
            const row = document.createElement('button');
            row.className = i === active ? 'on' : '';
            const lbl = document.createElement('span');
            lbl.className = 'lbl';
            lbl.textContent = a.label;
            const path = document.createElement('span');
            path.className = 'path';
            path.textContent = a.path;
            const hint = document.createElement('span');
            hint.className = 'hint';
            hint.textContent = a.hint ?? '';
            row.append(lbl, path, hint);
            row.addEventListener('pointerenter', () => {
              active = i;
              for (const [j, el] of [...listEl.children].entries()) el.className = j === i ? 'on' : '';
            });
            row.addEventListener('click', () => run(a));
            return row;
          })
        : [Object.assign(document.createElement('div'), { className: 'act-empty', textContent: tab === 'plugins' && !plugins ? 'Загружаю…' : tab === 'assets' && !q ? 'В файле и библиотеках нет компонентов' : 'Ничего не найдено' })]),
    );
    listEl.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeActions();
    else if (e.key === 'Enter') run(shown[active]);
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && tabs.length > 1) {
      e.preventDefault();
      const i = tabs.findIndex(([t]) => t === tab);
      setTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]![0]);
    }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      render();
    }
  });
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) closeActions();
  });
  setTab(tab);
  input.focus();
}

// ---------- Quick action parameters (plugins) ----------

export interface ParamSpec {
  key: string;
  name: string;
  description?: string;
  allowFreeform?: boolean;
  optional?: boolean;
}

export interface ParamReply {
  suggestions?: { name: string; data?: unknown }[];
  error?: string;
  loading?: string;
}

export interface ParamFlow {
  /** Title: plugin and command. */
  title: string;
  params: ParamSpec[];
  /** Input in the parameter field; there may be several answers (first “loading…”, then suggestions). */
  input(key: string, query: string, values: Record<string, unknown>, reply: (r: ParamReply) => void): void;
  done(values: Record<string, unknown>): void;
  cancel(): void;
}

/**
 * Plugin parameter input in the actions menu: parameter by parameter,
 * suggestions come from the plugin. Enter or Tab — choose, Backspace in an empty field — back to the previous one, Esc — cancel.
 */
export function openParameters(flow: ParamFlow) {
  closeActions();
  const root = document.createElement('div');
  root.id = 'actions';
  root.innerHTML =
    '<div class="act-card"><div class="act-chips"></div><input spellcheck="false" /><div class="act-list"></div><div class="act-foot">Enter или Tab — выбрать · Backspace — назад · Esc — отмена</div></div>';
  document.body.append(root);
  box = root;
  const chips = root.querySelector('.act-chips') as HTMLElement;
  const input = root.querySelector('input')!;
  const listEl = root.querySelector('.act-list') as HTMLElement;
  const values: Record<string, unknown> = {};
  const labels: string[] = [];
  let step = 0;
  let seq = 0;
  let reply: ParamReply = {};
  let active = 0;
  let finished = false;
  const close = (ok: boolean) => {
    if (finished) return;
    finished = true;
    root.remove();
    if (box === root) box = null;
    boxClose = null;
    if (ok) flow.done(values);
    else flow.cancel();
  };
  const param = () => flow.params[step]!;
  const header = () => {
    const parts = [flow.title, ...labels];
    chips.replaceChildren(
      ...parts.map((t, i) => Object.assign(document.createElement('span'), { className: i ? 'chip' : 'chip title', textContent: t })),
    );
    const p = param();
    input.placeholder = p.description ? `${p.name} — ${p.description}` : p.name + (p.optional ? ' (необязательно)' : '');
  };
  const items = () => reply.suggestions ?? [];
  const render = () => {
    const list = items();
    active = Math.min(active, Math.max(0, list.length - 1));
    const rows: HTMLElement[] = [];
    if (reply.error) rows.push(Object.assign(document.createElement('div'), { className: 'act-empty act-error', textContent: reply.error }));
    else if (reply.loading && !list.length) rows.push(Object.assign(document.createElement('div'), { className: 'act-empty', textContent: reply.loading }));
    else if (!list.length) {
      const p = param();
      const text = p.allowFreeform && input.value.trim() ? `Enter — «${input.value.trim()}»` : p.optional ? 'Enter — пропустить' : 'Нет подсказок';
      rows.push(Object.assign(document.createElement('div'), { className: 'act-empty', textContent: text }));
    }
    list.slice(0, 200).forEach((s, i) => {
      const row = document.createElement('button');
      row.className = i === active ? 'on' : '';
      row.append(Object.assign(document.createElement('span'), { className: 'lbl', textContent: s.name }));
      row.addEventListener('pointerenter', () => {
        active = i;
        for (const el of listEl.querySelectorAll('button')) el.className = el === row ? 'on' : '';
      });
      row.addEventListener('click', () => accept(i));
      rows.push(row);
    });
    listEl.replaceChildren(...rows);
    listEl.querySelector('button.on')?.scrollIntoView({ block: 'nearest' });
  };
  const ask = () => {
    const my = ++seq;
    reply = {};
    render();
    flow.input(param().key, input.value, { ...values }, (r) => {
      if (my !== seq || finished) return;
      reply = { ...reply, ...r };
      if (r.suggestions) delete reply.loading;
      render();
    });
  };
  const accept = (i: number | null) => {
    const p = param();
    const list = items();
    const q = input.value.trim();
    let value: unknown;
    let label: string;
    if (i !== null && list[i]) {
      value = list[i]!.data !== undefined ? list[i]!.data : list[i]!.name;
      label = list[i]!.name;
    } else if (p.allowFreeform && q) {
      value = q;
      label = q;
    } else if (p.optional && !q) {
      value = undefined;
      label = `${p.name}: —`;
    } else return;
    if (value !== undefined) values[p.key] = value;
    labels.push(label);
    step++;
    if (step >= flow.params.length) return close(true);
    input.value = '';
    active = 0;
    header();
    ask();
  };
  input.addEventListener('input', () => {
    active = 0;
    ask();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close(false);
    else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      accept(items().length ? active : null);
    } else if (e.key === 'Backspace' && !input.value && step > 0) {
      e.preventDefault();
      step--;
      labels.pop();
      delete values[param().key];
      header();
      ask();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items().length;
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      render();
    }
  });
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) close(false);
  });
  boxClose = () => close(false);
  header();
  ask();
  input.focus();
}
