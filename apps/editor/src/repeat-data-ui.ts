// Grid repeat and data fill — commands, panel section, data window. Logic lives in
// @mfp/editing (repeat-grid.ts, data-fill.ts); here — selection, undo, hints.

import { boundLayers, createRepeatGrid, fillTargets, isRepeatGrid, parseData, repeatGridsToSync, setRepeatGrid, syncRepeatGrid, type DataTable, type RepeatGrid } from '@mfp/editing';
import { h, modal } from './dom.ts';
import { scrubTextInput } from './number-drag.ts';
import type { Editor } from './editor.ts';

/** Hook repeat recomputation to edits (frame resized, template changed). */
export function installRepeatGrids(ed: Editor) {
  ed.derivers.push((ops) => {
    for (const [id, fromSize] of repeatGridsToSync(ed.doc, ops)) syncRepeatGrid(ed.doc, id, fromSize);
  });
}

/**
 * “Repeat in grid”: the selected component (or the selection wrapped in a component) — into a 3 × 2 grid.
 * makeComponent — create a component from the selection (like Ctrl+Alt+K) and select it.
 */
export function repeatSelection(ed: Editor, makeComponent: () => void, notify: (m: string) => void) {
  const doc = ed.doc;
  const sel = ed.selection.filter((id) => doc.has(id));
  if (!sel.length) return notify('Выделите слой, который нужно повторить');
  if (sel.length === 1 && isRepeatGrid(doc, sel[0]!)) return notify('Это уже повтор сеткой: растяните рамку или задайте колонки и строки в панели');
  const frame = doc.transact(() => {
    if (!(sel.length === 1 && doc.type(sel[0]!) === 'COMPONENT')) makeComponent();
    const comp = ed.selection[0];
    if (!comp || doc.type(comp) !== 'COMPONENT') return null;
    return createRepeatGrid(doc, comp);
  });
  if (!frame) return;
  ed.select([frame]);
  notify('Повтор сеткой: растяните рамку — ячеек станет больше; правка первой ячейки — во всех');
}

/** Number field for the section (custom, compact): Enter or blur — apply. */
function numInput(label: string, title: string, value: number, apply: (v: number) => void, doc?: { beginGroup(): void; endGroup(): void }): HTMLElement {
  const input = h('input', { value: String(value), 'aria-label': title }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const v = (Number(input.value.replace(',', '.')) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
      input.value = String(v);
      apply(v);
    }
  });
  input.addEventListener('change', () => {
    const v = Number(input.value.replace(',', '.'));
    if (Number.isFinite(v)) apply(v);
  });
  const lab = h('label', {}, label);
  scrubTextInput(lab, input, (t) => {
    const v = Number(t);
    if (Number.isFinite(v)) apply(v);
  }, () => doc?.beginGroup(), () => doc?.endGroup());
  return h('div', { class: 'field', title }, lab, input);
}

/** “Grid repeat” panel section for the selected repeat. */
export function repeatSection(ed: Editor, notify: (m: string) => void): (sel: string[]) => HTMLElement | '' {
  return (sel) => {
    const doc = ed.doc;
    if (sel.length !== 1 || !isRepeatGrid(doc, sel[0]!)) return '';
    const id = sel[0]!;
    const g = doc.get(id, 'repeatGrid') as RepeatGrid;
    const set = (patch: Partial<RepeatGrid>) => doc.transact(() => setRepeatGrid(doc, id, patch));
    return h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Повтор сеткой'),
      h(
        'div',
        { class: 'props' },
        numInput('▥', 'Колонки', g.columns, (v) => set({ columns: Math.max(1, Math.min(200, Math.round(v))) }), doc),
        numInput('▤', 'Строки', g.rows, (v) => set({ rows: Math.max(1, Math.min(200, Math.round(v))) }), doc),
        numInput('↔', 'Промежуток между колонками, px', g.gapX, (v) => set({ gapX: v }), doc),
        numInput('↕', 'Промежуток между строками, px', g.gapY, (v) => set({ gapY: v }), doc),
        h('button', { class: 'export-btn', title: 'Тексты и цвета ячеек — из CSV или JSON', onclick: () => openDataFill(ed, notify) }, 'Данные…'),
        h(
          'button',
          {
            class: 'export-btn',
            title: 'Обычная рамка: ячейки остаются (первая — компонент, остальные — его инстансы)',
            onclick: () => doc.transact(() => doc.set(id, { repeatGrid: undefined })),
          },
          'Убрать повтор',
        ),
      ),
    );
  };
}

/** Where records go: repeat cells (in order) or selected layers (in layer order). */
function targetsOf(ed: Editor): { grid: string | null; targets: readonly string[] } {
  const doc = ed.doc;
  const sel = ed.selection.filter((id) => doc.has(id));
  if (sel.length === 1 && isRepeatGrid(doc, sel[0]!)) return { grid: sel[0]!, targets: doc.children(sel[0]!) };
  // A layer inside a repeat — the whole repeat.
  const p = sel.length === 1 ? doc.parent(sel[0]!) : null;
  if (p && isRepeatGrid(doc, p)) return { grid: p, targets: doc.children(p) };
  // A single container with several children (a list of cards) — its children.
  if (sel.length === 1 && doc.children(sel[0]!).length > 1) return { grid: null, targets: doc.children(sel[0]!) };
  return { grid: null, targets: sel };
}

/** “Data” window: paste or open CSV/JSON, see which fields the layers matched, fill. */
export function openDataFill(ed: Editor, notify: (m: string) => void) {
  const doc = ed.doc;
  const first = targetsOf(ed);
  if (!first.targets.length) return notify('Выделите повтор сеткой или несколько карточек');
  const m = modal('Заполнить данными');
  const area = h('textarea', {
    class: 'm-input',
    style: 'width:100%;height:150px;font-family:ui-monospace,monospace;font-size:12px;resize:vertical',
    placeholder: 'name,price,color\nКофе,250 ₽,#6b4226\nЧай,180 ₽,#2f7d32\n\nили JSON: [{"name": "Кофе", "price": "250 ₽"}]',
    'aria-label': 'CSV или JSON',
  }) as HTMLTextAreaElement;
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.json,.txt,text/csv,application/json', style: 'display:none' }) as HTMLInputElement;
  const status = h('p', { class: 'm-note' });
  const grow = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  let table: DataTable | null = null;
  const update = () => {
    table = parseData(area.value);
    const { grid, targets } = targetsOf(ed);
    if (!area.value.trim()) {
      status.textContent = `Имена слоёв в карточке — поля таблицы (как «name», «#price» или «{photo}»). Цвет «#rrggbb» красит фигуру, «/hide» скрывает слой. Карточек: ${targets.length}.`;
      return;
    }
    if (!table || !table.rows.length) {
      status.textContent = 'Не похоже на CSV с заголовком или JSON-массив объектов';
      return;
    }
    const probe = targets[0] ? boundLayers(doc, targets[0], table.columns) : new Map();
    const found = table.columns.filter((c) => probe.has(c));
    const missing = table.columns.filter((c) => !probe.has(c));
    status.textContent = `Записей: ${table.rows.length}, карточек: ${targets.length}${grid ? ' (сетка дорастёт)' : ''}. Поля со слоями: ${found.join(', ') || 'нет'}${missing.length ? `; без слоя: ${missing.join(', ')}` : ''}.`;
  };
  area.addEventListener('input', update);
  area.addEventListener('keydown', (e) => e.stopPropagation());
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    area.value = await f.text();
    update();
  });
  const apply = () => {
    if (!table || !table.rows.length) return area.focus();
    const t = table;
    const result = doc.transact(() => {
      let { grid, targets } = targetsOf(ed);
      if (grid && grow.checked && targets.length < t.rows.length) {
        const g = doc.get(grid, 'repeatGrid') as RepeatGrid;
        setRepeatGrid(doc, grid, { rows: Math.ceil(t.rows.length / g.columns) });
        targets = doc.children(grid);
      }
      return fillTargets(doc, targets, t);
    });
    m.close();
    notify(result.changed ? `Заполнено: изменено слоёв — ${result.changed}` : 'Ни одно поле не совпало с именами слоёв карточки');
  };
  m.body.append(
    area,
    h('div', { class: 'm-row' }, h('button', { class: 'm-btn', onclick: () => file.click() }, 'Открыть файл…'), file),
    status,
    ...(first.grid ? [h('label', { class: 'm-row' }, grow, 'Добавить строки сетки, если записей больше, чем ячеек')] : []),
    h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => m.close() }, 'Отмена'), h('button', { class: 'm-btn primary', onclick: apply }, 'Заполнить')),
  );
  update();
  setTimeout(() => area.focus(), 0);
}
