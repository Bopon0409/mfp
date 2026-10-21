// Text on a path: line coordinates (x — along the line, y — down from the top of the layout) ⇄ node
// coordinates. A character sits on the path: the first line's baseline lies on the path itself,
// rotated along the tangent; the next line is parallel, offset along the normal. The line start is
// an offset along the path (for center and right alignment — from the middle and from the end).
// Past the end of an open path the line continues along the tangent; on a closed one it wraps around.

import type { CanvasKit, ContourMeasure, Path } from 'canvaskit-wasm';

export type PathTextAlign = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';

export class PathTextMap {
  private path: Path | null;
  private measure: ContourMeasure | null = null;
  readonly length: number = 0;
  readonly closed: boolean = false;
  /** Where on the path the line starts. */
  readonly start: number = 0;
  private baseline: number;
  /** Path points with a ~2 px step: length, position, tangent (for the inverse mapping). */
  private samples: [number, number, number, number, number][] = [];

  /**
   * sx, sy — path stretch (the node bounds were stretched after creation): the line start moves
   * together with the path (the offset stays the same fraction of length).
   */
  constructor(ck: CanvasKit, data: string, offset: number, textWidth: number, align: PathTextAlign, baseline: number, sx = 1, sy = 1) {
    this.baseline = baseline;
    this.path = ck.Path.MakeFromSVGString(data);
    if (!this.path) return;
    if (sx !== 1 || sy !== 1) {
      const before = contourLength(ck, this.path);
      const b = new ck.PathBuilder();
      b.addPath(this.path);
      b.transform([sx, 0, 0, 0, sy, 0, 0, 0, 1]);
      this.path.delete();
      this.path = b.detachAndDelete();
      const after = contourLength(ck, this.path);
      if (before > 0) offset *= after / before;
    }
    // Precision 8: at high zoom characters don't drift off the curve inward.
    const iter = new ck.ContourMeasureIter(this.path, false, 8);
    this.measure = iter.next();
    iter.delete();
    if (!this.measure) return;
    this.length = this.measure.length();
    this.closed = this.measure.isClosed();
    this.start = align === 'CENTER' ? (this.length - textWidth) / 2 + offset : align === 'RIGHT' ? this.length - textWidth + offset : offset;
    const n = Math.max(2, Math.min(4000, Math.ceil(this.length / 2)));
    for (let i = 0; i <= n; i++) {
      const s = (this.length * i) / n;
      const p = this.measure.getPosTan(s);
      this.samples.push([s, p[0]!, p[1]!, p[2]!, p[3]!]);
    }
  }

  get ok(): boolean {
    return !!this.measure && this.length > 0;
  }

  /** The path (with stretch) as an SVG string. */
  svg(): string {
    return this.path?.toSVGString() ?? '';
  }

  /** Position and tangent on the path at length s (past the ends of an open one — continued along the tangent). */
  private at(s: number): [number, number, number, number] {
    const m = this.measure!;
    const L = this.length;
    if (this.closed) s = ((s % L) + L) % L;
    else if (s < 0 || s > L) {
      const end = s < 0 ? 0 : L;
      const p = m.getPosTan(end);
      const d = s - end;
      return [p[0]! + p[2]! * d, p[1]! + p[3]! * d, p[2]!, p[3]!];
    }
    const p = m.getPosTan(s);
    return [p[0]!, p[1]!, p[2]!, p[3]!];
  }

  /** Line → node: x, y and the character's rotation angle (radians). */
  toLocal(x: number, y: number): [number, number, number] {
    const [px, py, tx, ty] = this.at(this.start + x);
    const d = y - this.baseline;
    // Normal (y axis down): for a left-to-right path, “below the baseline” is lower on screen.
    return [px - ty * d, py + tx * d, Math.atan2(ty, tx)];
  }

  /** Node → line (nearest path point). */
  fromLocal(x: number, y: number): [number, number] {
    let best = this.samples[0];
    let bd = Infinity;
    for (const smp of this.samples) {
      const d = (smp[1] - x) ** 2 + (smp[2] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = smp;
      }
    }
    if (!best) return [0, this.baseline];
    const [s, px, py, tx, ty] = best;
    // Along the tangent — a length correction, along the normal — offset from the baseline.
    const along = (x - px) * tx + (y - py) * ty;
    const across = (x - px) * -ty + (y - py) * tx;
    return [s + along - this.start, this.baseline + across];
  }

  delete() {
    this.measure?.delete();
    this.measure = null;
    this.path?.delete();
    this.path = null;
  }
}

/** Length of the path's first contour. */
function contourLength(ck: CanvasKit, path: Path): number {
  const iter = new ck.ContourMeasureIter(path, false, 8);
  const m = iter.next();
  iter.delete();
  const len = m?.length() ?? 0;
  m?.delete();
  return len;
}

/** Stretch of the path for text on a path: frame size relative to the size the path was defined at. */
export function textPathScale(p: { width?: number; height?: number; geometrySize?: { width: number; height: number } }): [number, number] {
  const gs = p.geometrySize;
  return [gs && gs.width > 0 ? (p.width ?? 0) / gs.width : 1, gs && gs.height > 0 ? (p.height ?? 0) / gs.height : 1];
}

/** Character boundaries of a line for text on a path: [start, end) by graphemes. */
export function graphemes(text: string): [number, number][] {
  const out: [number, number][] = [];
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => { segment(s: string): Iterable<{ index: number; segment: string }> } }).Segmenter;
  if (Seg) {
    for (const g of new Seg('ru', { granularity: 'grapheme' }).segment(text)) out.push([g.index, g.index + g.segment.length]);
    return out;
  }
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    const n = c >= 0xd800 && c <= 0xdbff ? 2 : 1;
    out.push([i, i + n]);
    i += n;
  }
  return out;
}
