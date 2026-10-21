// Arranging: alignment (Alt+A / D / W / S / H / V), spacing distribution
// (Alt+Shift+H / V) and Tidy up (Ctrl+Alt+T). Works with bounds on the page, so it suits
// both rotated layers and layers from different frames.

import { invert, multiply, type Matrix } from '@mfp/core';
import type { Editor, Rect } from './editor.ts';

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];

/** Layer bounds on the page (by rotated corners). */
function box(ed: Editor, id: string): Rect {
  const pts = ed.corners(id);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

/** Move a layer by (dx, dy) in page coordinates. The caller opens the transaction. */
function shift(ed: Editor, id: string, dx: number, dy: number) {
  if (!dx && !dy) return;
  const doc = ed.doc;
  const parent = doc.parent(id)!;
  const pw = (parent === ed.pageId ? IDENTITY : ed.worldMatrix(parent)) as Matrix;
  const w = ed.worldMatrix(id) as Matrix;
  doc.set(id, { transform: multiply(invert(pw), [w[0], w[1], Math.round((w[2] + dx) * 100) / 100, w[3], w[4], Math.round((w[5] + dy) * 100) / 100]) });
}

/** Whether alignment is possible: several layers — to each other, one — to its parent (not the page). */
export function canAlign(ed: Editor, ids: string[]): boolean {
  return ids.length > 1 || (ids.length === 1 && ed.doc.parent(ids[0]!) !== ed.pageId);
}

/** Key object among the layers (if set and selected together with others). */
export function keyOf(ed: Editor, ids: readonly string[]): string | null {
  const k = ed.keyObject;
  return k && ids.length > 1 && ids.includes(k) && ed.doc.has(k) ? k : null;
}

/**
 * Align: one layer — inside its parent, several — to their common bounds, and with a key object —
 * to it (it does not move itself; our own, like “Align to key object” in Illustrator).
 */
export function align(ed: Editor, ids: string[], mode: AlignMode) {
  const doc = ed.doc;
  ids = ids.filter((id) => doc.has(id));
  if (!canAlign(ed, ids)) return;
  const key = keyOf(ed, ids);
  const target = key ? box(ed, key) : ids.length === 1 ? box(ed, doc.parent(ids[0]!)!) : (ed.selectionBounds(ids) as Rect);
  doc.transact(() => {
    for (const id of ids) {
      if (id === key) continue;
      const b = box(ed, id);
      const dx = mode === 'left' ? target[0] - b[0] : mode === 'right' ? target[2] - b[2] : mode === 'hcenter' ? (target[0] + target[2] - b[0] - b[2]) / 2 : 0;
      const dy = mode === 'top' ? target[1] - b[1] : mode === 'bottom' ? target[3] - b[3] : mode === 'vcenter' ? (target[1] + target[3] - b[1] - b[3]) / 2 : 0;
      shift(ed, id, dx, dy);
    }
  });
}

/**
 * Distribute spacing evenly along an axis (the outermost layers stay put); needs three or more layers.
 * With a key object — spacing gap (current average by default), the key stays in place,
 * the rest line up on both sides of it in their previous order (two or more layers).
 */
export function distribute(ed: Editor, ids: string[], axis: 'x' | 'y', keyGap?: number) {
  const doc = ed.doc;
  ids = ids.filter((id) => doc.has(id));
  const key = keyOf(ed, ids);
  if (key) return distributeAroundKey(ed, ids, key, axis, keyGap);
  if (ids.length < 3) return;
  const a = axis === 'x' ? 0 : 1;
  const items = ids.map((id) => ({ id, b: box(ed, id) })).sort((p, q) => p.b[a] - q.b[a]);
  const start = items[0]!.b[a];
  const end = Math.max(...items.map((i) => i.b[a + 2]!));
  const sizes = items.reduce((s, i) => s + (i.b[a + 2]! - i.b[a]!), 0);
  const gap = (end - start - sizes) / (items.length - 1);
  doc.transact(() => {
    let pos = start;
    for (const it of items) {
      const d = Math.round(pos) - it.b[a]!;
      shift(ed, it.id, axis === 'x' ? d : 0, axis === 'y' ? d : 0);
      pos += it.b[a + 2]! - it.b[a]! + gap;
    }
  });
}

/** Spacing around the key object: layers in order along the axis, the key is fixed. */
function distributeAroundKey(ed: Editor, ids: string[], key: string, axis: 'x' | 'y', gap?: number) {
  const a = axis === 'x' ? 0 : 1;
  const items = ids.map((id) => ({ id, b: box(ed, id) })).sort((p, q) => p.b[a] - q.b[a]);
  const k = items.findIndex((i) => i.id === key);
  if (gap === undefined) {
    const gaps = items.slice(1).map((it, i) => it.b[a] - items[i]!.b[a + 2]!);
    gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)) : 0;
  }
  const g = gap;
  ed.doc.transact(() => {
    // After the key — forward from its far edge, before the key — backward from its near edge.
    let pos = items[k]!.b[a + 2]! + g;
    for (const it of items.slice(k + 1)) {
      const d = pos - it.b[a]!;
      shift(ed, it.id, axis === 'x' ? d : 0, axis === 'y' ? d : 0);
      pos += it.b[a + 2]! - it.b[a]! + g;
    }
    pos = items[k]!.b[a]! - g;
    for (const it of items.slice(0, k).reverse()) {
      const d = pos - it.b[a + 2]!;
      shift(ed, it.id, axis === 'x' ? d : 0, axis === 'y' ? d : 0);
      pos -= it.b[a + 2]! - it.b[a]! + g;
    }
  });
}

/**
 * Tidy up: arrange layers in an even grid with equal spacing. Rows are guessed by
 * position (centers close vertically), columns by order within the row; spacing is the average
 * of the current ones (not less than zero).
 */
export function tidyUp(ed: Editor, ids: string[]) {
  const doc = ed.doc;
  ids = ids.filter((id) => doc.has(id));
  if (ids.length < 2) return;
  const items = ids.map((id) => ({ id, b: box(ed, id) }));
  // Rows: sorted by top; a layer is in the same row if its center is above the row's bottom.
  items.sort((p, q) => p.b[1] - q.b[1]);
  const rows: (typeof items)[] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && (it.b[1] + it.b[3]) / 2 < Math.max(...row.map((r) => r.b[3]))) row.push(it);
    else rows.push([it]);
  }
  for (const row of rows) row.sort((p, q) => p.b[0] - q.b[0]);
  const cols = Math.max(...rows.map((r) => r.length));
  // Spacing: averages of the current horizontal and vertical spacing.
  const hGaps: number[] = [];
  for (const row of rows) for (let i = 1; i < row.length; i++) hGaps.push(row[i]!.b[0] - row[i - 1]!.b[2]);
  const vGaps: number[] = [];
  for (let i = 1; i < rows.length; i++) vGaps.push(Math.min(...rows[i]!.map((r) => r.b[1])) - Math.max(...rows[i - 1]!.map((r) => r.b[3])));
  const avg = (v: number[]) => (v.length ? Math.max(0, Math.round(v.reduce((s, x) => s + x, 0) / v.length)) : 0);
  const gx = avg(hGaps);
  const gy = rows.length > 1 ? avg(vGaps) : gx;
  // Column width and row height — by the largest layer in them.
  const colW = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => (r[c] ? r[c]!.b[2] - r[c]!.b[0] : 0))));
  const rowH = rows.map((r) => Math.max(...r.map((i) => i.b[3] - i.b[1])));
  const x0 = Math.min(...items.map((i) => i.b[0]));
  const y0 = Math.min(...items.map((i) => i.b[1]));
  doc.transact(() => {
    let y = y0;
    rows.forEach((row, ri) => {
      let x = x0;
      row.forEach((it, ci) => {
        shift(ed, it.id, Math.round(x) - it.b[0], Math.round(y) - it.b[1]);
        x += colW[ci]! + gx;
      });
      y += rowH[ri]! + gy;
    });
  });
}

/** Swap two layers (by centers, on the page); the layers stay in their parents. */
export function swapPositions(ed: Editor, ids: string[]) {
  const doc = ed.doc;
  ids = ids.filter((id) => doc.has(id));
  if (ids.length !== 2) return;
  const [a, b] = ids.map((id) => box(ed, id)) as [Rect, Rect];
  const ca = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2];
  const cb = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  doc.transact(() => {
    shift(ed, ids[0]!, cb[0]! - ca[0]!, cb[1]! - ca[1]!);
    shift(ed, ids[1]!, ca[0]! - cb[0]!, ca[1]! - cb[1]!);
  });
}
