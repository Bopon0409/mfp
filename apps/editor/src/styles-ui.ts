// Styles in the UI:
// - local styles — in the right panel when nothing is selected: by type and group (“/” in the name);
//   click — edit the style in the same panel, right click — rename, delete;
// - styles button in the fill, stroke, effects, grids and text sections: pick a style or
//   create one from the layer's values; an applied style — a row with the name and a “Detach” button.

import { applyStyle, createStyle, deleteStyle, localStyles, styleLeafName, styleValues, valuesForStyle, type Document, type Paint, type StyleField, type StyleType } from '@mfp/core';
import type { Editor } from './editor.ts';
import { h, iconBtn, popover, searchInput, svgEl, textInput } from './dom.ts';
import { ICON } from './icons.ts';
import { freeformCss } from './freeform.ts';
import { showMenu, showMenuAt } from './menu.ts';

export const STYLE_TYPE_LABEL: Record<StyleType, string> = { TEXT: 'Стили текста', PAINT: 'Стили цвета', EFFECT: 'Стили эффектов', GRID: 'Стили сеток' };
const NEW_NAME: Record<StyleType, string> = { TEXT: 'Текст', PAINT: 'Цвет', EFFECT: 'Эффект', GRID: 'Направляющие' };

const css = (c: { r: number; g: number; b: number }, a = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;

/** CSS background for a paint (swatch). */
export function paintCss(p: Paint | undefined): string {
  if (!p) return 'transparent';
  if (p.type === 'SOLID') return css(p.color, p.opacity ?? 1);
  if (p.type === 'IMAGE' || p.type === 'VIDEO' || p.type === 'LOTTIE' || p.type === 'MODEL3D') return 'repeating-conic-gradient(#888 0 25%, #bbb 0 50%) 0 0 / 8px 8px';
  if (p.type === 'PATTERN') return 'radial-gradient(circle, #666 30%, transparent 34%) 0 0 / 6px 6px, #ddd';
  if (p.type === 'SHADER') return 'conic-gradient(from 45deg, #ff6b4a, #ffc24b, #2dd4bf, #6b5bff, #ff6b4a)';
  if (p.type === 'GRADIENT_FREEFORM') return freeformCss(p);
  const stops = [...p.gradientStops].sort((a, b) => a.position - b.position).map((s) => `${css(s.color, (s.color.a ?? 1) * (p.opacity ?? 1))} ${Math.round(s.position * 100)}%`);
  return p.type === 'GRADIENT_LINEAR' ? `linear-gradient(90deg, ${stops.join(', ')})` : p.type === 'GRADIENT_ANGULAR' ? `conic-gradient(${stops.join(', ')})` : `radial-gradient(${stops.join(', ')})`;
}

/** Style swatch: color, “Aa” in the right font, effect or grid icon. */
export function stylePreview(doc: Document, id: string): HTMLElement {
  const type = doc.get(id, 'styleType');
  if (type === 'PAINT') {
    const fills = (doc.get(id, 'fills') ?? []).filter((p) => p.visible !== false);
    const el = h('span', { class: 'style-prev swatch-prev' });
    el.style.background = fills.length ? fills.map((p) => paintCss(p).replace(/^rgba\((.*)\)$/, 'linear-gradient(rgba($1), rgba($1))')).reverse().join(', ') : 'transparent';
    return el;
  }
  if (type === 'TEXT') {
    const f = doc.get(id, 'fontName');
    const el = h('span', { class: 'style-prev text-prev' }, 'Аа');
    if (f) {
      el.style.fontFamily = `${JSON.stringify(f.family)}, sans-serif`;
      if (/bold|black|heavy|semi/i.test(f.style)) el.style.fontWeight = '700';
      if (/italic/i.test(f.style)) el.style.fontStyle = 'italic';
    }
    return el;
  }
  return svgEl('span', { class: 'style-prev icon-prev' }, type === 'EFFECT' ? ICON.effects : ICON.frame);
}

/** Text style label: “Inter 16/24”. */
export function styleSubtitle(doc: Document, id: string): string {
  if (doc.get(id, 'styleType') !== 'TEXT') return '';
  const f = doc.get(id, 'fontName');
  const lh = doc.get(id, 'lineHeight');
  const size = doc.get(id, 'fontSize') ?? 12;
  const line = !lh || lh.unit === 'AUTO' ? 'авто' : lh.unit === 'PIXELS' ? String(+lh.value.toFixed(2)) : `${+lh.value.toFixed(1)}%`;
  return `${f?.family ?? ''} ${f?.style ?? ''} · ${+size.toFixed(2)}/${line}`;
}

/** Styles of one type grouped by “/”. */
export function groupedStyles(doc: Document, ids: string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const name = doc.get(id, 'name') ?? '';
    const i = name.lastIndexOf('/');
    const g = i > 0 ? name.slice(0, i).trim() : '';
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    list.push(id);
  }
  return [...groups];
}

/** Style row in lists. */
export function styleItem(doc: Document, id: string, onClick: () => void, current?: string | null): HTMLElement {
  const sub = styleSubtitle(doc, id);
  const row = h(
    'div',
    { class: `style-item${id === current ? ' current' : ''}`, title: doc.get(id, 'description') || (doc.get(id, 'name') ?? '') },
    stylePreview(doc, id),
    h('span', { class: 'style-name' }, styleLeafName(doc.get(id, 'name') ?? '')),
    sub ? h('span', { class: 'style-sub' }, sub) : '',
  );
  row.addEventListener('click', onClick);
  return row;
}

/** Style types for a layer field. */
export const STYLE_TYPE_OF_FIELD: Record<StyleField, StyleType> = { fillStyleId: 'PAINT', strokeStyleId: 'PAINT', textStyleId: 'TEXT', effectStyleId: 'EFFECT', gridStyleId: 'GRID' };

/**
 * Section styles window: pick one (apply to all selected) or create one from the values
 * of the first selected layer.
 */
export function openStylePicker(ed: Editor, anchor: HTMLElement, field: StyleField, sel: string[]) {
  const doc = ed.doc;
  const type = STYLE_TYPE_OF_FIELD[field];
  const { box, close } = popover(anchor, 'picker', { width: 260, side: 'left' });
  if (!box.isConnected) return;
  const current = sel.every((id) => doc.get(id, field) === doc.get(sel[0]!, field)) ? doc.get(sel[0]!, field) : null;
  const list = h('div', { class: 'pop-list' });
  const apply = (styleId: string) => {
    close();
    doc.transact(() => sel.forEach((id) => applyStyle(doc, id, field, styleId)));
  };
  const render = (q: string) => {
    list.replaceChildren();
    const all = localStyles(doc, type).filter((s) => !q || (doc.get(s, 'name') ?? '').toLowerCase().includes(q));
    for (const [g, ids] of groupedStyles(doc, all)) {
      if (g) list.append(h('div', { class: 'asset-group' }, g));
      for (const id of ids) list.append(styleItem(doc, id, () => apply(id), current));
    }
    if (!all.length) list.append(h('div', { class: 'empty' }, q ? 'Ничего не найдено' : 'Стилей этого типа нет. «+» — создать из значений слоя.'));
  };
  const create = iconBtn('plus', 'Создать стиль из значений слоя', () => {
    const name = textInput(`${NEW_NAME[type]} ${localStyles(doc, type).length + 1}`, (v) => {
      const n = v.trim();
      if (!n) return;
      close();
      doc.transact(() => {
        const s = createStyle(doc, type, n, valuesForStyle(doc, sel[0]!, field));
        for (const id of sel) applyStyle(doc, id, field, s);
      });
    });
    head.replaceWith(h('div', { class: 'pop-head' }, name));
    name.focus();
    name.select();
  }, 'icon-btn sm');
  const head = h('div', { class: 'pop-head row-head' }, h('span', {}, STYLE_TYPE_LABEL[type]), create);
  const search = searchInput('Поиск стиля', render);
  box.append(head, search, list);
  render('');
  setTimeout(() => search.focus(), 0);
}

/**
 * Applied style: swatch, name, “Detach” (values stay in the layer). Clicking the name —
 * edit the style (open).
 */
export function appliedStyleRow(ed: Editor, sel: string[], field: StyleField, open: (styleId: string) => void): HTMLElement | null {
  const doc = ed.doc;
  const id = doc.get(sel[0]!, field);
  if (!id || !doc.has(id) || doc.type(id) !== 'STYLE' || !sel.every((s) => doc.get(s, field) === id)) return null;
  const detach = iconBtn('unlink', 'Отвязать стиль (значения останутся)', () => doc.transact(() => sel.forEach((s) => applyStyle(doc, s, field, ''))), 'icon-btn sm');
  const name = h('button', { class: 'style-applied', title: 'Изменить стиль' }, stylePreview(doc, id), h('span', { class: 'style-name' }, doc.get(id, 'name') ?? ''));
  name.addEventListener('click', () => open(id));
  return h('div', { class: 'style-row wide' }, name, detach);
}

/** Whether the selected layers have different styles for this field (or some have a style and some don't). */
export function mixedStyle(doc: Document, sel: string[], field: StyleField): boolean {
  const first = doc.get(sel[0]!, field) ?? '';
  return sel.some((id) => (doc.get(id, field) ?? '') !== first);
}

/** Local styles (nothing selected): by type; click — edit, right click — menu. */
export function localStylesSection(ed: Editor, open: (styleId: string) => void): HTMLElement {
  const doc = ed.doc;
  const blocks: HTMLElement[] = [];
  const add = iconBtn('plus', 'Новый стиль', () =>
    showMenu(
      add,
      (['PAINT', 'TEXT', 'EFFECT', 'GRID'] as StyleType[]).map((t) => ({
        label: STYLE_TYPE_LABEL[t].replace('Стили', 'Стиль'),
        run: () => {
          const values =
            t === 'PAINT'
              ? { fills: [{ type: 'SOLID' as const, color: { r: 0.302, g: 0.482, b: 0.992 } }] }
              : t === 'EFFECT'
                ? { effects: [{ type: 'DROP_SHADOW' as const, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL' as const }] }
                : t === 'GRID'
                  ? { layoutGrids: [{ pattern: 'COLUMNS' as const, alignment: 'STRETCH' as const, count: 12, gutterSize: 20, offset: 20, sectionSize: 60, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } }] }
                  : { fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16, lineHeight: { unit: 'PIXELS' as const, value: 24 } };
          const id = doc.transact(() => createStyle(doc, t, `${NEW_NAME[t]} ${localStyles(doc, t).length + 1}`, values));
          open(id);
        },
      })),
    ),
  );
  for (const t of ['TEXT', 'PAINT', 'EFFECT', 'GRID'] as StyleType[]) {
    const ids = localStyles(doc, t);
    if (!ids.length) continue;
    const list = h('div', { class: 'style-list' });
    for (const [g, group] of groupedStyles(doc, ids)) {
      if (g) list.append(h('div', { class: 'asset-group' }, g));
      for (const id of group) {
        const item = styleItem(doc, id, () => open(id));
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showMenuAt(e.clientX, e.clientY, [
            { label: 'Изменить', run: () => open(id) },
            { label: 'Удалить стиль', run: () => doc.transact(() => deleteStyle(doc, id)) },
          ]);
        });
        list.append(item);
      }
    }
    blocks.push(h('div', { class: 'style-block' }, h('div', { class: 'nested-head' }, STYLE_TYPE_LABEL[t]), list));
  }
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, h('span', {}, 'Локальные стили'), h('span', { class: 'h-acts' }, add)),
    ...(blocks.length ? blocks : [h('div', { class: 'empty' }, 'Стилей нет. «+» — новый стиль; или кнопка стилей в разделе заливки, текста, эффектов.')]),
  );
}

/** Style edit header: back, name, description. */
export function styleEditorHead(ed: Editor, id: string, back: () => void): HTMLElement {
  const doc = ed.doc;
  const name = textInput(doc.get(id, 'name') ?? '', (v) => v.trim() && doc.transact(() => doc.set(id, { name: v.trim() })));
  const desc = textInput(doc.get(id, 'description') ?? '', (v) => doc.transact(() => doc.set(id, { description: v })), { placeholder: 'Описание', multiline: true, cls: 'desc' });
  const users = ed.components.styleUsersOf(id).length;
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, h('span', { class: 'h-acts left' }, iconBtn('chevronRight', 'Назад к стилям', back, 'icon-btn sm back'), h('span', {}, STYLE_TYPE_LABEL[doc.get(id, 'styleType') ?? 'PAINT'].replace('Стили', 'Стиль'))), h('span', { class: 'h-acts' }, iconBtn('minus', 'Удалить стиль', () => {
      doc.transact(() => deleteStyle(doc, id));
      back();
    }))),
    h('div', { class: 'props comp-props' }, h('div', { class: 'field wide' }, name), h('div', { class: 'wide' }, desc), h('div', { class: 'empty wide', style: 'padding:0' }, users ? `Используют слоёв: ${users}` : 'Пока не используется')),
  );
}

/** Style values for a layer (for preview and comparison). */
export const styleValuesFor = styleValues;
