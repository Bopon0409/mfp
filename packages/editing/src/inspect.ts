// Inspect (developer mode): the layer's styling in a developer-friendly form — sizes and sizing modes,
// auto layout, paints, stroke, corner radii, shadows, text (with differently styled runs) — and
// the variables the values are bound to (their code names). Variable values can be
// viewed in another collection mode (modes) without changing the file. Both the property list in the
// panel and the code (codegen.ts) are built from this model.

import {
  effectiveStyle,
  formatOklch,
  invert,
  multiply,
  resolveVariable,
  rotationOf,
  styleWeight,
  textSegments,
  type Document,
  type Effect,
  type Matrix,
  type NodeType,
  type Paint,
  type Props,
  type RGBA,
  type VariableAlias,
} from '@mfp/core';
import { getSizing, isAutoLayout, type SizingMode } from './sizing.ts';

/** Variable a value is bound to: name and code entries for different platforms. */
export interface Token {
  id: string;
  /** Variable name (“color/primary/500”). */
  name: string;
  collection: string;
  /** CSS: var(--color-primary-500) or codeSyntax.WEB. */
  web: string;
  /** Swift: colorPrimary500 or codeSyntax.iOS. */
  ios: string;
  /** Kotlin: colorPrimary500 or codeSyntax.ANDROID. */
  android: string;
  /** Android resource: color_primary_500. */
  resource: string;
}

export interface ColorValue {
  r: number;
  g: number;
  b: number;
  a: number;
  token?: Token;
}

export interface NumberValue {
  value: number;
  token?: Token;
}

export interface GradientStop {
  position: number;
  color: ColorValue;
}

export type FillValue =
  | { kind: 'solid'; color: ColorValue }
  /** Linear: angle as in CSS (0° — up, clockwise), start and end as fractions of the bounds. */
  | { kind: 'linear'; angle: number; start: [number, number]; end: [number, number]; stops: GradientStop[] }
  | { kind: 'radial'; center: [number, number]; radius: [number, number]; stops: GradientStop[] }
  | { kind: 'angular'; center: [number, number]; stops: GradientStop[] }
  | { kind: 'image'; name: string; scaleMode: string; hash: string | null };

export interface ShadowValue {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: ColorValue;
}

export interface TextValue {
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  size: NumberValue;
  /** null — auto (normal). */
  lineHeight: { value: number; unit: 'PX' | 'PERCENT'; token?: Token } | null;
  /** In px (percentages converted from the font size). */
  letterSpacing: NumberValue;
  align: 'left' | 'center' | 'right' | 'justify';
  verticalAlign: 'top' | 'center' | 'bottom';
  textCase: 'none' | 'upper' | 'lower' | 'title' | 'small-caps';
  decoration: 'none' | 'underline' | 'line-through';
  color: ColorValue | null;
  fills: FillValue[];
  paragraphSpacing: number;
  /** Truncation “…”: number of lines (null — no limit). */
  truncate: number | null;
  textStyle: string | null;
  link: string | null;
}

export interface TextSegment {
  characters: string;
  style: TextValue;
}

export type Justify = 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
export type Align = 'start' | 'center' | 'end' | 'baseline';

export interface LayoutValue {
  direction: 'row' | 'column' | 'grid';
  gap: NumberValue;
  /** Between rows when wrapping (null — as gap). */
  crossGap: NumberValue | null;
  padding: { top: NumberValue; right: NumberValue; bottom: NumberValue; left: NumberValue };
  justify: Justify;
  align: Align;
  wrap: boolean;
  /** Grid: column and row tracks (CSS: 1fr, 120px, auto). */
  columns: string[];
  rows: string[];
}

export interface StrokeValue {
  fills: FillValue[];
  /** One width or per side. */
  weight: NumberValue | { top: number; right: number; bottom: number; left: number };
  align: 'inside' | 'outside' | 'center';
  dash: number[];
}

export interface NodeStyle {
  id: string;
  name: string;
  type: NodeType;
  visible: boolean;
  /** Position in the parent (for a rotated layer — of the unrotated bounds, rotation around the center). */
  x: number;
  y: number;
  width: NumberValue;
  height: NumberValue;
  sizing: { width: SizingMode; height: SizingMode };
  /** Size as a percentage of the parent's inner area (PERCENT mode). */
  percent: { width?: number; height?: number };
  limits: { minWidth?: NumberValue; maxWidth?: NumberValue; minHeight?: NumberValue; maxHeight?: NumberValue };
  /** Degrees clockwise (as in CSS). */
  rotation: number;
  /** 3D rotation (like CSS perspective / translateZ / rotateX / rotateY); none — undefined. */
  transform3d?: { rotateX: number; rotateY: number; perspective: number; translateZ: number };
  /** In the auto layout flow, out of flow (absolute) or just in a frame (free). */
  position: 'flow' | 'absolute' | 'free';
  /** The parent's auto layout direction (for “fill”: flex-grow or stretch). */
  parentDirection: 'row' | 'column' | 'grid' | null;
  layout: LayoutValue | null;
  fills: FillValue[];
  stroke: StrokeValue | null;
  /** Corner radii; ellipse — an ellipse. */
  radius: { tl: NumberValue; tr: NumberValue; br: NumberValue; bl: NumberValue } | 'ellipse' | null;
  shadows: ShadowValue[];
  blur: number;
  backdropBlur: number;
  opacity: NumberValue;
  blend: string | null;
  clip: boolean;
  text: (TextValue & { characters: string; segments: TextSegment[] }) | null;
  /** Instance: name of the main component (set). */
  component: string | null;
}

export interface InspectOptions {
  /** Collection modes for variable values (viewing in another mode). */
  modes?: Record<string, string>;
}

const I: Matrix = [1, 0, 0, 0, 1, 0];
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- Variable names for code ----------

const words = (name: string) => name.split(/[\s/._-]+/).filter(Boolean);
const camel = (name: string) => {
  const w = words(name).map((s) => s.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const id = w.map((s, i) => (i ? s[0]!.toUpperCase() + s.slice(1) : s[0]!.toLowerCase() + s.slice(1))).join('');
  return /^\p{L}/u.test(id) ? id : `v${id}`;
};
const kebab = (name: string) =>
  words(name)
    .map((s) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
    .filter(Boolean)
    .join('-');

export function tokenOf(doc: Document, variableId: string): Token | undefined {
  if (!doc.has(variableId) || doc.type(variableId) !== 'VARIABLE') return undefined;
  const name = doc.get(variableId, 'name') ?? '';
  const coll = doc.parent(variableId);
  const cs = doc.get(variableId, 'codeSyntax') ?? {};
  const k = kebab(name) || 'token';
  const web = cs.WEB ? (/^(var\(|--)/.test(cs.WEB) ? (cs.WEB.startsWith('--') ? `var(${cs.WEB})` : cs.WEB) : cs.WEB) : `var(--${k})`;
  return {
    id: variableId,
    name,
    collection: coll && doc.type(coll) === 'VARIABLE_COLLECTION' ? (doc.get(coll, 'name') ?? '') : '',
    web,
    ios: cs.iOS || camel(name),
    android: cs.ANDROID || camel(name),
    resource: k.replace(/-/g, '_'),
  };
}

// ---------- Model ----------

export function inspectNode(doc: Document, id: string, opts: InspectOptions = {}): NodeStyle {
  const p = doc.props(id);
  const type = doc.type(id)!;
  const bound = (p.boundVariables ?? {}) as Record<string, VariableAlias>;
  const num = (field: string, fallback: number): NumberValue => {
    const a = bound[field];
    if (!a) return { value: fallback };
    const v = resolveVariable(doc, a.id, id, 0, opts.modes);
    return { value: typeof v === 'number' ? v : fallback, token: tokenOf(doc, a.id) };
  };
  const color = (c: { r: number; g: number; b: number; a?: number }, opacity = 1, alias?: VariableAlias): ColorValue => {
    if (alias) {
      const v = resolveVariable(doc, alias.id, id, 0, opts.modes) as RGBA | undefined;
      if (v && typeof v === 'object' && 'r' in v) return { r: v.r, g: v.g, b: v.b, a: (v.a ?? 1) * (v.a !== undefined && v.a < 1 ? 1 : opacity), token: tokenOf(doc, alias.id) };
    }
    return { r: c.r, g: c.g, b: c.b, a: (c.a ?? 1) * opacity };
  };
  const w = p.width ?? 0;
  const h = p.height ?? 0;
  const fillsOf = (list: readonly Paint[] | undefined): FillValue[] =>
    (list ?? [])
      .filter((f) => f.visible !== false)
      .map((f) => paintValue(f, w, h, color, p.name ?? ''))
      .filter((f): f is FillValue => !!f)
      .reverse();

  // Position: unrotated bounds with the same center.
  const t = (p.transform ?? I) as Matrix;
  const cx = t[0] * (w / 2) + t[1] * (h / 2) + t[2];
  const cy = t[3] * (w / 2) + t[4] * (h / 2) + t[5];
  const parent = doc.parent(id);
  const parentAuto = !!parent && doc.type(parent) !== 'PAGE' && isAutoLayout(doc, parent);
  const parentMode = parent ? doc.get(parent, 'layoutMode') : undefined;
  const absolute = parentAuto && p.layoutPositioning === 'ABSOLUTE';

  let layout: LayoutValue | null = null;
  if (isAutoLayout(doc, id)) {
    const dir = p.layoutMode === 'GRID' ? 'grid' : p.layoutMode === 'VERTICAL' ? 'column' : 'row';
    const J: Record<string, Justify> = { MIN: 'start', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'space-between', SPACE_AROUND: 'space-around', SPACE_EVENLY: 'space-evenly' };
    const A: Record<string, Align> = { MIN: 'start', CENTER: 'center', MAX: 'end', BASELINE: 'baseline' };
    const track = (s: { type: string; value?: number }) => (s.type === 'FLEX' ? `${s.value ?? 1}fr` : s.type === 'FIXED' ? `${round(s.value ?? 0)}px` : 'auto');
    layout = {
      direction: dir,
      gap: dir === 'grid' ? num('gridColumnGap', p.gridColumnGap ?? 0) : num('itemSpacing', p.itemSpacing ?? 0),
      crossGap: dir === 'grid' ? num('gridRowGap', p.gridRowGap ?? 0) : p.layoutWrap === 'WRAP' && p.counterAxisSpacing != null ? num('counterAxisSpacing', p.counterAxisSpacing) : null,
      padding: { top: num('paddingTop', p.paddingTop ?? 0), right: num('paddingRight', p.paddingRight ?? 0), bottom: num('paddingBottom', p.paddingBottom ?? 0), left: num('paddingLeft', p.paddingLeft ?? 0) },
      justify: J[p.primaryAxisAlignItems ?? 'MIN'] ?? 'start',
      align: A[p.counterAxisAlignItems ?? 'MIN'] ?? 'start',
      wrap: p.layoutWrap === 'WRAP',
      columns: (p.gridColumnSizes ?? []).map(track),
      rows: (p.gridRowSizes ?? []).map(track),
    };
  }

  // Stroke.
  let stroke: StrokeValue | null = null;
  const strokeFills = (p.strokes ?? [])
    .filter((s) => s.visible !== false)
    .map((s) => paintValue(s, w, h, color, p.name ?? ''))
    .filter((f): f is FillValue => !!f)
    .reverse();
  const sides = [p.strokeTopWeight, p.strokeRightWeight, p.strokeBottomWeight, p.strokeLeftWeight];
  if (strokeFills.length && ((p.strokeWeight ?? 1) > 0 || sides.some((s) => s))) {
    const base = p.strokeWeight ?? 1;
    const per = sides.map((s) => s ?? base);
    stroke = {
      fills: strokeFills,
      weight: per.every((s) => s === per[0]) ? num('strokeWeight', per[0]!) : { top: per[0]!, right: per[1]!, bottom: per[2]!, left: per[3]! },
      align: p.strokeAlign === 'OUTSIDE' ? 'outside' : p.strokeAlign === 'CENTER' ? 'center' : 'inside',
      dash: p.dashPattern ?? [],
    };
  }

  // Corner radii.
  let radius: NodeStyle['radius'] = null;
  if (type === 'ELLIPSE') radius = 'ellipse';
  else if (type !== 'TEXT' && type !== 'LINE' && type !== 'VECTOR' && type !== 'STAR' && type !== 'POLYGON') {
    const all = p.cornerRadius ?? 0;
    const r = {
      tl: num(bound.topLeftRadius ? 'topLeftRadius' : 'cornerRadius', p.topLeftRadius ?? all),
      tr: num(bound.topRightRadius ? 'topRightRadius' : 'cornerRadius', p.topRightRadius ?? all),
      br: num(bound.bottomRightRadius ? 'bottomRightRadius' : 'cornerRadius', p.bottomRightRadius ?? all),
      bl: num(bound.bottomLeftRadius ? 'bottomLeftRadius' : 'cornerRadius', p.bottomLeftRadius ?? all),
    };
    if (r.tl.value || r.tr.value || r.br.value || r.bl.value) radius = r;
  }

  // Effects.
  const effects = (p.effects ?? []).filter((e) => e.visible !== false);
  const shadows: ShadowValue[] = [];
  let blur = 0;
  let backdropBlur = 0;
  for (const e of effects) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const c = e.color as RGBA;
      shadows.push({ inset: e.type === 'INNER_SHADOW', x: e.offset.x, y: e.offset.y, blur: e.radius, spread: e.spread ?? 0, color: color(c, 1, e.boundVariables?.color) });
    } else if (e.type === 'LAYER_BLUR') blur = e.radius;
    else if (e.type === 'BACKGROUND_BLUR') backdropBlur = e.radius;
  }

  // Text.
  let text: NodeStyle['text'] = null;
  if (type === 'TEXT') {
    const chars = p.characters ?? '';
    const segs = textSegments(p.textRuns, chars.length).map((s) => ({ characters: chars.slice(s.start, s.end), style: textValue(doc, id, { ...p, ...effectiveStyle(p, s.style) } as Props, bound, num, color, w, h) }));
    const base = textValue(doc, id, p, bound, num, color, w, h);
    text = { ...base, characters: chars, segments: segs.length > 1 ? segs : [] };
  }

  const comp = type === 'INSTANCE' ? (p.componentId ?? null) : null;
  let component: string | null = null;
  if (comp && doc.has(comp)) {
    const set = doc.parent(comp);
    component = set && doc.type(set) === 'COMPONENT_SET' ? `${doc.get(set, 'name') ?? ''}` : (doc.get(comp, 'name') ?? '');
  }

  return {
    id,
    name: p.name ?? '',
    type,
    visible: p.visible !== false,
    x: round(cx - w / 2),
    y: round(cy - h / 2),
    width: num('width', w),
    height: num('height', h),
    sizing: { width: getSizing(doc, id, 'width'), height: getSizing(doc, id, 'height') },
    percent: {
      ...(getSizing(doc, id, 'width') === 'PERCENT' ? { width: doc.get(id, 'widthPercent') } : {}),
      ...(getSizing(doc, id, 'height') === 'PERCENT' ? { height: doc.get(id, 'heightPercent') } : {}),
      // Limits as a percentage of the parent (MFP extension): in code — min-width: 30% etc.
      ...Object.fromEntries((['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const).filter((k) => p[`${k}Percent`] != null).map((k) => [k, p[`${k}Percent`] as number])),
    },
    limits: Object.fromEntries(
      (['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const).filter((k) => p[k] != null).map((k) => [k, num(k, p[k] as number)]),
    ),
    rotation: round(-rotationOf(t), 2) || 0,
    ...(p.rotateX || p.rotateY || p.translateZ
      ? { transform3d: { rotateX: round(p.rotateX ?? 0, 2), rotateY: round(p.rotateY ?? 0, 2), perspective: round(p.perspective ?? 1000, 2), translateZ: round(p.translateZ ?? 0, 2) } }
      : {}),
    // A layer directly on the page is the code root: no position.
    position: absolute ? 'absolute' : parentAuto || !parent || doc.type(parent) === 'PAGE' ? 'flow' : 'free',
    parentDirection: parentAuto ? (parentMode === 'GRID' ? 'grid' : parentMode === 'VERTICAL' ? 'column' : 'row') : null,
    layout,
    fills: type === 'TEXT' ? [] : fillsOf(p.fills),
    stroke,
    radius,
    shadows,
    blur,
    backdropBlur,
    opacity: num('opacity', p.opacity ?? 1),
    blend: p.blendMode && p.blendMode !== 'PASS_THROUGH' && p.blendMode !== 'NORMAL' ? p.blendMode.toLowerCase().replace(/_/g, '-') : null,
    clip: !!p.clipsContent && (type === 'FRAME' || type === 'COMPONENT' || type === 'INSTANCE' || type === 'COMPONENT_SET'),
    text,
    component,
  };
}

/** Text styling (of a node or a run). */
function textValue(
  doc: Document,
  id: string,
  p: Props,
  bound: Record<string, VariableAlias>,
  num: (field: string, fallback: number) => NumberValue,
  color: (c: { r: number; g: number; b: number; a?: number }, opacity?: number, alias?: VariableAlias) => ColorValue,
  w: number,
  h: number,
): TextValue {
  const font = p.fontName ?? { family: 'Inter', style: 'Regular' };
  const { weight, italic } = styleWeight(font.style);
  const size = num('fontSize', p.fontSize ?? 12);
  const lh = p.lineHeight;
  const ls = p.letterSpacing;
  const lsPx = !ls ? 0 : ls.unit === 'PERCENT' ? (ls.value / 100) * size.value : ls.value;
  const fills = (p.fills ?? [])
    .filter((f) => f.visible !== false)
    .map((f) => paintValue(f, w, h, color, ''))
    .filter((f): f is FillValue => !!f)
    .reverse();
  const solid = fills.find((f) => f.kind === 'solid');
  const styleId = p.textStyleId;
  const CASES: Record<string, TextValue['textCase']> = { UPPER: 'upper', LOWER: 'lower', TITLE: 'title', SMALL_CAPS: 'small-caps', SMALL_CAPS_FORCED: 'small-caps' };
  return {
    family: font.family,
    style: font.style,
    weight,
    italic,
    size,
    lineHeight: !lh || lh.unit === 'AUTO' ? null : { value: lh.value, unit: lh.unit === 'PERCENT' ? 'PERCENT' : 'PX', token: bound.lineHeight ? tokenOf(doc, bound.lineHeight.id) : undefined },
    letterSpacing: bound.letterSpacing ? num('letterSpacing', lsPx) : { value: round(lsPx, 3) },
    align: ({ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' } as const)[p.textAlignHorizontal ?? 'LEFT'],
    verticalAlign: ({ TOP: 'top', CENTER: 'center', BOTTOM: 'bottom' } as const)[p.textAlignVertical ?? 'TOP'],
    textCase: CASES[p.textCase ?? ''] ?? 'none',
    decoration: p.textDecoration === 'UNDERLINE' ? 'underline' : p.textDecoration === 'STRIKETHROUGH' ? 'line-through' : 'none',
    color: solid && solid.kind === 'solid' ? solid.color : null,
    fills,
    paragraphSpacing: p.paragraphSpacing ?? 0,
    truncate: p.textTruncation === 'ENDING' ? (p.maxLines ?? 1) : null,
    textStyle: styleId && doc.has(styleId) ? (doc.get(styleId, 'name') ?? null) : null,
    link: p.hyperlink && p.hyperlink.type === 'URL' ? p.hyperlink.value : null,
  };
}

/** Paint → value for code. */
function paintValue(
  f: Paint,
  w: number,
  h: number,
  color: (c: { r: number; g: number; b: number; a?: number }, opacity?: number, alias?: VariableAlias) => ColorValue,
  name: string,
): FillValue | null {
  const op = f.opacity ?? 1;
  if (f.type === 'SOLID') return { kind: 'solid', color: color(f.color, op, f.boundVariables?.color) };
  if (f.type === 'IMAGE') return { kind: 'image', name: name || 'image', scaleMode: f.scaleMode ?? 'FILL', hash: f.imageHash ?? null };
  // A pattern in code is a tile image with repeat.
  if (f.type === 'PATTERN') return { kind: 'image', name: name ? `${name}-pattern` : 'pattern', scaleMode: 'TILE', hash: null };
  // A shader in code is an image (a snapshot of the fill).
  if (f.type === 'SHADER') return { kind: 'image', name: name ? `${name}-shader` : 'shader', scaleMode: 'FILL', hash: null };
  if (!('gradientTransform' in f)) return null;
  const g = f.gradientTransform;
  // Gradient points as fractions of the bounds: from the gradient's unit square.
  const m = invert([g[0][0], g[0][1], g[0][2], g[1][0], g[1][1], g[1][2]] as Matrix);
  const at = (x: number, y: number): [number, number] => [round(m[0] * x + m[1] * y + m[2], 4), round(m[3] * x + m[4] * y + m[5], 4)];
  const stops = [...f.gradientStops].sort((a, b) => a.position - b.position).map((s) => ({ position: round(s.position, 4), color: color(s.color, op) }));
  if (f.type === 'GRADIENT_LINEAR') {
    const s = at(0, 0.5);
    const e = at(1, 0.5);
    // In bounds pixels — angle as in CSS (0° up, clockwise).
    const deg = Math.round(((Math.atan2((e[0] - s[0]) * w, -((e[1] - s[1]) * h)) * 180) / Math.PI + 360) % 360);
    return { kind: 'linear', angle: deg, start: s, end: e, stops };
  }
  const c = at(0.5, 0.5);
  if (f.type === 'GRADIENT_ANGULAR') return { kind: 'angular', center: c, stops };
  const px = multiply([w, 0, 0, 0, h, 0], m);
  const rx = Math.hypot(px[0], px[3]) / 2 / Math.max(1e-6, w);
  const ry = Math.hypot(px[1], px[4]) / 2 / Math.max(1e-6, h);
  return { kind: 'radial', center: c, radius: [round(rx, 4), round(ry, 4)], stops };
}

// ---------- Shared for code ----------

/** Variables the layer's values are bound to (for the list in the panel). */
export function styleTokens(s: NodeStyle): Token[] {
  const out = new Map<string, Token>();
  const add = (t?: Token) => t && out.set(t.id, t);
  const fill = (f: FillValue) => {
    if (f.kind === 'solid') add(f.color.token);
    else if (f.kind !== 'image') for (const st of f.stops) add(st.color.token);
  };
  add(s.width.token);
  add(s.height.token);
  for (const v of Object.values(s.limits)) add(v?.token);
  if (s.layout) {
    add(s.layout.gap.token);
    add(s.layout.crossGap?.token);
    for (const v of Object.values(s.layout.padding)) add(v.token);
  }
  s.fills.forEach(fill);
  s.stroke?.fills.forEach(fill);
  if (s.stroke && 'value' in s.stroke.weight) add(s.stroke.weight.token);
  if (s.radius && s.radius !== 'ellipse') for (const v of Object.values(s.radius)) add(v.token);
  for (const sh of s.shadows) add(sh.color.token);
  add(s.opacity.token);
  if (s.text) {
    add(s.text.size.token);
    add(s.text.lineHeight?.token);
    add(s.text.letterSpacing.token);
    s.text.fills.forEach(fill);
    for (const seg of s.text.segments) seg.style.fills.forEach(fill);
  }
  return [...out.values()];
}

export const hex = (c: { r: number; g: number; b: number }) =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
export const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

/** Color for display: HEX (and opacity), RGB, HSL or OKLCH. */
export function formatColor(c: ColorValue, format: 'hex' | 'rgb' | 'hsl' | 'oklch' = 'hex'): string {
  const a = round(c.a, 2);
  if (format === 'oklch') return formatOklch({ r: c.r, g: c.g, b: c.b, a });
  if (format === 'rgb') return a >= 1 ? `rgb(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)})` : `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${a})`;
  if (format === 'hsl') {
    const r = c.r;
    const g = c.g;
    const b = c.b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let hh = 0;
    let s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hh = Math.round(hh * 60 + 360) % 360;
    }
    const body = `${hh}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`;
    return a >= 1 ? `hsl(${body})` : `hsla(${body}, ${a})`;
  }
  return a >= 1 ? hex(c) : `${hex(c)} ${Math.round(a * 100)}%`;
}
