// Layer outline without rendering (in layer coordinates): prepared geometry (vectorPaths) or built
// from the shape parameters; for groups and booleans — the children's paths together. For flatten in the
// plugin Worker: the exact result (boolean operations, outlined text, smoothed corners) comes from the renderer later.

import { multiply, type Document, type Matrix } from '@mfp/core';
import { parsePath, transformPath, type Seg } from './svg-path.ts';

/** Cubic curve coefficient for a quarter circle. */
const K = 0.5522847498307936;
const TAU = Math.PI * 2;

const M = (x: number, y: number): Seg => ({ c: 'M', v: [x, y] });
const L = (x: number, y: number): Seg => ({ c: 'L', v: [x, y] });
const C = (...v: number[]): Seg => ({ c: 'C', v });
const Z: Seg = { c: 'Z', v: [] };

function roundedRect(w: number, h: number, radii: [number, number, number, number]): Seg[] {
  let [tl, tr, br, bl] = radii.map((v) => Math.max(0, v)) as [number, number, number, number];
  const fit = (side: number, a: number, b: number) => (a + b > side ? side / (a + b) : 1);
  const f = Math.min(fit(w, tl, tr), fit(w, bl, br), fit(h, tl, bl), fit(h, tr, br));
  [tl, tr, br, bl] = [tl * f, tr * f, br * f, bl * f];
  if (!tl && !tr && !br && !bl) return [M(0, 0), L(w, 0), L(w, h), L(0, h), Z];
  const out: Seg[] = [M(tl, 0), L(w - tr, 0)];
  if (tr) out.push(C(w - tr + tr * K, 0, w, tr - tr * K, w, tr));
  out.push(L(w, h - br));
  if (br) out.push(C(w, h - br + br * K, w - br + br * K, h, w - br, h));
  out.push(L(bl, h));
  if (bl) out.push(C(bl - bl * K, h, 0, h - bl + bl * K, 0, h - bl));
  out.push(L(0, tl));
  if (tl) out.push(C(0, tl - tl * K, tl - tl * K, 0, tl, 0));
  out.push(Z);
  return out;
}

/** Ellipse arc as cubic curves (pieces of at most 90°). */
function arc(out: Seg[], cx: number, cy: number, rx: number, ry: number, a0: number, sweep: number, first: 'M' | 'L') {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const x0 = cx + rx * Math.cos(a0);
  const y0 = cy + ry * Math.sin(a0);
  out.push(first === 'M' ? M(x0, y0) : L(x0, y0));
  let a = a0;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const ax = cx + rx * Math.cos(a);
    const ay = cy + ry * Math.sin(a);
    const bx = cx + rx * Math.cos(b);
    const by = cy + ry * Math.sin(b);
    out.push(C(ax - k * rx * Math.sin(a), ay + k * ry * Math.cos(a), bx + k * rx * Math.sin(b), by - k * ry * Math.cos(b), bx, by));
    a = b;
  }
}

function ellipse(w: number, h: number, data?: { startingAngle: number; endingAngle: number; innerRadius: number }): Seg[] {
  const rx = w / 2;
  const ry = h / 2;
  const out: Seg[] = [];
  if (data) {
    const s = (((data.endingAngle - data.startingAngle) % TAU) + TAU) % TAU;
    const sweep = s < 1e-6 ? TAU : s;
    const ratio = Math.max(0, Math.min(1, data.innerRadius));
    const full = sweep >= TAU - 1e-6;
    if (full && ratio > 0) {
      arc(out, rx, ry, rx, ry, 0, TAU, 'M');
      out.push(Z);
      arc(out, rx, ry, rx * ratio, ry * ratio, 0, -TAU, 'M');
      out.push(Z);
      return out;
    }
    if (!full) {
      if (ratio > 0) {
        arc(out, rx, ry, rx, ry, data.startingAngle, sweep, 'M');
        arc(out, rx, ry, rx * ratio, ry * ratio, data.startingAngle + sweep, -sweep, 'L');
      } else {
        out.push(M(rx, ry));
        arc(out, rx, ry, rx, ry, data.startingAngle, sweep, 'L');
      }
      out.push(Z);
      return out;
    }
  }
  arc(out, rx, ry, rx, ry, 0, TAU, 'M');
  out.push(Z);
  return out;
}

function polygon(w: number, h: number, points: number, star: boolean, ratio: number): Seg[] {
  const out: Seg[] = [];
  const n = star ? points * 2 : points;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * TAU) / n;
    const k = star && i % 2 === 1 ? Math.max(0, Math.min(1, ratio)) : 1;
    const x = w / 2 + (Math.cos(a) * w * k) / 2;
    const y = h / 2 + (Math.sin(a) * h * k) / 2;
    out.push(i === 0 ? M(x, y) : L(x, y));
  }
  out.push(Z);
  return out;
}

const RECT_LIKE = new Set(['RECTANGLE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

/** Layer outline in its coordinates; invisible children are excluded. */
export function nodeOutline(doc: Document, id: string): Seg[] {
  const p = doc.props(id);
  const t = doc.type(id);
  const w = p.width ?? 0;
  const h = p.height ?? 0;
  const out: Seg[] = [];
  if (p.vectorPaths?.length) {
    // Prepared geometry is defined at geometrySize and stretched to the layer size.
    const gw = p.geometrySize?.width || w;
    const gh = p.geometrySize?.height || h;
    const m: Matrix = [gw ? w / gw : 1, 0, 0, 0, gh ? h / gh : 1, 0];
    for (const vp of p.vectorPaths) {
      const d = vp.data ?? (vp.blob ? doc.blob(vp.blob) : undefined);
      const segs = d ? parsePath(d) : null;
      if (segs) out.push(...transformPath(segs, m));
    }
  } else if (t && RECT_LIKE.has(t)) {
    const r = p.cornerRadius ?? 0;
    out.push(...roundedRect(w, h, [p.topLeftRadius ?? r, p.topRightRadius ?? r, p.bottomRightRadius ?? r, p.bottomLeftRadius ?? r]));
  } else if (t === 'ELLIPSE') out.push(...ellipse(w, h, p.arcData));
  else if (t === 'POLYGON') out.push(...polygon(w, h, p.pointCount ?? 3, false, 1));
  else if (t === 'STAR') out.push(...polygon(w, h, p.pointCount ?? 5, true, p.innerRadius ?? 0.382));
  else if (t === 'LINE') out.push(M(0, 0), L(w, 0));
  // Contents of groups, booleans and frames.
  if (t === 'GROUP' || t === 'BOOLEAN_OPERATION' || (t && RECT_LIKE.has(t))) {
    for (const c of doc.children(id)) {
      if (doc.get(c, 'visible') === false) continue;
      out.push(...transformPath(nodeOutline(doc, c), (doc.get(c, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix));
    }
  }
  return out;
}

/** Layer outline in page coordinates (with ancestor matrices). */
export function pageOutline(doc: Document, id: string): Seg[] {
  let m: Matrix = [1, 0, 0, 0, 1, 0];
  for (let cur: string | null = id; cur; cur = doc.parent(cur)) {
    const t = doc.type(cur);
    if (t === 'PAGE' || t === 'DOCUMENT') break;
    m = multiply((doc.get(cur, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix, m);
  }
  return transformPath(nodeOutline(doc, id), m);
}
