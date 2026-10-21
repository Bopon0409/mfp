// Styling of the file's new texts and shapes (our own). “Use as style for new texts” takes from
// the selected text its font, size, spacing, alignment, color and text style; the “Text” tool
// then creates texts this way. Stored in the file (root property defaultTextStyle).

import type { Document, Props } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { MenuEntry } from './menu.ts';

/** What carries over to new texts. */
export const DEFAULT_TEXT_KEYS = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'textCase', 'textDecoration', 'textAlignHorizontal', 'fills', 'textStyleId'] as const;

/** Properties for a new text ({} — as usual). */
export function defaultTextProps(doc: Document): Props {
  const d = doc.get(doc.root, 'defaultTextStyle') as Props | undefined;
  if (!d) return {};
  const out: Props = {};
  for (const k of DEFAULT_TEXT_KEYS) if (d[k] !== undefined) (out as Record<string, unknown>)[k] = structuredClone(d[k]);
  // The style was deleted — no reference to it (values remain).
  if (out.textStyleId && !doc.has(out.textStyleId)) delete out.textStyleId;
  return out;
}

/** Remember the styling of text id (null — reset). */
export function setDefaultText(doc: Document, id: string | null) {
  doc.transact(() => {
    if (!id) return doc.set(doc.root, { defaultTextStyle: undefined });
    const p = doc.props(id);
    const d: Record<string, unknown> = {};
    for (const k of DEFAULT_TEXT_KEYS) if (p[k] !== undefined) d[k] = structuredClone(p[k]);
    doc.set(doc.root, { defaultTextStyle: d as Props });
  });
}

/** What carries over to new shapes (rectangle, ellipse, polygon, star). */
export const DEFAULT_SHAPE_KEYS = ['fills', 'strokes', 'strokeWeight', 'strokeAlign', 'cornerRadius', 'effects', 'opacity'] as const;
const SHAPES = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR']);

/**
 * Styling of the file's new shapes (our own; request “customize my default shape starting color”): instead of
 * the gray fill — the sample's fill, stroke, corner radius, effects. {} — as usual.
 */
export function defaultShapeProps(doc: Document, type: string): Props {
  const d = doc.get(doc.root, 'defaultShapeStyle') as Props | undefined;
  if (!d || !SHAPES.has(type)) return {};
  const out: Props = {};
  for (const k of DEFAULT_SHAPE_KEYS) if (d[k] !== undefined) (out as Record<string, unknown>)[k] = structuredClone(d[k]);
  // Corner radius — only for rectangles.
  if (type !== 'RECTANGLE') delete out.cornerRadius;
  return out;
}

/** Remember the styling of shape id (null — reset). */
export function setDefaultShape(doc: Document, id: string | null) {
  doc.transact(() => {
    if (!id) return doc.set(doc.root, { defaultShapeStyle: undefined });
    const p = doc.props(id);
    const d: Record<string, unknown> = {};
    for (const k of DEFAULT_SHAPE_KEYS) if (p[k] !== undefined) d[k] = structuredClone(p[k]);
    doc.set(doc.root, { defaultShapeStyle: d as Props });
  });
}

/** Text menu items. */
export function defaultTextMenu(ed: Editor, sel: readonly string[]): MenuEntry[] {
  const doc = ed.doc;
  const has = !!doc.get(doc.root, 'defaultTextStyle');
  const items: MenuEntry[] = [];
  if (sel.length === 1 && doc.type(sel[0]!) === 'TEXT') items.push({ label: 'Сделать оформлением новых текстов', run: () => setDefaultText(doc, sel[0]!) });
  if (has) items.push({ label: 'Новые тексты — как обычно (Inter 24)', run: () => setDefaultText(doc, null) });
  if (sel.length === 1 && SHAPES.has(doc.type(sel[0]!) ?? '')) items.push({ label: 'Сделать оформлением новых фигур', run: () => setDefaultShape(doc, sel[0]!) });
  if (doc.get(doc.root, 'defaultShapeStyle')) items.push({ label: 'Новые фигуры — как обычно (серые)', run: () => setDefaultShape(doc, null) });
  return items;
}
