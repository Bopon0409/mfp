// Code from a layer (developer mode): CSS, Tailwind, SwiftUI, UIKit, Jetpack Compose, Android XML. Values
// bound to variables are emitted as variable names (the variable's codeSyntax, if set). For the web —
// px or rem. CSS covers the layer's own styling; the others cover the layer with nested layers
// (nested), but no deeper than maxDepth and no more than maxNodes layers.

import type { Document } from '@mfp/core';
import { byte, hex, inspectNode, type ColorValue, type FillValue, type InspectOptions, type NodeStyle, type NumberValue, type ShadowValue, type TextValue } from './inspect.ts';

export type CodeLanguage = 'css' | 'tailwind' | 'swiftui' | 'uikit' | 'compose' | 'android-xml';

export const CODE_LANGUAGES: { id: CodeLanguage; label: string; ext: string; web: boolean }[] = [
  { id: 'css', label: 'CSS', ext: 'css', web: true },
  { id: 'tailwind', label: 'Tailwind', ext: 'html', web: true },
  { id: 'swiftui', label: 'SwiftUI', ext: 'swift', web: false },
  { id: 'uikit', label: 'UIKit', ext: 'swift', web: false },
  { id: 'compose', label: 'Compose', ext: 'kt', web: false },
  { id: 'android-xml', label: 'Android XML', ext: 'xml', web: false },
];

export interface CodegenOptions extends InspectOptions {
  language: CodeLanguage;
  /** Web: px or rem (from remBase, default 16). */
  unit?: 'px' | 'rem';
  remBase?: number;
  /** With nested layers (for CSS — child blocks). Default: CSS — no, others — yes. */
  nested?: boolean;
  maxDepth?: number;
  maxNodes?: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: number) => String(r2(v));
const pad = (s: string, n: number) => s.replace(/^(?=.)/gm, ' '.repeat(n));

interface Ctx {
  doc: Document;
  opts: CodegenOptions;
  count: number;
}

/** CSS properties of the layer itself [name, value] (like getCSSAsync for plugins). */
export function cssDeclarations(doc: Document, id: string, opts: InspectOptions = {}): [string, string][] {
  const ctx: Ctx = { doc, opts: { ...opts, language: 'css' }, count: 0 };
  return cssProps(ctx, inspectNode(doc, id, opts));
}

/** Layer code in the chosen language. */
export function generateCode(doc: Document, id: string, opts: CodegenOptions): string {
  const ctx: Ctx = { doc, opts, count: 0 };
  const nested = opts.nested ?? opts.language !== 'css';
  const tree = buildTree(ctx, id, 0, nested);
  switch (opts.language) {
    case 'css':
      return cssCode(ctx, tree);
    case 'tailwind':
      return tailwindCode(ctx, tree, 0);
    case 'swiftui':
      return swiftUI(ctx, tree);
    case 'uikit':
      return uikit(ctx, tree);
    case 'compose':
      return compose(ctx, tree, null);
    case 'android-xml':
      return `<?xml version="1.0" encoding="utf-8"?>\n${androidXml(ctx, tree, true, null)}`;
  }
}

interface Tree {
  s: NodeStyle;
  children: Tree[];
  /** Children were not shown (depth or layer count). */
  cut: number;
}

function buildTree(ctx: Ctx, id: string, depth: number, nested: boolean): Tree {
  ctx.count++;
  const s = inspectNode(ctx.doc, id, ctx.opts);
  const kids = ctx.doc.children(id).filter((c) => ctx.doc.get(c, 'visible') !== false && ctx.doc.type(c) !== 'SLICE');
  const deep = s.type === 'TEXT' || s.type === 'VECTOR' || s.type === 'BOOLEAN_OPERATION' ? [] : kids;
  if (!nested || !deep.length) return { s, children: [], cut: nested ? 0 : deep.length };
  const maxDepth = ctx.opts.maxDepth ?? 6;
  const maxNodes = ctx.opts.maxNodes ?? 200;
  if (depth >= maxDepth) return { s, children: [], cut: deep.length };
  const children: Tree[] = [];
  let cut = 0;
  // As in code: the first child goes first (in the model the bottom layer goes first).
  for (const c of ctx.doc.get(id, 'itemReverseZIndex') ? [...deep].reverse() : deep) {
    if (ctx.count >= maxNodes) {
      cut++;
      continue;
    }
    children.push(buildTree(ctx, c, depth + 1, true));
  }
  return { s, children, cut };
}

/** Simple layer kind for names: image, icon (vector), text, container. */
const isVectorish = (s: NodeStyle) => s.type === 'VECTOR' || s.type === 'BOOLEAN_OPERATION' || s.type === 'STAR' || s.type === 'POLYGON' || s.type === 'LINE';
const imageFill = (s: NodeStyle) => s.fills.find((f) => f.kind === 'image') as Extract<FillValue, { kind: 'image' }> | undefined;

// ---------- CSS ----------

function cssLen(ctx: Ctx, v: number): string {
  if (!v) return '0';
  if (ctx.opts.unit === 'rem') return `${Math.round((v / (ctx.opts.remBase ?? 16)) * 10000) / 10000}rem`;
  return `${r2(v)}px`;
}
const cssNum = (ctx: Ctx, v: NumberValue) => v.token?.web ?? cssLen(ctx, v.value);
function cssColor(c: ColorValue): string {
  if (c.token) return c.token.web;
  const a = r2(c.a);
  return a >= 1 ? hex(c) : `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${a})`;
}
function cssStops(stops: { position: number; color: ColorValue }[]) {
  return stops.map((s) => `${cssColor(s.color)} ${r2(s.position * 100)}%`).join(', ');
}
function cssFill(f: FillValue): string {
  switch (f.kind) {
    case 'solid':
      return cssColor(f.color);
    case 'linear':
      return `linear-gradient(${f.angle}deg, ${cssStops(f.stops)})`;
    case 'radial':
      return `radial-gradient(${r2(f.radius[0] * 100)}% ${r2(f.radius[1] * 100)}% at ${r2(f.center[0] * 100)}% ${r2(f.center[1] * 100)}%, ${cssStops(f.stops)})`;
    case 'angular':
      return `conic-gradient(from 90deg at ${r2(f.center[0] * 100)}% ${r2(f.center[1] * 100)}%, ${cssStops(f.stops)})`;
    case 'image':
      return `url(${slug(f.name)}.png) ${f.scaleMode === 'TILE' ? 'repeat' : 'center / ' + (f.scaleMode === 'FIT' ? 'contain' : 'cover') + ' no-repeat'}`;
  }
}
/** CSS shadow; text (text-shadow) has no spread and inset. */
const cssShadow = (ctx: Ctx, s: ShadowValue, text = false) =>
  text ? `${cssLen(ctx, s.x)} ${cssLen(ctx, s.y)} ${cssLen(ctx, s.blur)} ${cssColor(s.color)}` : `${s.inset ? 'inset ' : ''}${cssLen(ctx, s.x)} ${cssLen(ctx, s.y)} ${cssLen(ctx, s.blur)} ${cssLen(ctx, s.spread)} ${cssColor(s.color)}`;
const WEIGHT_CSS = (w: number) => String(Math.round(w / 100) * 100 || 400);

function cssText(ctx: Ctx, t: TextValue, base?: TextValue): [string, string][] {
  const out: [string, string][] = [];
  const add = (k: string, v: string, same?: boolean) => !same && out.push([k, v]);
  add('font-family', `"${t.family}"`, base && base.family === t.family);
  add('font-size', cssNum(ctx, t.size), base && base.size.value === t.size.value);
  add('font-style', t.italic ? 'italic' : 'normal', (base && base.italic === t.italic) || (!base && !t.italic));
  add('font-weight', WEIGHT_CSS(t.weight), base && base.weight === t.weight);
  // Line height as a percentage of font size — unitless, as is customary in CSS (the multiplier is inherited, not computed pixels).
  const lh = t.lineHeight ? (t.lineHeight.token?.web ?? (t.lineHeight.unit === 'PERCENT' ? `${r2(t.lineHeight.value / 100)}` : cssLen(ctx, t.lineHeight.value))) : 'normal';
  add('line-height', lh, base && JSON.stringify(base.lineHeight) === JSON.stringify(t.lineHeight));
  if (t.letterSpacing.value || t.letterSpacing.token) add('letter-spacing', cssNum(ctx, t.letterSpacing), base && base.letterSpacing.value === t.letterSpacing.value);
  if (!base && t.align !== 'left') add('text-align', t.align);
  const tc = { none: 'none', upper: 'uppercase', lower: 'lowercase', title: 'capitalize', 'small-caps': '' }[t.textCase];
  if (t.textCase === 'small-caps') add('font-variant', 'small-caps', base && base.textCase === t.textCase);
  else if (t.textCase !== 'none' || (base && base.textCase !== 'none')) add('text-transform', tc, base && base.textCase === t.textCase);
  if (t.decoration !== 'none' || (base && base.decoration !== 'none')) add('text-decoration', t.decoration, base && base.decoration === t.decoration);
  if (t.color) add('color', cssColor(t.color), !!base?.color && JSON.stringify(base.color) === JSON.stringify(t.color));
  else if (t.fills.length && t.fills[0]!.kind !== 'solid') {
    add('background', cssFill(t.fills[0]!));
    add('background-clip', 'text');
    add('-webkit-text-fill-color', 'transparent');
  }
  return out;
}

/** CSS properties of a single layer (“property — value” pairs). */
/** Percentage for output: to hundredths. */
const pctNum = (v: number | undefined) => Math.round((v ?? 100) * 100) / 100;

/** Tailwind class for a percentage: fractions (w-1/2, w-2/3…) or an arbitrary value (w-[37.5%]). */
function twPercent(p: string, v: number | undefined): string {
  const x = pctNum(v);
  if (x === 100) return `${p}-full`;
  for (const d of [2, 3, 4, 5, 6, 12]) {
    for (let n = 1; n < d; n++) if (Math.abs((n / d) * 100 - x) < 0.01) return `${p}-${n}/${d}`;
  }
  return `${p}-[${x}%]`;
}

function cssProps(ctx: Ctx, s: NodeStyle): [string, string][] {
  const out: [string, string][] = [];
  const add = (k: string, v: string | null | undefined) => v && out.push([k, v]);
  if (s.position !== 'flow') {
    add('position', 'absolute');
    add('left', cssLen(ctx, s.x));
    add('top', cssLen(ctx, s.y));
  }
  // Size: “hug” — no size; “fill” — flex / stretch.
  const fillMain = (axis: 'width' | 'height') => s.position === 'flow' && s.sizing[axis] === 'FILL' && ((axis === 'width') === (s.parentDirection === 'row'));
  const fillCross = (axis: 'width' | 'height') => s.position === 'flow' && s.sizing[axis] === 'FILL' && !fillMain(axis);
  for (const axis of ['width', 'height'] as const) {
    if (fillMain(axis)) add('flex', '1 0 0');
    else if (fillCross(axis)) add('align-self', 'stretch');
    else if (s.sizing[axis] === 'PERCENT') add(axis, `${pctNum(s.percent[axis])}%`);
    else if (s.sizing[axis] === 'FIXED') add(axis, cssNum(ctx, s[axis]));
  }
  const L = s.limits;
  const P = s.percent as Record<string, number | undefined>;
  for (const [k, css] of [['minWidth', 'min-width'], ['maxWidth', 'max-width'], ['minHeight', 'min-height'], ['maxHeight', 'max-height']] as const) {
    if (P[k] != null) add(css, `${pctNum(P[k])}%`);
    else if (L[k]) add(css, cssNum(ctx, L[k]));
  }
  // 3D as in CSS: perspective on the layer itself, rotation origin at the center (default transform-origin).
  const t3 = s.transform3d;
  const parts3d = t3 ? [`perspective(${t3.perspective}px)`, ...(t3.translateZ ? [`translateZ(${t3.translateZ}px)`] : []), ...(t3.rotateX ? [`rotateX(${t3.rotateX}deg)`] : []), ...(t3.rotateY ? [`rotateY(${t3.rotateY}deg)`] : [])] : [];
  if (s.rotation || parts3d.length) add('transform', [...(s.rotation ? [`rotate(${s.rotation}deg)`] : []), ...parts3d].join(' '));
  const lay = s.layout;
  if (lay) {
    if (lay.direction === 'grid') {
      add('display', 'grid');
      if (lay.columns.length) add('grid-template-columns', lay.columns.join(' '));
      if (lay.rows.length) add('grid-template-rows', lay.rows.join(' '));
      add('row-gap', cssNum(ctx, lay.crossGap ?? lay.gap));
      add('column-gap', cssNum(ctx, lay.gap));
    } else {
      add('display', 'flex');
      add('flex-direction', lay.direction);
      if (lay.wrap) add('flex-wrap', 'wrap');
      add('justify-content', { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly' }[lay.justify]);
      add('align-items', { start: 'flex-start', center: 'center', end: 'flex-end', baseline: 'baseline' }[lay.align]);
      if (!lay.justify.startsWith('space')) {
        if (lay.crossGap && lay.crossGap.value !== lay.gap.value) {
          add(lay.direction === 'row' ? 'column-gap' : 'row-gap', cssNum(ctx, lay.gap));
          add(lay.direction === 'row' ? 'row-gap' : 'column-gap', cssNum(ctx, lay.crossGap));
        } else if (lay.gap.value || lay.gap.token) add('gap', cssNum(ctx, lay.gap));
      }
    }
    const P = lay.padding;
    const vals = [P.top, P.right, P.bottom, P.left].map((v) => cssNum(ctx, v));
    if ([P.top, P.right, P.bottom, P.left].some((v) => v.value || v.token)) {
      add('padding', vals[0] === vals[2] && vals[1] === vals[3] ? (vals[0] === vals[1] ? vals[0] : `${vals[0]} ${vals[1]}`) : vals.join(' '));
    }
  }
  if (s.text) {
    for (const [k, v] of cssText(ctx, s.text)) add(k, v);
    if (s.text.truncate) {
      add('overflow', 'hidden');
      add('text-overflow', 'ellipsis');
      if (s.text.truncate === 1) add('white-space', 'nowrap');
      else {
        add('display', '-webkit-box');
        add('-webkit-box-orient', 'vertical');
        add('-webkit-line-clamp', String(s.text.truncate));
      }
    }
  } else if (s.fills.length) {
    const solidOnly = s.fills.length === 1 && s.fills[0]!.kind === 'solid';
    add('background', solidOnly ? cssFill(s.fills[0]!) : s.fills.map((f, i) => (f.kind === 'solid' && i < s.fills.length - 1 ? `linear-gradient(0deg, ${cssColor(f.color)} 0%, ${cssColor(f.color)} 100%)` : cssFill(f))).join(', '));
  }
  if (s.radius === 'ellipse') add('border-radius', '50%');
  else if (s.radius) {
    const v = [s.radius.tl, s.radius.tr, s.radius.br, s.radius.bl].map((x) => cssNum(ctx, x));
    add('border-radius', v.every((x) => x === v[0]) ? v[0] : v.join(' '));
  }
  if (s.stroke) {
    const st = s.stroke;
    const solid = st.fills.find((f) => f.kind === 'solid');
    const col = solid && solid.kind === 'solid' ? cssColor(solid.color) : st.fills[0] ? cssFill(st.fills[0]) : '#000';
    const style = st.dash.length ? 'dashed' : 'solid';
    if ('value' in st.weight) {
      const line = `${cssNum(ctx, st.weight)} ${style} ${col}`;
      if (st.align === 'outside') add('outline', line);
      else add('border', line);
      if (st.align === 'outside') add('outline-offset', '0');
    } else {
      const W = st.weight;
      for (const [side, w] of [['top', W.top], ['right', W.right], ['bottom', W.bottom], ['left', W.left]] as const) if (w) add(`border-${side}`, `${cssLen(ctx, w)} ${style} ${col}`);
    }
    if (st.align !== 'outside' && s.type !== 'TEXT') add('box-sizing', 'border-box');
  }
  const textShadow = s.type === 'TEXT';
  const shadows = textShadow ? s.shadows.filter((x) => !x.inset) : s.shadows;
  if (shadows.length) add(textShadow ? 'text-shadow' : 'box-shadow', shadows.map((x) => cssShadow(ctx, x, textShadow)).join(', '));
  if (s.blur) add('filter', `blur(${cssLen(ctx, s.blur / 2)})`);
  if (s.backdropBlur) add('backdrop-filter', `blur(${cssLen(ctx, s.backdropBlur / 2)})`);
  if (s.opacity.value < 1 || s.opacity.token) add('opacity', s.opacity.token?.web ?? num(s.opacity.value));
  if (s.blend) add('mix-blend-mode', s.blend);
  if (s.clip) add('overflow', 'hidden');
  return out;
}

function cssCode(ctx: Ctx, tree: Tree): string {
  const blocks: string[] = [];
  const walk = (t: Tree, depth: number) => {
    const props = cssProps(ctx, t.s);
    const head = depth ? `.${slug(t.s.name) || 'layer'} {` : '';
    const body = props.map(([k, v]) => `${k}: ${v};`).join('\n');
    let block = depth ? `${head}\n${pad(body, 2)}\n}` : `/* ${t.s.name} */\n${body}`;
    // Text runs with their own formatting become separate blocks.
    if (t.s.text?.segments.length) {
      const base = t.s.text;
      for (const seg of base.segments) {
        const diff = cssText(ctx, seg.style, base);
        if (!diff.length) continue;
        const excerpt = seg.characters.replace(/\s+/g, ' ').trim().slice(0, 40);
        block += `\n\n/* «${excerpt}${seg.characters.length > 40 ? '…' : ''}» */\n${diff.map(([k, v]) => `${k}: ${v};`).join('\n')}`;
      }
    }
    blocks.push(block);
    for (const c of t.children) walk(c, depth + 1);
  };
  walk(tree, 0);
  return blocks.join('\n\n');
}

// ---------- Tailwind ----------

const TW_SPACING = new Set([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96]);
/** Tailwind value: scale (4 px = 1), px or arbitrary [..]. */
function tw(ctx: Ctx, prefix: string, v: NumberValue, allowScale = true): string {
  if (v.token) return `${prefix}-[${v.token.web}]`;
  const x = r2(v.value);
  if (allowScale && x === 1) return `${prefix}-px`;
  if (allowScale && TW_SPACING.has(x / 4)) return `${prefix}-${x / 4}`;
  return `${prefix}-[${ctx.opts.unit === 'rem' ? cssLen(ctx, x) : `${x}px`}]`;
}
const twArb = (s: string) => s.replace(/\s+/g, '_');
const twColor = (prefix: string, c: ColorValue) => `${prefix}-[${twArb(cssColor(c))}]`;
const TW_WEIGHT: Record<number, string> = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };
const TW_RADIUS: Record<number, string> = { 2: 'rounded-sm', 4: 'rounded', 6: 'rounded-md', 8: 'rounded-lg', 12: 'rounded-xl', 16: 'rounded-2xl', 24: 'rounded-3xl' };

function twText(ctx: Ctx, t: TextValue, base?: TextValue): string[] {
  const c: string[] = [];
  if (!base || base.family !== t.family) c.push(`font-['${t.family.replace(/\s+/g, '_')}']`);
  if (!base || base.size.value !== t.size.value) c.push(t.size.token ? `text-[length:${t.size.token.web}]` : `text-[${ctx.opts.unit === 'rem' ? cssLen(ctx, t.size.value) : `${r2(t.size.value)}px`}]`);
  if (!base || base.weight !== t.weight) c.push(`font-${TW_WEIGHT[Math.round(t.weight / 100) * 100] ?? 'normal'}`);
  if (t.italic && (!base || !base.italic)) c.push('italic');
  if (t.lineHeight && (!base || JSON.stringify(base.lineHeight) !== JSON.stringify(t.lineHeight)))
    c.push(`leading-[${t.lineHeight.token?.web ?? (t.lineHeight.unit === 'PERCENT' ? `${r2(t.lineHeight.value / 100)}` : cssLen(ctx, t.lineHeight.value))}]`);
  if ((t.letterSpacing.value || t.letterSpacing.token) && (!base || base.letterSpacing.value !== t.letterSpacing.value)) c.push(`tracking-[${cssNum(ctx, t.letterSpacing)}]`);
  if (!base && t.align !== 'left') c.push(`text-${t.align}`);
  if (t.textCase !== 'none' && (!base || base.textCase !== t.textCase)) c.push({ upper: 'uppercase', lower: 'lowercase', title: 'capitalize', 'small-caps': '[font-variant:small-caps]' }[t.textCase]);
  if (t.decoration !== 'none' && (!base || base.decoration !== t.decoration)) c.push(t.decoration === 'underline' ? 'underline' : 'line-through');
  if (t.color && (!base || JSON.stringify(base.color) !== JSON.stringify(t.color))) c.push(twColor('text', t.color));
  return c;
}

function twClasses(ctx: Ctx, s: NodeStyle): string[] {
  const c: string[] = [];
  if (s.position !== 'flow') c.push('absolute', tw(ctx, 'left', { value: s.x }), tw(ctx, 'top', { value: s.y }));
  const fill = (axis: 'width' | 'height') => s.position === 'flow' && s.sizing[axis] === 'FILL';
  const main = (axis: 'width' | 'height') => (axis === 'width') === (s.parentDirection === 'row');
  for (const axis of ['width', 'height'] as const) {
    const p = axis === 'width' ? 'w' : 'h';
    if (fill(axis)) c.push(main(axis) ? 'flex-1' : 'self-stretch');
    else if (s.sizing[axis] === 'PERCENT') c.push(twPercent(p, s.percent[axis]));
    else if (s.sizing[axis] === 'FIXED') c.push(tw(ctx, p, s[axis]));
  }
  if (s.limits.minWidth) c.push(tw(ctx, 'min-w', s.limits.minWidth, false));
  if (s.limits.maxWidth) c.push(tw(ctx, 'max-w', s.limits.maxWidth, false));
  if (s.limits.minHeight) c.push(tw(ctx, 'min-h', s.limits.minHeight, false));
  if (s.limits.maxHeight) c.push(tw(ctx, 'max-h', s.limits.maxHeight, false));
  if (s.rotation) c.push(`rotate-[${s.rotation}deg]`);
  const lay = s.layout;
  if (lay) {
    if (lay.direction === 'grid') {
      c.push('grid');
      if (lay.columns.length) c.push(`grid-cols-[${lay.columns.join('_')}]`);
      if (lay.rows.length) c.push(`grid-rows-[${lay.rows.join('_')}]`);
      c.push(tw(ctx, 'gap-x', lay.gap), tw(ctx, 'gap-y', lay.crossGap ?? lay.gap));
    } else {
      c.push('flex');
      if (lay.direction === 'column') c.push('flex-col');
      if (lay.wrap) c.push('flex-wrap');
      const J = { start: 'justify-start', center: 'justify-center', end: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly' }[lay.justify];
      if (lay.justify !== 'start') c.push(J);
      c.push({ start: 'items-start', center: 'items-center', end: 'items-end', baseline: 'items-baseline' }[lay.align]);
      if (!lay.justify.startsWith('space') && (lay.gap.value || lay.gap.token)) {
        if (lay.crossGap && lay.crossGap.value !== lay.gap.value) c.push(tw(ctx, lay.direction === 'row' ? 'gap-x' : 'gap-y', lay.gap), tw(ctx, lay.direction === 'row' ? 'gap-y' : 'gap-x', lay.crossGap));
        else c.push(tw(ctx, 'gap', lay.gap));
      }
    }
    const P = lay.padding;
    const same = (a: NumberValue, b: NumberValue) => a.value === b.value && a.token?.id === b.token?.id;
    if (same(P.top, P.bottom) && same(P.left, P.right) && same(P.top, P.left)) {
      if (P.top.value || P.top.token) c.push(tw(ctx, 'p', P.top));
    } else if (same(P.top, P.bottom) && same(P.left, P.right)) {
      if (P.left.value || P.left.token) c.push(tw(ctx, 'px', P.left));
      if (P.top.value || P.top.token) c.push(tw(ctx, 'py', P.top));
    } else {
      for (const [k, v] of [['pt', P.top], ['pr', P.right], ['pb', P.bottom], ['pl', P.left]] as const) if (v.value || v.token) c.push(tw(ctx, k, v));
    }
  }
  if (s.text) {
    c.push(...twText(ctx, s.text));
    if (s.text.truncate === 1) c.push('truncate');
    else if (s.text.truncate) c.push(`line-clamp-${s.text.truncate}`);
  } else if (s.fills.length === 1 && s.fills[0]!.kind === 'solid') c.push(twColor('bg', s.fills[0]!.color));
  else if (s.fills.length) c.push(`bg-[${twArb(s.fills.map((f) => (f.kind === 'solid' ? `linear-gradient(0deg,${cssColor(f.color)},${cssColor(f.color)})` : cssFill(f))).join(','))}]`);
  if (s.radius === 'ellipse') c.push('rounded-full');
  else if (s.radius) {
    const R = s.radius;
    if ([R.tr, R.br, R.bl].every((x) => x.value === R.tl.value && x.token?.id === R.tl.token?.id)) c.push(R.tl.token ? `rounded-[${R.tl.token.web}]` : (TW_RADIUS[r2(R.tl.value)] ?? `rounded-[${cssLen(ctx, R.tl.value)}]`));
    else for (const [k, v] of [['rounded-tl', R.tl], ['rounded-tr', R.tr], ['rounded-br', R.br], ['rounded-bl', R.bl]] as const) if (v.value || v.token) c.push(`${k}-[${cssNum(ctx, v)}]`);
  }
  if (s.stroke) {
    const st = s.stroke;
    const solid = st.fills.find((f) => f.kind === 'solid');
    const pre = st.align === 'outside' ? 'outline' : 'border';
    if ('value' in st.weight) c.push(st.weight.token ? `${pre}-[length:${st.weight.token.web}]` : r2(st.weight.value) === 1 && pre === 'border' ? 'border' : `${pre}-[${cssLen(ctx, st.weight.value)}]`);
    else for (const [k, w] of [['border-t', st.weight.top], ['border-r', st.weight.right], ['border-b', st.weight.bottom], ['border-l', st.weight.left]] as const) if (w) c.push(`${k}-[${cssLen(ctx, w)}]`);
    if (st.dash.length) c.push(`${pre}-dashed`);
    else if (pre === 'outline') c.push('outline');
    if (solid && solid.kind === 'solid') c.push(twColor(pre, solid.color));
  }
  if (s.shadows.length) c.push(s.type === 'TEXT' ? `[text-shadow:${twArb(s.shadows.filter((x) => !x.inset).map((x) => cssShadow(ctx, x, true)).join(','))}]` : `shadow-[${twArb(s.shadows.map((x) => cssShadow(ctx, x)).join(','))}]`);
  if (s.blur) c.push(`blur-[${cssLen(ctx, s.blur / 2)}]`);
  if (s.backdropBlur) c.push(`backdrop-blur-[${cssLen(ctx, s.backdropBlur / 2)}]`);
  if (s.opacity.token) c.push(`opacity-[${s.opacity.token.web}]`);
  else if (s.opacity.value < 1) c.push(Math.round(s.opacity.value * 100) % 5 === 0 ? `opacity-${Math.round(s.opacity.value * 100)}` : `opacity-[${num(s.opacity.value)}]`);
  if (s.blend) c.push(`mix-blend-${s.blend}`);
  if (s.clip) c.push('overflow-hidden');
  return c;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tailwindCode(ctx: Ctx, t: Tree, depth: number): string {
  const s = t.s;
  const classes = twClasses(ctx, s);
  // Children in a free-form frame need a reference point.
  if (!s.layout && t.children.some((c) => c.s.position !== 'flow') && !classes.includes('absolute')) classes.push('relative');
  const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
  const img = imageFill(s);
  if (s.text) {
    const tag = s.text.link ? 'a' : 'p';
    const href = s.text.link ? ` href="${escHtml(s.text.link)}"` : '';
    let inner = escHtml(s.text.characters).replace(/\n/g, '<br />');
    if (s.text.segments.length) {
      inner = s.text.segments
        .map((seg) => {
          const diff = twText(ctx, seg.style, s.text!);
          const txt = escHtml(seg.characters).replace(/\n/g, '<br />');
          return diff.length ? `<span class="${diff.join(' ')}">${txt}</span>` : txt;
        })
        .join('');
    }
    return `<${tag}${href}${cls}>${inner}</${tag}>`;
  }
  if (img && !t.children.length) return `<img${cls} src="${slug(img.name)}.png" alt="${escHtml(s.name)}" />`;
  if (isVectorish(s)) return `<img${cls} src="${slug(s.name) || 'icon'}.svg" alt="${escHtml(s.name)}" />`;
  const kids = t.children.map((c) => tailwindCode(ctx, c, depth + 1));
  if (t.cut) kids.push(`<!-- ещё слоёв: ${t.cut} -->`);
  const comment = s.component ? `<!-- ${escHtml(s.component)} -->\n` : '';
  if (!kids.length) return `${comment}<div${cls}></div>`;
  return `${comment}<div${cls}>\n${pad(kids.join('\n'), 2)}\n</div>`;
}

// ---------- Shared for iOS and Android ----------

/** Code name from the layer name: Latin letters and digits, camelCase. */
export function identifier(name: string, fallback = 'view'): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const id = parts.map((p, i) => (i ? p[0]!.toUpperCase() + p.slice(1) : p[0]!.toLowerCase() + p.slice(1))).join('');
  return id && /^\p{L}/u.test(id) ? id : fallback;
}
/** Asset file name: lowercase, hyphen-separated. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join('-');
}
const strLit = (s: string) => JSON.stringify(s);

// ---------- SwiftUI ----------

function swiftColor(c: ColorValue): string {
  if (c.token) return /^[A-Za-z_][\w.]*$/.test(c.token.ios) && !c.token.ios.includes('(') ? `Color.${c.token.ios.replace(/^Color\./, '')}` : c.token.ios;
  const base = `Color(red: ${num(c.r)}, green: ${num(c.g)}, blue: ${num(c.b)})`;
  return c.a < 1 ? `${base}.opacity(${num(c.a)})` : base;
}
const swiftNum = (v: NumberValue) => v.token?.ios ?? num(v.value);
const SWIFT_WEIGHT: Record<number, string> = { 100: '.ultraLight', 200: '.thin', 300: '.light', 400: '.regular', 500: '.medium', 600: '.semibold', 700: '.bold', 800: '.heavy', 900: '.black' };
function swiftGradient(f: FillValue): string | null {
  if (f.kind === 'solid') return swiftColor(f.color);
  if (f.kind === 'image') return null;
  const stops = `Gradient(stops: [${f.stops.map((s) => `.init(color: ${swiftColor(s.color)}, location: ${num(s.position)})`).join(', ')}])`;
  if (f.kind === 'linear') return `LinearGradient(gradient: ${stops}, startPoint: UnitPoint(x: ${num(f.start[0])}, y: ${num(f.start[1])}), endPoint: UnitPoint(x: ${num(f.end[0])}, y: ${num(f.end[1])}))`;
  if (f.kind === 'radial') return `EllipticalGradient(gradient: ${stops}, center: UnitPoint(x: ${num(f.center[0])}, y: ${num(f.center[1])}))`;
  return `AngularGradient(gradient: ${stops}, center: UnitPoint(x: ${num(f.center[0])}, y: ${num(f.center[1])}))`;
}

/** SwiftUI modifiers for the layer's styling (size, background, corner radius, stroke, shadows…). */
function swiftModifiers(s: NodeStyle, parent: Tree | null): string[] {
  const m: string[] = [];
  const lay = s.layout;
  if (lay) {
    const P = lay.padding;
    const v = [P.top, P.left, P.bottom, P.right].map(swiftNum);
    if (v.every((x) => x === '0')) {
      // no padding
    } else if (v.every((x) => x === v[0])) m.push(`.padding(${v[0]})`);
    else if (v[0] === v[2] && v[1] === v[3]) {
      if (v[1] !== '0') m.push(`.padding(.horizontal, ${v[1]})`);
      if (v[0] !== '0') m.push(`.padding(.vertical, ${v[0]})`);
    } else m.push(`.padding(EdgeInsets(top: ${v[0]}, leading: ${v[1]}, bottom: ${v[2]}, trailing: ${v[3]}))`);
  }
  // Size.
  const fw = s.position === 'flow' && s.sizing.width === 'FILL';
  const fh = s.position === 'flow' && s.sizing.height === 'FILL';
  const parts: string[] = [];
  if (fw) parts.push('maxWidth: .infinity');
  else if (s.sizing.width === 'FIXED') parts.push(`width: ${swiftNum(s.width)}`);
  if (fh) parts.push('maxHeight: .infinity');
  else if (s.sizing.height === 'FIXED') parts.push(`height: ${swiftNum(s.height)}`);
  if (parts.length) {
    const fixed = parts.filter((p) => !p.startsWith('max'));
    const max = parts.filter((p) => p.startsWith('max'));
    if (fixed.length) m.push(`.frame(${fixed.join(', ')})`);
    if (max.length) m.push(`.frame(${max.join(', ')}${s.text ? `, alignment: .${s.text.align === 'center' ? 'center' : s.text.align === 'right' ? 'trailing' : 'leading'}` : ''})`);
  }
  // Parent percentage — a fraction of the container size (iOS 17+).
  for (const axis of ['width', 'height'] as const) {
    if (s.sizing[axis] !== 'PERCENT') continue;
    m.push(`.containerRelativeFrame(.${axis === 'width' ? 'horizontal' : 'vertical'}) { length, _ in length * ${num(pctNum(s.percent[axis]) / 100)} }`);
  }
  // Background (for shapes — the shape fill, for containers — the background).
  const shape = s.type === 'RECTANGLE' || s.type === 'ELLIPSE';
  if (!s.text && !shape) {
    for (const f of [...s.fills].reverse()) {
      const g = swiftGradient(f);
      if (g) m.push(`.background(${g})`);
      else if (f.kind === 'image') m.push(`.background(Image(${strLit(slug(f.name))}).resizable().aspectRatio(contentMode: .${f.scaleMode === 'FIT' ? 'fit' : 'fill'}))`);
    }
  }
  const radius = s.radius && s.radius !== 'ellipse' ? s.radius : null;
  const uniform = radius && [radius.tr, radius.br, radius.bl].every((x) => x.value === radius.tl.value);
  const shapeExpr = s.radius === 'ellipse' ? 'Ellipse()' : radius ? (uniform ? `RoundedRectangle(cornerRadius: ${swiftNum(radius.tl)})` : `UnevenRoundedRectangle(topLeadingRadius: ${swiftNum(radius.tl)}, bottomLeadingRadius: ${swiftNum(radius.bl)}, bottomTrailingRadius: ${swiftNum(radius.br)}, topTrailingRadius: ${swiftNum(radius.tr)})`) : 'Rectangle()';
  if (!shape && (radius || s.clip)) m.push(`.clipShape(${shapeExpr})`);
  if (s.stroke) {
    const solid = s.stroke.fills.find((f) => f.kind === 'solid');
    const col = solid && solid.kind === 'solid' ? swiftColor(solid.color) : '.black';
    const w = 'value' in s.stroke.weight ? swiftNum(s.stroke.weight) : num(Math.max(s.stroke.weight.top, s.stroke.weight.right, s.stroke.weight.bottom, s.stroke.weight.left));
    const style = s.stroke.dash.length ? `StrokeStyle(lineWidth: ${w}, dash: [${s.stroke.dash.map(num).join(', ')}])` : null;
    const stroke = s.stroke.align === 'inside' ? (style ? `.strokeBorder(${col}, style: ${style})` : `.strokeBorder(${col}, lineWidth: ${w})`) : style ? `.stroke(${col}, style: ${style})` : `.stroke(${col}, lineWidth: ${w})`;
    m.push(`.overlay(${shapeExpr}${stroke})`);
  }
  for (const sh of s.shadows.filter((x) => !x.inset)) m.push(`.shadow(color: ${swiftColor(sh.color)}, radius: ${num(sh.blur / 2)}, x: ${num(sh.x)}, y: ${num(sh.y)})`);
  if (s.blur) m.push(`.blur(radius: ${num(s.blur / 2)})`);
  if (s.opacity.value < 1 || s.opacity.token) m.push(`.opacity(${swiftNum(s.opacity)})`);
  if (s.rotation) m.push(`.rotationEffect(.degrees(${num(s.rotation)}))`);
  if (s.blend) m.push(`.blendMode(.${identifier(s.blend)})`);
  // Free position in a ZStack parent.
  if (parent && !parent.s.layout && s.position === 'free') m.push(`.offset(x: ${num(s.x)}, y: ${num(s.y)})`);
  else if (s.position === 'absolute') m.push(`.offset(x: ${num(s.x)}, y: ${num(s.y)})`);
  return m;
}

function swiftTextMods(t: TextValue): string[] {
  const m: string[] = [];
  const w = SWIFT_WEIGHT[Math.round(t.weight / 100) * 100] ?? '.regular';
  m.push(`.font(.custom(${strLit(t.family)}, size: ${swiftNum(t.size)})${w !== '.regular' ? `.weight(${w})` : ''})`);
  if (t.italic) m.push('.italic()');
  if (t.color) m.push(`.foregroundColor(${swiftColor(t.color)})`);
  if (t.lineHeight) {
    const lh = t.lineHeight.unit === 'PERCENT' ? (t.lineHeight.value / 100) * t.size.value : t.lineHeight.value;
    const extra = lh - t.size.value * 1.2;
    if (Math.abs(extra) > 0.5) m.push(`.lineSpacing(${num(extra)})`);
  }
  if (t.letterSpacing.value) m.push(`.kerning(${swiftNum(t.letterSpacing)})`);
  if (t.align !== 'left') m.push(`.multilineTextAlignment(.${t.align === 'center' ? 'center' : t.align === 'right' ? 'trailing' : 'leading'})`);
  if (t.textCase === 'upper') m.push('.textCase(.uppercase)');
  else if (t.textCase === 'lower') m.push('.textCase(.lowercase)');
  if (t.decoration === 'underline') m.push('.underline()');
  else if (t.decoration === 'line-through') m.push('.strikethrough()');
  if (t.truncate) m.push(`.lineLimit(${t.truncate})`);
  return m;
}

function swiftView(ctx: Ctx, t: Tree, parent: Tree | null): string {
  const s = t.s;
  const mods = swiftModifiers(s, parent);
  let head: string;
  if (s.text) {
    head = `Text(${strLit(s.text.characters)})`;
    mods.unshift(...swiftTextMods(s.text));
  } else if (s.type === 'RECTANGLE' || s.type === 'ELLIPSE') {
    const radius = s.radius && s.radius !== 'ellipse' ? s.radius : null;
    const shape = s.type === 'ELLIPSE' ? 'Ellipse()' : radius ? `RoundedRectangle(cornerRadius: ${swiftNum(radius.tl)})` : 'Rectangle()';
    const img = imageFill(s);
    const fill = s.fills.length ? swiftGradient(s.fills[0]!) : null;
    if (img) {
      head = `Image(${strLit(slug(img.name))})`;
      mods.unshift('.resizable()', `.aspectRatio(contentMode: .${img.scaleMode === 'FIT' ? 'fit' : 'fill'})`);
      if (s.type === 'ELLIPSE' || radius) mods.push(`.clipShape(${shape})`);
    } else head = fill ? `${shape}\n    .fill(${fill})` : shape;
  } else if (isVectorish(s)) {
    head = `Image(${strLit(slug(s.name) || 'icon')})`;
  } else {
    const lay = s.layout;
    const kids = t.children.map((c) => swiftView(ctx, c, t));
    if (t.cut) kids.push(`// ещё слоёв: ${t.cut}`);
    const body = kids.length ? `{\n${pad(kids.join('\n'), 4)}\n}` : '{}';
    if (lay && lay.direction !== 'grid') {
      const H = lay.direction === 'row';
      const al = H ? { start: '.top', center: '.center', end: '.bottom', baseline: '.firstTextBaseline' }[lay.align] : { start: '.leading', center: '.center', end: '.trailing', baseline: '.leading' }[lay.align];
      const spacing = lay.justify.startsWith('space') ? '0' : swiftNum(lay.gap);
      head = `${H ? 'HStack' : 'VStack'}(alignment: ${al}, spacing: ${spacing}) ${body}`;
    } else if (lay) {
      const cols = Math.max(1, lay.columns.length);
      head = `LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: ${swiftNum(lay.gap)}), count: ${cols}), spacing: ${swiftNum(lay.crossGap ?? lay.gap)}) ${body}`;
    } else head = `ZStack(alignment: .topLeading) ${body}`;
  }
  const comment = s.component ? `// ${s.component}\n` : '';
  // After the container body, modifiers have no indentation (the SwiftUI convention).
  return `${comment}${head}${mods.length ? '\n' + pad(mods.join('\n'), head.endsWith('}') ? 0 : 4) : ''}`;
}

function swiftUI(ctx: Ctx, t: Tree): string {
  const name = identifier(t.s.name, 'Layer');
  const type = name[0]!.toUpperCase() + name.slice(1);
  return `struct ${type}View: View {\n    var body: some View {\n${pad(swiftView(ctx, t, null), 8)}\n    }\n}`;
}

// ---------- UIKit ----------

function uiColor(c: ColorValue): string {
  if (c.token) return c.token.ios.startsWith('UIColor') || c.token.ios.includes('(') ? c.token.ios : `UIColor(named: ${strLit(c.token.ios)})!`;
  return `UIColor(red: ${num(c.r)}, green: ${num(c.g)}, blue: ${num(c.b)}, alpha: ${num(c.a)})`;
}

function uikitView(ctx: Ctx, t: Tree, names: Set<string>, parentVar: string | null, parentStack: boolean): string[] {
  const s = t.s;
  let v = identifier(s.name, s.text ? 'label' : 'view');
  for (let i = 2; names.has(v); i++) v = `${identifier(s.name, 'view')}${i}`;
  names.add(v);
  const L: string[] = [];
  const lay = s.layout && s.layout.direction !== 'grid' ? s.layout : null;
  const cls = s.text ? 'UILabel' : lay ? 'UIStackView' : isVectorish(s) || imageFill(s) ? 'UIImageView' : 'UIView';
  if (s.component) L.push(`// ${s.component}`);
  L.push(`let ${v} = ${cls}()`);
  if (cls === 'UIImageView') L.push(`${v}.image = UIImage(named: ${strLit(slug(imageFill(s)?.name ?? s.name) || 'icon')})`, `${v}.contentMode = .${imageFill(s)?.scaleMode === 'FIT' ? 'scaleAspectFit' : 'scaleAspectFill'}`);
  if (!parentVar || s.position !== 'flow') L.push(`${v}.frame = CGRect(x: ${num(s.x)}, y: ${num(s.y)}, width: ${num(s.width.value)}, height: ${num(s.height.value)})`);
  else L.push(`${v}.translatesAutoresizingMaskIntoConstraints = false`);
  if (s.text) {
    const t = s.text;
    L.push(`${v}.text = ${strLit(t.characters)}`);
    const face = `${t.family.replace(/\s+/g, '')}-${t.style.replace(/\s+/g, '')}`;
    L.push(`${v}.font = UIFont(name: ${strLit(face)}, size: ${num(t.size.value)})`);
    if (t.color) L.push(`${v}.textColor = ${uiColor(t.color)}`);
    if (t.align !== 'left') L.push(`${v}.textAlignment = .${t.align === 'justify' ? 'justified' : t.align}`);
    L.push(`${v}.numberOfLines = ${t.truncate ?? 0}`);
    if (t.truncate) L.push(`${v}.lineBreakMode = .byTruncatingTail`);
  }
  if (lay) {
    L.push(`${v}.axis = .${lay.direction === 'row' ? 'horizontal' : 'vertical'}`);
    L.push(`${v}.spacing = ${lay.justify.startsWith('space') ? 0 : num(lay.gap.value)}`);
    L.push(`${v}.alignment = .${{ start: lay.direction === 'row' ? 'top' : 'leading', center: 'center', end: lay.direction === 'row' ? 'bottom' : 'trailing', baseline: 'firstBaseline' }[lay.align]}`);
    L.push(`${v}.distribution = .${lay.justify === 'space-between' ? 'equalSpacing' : lay.justify === 'space-evenly' || lay.justify === 'space-around' ? 'equalCentering' : 'fill'}`);
    const P = lay.padding;
    if ([P.top, P.right, P.bottom, P.left].some((x) => x.value)) {
      L.push(`${v}.isLayoutMarginsRelativeArrangement = true`);
      L.push(`${v}.directionalLayoutMargins = NSDirectionalEdgeInsets(top: ${num(P.top.value)}, leading: ${num(P.left.value)}, bottom: ${num(P.bottom.value)}, trailing: ${num(P.right.value)})`);
    }
  }
  const solid = !s.text ? s.fills.find((f) => f.kind === 'solid') : undefined;
  if (solid && solid.kind === 'solid') L.push(`${v}.backgroundColor = ${uiColor(solid.color)}`);
  const grad = !s.text ? s.fills.find((f) => f.kind === 'linear') : undefined;
  if (grad && grad.kind === 'linear') {
    L.push(`let ${v}Gradient = CAGradientLayer()`);
    L.push(`${v}Gradient.frame = ${v}.bounds`);
    L.push(`${v}Gradient.colors = [${grad.stops.map((st) => `${uiColor(st.color)}.cgColor`).join(', ')}]`);
    L.push(`${v}Gradient.locations = [${grad.stops.map((st) => num(st.position)).join(', ')}]`);
    L.push(`${v}Gradient.startPoint = CGPoint(x: ${num(grad.start[0])}, y: ${num(grad.start[1])})`);
    L.push(`${v}Gradient.endPoint = CGPoint(x: ${num(grad.end[0])}, y: ${num(grad.end[1])})`);
    L.push(`${v}.layer.insertSublayer(${v}Gradient, at: 0)`);
  }
  if (s.radius === 'ellipse') L.push(`${v}.layer.cornerRadius = ${num(Math.min(s.width.value, s.height.value) / 2)}`);
  else if (s.radius) L.push(`${v}.layer.cornerRadius = ${num(s.radius.tl.value)}`);
  if (s.stroke) {
    const st = s.stroke.fills.find((f) => f.kind === 'solid');
    L.push(`${v}.layer.borderWidth = ${num('value' in s.stroke.weight ? s.stroke.weight.value : s.stroke.weight.top)}`);
    if (st && st.kind === 'solid') L.push(`${v}.layer.borderColor = ${uiColor(st.color)}.cgColor`);
  }
  const sh = s.shadows.find((x) => !x.inset);
  if (sh) {
    L.push(`${v}.layer.shadowColor = ${uiColor({ ...sh.color, a: 1 })}.cgColor`);
    L.push(`${v}.layer.shadowOpacity = ${num(sh.color.a)}`);
    L.push(`${v}.layer.shadowOffset = CGSize(width: ${num(sh.x)}, height: ${num(sh.y)})`);
    L.push(`${v}.layer.shadowRadius = ${num(sh.blur / 2)}`);
  }
  if (s.opacity.value < 1) L.push(`${v}.alpha = ${num(s.opacity.value)}`);
  if (s.clip) L.push(`${v}.clipsToBounds = true`);
  if (s.rotation) L.push(`${v}.transform = CGAffineTransform(rotationAngle: ${num((s.rotation * Math.PI) / 180)})`);
  for (const c of t.children) {
    L.push('');
    L.push(...uikitView(ctx, c, names, v, !!lay));
  }
  // Into the stack in layout order, the rest at their own positions.
  if (parentVar) L.push(`${parentVar}.${parentStack && s.position === 'flow' ? 'addArrangedSubview' : 'addSubview'}(${v})`);
  if (t.cut) L.push(`// ещё слоёв: ${t.cut}`);
  return L;
}

function uikit(ctx: Ctx, t: Tree): string {
  return uikitView(ctx, t, new Set(), null, false).join('\n');
}

// ---------- Jetpack Compose ----------

function ktColor(c: ColorValue): string {
  if (c.token) return c.token.android;
  const a = byte(c.a).toString(16).padStart(2, '0').toUpperCase();
  return `Color(0x${a}${hex(c).slice(1)})`;
}
const dp = (v: NumberValue) => (v.token ? v.token.android : `${num(v.value)}.dp`);
const ktFloat = (v: number) => `${num(v)}f`;
function ktBrush(f: FillValue): string | null {
  if (f.kind === 'solid') return null;
  if (f.kind === 'image') return null;
  const stops = f.stops.map((s) => `${ktFloat(s.position)} to ${ktColor(s.color)}`).join(', ');
  if (f.kind === 'linear') return `Brush.linearGradient(${stops})`;
  if (f.kind === 'radial') return `Brush.radialGradient(${stops})`;
  return `Brush.sweepGradient(${stops})`;
}

function composeModifier(s: NodeStyle, parent: Tree | null): string[] {
  const m: string[] = [];
  const pd = parent?.s.layout?.direction ?? null;
  if (s.position === 'absolute' || (parent && !parent.s.layout)) m.push(`.offset(x = ${num(s.x)}.dp, y = ${num(s.y)}.dp)`);
  for (const axis of ['width', 'height'] as const) {
    const fill = s.position === 'flow' && s.sizing[axis] === 'FILL';
    const main = (axis === 'width') === (pd === 'row');
    if (fill) m.push(main && pd !== 'grid' ? '.weight(1f)' : axis === 'width' ? '.fillMaxWidth()' : '.fillMaxHeight()');
    else if (s.sizing[axis] === 'PERCENT') m.push(`.${axis === 'width' ? 'fillMaxWidth' : 'fillMaxHeight'}(${num(pctNum(s.percent[axis]) / 100)}f)`);
    else if (s.sizing[axis] === 'FIXED') m.push(`.${axis}(${dp(s[axis])})`);
  }
  for (const sh of s.shadows.filter((x) => !x.inset).slice(0, 1)) m.push(`.shadow(elevation = ${num(Math.max(sh.blur / 2, Math.abs(sh.y)))}.dp, shape = ${composeShape(s)})`);
  if (s.opacity.value < 1 || s.opacity.token) m.push(`.alpha(${s.opacity.token?.android ?? ktFloat(s.opacity.value)})`);
  if (s.rotation) m.push(`.rotate(${ktFloat(s.rotation)})`);
  if ((s.radius && s.radius !== 'ellipse') || s.radius === 'ellipse' || s.clip) m.push(`.clip(${composeShape(s)})`);
  if (!s.text) {
    for (const f of [...s.fills].reverse()) {
      if (f.kind === 'solid') m.push(`.background(color = ${ktColor(f.color)}, shape = ${composeShape(s)})`);
      else if (f.kind !== 'image') m.push(`.background(brush = ${ktBrush(f)}, shape = ${composeShape(s)})`);
    }
  }
  if (s.stroke) {
    const st = s.stroke.fills.find((f) => f.kind === 'solid');
    const w = 'value' in s.stroke.weight ? dp(s.stroke.weight) : `${num(s.stroke.weight.top)}.dp`;
    m.push(`.border(width = ${w}, color = ${st && st.kind === 'solid' ? ktColor(st.color) : 'Color.Black'}, shape = ${composeShape(s)})`);
  }
  if (s.blur) m.push(`.blur(${num(s.blur / 2)}.dp)`);
  const lay = s.layout;
  if (lay) {
    const P = lay.padding;
    const v = [P.left, P.top, P.right, P.bottom];
    if (v.some((x) => x.value || x.token)) {
      if (v.every((x) => x.value === v[0]!.value && x.token?.id === v[0]!.token?.id)) m.push(`.padding(${dp(v[0]!)})`);
      else if (P.left.value === P.right.value && P.top.value === P.bottom.value) m.push(`.padding(horizontal = ${dp(P.left)}, vertical = ${dp(P.top)})`);
      else m.push(`.padding(start = ${dp(P.left)}, top = ${dp(P.top)}, end = ${dp(P.right)}, bottom = ${dp(P.bottom)})`);
    }
  }
  return m;
}

function composeShape(s: NodeStyle): string {
  if (s.radius === 'ellipse') return 'CircleShape';
  if (!s.radius) return 'RectangleShape';
  const R = s.radius;
  if ([R.tr, R.br, R.bl].every((x) => x.value === R.tl.value && x.token?.id === R.tl.token?.id)) return `RoundedCornerShape(${dp(R.tl)})`;
  return `RoundedCornerShape(topStart = ${dp(R.tl)}, topEnd = ${dp(R.tr)}, bottomEnd = ${dp(R.br)}, bottomStart = ${dp(R.bl)})`;
}

function composeText(t: TextValue & { characters: string }, modifier: string): string {
  const args: string[] = [`text = ${strLit(t.characters)}`];
  if (modifier) args.push(`modifier = ${modifier}`);
  const st: string[] = [];
  st.push(`fontSize = ${t.size.token ? t.size.token.android : `${num(t.size.value)}.sp`}`);
  st.push(`fontWeight = FontWeight(${Math.round(t.weight)})`);
  st.push(`fontFamily = FontFamily.Default /* ${t.family} */`);
  if (t.italic) st.push('fontStyle = FontStyle.Italic');
  if (t.lineHeight) st.push(`lineHeight = ${num(t.lineHeight.unit === 'PERCENT' ? (t.lineHeight.value / 100) * t.size.value : t.lineHeight.value)}.sp`);
  if (t.letterSpacing.value) st.push(`letterSpacing = ${num(t.letterSpacing.value)}.sp`);
  if (t.color) st.push(`color = ${ktColor(t.color)}`);
  if (t.align !== 'left') st.push(`textAlign = TextAlign.${{ center: 'Center', right: 'End', justify: 'Justify', left: 'Start' }[t.align]}`);
  if (t.decoration !== 'none') st.push(`textDecoration = TextDecoration.${t.decoration === 'underline' ? 'Underline' : 'LineThrough'}`);
  args.push(`style = TextStyle(\n${pad(st.join(',\n'), 4)},\n)`);
  if (t.truncate) args.push(`maxLines = ${t.truncate}`, 'overflow = TextOverflow.Ellipsis');
  return `Text(\n${pad(args.join(',\n'), 4)},\n)`;
}

function compose(ctx: Ctx, t: Tree, parent: Tree | null): string {
  const s = t.s;
  const mods = composeModifier(s, parent);
  const modifier = mods.length ? `Modifier\n${pad(mods.join('\n'), 4)}` : '';
  const comment = s.component ? `// ${s.component}\n` : '';
  if (s.text) {
    const t2 = s.text.textCase === 'upper' ? { ...s.text, characters: s.text.characters.toUpperCase() } : s.text;
    return comment + composeText(t2, modifier);
  }
  const img = imageFill(s);
  if (img && !t.children.length) return `${comment}Image(\n    painter = painterResource(R.drawable.${slug(img.name).replace(/-/g, '_') || 'image'}),\n    contentDescription = ${strLit(s.name)},\n    contentScale = ContentScale.${img.scaleMode === 'FIT' ? 'Fit' : 'Crop'},${modifier ? `\n    modifier = ${modifier.replace(/\n/g, '\n    ')},` : ''}\n)`;
  if (isVectorish(s)) return `${comment}Icon(\n    painter = painterResource(R.drawable.${slug(s.name).replace(/-/g, '_') || 'icon'}),\n    contentDescription = ${strLit(s.name)},${modifier ? `\n    modifier = ${modifier.replace(/\n/g, '\n    ')},` : ''}\n)`;
  const lay = s.layout;
  const kids = t.children.map((c) => compose(ctx, c, t));
  if (t.cut) kids.push(`// ещё слоёв: ${t.cut}`);
  const body = kids.length ? ` {\n${pad(kids.join('\n'), 4)}\n}` : ' {}';
  const args: string[] = [];
  if (modifier) args.push(`modifier = ${modifier}`);
  let name = 'Box';
  if (lay && lay.direction !== 'grid') {
    const H = lay.direction === 'row';
    name = H ? 'Row' : 'Column';
    const spacing = lay.justify.startsWith('space') ? null : lay.gap;
    // spacedBy with main-axis alignment: Row uses Alignment.Horizontal, Column uses Vertical.
    const along = lay.justify === 'center' ? (H ? ', Alignment.CenterHorizontally' : ', Alignment.CenterVertically') : lay.justify === 'end' ? (H ? ', Alignment.End' : ', Alignment.Bottom') : '';
    const arr =
      lay.justify === 'space-between'
        ? 'Arrangement.SpaceBetween'
        : lay.justify === 'space-around'
          ? 'Arrangement.SpaceAround'
          : lay.justify === 'space-evenly'
            ? 'Arrangement.SpaceEvenly'
            : spacing && (spacing.value || spacing.token)
              ? `Arrangement.spacedBy(${dp(spacing)}${along})`
              : lay.justify === 'center'
                ? 'Arrangement.Center'
                : lay.justify === 'end'
                  ? `Arrangement.${H ? 'End' : 'Bottom'}`
                  : null;
    if (arr) args.push(`${H ? 'horizontalArrangement' : 'verticalArrangement'} = ${arr}`);
    const al = H ? { start: 'Alignment.Top', center: 'Alignment.CenterVertically', end: 'Alignment.Bottom', baseline: 'Alignment.CenterVertically' }[lay.align] : { start: 'Alignment.Start', center: 'Alignment.CenterHorizontally', end: 'Alignment.End', baseline: 'Alignment.Start' }[lay.align];
    if (lay.align !== 'start') args.push(`${H ? 'verticalAlignment' : 'horizontalAlignment'} = ${al}`);
  } else if (lay) {
    name = 'LazyVerticalGrid';
    args.unshift(`columns = GridCells.Fixed(${Math.max(1, lay.columns.length)})`);
    args.push(`horizontalArrangement = Arrangement.spacedBy(${dp(lay.gap)})`, `verticalArrangement = Arrangement.spacedBy(${dp(lay.crossGap ?? lay.gap)})`);
  }
  const call = args.length ? `${name}(\n${pad(args.join(',\n'), 4)},\n)` : `${name}`;
  return `${comment}${call}${body}`;
}

// ---------- Android XML ----------

function xmlColor(c: ColorValue): string {
  if (c.token) return c.token.android.startsWith('@') ? c.token.android : `@color/${c.token.resource}`;
  const a = byte(c.a).toString(16).padStart(2, '0').toUpperCase();
  return c.a >= 1 ? hex(c) : `#${a}${hex(c).slice(1)}`;
}
const xmlDp = (v: NumberValue) => (v.token ? `@dimen/${v.token.resource}` : `${num(v.value)}dp`);
const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '\\n');

function androidXml(ctx: Ctx, t: Tree, root: boolean, parent: Tree | null): string {
  const s = t.s;
  const lay = s.layout && s.layout.direction !== 'grid' ? s.layout : null;
  const img = imageFill(s);
  const tag = s.text ? 'TextView' : lay ? 'LinearLayout' : img || isVectorish(s) ? 'ImageView' : 'FrameLayout';
  const a: string[] = [];
  if (root) a.push('xmlns:android="http://schemas.android.com/apk/res/android"');
  a.push(`android:id="@+id/${identifier(s.name, 'view')}"`);
  const pd = parent?.s.layout?.direction ?? null;
  for (const axis of ['width', 'height'] as const) {
    const fill = s.position === 'flow' && s.sizing[axis] === 'FILL';
    const main = (axis === 'width') === (pd === 'row');
    const v = fill ? (main ? '0dp' : 'match_parent') : s.sizing[axis] === 'HUG' ? 'wrap_content' : xmlDp(s[axis]);
    a.push(`android:layout_${axis}="${v}"`);
  }
  if (s.position === 'flow' && pd !== 'grid' && ((s.sizing.width === 'FILL' && pd === 'row') || (s.sizing.height === 'FILL' && pd === 'column'))) a.push('android:layout_weight="1"');
  if (parent && !parent.s.layout) a.push(`android:layout_marginStart="${num(s.x)}dp"`, `android:layout_marginTop="${num(s.y)}dp"`);
  // The parent's gap becomes padding on all children except the first.
  if (parent?.s.layout && parent.s.layout.direction !== 'grid' && parent.children[0] !== t && !parent.s.layout.justify.startsWith('space') && (parent.s.layout.gap.value || parent.s.layout.gap.token)) {
    a.push(`android:layout_${parent.s.layout.direction === 'row' ? 'marginStart' : 'marginTop'}="${xmlDp(parent.s.layout.gap)}"`);
  }
  if (lay) {
    a.push(`android:orientation="${lay.direction === 'row' ? 'horizontal' : 'vertical'}"`);
    const H = lay.direction === 'row';
    const main = { start: H ? 'start' : 'top', center: H ? 'center_horizontal' : 'center_vertical', end: H ? 'end' : 'bottom' } as Record<string, string>;
    const cross = { start: H ? 'top' : 'start', center: H ? 'center_vertical' : 'center_horizontal', end: H ? 'bottom' : 'end', baseline: H ? 'top' : 'start' } as Record<string, string>;
    const g = [main[lay.justify], cross[lay.align]].filter(Boolean);
    if (g.length && !(lay.justify === 'start' && lay.align === 'start')) a.push(`android:gravity="${g.join('|')}"`);
    const P = lay.padding;
    for (const [k, v] of [['paddingStart', P.left], ['paddingTop', P.top], ['paddingEnd', P.right], ['paddingBottom', P.bottom]] as const) if (v.value || v.token) a.push(`android:${k}="${xmlDp(v)}"`);
  }
  if (s.text) {
    const tx = s.text;
    a.push(`android:text="${escXml(tx.characters)}"`);
    a.push(`android:textSize="${tx.size.token ? `@dimen/${tx.size.token.resource}` : `${num(tx.size.value)}sp`}"`);
    if (tx.color) a.push(`android:textColor="${xmlColor(tx.color)}"`);
    a.push(`android:fontFamily="@font/${slug(`${tx.family} ${tx.style}`).replace(/-/g, '_')}"`);
    if (tx.lineHeight) a.push(`android:lineHeight="${num(tx.lineHeight.unit === 'PERCENT' ? (tx.lineHeight.value / 100) * tx.size.value : tx.lineHeight.value)}sp"`);
    if (tx.letterSpacing.value) a.push(`android:letterSpacing="${num(tx.letterSpacing.value / tx.size.value)}"`);
    if (tx.align !== 'left') a.push(`android:gravity="${tx.align === 'center' ? 'center_horizontal' : tx.align === 'right' ? 'end' : 'start'}"`);
    if (tx.textCase === 'upper') a.push('android:textAllCaps="true"');
    if (tx.truncate) a.push(`android:maxLines="${tx.truncate}"`, 'android:ellipsize="end"');
  } else if (img) a.push(`android:src="@drawable/${slug(img.name).replace(/-/g, '_') || 'image'}"`, `android:scaleType="${img.scaleMode === 'FIT' ? 'fitCenter' : 'centerCrop'}"`);
  else if (isVectorish(s)) a.push(`android:src="@drawable/${slug(s.name).replace(/-/g, '_') || 'icon'}"`);
  const solid = !s.text ? s.fills.find((f) => f.kind === 'solid') : undefined;
  const needsShape = !!(s.radius || s.stroke || s.fills.some((f) => f.kind !== 'solid' && f.kind !== 'image'));
  if (needsShape) a.push(`android:background="@drawable/bg_${slug(s.name).replace(/-/g, '_') || 'view'}"`);
  else if (solid && solid.kind === 'solid') a.push(`android:background="${xmlColor(solid.color)}"`);
  if (s.shadows.some((x) => !x.inset)) a.push(`android:elevation="${num(Math.max(...s.shadows.map((x) => x.blur / 2)))}dp"`);
  if (s.opacity.value < 1) a.push(`android:alpha="${num(s.opacity.value)}"`);
  if (s.rotation) a.push(`android:rotation="${num(s.rotation)}"`);
  if (s.clip && !s.text) a.push('android:clipChildren="true"');
  const notes: string[] = [];
  if (needsShape) {
    const parts: string[] = [];
    if (solid && solid.kind === 'solid') parts.push(`заливка ${xmlColor(solid.color)}`);
    if (s.radius === 'ellipse') parts.push('овал');
    else if (s.radius) parts.push(`скругление ${num(s.radius.tl.value)}dp`);
    if (s.stroke) parts.push(`обводка ${num('value' in s.stroke.weight ? s.stroke.weight.value : s.stroke.weight.top)}dp`);
    notes.push(`<!-- bg_${slug(s.name).replace(/-/g, '_') || 'view'}: shape-drawable — ${parts.join(', ') || 'градиент'} -->`);
  }
  const attrs = a.map((x) => `    ${x}`).join('\n');
  const kids = t.children.map((c) => androidXml(ctx, c, false, t));
  if (t.cut) kids.push(`<!-- ещё слоёв: ${t.cut} -->`);
  const comment = s.component ? `<!-- ${escXml(s.component)} -->\n` : '';
  const head = `${notes.join('\n')}${notes.length ? '\n' : ''}${comment}<${tag}\n${attrs}`;
  if (!kids.length) return `${head} />`;
  return `${head}>\n\n${pad(kids.join('\n\n'), 4)}\n\n</${tag}>`;
}
