// Colored layer labels (MFP's own; like layer labels in Photoshop and After Effects). A label is the labelColor layer property: a strip and a light background
// of the row in the layers list, the frame name color on the canvas. Layer menu: “Label” to pick a color, clear it,
// or select all layers on the page with the same label. A label does not affect the design's appearance or export.

import type { Document, LayerLabel } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { MenuEntry } from './menu.ts';

/** Menu order, label and color (equally readable in light and dark themes). */
export const LABELS: readonly [LayerLabel, string, string][] = [
  ['RED', 'Красная', '#e5484d'],
  ['ORANGE', 'Оранжевая', '#f76b15'],
  ['YELLOW', 'Жёлтая', '#e2a336'],
  ['GREEN', 'Зелёная', '#30a46c'],
  ['BLUE', 'Синяя', '#0d74ce'],
  ['VIOLET', 'Фиолетовая', '#8e4ec6'],
  ['GRAY', 'Серая', '#8b8d98'],
];

const COLOR = new Map(LABELS.map(([k, , c]) => [k, c]));
const NAME = new Map(LABELS.map(([k, n]) => [k, n]));

/** Layer label color (CSS) or undefined. */
export function labelColor(doc: Document, id: string): string | undefined {
  const l = doc.get(id, 'labelColor');
  return l ? COLOR.get(l) : undefined;
}

/** Layers on the page with this label (in tree order). */
export function labeledLayers(doc: Document, pageId: string, label: LayerLabel): string[] {
  return [...doc.descendants(pageId)].filter((id) => doc.get(id, 'labelColor') === label);
}

/** Set (or clear with null) the label on layers in one undo step. */
export function setLabel(doc: Document, ids: readonly string[], label: LayerLabel | null) {
  doc.transact(() => {
    for (const id of ids) if (doc.has(id)) doc.set(id, { labelColor: label ?? undefined });
  });
}

const dot = (c: string) => `<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="5" fill="${c}"/></svg>`;

/** The “Label” menu item for the selected layers. */
export function labelMenu(ed: Editor, sel: readonly string[]): MenuEntry {
  const doc = ed.doc;
  const current = new Set(sel.map((id) => doc.get(id, 'labelColor') ?? null));
  const only = current.size === 1 ? [...current][0]! : undefined;
  return {
    label: 'Метка',
    submenu: () => {
      const items: MenuEntry[] = LABELS.map(([k, name, c]) => ({ label: name, icon: dot(c), checked: only === k, run: () => setLabel(doc, sel, k) }));
      items.push({ label: 'Без метки', disabled: current.size === 1 && only === null, run: () => setLabel(doc, sel, null) }, 'sep');
      const used = new Set([...doc.descendants(ed.pageId)].map((id) => doc.get(id, 'labelColor')).filter(Boolean));
      for (const [k, , c] of LABELS) {
        if (!used.has(k)) continue;
        items.push({ label: `Выделить: ${NAME.get(k)!.toLowerCase()}`, icon: dot(c), run: () => ed.select(labeledLayers(doc, ed.pageId, k)) });
      }
      return items;
    },
  };
}
