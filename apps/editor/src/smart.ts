// “Smart selection”: if the selected layers sit in a row or column with equal
// gaps, handles appear in the gaps; dragging a handle changes all gaps at once.
// A dot at the layer center — reordering: the layer is dragged along the row, the others make room.
// Layers inside auto layout don't count — there the gap is set by the layout.

import type { Editor, Rect } from './editor.ts';
import { isAutoLayout } from '@mfp/editing';

export interface Arrangement {
  axis: 'x' | 'y';
  /** Layers in order along the axis and their bounds on the page. */
  items: { id: string; b: Rect }[];
  gap: number;
}

/** Row or column with equal gaps (tolerance — half a pixel). */
export function arrangement(ed: Editor): Arrangement | null {
  const doc = ed.doc;
  const ids = ed.selection.filter((id) => doc.has(id));
  if (ids.length < 2 || ed.tool !== 'select') return null;
  if (ids.some((id) => isAutoLayout(doc, doc.parent(id)!))) return null;
  const items = ids.map((id) => ({ id, b: ed.selectionBounds([id])! })).filter((i) => i.b);
  for (const axis of ['x', 'y'] as const) {
    const [a0, a1, b0, b1] = axis === 'x' ? [0, 2, 1, 3] : [1, 3, 0, 2];
    const sorted = [...items].sort((p, q) => p.b[a0]! - q.b[a0]!);
    // All in one row: each overlaps its neighbor along the other axis.
    let ok = true;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1]!.b;
      const q = sorted[i]!.b;
      if (q[b0]! >= p[b1]! || q[b1]! <= p[b0]!) ok = false;
      gaps.push(q[a0]! - p[a1]!);
    }
    if (!ok || gaps.some((g) => g < 0 || Math.abs(g - gaps[0]!) > 0.5)) continue;
    return { axis, items: sorted, gap: gaps[0]! };
  }
  return null;
}

/** Gap handles in screen coordinates (middle of each gap). */
export function gapHandles(ed: Editor, arr: Arrangement): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 1; i < arr.items.length; i++) {
    const p = arr.items[i - 1]!.b;
    const q = arr.items[i]!.b;
    const [x, y] =
      arr.axis === 'x'
        ? [(p[2] + q[0]) / 2, (Math.max(p[1], q[1]) + Math.min(p[3], q[3])) / 2]
        : [(Math.max(p[0], q[0]) + Math.min(p[2], q[2])) / 2, (p[3] + q[1]) / 2];
    const [sx, sy] = ed.worldToScreen(x, y);
    out.push({ x: sx, y: sy });
  }
  return out;
}

/** Reorder dots — at the centers of the row's layers (screen); none for layers too small on screen. */
export function reorderHandles(ed: Editor, arr: Arrangement): ({ x: number; y: number } | null)[] {
  return arr.items.map(({ b }) => {
    const [x0, y0] = ed.worldToScreen(b[0], b[1]);
    const [x1, y1] = ed.worldToScreen(b[2], b[3]);
    if (Math.min(x1 - x0, y1 - y0) < 24) return null;
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  });
}

/**
 * Reordering: where each layer of the row ends up if the dragged one (index) is centered at center
 * (page coordinate along the axis). Order — by the centers of the rest; the gap and row start stay the same.
 */
export function reorderPlan(arr: Arrangement, index: number, center: number): { order: number[]; starts: number[] } {
  const a = arr.axis === 'x' ? 0 : 1;
  const mid = (i: number) => (arr.items[i]!.b[a]! + arr.items[i]!.b[a + 2]!) / 2;
  const others = arr.items.map((_, i) => i).filter((i) => i !== index);
  const at = others.filter((i) => mid(i) < center).length;
  const order = [...others.slice(0, at), index, ...others.slice(at)];
  const starts: number[] = Array(arr.items.length).fill(0);
  let pos = arr.items[0]!.b[a]!;
  for (const i of order) {
    starts[i] = pos;
    pos += arr.items[i]!.b[a + 2]! - arr.items[i]!.b[a]! + arr.gap;
  }
  return { order, starts };
}
