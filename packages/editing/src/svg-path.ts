// SVG paths without Skia: path data parsing (all commands; arcs as cubic curves), matrix,
// exact bounds (curve extrema), serialization back to a string. Used where CanvasKit is unavailable
// (plugin Worker: createNodeFromSvg, flatten) and for geometry without rendering.

import type { Matrix } from '@mfp/core';

/** Segment in absolute coordinates: M/L — x y; Q — x1 y1 x y; C — x1 y1 x2 y2 x y; Z — no numbers. */
export interface Seg {
  c: 'M' | 'L' | 'Q' | 'C' | 'Z';
  v: number[];
}

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const COMMANDS = 'MmLlHhVvCcSsQqTtAaZz';

/** Parse path data. An error midway keeps the path up to it (as SVG does); empty or no M — null. */
export function parsePath(d: string): Seg[] | null {
  const out: Seg[] = [];
  const n = d.length;
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  /** Second control point of the previous cubic (for S) and the control point of the previous quadratic (for T). */
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  const sep = (ch: string) => ch === ' ' || ch === ',' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
  const skip = () => {
    while (i < n && sep(d[i]!)) i++;
  };
  const num = (): number | null => {
    skip();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return null;
    i = NUM.lastIndex;
    return parseFloat(m[0]);
  };
  const flag = (): number | null => {
    skip();
    const ch = d[i];
    if (ch !== '0' && ch !== '1') return null;
    i++;
    return ch === '1' ? 1 : 0;
  };
  const moreNumbers = () => {
    skip();
    const ch = d[i];
    return ch !== undefined && /[0-9.+-]/.test(ch);
  };
  const done = () => (out.length ? out : null);

  while (true) {
    skip();
    if (i >= n) break;
    const ch = d[i]!;
    if (!COMMANDS.includes(ch)) return done();
    i++;
    const C = ch.toUpperCase();
    const rel = ch !== C;
    if (!out.length && C !== 'M') return null;
    if (C === 'Z') {
      out.push({ c: 'Z', v: [] });
      cx = sx;
      cy = sy;
      lastC = lastQ = null;
      continue;
    }
    let first = true;
    do {
      const ox = rel ? cx : 0;
      const oy = rel ? cy : 0;
      switch (C) {
        case 'M':
        case 'L': {
          const x = num();
          const y = num();
          if (x === null || y === null) return done();
          cx = ox + x;
          cy = oy + y;
          // After M, subsequent pairs are lines.
          if (C === 'M' && first) {
            out.push({ c: 'M', v: [cx, cy] });
            sx = cx;
            sy = cy;
          } else out.push({ c: 'L', v: [cx, cy] });
          lastC = lastQ = null;
          break;
        }
        case 'H': {
          const x = num();
          if (x === null) return done();
          cx = ox + x;
          out.push({ c: 'L', v: [cx, cy] });
          lastC = lastQ = null;
          break;
        }
        case 'V': {
          const y = num();
          if (y === null) return done();
          cy = oy + y;
          out.push({ c: 'L', v: [cx, cy] });
          lastC = lastQ = null;
          break;
        }
        case 'C':
        case 'S': {
          let x1: number;
          let y1: number;
          if (C === 'C') {
            const a = num();
            const b = num();
            if (a === null || b === null) return done();
            x1 = ox + a;
            y1 = oy + b;
          } else {
            // Reflection of the previous control point about the current point.
            x1 = lastC ? 2 * cx - lastC[0] : cx;
            y1 = lastC ? 2 * cy - lastC[1] : cy;
          }
          const x2 = num();
          const y2 = num();
          const x = num();
          const y = num();
          if (x2 === null || y2 === null || x === null || y === null) return done();
          out.push({ c: 'C', v: [x1, y1, ox + x2, oy + y2, ox + x, oy + y] });
          lastC = [ox + x2, oy + y2];
          lastQ = null;
          cx = ox + x;
          cy = oy + y;
          break;
        }
        case 'Q':
        case 'T': {
          let x1: number;
          let y1: number;
          if (C === 'Q') {
            const a = num();
            const b = num();
            if (a === null || b === null) return done();
            x1 = ox + a;
            y1 = oy + b;
          } else {
            x1 = lastQ ? 2 * cx - lastQ[0] : cx;
            y1 = lastQ ? 2 * cy - lastQ[1] : cy;
          }
          const x = num();
          const y = num();
          if (x === null || y === null) return done();
          out.push({ c: 'Q', v: [x1, y1, ox + x, oy + y] });
          lastQ = [x1, y1];
          lastC = null;
          cx = ox + x;
          cy = oy + y;
          break;
        }
        case 'A': {
          const rx = num();
          const ry = num();
          const rot = num();
          const large = flag();
          const sweep = flag();
          const x = num();
          const y = num();
          if (rx === null || ry === null || rot === null || large === null || sweep === null || x === null || y === null) return done();
          arcToCubics(cx, cy, rx, ry, rot, large, sweep, ox + x, oy + y, out);
          cx = ox + x;
          cy = oy + y;
          lastC = lastQ = null;
          break;
        }
      }
      first = false;
    } while (moreNumbers());
  }
  return done();
}

/** Elliptical arc (SVG parameters) as cubic curves of at most 90° each (SVG 1.1, F.6.5). */
function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, angle: number, large: number, sweep: number, x2: number, y2: number, out: Seg[]) {
  if (x1 === x2 && y1 === y2) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry) {
    out.push({ c: 'L', v: [x2, y2] });
    return;
  }
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  // Radii too small for the endpoints — scale them up.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den ? Math.sqrt(Math.max(0, (rx2 * ry2 - den) / den)) : 0;
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const ccx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const ccy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let delta = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const parts = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  const map = (px: number, py: number): [number, number] => [cos * rx * px - sin * ry * py + ccx, sin * rx * px + cos * ry * py + ccy];
  let th = theta1;
  for (let p = 0; p < parts; p++) {
    const c1 = Math.cos(th);
    const s1 = Math.sin(th);
    const c2 = Math.cos(th + step);
    const s2 = Math.sin(th + step);
    const [ax, ay] = map(c1 - k * s1, s1 + k * c1);
    const [bx, by] = map(c2 + k * s2, s2 - k * c2);
    const [ex, ey] = p === parts - 1 ? [x2, y2] : map(c2, s2);
    out.push({ c: 'C', v: [ax, ay, bx, by, ex, ey] });
    th += step;
  }
}

/** Path with a matrix [a, b, c, d, e, f] (x' = a·x + b·y + c). */
export function transformPath(segs: readonly Seg[], m: Matrix): Seg[] {
  return segs.map((s) => {
    const v: number[] = [];
    for (let k = 0; k < s.v.length; k += 2) {
      const x = s.v[k]!;
      const y = s.v[k + 1]!;
      v.push(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
    }
    return { c: s.c, v };
  });
}

/** Exact path bounds [x0, y0, x1, y1] (including curve extrema); empty — zeros. */
export function pathBounds(segs: readonly Seg[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  let px = 0;
  let py = 0;
  let sx = 0;
  let sy = 0;
  /** A lone M is not included in the bounds — only the start of what is drawn. */
  let pending = false;
  const start = () => {
    if (pending) add(px, py);
    pending = false;
  };
  for (const s of segs) {
    const v = s.v;
    switch (s.c) {
      case 'M':
        px = sx = v[0]!;
        py = sy = v[1]!;
        pending = true;
        break;
      case 'L':
        start();
        add(v[0]!, v[1]!);
        px = v[0]!;
        py = v[1]!;
        break;
      case 'Q': {
        start();
        for (const axis of [0, 1]) {
          const p0 = axis ? py : px;
          const p1 = v[axis]!;
          const p2 = v[2 + axis]!;
          const den = p0 - 2 * p1 + p2;
          if (den) {
            const t = (p0 - p1) / den;
            if (t > 0 && t < 1) {
              const mt = 1 - t;
              const xq = mt * mt * px + 2 * mt * t * v[0]! + t * t * v[2]!;
              const yq = mt * mt * py + 2 * mt * t * v[1]! + t * t * v[3]!;
              add(xq, yq);
            }
          }
        }
        add(v[2]!, v[3]!);
        px = v[2]!;
        py = v[3]!;
        break;
      }
      case 'C': {
        start();
        const at = (t: number): [number, number] => {
          const mt = 1 - t;
          const a = mt * mt * mt;
          const b = 3 * mt * mt * t;
          const c = 3 * mt * t * t;
          const d = t * t * t;
          return [a * px + b * v[0]! + c * v[2]! + d * v[4]!, a * py + b * v[1]! + c * v[3]! + d * v[5]!];
        };
        for (const axis of [0, 1]) {
          const p0 = axis ? py : px;
          const p1 = v[axis]!;
          const p2 = v[2 + axis]!;
          const p3 = v[4 + axis]!;
          // B'(t)/3 = qa·t² + qb·t + qc.
          const A = p1 - p0;
          const B = p2 - p1;
          const Cc = p3 - p2;
          const qa = A - 2 * B + Cc;
          const qb = 2 * (B - A);
          const qc = A;
          const roots: number[] = [];
          if (Math.abs(qa) < 1e-12) {
            if (Math.abs(qb) > 1e-12) roots.push(-qc / qb);
          } else {
            const disc = qb * qb - 4 * qa * qc;
            if (disc >= 0) {
              const r = Math.sqrt(disc);
              roots.push((-qb + r) / (2 * qa), (-qb - r) / (2 * qa));
            }
          }
          for (const t of roots) if (t > 0 && t < 1) add(...at(t));
        }
        add(v[4]!, v[5]!);
        px = v[4]!;
        py = v[5]!;
        break;
      }
      case 'Z':
        px = sx;
        py = sy;
        break;
    }
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

const fmt = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Path as an SVG path string (with an offset dx, dy). */
export function pathToSvg(segs: readonly Seg[], dx = 0, dy = 0): string {
  let out = '';
  for (const s of segs) {
    if (s.c === 'Z') {
      out += 'Z';
      continue;
    }
    const parts: string[] = [];
    for (let k = 0; k < s.v.length; k += 2) parts.push(`${fmt(s.v[k]! + dx)} ${fmt(s.v[k + 1]! + dy)}`);
    out += s.c + parts.join(' ');
  }
  return out;
}

/** Path as a polyline (24 segments per curve): points per subpath. */
function polylines(segs: readonly Seg[]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const N = 24;
  for (const s of segs) {
    const v = s.v;
    if (s.c === 'M') {
      if (cur.length > 1) out.push(cur);
      x = sx = v[0]!;
      y = sy = v[1]!;
      cur = [[x, y]];
    } else if (s.c === 'L') {
      x = v[0]!;
      y = v[1]!;
      cur.push([x, y]);
    } else if (s.c === 'Q') {
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        cur.push([u * u * x + 2 * u * t * v[0]! + t * t * v[2]!, u * u * y + 2 * u * t * v[1]! + t * t * v[3]!]);
      }
      x = v[2]!;
      y = v[3]!;
    } else if (s.c === 'C') {
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        cur.push([u * u * u * x + 3 * u * u * t * v[0]! + 3 * u * t * t * v[2]! + t * t * t * v[4]!, u * u * u * y + 3 * u * u * t * v[1]! + 3 * u * t * t * v[3]! + t * t * t * v[5]!]);
      }
      x = v[4]!;
      y = v[5]!;
    } else {
      cur.push([sx, sy]);
      x = sx;
      y = sy;
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Path length (all subpaths in sequence). */
export function pathLength(segs: readonly Seg[]): number {
  let len = 0;
  for (const pl of polylines(segs)) for (let i = 1; i < pl.length; i++) len += Math.hypot(pl[i]![0] - pl[i - 1]![0], pl[i]![1] - pl[i - 1]![1]);
  return len;
}

/** Point at length fraction frac and the tangent angle (degrees, clockwise on screen). */
export function pathPointAt(segs: readonly Seg[], frac: number): { x: number; y: number; angle: number } | null {
  const total = pathLength(segs);
  if (!(total > 0)) return null;
  let target = Math.max(0, Math.min(1, frac)) * total;
  for (const pl of polylines(segs)) {
    for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1]!;
      const b = pl[i]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (target <= l || (i === pl.length - 1 && target - l < 1e-6)) {
        const k = l > 0 ? Math.min(1, target / l) : 0;
        return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
      }
      target -= l;
    }
  }
  return null;
}
