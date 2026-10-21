// Find and replace (Ctrl+F) and batch rename (Ctrl+R on several layers).
// Search — in text and layer names of the current page; Enter — to the next match.
// Replace — in text (and in names, if searching them); “Replace all” — one undo step.

import type { Editor } from './editor.ts';
import { findHits, replaceFindHit, replaceFindAll, type FindScope as Scope, type FindHit as Hit } from '@mfp/editing';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let open: HTMLElement | null = null;

function close() {
  open?.remove();
  open = null;
}

/** Window in the top right corner of the canvas. */
function panel(title: string): HTMLElement {
  close();
  const box = document.createElement('div');
  box.className = 'float-panel';
  box.innerHTML = `<div class="fp-head"><b></b><button class="fp-close" title="Закрыть (Esc)">×</button></div><div class="fp-body"></div>`;
  box.querySelector('b')!.textContent = title;
  box.querySelector('.fp-close')!.addEventListener('click', close);
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  document.getElementById('stage')!.append(box);
  open = box;
  return box.querySelector('.fp-body') as HTMLElement;
}

function input(placeholder: string, value = ''): HTMLInputElement {
  const el = document.createElement('input');
  el.placeholder = placeholder;
  el.value = value;
  el.spellcheck = false;
  return el;
}

function button(label: string, run: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = primary ? 'fp-btn primary' : 'fp-btn';
  b.textContent = label;
  b.addEventListener('click', run);
  return b;
}

/** Find and replace on the current page. */
export function openFind(ed: Editor, notify: (m: string) => void) {
  const body = panel(ed.devMode ? 'Найти' : 'Найти и заменить');
  const pageId = ed.pageId;
  const selectedRoots = [...ed.selection];
  const area = document.createElement('select');
  area.setAttribute('aria-label', 'Область поиска');
  area.append(new Option('Текущая страница', 'page'), new Option('Выделенные слои и всё внутри', 'selection'));
  area.options[1]!.disabled = !selectedRoots.length;
  area.title = 'Выделение запоминается при открытии окна. Для другого выделения откройте окно заново.';
  const roots = () => area.value === 'selection' ? selectedRoots : [pageId];
  const q = input('Найти');
  const rep = input('Заменить на');
  const scopeSel = document.createElement('select');
  for (const [v, label] of [
    ['all', 'Текст и имена слоёв'],
    ['text', 'Только текст'],
    ['names', 'Только имена слоёв'],
  ] as const)
    scopeSel.append(Object.assign(document.createElement('option'), { value: v, textContent: label }));
  const info = document.createElement('div');
  info.className = 'fp-info';
  const list = document.createElement('div');
  list.className = 'fp-list';
  const actions = document.createElement('div');
  actions.className = 'fp-row';
  let hits: Hit[] = [];
  let cur = -1;
  let truncated = false;

  const search = () => {
    hits = [];
    cur = -1;
    truncated = false;
    for (const hit of findHits(ed.doc, roots(), q.value, scopeSel.value as Scope)) {
      if (hits.length === 2000) { truncated = true; break; }
      hits.push(hit);
    }
    render();
  };

  const go = (i: number) => {
    if (!hits.length || ed.pageId !== pageId) return;
    cur = ((i % hits.length) + hits.length) % hits.length;
    const h = hits[cur]!;
    ed.select([h.id]);
    const b = ed.selectionBounds([h.id]);
    if (b && !intersects(b, ed.viewportRect())) ed.fitRect([b[0] - 80, b[1] - 80, b[2] + 80, b[3] + 80]);
    render();
  };

  const render = () => {
    info.textContent = q.value ? (hits.length ? `Найдено: ${hits.length}${truncated ? '+' : ''}${cur >= 0 ? ` · ${cur + 1}-е` : ''}` : 'Ничего не найдено') : (area.value === 'selection' ? 'Ищет в выделении при открытии окна' : 'Ищет на текущей странице');
    list.replaceChildren(
      ...hits.slice(0, 200).map((h, i) => {
        const row = document.createElement('button');
        row.className = i === cur ? 'on' : '';
        const len = q.value.length;
        const from = Math.max(0, h.index - 20);
        const before = h.source.slice(from, h.index);
        const match = h.source.slice(h.index, h.index + len);
        const after = h.source.slice(h.index + len, h.index + len + 30);
        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = h.kind === 'text' ? 'Т' : '#';
        kind.title = h.kind === 'text' ? 'Текст' : 'Имя слоя';
        const snippet = document.createElement('span');
        snippet.className = 'snip';
        snippet.append(`${from > 0 ? '…' : ''}${before}`, Object.assign(document.createElement('mark'), { textContent: match }), after);
        row.append(kind, snippet);
        row.addEventListener('click', () => go(i));
        return row;
      }),
    );
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };

  const canReplace = () => {
    if (ed.devMode) { notify('Для замены переключитесь в режим дизайна.'); return false; }
    if (ed.pageId === pageId) return true;
    notify('Страница изменилась. Откройте поиск заново.');
    return false;
  };

  actions.append(
    button('Заменить', () => {
      const h = hits[cur >= 0 ? cur : 0];
      if (!h || !q.value || !canReplace()) return;
      ed.doc.transact(() => replaceFindHit(ed.doc, h, q.value, rep.value));
      search();
      go(Math.max(0, cur));
    }),
    button(
      'Заменить все',
      () => {
        if (!q.value || !canReplace()) return;
        const n = replaceFindAll(ed.doc, roots(), q.value, rep.value, scopeSel.value as Scope);
        notify('Заменено вхождений: ' + n);
        search();
      },
      true,
    ),
  );
  q.addEventListener('input', search);
  scopeSel.addEventListener('change', search);
  area.addEventListener('change', search);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(cur + (e.shiftKey ? -1 : 1));
  });
  body.append(q, area, scopeSel, info, list);
  if (!ed.devMode) { q.after(rep); body.append(actions); }
  // Initial query — the layer's selected text (as a hint), otherwise empty.
  render();
  q.focus();
}

function intersects(a: [number, number, number, number], b: [number, number, number, number]) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Batch rename: new name template ($& — current name, $n — number, $nn — number
 * with a leading zero) or “find and replace” in names. Numbering follows the order in the layers list.
 */
export function openBatchRename(ed: Editor, ids: string[]) {
  const doc = ed.doc;
  // Order — as in the layers list (top to bottom).
  const order = new Map<string, number>();
  let k = 0;
  const walk = (p: string) => {
    for (const c of [...doc.children(p)].reverse()) {
      order.set(c, k++);
      walk(c);
    }
  };
  walk(ed.pageId);
  const sorted = [...ids].filter((id) => doc.has(id)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const body = panel(`Переименовать слои: ${sorted.length}`);
  const name = input('Новое имя: $& — нынешнее, $n — номер', '$&');
  const find = input('Найти в имени (необязательно)');
  const rep = input('Заменить на');
  const start = input('Начать нумерацию с', '1');
  start.type = 'number';
  const desc = document.createElement('label');
  desc.className = 'fp-check';
  const descBox = document.createElement('input');
  descBox.type = 'checkbox';
  desc.append(descBox, 'Нумерация по убыванию');
  const preview = document.createElement('div');
  preview.className = 'fp-list preview';
  const result = (i: number, id: string) => {
    const n0 = Number(start.value) || 0;
    const num = descBox.checked ? n0 + sorted.length - 1 - i : n0 + i;
    let cur = doc.get(id, 'name') ?? '';
    if (find.value) cur = cur.replace(new RegExp(escapeRe(find.value), 'gi'), rep.value);
    return (name.value || '$&').replace(/\$(n+)/g, (_, ns: string) => String(num).padStart(ns.length, '0')).replace(/\$&/g, cur);
  };
  const render = () => {
    preview.replaceChildren(
      ...sorted.slice(0, 8).map((id, i) => {
        const row = document.createElement('div');
        row.className = 'pv';
        row.textContent = `${doc.get(id, 'name') ?? ''} → ${result(i, id)}`;
        return row;
      }),
    );
  };
  for (const el of [name, find, rep, start]) el.addEventListener('input', render);
  descBox.addEventListener('change', render);
  const apply = () => {
    doc.transact(() => sorted.forEach((id, i) => doc.set(id, { name: result(i, id) })));
    close();
  };
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  });
  const row = document.createElement('div');
  row.className = 'fp-row';
  row.append(button('Отмена', close), button('Переименовать', apply, true));
  body.append(name, find, rep, start, desc, preview, row);
  render();
  name.focus();
  name.select();
}
