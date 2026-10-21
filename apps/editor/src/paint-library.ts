// “Libraries” tab of the paint popup: search, the file's color styles and color variables by
// collection. Clicking a style applies the fill or stroke style to the selection; clicking a
// variable binds this paint to the variable.

import { localStyles, type Document } from '@mfp/core';
import type { Editor } from './editor.ts';
import { h, searchInput } from './dom.ts';
import { groupedStyles, styleItem } from './styles-ui.ts';
import { variableCandidates, variableItem } from './variables-ui.ts';

export interface PaintLibraryOptions {
  /** Field for matching variables (fills / strokes) and the layer in which to resolve values. */
  field: string;
  nodeId: string | null;
  nodeType?: string;
  currentStyle: string | null;
  currentVariable: string | null;
  onStyle(id: string): void;
  onVariable(id: string): void;
}

export function paintLibrary(ed: Editor, opts: PaintLibraryOptions): HTMLElement {
  const doc: Document = ed.doc;
  const list = h('div', { class: 'pe-lib-list' });
  const render = (q: string) => {
    list.replaceChildren();
    const match = (id: string) => !q || (doc.get(id, 'name') ?? '').toLowerCase().includes(q);
    let n = 0;
    const styles = localStyles(doc, 'PAINT').filter(match);
    if (styles.length) {
      list.append(h('div', { class: 'asset-group' }, 'Стили цвета'));
      for (const [g, ids] of groupedStyles(doc, styles)) {
        if (g) list.append(h('div', { class: 'asset-group sub' }, g));
        for (const id of ids) list.append(styleItem(doc, id, () => opts.onStyle(id), opts.currentStyle));
      }
      n += styles.length;
    }
    for (const [c, groups] of variableCandidates(doc, ['COLOR', 'GRADIENT'], opts.field, opts.nodeType)) {
      const rows: HTMLElement[] = [];
      for (const [g, ids] of groups) {
        const found = ids.filter(match);
        if (!found.length) continue;
        if (g) rows.push(h('div', { class: 'asset-group sub' }, g));
        for (const v of found) rows.push(variableItem(doc, v, opts.nodeId, () => opts.onVariable(v), opts.currentVariable));
        n += found.length;
      }
      if (rows.length) list.append(h('div', { class: 'asset-group' }, doc.get(c, 'name') ?? ''), ...rows);
    }
    if (!n) list.append(h('div', { class: 'empty' }, q ? 'Ничего не найдено' : 'В файле нет стилей цвета и цветовых переменных.'));
  };
  const search = searchInput('Поиск стилей и переменных', render);
  render('');
  return h('div', { class: 'pe-lib' }, search, list);
}
