// Executing PDF page content → a draw list in page coordinates (y down): paths with fill and
// stroke (color or gradient), images, text lines, clip tree. Graphics state (q / Q, cm, colors and
// color spaces, line width, caps, dashes, opacity and blending from ExtGState), text (BT…ET, Tf,
// Tm, Td, Tj, TJ, ' ") — lines are assembled along the baseline; forms (Form XObject) with their
// own matrix and resources; shading fills (sh) and gradient patterns; color functions — types
// 0, 2, 3, 4.

import { Keyword, Lexer, PdfDict, PdfName, PdfStream, PdfString, parseValue, type PdfFile, type PdfObj } from './parser.ts';
import { loadFont, type PdfFont } from './fonts.ts';

/** Matrix [a, b, c, d, e, f]: x' = a·x + b·y + c, y' = d·x + e·y + f. */
export type M = [number, number, number, number, number, number];

const mul = (p: M, q: M): M => [p[0] * q[0] + p[1] * q[3], p[0] * q[1] + p[1] * q[4], p[0] * q[2] + p[1] * q[5] + p[2], p[3] * q[0] + p[4] * q[3], p[3] * q[1] + p[4] * q[4], p[3] * q[2] + p[4] * q[5] + p[5]];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
/** PDF matrix (a b c d e f) → ours. */
const pdfM = (a: number[]): M => [a[0] ?? 1, a[2] ?? 0, a[4] ?? 0, a[1] ?? 0, a[3] ?? 1, a[5] ?? 0];

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type Paint =
  | { kind: 'solid'; color: RGBA }
  | { kind: 'linear' | 'radial'; stops: { pos: number; color: RGBA }[]; p0: [number, number]; p1: [number, number]; r0?: number; r1?: number; alpha: number };

/** Path: commands in page coordinates. */
export interface PathData {
  cmds: (['M' | 'L', number, number] | ['C', number, number, number, number, number, number] | ['Z'])[];
  box: [number, number, number, number];
}

export interface Clip {
  path: PathData;
  evenOdd: boolean;
  parent: Clip | null;
}

export type Item =
  | {
      kind: 'path';
      path: PathData;
      fill?: Paint;
      evenOdd: boolean;
      stroke?: { paint: Paint; width: number; cap: number; join: number; miter: number; dash: number[] };
      clip: Clip | null;
      blend?: string;
    }
  | { kind: 'image'; image: PdfStream; m: M; alpha: number; clip: Clip | null; stencil?: RGBA; blend?: string }
  | { kind: 'text'; text: string; font: PdfFont; size: number; x: number; y: number; angle: number; width: number; color: RGBA; stroke: boolean; clip: Clip | null };

interface GState {
  ctm: M;
  fill: Paint;
  stroke: Paint;
  fillSpace: ColorSpace;
  strokeSpace: ColorSpace;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  cap: number;
  join: number;
  miter: number;
  dash: number[];
  dashPhase: number;
  clip: Clip | null;
  blend?: string;
  // Text.
  font: PdfFont | null;
  fontSize: number;
  charSpace: number;
  wordSpace: number;
  hScale: number;
  leading: number;
  rise: number;
  render: number;
}

const BLEND: Record<string, string> = {
  Multiply: 'MULTIPLY',
  Screen: 'SCREEN',
  Overlay: 'OVERLAY',
  Darken: 'DARKEN',
  Lighten: 'LIGHTEN',
  ColorDodge: 'COLOR_DODGE',
  ColorBurn: 'COLOR_BURN',
  HardLight: 'HARD_LIGHT',
  SoftLight: 'SOFT_LIGHT',
  Difference: 'DIFFERENCE',
  Exclusion: 'EXCLUSION',
  Hue: 'HUE',
  Saturation: 'SATURATION',
  Color: 'COLOR',
  Luminosity: 'LUMINOSITY',
};

// ---------- Color spaces and functions ----------

type Fn = (input: number[]) => number[];

export interface ColorSpace {
  n: number;
  toRGB(c: number[]): RGBA;
  /** Patterns: pattern name → paint. */
  pattern?: boolean;
  /** Initial color. */
  initial: number[];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const gray: ColorSpace = { n: 1, initial: [0], toRGB: ([g = 0]) => ({ r: clamp01(g), g: clamp01(g), b: clamp01(g), a: 1 }) };
const rgb: ColorSpace = { n: 3, initial: [0, 0, 0], toRGB: ([r = 0, g = 0, b = 0]) => ({ r: clamp01(r), g: clamp01(g), b: clamp01(b), a: 1 }) };
const cmyk: ColorSpace = {
  n: 4,
  initial: [0, 0, 0, 1],
  toRGB: ([c = 0, m = 0, y = 0, k = 0]) => ({ r: clamp01((1 - c) * (1 - k)), g: clamp01((1 - m) * (1 - k)), b: clamp01((1 - y) * (1 - k)), a: 1 }),
};

export async function colorSpace(file: PdfFile, o: PdfObj | undefined, resources: PdfDict | null, depth = 0): Promise<ColorSpace> {
  const v = await file.resolve(o);
  if (v instanceof PdfName) {
    switch (v.v) {
      case 'DeviceGray':
      case 'G':
      case 'CalGray':
        return gray;
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
        return rgb;
      case 'DeviceCMYK':
      case 'CMYK':
        return cmyk;
      case 'Pattern':
        return { n: 1, initial: [0], pattern: true, toRGB: () => ({ r: 0.5, g: 0.5, b: 0.5, a: 1 }) };
    }
    // Name from the /ColorSpace resources.
    const named = resources ? await file.dict(resources.get('ColorSpace')) : null;
    const r = named?.get(v.v);
    if (r !== undefined && depth < 4) return colorSpace(file, r, resources, depth + 1);
    return rgb;
  }
  if (!Array.isArray(v) || !(v[0] instanceof PdfName)) return rgb;
  const kind = (v[0] as PdfName).v;
  switch (kind) {
    case 'ICCBased': {
      const s = await file.resolve(v[1]);
      const n = s instanceof PdfStream ? await file.num(s.dict.get('N'), 3) : 3;
      const alt = s instanceof PdfStream ? s.dict.get('Alternate') : undefined;
      if (alt && depth < 4) return colorSpace(file, alt, resources, depth + 1);
      return n === 1 ? gray : n === 4 ? cmyk : rgb;
    }
    case 'Indexed':
    case 'I': {
      const base = await colorSpace(file, v[1], resources, depth + 1);
      const hival = await file.num(v[2], 255);
      const lk = await file.resolve(v[3]);
      const table = lk instanceof PdfString ? lk.bytes : lk instanceof PdfStream ? await file.decode(lk) : new Uint8Array();
      return {
        n: 1,
        initial: [0],
        toRGB: ([i = 0]) => {
          const k = Math.max(0, Math.min(hival, Math.round(i)));
          const comps = Array.from({ length: base.n }, (_, j) => (table[k * base.n + j] ?? 0) / 255);
          return base.toRGB(comps);
        },
      };
    }
    case 'Separation':
    case 'DeviceN': {
      const names = kind === 'Separation' ? 1 : ((await file.array(v[1])) ?? []).length;
      const alt = await colorSpace(file, v[2], resources, depth + 1);
      const fn = await makeFunction(file, v[3]);
      const isNone = kind === 'Separation' && v[1] instanceof PdfName && v[1].v === 'None';
      return {
        n: Math.max(1, names),
        initial: Array(Math.max(1, names)).fill(1),
        toRGB: (c) => {
          if (isNone) return { r: 1, g: 1, b: 1, a: 0 };
          return alt.toRGB(fn ? fn(c) : alt.initial);
        },
      };
    }
    case 'Pattern':
      return { n: 1, initial: [0], pattern: true, toRGB: () => ({ r: 0.5, g: 0.5, b: 0.5, a: 1 }) };
    case 'Lab':
      return rgb;
    case 'CalRGB':
      return rgb;
    case 'CalGray':
      return gray;
  }
  return rgb;
}

/** PDF function (types 0, 2, 3, 4) or an array of functions (one per output). */
export async function makeFunction(file: PdfFile, o: PdfObj | undefined): Promise<Fn | null> {
  const v = await file.resolve(o);
  if (Array.isArray(v)) {
    const fns = (await Promise.all(v.map((x) => makeFunction(file, x)))).filter((f): f is Fn => !!f);
    return (inp) => fns.map((f) => f(inp)[0] ?? 0);
  }
  const d = v instanceof PdfStream ? v.dict : v instanceof PdfDict ? v : null;
  if (!d) return null;
  const type = await file.num(d.get('FunctionType'), -1);
  const nums = async (k: string) => ((await file.array(d.get(k))) ?? []).map((x) => (typeof x === 'number' ? x : 0));
  const domain = await nums('Domain');
  const range = await nums('Range');
  const clampIn = (x: number, i: number) => (domain.length > 2 * i + 1 ? Math.max(domain[2 * i]!, Math.min(domain[2 * i + 1]!, x)) : x);
  const clampOut = (out: number[]) => (range.length ? out.map((x, i) => (range.length > 2 * i + 1 ? Math.max(range[2 * i]!, Math.min(range[2 * i + 1]!, x)) : x)) : out);
  if (type === 2) {
    const c0 = (await nums('C0')).length ? await nums('C0') : [0];
    const c1 = (await nums('C1')).length ? await nums('C1') : [1];
    const n = await file.num(d.get('N'), 1);
    return (inp) => {
      const x = clampIn(inp[0] ?? 0, 0);
      return clampOut(c0.map((a, i) => a + Math.pow(x, n) * ((c1[i] ?? 0) - a)));
    };
  }
  if (type === 3) {
    const fns = await Promise.all(((await file.array(d.get('Functions'))) ?? []).map((x) => makeFunction(file, x)));
    const bounds = await nums('Bounds');
    const encode = await nums('Encode');
    return (inp) => {
      const x = clampIn(inp[0] ?? 0, 0);
      let k = 0;
      while (k < bounds.length && x >= bounds[k]!) k++;
      const lo = k === 0 ? (domain[0] ?? 0) : bounds[k - 1]!;
      const hi = k === bounds.length ? (domain[1] ?? 1) : bounds[k]!;
      const e0 = encode[2 * k] ?? 0;
      const e1 = encode[2 * k + 1] ?? 1;
      const t = hi > lo ? e0 + ((x - lo) / (hi - lo)) * (e1 - e0) : e0;
      return clampOut(fns[k]?.([t]) ?? [t]);
    };
  }
  if (type === 0 && v instanceof PdfStream) {
    const size = await nums('Size');
    const bps = await file.num(d.get('BitsPerSample'), 8);
    const enc = (await nums('Encode')).length ? await nums('Encode') : [0, (size[0] ?? 1) - 1];
    const dec = (await nums('Decode')).length ? await nums('Decode') : range;
    const data = await file.decode(v);
    const outN = Math.max(1, range.length / 2);
    const sample = (i: number, j: number) => {
      const bit = (i * outN + j) * bps;
      let x = 0;
      for (let k = 0; k < bps; k++) x = x * 2 + ((data[(bit + k) >> 3]! >> (7 - ((bit + k) & 7))) & 1);
      return x / (2 ** bps - 1);
    };
    return (inp) => {
      const x = clampIn(inp[0] ?? 0, 0);
      const d0 = domain[0] ?? 0;
      const d1 = domain[1] ?? 1;
      const e = enc[0]! + ((x - d0) / (d1 - d0 || 1)) * (enc[1]! - enc[0]!);
      const i0 = Math.max(0, Math.min((size[0] ?? 1) - 1, Math.floor(e)));
      const i1 = Math.min((size[0] ?? 1) - 1, i0 + 1);
      const f = e - i0;
      const out: number[] = [];
      for (let j = 0; j < outN; j++) {
        const s = sample(i0, j) * (1 - f) + sample(i1, j) * f;
        out.push((dec[2 * j] ?? 0) + s * ((dec[2 * j + 1] ?? 1) - (dec[2 * j] ?? 0)));
      }
      return clampOut(out);
    };
  }
  if (type === 4 && v instanceof PdfStream) {
    const code = new TextDecoder('latin1').decode(await file.decode(v));
    const prog = parsePostScript(code);
    return (inp) => {
      const stack = inp.map((x, i) => clampIn(x, i));
      runPostScript(prog, stack);
      const outN = range.length / 2 || stack.length;
      return clampOut(stack.slice(-outN).map((x) => (typeof x === 'number' ? x : 0)));
    };
  }
  return null;
}

type PsOp = number | string | PsOp[];

function parsePostScript(code: string): PsOp[] {
  const tokens = code.match(/[{}]|[^\s{}]+/g) ?? [];
  let i = 0;
  const block = (): PsOp[] => {
    const out: PsOp[] = [];
    while (i < tokens.length) {
      const t = tokens[i++]!;
      if (t === '{') out.push(block());
      else if (t === '}') return out;
      else out.push(/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : t);
    }
    return out;
  };
  const top = block();
  return (Array.isArray(top[0]) ? top[0] : top) as PsOp[];
}

function runPostScript(prog: PsOp[], st: number[]) {
  const b = (v: boolean) => (v ? 1 : 0);
  for (let i = 0; i < prog.length; i++) {
    const op = prog[i]!;
    if (typeof op === 'number') {
      st.push(op);
      continue;
    }
    if (Array.isArray(op)) {
      // if / ifelse: the blocks come before the operator.
      const next = prog[i + 1];
      if (next === 'if') {
        const c = st.pop()!;
        if (c) runPostScript(op, st);
        i++;
      } else if (Array.isArray(next) && prog[i + 2] === 'ifelse') {
        const c = st.pop()!;
        runPostScript(c ? op : next, st);
        i += 2;
      }
      continue;
    }
    const y = () => st.pop() ?? 0;
    switch (op) {
      case 'add': { const b2 = y(); st.push(y() + b2); break; }
      case 'sub': { const b2 = y(); st.push(y() - b2); break; }
      case 'mul': st.push(y() * y()); break;
      case 'div': { const b2 = y(); const a = y(); st.push(b2 ? a / b2 : 0); break; }
      case 'idiv': { const b2 = y(); const a = y(); st.push(b2 ? Math.trunc(a / b2) : 0); break; }
      case 'mod': { const b2 = y(); const a = y(); st.push(b2 ? a % b2 : 0); break; }
      case 'neg': st.push(-y()); break;
      case 'abs': st.push(Math.abs(y())); break;
      case 'sqrt': st.push(Math.sqrt(Math.max(0, y()))); break;
      case 'exp': { const e = y(); st.push(Math.pow(y(), e)); break; }
      case 'ln': st.push(Math.log(y())); break;
      case 'log': st.push(Math.log10(y())); break;
      case 'sin': st.push(Math.sin((y() * Math.PI) / 180)); break;
      case 'cos': st.push(Math.cos((y() * Math.PI) / 180)); break;
      case 'atan': { const den = y(); const num = y(); st.push((((Math.atan2(num, den) * 180) / Math.PI) + 360) % 360); break; }
      case 'floor': st.push(Math.floor(y())); break;
      case 'ceiling': st.push(Math.ceil(y())); break;
      case 'round': st.push(Math.round(y())); break;
      case 'truncate': case 'cvi': st.push(Math.trunc(y())); break;
      case 'cvr': break;
      case 'dup': { const a = y(); st.push(a, a); break; }
      case 'pop': y(); break;
      case 'exch': { const b2 = y(); const a = y(); st.push(b2, a); break; }
      case 'copy': { const n = y(); st.push(...st.slice(st.length - n)); break; }
      case 'index': { const n = y(); st.push(st[st.length - 1 - n] ?? 0); break; }
      case 'roll': {
        const j = y();
        const n = y();
        if (n > 0) {
          const part = st.splice(st.length - n, n);
          const k = ((j % n) + n) % n;
          st.push(...part.slice(n - k), ...part.slice(0, n - k));
        }
        break;
      }
      case 'eq': st.push(b(y() === y())); break;
      case 'ne': st.push(b(y() !== y())); break;
      case 'gt': { const b2 = y(); st.push(b(y() > b2)); break; }
      case 'ge': { const b2 = y(); st.push(b(y() >= b2)); break; }
      case 'lt': { const b2 = y(); st.push(b(y() < b2)); break; }
      case 'le': { const b2 = y(); st.push(b(y() <= b2)); break; }
      case 'and': st.push(y() & y()); break;
      case 'or': st.push(y() | y()); break;
      case 'xor': st.push(y() ^ y()); break;
      case 'not': st.push(~y()); break;
      case 'bitshift': { const s = y(); const a = y(); st.push(s >= 0 ? a << s : a >> -s); break; }
      case 'true': st.push(1); break;
      case 'false': st.push(0); break;
    }
  }
}

// ---------- Interpreter ----------

export interface PageContent {
  items: Item[];
  warnings: Set<string>;
}

interface Ctx {
  file: PdfFile;
  items: Item[];
  warnings: Set<string>;
  /** Page matrix (PDF page space → ours): for patterns. */
  base: M;
  fonts: Map<PdfDict, PdfFont>;
  depth: number;
}

/** Execute page (or form) content with resources; base — PDF space → page. */
export async function runPage(file: PdfFile, contents: Uint8Array, resources: PdfDict | null, base: M): Promise<PageContent> {
  const ctx: Ctx = { file, items: [], warnings: new Set(), base, fonts: new Map(), depth: 0 };
  const gs: GState = {
    ctm: base,
    fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
    stroke: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
    fillSpace: gray,
    strokeSpace: gray,
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    cap: 0,
    join: 0,
    miter: 10,
    dash: [],
    dashPhase: 0,
    clip: null,
    font: null,
    fontSize: 12,
    charSpace: 0,
    wordSpace: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    render: 0,
  };
  await run(ctx, contents, resources, gs);
  return { items: ctx.items, warnings: ctx.warnings };
}

const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]));
const withAlpha = (p: Paint, a: number): Paint => (p.kind === 'solid' ? { kind: 'solid', color: { ...p.color, a: p.color.a * a } } : { ...p, alpha: p.alpha * a });

async function run(ctx: Ctx, data: Uint8Array, resources: PdfDict | null, gs0: GState) {
  const { file } = ctx;
  let gs: GState = { ...gs0 };
  const stack: GState[] = [];
  const lx = new Lexer(data);
  const operands: PdfObj[] = [];
  // Path in progress.
  let path: PathData = { cmds: [], box: [Infinity, Infinity, -Infinity, -Infinity] };
  let start: [number, number] = [0, 0];
  let cur: [number, number] = [0, 0];
  let pendingClip: boolean | null = null;
  // Text.
  let tm: M = [1, 0, 0, 0, 1, 0];
  let tlm: M = [1, 0, 0, 0, 1, 0];
  let line: { text: string; x: number; y: number; ex: number; ey: number; angle: number; size: number; font: PdfFont; color: RGBA; stroke: boolean; clip: Clip | null } | null = null;

  const res = async (cat: string, name: string) => {
    const d = resources ? await file.dict(resources.get(cat)) : null;
    return d ? d.get(name) : undefined;
  };
  const point = (x: number, y: number): [number, number] => {
    const p = apply(gs.ctm, x, y);
    const b = path.box;
    b[0] = Math.min(b[0], p[0]);
    b[1] = Math.min(b[1], p[1]);
    b[2] = Math.max(b[2], p[0]);
    b[3] = Math.max(b[3], p[1]);
    return p;
  };
  const endPath = () => {
    if (pendingClip !== null && path.cmds.length) gs.clip = { path, evenOdd: pendingClip, parent: gs.clip };
    pendingClip = null;
    path = { cmds: [], box: [Infinity, Infinity, -Infinity, -Infinity] };
  };
  const paint = (fill: boolean, stroke: boolean, evenOdd: boolean) => {
    if (path.cmds.length) {
      const scale = scaleOf(gs.ctm);
      ctx.items.push({
        kind: 'path',
        path,
        evenOdd,
        fill: fill ? withAlpha(gs.fill, gs.fillAlpha) : undefined,
        stroke: stroke
          ? { paint: withAlpha(gs.stroke, gs.strokeAlpha), width: Math.max(gs.lineWidth * scale, 0.25), cap: gs.cap, join: gs.join, miter: gs.miter, dash: gs.dash.map((d) => d * scale) }
          : undefined,
        clip: gs.clip,
        blend: gs.blend,
      });
    }
    endPath();
  };
  const flushText = () => {
    if (line && line.text.trim()) {
      ctx.items.push({ kind: 'text', text: line.text, font: line.font, size: line.size, x: line.x, y: line.y, angle: line.angle, width: Math.hypot(line.ex - line.x, line.ey - line.y), color: line.color, stroke: line.stroke, clip: line.clip });
    }
    line = null;
  };
  const setColor = async (space: ColorSpace, ops: PdfObj[], fill: boolean) => {
    const last = ops[ops.length - 1];
    if (space.pattern && last instanceof PdfName) {
      const p = await patternPaint(ctx, await res('Pattern', last.v), gs);
      if (p) {
        if (fill) gs.fill = p;
        else gs.stroke = p;
        return;
      }
      ctx.warnings.add('Узоры (заливки повторами) — серым');
    }
    const comps = ops.filter((x): x is number => typeof x === 'number');
    const c = space.toRGB(comps.length ? comps : space.initial);
    if (fill) gs.fill = { kind: 'solid', color: c };
    else gs.stroke = { kind: 'solid', color: c };
  };
  const showText = (bytes: Uint8Array) => {
    const font = gs.font;
    if (!font) return;
    const glyphs = font.decode(bytes);
    const tfs = gs.fontSize;
    const th = gs.hScale;
    for (const g of glyphs) {
      const trm = mul(gs.ctm, mul(tm, [tfs * th, 0, 0, 0, tfs, gs.rise]));
      const [x, y] = apply(trm, 0, 0);
      const tx = ((g.width / 1000) * tfs + gs.charSpace + (g.space ? gs.wordSpace : 0)) * th;
      // Position after the glyph.
      const next = mul(tm, [1, 0, tx, 0, 1, 0]);
      const [ex, ey] = apply(mul(gs.ctm, mul(next, [tfs * th, 0, 0, 0, tfs, gs.rise])), 0, 0);
      tm = next;
      if (gs.render === 3 || gs.render === 7) continue;
      const size = Math.hypot(trm[1], trm[4]);
      const angle = Math.atan2(trm[3], trm[0]);
      const color = gs.render === 1 || gs.render === 5 ? (gs.stroke.kind === 'solid' ? gs.stroke.color : { r: 0, g: 0, b: 0, a: 1 }) : gs.fill.kind === 'solid' ? { ...gs.fill.color, a: gs.fill.color.a * gs.fillAlpha } : { r: 0, g: 0, b: 0, a: 1 };
      const stroke = gs.render === 1 || gs.render === 5;
      if (line) {
        // Same line: same font, size, color, direction; not far from the end of the previous one.
        const dx = x - line.ex;
        const dy = y - line.ey;
        const along = dx * Math.cos(line.angle) + dy * Math.sin(line.angle);
        const across = -dx * Math.sin(line.angle) + dy * Math.cos(line.angle);
        const same = line.font === font && Math.abs(line.size - size) < 0.01 * size && Math.abs(line.angle - angle) < 0.01 && line.clip === gs.clip && line.stroke === stroke && JSON.stringify(line.color) === JSON.stringify(color);
        if (same && Math.abs(across) < 0.2 * size && along > -0.5 * size && along < 3 * size) {
          if (along > 0.2 * size && !line.text.endsWith(' ') && !g.text.startsWith(' ')) line.text += ' ';
          line.text += g.text;
          line.ex = ex;
          line.ey = ey;
          continue;
        }
        flushText();
      }
      line = { text: g.text, x, y, ex, ey, angle, size, font, color, stroke, clip: gs.clip };
    }
  };

  for (;;) {
    const t = lx.next();
    if (t === undefined) break;
    if (!(t instanceof Keyword)) {
      const v = parseValue(lx, t);
      if (v !== undefined && !(v instanceof Keyword)) operands.push(v);
      continue;
    }
    const op = t.v;
    const ops = operands.splice(0);
    const num = (i: number) => (typeof ops[i] === 'number' ? (ops[i] as number) : 0);
    switch (op) {
      // State.
      case 'q':
        stack.push({ ...gs, dash: [...gs.dash] });
        break;
      case 'Q':
        if (stack.length) gs = stack.pop()!;
        break;
      case 'cm':
        gs.ctm = mul(gs.ctm, pdfM([num(0), num(1), num(2), num(3), num(4), num(5)]));
        break;
      case 'w':
        gs.lineWidth = num(0);
        break;
      case 'J':
        gs.cap = num(0);
        break;
      case 'j':
        gs.join = num(0);
        break;
      case 'M':
        gs.miter = num(0);
        break;
      case 'd':
        gs.dash = Array.isArray(ops[0]) ? (ops[0] as PdfObj[]).filter((x): x is number => typeof x === 'number') : [];
        gs.dashPhase = num(1);
        break;
      case 'gs': {
        const d = await file.dict(await res('ExtGState', (ops[0] as PdfName)?.v ?? ''));
        if (!d) break;
        for (const [k, v0] of d.map) {
          const v = await file.resolve(v0);
          if (k === 'ca' && typeof v === 'number') gs.fillAlpha = v;
          else if (k === 'CA' && typeof v === 'number') gs.strokeAlpha = v;
          else if (k === 'LW' && typeof v === 'number') gs.lineWidth = v;
          else if (k === 'LC' && typeof v === 'number') gs.cap = v;
          else if (k === 'LJ' && typeof v === 'number') gs.join = v;
          else if (k === 'ML' && typeof v === 'number') gs.miter = v;
          else if (k === 'BM') {
            const n = Array.isArray(v) ? v[0] : v;
            gs.blend = n instanceof PdfName ? BLEND[n.v] : undefined;
          } else if (k === 'SMask' && !(v instanceof PdfName && v.v === 'None')) ctx.warnings.add('Мягкие маски (SMask) не переносятся');
          else if (k === 'Font' && Array.isArray(v)) {
            const fd = await file.dict(v[0]);
            if (fd) gs.font = await fontOf(ctx, fd);
            gs.fontSize = typeof v[1] === 'number' ? v[1] : gs.fontSize;
          }
        }
        break;
      }
      // Paths.
      case 'm':
        cur = start = point(num(0), num(1));
        path.cmds.push(['M', cur[0], cur[1]]);
        break;
      case 'l':
        cur = point(num(0), num(1));
        path.cmds.push(['L', cur[0], cur[1]]);
        break;
      case 'c': {
        const a = point(num(0), num(1));
        const b = point(num(2), num(3));
        cur = point(num(4), num(5));
        path.cmds.push(['C', a[0], a[1], b[0], b[1], cur[0], cur[1]]);
        break;
      }
      case 'v': {
        const b = point(num(0), num(1));
        const from = cur;
        cur = point(num(2), num(3));
        path.cmds.push(['C', from[0], from[1], b[0], b[1], cur[0], cur[1]]);
        break;
      }
      case 'y': {
        const a = point(num(0), num(1));
        cur = point(num(2), num(3));
        path.cmds.push(['C', a[0], a[1], cur[0], cur[1], cur[0], cur[1]]);
        break;
      }
      case 'h':
        path.cmds.push(['Z']);
        cur = start;
        break;
      case 're': {
        const [x, y, w, h] = [num(0), num(1), num(2), num(3)];
        const a = point(x, y);
        path.cmds.push(['M', a[0], a[1]], ['L', ...point(x + w, y)], ['L', ...point(x + w, y + h)], ['L', ...point(x, y + h)], ['Z']);
        cur = start = a;
        break;
      }
      case 'S':
        paint(false, true, false);
        break;
      case 's':
        path.cmds.push(['Z']);
        paint(false, true, false);
        break;
      case 'f':
      case 'F':
        paint(true, false, false);
        break;
      case 'f*':
        paint(true, false, true);
        break;
      case 'B':
        paint(true, true, false);
        break;
      case 'B*':
        paint(true, true, true);
        break;
      case 'b':
        path.cmds.push(['Z']);
        paint(true, true, false);
        break;
      case 'b*':
        path.cmds.push(['Z']);
        paint(true, true, true);
        break;
      case 'n':
        endPath();
        break;
      case 'W':
        pendingClip = false;
        break;
      case 'W*':
        pendingClip = true;
        break;
      // Color.
      case 'g':
        gs.fillSpace = gray;
        gs.fill = { kind: 'solid', color: gray.toRGB([num(0)]) };
        break;
      case 'G':
        gs.strokeSpace = gray;
        gs.stroke = { kind: 'solid', color: gray.toRGB([num(0)]) };
        break;
      case 'rg':
        gs.fillSpace = rgb;
        gs.fill = { kind: 'solid', color: rgb.toRGB([num(0), num(1), num(2)]) };
        break;
      case 'RG':
        gs.strokeSpace = rgb;
        gs.stroke = { kind: 'solid', color: rgb.toRGB([num(0), num(1), num(2)]) };
        break;
      case 'k':
        gs.fillSpace = cmyk;
        gs.fill = { kind: 'solid', color: cmyk.toRGB([num(0), num(1), num(2), num(3)]) };
        break;
      case 'K':
        gs.strokeSpace = cmyk;
        gs.stroke = { kind: 'solid', color: cmyk.toRGB([num(0), num(1), num(2), num(3)]) };
        break;
      case 'cs':
        gs.fillSpace = await colorSpace(file, ops[0], resources);
        await setColor(gs.fillSpace, [], true);
        break;
      case 'CS':
        gs.strokeSpace = await colorSpace(file, ops[0], resources);
        await setColor(gs.strokeSpace, [], false);
        break;
      case 'sc':
      case 'scn':
        await setColor(gs.fillSpace, ops, true);
        break;
      case 'SC':
      case 'SCN':
        await setColor(gs.strokeSpace, ops, false);
        break;
      // Shading fill over the clip.
      case 'sh': {
        const sh = await res('Shading', (ops[0] as PdfName)?.v ?? '');
        const p = await shadingPaint(ctx, sh, gs.ctm);
        if (p) {
          const area = gs.clip?.path ?? rectPath(apply(ctx.base, -1e5, -1e5), apply(ctx.base, 1e5, 1e5));
          ctx.items.push({ kind: 'path', path: area, evenOdd: gs.clip?.evenOdd ?? false, fill: withAlpha(p, gs.fillAlpha), clip: gs.clip?.parent ?? null, blend: gs.blend });
        }
        break;
      }
      // External objects: images and forms.
      case 'Do': {
        const xo = await file.resolve(await res('XObject', (ops[0] as PdfName)?.v ?? ''));
        if (!(xo instanceof PdfStream)) break;
        const sub = (xo.dict.get('Subtype') as PdfName | undefined)?.v;
        if (sub === 'Image') {
          const isMask = (await file.resolve(xo.dict.get('ImageMask'))) === true;
          ctx.items.push({ kind: 'image', image: xo, m: gs.ctm, alpha: gs.fillAlpha, clip: gs.clip, stencil: isMask ? (gs.fill.kind === 'solid' ? gs.fill.color : { r: 0, g: 0, b: 0, a: 1 }) : undefined, blend: gs.blend });
        } else if (sub === 'Form' && ctx.depth < 12) {
          const matrix = ((await file.array(xo.dict.get('Matrix'))) ?? [1, 0, 0, 1, 0, 0]).map((x) => (typeof x === 'number' ? x : 0));
          const inner: GState = { ...gs, dash: [...gs.dash], ctm: mul(gs.ctm, pdfM(matrix)) };
          const bbox = ((await file.array(xo.dict.get('BBox'))) ?? []).map((x) => (typeof x === 'number' ? x : 0));
          if (bbox.length === 4) {
            const corners = [apply(inner.ctm, bbox[0]!, bbox[1]!), apply(inner.ctm, bbox[2]!, bbox[1]!), apply(inner.ctm, bbox[2]!, bbox[3]!), apply(inner.ctm, bbox[0]!, bbox[3]!)];
            const box: [number, number, number, number] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
            inner.clip = { path: { cmds: [['M', ...corners[0]!], ['L', ...corners[1]!], ['L', ...corners[2]!], ['L', ...corners[3]!], ['Z']], box }, evenOdd: false, parent: gs.clip };
          }
          const formRes = (await file.dict(xo.dict.get('Resources'))) ?? resources;
          ctx.depth++;
          flushText();
          await run(ctx, await file.decode(xo), formRes, inner);
          ctx.depth--;
        }
        break;
      }
      case 'BI': {
        // Inline image: dictionary up to ID, data up to EI.
        const d = new PdfDict();
        for (;;) {
          const k = lx.next();
          if (k === undefined || (k instanceof Keyword && k.v === 'ID')) break;
          if (k instanceof PdfName) {
            const v = parseValue(lx);
            if (v !== undefined && !(v instanceof Keyword)) d.map.set(INLINE_KEYS[k.v] ?? k.v, inlineValue(v));
          }
        }
        const p = lx.pos + 1;
        const b = lx.buf;
        // The end is “EI” between whitespace.
        let end = p;
        for (; end + 2 <= b.length; end++) {
          if (b[end] === 0x45 && b[end + 1] === 0x49 && (end === p || /\s/.test(String.fromCharCode(b[end - 1]!))) && (end + 2 === b.length || /\s/.test(String.fromCharCode(b[end + 2]!)))) break;
        }
        const raw = b.subarray(p, Math.max(p, end - 1));
        lx.pos = end + 2;
        const isMask = d.get('ImageMask') === true;
        ctx.items.push({ kind: 'image', image: new PdfStream(d, raw), m: gs.ctm, alpha: gs.fillAlpha, clip: gs.clip, stencil: isMask ? (gs.fill.kind === 'solid' ? gs.fill.color : { r: 0, g: 0, b: 0, a: 1 }) : undefined, blend: gs.blend });
        break;
      }
      // Text.
      case 'BT':
        tm = [1, 0, 0, 0, 1, 0];
        tlm = [1, 0, 0, 0, 1, 0];
        break;
      case 'ET':
        flushText();
        break;
      case 'Tf': {
        const fd = await file.dict(await res('Font', (ops[0] as PdfName)?.v ?? ''));
        gs.font = fd ? await fontOf(ctx, fd) : null;
        gs.fontSize = num(1);
        break;
      }
      case 'Tc':
        gs.charSpace = num(0);
        break;
      case 'Tw':
        gs.wordSpace = num(0);
        break;
      case 'Tz':
        gs.hScale = num(0) / 100;
        break;
      case 'TL':
        gs.leading = num(0);
        break;
      case 'Ts':
        gs.rise = num(0);
        break;
      case 'Tr':
        gs.render = num(0);
        break;
      case 'Td':
        tlm = mul(tlm, [1, 0, num(0), 0, 1, num(1)]);
        tm = tlm;
        break;
      case 'TD':
        gs.leading = -num(1);
        tlm = mul(tlm, [1, 0, num(0), 0, 1, num(1)]);
        tm = tlm;
        break;
      case 'Tm':
        tlm = tm = pdfM([num(0), num(1), num(2), num(3), num(4), num(5)]);
        break;
      case 'T*':
        tlm = mul(tlm, [1, 0, 0, 0, 1, -gs.leading]);
        tm = tlm;
        break;
      case 'Tj':
        if (ops[0] instanceof PdfString) showText(ops[0].bytes);
        break;
      case "'":
        tlm = mul(tlm, [1, 0, 0, 0, 1, -gs.leading]);
        tm = tlm;
        if (ops[0] instanceof PdfString) showText(ops[0].bytes);
        break;
      case '"':
        gs.wordSpace = num(0);
        gs.charSpace = num(1);
        tlm = mul(tlm, [1, 0, 0, 0, 1, -gs.leading]);
        tm = tlm;
        if (ops[2] instanceof PdfString) showText(ops[2].bytes);
        break;
      case 'TJ':
        for (const el of Array.isArray(ops[0]) ? (ops[0] as PdfObj[]) : []) {
          if (el instanceof PdfString) showText(el.bytes);
          else if (typeof el === 'number') tm = mul(tm, [1, 0, (-el / 1000) * gs.fontSize * gs.hScale, 0, 1, 0]);
        }
        break;
      default:
        break;
    }
  }
  flushText();
}

const INLINE_KEYS: Record<string, string> = { W: 'Width', H: 'Height', CS: 'ColorSpace', BPC: 'BitsPerComponent', F: 'Filter', DP: 'DecodeParms', IM: 'ImageMask', D: 'Decode', I: 'Interpolate' };
const INLINE_NAMES: Record<string, string> = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode' };
const inlineValue = (v: PdfObj): PdfObj => (v instanceof PdfName && INLINE_NAMES[v.v] ? new PdfName(INLINE_NAMES[v.v]!) : Array.isArray(v) ? v.map(inlineValue) : v);

async function fontOf(ctx: Ctx, d: PdfDict): Promise<PdfFont> {
  let f = ctx.fonts.get(d);
  if (!f) {
    f = await loadFont(ctx.file, d);
    ctx.fonts.set(d, f);
  }
  return f;
}

function rectPath(a: [number, number], b: [number, number]): PathData {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  return { cmds: [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']], box: [x0, y0, x1, y1] };
}

/** Shading gradient (types 2 and 3) in page coordinates; m — the matrix of its space. */
async function shadingPaint(ctx: Ctx, o: PdfObj | undefined, m: M): Promise<Paint | null> {
  const { file } = ctx;
  const d = await file.dict(o);
  if (!d) return null;
  const type = await file.num(d.get('ShadingType'), 0);
  if (type !== 2 && type !== 3) {
    ctx.warnings.add('Сетчатые градиенты (shading 4–7) — первым цветом');
  }
  const cs = await colorSpace(file, d.get('ColorSpace'), null);
  const fn = await makeFunction(file, d.get('Function'));
  const coords = ((await file.array(d.get('Coords'))) ?? []).map((x) => (typeof x === 'number' ? x : 0));
  const domain = ((await file.array(d.get('Domain'))) ?? [0, 1]).map((x) => (typeof x === 'number' ? x : 0));
  const t0 = domain[0] ?? 0;
  const t1 = domain[1] ?? 1;
  const N = 12;
  const stops: { pos: number; color: RGBA }[] = [];
  for (let i = 0; i <= N; i++) {
    const t = t0 + ((t1 - t0) * i) / N;
    stops.push({ pos: i / N, color: cs.toRGB(fn ? fn([t]) : cs.initial) });
  }
  if (type === 2 && coords.length >= 4) return { kind: 'linear', stops, p0: apply(m, coords[0]!, coords[1]!), p1: apply(m, coords[2]!, coords[3]!), alpha: 1 };
  if (type === 3 && coords.length >= 6) {
    const s = scaleOf(m);
    const c1 = apply(m, coords[3]!, coords[4]!);
    return { kind: 'radial', stops, p0: apply(m, coords[0]!, coords[1]!), p1: c1, r0: coords[2]! * s, r1: coords[5]! * s, alpha: 1 };
  }
  return stops[0] ? { kind: 'solid', color: stops[0].color } : null;
}

/** Pattern: shading (type 2) — a gradient in page space; tiling (type 1) — not supported. */
async function patternPaint(ctx: Ctx, o: PdfObj | undefined, _gs: GState): Promise<Paint | null> {
  const { file } = ctx;
  const p = await file.resolve(o);
  const d = p instanceof PdfStream ? p.dict : p instanceof PdfDict ? p : null;
  if (!d) return null;
  const type = await file.num(d.get('PatternType'), 0);
  if (type !== 2) return null;
  const matrix = ((await file.array(d.get('Matrix'))) ?? [1, 0, 0, 1, 0, 0]).map((x) => (typeof x === 'number' ? x : 0));
  return shadingPaint(ctx, d.get('Shading'), mul(ctx.base, pdfM(matrix)));
}
