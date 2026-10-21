// SVG animations → MFP timeline (like Motion): SMIL (<animate>, <animateTransform>, <animateMotion>,
// <set>) and CSS (@keyframes, animation, transform-origin, transform-box). The browser draws only the
// first SVG frame into a canvas, so the animation is not played back as an “image” but converted to keys:
// each animated element gets its own layer, its pose is computed frame by frame (60 fps) by SVG and
// CSS rules (timing, repeats, direction, curves, hold, transform composition) and
// thinned out to timeline keys (points on a straight line between neighbors are dropped).
//
// Also here: parsing the <style> stylesheet (simple selectors: tag, #id, .class, descendants) —
// regular import uses it too (styles like “.cls-1 {fill: …}” from graphics editors).

import { cubicBezier, invert, multiply, type AnimProperty, type AnimTrack, type Easing, type Keyframe, type Matrix } from '@mfp/core';
import type { SvgEl } from './svg-import.ts';

type RGBA = { r: number; g: number; b: number; a: number };
type Style = Record<string, string>;

const tagOf = (el: SvgEl) => el.tagName.toLowerCase().replace(/^svg:/, '');

// ---------- CSS ----------

interface Selector {
  /** Compound parts right to left: the last one is the element itself, the rest are ancestors. */
  parts: { tag?: string; id?: string; classes: string[] }[];
  specificity: number;
}

export interface CssRule {
  selectors: Selector[];
  decls: Style;
  order: number;
}

export interface Stylesheet {
  rules: CssRule[];
  keyframes: Map<string, { offsets: number[]; decls: Style }[]>;
}

/** Declarations “a: b; c: d” (semicolons inside parentheses are not separators). */
export function parseDecls(text: string): Style {
  const out: Style = {};
  let depth = 0;
  let start = 0;
  const flush = (end: number) => {
    const d = text.slice(start, end);
    const i = d.indexOf(':');
    if (i > 0) out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).replace(/!important\s*$/i, '').trim();
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(text.length);
  return out;
}

function parseSelector(s: string): Selector | null {
  const parts: Selector['parts'] = [];
  let spec = 0;
  for (const token of s.replace(/\s*>\s*/g, ' ').trim().split(/\s+/)) {
    if (!token || token === '*') {
      parts.push({ classes: [] });
      continue;
    }
    // Pseudo-classes and attributes are not supported: the whole rule is skipped.
    if (/[:[\]+~]/.test(token)) return null;
    const m = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)$/.exec(token);
    if (!m) return null;
    const part: Selector['parts'][number] = { classes: [] };
    if (m[1]) {
      part.tag = m[1].toLowerCase();
      spec += 1;
    }
    for (const [, kind, name] of (m[2] ?? '').matchAll(/([#.])([\w-]+)/g)) {
      if (kind === '#') {
        part.id = name;
        spec += 10000;
      } else {
        part.classes.push(name!);
        spec += 100;
      }
    }
    parts.push(part);
  }
  return parts.length ? { parts: parts.reverse(), specificity: spec } : null;
}

/** Stylesheet: rules and @keyframes (without @media conditions: their content is treated as regular rules). */
export function parseCss(text: string): Stylesheet {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const sheet: Stylesheet = { rules: [], keyframes: new Map() };
  let order = 0;
  const block = (s: string) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) return;
      const head = s.slice(i, open).trim();
      // End of the block, accounting for nesting.
      let depth = 1;
      let j = open + 1;
      for (; j < s.length && depth; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
      }
      const body = s.slice(open + 1, j - 1);
      i = j;
      const kf = /^@(?:-webkit-|-moz-)?keyframes\s+["']?([\w-]+)["']?$/i.exec(head);
      if (kf) {
        const frames: { offsets: number[]; decls: Style }[] = [];
        let k = 0;
        while (k < body.length) {
          const o = body.indexOf('{', k);
          if (o < 0) break;
          const c = body.indexOf('}', o);
          if (c < 0) break;
          const offsets = body
            .slice(k, o)
            .split(',')
            .map((x) => x.trim().toLowerCase())
            .map((x) => (x === 'from' ? 0 : x === 'to' ? 1 : parseFloat(x) / 100))
            .filter((x) => Number.isFinite(x));
          if (offsets.length) frames.push({ offsets, decls: parseDecls(body.slice(o + 1, c)) });
          k = c + 1;
        }
        sheet.keyframes.set(kf[1]!, frames);
        continue;
      }
      if (head.startsWith('@')) {
        // @media, @supports — content as regular rules; other @-rules are skipped.
        if (/^@(media|supports)/i.test(head)) block(body);
        continue;
      }
      const selectors = head
        .split(',')
        .map((x) => parseSelector(x))
        .filter((x): x is Selector => !!x);
      if (selectors.length) sheet.rules.push({ selectors, decls: parseDecls(body), order: order++ });
    }
  };
  block(src);
  return sheet;
}

const classesOf = (el: SvgEl) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

function matchPart(el: SvgEl, p: Selector['parts'][number]): boolean {
  if (p.tag && tagOf(el) !== p.tag) return false;
  if (p.id && el.id !== p.id) return false;
  if (p.classes.length) {
    const cls = classesOf(el);
    if (!p.classes.every((c) => cls.includes(c))) return false;
  }
  return true;
}

/** Whether a selector matches the element (ancestors from nearest to farthest). */
function matches(sel: Selector, el: SvgEl, ancestors: readonly SvgEl[]): boolean {
  if (!matchPart(el, sel.parts[0]!)) return false;
  let a = 0;
  for (let k = 1; k < sel.parts.length; k++) {
    while (a < ancestors.length && !matchPart(ancestors[a]!, sel.parts[k]!)) a++;
    if (a >= ancestors.length) return false;
    a++;
  }
  return true;
}

/** Stylesheet styles for all elements of the tree (by specificity and order). */
export function cssStyles(root: SvgEl, sheet: Stylesheet): Map<SvgEl, Style> {
  const out = new Map<SvgEl, Style>();
  if (!sheet.rules.length) return out;
  const walk = (el: SvgEl, ancestors: SvgEl[]) => {
    const hits: { spec: number; order: number; decls: Style }[] = [];
    for (const r of sheet.rules) {
      let best = -1;
      for (const s of r.selectors) if (s.specificity > best && matches(s, el, ancestors)) best = s.specificity;
      if (best >= 0) hits.push({ spec: best, order: r.order, decls: r.decls });
    }
    if (hits.length) {
      hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
      out.set(el, Object.assign({}, ...hits.map((h) => h.decls)));
    }
    const next = [el, ...ancestors];
    for (const c of el.children) walk(c, next);
  };
  walk(root, []);
  return out;
}

/** Text of all <style> elements in the tree. */
export function styleText(root: SvgEl): string {
  let out = '';
  const walk = (el: SvgEl) => {
    if (tagOf(el) === 'style') out += (el as SvgEl & { textContent?: string | null }).textContent ?? '';
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

// ---------- Values ----------

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a', cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00', navy: '#000080',
  teal: '#008080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000',
};

export function parseCssColor(v: string | undefined | null): RGBA | null {
  if (!v) return null;
  let s = v.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
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
  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean);
    const h = ((parseFloat(p[0] ?? '0') % 360) + 360) % 360;
    const sat = parseFloat(p[1] ?? '0') / 100;
    const l = parseFloat(p[2] ?? '0') / 100;
    const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    const k = (n: number) => (n + h / 30) % 12;
    const f = (n: number) => l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return { r: f(0), g: f(8), b: f(4), a };
  }
  return null;
}

/** SVG/CSS time: “1s”, “250ms”, “0:00:01.5”, a number — seconds. */
export function parseTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  let m = /^(-?[\d.]+)\s*(ms|s|min|h)?$/.exec(s);
  if (m) {
    const x = parseFloat(m[1]!);
    const unit = m[2] ?? 's';
    return unit === 'ms' ? x / 1000 : unit === 'min' ? x * 60 : unit === 'h' ? x * 3600 : x;
  }
  m = /^(?:(\d+):)?(\d+):([\d.]+)$/.exec(s);
  if (m) return (parseFloat(m[1] ?? '0') * 60 + parseFloat(m[2]!)) * 60 + parseFloat(m[3]!);
  return null;
}

const angle = (v: string): number => {
  const m = /^(-?[\d.e+-]+)\s*(deg|rad|turn|grad)?$/i.exec(v.trim());
  if (!m) return 0;
  const x = parseFloat(m[1]!);
  const u = (m[2] ?? 'deg').toLowerCase();
  return u === 'rad' ? (x * 180) / Math.PI : u === 'turn' ? x * 360 : u === 'grad' ? x * 0.9 : x;
};

// ---------- Transforms ----------

const ID: Matrix = [1, 0, 0, 0, 1, 0];
const translate = (x: number, y: number): Matrix => [1, 0, x, 0, 1, y];
const scaleM = (x: number, y: number): Matrix => [x, 0, 0, 0, y, 0];
const rotateM = (deg: number): Matrix => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0];
};
const skewXM = (deg: number): Matrix => [1, Math.tan((deg * Math.PI) / 180), 0, 0, 1, 0];
const skewYM = (deg: number): Matrix => [1, 0, 0, Math.tan((deg * Math.PI) / 180), 1, 0];

/** CSS transform function: name and numbers (px, degrees, factors; percentages — fractions of the bounds). */
interface TransformFn {
  name: string;
  args: number[];
  /** Percentage arguments (translate) — fractions of the bounds (fill-box). */
  pct?: boolean[];
}

function parseCssTransform(v: string | undefined): TransformFn[] {
  if (!v || v.trim() === 'none') return [];
  const out: TransformFn[] = [];
  for (const [, fnRaw, argsRaw] of v.matchAll(/([\w-]+)\s*\(([^)]*)\)/g)) {
    const name = fnRaw!.toLowerCase();
    const raw = argsRaw!.split(/[\s,]+/).filter(Boolean);
    if (name.startsWith('rotate') || name.startsWith('skew')) {
      out.push({ name, args: raw.map(angle) });
      continue;
    }
    out.push({ name, args: raw.map((x) => parseFloat(x)), pct: raw.map((x) => x.endsWith('%')) });
  }
  return out;
}

/** CSS functions → matrix (box — the element bounds for translate percentages). */
function cssMatrix(fns: TransformFn[], box: [number, number, number, number]): Matrix {
  let m = ID;
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  for (const f of fns) {
    const a = f.args;
    const px = (i: number, ref: number) => (f.pct?.[i] ? ((a[i] ?? 0) / 100) * ref : a[i] ?? 0);
    let t: Matrix = ID;
    switch (f.name) {
      case 'translate':
        t = translate(px(0, w), px(1, h));
        break;
      case 'translatex':
        t = translate(px(0, w), 0);
        break;
      case 'translatey':
        t = translate(0, px(0, h));
        break;
      case 'scale':
        t = scaleM(a[0] ?? 1, a[1] ?? a[0] ?? 1);
        break;
      case 'scalex':
        t = scaleM(a[0] ?? 1, 1);
        break;
      case 'scaley':
        t = scaleM(1, a[0] ?? 1);
        break;
      case 'rotate':
      case 'rotatez':
        t = rotateM(a[0] ?? 0);
        break;
      case 'skew':
        t = multiply(skewXM(a[0] ?? 0), skewYM(a[1] ?? 0));
        break;
      case 'skewx':
        t = skewXM(a[0] ?? 0);
        break;
      case 'skewy':
        t = skewYM(a[0] ?? 0);
        break;
      case 'matrix':
        t = [a[0] ?? 1, a[2] ?? 0, a[4] ?? 0, a[1] ?? 0, a[3] ?? 1, a[5] ?? 0];
        break;
    }
    m = multiply(m, t);
  }
  return m;
}

/** Matrix decomposition: translation, rotation, per-axis scale (for blending different function lists). */
function decomposeM(m: Matrix): { tx: number; ty: number; rot: number; sx: number; sy: number } {
  const sx = Math.hypot(m[0], m[3]);
  const rot = (Math.atan2(m[3], m[0]) * 180) / Math.PI;
  const det = m[0] * m[4] - m[1] * m[3];
  return { tx: m[2], ty: m[5], rot, sx, sy: sx ? det / sx : 0 };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** “none” next to a function list — the same functions with no effect (as in CSS: rotate(0), scale(1)). */
const neutral = (fns: TransformFn[]): TransformFn[] => fns.map((f) => ({ name: f.name, args: f.args.map(() => (f.name.startsWith('scale') ? 1 : 0)) }));

function lerpTransform(a: TransformFn[], b: TransformFn[], k: number, box: [number, number, number, number]): Matrix {
  if (!a.length && b.length) a = neutral(b);
  if (!b.length && a.length) b = neutral(a);
  const same = a.length === b.length && a.every((f, i) => f.name === b[i]!.name);
  if (same) {
    return cssMatrix(
      a.map((f, i) => {
        const g = b[i]!;
        const n = Math.max(f.args.length, g.args.length);
        const def = f.name.startsWith('scale') ? 1 : 0;
        // Scale with a single number applies to both axes.
        const arg = (x: TransformFn, j: number) => x.args[j] ?? (f.name === 'scale' && j === 1 ? (x.args[0] ?? def) : def);
        return { name: f.name, args: Array.from({ length: n }, (_, j) => lerp(arg(f, j), arg(g, j), k)), pct: f.pct };
      }),
      box,
    );
  }
  // Different lists — via matrix decomposition.
  const da = decomposeM(cssMatrix(a, box));
  const db = decomposeM(cssMatrix(b, box));
  let dr = db.rot - da.rot;
  if (dr > 180) dr -= 360;
  if (dr < -180) dr += 360;
  return multiply(multiply(translate(lerp(da.tx, db.tx, k), lerp(da.ty, db.ty, k)), rotateM(da.rot + dr * k)), scaleM(lerp(da.sx, db.sx, k), lerp(da.sy, db.sy, k)));
}

/** SMIL animateTransform transform: type and numbers → matrix. */
function smilMatrix(type: string, a: number[]): Matrix {
  switch (type) {
    case 'translate':
      return translate(a[0] ?? 0, a[1] ?? 0);
    case 'scale':
      return scaleM(a[0] ?? 1, a[1] ?? a[0] ?? 1);
    case 'rotate': {
      const [deg = 0, cx = 0, cy = 0] = a;
      return multiply(multiply(translate(cx, cy), rotateM(deg)), translate(-cx, -cy));
    }
    case 'skewX':
      return skewXM(a[0] ?? 0);
    case 'skewY':
      return skewYM(a[0] ?? 0);
  }
  return ID;
}

const nums = (v: string) => v.split(/[\s,]+/).filter(Boolean).map(Number).filter((x) => Number.isFinite(x));

// ---------- Animation description ----------

type Ease = [number, number, number, number] | { steps: number; start: boolean } | null;

/** Animated property: what the animation changes in the layer. */
export type AnimAttr = 'transform' | 'motion' | 'opacity' | 'fill' | 'stroke' | 'fill-opacity' | 'stroke-opacity' | 'stroke-dashoffset' | 'stroke-width' | 'x' | 'y' | 'cx' | 'cy' | 'r' | 'width' | 'height';

const SUPPORTED: ReadonlySet<string> = new Set<AnimAttr>(['transform', 'motion', 'opacity', 'fill', 'stroke', 'fill-opacity', 'stroke-opacity', 'stroke-dashoffset', 'stroke-width', 'x', 'y', 'cx', 'cy', 'r', 'width', 'height']);

type Value = number[] | RGBA | TransformFn[];

export interface AnimSpec {
  attr: AnimAttr;
  source: 'smil' | 'css';
  /** SMIL animateTransform: translate, scale, rotate, skewX, skewY. */
  transformType?: string;
  /** Keys: cycle fraction 0…1 and value; curves are per segment (null — linear). */
  frames: { k: number; v: Value }[];
  eases: Ease[];
  /** Discrete (calcMode discrete, set): the value holds until the next key. */
  discrete: boolean;
  begin: number;
  dur: number;
  repeat: number;
  /** After the end: hold the last value (fill freeze / forwards). */
  freeze: boolean;
  /** Before the start: the first value (CSS backwards / both). */
  backwards: boolean;
  direction: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
  additive: boolean;
  /** animateMotion: path (SVG path) and rotation along the tangent. */
  motion?: { d: string; rotate: 'auto' | 'auto-reverse' | number };
}

/** Cycle fraction and segment index at moment t (null — the animation is not active now). */
function phase(s: AnimSpec, t: number): number | null {
  if (!(s.dur > 0)) return null;
  let local = t - s.begin;
  if (local < 0) {
    if (!s.backwards) return null;
    local = 0;
  }
  const total = s.dur * s.repeat;
  let iter: number;
  let frac: number;
  if (local >= total) {
    if (!s.freeze) return null;
    // End of the last cycle (a fractional repeat — its fraction).
    const r = s.repeat;
    iter = Number.isFinite(r) ? Math.max(0, Math.ceil(r) - 1) : 0;
    frac = Number.isFinite(r) ? r - iter : 1;
    if (frac <= 0) frac = 1;
  } else {
    iter = Math.floor(local / s.dur);
    frac = local / s.dur - iter;
  }
  const rev = s.direction === 'reverse' || (s.direction === 'alternate' && iter % 2 === 1) || (s.direction === 'alternate-reverse' && iter % 2 === 0);
  return rev ? 1 - frac : frac;
}

function easeAt(e: Ease, u: number): number {
  if (!e) return u;
  if (Array.isArray(e)) return cubicBezier(e[0], e[1], e[2], e[3])(u);
  const n = Math.max(1, e.steps);
  return Math.min(1, (e.start ? Math.ceil(u * n) : Math.floor(u * n)) / n);
}

/** Animation value at cycle fraction p: the segment by keys, the segment's curve. */
function valueAtPhase(s: AnimSpec, p: number, box: [number, number, number, number]): { v: Value; m?: Matrix } {
  const f = s.frames;
  if (f.length === 1) return { v: f[0]!.v };
  let i = 0;
  while (i < f.length - 2 && p >= f[i + 1]!.k) i++;
  const a = f[i]!;
  const b = f[i + 1]!;
  if (s.discrete) return { v: p >= b.k ? b.v : a.v };
  const span = b.k - a.k;
  const u = span > 0 ? Math.max(0, Math.min(1, (p - a.k) / span)) : 1;
  const k = easeAt(s.eases[i] ?? null, u);
  if (Array.isArray(a.v) && Array.isArray(b.v) && (a.v.length === 0 || typeof a.v[0] === 'number') && (b.v.length === 0 || typeof b.v[0] === 'number')) {
    const x = a.v as number[];
    const y = b.v as number[];
    return { v: Array.from({ length: Math.max(x.length, y.length) }, (_, j) => lerp(x[j] ?? 0, y[j] ?? 0, k)) };
  }
  if (!Array.isArray(a.v) && !Array.isArray(b.v)) {
    const c = a.v as RGBA;
    const d = b.v as RGBA;
    return { v: { r: lerp(c.r, d.r, k), g: lerp(c.g, d.g, k), b: lerp(c.b, d.b, k), a: lerp(c.a, d.a, k) } };
  }
  return { v: a.v, m: lerpTransform(a.v as TransformFn[], b.v as TransformFn[], k, box) };
}

// ---------- Collecting animations ----------

const CSS_EASE: Record<string, Ease> = {
  linear: null,
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  'step-start': { steps: 1, start: true },
  'step-end': { steps: 1, start: false },
};

function parseEase(v: string | undefined): Ease {
  if (!v) return CSS_EASE.ease!;
  const s = v.trim().toLowerCase();
  if (s in CSS_EASE) return CSS_EASE[s]!;
  const cb = /^cubic-bezier\(([^)]+)\)$/.exec(s);
  if (cb) {
    const p = nums(cb[1]!);
    if (p.length === 4) return [p[0]!, p[1]!, p[2]!, p[3]!];
  }
  const st = /^steps\(\s*(\d+)\s*(?:,\s*([\w-]+))?\s*\)$/.exec(s);
  if (st) return { steps: parseInt(st[1]!, 10), start: st[2] === 'start' || st[2] === 'jump-start' };
  return null;
}

/** Property value from a string (the type depends on the property). */
function parseValue(attr: AnimAttr, v: string, transformType?: string): Value | null {
  switch (attr) {
    case 'fill':
    case 'stroke': {
      const c = parseCssColor(v);
      return c;
    }
    case 'transform':
      return transformType ? nums(v) : parseCssTransform(v);
    case 'motion':
      return nums(v);
    default: {
      const s = v.trim();
      const x = parseFloat(s);
      if (!Number.isFinite(x)) return null;
      return [s.endsWith('%') && (attr === 'opacity' || attr === 'fill-opacity' || attr === 'stroke-opacity') ? x / 100 : x];
    }
  }
}

/** Base (static) value of an element property — for “to” animations and missing CSS keys. */
export type BaseOf = (attr: AnimAttr) => string | undefined;

function evenKeys(n: number, discrete: boolean): number[] {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => (discrete ? i / n : i / (n - 1)));
}

/** SMIL animation from an <animate…> element; null — unsupported or incomplete. */
function smilSpec(a: SvgEl, base: BaseOf): AnimSpec | null {
  const tag = tagOf(a);
  const transformType = tag === 'animatetransform' ? (a.getAttribute('type') ?? 'translate') : undefined;
  const attr = (tag === 'animatemotion' ? 'motion' : tag === 'animatetransform' ? 'transform' : (a.getAttribute('attributeName') ?? '').toLowerCase()) as AnimAttr;
  if (!SUPPORTED.has(attr)) return null;
  // Begin: the first time value (events — click, id.end — are not supported: the animation starts at zero).
  const beginRaw = (a.getAttribute('begin') ?? '0s').split(';')[0]!.trim();
  if (beginRaw === 'indefinite') return null;
  const begin = parseTime(beginRaw) ?? 0;
  const set = tag === 'set';
  const durRaw = a.getAttribute('dur');
  let dur = durRaw && durRaw !== 'indefinite' && durRaw !== 'media' ? (parseTime(durRaw) ?? 0) : set ? 1e6 : 0;
  const rc = a.getAttribute('repeatCount');
  const rd = parseTime(a.getAttribute('repeatDur'));
  let repeat = rc === 'indefinite' || a.getAttribute('repeatDur') === 'indefinite' ? Infinity : rc ? parseFloat(rc) || 1 : rd && dur > 0 ? rd / dur : 1;
  if (!(dur > 0)) {
    if (!set) return null;
    dur = 1e6;
  }
  const calc = (a.getAttribute('calcMode') ?? (tag === 'animatemotion' ? 'paced' : 'linear')).toLowerCase();
  const discrete = set || calc === 'discrete';
  const additive = a.getAttribute('additive') === 'sum';
  const freeze = set || a.getAttribute('fill') === 'freeze';
  let raw: string[];
  let motion: AnimSpec['motion'];
  if (attr === 'motion') {
    // Path: path, <mpath href>, or from/to/values as points.
    const d = a.getAttribute('path');
    const rot = a.getAttribute('rotate') ?? '0';
    motion = d ? { d, rotate: rot === 'auto' || rot === 'auto-reverse' ? rot : parseFloat(rot) || 0 } : undefined;
    const kp = a.getAttribute('keyPoints');
    raw = motion ? (kp ? kp.split(';') : ['0', '1']) : (a.getAttribute('values')?.split(';') ?? [a.getAttribute('from') ?? '0,0', a.getAttribute('to') ?? '0,0']);
    if (motion && !kp && discrete) raw = ['0', '1'];
  } else if (set) raw = [a.getAttribute('to') ?? ''];
  else if (a.getAttribute('values')) raw = a.getAttribute('values')!.split(';');
  else {
    const from = a.getAttribute('from');
    const to = a.getAttribute('to');
    const by = a.getAttribute('by');
    const start = from ?? base(attr) ?? '0';
    if (to !== null) raw = [start, to];
    else if (by !== null) {
      const s0 = nums(transformType ? (from ?? '0') : start);
      const b = nums(by);
      raw = [s0.join(' '), b.map((x, i) => x + (s0[i] ?? 0)).join(' ')];
    } else return null;
  }
  raw = raw.map((x) => x.trim()).filter((x) => x !== '');
  if (!raw.length) return null;
  const values = raw.map((x) => parseValue(attr, x, transformType));
  if (values.some((v) => v === null)) return null;
  const kt = (a.getAttribute('keyTimes') ?? '').split(';').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
  const keys = kt.length === values.length ? kt : evenKeys(values.length, discrete);
  const splines = calc === 'spline' ? (a.getAttribute('keySplines') ?? '').split(';').map((x) => nums(x)) : [];
  const eases: Ease[] = keys.slice(0, -1).map((_, i) => (splines[i]?.length === 4 ? (splines[i] as [number, number, number, number]) : null));
  // Discrete: each value gets its own interval (the last one until the end).
  const frames = values.map((v, i) => ({ k: keys[i]!, v: v! }));
  if (discrete && frames.length > 1 && !kt.length) frames.forEach((f, i) => (f.k = i / frames.length));
  return { attr, source: 'smil', transformType, frames, eases, discrete, begin, dur, repeat, freeze, backwards: false, direction: 'normal', additive, motion };
}

/** CSS animations of an element from its style (animation…). */
function cssSpecs(style: Style, sheet: Stylesheet, base: BaseOf): AnimSpec[] {
  const list = (key: string) => (style[key] ? splitTop(style[key]!) : []);
  let names = list('animation-name');
  let durs = list('animation-duration');
  let eases = list('animation-timing-function');
  let delays = list('animation-delay');
  let counts = list('animation-iteration-count');
  let dirs = list('animation-direction');
  let fills = list('animation-fill-mode');
  if (style.animation) {
    // Shorthand: name, duration, delay (the second time), curve, repeats, direction, fill mode.
    names = [];
    durs = [];
    eases = [];
    delays = [];
    counts = [];
    dirs = [];
    fills = [];
    for (const one of splitTop(style.animation)) {
      const tokens = one.match(/[\w-]+\([^)]*\)|[^\s]+/g) ?? [];
      let times = 0;
      let name = '';
      let ease = 'ease';
      let count = '1';
      let dir = 'normal';
      let fill = 'none';
      for (const tk of tokens) {
        const t = tk.toLowerCase();
        const time = parseTime(t);
        if (time !== null && /[\d.](ms|s)$/.test(t)) {
          if (times++ === 0) durs.push(t);
          else delays.push(t);
        } else if (t in CSS_EASE || t.startsWith('cubic-bezier') || t.startsWith('steps')) ease = t;
        else if (t === 'infinite' || /^[\d.]+$/.test(t)) count = t;
        else if (['normal', 'reverse', 'alternate', 'alternate-reverse'].includes(t)) dir = t;
        else if (['none', 'forwards', 'backwards', 'both'].includes(t)) fill = t;
        else if (['running', 'paused'].includes(t)) continue;
        else name = tk;
      }
      if (times < 2) delays.push('0s');
      if (!times) durs.push('0s');
      names.push(name);
      eases.push(ease);
      counts.push(count);
      dirs.push(dir);
      fills.push(fill);
    }
  }
  const out: AnimSpec[] = [];
  names.forEach((name, i) => {
    const frames = sheet.keyframes.get(name);
    const at = <T,>(arr: T[], d: T) => (arr.length ? arr[i % arr.length]! : d);
    const dur = parseTime(at(durs, '0s')) ?? 0;
    if (!frames || !(dur > 0)) return;
    const begin = parseTime(at(delays, '0s')) ?? 0;
    const countRaw = at(counts, '1');
    const repeat = countRaw === 'infinite' ? Infinity : parseFloat(countRaw) || 1;
    const dir = at(dirs, 'normal') as AnimSpec['direction'];
    const fill = at(fills, 'none');
    const defEase = parseEase(at(eases, 'ease'));
    // Keyframe properties: each one as its own animation (keys only where the property is set).
    const props = new Set<string>();
    for (const f of frames) for (const k of Object.keys(f.decls)) props.add(k);
    for (const prop of props) {
      const attr = prop as AnimAttr;
      if (!SUPPORTED.has(attr) || attr === 'motion') continue;
      const pts: { k: number; raw: string; ease: Ease }[] = [];
      for (const f of frames) {
        if (f.decls[prop] === undefined) continue;
        const e = f.decls['animation-timing-function'] ? parseEase(f.decls['animation-timing-function']) : defEase;
        for (const k of f.offsets) pts.push({ k, raw: f.decls[prop]!, ease: e });
      }
      pts.sort((a, b) => a.k - b.k);
      // No 0 % or 100 % — the element's value without the animation.
      const b = base(attr) ?? (attr === 'transform' ? 'none' : undefined);
      if (b !== undefined && (!pts.length || pts[0]!.k > 0)) pts.unshift({ k: 0, raw: b, ease: defEase });
      if (b !== undefined && pts[pts.length - 1]!.k < 1) pts.push({ k: 1, raw: b, ease: defEase });
      const values = pts.map((p) => parseValue(attr, p.raw));
      if (values.some((v) => v === null) || pts.length < 1) continue;
      out.push({
        attr,
        source: 'css',
        frames: pts.map((p, j) => ({ k: p.k, v: values[j]! })),
        eases: pts.slice(0, -1).map((p) => p.ease),
        discrete: false,
        begin,
        dur,
        repeat,
        freeze: fill === 'forwards' || fill === 'both',
        backwards: fill === 'backwards' || fill === 'both',
        direction: ['normal', 'reverse', 'alternate', 'alternate-reverse'].includes(dir) ? dir : 'normal',
        additive: false,
      });
    }
  });
  return out;
}

/** Top-level comma-separated parts (commas inside parentheses stay inside). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * Animations of all tree elements: SMIL (child <animate…> or by href) and CSS (by the element style:
 * stylesheet + style=""). styleOf — the resulting own style, baseOf — static values.
 */
export function collectAnimations(root: SvgEl, sheet: Stylesheet, styleOf: (el: SvgEl) => Style, byId: Map<string, SvgEl>, baseOf: (el: SvgEl) => BaseOf): Map<SvgEl, AnimSpec[]> {
  const out = new Map<SvgEl, AnimSpec[]>();
  const add = (el: SvgEl, s: AnimSpec | null) => {
    if (!s) return;
    const list = out.get(el) ?? [];
    list.push(s);
    out.set(el, list);
  };
  const ANIM = new Set(['animate', 'animatetransform', 'animatemotion', 'set']);
  const walk = (el: SvgEl, parent: SvgEl | null) => {
    const tag = tagOf(el);
    if (ANIM.has(tag)) {
      const href = el.getAttribute('href') ?? el.getAttribute('xlink:href');
      const target = href?.startsWith('#') ? byId.get(href.slice(1)) : parent;
      if (target) {
        const spec = smilSpec(el, baseOf(target));
        // <mpath href> — the motion path from another element.
        if (spec?.attr === 'motion' && !spec.motion) {
          for (const c of el.children) {
            if (tagOf(c) !== 'mpath') continue;
            const ref = (c.getAttribute('href') ?? c.getAttribute('xlink:href') ?? '').replace(/^#/, '');
            const d = byId.get(ref)?.getAttribute('d');
            const rot = el.getAttribute('rotate') ?? '0';
            if (d) {
              spec.motion = { d, rotate: rot === 'auto' || rot === 'auto-reverse' ? rot : parseFloat(rot) || 0 };
              spec.frames = [{ k: 0, v: [0] }, { k: 1, v: [1] }];
              spec.eases = [null];
            }
          }
        }
        add(target, spec);
      }
      return;
    }
    if (tag !== 'style' && tag !== 'defs') for (const s of cssSpecs(styleOf(el), sheet, baseOf(el))) add(el, s);
    for (const c of el.children) walk(c, el);
  };
  walk(root, null);
  return out;
}

// ---------- Timeline time ----------

/** Timeline duration and repeat: infinite animations — the common period (LCM), otherwise — until the end of the last one. */
export function timelineOf(specs: AnimSpec[]): { duration: number; loop: boolean } {
  const infinite = specs.filter((s) => !Number.isFinite(s.repeat));
  const finiteEnd = Math.max(0, ...specs.filter((s) => Number.isFinite(s.repeat) && s.dur < 1e5).map((s) => s.begin + s.dur * s.repeat));
  if (!infinite.length) return { duration: Math.max(0.1, finiteEnd), loop: false };
  // Period: LCM of the durations (hundredths of a second), no longer than 20 s; start — after all delays.
  const cs = infinite.map((s) => Math.max(1, Math.round(s.dur * (s.direction.startsWith('alternate') ? 2 : 1) * 100)));
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  let l = cs[0]!;
  for (const c of cs.slice(1)) {
    l = (l / gcd(l, c)) * c;
    if (l > 2000) break;
  }
  const period = l <= 2000 ? l / 100 : Math.max(...cs) / 100;
  return { duration: Math.max(period, finiteEnd), loop: true };
}

// ---------- Frame-by-frame pose ----------

export interface AnimatedElement {
  el: SvgEl;
  specs: AnimSpec[];
  /** Parent matrix (before its own transform) in frame coordinates. */
  parent: Matrix;
  /** Own static transform (attribute or CSS). */
  own: Matrix;
  /** Element bounds in its own coordinates (transform-box: fill-box) and the viewBox bounds. */
  box: [number, number, number, number];
  viewBox: [number, number, number, number];
  /** transform-origin and transform-box (CSS). */
  origin?: string;
  fillBox: boolean;
  /** Ancestors' opacity (the layer gets its own opacity itself). */
  ancestorsOpacity: number;
  /** Static values. */
  opacity: number;
  fill: RGBA | null;
  stroke: RGBA | null;
  fillOpacity: number;
  strokeOpacity: number;
  strokeWidth: number;
  /** Matrix scale (stroke width) and path length (trim via dashes). */
  scale: number;
  length?: number;
  pathLength?: number;
  dash?: number[];
  dashOffset: number;
  geom: { x: number; y: number; cx: number; cy: number; r: number; width: number; height: number };
  /** Length and a point on the path (animateMotion). */
  motionAt?(d: string, frac: number): { x: number; y: number; angle: number } | null;
}

/** The transform-origin point in the element's own coordinates. */
function originPoint(a: AnimatedElement): [number, number] {
  const ref = a.fillBox ? a.box : a.viewBox;
  const w = ref[2] - ref[0];
  const h = ref[3] - ref[1];
  const parts = (a.origin ?? '0 0').trim().toLowerCase().split(/\s+/);
  const kw: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  const one = (v: string | undefined, size: number, start: number, axis: 'x' | 'y'): number => {
    if (v === undefined) return start + size / 2;
    if (v in kw) {
      // “top”/“bottom” in the second position and “left”/“right” in the first — on their own axis.
      if ((axis === 'x' && (v === 'top' || v === 'bottom')) || (axis === 'y' && (v === 'left' || v === 'right'))) return start + size / 2;
      return start + kw[v]! * size;
    }
    if (v.endsWith('%')) return start + (parseFloat(v) / 100) * size;
    // Length is from the element's origin (fill-box: from the bounds corner).
    return (a.fillBox ? start : 0) + parseFloat(v);
  };
  let [px, py] = parts;
  // A single vertical keyword (“top”) goes first.
  if (px === 'top' || px === 'bottom') [px, py] = [py, px];
  return [one(px, w, ref[0], 'x'), one(py ?? (parts.length === 1 && px === 'center' ? 'center' : px === undefined ? undefined : 'center'), h, ref[1], 'y')];
}

/** Element state at moment t: matrix (in frame coordinates), opacity, colors, dashes. */
export interface Pose {
  /** Matrix change relative to the static one (in frame coordinates). */
  delta: Matrix;
  opacity: number;
  fill: RGBA | null;
  stroke: RGBA | null;
  strokeWidth: number;
  /** Visible part of the path by dashes (trim), if the dashes look like “line drawing”. */
  trim: [number, number] | null;
}

/** Effective value of the animations of attribute attr at moment t (the last active one; additive — the sum). */
function current(a: AnimatedElement, attr: AnimAttr, t: number): Value | null {
  let out: Value | null = null;
  for (const s of a.specs) {
    if (s.attr !== attr) continue;
    const p = phase(s, t);
    if (p === null) continue;
    const { v } = valueAtPhase(s, p, a.box);
    out = s.additive && Array.isArray(out) && Array.isArray(v) && typeof (v as number[])[0] === 'number' ? (out as number[]).map((x, i) => x + ((v as number[])[i] ?? 0)) : v;
  }
  return out;
}

/** The element's own matrix at moment t (before the parent matrix). */
function ownMatrix(a: AnimatedElement, t: number): Matrix {
  let m = a.own;
  // CSS transform replaces the attribute; SMIL animateTransform replaces or adds (additive).
  let replaced = false;
  for (const s of a.specs) {
    if (s.attr !== 'transform') continue;
    const p = phase(s, t);
    if (p === null) continue;
    const r = valueAtPhase(s, p, a.box);
    let tm: Matrix;
    if (s.source === 'css') {
      const o = originPoint(a);
      const inner = r.m ?? cssMatrix(r.v as TransformFn[], a.box);
      tm = multiply(multiply(translate(o[0], o[1]), inner), translate(-o[0], -o[1]));
      m = tm;
      replaced = true;
      continue;
    }
    tm = smilMatrix(s.transformType ?? 'translate', r.v as number[]);
    if (s.additive) m = multiply(m, tm);
    else m = tm;
    replaced = true;
  }
  // Motion along a path goes on top (in parent coordinates).
  for (const s of a.specs) {
    if (s.attr !== 'motion') continue;
    const p = phase(s, t);
    if (p === null) continue;
    const r = valueAtPhase(s, p, a.box).v as number[];
    if (s.motion && a.motionAt) {
      const pt = a.motionAt(s.motion.d, Math.max(0, Math.min(1, r[0] ?? 0)));
      if (!pt) continue;
      const rot = s.motion.rotate === 'auto' ? pt.angle : s.motion.rotate === 'auto-reverse' ? pt.angle + 180 : s.motion.rotate;
      m = multiply(multiply(translate(pt.x, pt.y), rotateM(rot)), m);
    } else m = multiply(translate(r[0] ?? 0, r[1] ?? 0), m);
  }
  // Geometry: x/y/cx/cy — translation, r — scale from the circle center, width/height — from the corner.
  const g = a.geom;
  const num = (attr: AnimAttr, d: number) => {
    const v = current(a, attr, t);
    return Array.isArray(v) && typeof v[0] === 'number' ? (v[0] as number) : d;
  };
  const dx = num('x', g.x) - g.x + num('cx', g.cx) - g.cx;
  const dy = num('y', g.y) - g.y + num('cy', g.cy) - g.cy;
  let geo: Matrix = translate(dx, dy);
  const r = num('r', g.r);
  if (g.r > 0 && r !== g.r) geo = multiply(geo, multiply(multiply(translate(g.cx, g.cy), scaleM(r / g.r, r / g.r)), translate(-g.cx, -g.cy)));
  const w = num('width', g.width);
  const h = num('height', g.height);
  if ((g.width > 0 && w !== g.width) || (g.height > 0 && h !== g.height)) {
    geo = multiply(geo, multiply(multiply(translate(g.x, g.y), scaleM(g.width > 0 ? w / g.width : 1, g.height > 0 ? h / g.height : 1)), translate(-g.x, -g.y)));
  }
  return multiply(m, geo);
}

/** Visible part of a path of length L with dashes [dash, gap] and offset o; null — does not look like a trim. */
export function dashTrim(dash: number[], offset: number, length: number): [number, number] | null {
  if (!(length > 0) || !dash.length) return null;
  const d = dash[0]!;
  const g = dash.length > 1 ? dash[1]! : d;
  // A trim — when a single dash fits on the path (the gap is at least the length).
  if (dash.length > 2 || g < length * 0.98 || d <= 0) return null;
  const period = d + g;
  let start = -offset;
  // The dash that touches [0, L].
  start -= Math.floor((start + d) / period) * period;
  if (start + d <= 0) start += period;
  const a = Math.max(0, start);
  const b = Math.min(length, start + d);
  return b > a ? [a / length, b / length] : [0, 0];
}

/** Element pose at moment t. */
export function poseAt(a: AnimatedElement, t: number): Pose {
  const own = ownMatrix(a, t);
  // Change relative to the static pose — in frame coordinates: P · own(t) · own₀⁻¹ · P⁻¹.
  const inv0 = invert(a.own) ?? ID;
  const invP = invert(a.parent) ?? ID;
  const delta = multiply(multiply(multiply(a.parent, own), inv0), invP);
  const num = (attr: AnimAttr, d: number) => {
    const v = current(a, attr, t);
    return Array.isArray(v) && typeof v[0] === 'number' ? (v[0] as number) : d;
  };
  const col = (attr: 'fill' | 'stroke', d: RGBA | null): RGBA | null => {
    const v = current(a, attr, t);
    return v && !Array.isArray(v) ? (v as RGBA) : d;
  };
  const fill = col('fill', a.fill);
  const stroke = col('stroke', a.stroke);
  const fo = num('fill-opacity', a.fillOpacity);
  const so = num('stroke-opacity', a.strokeOpacity);
  let trim: [number, number] | null = null;
  if (a.dash && a.length && a.specs.some((s) => s.attr === 'stroke-dashoffset')) {
    // Dash lengths are in pathLength units, if it is set.
    const k = a.pathLength && a.pathLength > 0 ? a.length / a.pathLength : 1;
    trim = dashTrim(a.dash.map((x) => x * k), num('stroke-dashoffset', a.dashOffset) * k, a.length);
  }
  return {
    delta,
    opacity: a.ancestorsOpacity * Math.max(0, Math.min(1, num('opacity', a.opacity))),
    fill: fill && { ...fill, a: fill.a * fo },
    stroke: stroke && { ...stroke, a: stroke.a * so },
    strokeWidth: num('stroke-width', a.strokeWidth) * a.scale,
    trim,
  };
}

// ---------- Keys ----------

/** Thinning: drop points lying on a straight line between neighboring kept ones (within tolerance tol). */
export function simplify(times: number[], values: number[][], tol: number[]): number[] {
  const keep = [0];
  for (let j = 1; j < times.length - 1; j++) {
    const a = keep[keep.length - 1]!;
    const b = j + 1;
    const u = (times[j]! - times[a]!) / Math.max(1e-9, times[b]! - times[a]!);
    const off = values[j]!.some((v, d) => Math.abs(values[a]![d]! + (values[b]![d]! - values[a]![d]!) * u - v) > tol[d]!);
    if (off) keep.push(j);
  }
  if (times.length > 1) keep.push(times.length - 1);
  return keep;
}

/** Track from per-frame values: straight segments between kept frames (a jump — within one frame). */
export function bakeTrack(property: AnimProperty, times: number[], values: (number | RGBA)[], tol: number): AnimTrack | null {
  const vec = values.map((v) => (typeof v === 'number' ? [v] : [v.r, v.g, v.b, v.a]));
  const first = vec[0]!;
  if (vec.every((v) => v.every((x, i) => Math.abs(x - first[i]!) <= tol))) return null;
  const keep = simplify(times, vec, first.map(() => tol));
  const keys: Keyframe[] = keep.map((i) => ({ t: Math.round(times[i]! * 1000) / 1000, value: values[i]!, easing: { type: 'LINEAR' } }));
  return { property, keys };
}

// ---------- Exact keys ----------

/** Animation segment boundary: the moment and the curve of the segment starting there. */
export interface Boundary {
  t: number;
  easing?: Easing;
}

const bezierEasing = (b: [number, number, number, number]): Easing => ({ type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: b[0], y1: b[1], x2: b[2], y2: b[3] } });

/** Segment curve in the timeline (a reverse pass — the curve reversed); null — cannot be expressed as a key. */
function easingOf(e: Ease, reversed: boolean, discrete: boolean): Easing | null {
  if (discrete) return { type: 'HOLD' };
  if (!e) return { type: 'LINEAR' };
  if (Array.isArray(e)) return bezierEasing(reversed ? [1 - e[2], 1 - e[3], 1 - e[0], 1 - e[1]] : e);
  // steps(1, end) — hold; other steps cannot be expressed.
  return e.steps === 1 && !e.start && !reversed ? { type: 'HOLD' } : null;
}

/**
 * Animation segment boundaries on [0, duration]: each cycle of each animation contributes its keys (a reverse
 * cycle — in reverse order). Overlapping segments with different curves get no curve
 * (the frame-by-frame check decides whether exact keys are usable).
 */
export function boundaries(specs: AnimSpec[], duration: number): Boundary[] {
  const map = new Map<number, Easing | null | undefined>();
  const put = (t: number, e: Easing | null | undefined) => {
    if (t < -1e-9 || t > duration + 1e-9) return;
    const key = Math.round(Math.max(0, Math.min(duration, t)) * 1000) / 1000;
    const prev = map.get(key);
    map.set(key, prev === undefined ? e : prev && e && JSON.stringify(prev) === JSON.stringify(e) ? prev : e === undefined ? prev : null);
  };
  put(0, undefined);
  put(duration, undefined);
  for (const s of specs) {
    if (!(s.dur > 0)) continue;
    const iterations = Number.isFinite(s.repeat) ? Math.ceil(s.repeat) : Math.ceil((duration - s.begin) / s.dur) + 1;
    for (let i = 0; i < iterations && i < 2000; i++) {
      const t0 = s.begin + i * s.dur;
      if (t0 > duration) break;
      const rev = s.direction === 'reverse' || (s.direction === 'alternate' && i % 2 === 1) || (s.direction === 'alternate-reverse' && i % 2 === 0);
      const f = s.frames;
      for (let j = 0; j < f.length; j++) {
        const k = rev ? 1 - f[j]!.k : f[j]!.k;
        // Curve of the segment starting at this key (in a reverse cycle — segment j−1 reversed).
        const seg = rev ? j - 1 : j;
        const e = seg >= 0 && seg < f.length - 1 ? easingOf(s.eases[seg] ?? null, rev, s.discrete) : undefined;
        put(t0 + k * s.dur, e);
      }
      // End of the cycle (a fractional repeat — its fraction).
      const end = Number.isFinite(s.repeat) && i === iterations - 1 ? s.begin + s.repeat * s.dur : t0 + s.dur;
      put(end, undefined);
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, e]) => ({ t, ...(e ? { easing: e } : e === null ? { easing: { type: 'LINEAR' as const } } : {}) }));
}
