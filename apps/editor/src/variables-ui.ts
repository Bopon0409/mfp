import { draggableWindow } from './draggable-window.ts';
// Variables in the UI:
// - variable picker at a field: “=” in a number field, a button on a paint — matching by type
//   and scopes, by collections and groups; a bound field shows the variable name;
// - collection modes on a frame (“View” section) and on a page: “Auto” — same as the ancestor;
// - “Variables” window: collections, modes as columns, values (color, number, string,
//   boolean), references to other variables and expressions (“=” in a cell), scopes,
//   code syntax names, description.

import {
  addMode,
  alias,
  bindVariable,
  collectionChain,
  collectionOf,
  collectionVariables,
  colorHex,
  createCollection,
  createVariable,
  defaultMode,
  deleteVariable,
  extendCollection,
  extensionsOf,
  gradientValueOf,
  isAlias,
  isComposite,
  isColor,
  isExpression,
  localCollections,
  localVariables,
  modeContext,
  modeFor,
  parseCssColor,
  removeMode,
  renameMode,
  resolveVariable,
  setExplicitMode,
  setVariableOverride,
  setVariableValue,
  shadowValueOf,
  typographyValueOf,
  variableAllowed,
  variablesIn,
  variableValueIn,
  type Document,
  type GradientPaint,
  type RGBA,
  type VariableType,
  type VariableValue,
  type Props,
} from '@mfp/core';
import type { Editor } from './editor.ts';
import { h, iconBtn, popover, searchInput, svgEl, textInput } from './dom.ts';
import { ICON } from './icons.ts';
import { showMenu, showMenuAt, type MenuEntry } from './menu.ts';
import { openColorEditor } from './paint-editor.ts';
import { scrubTextInput } from './number-drag.ts';
import { compositeEditor, compositePreview } from './composite-editor.ts';
import { t } from './i18n/index.ts';

export const TYPE_LABEL: Record<VariableType, string> = { COLOR: 'Цвет', FLOAT: 'Число', STRING: 'Строка', BOOLEAN: 'Логическое', GRADIENT: 'Градиент', SHADOW: 'Тени', TYPOGRAPHY: 'Типографика' };

const short = (name: string) => name.split('/').pop()!.trim();

/** Unit label of a number variable (as in CSS). */
export const UNIT_LABEL: Record<NonNullable<Props['unit']>, string> = { REM: 'rem', PERCENT: '%', MULTIPLIER: '×' };
/** Unit from input: “1.5rem”, “150%”, “1.5x” / “1.5×”; px — no unit. */
const UNIT_OF: Record<string, Props['unit'] | undefined> = { rem: 'REM', '%': 'PERCENT', x: 'MULTIPLIER', '×': 'MULTIPLIER', px: undefined };

/** Value swatch: color, number (with the variable's unit), string, yes/no. */
export function valuePreview(doc: Document, v: VariableValue | undefined, unit?: Props['unit']): HTMLElement {
  if (v === undefined) return h('span', { class: 'var-val muted' }, '—');
  if (isColor(v)) {
    const el = h('span', { class: 'var-swatch' });
    el.style.background = `rgba(${Math.round(v.r * 255)},${Math.round(v.g * 255)},${Math.round(v.b * 255)},${v.a ?? 1})`;
    return el;
  }
  if (isAlias(v)) return h('span', { class: 'var-val' }, short(doc.get(v.id, 'name') ?? '?'));
  if (isComposite(v)) return compositePreview(v, (id) => resolveVariable(doc, id, null));
  if (isExpression(v)) return h('span', { class: 'var-val expr' }, `= ${v.expression}`);
  return h('span', { class: 'var-val' }, typeof v === 'boolean' ? (v ? 'да' : 'нет') : typeof v === 'number' ? `${+v.toFixed(3)}${unit ? ` ${UNIT_LABEL[unit]}` : ''}` : `«${v}»`);
}

/** Variables by collections and groups: those matching the field's type and scopes. */
export function variableCandidates(doc: Document, types: VariableType[], field: string, nodeType?: string): [string, [string, string[]][]][] {
  const out: [string, [string, string[]][]][] = [];
  for (const c of localCollections(doc)) {
    const groups = new Map<string, string[]>();
    for (const v of variablesIn(doc, c)) {
      if (!types.includes(doc.get(v, 'resolvedType') ?? 'FLOAT') || !variableAllowed(doc, v, field, nodeType)) continue;
      const name = doc.get(v, 'name') ?? '';
      const i = name.lastIndexOf('/');
      const g = i > 0 ? name.slice(0, i) : '';
      let list = groups.get(g);
      if (!list) groups.set(g, (list = []));
      list.push(v);
    }
    if (groups.size) out.push([c, [...groups]]);
  }
  return out;
}

/**
 * Variable picker at a field. nodeId — the layer (values are shown in its modes).
 * onPick(null) — “Detach”.
 */
export function openVariablePicker(
  ed: Editor,
  anchor: HTMLElement,
  opts: { types: VariableType[]; field: string; nodeId?: string | null; nodeType?: string; current?: string | null; onPick(id: string | null): void; onOpenWindow?: () => void },
) {
  const doc = ed.doc;
  const { box, close } = popover(anchor, 'picker var-picker', { width: 260, side: 'left' });
  if (!box.isConnected) return;
  const list = h('div', { class: 'pop-list' });
  const pick = (id: string | null) => {
    close();
    opts.onPick(id);
  };
  const render = (q: string) => {
    list.replaceChildren();
    let n = 0;
    for (const [c, groups] of variableCandidates(doc, opts.types, opts.field, opts.nodeType)) {
      const rows: HTMLElement[] = [];
      for (const [g, ids] of groups) {
        const found = ids.filter((v) => !q || (doc.get(v, 'name') ?? '').toLowerCase().includes(q));
        if (!found.length) continue;
        if (g) rows.push(h('div', { class: 'asset-group sub' }, g));
        for (const v of found) {
          rows.push(variableItem(doc, v, opts.nodeId ?? null, () => pick(v), opts.current));
          n++;
        }
      }
      if (rows.length) list.append(h('div', { class: 'asset-group' }, doc.get(c, 'name') ?? ''), ...rows);
    }
    if (!n) list.append(h('div', { class: 'empty' }, q ? 'Ничего не найдено' : `Нет переменных типа «${opts.types.map((t) => TYPE_LABEL[t]).join(' / ')}» для этого поля.`));
  };
  const search = searchInput('Поиск переменной', render);
  const actions = h('div', { class: 'pop-actions' });
  if (opts.current) actions.append(h('button', { class: 'pe-btn', onclick: () => pick(null) }, 'Отвязать'));
  if (opts.onOpenWindow)
    actions.append(
      h('button', {
        class: 'pe-btn',
        onclick: () => {
          close();
          opts.onOpenWindow!();
        },
      }, 'Все переменные…'),
    );
  box.append(h('div', { class: 'pop-head' }, 'Переменные'), search, list, actions);
  render('');
  setTimeout(() => search.focus(), 0);
}

/** Variable row in lists: value swatch and name. */
export function variableItem(doc: Document, v: string, nodeId: string | null, onClick: () => void, current?: string | null): HTMLElement {
  const row = h('div', { class: `style-item${v === current ? ' current' : ''}`, title: doc.get(v, 'description') || (doc.get(v, 'name') ?? '') }, valuePreview(doc, resolveVariable(doc, v, nodeId), doc.get(v, 'unit')), h('span', { class: 'style-name' }, short(doc.get(v, 'name') ?? '')));
  row.addEventListener('click', onClick);
  return row;
}

/** Bound field: the variable name (click — change), a “Detach” button. */
export function variablePill(ed: Editor, variableId: string, opts: { onPick(anchor: HTMLElement): void; onDetach(): void; nodeId?: string | null }): HTMLElement {
  const doc = ed.doc;
  const exists = doc.has(variableId);
  const name = exists ? short(doc.get(variableId, 'name') ?? '') : 'удалена';
  const pill = h('button', { class: `var-pill${exists ? '' : ' missing'}`, title: exists ? `${doc.get(collectionOf(doc, variableId) ?? '', 'name') ?? ''} / ${doc.get(variableId, 'name')}` : 'Переменная удалена' });
  const vt = exists ? doc.get(variableId, 'resolvedType') : undefined;
  if (vt === 'COLOR' || vt === 'GRADIENT' || vt === 'SHADOW') pill.append(valuePreview(doc, resolveVariable(doc, variableId, opts.nodeId ?? null)));
  else pill.append(svgEl('span', { class: 'var-ic' }, ICON.variable));
  pill.append(h('span', { class: 'var-name' }, name));
  pill.addEventListener('click', () => opts.onPick(pill));
  const detach = iconBtn('unlink', 'Отвязать переменную (значение останется)', () => opts.onDetach(), 'icon-btn sm');
  return h('div', { class: 'var-bound' }, pill, detach);
}

/** Shared field binding across layers (or null). */
export function boundOf(doc: Document, ids: string[], fields: string[]): string | null {
  const first = doc.get(ids[0]!, 'boundVariables')?.[fields[0]!]?.id ?? null;
  if (!first) return null;
  for (const id of ids) for (const f of fields) if (doc.get(id, 'boundVariables')?.[f]?.id !== first) return null;
  return first;
}

/** Bind the layers' fields to a variable (null — detach). */
export function bindFields(ed: Editor, ids: string[], fields: string[], variableId: string | null) {
  const doc = ed.doc;
  doc.transact(() => {
    for (const id of ids) for (const f of fields) bindVariable(doc, id, f, variableId);
  });
}

/** Collection modes on layers (or a page): “Auto” — same as the ancestor. */
export function modeRows(ed: Editor, ids: string[]): HTMLElement[] {
  const doc = ed.doc;
  const rows: HTMLElement[] = [];
  for (const c of localCollections(doc)) {
    const modes = doc.get(c, 'modes') ?? [];
    const ext = !!doc.get(c, 'extendsCollection');
    // An extension (brand) — as a row with a single mode: apply the brand to the frame.
    if (modes.length < 2 && !ext) continue;
    const own = ids.map((id) => doc.get(id, 'explicitVariableModes')?.[c] ?? '');
    const same = own.every((m) => m === own[0]) ? own[0]! : null;
    // “Auto” shows the mode the layer gets from its ancestors (for a brand — whether it is applied higher up).
    let auto: string;
    if (ext) {
      const base = collectionChain(doc, c).at(-1)!;
      const ctx = modeContext(doc, doc.parent(ids[0]!) ?? null, base);
      auto = ctx.collection === c ? `Авто (${modes.find((m) => m.modeId === ctx.modeId)?.name ?? ''})` : 'Не применён';
    } else {
      const inherited = modeFor(doc, doc.parent(ids[0]!) ?? null, c);
      auto = `Авто (${modes.find((m) => m.modeId === inherited)?.name ?? ''})`;
    }
    const sel = h(
      'select',
      {},
      ...(same === null ? [h('option', { value: '*', selected: true, disabled: true }, 'Разные')] : []),
      h('option', { value: '', selected: same === '' }, auto),
      ...modes.map((m) => h('option', { value: m.modeId, selected: same === m.modeId }, m.name)),
    ) as HTMLSelectElement;
    sel.addEventListener('change', () => doc.transact(() => ids.forEach((id) => setExplicitMode(doc, id, c, sel.value))));
    rows.push(h('div', { class: 'prop-row' }, h('div', { class: 'prop-label', title: doc.get(c, 'name') ?? '' }, svgEl('span', { class: 'prop-ic' }, ICON.mode), h('span', {}, doc.get(c, 'name') ?? '')), h('div', { class: 'prop-control' }, h('div', { class: 'field' }, sel)), h('span', { class: 'prop-pad' })));
  }
  return rows;
}

// ---------- “Variables” window ----------

let windowEl: HTMLElement | null = null;
let closeWindow: (() => void) | null = null;

/** Default value for a new mode or variable. */
const parseNumber = (s: string) => Number(s.replace(',', '.'));
/** Color from input: hex, rgb(), hsl(), oklch(), oklab() — as in CSS. */
const parseColor = (s: string): RGBA | null => parseCssColor(s) ?? (/^[0-9a-f]{3,8}$/i.test(s.trim()) ? parseCssColor(`#${s.trim()}`) : null);

/**
 * Variable value cell in a mode. ext — an extension (brand), while the variable belongs to the parent: the cell
 * shows the brand's own value or the inherited one (dimmed), an edit sets the brand's own value.
 */
function valueCell(ed: Editor, v: string, modeId: string, ext?: string, onExpand?: () => void): HTMLElement {
  const doc = ed.doc;
  const type = doc.get(v, 'resolvedType') ?? 'FLOAT';
  const overridden = !!ext && doc.get(ext, 'variableOverrides')?.[v]?.[modeId] !== undefined;
  const value = ext ? variableValueIn(doc, v, ext, modeId) : (doc.get(v, 'valuesByMode') ?? {})[modeId];
  const set = (x: VariableValue) => doc.transact(() => (ext ? setVariableOverride(doc, ext, v, modeId, x) : setVariableValue(doc, v, modeId, x)));
  const cell = h('div', { class: `var-cell${ext && !overridden ? ' inherited' : ''}`, ...(ext ? { title: overridden ? 'Своё значение бренда (правая кнопка — «Как у родителя»)' : 'Как у родителя — правка задаст своё значение бренда' } : {}) });
  const resolveHere = () => resolveVariableIn(doc, v, modeId, ext);
  const menu = (anchor: HTMLElement, x: number, y: number) => {
    const items: MenuEntry[] = [
      {
        label: 'Ссылка на переменную…',
        run: () =>
          openVariablePicker(ed, anchor, {
            types: [type],
            field: '',
            current: isAlias(value) ? value.id : null,
            onPick: (id) => {
              if (id && id !== v) set(alias(id));
              else if (!id) set(resolveVariable(doc, v, null) ?? 0);
            },
          }),
      },
    ];
    if (isAlias(value) || isExpression(value)) items.push({ label: 'Значение вместо ссылки', run: () => set(resolveHere() ?? 0) });
    if (overridden) items.push('sep', { label: 'Как у родителя (убрать своё значение бренда)', run: () => doc.transact(() => setVariableOverride(doc, ext!, v, modeId, undefined)) });
    showMenuAt(x, y, items);
  };
  cell.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    menu(cell, e.clientX, e.clientY);
  });
  if (isAlias(value)) {
    const pill = h('button', { class: 'var-pill', title: 'Ссылка — щелчок, чтобы сменить; правая кнопка — меню' }, valuePreview(doc, resolveHere()), h('span', { class: 'var-name' }, short(doc.get(value.id, 'name') ?? '?')));
    pill.addEventListener('click', () => menu(pill, pill.getBoundingClientRect().left, pill.getBoundingClientRect().bottom));
    cell.append(pill);
    return cell;
  }
  // Composite (gradient, shadows, typography): a swatch; click — edit in a row under the variable.
  if (isComposite(value)) {
    const b = h('button', { class: 'var-pill var-comp-btn', title: 'Править (строкой ниже); правая кнопка — ссылка на переменную' }, valuePreview(doc, resolveHere()));
    b.addEventListener('click', () => onExpand?.());
    cell.append(b);
    return cell;
  }
  // Expression: “=…” in a cell; editing — the same row.
  const exprText = isExpression(value) ? `=${value.expression}` : null;
  if (type === 'BOOLEAN' && !exprText) {
    const t = h('button', { class: `toggle${value === true ? ' on' : ''}` });
    t.addEventListener('click', () => set(!(value === true)));
    cell.append(t);
    return cell;
  }
  if (type === 'COLOR' && !exprText) {
    const c = isColor(value) ? value : { r: 0, g: 0, b: 0, a: 1 };
    const sw = h('button', { class: 'swatch', title: 'Палитра' });
    sw.style.background = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a ?? 1})`;
    const key = `var:${v}:${modeId}`;
    sw.addEventListener('click', () => openColorEditor({ key, anchor: cell, color: { ...c, a: c.a ?? 1 }, alpha: true, onChange: (n) => set({ r: n.r, g: n.g, b: n.b, a: n.a }), onStart: () => doc.beginGroup(), onEnd: () => doc.endGroup(), docColors: [] }));
    const input = textInput(colorHex(c).replace(/^#/, ''), (s) => {
      if (s.trim().startsWith('=')) return set({ type: 'EXPRESSION', expression: s.trim().slice(1).trim() });
      const p = parseColor(s);
      if (p) set(p);
    });
    cell.append(h('div', { class: 'field' }, sw, input));
    return cell;
  }
  const shown = exprText ?? (value === undefined ? '' : String(value));
  const input = textInput(shown, (s) => {
    const t = s.trim();
    if (t.startsWith('=')) return set({ type: 'EXPRESSION', expression: t.slice(1).trim() });
    if (type === 'FLOAT') {
      // A number with a unit, as in CSS: “1.5rem”, “150%”, “1.5×” — the variable's unit changes accordingly (px — no unit).
      const m = /^(-?[\d.,]+)\s*(px|rem|%|x|×)?$/i.exec(t);
      const n = m ? parseNumber(m[1]!) : NaN;
      if (!Number.isFinite(n)) return;
      doc.transact(() => {
        set(n);
        if (m![2]) doc.set(v, { unit: UNIT_OF[m![2].toLowerCase()] });
      });
    } else if (type === 'BOOLEAN') set(t === 'true' || t === 'да' || t === '1');
    else set(s);
  });
  if (exprText) {
    input.classList.add('expr');
    input.title = `= ${String(resolveHere() ?? '?')}`;
  } else
    input.title =
      type === 'BOOLEAN'
        ? 'да / нет; «=» — выражение: не {Флаг}, {Шаг} > 8, {А} и {Б}, if(…, да, нет)'
        : 'Значение; «=» — выражение: {Имя} * 2, min(), round(), if({Флаг}, 16, 8)';
  cell.append(h('div', { class: 'field' }, input));
  return cell;
}

/** Variable value in its collection's mode (references into other collections — in their default modes). */
function resolveVariableIn(doc: Document, v: string, modeId: string, ext?: string): VariableValue | undefined {
  const coll = ext ?? collectionOf(doc, v);
  return resolveVariable(doc, v, null, 0, coll ? { [coll]: modeId } : undefined);
}

/** Variable details: description, scopes, code syntax names. */
function detailsPopover(ed: Editor, anchor: HTMLElement, v: string) {
  const doc = ed.doc;
  const { box } = popover(anchor, 'picker var-details', { width: 280, side: 'left' });
  if (!box.isConnected) return;
  const type = doc.get(v, 'resolvedType') ?? 'FLOAT';
  const scopes = doc.get(v, 'scopes') ?? ['ALL_SCOPES'];
  const SCOPES: Record<VariableType, [string, string][]> = {
    COLOR: [['ALL_FILLS', 'Все заливки'], ['FRAME_FILL', 'Заливка фрейма'], ['SHAPE_FILL', 'Заливка фигуры'], ['TEXT_FILL', 'Цвет текста'], ['STROKE_COLOR', 'Обводка'], ['EFFECT_COLOR', 'Эффекты']],
    FLOAT: [['CORNER_RADIUS', 'Скругление'], ['WIDTH_HEIGHT', 'Ширина и высота'], ['GAP', 'Промежутки и отступы'], ['STROKE_FLOAT', 'Толщина обводки'], ['OPACITY', 'Непрозрачность'], ['EFFECT_FLOAT', 'Эффекты'], ['FONT_SIZE', 'Кегль'], ['LINE_HEIGHT', 'Межстрочный'], ['LETTER_SPACING', 'Межбуквенный'], ['PARAGRAPH_SPACING', 'Интервал абзацев'], ['PARAGRAPH_INDENT', 'Отступ абзаца'], ['FONT_WEIGHT', 'Насыщенность шрифта']],
    STRING: [['TEXT_CONTENT', 'Текст'], ['FONT_FAMILY', 'Шрифт'], ['FONT_STYLE', 'Начертание']],
    BOOLEAN: [],
    GRADIENT: [['ALL_FILLS', 'Все заливки'], ['FRAME_FILL', 'Заливка фрейма'], ['SHAPE_FILL', 'Заливка фигуры'], ['TEXT_FILL', 'Цвет текста'], ['STROKE_COLOR', 'Обводка']],
    SHADOW: [],
    TYPOGRAPHY: [],
  };
  const all = scopes.includes('ALL_SCOPES');
  const check = (label: string, on: boolean, toggle: (on: boolean) => void) => {
    const c = h('input', { type: 'checkbox', checked: on }) as HTMLInputElement;
    c.addEventListener('change', () => toggle(c.checked));
    return h('label', { class: 'chk-row' }, c, h('span', {}, label));
  };
  const scopeRows = SCOPES[type].length
    ? [
        check('Все поля', all, (on) => doc.transact(() => doc.set(v, { scopes: on ? ['ALL_SCOPES'] : [] }))),
        ...SCOPES[type].map(([s, label]) =>
          check(label, all || scopes.includes(s), (on) => {
            const cur = all ? SCOPES[type].map(([x]) => x) : scopes.filter((x) => x !== 'ALL_SCOPES');
            doc.transact(() => doc.set(v, { scopes: on ? [...new Set([...cur, s])] : cur.filter((x) => x !== s) }));
          }),
        ),
      ]
    : [h('div', { class: 'empty' }, type === 'BOOLEAN' ? 'Логические переменные подходят любым полям.' : type === 'SHADOW' ? 'Тени применяются к эффектам слоя целиком.' : 'Типографика применяется к тексту целиком.')];
  const code = doc.get(v, 'codeSyntax') ?? {};
  const codeRow = (platform: 'WEB' | 'ANDROID' | 'iOS') =>
    h('div', { class: 'field wide', title: `Имя в коде (${platform})` }, h('label', {}, platform === 'WEB' ? 'Web' : platform === 'ANDROID' ? 'Android' : 'iOS'), textInput(code[platform] ?? '', (s) => doc.transact(() => doc.set(v, { codeSyntax: { ...(doc.get(v, 'codeSyntax') ?? {}), [platform]: s.trim() || undefined } }))));
  // Number unit, as in CSS: rem — relative to the document's root font size; percentages and “unitless” — for text spacing.
  const unitRow: HTMLElement[] = [];
  if (type === 'FLOAT') {
    const sel = h(
      'select',
      { title: 'Единица значения' },
      ...(
        [
          ['', 'px (число)'],
          ['REM', 'rem — от корневого размера шрифта'],
          ['PERCENT', '% — межстрочный, межбуквенный'],
          ['MULTIPLIER', 'без единиц — множитель шрифта'],
        ] as const
      ).map(([val, label]) => h('option', { value: val, selected: (doc.get(v, 'unit') ?? '') === val }, label)),
    ) as HTMLSelectElement;
    sel.addEventListener('change', () => doc.transact(() => doc.set(v, { unit: (sel.value || undefined) as Props['unit'] })));
    unitRow.push(h('div', { class: 'nested-head' }, 'Единица'), h('div', { class: 'field wide' }, sel));
  }
  box.append(
    h('div', { class: 'pop-head' }, doc.get(v, 'name') ?? ''),
    h('div', { class: 'wide' }, textInput(doc.get(v, 'description') ?? '', (s) => doc.transact(() => doc.set(v, { description: s })), { placeholder: 'Описание', multiline: true, cls: 'desc' })),
    ...unitRow,
    h('div', { class: 'nested-head' }, 'Где применять'),
    ...scopeRows,
    h('div', { class: 'nested-head' }, 'Имена в коде'),
    codeRow('WEB'),
    codeRow('ANDROID'),
    codeRow('iOS'),
    check('Скрыть при публикации', !!doc.get(v, 'hiddenFromPublishing'), (on) => doc.transact(() => doc.set(v, { hiddenFromPublishing: on }))),
  );
}

/** “Variables” window: collections on the left, variables and modes as a table. */
export function openVariablesWindow(ed: Editor, focusCollection?: string | null) {
  closeWindow?.();
  const doc = ed.doc;
  let current = focusCollection && doc.has(focusCollection) ? focusCollection : (localCollections(doc)[0] ?? null);
  let q = '';
  /** Group on the left (“All” — null). */
  let group: string | null = null;
  /** Composite value edited in a row under the variable. */
  let expanded: { v: string; modeId: string } | null = null;
  const box = h('div', { class: 'var-window' });
  windowEl = box;
  const side = h('div', { class: 'var-side' });
  const main = h('div', { class: 'var-main' });
  const close = () => {
    stopDrag();
    box.remove();
    windowEl = null;
    closeWindow = null;
    unsub();
  };
  // Header — title, search, close; own extras (1 rem, expression hint) — in “…”.
  const HELP = 'Значение «=…» — выражение: «={Space/base} * 2», «=alpha({Brand/primary}, 0.5)». Правая кнопка по ячейке — ссылка на другую переменную; по коллекции слева — «Расширить (бренд)». Градиент, тени и типографика — составные: внутри — ссылки на цвета, числа и строки.';
  const more: HTMLButtonElement = iconBtn('more', 'Ещё: 1 rem документа, подсказка по выражениям', () =>
    showMenu(more, [
      {
        label: `1 rem = ${doc.get(doc.root, 'rootFontSize') ?? 16} px…`,
        run: () => {
          const n = parseNumber(prompt('Корневой размер шрифта документа: 1 rem в пикселях (переменные и поля в rem)', String(doc.get(doc.root, 'rootFontSize') ?? 16)) ?? '');
          if (Number.isFinite(n) && n > 0) doc.transact(() => doc.set(doc.root, { rootFontSize: n === 16 ? undefined : n }));
        },
      },
      {
        label: 'Выражения и ссылки…',
        run: () => popover(more, 'var-help-pop', { width: 320 }).box.append(h('p', { class: 'm-note', style: 'margin:12px' }, HELP)),
      },
    ]),
  'icon-btn sm');
  const head = h('div', { class: 'var-head' }, h('span', { class: 'var-title' }, 'Переменные'), searchInput('Поиск', (s) => {
    q = s;
    renderMain();
  }), more, iconBtn('chevronDown', 'Закрыть', close, 'pe-close'));
  (head.lastChild as HTMLElement).textContent = '×';
  box.append(head, h('div', { class: 'var-body' }, side, main));
  document.body.append(box);
  const stopDrag = draggableWindow(box, head);
  closeWindow = close;
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });

  const renderSide = () => {
    side.replaceChildren(
      h('div', { class: 'var-side-head' }, h('span', {}, 'Коллекции'), iconBtn('plus', 'Новая коллекция', () => {
        current = doc.transact(() => createCollection(doc, `Коллекция ${localCollections(doc).length + 1}`));
        group = null;
        render();
      }, 'icon-btn sm')),
    );
    // Base collections, each followed by its extensions (brands), indented.
    const all = localCollections(doc);
    const ordered: [string, number][] = [];
    const visit = (c: string, depth: number) => {
      ordered.push([c, depth]);
      for (const e of extensionsOf(doc, c)) if (depth < 6) visit(e, depth + 1);
    };
    for (const c of all) {
      const parent = doc.get(c, 'extendsCollection');
      if (!parent || !doc.has(parent)) visit(c, 0);
    }
    for (const [c, depth] of ordered) {
      const count = depth ? collectionVariables(doc, c).length : variablesIn(doc, c).length;
      const row = h(
        'div',
        { class: `var-coll${c === current ? ' on' : ''}${depth ? ' ext' : ''}`, style: depth ? `padding-left: ${12 + depth * 14}px` : '', title: depth ? `Расширение «${doc.get(doc.get(c, 'extendsCollection')!, 'name') ?? ''}»: переменные и режимы родителя, свои значения бренда` : '' },
        ...(depth ? [h('span', { class: 'var-ext-ic' }, '↳')] : []),
        h('span', { class: 'style-name' }, doc.get(c, 'name') ?? ''),
        h('span', { class: 'style-sub' }, String(count)),
      );
      row.addEventListener('click', () => {
        current = c;
        group = null;
        render();
      });
      row.addEventListener('dblclick', () => {
        const input = textInput(doc.get(c, 'name') ?? '', (s) => s.trim() && doc.transact(() => doc.set(c, { name: s.trim() })));
        row.replaceChildren(input);
        input.focus();
        input.select();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const exts = ordered.filter(([x, d]) => d > depth && collectionChain(doc, x).includes(c) && x !== c).map(([x]) => x);
        showMenuAt(e.clientX, e.clientY, [
          { label: 'Переименовать', run: () => row.dispatchEvent(new MouseEvent('dblclick')) },
          {
            label: 'Расширить (бренд)…',
            run: () => {
              current = doc.transact(() => extendCollection(doc, c, `${doc.get(c, 'name') ?? 'Коллекция'} — бренд ${extensionsOf(doc, c).length + 2}`));
              render();
            },
          },
          'sep',
          {
            label: exts.length ? `Удалить коллекцию и расширения (${exts.length})` : 'Удалить коллекцию',
            run: () =>
              doc.transact(() => {
                for (const x of [...exts].reverse()) {
                  for (const v of variablesIn(doc, x)) deleteVariable(doc, v);
                  doc.delete(x);
                }
                for (const v of variablesIn(doc, c)) deleteVariable(doc, v);
                doc.delete(c);
                if (current && !doc.has(current)) current = localCollections(doc)[0] ?? null;
              }),
          },
        ]);
      });
      side.append(row);
    }
    // Groups of the current collection (the part of the name before “/”): “All” and per group — table filter.
    if (current && doc.has(current)) {
      const vars = doc.get(current, 'extendsCollection') ? collectionVariables(doc, current) : variablesIn(doc, current);
      const counts = new Map<string, number>();
      for (const v of vars) {
        const name = doc.get(v, 'name') ?? '';
        const i = name.lastIndexOf('/');
        if (i > 0) counts.set(name.slice(0, i), (counts.get(name.slice(0, i)) ?? 0) + 1);
      }
      if (group !== null && !counts.has(group)) group = null;
      const groupRow = (g: string | null, label: string, n: number) => {
        const row = h('div', { class: `var-coll var-grp${g === group ? ' on' : ''}` }, h('span', { class: 'style-name' }, label), h('span', { class: 'style-sub' }, String(n)));
        row.addEventListener('click', () => {
          group = g;
          render();
        });
        return row;
      };
      side.append(h('div', { class: 'var-side-head groups' }, h('span', {}, 'Группы')), groupRow(null, t('Все'), vars.length), ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([g, n]) => groupRow(g, g, n)));
    }
  };

  const renderMain = () => {
    main.replaceChildren();
    if (!current || !doc.has(current)) {
      main.append(h('div', { class: 'empty' }, 'Коллекций нет. «+ Коллекция» слева: в коллекции — переменные и режимы (например, светлая и тёмная тема).'));
      return;
    }
    const c = current;
    const modes = doc.get(c, 'modes') ?? [];
    const def = defaultMode(doc, c);
    const isExt = !!doc.get(c, 'extendsCollection');
    const grid = h('div', { class: 'var-grid' });
    grid.style.gridTemplateColumns = `minmax(160px, 1.2fr) repeat(${modes.length}, minmax(150px, 1fr)) 36px`;
    // Header: name and modes.
    grid.append(h('div', { class: 'var-th' }, 'Имя'));
    for (const m of modes) {
      const th = h('div', { class: 'var-th', title: m.modeId === def ? 'Режим по умолчанию' : 'Двойной щелчок — переименовать, правая кнопка — меню' }, m.name + (m.modeId === def ? ' ·' : ''));
      th.addEventListener('dblclick', () => {
        const input = textInput(m.name, (s) => s.trim() && doc.transact(() => renameMode(doc, c, m.modeId, s.trim())));
        th.replaceChildren(input);
        input.focus();
        input.select();
      });
      th.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenuAt(e.clientX, e.clientY, [
          { label: 'Переименовать', run: () => th.dispatchEvent(new MouseEvent('dblclick')) },
          { label: 'Режим по умолчанию', disabled: m.modeId === def, run: () => doc.transact(() => doc.set(c, { defaultModeId: m.modeId })) },
          { label: 'Удалить режим', disabled: modes.length < 2 || isExt, run: () => doc.transact(() => removeMode(doc, c, m.modeId)) },
        ]);
      });
      grid.append(th);
    }
    grid.append(h('div', { class: 'var-th' }, isExt ? '' : iconBtn('plus', 'Добавить режим', () => doc.transact(() => addMode(doc, c, `Режим ${modes.length + 1}`)), 'icon-btn sm')));
    // Variables by group.
    let rowGroup: string | null = null;
    const inGroup = (v: string) => group === null || (doc.get(v, 'name') ?? '').startsWith(`${group}/`);
    const vars = (isExt ? collectionVariables(doc, c) : variablesIn(doc, c)).filter((v) => inGroup(v) && (!q || (doc.get(v, 'name') ?? '').toLowerCase().includes(q)));
    vars.sort((a, b) => (doc.get(a, 'name') ?? '').localeCompare(doc.get(b, 'name') ?? ''));
    for (const v of vars) {
      const name = doc.get(v, 'name') ?? '';
      const i = name.lastIndexOf('/');
      const g = i > 0 ? name.slice(0, i) : '';
      if (g !== rowGroup) {
        rowGroup = g;
        if (g) grid.append(h('div', { class: 'var-group', style: `grid-column: 1 / -1` }, g));
      }
      const type = doc.get(v, 'resolvedType') ?? 'FLOAT';
      const label = h('div', { class: 'var-name-cell', title: `${TYPE_LABEL[type]}: ${name}${doc.get(v, 'description') ? '\n' + doc.get(v, 'description') : ''}` }, svgEl('span', { class: 'prop-ic' }, type === 'COLOR' ? ICON.styles : type === 'BOOLEAN' ? ICON.toggleProp : type === 'STRING' ? ICON.textProp : ICON.variable), h('span', { class: 'style-name' }, short(name)));
      label.addEventListener('dblclick', () => {
        const input = textInput(name, (s) => s.trim() && doc.transact(() => doc.set(v, { name: s.trim() })));
        label.replaceChildren(input);
        input.focus();
        input.select();
      });
      grid.append(label);
      // A parent's variable in an extension — brand values; editing the variable itself — on the parent.
      const parentVar = isExt && collectionOf(doc, v) !== c;
      for (const m of modes)
        grid.append(
          valueCell(ed, v, m.modeId, parentVar ? c : undefined, () => {
            expanded = expanded?.v === v && expanded.modeId === m.modeId ? null : { v, modeId: m.modeId };
            renderMain();
          }),
        );
      // Editing a composite value — in a full-width row.
      const editRow = () => {
        const ex = expanded;
        if (!ex || ex.v !== v || !modes.some((m) => m.modeId === ex.modeId)) return;
        const ext = parentVar ? c : undefined;
        const value = ext ? variableValueIn(doc, v, ext, ex.modeId) : (doc.get(v, 'valuesByMode') ?? {})[ex.modeId];
        if (!isComposite(value)) return;
        const coll = ext ?? collectionOf(doc, v);
        const set = (x: VariableValue) => doc.transact(() => (ext ? setVariableOverride(doc, ext, v, ex.modeId, x) : setVariableValue(doc, v, ex.modeId, x)));
        const mode = modes.find((m) => m.modeId === ex.modeId)!;
        grid.append(
          h(
            'div',
            { class: 'var-comp-cell', style: 'grid-column: 1 / -1' },
            h('div', { class: 'var-comp-head' }, `${short(name)} · ${mode.name}`, iconBtn('chevronDown', 'Свернуть', () => { expanded = null; renderMain(); }, 'icon-btn sm')),
            compositeEditor(ed, value, set, (id) => resolveVariable(doc, id, null, 0, coll ? { [coll]: ex.modeId } : undefined), `comp:${v}:${ex.modeId}`),
          ),
        );
      };
      if (parentVar) {
        const home = collectionOf(doc, v)!;
        const back = iconBtn('more', 'Подробнее', () =>
          showMenu(back, [
            {
              label: `Открыть в «${doc.get(home, 'name') ?? ''}»`,
              run: () => {
                current = home;
                render();
              },
            },
            {
              label: 'Как у родителя во всех режимах',
              disabled: !doc.get(c, 'variableOverrides')?.[v],
              run: () => doc.transact(() => modes.forEach((m) => setVariableOverride(doc, c, v, m.modeId, undefined))),
            },
          ]),
        'icon-btn sm');
        grid.append(back);
        editRow();
        continue;
      }
      // “Edit” on row hover and right click — the same menu as “…”.
      const edit = iconBtn('settings', 'Изменить переменную: описание, области, имя в коде', () => detailsPopover(ed, edit, v), 'icon-btn sm var-edit');
      label.append(edit);
      label.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenuAt(e.clientX, e.clientY, rowMenu());
      });
      const rowMenu = (): MenuEntry[] => [
          { label: 'Изменить переменную…', run: () => detailsPopover(ed, edit, v) },
          { label: 'Переименовать', run: () => label.dispatchEvent(new MouseEvent('dblclick')) },
          {
            label: 'Дублировать',
            run: () =>
              doc.transact(() => {
                const copy = createVariable(doc, `${name} копия`, c, type);
                doc.set(copy, { valuesByMode: { ...(doc.get(v, 'valuesByMode') ?? {}) }, scopes: doc.get(v, 'scopes'), description: doc.get(v, 'description') });
              }),
          },
          { label: 'Удалить', run: () => doc.transact(() => deleteVariable(doc, v)) },
        ];
      const more = iconBtn('more', 'Подробнее', () => showMenu(more, rowMenu()), 'icon-btn sm');
      grid.append(more);
      editRow();
    }
    const add = h('button', { class: 'var-add var-create' }, '+ Создать переменную');
    // Composites — from the selected layer, if it has something to take (gradient, shadows, text formatting).
    const fromSelection = (t: VariableType): VariableValue | undefined => {
      const id = ed.selection.find((x) => doc.has(x));
      if (!id) return undefined;
      if (t === 'GRADIENT') {
        const p = (doc.get(id, 'fills') ?? []).find((x) => x.type.startsWith('GRADIENT') && x.visible !== false);
        return p ? gradientValueOf(p as GradientPaint) : undefined;
      }
      if (t === 'SHADOW') {
        const sh = shadowValueOf(doc.get(id, 'effects'));
        return sh.shadows.length ? sh : undefined;
      }
      if (t === 'TYPOGRAPHY' && doc.type(id) === 'TEXT') return typographyValueOf(doc.props(id));
      return undefined;
    };
    add.addEventListener('click', () =>
      showMenu(add, [
        ...(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'] as VariableType[]).map((t) => ({
          label: TYPE_LABEL[t],
          run: () => doc.transact(() => createVariable(doc, `${group ? `${group}/` : ''}${TYPE_LABEL[t]} ${localVariables(doc, t).length + 1}`, c, t, t === 'COLOR' ? { r: 1, g: 1, b: 1, a: 1 } : undefined)),
        })),
        'sep' as const,
        ...(['GRADIENT', 'SHADOW', 'TYPOGRAPHY'] as VariableType[]).map((t) => {
          const value = fromSelection(t);
          return {
            label: `${TYPE_LABEL[t]}${value ? ' — из выделенного' : ''}`,
            run: () => {
              const nv = doc.transact(() => createVariable(doc, `${TYPE_LABEL[t]} ${localVariables(doc, t).length + 1}`, c, t, value));
              expanded = { v: nv, modeId: defaultMode(doc, c) };
              renderMain();
            },
          };
        }),
      ]),
    );
    // For an extension (brand) — a hint under the table; the general one — a “?” icon in the header.
    const hint = isExt
      ? `Расширение «${doc.get(doc.get(c, 'extendsCollection')!, 'name') ?? ''}»: переменные и режимы — родителя, тусклые значения — его же. Правка ячейки — своё значение бренда, правая кнопка — «Как у родителя». Бренд у фрейма — справа, в «Режимах».`
      : '';
    main.append(grid, add, ...(hint ? [h('div', { class: 'empty' }, hint)] : []));
  };

  const render = () => {
    renderSide();
    renderMain();
  };
  // Variable edits (and undo) — redraw if focus is not in a window field.
  let timer = 0;
  const onOps = (ops: Parameters<Editor['onDocument'][number]>[0]) => {
    if (!ops.some((o) => o.op !== 'blob' && (o.op === 'delete' || ['VARIABLE', 'VARIABLE_COLLECTION'].includes(doc.type(o.id) ?? '')))) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (box.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
      render();
    }, 60);
  };
  ed.onDocument.push(onOps);
  const unsub = () => {
    const i = ed.onDocument.indexOf(onOps);
    if (i >= 0) ed.onDocument.splice(i, 1);
  };
  render();
}
