// SVG import into a frame: shared by the editor (DOMParser + Skia paths) and the plugin Worker
// (figma.createNodeFromSvg: its own XML parser and TS paths — svg-path.ts).
// Transforms are “baked” into the path; stroke weight scales with them. Styles come from attributes and
// style="", with inheritance. Gradients (linear and radial) are real ones, with handles;
// clip-path becomes a group with a shape mask, mask a luminance mask; <use> is a copy of the element.
// The <style> stylesheet (simple selectors) sits between attributes and style="". SMIL and CSS animations
// (opts.animate) go to the frame timeline (svg-anim.ts): animated elements become their own layers.

import { animatedProps, invert, multiply, valueAt, type AnimProperty, type AnimTrack, type ColorStop, type Document, type GradientPaint, type Matrix, type Paint, type Props, type StrokeCap } from '@mfp/core';
import { bakeTrack, boundaries, collectAnimations, cssStyles, parseCss, poseAt, styleText, timelineOf, type AnimSpec, type AnimatedElement, type BaseOf } from './svg-anim.ts';
import { transformFromHandles, type Pt } from './gradient.ts';
import { fitGroup } from './groups.ts';
import { parsePath, pathBounds, pathLength, pathPointAt, pathToSvg, transformPath, type Seg } from './svg-path.ts';

/** SVG element: either a DOM Element or a node from our own XML parser. */
export interface SvgEl {
  readonly tagName: string;
  readonly id: string;
  readonly children: Iterable<SvgEl>;
  getAttribute(name: string): string | null;
  /** Element text (needed for <style>). */
  readonly textContent?: string | null;
}

/** Path operations: Skia in the editor, TS (svg-path.ts) where it is unavailable. */
export interface PathKit<P> {
  /** Path from SVG path data with a matrix; null if it cannot be parsed. */
  path(d: string, m: Matrix): P | null;
  /** Exact bounds [x0, y0, x1, y1]. */
  bounds(p: P): [number, number, number, number];
  /** Path as an SVG path string with an offset (dx, dy). */
  toSvg(p: P, dx: number, dy: number): string;
  /** Union (clip-path from several shapes). Absent — a mask group instead. */
  union?(a: P, b: P): P | null;
  dispose?(p: P): void;
  /** Path length (trimming by dash for animations); absent — the dash is not converted to a trim. */
  length?(p: P): number;
  /** Point on an SVG path at length fraction frac and the tangent angle in degrees (animateMotion). */
  pointAt?(d: string, frac: number): { x: number; y: number; angle: number } | null;
}

/** TS paths. */
export const pathKit: PathKit<Seg[]> = {
  path: (d, m) => {
    const s = parsePath(d);
    return s ? transformPath(s, m) : null;
  },
  bounds: (p) => pathBounds(p),
  toSvg: (p, dx, dy) => pathToSvg(p, dx, dy),
  length: (p) => pathLength(p),
  pointAt: (d, frac) => {
    const s = parsePath(d);
    return s ? pathPointAt(s, frac) : null;
  },
};

// ---------- XML parsing (without DOM) ----------

class XmlEl implements SvgEl {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly children: XmlEl[] = [];
  /** Text (collected only for <style>). */
  textContent = '';
  constructor(tag: string) {
    this.tagName = tag;
  }
  get id() {
    return this.attrs.get('id') ?? '';
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.includes('&')
    ? s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
          const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
      })
    : s;
const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;

/** XML parsing: root element or null (markup error). Element text is not needed and is skipped. */
export function parseXml(text: string): SvgEl | null {
  const n = text.length;
  const stack: XmlEl[] = [];
  let root: XmlEl | null = null;
  let i = 0;
  const ws = () => {
    while (i < n && /\s/.test(text[i]!)) i++;
  };
  const name = (): string | null => {
    NAME.lastIndex = i;
    const m = NAME.exec(text);
    if (!m) return null;
    i = NAME.lastIndex;
    return m[0];
  };
  /** Text inside <style> goes into the element (stylesheet). */
  const styleTop = () => {
    const top = stack[stack.length - 1];
    return top && top.tagName.toLowerCase().replace(/^svg:/, '') === 'style' ? top : null;
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    const st = styleTop();
    if (st && lt > i) st.textContent += decode(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<![CDATA[', i) && styleTop()) {
      const e = text.indexOf(']]>', i);
      if (e < 0) return null;
      styleTop()!.textContent += text.slice(i + 9, e);
      i = e + 3;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      if (e < 0) return null;
      i = e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i);
      if (e < 0) return null;
      i = e + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i);
      if (e < 0) return null;
      i = e + 2;
      continue;
    }
    if (text.startsWith('<!', i)) {
      // DOCTYPE, possibly with an internal subset [ … ].
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        const ch = text[j];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (text[i + 1] === '/') {
      const e = text.indexOf('>', i);
      if (e < 0) return null;
      const tag = text.slice(i + 2, e).trim();
      const top = stack.pop();
      if (!top || top.tagName !== tag) return null;
      i = e + 1;
      continue;
    }
    i++;
    const tag = name();
    if (!tag) return null;
    const el = new XmlEl(tag);
    let selfClosing = false;
    while (true) {
      ws();
      if (i >= n) return null;
      if (text[i] === '/' && text[i + 1] === '>') {
        selfClosing = true;
        i += 2;
        break;
      }
      if (text[i] === '>') {
        i++;
        break;
      }
      const attr = name();
      if (!attr) return null;
      ws();
      if (text[i] !== '=') return null;
      i++;
      ws();
      const q = text[i];
      if (q !== '"' && q !== "'") return null;
      const e = text.indexOf(q, i + 1);
      if (e < 0) return null;
      el.attrs.set(attr, decode(text.slice(i + 1, e)));
      i = e + 1;
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;
    else return null;
    if (!selfClosing) stack.push(el);
  }
  return stack.length ? null : root;
}

// ---------- Styles and geometry ----------

type Style = Record<string, string>;
type RGBA = { r: number; g: number; b: number; a: number };
const INHERITED = [
  'fill',
  'stroke',
  'stroke-width',
  'fill-opacity',
  'stroke-opacity',
  'fill-rule',
  'stroke-linejoin',
  'stroke-linecap',
  'stroke-dasharray',
  'stroke-miterlimit',
  'color',
  'display',
  'visibility',
];
const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a', cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00', navy: '#000080',
  teal: '#008080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', transparent: 'none',
};
/** Not rendered on their own: definitions (used by reference) and auxiliary elements. */
const SKIP = new Set(['defs', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'pattern', 'style', 'script', 'title', 'desc', 'symbol', 'metadata', 'filter', 'marker']);
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];

function parseColor(v: string | undefined, current: string): RGBA | null {
  if (!v) return null;
  let s = v.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;
  if (s === 'currentcolor') s = current;
  s = NAMED[s] ?? s;
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean);
    const ch = (x: string | undefined) => (x === undefined ? 0 : x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x)) / 255;
    const alpha = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    return { r: ch(p[0]), g: ch(p[1]), b: ch(p[2]), a: alpha };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function parseTransform(v: string | null): Matrix {
  let m: Matrix = [1, 0, 0, 0, 1, 0];
  if (!v) return m;
  for (const [, fn, args] of v.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args!.split(/[\s,]+/).filter(Boolean).map(Number);
    let t: Matrix = [1, 0, 0, 0, 1, 0];
    if (fn === 'matrix') t = [a[0]!, a[2]!, a[4]!, a[1]!, a[3]!, a[5]!];
    else if (fn === 'translate') t = [1, 0, a[0] ?? 0, 0, 1, a[1] ?? 0];
    else if (fn === 'scale') t = [a[0]!, 0, 0, 0, a[1] ?? a[0]!, 0];
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
      t = multiply(multiply([1, 0, cx, 0, 1, cy], [c, -s, 0, s, c, 0]), [1, 0, -cx, 0, 1, -cy]);
    } else if (fn === 'skewX') t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 0, 1, 0];
    else if (fn === 'skewY') t = [1, 0, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0];
    m = multiply(m, t);
  }
  return m;
}

const n = (el: SvgEl, a: string, d = 0) => {
  const v = parseFloat(el.getAttribute(a) ?? '');
  return Number.isFinite(v) ? v : d;
};

const apply = (m: Matrix, [x, y]: Pt): Pt => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
const tagOf = (el: SvgEl) => el.tagName.toLowerCase();

/** Path of a shape element as SVG path (in its own coordinates). */
function shapeD(el: SvgEl): string | null {
  switch (tagOf(el)) {
    case 'path':
      return el.getAttribute('d');
    case 'rect': {
      const x = n(el, 'x');
      const y = n(el, 'y');
      const w = n(el, 'width');
      const h = n(el, 'height');
      if (w <= 0 || h <= 0) return null;
      let rx = n(el, 'rx', NaN);
      let ry = n(el, 'ry', NaN);
      if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
      if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx && !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const cx = n(el, 'cx');
      const cy = n(el, 'cy');
      const rx = tagOf(el) === 'circle' ? n(el, 'r') : n(el, 'rx');
      const ry = tagOf(el) === 'circle' ? n(el, 'r') : n(el, 'ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line':
      return `M${n(el, 'x1')} ${n(el, 'y1')}L${n(el, 'x2')} ${n(el, 'y2')}`;
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return tagOf(el) === 'polygon' ? d + 'Z' : d;
    }
  }
  return null;
}

/** <style> stylesheet rules for the elements of the imported SVG (for the duration of the import). */
let sheetStyles: Map<SvgEl, Style> | null = null;

function ownStyle(el: SvgEl): Style {
  const s: Style = {};
  for (const a of [...INHERITED, 'opacity', 'stop-color', 'stop-opacity', 'clip-path', 'mask', 'mask-type']) {
    const v = el.getAttribute(a);
    if (v !== null) s[a] = v;
  }
  // The stylesheet overrides attributes, style="" overrides the stylesheet (as in a browser).
  const css = sheetStyles?.get(el);
  if (css) Object.assign(s, css);
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) s[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return s;
}

const urlId = (v: string | undefined) => (v ? (/^url\(\s*['"]?#([^)'"]+)['"]?\s*\)/.exec(v.trim())?.[1] ?? null) : null);
const hrefOf = (el: SvgEl) => el.getAttribute('href') ?? el.getAttribute('xlink:href');

/** Node of the future document: a shape (vector) or a group (with a mask from clip-path / mask). */
type Item =
  | { kind: 'shape'; props: Props; anim?: AnimRef }
  | { kind: 'group'; name: string; mask: Item | null; children: Item[]; isMask?: boolean; maskType?: Props['maskType']; opacity?: number; anim?: AnimRef };

/** Animated element and its layer (after creation). */
interface AnimRef {
  meta: AnimatedElement;
  node?: string;
}

/** SVG gradient → gradient paint of a node. bbox — shape bounds in its own space, m — its matrix, node — node bounds (page). */
function gradientPaint(
  g: SvgEl,
  byId: Map<string, SvgEl>,
  current: string,
  opacity: number,
  bbox: [number, number, number, number],
  m: Matrix,
  node: [number, number, number, number],
  viewport: [number, number],
): GradientPaint | null {
  // Attributes and stops are inherited via href (gradient template).
  const attr = (name: string, el: SvgEl = g, depth = 0): string | null => {
    const v = el.getAttribute(name);
    if (v !== null) return v;
    const ref = hrefOf(el);
    const next = ref?.startsWith('#') && depth < 8 ? byId.get(ref.slice(1)) : undefined;
    return next ? attr(name, next, depth + 1) : null;
  };
  const stopEls = (el: SvgEl = g, depth = 0): SvgEl[] => {
    const own = [...el.children].filter((c) => tagOf(c) === 'stop');
    if (own.length) return own;
    const ref = hrefOf(el);
    const next = ref?.startsWith('#') && depth < 8 ? byId.get(ref.slice(1)) : undefined;
    return next ? stopEls(next, depth + 1) : [];
  };
  const stops: ColorStop[] = [];
  let last = 0;
  for (const s of stopEls()) {
    const st = ownStyle(s);
    const raw = s.getAttribute('offset') ?? '0';
    const off = Math.max(last, Math.min(1, raw.trim().endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw) || 0));
    last = off;
    const c = parseColor(st['stop-color'] ?? '#000000', current) ?? { r: 0, g: 0, b: 0, a: 0 };
    stops.push({ position: off, color: { ...c, a: c.a * parseFloat(st['stop-opacity'] ?? '1') } });
  }
  if (!stops.length) return null;
  const bboxUnits = (attr('gradientUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  const len = (v: string | null, d: number, axis: 0 | 1) => {
    if (v === null) return d;
    const t = v.trim();
    if (t.endsWith('%')) return (parseFloat(t) / 100) * (bboxUnits ? 1 : viewport[axis]);
    const x = parseFloat(t);
    return Number.isFinite(x) ? x : d;
  };
  // Chain: gradient space → (gradientTransform) → shape bounds (if bbox) → shape → page → node (0…1).
  const [bx0, by0, bx1, by1] = bbox;
  const units: Matrix = bboxUnits ? [bx1 - bx0 || 1, 0, bx0, 0, by1 - by0 || 1, by0] : [1, 0, 0, 0, 1, 0];
  const chain = multiply(multiply(m, units), parseTransform(attr('gradientTransform')));
  const [nx, ny, nw, nh] = node;
  const toNode = (p: Pt): Pt => {
    const [x, y] = apply(chain, p);
    return [(x - nx) / (nw || 1), (y - ny) / (nh || 1)];
  };
  const radial = tagOf(g) === 'radialgradient';
  let handles: [Pt, Pt, Pt];
  if (radial) {
    const cx = len(attr('cx'), bboxUnits ? 0.5 : viewport[0] / 2, 0);
    const cy = len(attr('cy'), bboxUnits ? 0.5 : viewport[1] / 2, 1);
    const r = len(attr('r'), bboxUnits ? 0.5 : Math.hypot(...viewport) / Math.SQRT2 / 2, 0);
    handles = [toNode([cx, cy]), toNode([cx + r, cy]), toNode([cx, cy + r])];
  } else {
    const x1 = len(attr('x1'), 0, 0);
    const y1 = len(attr('y1'), 0, 1);
    const x2 = len(attr('x2'), bboxUnits ? 1 : viewport[0], 0);
    const y2 = len(attr('y2'), 0, 1);
    // The third handle is the line of equal color: perpendicular to the axis in gradient space.
    const perp: Pt = [-(y2 - y1) / 2, (x2 - x1) / 2];
    handles = [toNode([x1, y1]), toNode([x2, y2]), toNode([x1 + perp[0], y1 + perp[1]])];
  }
  const type = radial ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR';
  const t = transformFromHandles(type, ...handles);
  if (t.flat().some((v) => !Number.isFinite(v))) return null;
  const paint: GradientPaint = { type, gradientTransform: t, gradientStops: stops };
  if (opacity < 1) paint.opacity = opacity;
  return paint;
}

export interface SvgImportOptions<P> {
  kit: PathKit<P>;
  /** Frame parent (page). */
  parent: string;
  name: string;
  /** Frame center. */
  at?: [number, number];
  /** Frame top-left corner (instead of the center). */
  origin?: [number, number];
  /** Move SMIL and CSS animations to the frame timeline (editor); otherwise only the first frame. */
  animate?: boolean;
}

/** Parse and import SVG text (without DOM: plugin Worker). */
export function importSvgText<P>(doc: Document, text: string, opts: SvgImportOptions<P>): string | null {
  const svg = parseXml(text);
  return svg && tagOf(svg) === 'svg' ? importSvgTree(doc, svg, opts) : null;
}

/** SVG (root element) → frame with vectors and groups; frame id or null (nothing to draw). */
export function importSvgTree<P>(doc: Document, svg: SvgEl, opts: SvgImportOptions<P>): string | null {
  const sheet = parseCss(styleText(svg));
  const prev = sheetStyles;
  sheetStyles = cssStyles(svg, sheet);
  try {
    return buildSvg(doc, svg, opts, sheet);
  } finally {
    sheetStyles = prev;
  }
}

/** Properties that make an animated element its own layer (colors are inherited by shapes). */
const NODE_ATTRS = new Set(['transform', 'motion', 'opacity', 'x', 'y', 'cx', 'cy', 'r', 'width', 'height']);
const COLOR_ATTRS = new Set(['fill', 'stroke', 'fill-opacity', 'stroke-opacity']);

function buildSvg<P>(doc: Document, svg: SvgEl, opts: SvgImportOptions<P>, sheet: ReturnType<typeof parseCss>): string | null {
  const kit = opts.kit;
  // Size: viewBox, otherwise width/height.
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const W = n(svg, 'width', vb[2] ?? 100);
  const H = n(svg, 'height', vb[3] ?? 100);
  const root: Matrix = vb.length === 4 && vb[2]! > 0 && vb[3]! > 0 ? [W / vb[2]!, 0, (-vb[0]! * W) / vb[2]!, 0, H / vb[3]!, (-vb[1]! * H) / vb[3]!] : [1, 0, 0, 0, 1, 0];
  const viewport: [number, number] = [vb[2] ?? W, vb[3] ?? H];
  const byId = new Map<string, SvgEl>();
  const index = (el: SvgEl) => {
    if (el.id) byId.set(el.id, el);
    for (const c of el.children) index(c);
  };
  index(svg);

  // Animations (SMIL and CSS) per element; base values come from attributes and styles.
  const baseOf = (el: SvgEl): BaseOf => (attr) => {
    const st = ownStyle(el);
    if (attr === 'transform') return el.getAttribute('transform') ?? undefined;
    if (attr === 'opacity' || attr === 'fill-opacity' || attr === 'stroke-opacity') return st[attr] ?? '1';
    if (attr === 'stroke-width') return st['stroke-width'] ?? '1';
    if (attr === 'stroke-dashoffset') return st['stroke-dashoffset'] ?? '0';
    if (attr === 'fill' || attr === 'stroke') return st[attr];
    return el.getAttribute(attr) ?? '0';
  };
  const anims = opts.animate ? collectAnimations(svg, sheet, ownStyle, byId, baseOf) : new Map<SvgEl, AnimSpec[]>();
  const animRefs: AnimRef[] = [];
  const vbBox: [number, number, number, number] = vb.length === 4 ? [vb[0]!, vb[1]!, vb[0]! + vb[2]!, vb[1]! + vb[3]!] : [0, 0, W, H];
  /** Element bounds in its own coordinates (fill-box): descendant shapes with their transforms. */
  const localBox = (el: SvgEl): [number, number, number, number] => {
    let box: [number, number, number, number] | null = null;
    const add = (e: SvgEl, m: Matrix, depth: number) => {
      if (depth > 32 || SKIP.has(tagOf(e))) return;
      const d = shapeD(e);
      if (d) {
        const p = kit.path(d, m);
        if (p) {
          const b = kit.bounds(p);
          kit.dispose?.(p);
          box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
        }
      }
      for (const c of e.children) add(c, multiply(m, parseTransform(c.getAttribute('transform'))), depth + 1);
    };
    add(el, IDENTITY, 0);
    return box ?? [0, 0, 0, 0];
  };
  /** Description of an animated element for computing its pose per frame. */
  const animMeta = (el: SvgEl, specs: AnimSpec[], m: Matrix, style: Style, ancestorsOpacity: number, d: string | null): AnimatedElement => {
    const own = ownStyle(el);
    const mm = multiply(m, parseTransform(el.getAttribute('transform')));
    let length: number | undefined;
    if (d && kit.length) {
      const p = kit.path(d, IDENTITY);
      if (p) {
        length = kit.length(p);
        kit.dispose?.(p);
      }
    }
    const dash = (style['stroke-dasharray'] ?? 'none') === 'none' ? undefined : style['stroke-dasharray']!.split(/[\s,]+/).filter(Boolean).map(parseFloat);
    const col = (v: string | undefined, current: string) => {
      const c = parseColor(v, current);
      return c ? { ...c } : null;
    };
    return {
      el,
      specs,
      parent: m,
      own: parseTransform(el.getAttribute('transform')),
      box: localBox(el),
      viewBox: vbBox,
      origin: own['transform-origin'],
      fillBox: own['transform-box'] === 'fill-box',
      ancestorsOpacity,
      opacity: own.opacity !== undefined ? parseFloat(own.opacity) : 1,
      fill: col(style.fill ?? '#000000', style.color ?? '#000000'),
      stroke: col(style.stroke, style.color ?? '#000000'),
      fillOpacity: parseFloat(style['fill-opacity'] ?? '1'),
      strokeOpacity: parseFloat(style['stroke-opacity'] ?? '1'),
      strokeWidth: parseFloat(style['stroke-width'] ?? '1'),
      scale: Math.sqrt(Math.abs(mm[0] * mm[4] - mm[1] * mm[3])),
      length,
      pathLength: el.getAttribute('pathLength') ? parseFloat(el.getAttribute('pathLength')!) : undefined,
      dash: dash?.every((x) => Number.isFinite(x)) ? dash : undefined,
      dashOffset: parseFloat(style['stroke-dashoffset'] ?? own['stroke-dashoffset'] ?? '0') || 0,
      geom: { x: n(el, 'x'), y: n(el, 'y'), cx: n(el, 'cx'), cy: n(el, 'cy'), r: n(el, 'r'), width: n(el, 'width'), height: n(el, 'height') },
      motionAt: kit.pointAt ? (pd: string, frac: number) => kit.pointAt!(pd, frac) : undefined,
    };
  };

  /** Move a path to the origin: SVG path and bounds (page). */
  const placed = (path: P): { data: string; box: [number, number, number, number] } => {
    const b = kit.bounds(path);
    return { data: kit.toSvg(path, -b[0], -b[1]), box: b };
  };

  /** fill / stroke paint: a color or a gradient by reference (other references get the fallback color). */
  const paintOf = (value: string | undefined, opacity: number, current: string, geo: { bbox: [number, number, number, number]; m: Matrix; node: [number, number, number, number] }): Paint | null => {
    if (!value) return null;
    const id = urlId(value);
    if (id) {
      const ref = byId.get(id);
      const tag = ref && tagOf(ref);
      if (ref && (tag === 'lineargradient' || tag === 'radialgradient')) {
        const g = gradientPaint(ref, byId, current, opacity, geo.bbox, geo.m, geo.node, viewport);
        if (g) return g;
      }
      // url(#x) fallback color: “url(#x) red”.
      const fallback = value.replace(/^url\([^)]*\)\s*/, '').trim();
      value = fallback || 'none';
    }
    const c = parseColor(value, current);
    if (!c) return null;
    const p: Paint = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } };
    if (c.a * opacity < 1) p.opacity = c.a * opacity;
    return p;
  };

  /** Shape → vector; null if there is nothing to draw. */
  const shapeItem = (el: SvgEl, d: string, mm: Matrix, style: Style, op: number): Item | null => {
    const path = kit.path(d, mm);
    if (!path) return null;
    const { data, box } = placed(path);
    kit.dispose?.(path);
    const src = kit.path(d, IDENTITY);
    const local = src ? kit.bounds(src) : ([0, 0, 0, 0] as [number, number, number, number]);
    if (src) kit.dispose?.(src);
    const current = style.color ?? '#000000';
    const w = Math.max(0, box[2] - box[0]);
    const h = Math.max(0, box[3] - box[1]);
    const geo = { bbox: local, m: mm, node: [box[0], box[1], w, h] as [number, number, number, number] };
    const fill = paintOf(style.fill ?? '#000000', parseFloat(style['fill-opacity'] ?? '1'), current, geo);
    const stroke = paintOf(style.stroke, parseFloat(style['stroke-opacity'] ?? '1'), current, geo);
    if (!fill && !stroke) return null;
    const scale = Math.sqrt(Math.abs(mm[0] * mm[4] - mm[1] * mm[3]));
    const cap = style['stroke-linecap'];
    const capType: StrokeCap | null = cap === 'round' ? 'ROUND' : cap === 'square' ? 'SQUARE' : null;
    const dashes = (style['stroke-dasharray'] ?? 'none') === 'none' ? [] : style['stroke-dasharray']!.split(/[\s,]+/).filter(Boolean).map((v) => parseFloat(v) * scale);
    const props: Props = {
      name: el.getAttribute('id') ?? tagOf(el),
      transform: [1, 0, box[0], 0, 1, box[1]],
      width: w,
      height: h,
      geometrySize: { width: w, height: h },
      vectorPaths: [{ windingRule: style['fill-rule'] === 'evenodd' ? 'EVENODD' : 'NONZERO', data }],
      fills: fill ? [fill] : [],
      strokes: stroke ? [stroke] : [],
      strokeWeight: stroke ? parseFloat(style['stroke-width'] ?? '1') * scale : 1,
      strokeAlign: 'CENTER',
      strokeJoin: style['stroke-linejoin'] === 'round' ? 'ROUND' : style['stroke-linejoin'] === 'bevel' ? 'BEVEL' : 'MITER',
    };
    if (capType) props.strokeStartCap = props.strokeEndCap = capType;
    if (dashes.length && dashes.every((v) => Number.isFinite(v) && v >= 0) && dashes.some((v) => v > 0)) props.dashPattern = dashes.length % 2 ? [...dashes, ...dashes] : dashes;
    const miter = parseFloat(style['stroke-miterlimit'] ?? '');
    if (Number.isFinite(miter) && miter !== 4) props.strokeMiterLimit = Math.max(1, miter);
    if (op < 1) props.opacity = op;
    return { kind: 'shape', props };
  };

  /** Mask vector from a path. */
  const maskShape = (path: P, name: string): Item => {
    const { data, box } = placed(path);
    const w = Math.max(0, box[2] - box[0]);
    const h = Math.max(0, box[3] - box[1]);
    return {
      kind: 'shape',
      props: {
        name,
        transform: [1, 0, box[0], 0, 1, box[1]],
        width: w,
        height: h,
        geometrySize: { width: w, height: h },
        vectorPaths: [{ windingRule: 'NONZERO', data }],
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
        isMask: true,
        maskType: 'VECTOR',
      },
    };
  };

  /** clip-path clipping: clipPath shapes as one opaque shape mask (union or group). */
  const clipItem = (cp: SvgEl, m: Matrix, depth: number): Item | null => {
    const cm = multiply(m, parseTransform(cp.getAttribute('transform')));
    const paths: P[] = [];
    const add = (el: SvgEl, mm: Matrix) => {
      const tag = tagOf(el);
      const t = multiply(mm, parseTransform(el.getAttribute('transform')));
      if (tag === 'use') {
        const ref = hrefOf(el);
        const target = ref?.startsWith('#') ? byId.get(ref.slice(1)) : undefined;
        if (target && depth < 8) add(target, multiply(t, [1, 0, n(el, 'x'), 0, 1, n(el, 'y')]));
        return;
      }
      const d = shapeD(el);
      if (d) {
        const p = kit.path(d, t);
        if (p) paths.push(p);
      }
      for (const c of el.children) add(c, t);
    };
    for (const c of cp.children) add(c, cm);
    if (!paths.length) return null;
    const name = cp.id || 'clip';
    if (paths.length > 1 && !kit.union) {
      // Without path union: the mask is a group of shapes (alpha mask, all opaque).
      const shapes = paths.map((p, i) => {
        const s = maskShape(p, `${name} ${i + 1}`);
        kit.dispose?.(p);
        if (s.kind === 'shape') {
          delete s.props.isMask;
          delete s.props.maskType;
        }
        return s;
      });
      return { kind: 'group', name, mask: null, children: shapes, isMask: true, maskType: 'ALPHA' };
    }
    let acc: P = paths[0]!;
    for (const p of paths.slice(1)) {
      const u = kit.union!(acc, p);
      kit.dispose?.(acc);
      kit.dispose?.(p);
      if (!u) return null;
      acc = u;
    }
    const item = maskShape(acc, name);
    kit.dispose?.(acc);
    return item;
  };

  const walk = (el: SvgEl, m: Matrix, inherited: Style, opacity: number, depth: number, inhSpecs: AnimSpec[] = []): Item[] => {
    const tag = tagOf(el);
    if (SKIP.has(tag) || depth > 32) return [];
    const own = ownStyle(el);
    const style: Style = { ...inherited };
    for (const k of INHERITED) if (own[k] !== undefined) style[k] = own[k]!;
    if (own.display === 'none' || own.visibility === 'hidden') return [];
    const mm = multiply(m, parseTransform(el.getAttribute('transform')));
    const op = opacity * (own.opacity !== undefined ? parseFloat(own.opacity) : 1);
    // Animations: own and inherited color ones (if no own color is set).
    const ownSpecs = depth > 0 ? (anims.get(el) ?? []) : [];
    const inh = inhSpecs.filter((sp) => own[sp.attr] === undefined);
    const childInh = [...inh, ...ownSpecs.filter((sp) => COLOR_ATTRS.has(sp.attr))];
    const nodeSpecs = ownSpecs.filter((sp) => NODE_ATTRS.has(sp.attr));
    const d0 = tag === 'use' ? null : shapeD(el);
    // An animated container is its own layer (a frame: a group would refit to its children during the animation).
    if (nodeSpecs.length && !d0) {
      const children: Item[] = [];
      if (tag === 'use') {
        const ref = hrefOf(el);
        const target = ref?.startsWith('#') ? byId.get(ref.slice(1)) : undefined;
        if (target) {
          const t = multiply(mm, [1, 0, n(el, 'x'), 0, 1, n(el, 'y')]);
          if (tagOf(target) === 'symbol') for (const c of target.children) children.push(...walk(c, t, style, 1, depth + 1, childInh));
          else children.push(...walk(target, t, style, 1, depth + 1, childInh));
        }
      } else for (const c of el.children) children.push(...walk(c, mm, style, 1, depth + 1, childInh));
      if (!children.length) return [];
      const ref: AnimRef = { meta: animMeta(el, ownSpecs, m, style, opacity, null) };
      animRefs.push(ref);
      return [{ kind: 'group', name: el.getAttribute('id') ?? tag, mask: null, children, opacity: op, anim: ref }];
    }
    let items: Item[] = [];
    if (tag === 'use') {
      // <use>: a copy of the element offset by x, y; for <symbol>, its contents.
      const ref = hrefOf(el);
      const target = ref?.startsWith('#') ? byId.get(ref.slice(1)) : undefined;
      if (target) {
        const t = multiply(mm, [1, 0, n(el, 'x'), 0, 1, n(el, 'y')]);
        if (tagOf(target) === 'symbol') for (const c of target.children) items.push(...walk(c, t, style, op, depth + 1, childInh));
        else items.push(...walk(target, t, style, op, depth + 1, childInh));
      }
    } else {
      const d = d0;
      if (d) {
        const item = shapeItem(el, d, mm, style, op);
        if (item) {
          const specs = [...ownSpecs, ...inh];
          if (specs.length && item.kind === 'shape') {
            item.anim = { meta: animMeta(el, specs, m, style, opacity, d) };
            animRefs.push(item.anim);
          }
          items.push(item);
        }
      }
      for (const c of el.children) items.push(...walk(c, mm, style, op, depth + 1, childInh));
    }
    if (!items.length) return items;
    // clip-path and mask: a group with the mask at the bottom.
    const clipRef = byId.get(urlId(own['clip-path']) ?? '');
    if (clipRef && tagOf(clipRef) === 'clippath') {
      const mask = clipItem(clipRef, mm, depth);
      if (mask) items = [{ kind: 'group', name: el.getAttribute('id') ?? 'Clip group', mask, children: items }];
    }
    const maskRef = byId.get(urlId(own.mask) ?? '');
    if (maskRef && tagOf(maskRef) === 'mask') {
      const content: Item[] = [];
      for (const c of maskRef.children) content.push(...walk(c, mm, {}, 1, depth + 1));
      const type: Props['maskType'] = (ownStyle(maskRef)['mask-type'] ?? '') === 'alpha' ? 'ALPHA' : 'LUMINANCE';
      if (content.length) {
        const mask: Item =
          content.length === 1 && content[0]!.kind === 'shape'
            ? { kind: 'shape', props: { ...content[0]!.props, isMask: true, maskType: type } }
            : { kind: 'group', name: maskRef.id || 'mask', mask: null, children: content, isMask: true, maskType: type };
        items = [{ kind: 'group', name: el.getAttribute('id') ?? 'Mask group', mask, children: items }];
      }
    }
    return items;
  };
  const items = walk(svg, root, {}, 1, 0);
  if (!items.length) return null;
  return doc.transact(() => {
    const frame = doc.create('FRAME', opts.parent, {
      name: opts.name,
      transform: [1, 0, opts.origin ? opts.origin[0] : Math.round((opts.at?.[0] ?? 0) - W / 2), 0, 1, opts.origin ? opts.origin[1] : Math.round((opts.at?.[1] ?? 0) - H / 2)],
      width: W,
      height: H,
      fills: [],
      clipsContent: false,
    });
    // Groups are created in frame coordinates and fitted to their children (mask bounds follow the mask).
    // An animated container and a wrapper with animated layers inside become a frame without clipping in
    // frame coordinates (a group would refit to its children during the animation).
    const animated = (it: Item): boolean => !!it.anim || (it.kind === 'group' && (it.children.some(animated) || (!!it.mask && animated(it.mask))));
    const create = (item: Item, parent: string) => {
      if (item.kind === 'shape') {
        const id = doc.create('VECTOR', parent, item.props);
        if (item.anim) item.anim.node = id;
        return;
      }
      const mask = item.isMask ? { isMask: true, maskType: item.maskType } : {};
      const opacity = item.opacity !== undefined && item.opacity < 1 ? { opacity: item.opacity } : {};
      if (animated(item)) {
        const g = doc.create('FRAME', parent, { name: item.name, width: W, height: H, fills: [], clipsContent: false, ...mask, ...opacity });
        if (item.anim) item.anim.node = g;
        if (item.mask) create(item.mask, g);
        for (const c of item.children) create(c, g);
        return;
      }
      const g = doc.create('GROUP', parent, { name: item.name, width: W, height: H, ...mask, ...opacity });
      if (item.mask) create(item.mask, g);
      for (const c of item.children) create(c, g);
      fitGroup(doc, g);
    };
    for (const it of items) create(it, frame);
    if (animRefs.length) bakeAnimations(doc, frame, animRefs);
    return frame;
  });
}

/**
 * Animations as keyframes: layer matrix relative to the parent → position, rotation, per-axis scale;
 * opacity, colors, stroke weight and stroke trim. First, exact keys at the segment boundaries of the
 * source animations with their curves (verified per frame at 60 fps); on mismatch, per-frame keys,
 * thinned out. The frame timeline is the common period (looped) or until the last one ends (once).
 */
function bakeAnimations(doc: Document, frame: string, refs: AnimRef[]) {
  const { duration, loop } = timelineOf(refs.flatMap((r) => r.meta.specs));
  const fps = 60;
  const count = Math.max(1, Math.round(duration * fps));
  const samples = Array.from({ length: count + 1 }, (_, i) => Math.min(duration, i / fps));
  const tf = (id: string) => (doc.get(id, 'transform') ?? IDENTITY) as Matrix;
  /** Layer matrix in frame coordinates (static). */
  const world = (id: string): Matrix => {
    let m = tf(id);
    for (let cur = doc.parent(id); cur && cur !== frame; cur = doc.parent(cur)) m = multiply(tf(cur), m);
    return m;
  };
  const TRANSFORM_ATTRS = new Set(['transform', 'motion', 'x', 'y', 'cx', 'cy', 'r', 'width', 'height']);
  for (const ref of refs) {
    const id = ref.node;
    if (!id || !doc.has(id)) continue;
    const meta = ref.meta;
    const parent = doc.parent(id);
    const invP = invert(parent && parent !== frame ? world(parent) : IDENTITY) ?? IDENTITY;
    const s0 = world(id);
    const w = doc.get(id, 'width') ?? 0;
    const h = doc.get(id, 'height') ?? 0;
    /** Property values at moments times; exact keys at the boundaries of the attrs animations or per frame. */
    const track = (property: AnimProperty, attrs: Set<string>, value: (times: number[]) => (number | RGBALike)[], tol: number): AnimTrack | null => {
      const specs = meta.specs.filter((s) => attrs.has(s.attr));
      if (!specs.length) return null;
      const bounds = boundaries(specs, duration);
      // Common series of moments: frames and boundaries (rotation is unwrapped continuously across the whole series).
      const all = [...new Set([...samples, ...bounds.map((b) => b.t)])].sort((a, b) => a - b);
      const vals = value(all);
      const at = new Map(all.map((t, i) => [t, vals[i]!]));
      const sampled = samples.map((t) => at.get(t)!);
      const baked = bakeTrack(property, samples, sampled, tol);
      if (!baked) return null;
      const exact: AnimTrack = {
        property,
        keys: bounds.map((b, i) => ({ t: b.t, value: at.get(b.t)!, ...(i < bounds.length - 1 ? { easing: b.easing ?? { type: 'LINEAR' as const } } : {}) })),
      };
      const vec = (v: number | RGBALike) => (typeof v === 'number' ? [v] : [v.r, v.g, v.b, v.a]);
      const ok = samples.every((t, i) => {
        const v = valueAt(exact, t);
        if (v === undefined) return false;
        const a = vec(v);
        const b = vec(sampled[i]!);
        return a.every((x, d) => Math.abs(x - b[d]!) <= tol * 4);
      });
      return ok && exact.keys.length < baked.keys.length ? dropFlat(exact, tol) : baked;
    };
    const tracks: AnimTrack[] = [];
    const add = (tr: AnimTrack | null) => tr && tracks.push(tr);
    // Position, rotation and scale: layer matrix in the parent, decomposed as the timeline does.
    const layout = (times: number[]) => {
      let prevRot: number | null = null;
      return times.map((t) => {
        const m = multiply(multiply(invP, poseAt(meta, t).delta), s0);
        const sx = Math.hypot(m[0], m[3]) || 1e-9;
        let rot = (-Math.atan2(m[3], m[0]) * 180) / Math.PI;
        // Continuous rotation (no jump across ±180°).
        if (prevRot !== null) {
          while (rot - prevRot > 180) rot -= 360;
          while (rot - prevRot < -180) rot += 360;
        }
        prevRot = rot;
        const cx = m[0] * (w / 2) + m[1] * (h / 2) + m[2];
        const cy = m[3] * (w / 2) + m[4] * (h / 2) + m[5];
        return { x: cx - w / 2, y: cy - h / 2, rotation: rot, scaleX: sx, scaleY: (m[0] * m[4] - m[1] * m[3]) / sx };
      });
    };
    for (const [prop, tol] of [['x', 0.02], ['y', 0.02], ['rotation', 0.05], ['scaleX', 0.0005], ['scaleY', 0.0005]] as const) {
      add(track(prop, TRANSFORM_ATTRS, (ts) => layout(ts).map((p) => p[prop]), tol));
    }
    add(track('opacity', new Set(['opacity']), (ts) => ts.map((t) => poseAt(meta, t).opacity), 0.002));
    const fills = doc.get(id, 'fills') ?? [];
    const strokes = doc.get(id, 'strokes') ?? [];
    const black = { r: 0, g: 0, b: 0, a: 1 };
    if (fills[0]?.type === 'SOLID') add(track('fill', new Set(['fill', 'fill-opacity']), (ts) => ts.map((t) => poseAt(meta, t).fill ?? black), 0.002));
    if (strokes[0]?.type === 'SOLID') add(track('stroke', new Set(['stroke', 'stroke-opacity']), (ts) => ts.map((t) => poseAt(meta, t).stroke ?? black), 0.002));
    if (strokes.length) add(track('strokeWeight', new Set(['stroke-width']), (ts) => ts.map((t) => poseAt(meta, t).strokeWidth), 0.01));
    // A “line drawing” dash becomes a path trim (the dash itself is removed).
    const poses = samples.map((t) => poseAt(meta, t));
    if (poses.some((p) => p.trim)) {
      doc.set(id, { dashPattern: undefined });
      const dash = new Set(['stroke-dashoffset']);
      add(track('trimStart', dash, (ts) => ts.map((t) => poseAt(meta, t).trim?.[0] ?? 0), 0.0005) ?? { property: 'trimStart', keys: [{ t: 0, value: poses[0]!.trim?.[0] ?? 0 }] });
      add(track('trimEnd', dash, (ts) => ts.map((t) => poseAt(meta, t).trim?.[1] ?? 1), 0.0005) ?? { property: 'trimEnd', keys: [{ t: 0, value: poses[0]!.trim?.[1] ?? 1 }] });
    }
    if (!tracks.length) continue;
    doc.set(id, { animation: tracks });
    // Regular layer properties hold the pose at moment zero (as after recording on the timeline).
    const p0 = animatedProps(doc, id, 0);
    if (p0) doc.set(id, p0);
  }
  doc.set(frame, { timeline: { duration: Math.round(duration * 1000) / 1000, playback: loop ? 'LOOP' : 'ONCE', loop, autoplay: true } });
}

type RGBALike = { r: number; g: number; b: number; a: number };

/** Redundant keys: the middle of three consecutive keys with the same value is removed (a hold with no change). */
function dropFlat(tr: AnimTrack, tol: number): AnimTrack {
  const same = (a: number | RGBALike, b: number | RGBALike) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= tol : JSON.stringify(a) === JSON.stringify(b));
  const keys = tr.keys.filter((k, i, all) => i === 0 || i === all.length - 1 || !(same(all[i - 1]!.value, k.value) && same(k.value, all[i + 1]!.value)));
  return { ...tr, keys };
}
