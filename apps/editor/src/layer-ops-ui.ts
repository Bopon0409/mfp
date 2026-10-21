// Menu items for layer and text operations (MFP's own): layer and variant order (sort, reverse), swap two layers,
// split and join texts, invert colors. Logic is in @mfp/editing/layer-ops.ts.

import { multiply, type Matrix } from '@mfp/core';
import { invertColors, joinTexts, reverseOrder, sortByName, sortByPosition, textPartProps, textPieces } from '@mfp/editing';
import { swapPositions } from './arrange.ts';
import type { Editor } from './editor.ts';
import type { MenuEntry } from './menu.ts';

/** Top-left corner of the layer on the page. */
function topLeft(ed: Editor, id: string): [number, number] {
  const pts = ed.corners(id);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
}

/** The “Layer order” submenu for the selection. */
export function orderMenu(ed: Editor, sel: string[]): MenuEntry {
  const doc = ed.doc;
  const run = (fn: () => void) => () => doc.transact(fn);
  // A variant set: sort its variants (request “sort variants alphabetically”).
  const set = sel.length === 1 && doc.type(sel[0]!) === 'COMPONENT_SET' ? sel[0]! : null;
  const variants = set ? doc.children(set) : [];
  return {
    label: 'Порядок слоёв',
    submenu: [
      { label: 'Поменять местами', disabled: sel.length !== 2, run: () => swapPositions(ed, sel) },
      'sep',
      { label: 'Обратный порядок', disabled: sel.length < 2, run: run(() => reverseOrder(doc, sel)) },
      { label: 'По имени: А → Я', disabled: sel.length < 2, run: run(() => sortByName(doc, sel)) },
      { label: 'По имени: Я → А', disabled: sel.length < 2, run: run(() => sortByName(doc, sel, true)) },
      { label: 'По положению на холсте', disabled: sel.length < 2, run: run(() => sortByPosition(doc, sel, (id) => topLeft(ed, id))) },
      ...(set
        ? (['sep', { label: 'Варианты по имени: А → Я', run: run(() => sortByName(doc, variants)) }, { label: 'Варианты по имени: Я → А', run: run(() => sortByName(doc, variants, true)) }] as MenuEntry[])
        : []),
    ],
  };
}

/**
 * Split text into lines or words: each part becomes its own text in the same place (run styling
 * is preserved), the original is deleted. The parts get selected.
 */
export function splitText(ed: Editor, id: string, by: 'lines' | 'words'): string[] {
  const doc = ed.doc;
  const chars = doc.get(id, 'characters') ?? '';
  const pieces = textPieces(chars, by);
  if (pieces.length < 2) return [id];
  const boxes = ed.textBoxes(id, pieces);
  if (!boxes) return [id];
  const parent = doc.parent(id)!;
  const index = doc.children(parent).indexOf(id);
  const t = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
  const made = doc.transact(() => {
    const out: string[] = [];
    pieces.forEach(([a, b], k) => {
      const r = boxes.rects[k]![0];
      const [x, y] = r ? [r[0], r[1]] : [0, 0];
      const props = textPartProps(doc, id, a, b);
      // The part's top-left corner stays where it was inside the original block.
      props.transform = multiply(t, [1, 0, x, 0, 1, y]);
      props.textAlignHorizontal = 'LEFT';
      props.textAlignVertical = 'TOP';
      out.push(doc.create('TEXT', parent, props, index + k + 1));
    });
    doc.delete(id);
    return out;
  });
  ed.select(made);
  return made;
}

/** Menu items for the selected texts. */
export function textOpsMenu(ed: Editor, sel: string[]): MenuEntry[] {
  const doc = ed.doc;
  const texts = sel.filter((id) => doc.type(id) === 'TEXT');
  if (!texts.length) return [];
  const items: MenuEntry[] = [];
  if (texts.length === 1) {
    items.push({
      label: 'Разрезать текст',
      submenu: [
        { label: 'По строкам', run: () => splitText(ed, texts[0]!, 'lines') },
        { label: 'По словам', run: () => splitText(ed, texts[0]!, 'words') },
      ],
    });
  }
  if (texts.length > 1) {
    items.push({
      label: 'Склеить тексты',
      run: () => {
        // By position on the canvas: top to bottom, left to right.
        const order = [...texts].sort((a, b) => {
          const [ax, ay] = topLeft(ed, a);
          const [bx, by] = topLeft(ed, b);
          return Math.abs(ay - by) > 1 ? ay - by : ax - bx;
        });
        const kept = doc.transact(() => joinTexts(doc, order, '\n'));
        if (kept) ed.select([kept]);
      },
    });
  }
  return items;
}


/** The “Invert colors” submenu (MFP's own; request “invert colors feature”). */
export function invertMenu(ed: Editor, sel: string[], notify: (m: string) => void): MenuEntry {
  const run = (mode: 'rgb' | 'lightness') => () => {
    const n = ed.doc.transact(() => invertColors(ed.doc, sel, mode));
    notify(n ? `Инвертировано цветов: ${n}` : 'Нечего инвертировать: цвета из переменных и картинки не меняются');
  };
  return {
    label: 'Инвертировать цвета',
    submenu: [
      { label: 'Полностью', run: run('rgb') },
      { label: 'Только светлоту — черновик тёмной темы', run: run('lightness') },
    ],
  };
}
