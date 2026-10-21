// Snapping (smart guides): edges and centers of the moved object snap to the edges
// and centers of neighbors and the parent; matching lines are shown as guides. When moving —
// also equal gaps with neighbors in a row (teal marks).
// Targets are collected once at the start of the drag and sorted — finding the nearest
// line is a binary search, so snapping doesn't slow down dragging even among thousands of neighbors.

import type { Editor, Rect } from './editor.ts';
import type { Span } from './measure.ts';
import { gridLines } from './layout-grids.ts';

/** Target line: coordinate on its axis and the target's extent along the other axis. */
interface Line {
  v: number;
  lo: number;
  hi: number;
}

/** Guide in world coordinates: x0, y0, x1, y1. */
export type Guide = [number, number, number, number];

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
  /** Equal gap marks (only when moving). */
  spacings?: Span[];
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

/** Snap threshold, screen pixels. */
export const SNAP_PX = 6;
export const RESIZE_SNAP_PX = 8;

function sortedLines(rects: Rect[], axis: 0 | 1): Line[] {
  const out: Line[] = [];
  for (const r of rects) {
    const [a0, a1, b0, b1] = axis === 0 ? [r[0], r[2], r[1], r[3]] : [r[1], r[3], r[0], r[2]];
    out.push({ v: a0, lo: b0, hi: b1 }, { v: (a0 + a1) / 2, lo: b0, hi: b1 }, { v: a1, lo: b0, hi: b1 });
  }
  return out.sort((a, b) => a.v - b.v);
}

/** Index of the first line with v >= x. */
function lowerBound(lines: Line[], x: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.v < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Snapper {
  private held: [number | null, number | null] = [null, null];
  private xs: Line[];
  private ys: Line[];
  /** Neighbors (without the parent) — for equal gaps. */
  private siblings: Rect[];

  constructor(targets: Rect[], siblings: Rect[] = [], guides: { axis: 'X' | 'Y'; offset: number }[] = []) {
    // Guides — lines without extent (across the whole page).
    const g = (axis: 'X' | 'Y'): Line[] => guides.filter((x) => x.axis === axis).map((x) => ({ v: x.offset, lo: Infinity, hi: -Infinity }));
    this.xs = [...sortedLines(targets, 0), ...g('X')].sort((a, b) => a.v - b.v);
    this.ys = [...sortedLines(targets, 1), ...g('Y')].sort((a, b) => a.v - b.v);
    this.siblings = siblings;
  }

  /** Targets for moving or resizing nodes: neighbors and parent visible on screen. */
  static forNodes(ed: Editor, ids: string[]): Snapper {
    return Snapper.collect(ed, new Set(ids.map((id) => ed.doc.parent(id)!)), new Set(ids));
  }

  /** A frame edge can also align to its own children's initial bounds. */
  static forResize(ed: Editor, ids: string[]): Snapper {
    return Snapper.collect(ed, new Set([...ids.map(id => ed.doc.parent(id)!), ...ids]), new Set(ids));
  }

  releaseResize() { this.held = [null, null]; }

  /** Capture within the threshold, release at 1.5x to avoid jitter near a guide. */
  snapResizePoint(x: number, y: number, threshold: number, snapX = true, snapY = true): SnapResult {
    const delta = (axis: 0 | 1, value: number, enabled: boolean) => {
      if (!enabled) { this.held[axis] = null; return 0; }
      const held = this.held[axis];
      if (held !== null && Math.abs(held - value) <= threshold * 1.5) return held - value;
      const d = this.nearest(axis === 0 ? this.xs : this.ys, [value], threshold);
      this.held[axis] = d === null ? null : value + d;
      return d ?? 0;
    };
    const dx = delta(0, x, snapX), dy = delta(1, y, snapY);
    const guides: Guide[] = [];
    if (snapX) this.guides(this.xs, [x + dx], [y + dy, y + dy], 0, guides);
    if (snapY) this.guides(this.ys, [y + dy], [x + dx, x + dx], 1, guides);
    return { dx, dy, guides };
  }

  /** Targets for a new shape: contents of the container it will appear in, and the container itself. */
  static forCreate(ed: Editor, parent: string): Snapper {
    return Snapper.collect(ed, new Set([parent]), new Set());
  }

  private static collect(ed: Editor, containers: Set<string>, skip: Set<string>): Snapper {
    const doc = ed.doc;
    // Targets — on screen and near it (one screen width in each direction): snapping works
    // even when a layer is dragged past the edge, and on huge pages there aren't too many targets.
    const v = ed.viewportRect();
    const mx = v[2] - v[0];
    const my = v[3] - v[1];
    const view: Rect = [v[0] - mx, v[1] - my, v[2] + mx, v[3] + my];
    const targets: Rect[] = [];
    const siblings: Rect[] = [];
    const add = (id: string, sibling: boolean) => {
      if (skip.has(id) || doc.get(id, 'visible') === false) return;
      const b = ed.selectionBounds([id]);
      if (!b || b[0] > view[2] || b[2] < view[0] || b[1] > view[3] || b[3] < view[1]) return;
      targets.push(b);
      if (sibling) siblings.push(b);
    };
    const gridX: { offset: number; lo: number; hi: number }[] = [];
    const gridY: { offset: number; lo: number; hi: number }[] = [];
    for (const p of containers) {
      if (p !== ed.pageId) add(p, false);
      for (const c of doc.children(p)) add(c, true);
      // Column and row edges of the (unrotated) parent are targets too.
      const grids = p === ed.pageId ? undefined : doc.get(p, 'layoutGrids');
      if (grids?.length) {
        const m = ed.worldMatrix(p);
        if (Math.abs(m[1]) < 1e-9 && Math.abs(m[3]) < 1e-9 && m[0] > 0 && m[4] > 0) {
          const w = doc.get(p, 'width') ?? 0;
          const h = doc.get(p, 'height') ?? 0;
          const { xs, ys } = gridLines(grids, w, h);
          for (const x of xs) gridX.push({ offset: m[2] + x, lo: m[5], hi: m[5] + h });
          for (const y of ys) gridY.push({ offset: m[5] + y, lo: m[2], hi: m[2] + w });
        }
      }
    }
    const snapper = new Snapper(targets, siblings, doc.get(ed.pageId, 'guides') ?? []);
    snapper.addLines(gridX, gridY);
    return snapper;
  }

  /** Extra target lines with extent (column and row edges of the layout grid). */
  addLines(xs: { offset: number; lo: number; hi: number }[], ys: { offset: number; lo: number; hi: number }[]) {
    if (!xs.length && !ys.length) return;
    this.xs = [...this.xs, ...xs.map((l) => ({ v: l.offset, lo: l.lo, hi: l.hi }))].sort((a, b) => a.v - b.v);
    this.ys = [...this.ys, ...ys.map((l) => ({ v: l.offset, lo: l.lo, hi: l.hi }))].sort((a, b) => a.v - b.v);
  }

  /** Nearest line to any of the coordinates; returns the correction (or null). */
  private nearest(lines: Line[], coords: number[], threshold: number): number | null {
    let best: number | null = null;
    for (const c of coords) {
      const i = lowerBound(lines, c);
      for (const j of [i - 1, i]) {
        const l = lines[j];
        if (!l) continue;
        const d = l.v - c;
        if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      }
    }
    return best;
  }

  /** Guides for matching lines: from the target to the object along the other axis. */
  private guides(lines: Line[], coords: number[], span: [number, number], axis: 0 | 1, out: Guide[]) {
    for (const c of coords) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = lowerBound(lines, c - 0.5); j < lines.length && lines[j]!.v <= c + 0.5; j++) {
        lo = Math.min(lo, lines[j]!.lo);
        hi = Math.max(hi, lines[j]!.hi);
      }
      // Only guides (without extent) matched — their line is visible anyway.
      if (lo > hi) continue;
      lo = Math.min(lo, span[0]);
      hi = Math.max(hi, span[1]);
      out.push(axis === 0 ? [c, lo, c, hi] : [lo, c, hi, c]);
    }
  }

  /**
   * Equal gaps along an axis (axis 0 — horizontal): evenly between neighbors or with the same
   * gap as the neighboring pair in the row. Returns the correction and gap marks.
   */
  private spacing(r: Rect, axis: 0 | 1, threshold: number): { d: number; marks: Span[] } | null {
    const [a0, a1, b0, b1] = axis === 0 ? ([0, 2, 1, 3] as const) : ([1, 3, 0, 2] as const);
    const size = r[a1] - r[a0];
    // Neighbors in the same row — overlap along the other axis.
    const row = this.siblings.filter((s) => s[b0] < r[b1] && s[b1] > r[b0]);
    const before = row.filter((s) => s[a1] <= r[a0] + threshold).sort((p, q) => q[a1] - p[a1]);
    const after = row.filter((s) => s[a0] >= r[a1] - threshold).sort((p, q) => p[a0] - q[a0]);
    type Item = Rect | 'M';
    const cands: { pos: number; pairs: [Item, Item][] }[] = [];
    const P = before[0];
    const Q = after[0];
    if (P && Q) {
      const pos = (P[a1] + Q[a0] - size) / 2;
      if (pos >= P[a1]) cands.push({ pos, pairs: [[P, 'M'], ['M', Q]] });
    }
    const sameRow = (s: Rect, t: Rect) => s[b0] < t[b1] && s[b1] > t[b0];
    if (P) {
      const PP = before.find((s) => s !== P && s[a1] <= P[a0] && sameRow(s, P));
      if (PP) cands.push({ pos: P[a1] + (P[a0] - PP[a1]), pairs: [[PP, P], [P, 'M']] });
    }
    if (Q) {
      const QQ = after.find((s) => s !== Q && s[a0] >= Q[a1] && sameRow(s, Q));
      if (QQ) cands.push({ pos: Q[a0] - (QQ[a0] - Q[a1]) - size, pairs: [['M', Q], [Q, QQ]] });
    }
    let best: { d: number; pairs: [Item, Item][] } | null = null;
    for (const c of cands) {
      const d = c.pos - r[a0];
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, pairs: c.pairs };
    }
    if (!best) return null;
    const M: Rect = axis === 0 ? [r[0] + best.d, r[1], r[2] + best.d, r[3]] : [r[0], r[1] + best.d, r[2], r[3] + best.d];
    const marks = best.pairs.map(([l, rr]): Span => {
      const L = l === 'M' ? M : l;
      const R = rr === 'M' ? M : rr;
      const mid = (Math.max(L[b0], R[b0]) + Math.min(L[b1], R[b1])) / 2;
      const label = fmt(R[a0] - L[a1]);
      return axis === 0 ? { a: [L[a1], mid], b: [R[a0], mid], label } : { a: [mid, L[a1]], b: [mid, R[a0]], label };
    });
    return { d: best.d, marks };
  }

  /** Snap a rectangle (move): edges and center on both axes, equal gaps. */
  snapRect(r: Rect, threshold: number): SnapResult {
    const ex = this.nearest(this.xs, [r[0], (r[0] + r[2]) / 2, r[2]], threshold);
    const ey = this.nearest(this.ys, [r[1], (r[1] + r[3]) / 2, r[3]], threshold);
    const sx = this.spacing(r, 0, threshold);
    const sy = this.spacing(r, 1, threshold);
    // An equal gap wins over an edge if it is closer (or the same).
    const useSx = !!sx && (ex === null || Math.abs(sx.d) <= Math.abs(ex));
    const useSy = !!sy && (ey === null || Math.abs(sy.d) <= Math.abs(ey));
    const dx = useSx ? sx!.d : (ex ?? 0);
    const dy = useSy ? sy!.d : (ey ?? 0);
    const s: Rect = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
    const guides: Guide[] = [];
    this.guides(this.xs, [s[0], (s[0] + s[2]) / 2, s[2]], [s[1], s[3]], 0, guides);
    this.guides(this.ys, [s[1], (s[1] + s[3]) / 2, s[3]], [s[0], s[2]], 1, guides);
    const spacings = [...(useSx ? sx!.marks : []), ...(useSy ? sy!.marks : [])];
    return { dx, dy, guides, spacings };
  }

  /** Snap a point (corner or edge when resizing, drawing a new shape). */
  snapPoint(x: number, y: number, threshold: number, snapX = true, snapY = true): SnapResult {
    const dx = snapX ? (this.nearest(this.xs, [x], threshold) ?? 0) : 0;
    const dy = snapY ? (this.nearest(this.ys, [y], threshold) ?? 0) : 0;
    const guides: Guide[] = [];
    if (snapX) this.guides(this.xs, [x + dx], [y + dy, y + dy], 0, guides);
    if (snapY) this.guides(this.ys, [y + dy], [x + dx, x + dx], 1, guides);
    return { dx, dy, guides };
  }
}
