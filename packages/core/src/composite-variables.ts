// Composite variables (our own): gradient, shadows and typography — like
// DTCG composite tokens. Values are per collection mode, as with regular variables; inside are
// references to variables: stop and shadow color — to a color, font size — to a number, font family and style — to a
// string. Binding: a gradient — to a paint (boundVariables.gradient), shadows — to the layer's effects (field
// “shadows”), typography — to text (field “typography”). The layer also stores the resolved value.

import { styleWeight } from './text-style.ts';
import type {
  Effect,
  GradientPaint,
  GradientVariableValue,
  LetterSpacing,
  LineHeight,
  Paint,
  Props,
  RGBA,
  ShadowEffect,
  ShadowVariableValue,
  TypographyVariableValue,
  VariableAlias,
  VariableValue,
} from './types.ts';

export type CompositeValue = GradientVariableValue | ShadowVariableValue | TypographyVariableValue;
export type CompositeType = 'GRADIENT' | 'SHADOW' | 'TYPOGRAPHY';

const KIND: Record<CompositeValue['type'], CompositeType> = { GRADIENT: 'GRADIENT', SHADOWS: 'SHADOW', TYPOGRAPHY: 'TYPOGRAPHY' };

const isRef = (v: unknown): v is VariableAlias => !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'VARIABLE_ALIAS';
const isRgba = (v: unknown): v is RGBA => !!v && typeof v === 'object' && 'r' in v && 'g' in v && 'b' in v;

export const isComposite = (v: unknown): v is CompositeValue => !!v && typeof v === 'object' && (v as { type?: string }).type! in KIND;

/** Variable type of a composite value. */
export const compositeKind = (v: CompositeValue): CompositeType => KIND[v.type];

/** References to variables inside a composite value. */
export function compositeRefs(v: unknown): string[] {
  if (!isComposite(v)) return [];
  const out: string[] = [];
  const add = (x: unknown) => isRef(x) && out.push(x.id);
  if (v.type === 'GRADIENT') v.stops.forEach((s) => add(s.color));
  else if (v.type === 'SHADOWS') v.shadows.forEach((s) => add(s.color));
  else [v.fontFamily, v.fontStyle, v.fontSize].forEach(add);
  return out;
}

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

/** Default value for a new variable. */
export function defaultComposite(type: CompositeType): CompositeValue {
  if (type === 'GRADIENT')
    return {
      type: 'GRADIENT',
      gradientType: 'GRADIENT_LINEAR',
      angle: 90,
      stops: [
        { position: 0, color: { r: 0.25, g: 0.4, b: 1, a: 1 } },
        { position: 1, color: { r: 0.85, g: 0.3, b: 0.75, a: 1 } },
      ],
    };
  if (type === 'SHADOW') return { type: 'SHADOWS', shadows: [{ color: { r: 0, g: 0, b: 0, a: 0.15 }, x: 0, y: 4, blur: 12, spread: 0 }] };
  return { type: 'TYPOGRAPHY', fontFamily: 'Inter', fontStyle: 'Regular', fontSize: 16, lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PERCENT', value: 0 } };
}

/**
 * Value without references inside (resolve — the variable value for the layer); an unresolved reference or
 * a value of the wrong kind falls back to the default.
 */
export function resolveComposite<T extends CompositeValue>(v: T, resolve: (id: string) => VariableValue | undefined): T {
  const color = (c: RGBA | VariableAlias): RGBA => {
    if (!isRef(c)) return c;
    const r = resolve(c.id);
    return isRgba(r) ? { r: r.r, g: r.g, b: r.b, a: r.a ?? 1 } : BLACK;
  };
  const str = (s: string | VariableAlias, fallback: string): string => {
    if (!isRef(s)) return s;
    const r = resolve(s.id);
    return typeof r === 'string' && r ? r : typeof r === 'number' ? String(r) : fallback;
  };
  if (v.type === 'GRADIENT') return { ...v, stops: v.stops.map((s) => ({ position: s.position, color: color(s.color) })) };
  if (v.type === 'SHADOWS') return { ...v, shadows: v.shadows.map((s) => ({ ...s, color: color(s.color) })) };
  let size = v.fontSize;
  if (isRef(size)) {
    const r = resolve(size.id);
    size = typeof r === 'number' ? r : typeof r === 'string' && r.trim() !== '' && !isNaN(+r) ? +r : 16;
  }
  return { ...v, fontFamily: str(v.fontFamily, 'Inter'), fontStyle: str(v.fontStyle, 'Regular'), fontSize: size } as T;
}

// ---------- Gradient ----------

/**
 * Gradient matrix (like gradientTransform) for a linear gradient angle in degrees, as in CSS:
 * 0 — bottom to top, 90 — left to right, clockwise. Other kinds are centered on the layer.
 */
export function gradientTransformFor(angle: number, type: GradientVariableValue['gradientType'] = 'GRADIENT_LINEAR'): GradientPaint['gradientTransform'] {
  if (type !== 'GRADIENT_LINEAR') return [[1, 0, 0], [0, 1, 0]];
  const a = (angle * Math.PI) / 180;
  // Direction (d) and across (n) as fractions of the layer; the gradient runs from center − d/2 to center + d/2.
  const [dx, dy] = [Math.sin(a), -Math.cos(a)];
  const [nx, ny] = [-dy, dx];
  // Inverse of “gradient space → layer”: [[dx, nx, 0.5 − (dx + nx)/2], [dy, ny, 0.5 − (dy + ny)/2]].
  const [a0, b0, c0, d0, e0, f0] = [dx, nx, 0.5 - (dx + nx) / 2, dy, ny, 0.5 - (dy + ny) / 2];
  const det = a0 * e0 - b0 * d0 || 1;
  const r = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
  return [
    [r(e0 / det), r(-b0 / det), r((b0 * f0 - c0 * e0) / det)],
    [r(-d0 / det), r(a0 / det), r((c0 * d0 - a0 * f0) / det)],
  ];
}

/** Linear gradient angle (as in CSS) from its matrix. */
export function angleOfGradient(t: GradientPaint['gradientTransform']): number {
  // Inverse matrix: points (0, ½) and (1, ½) of gradient space, in the layer.
  const [[a, b, c], [d, e, f]] = t;
  const det = a * e - b * d || 1;
  const inv = [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
  const at = (x: number, y: number) => [inv[0]! * x + inv[1]! * y + inv[2]!, inv[3]! * x + inv[4]! * y + inv[5]!] as const;
  const [x0, y0] = at(0, 0.5);
  const [x1, y1] = at(1, 0.5);
  return Math.round((((Math.atan2(x1 - x0, -(y1 - y0)) * 180) / Math.PI + 360) % 360) * 100) / 100;
}

/** Paint from the variable's gradient (without references); visibility, opacity and blending are taken from base. */
export function gradientPaintOf(v: GradientVariableValue, base?: Paint): GradientPaint {
  const out: GradientPaint = {
    type: v.gradientType,
    gradientTransform: gradientTransformFor(v.angle, v.gradientType),
    gradientStops: [...v.stops].sort((x, y) => x.position - y.position).map((s) => ({ position: s.position, color: { ...(s.color as RGBA), a: (s.color as RGBA).a ?? 1 } })),
  };
  if (base?.visible === false) out.visible = false;
  if (base?.opacity !== undefined && base.opacity !== 1) out.opacity = base.opacity;
  if (base?.blendMode && base.blendMode !== 'NORMAL') out.blendMode = base.blendMode;
  return out;
}

/** Variable value from a gradient paint. */
export function gradientValueOf(p: GradientPaint): GradientVariableValue {
  return { type: 'GRADIENT', gradientType: p.type, angle: p.type === 'GRADIENT_LINEAR' ? angleOfGradient(p.gradientTransform) : 0, stops: p.gradientStops.map((s) => ({ position: s.position, color: { ...s.color } })) };
}

// ---------- Shadows ----------

const isShadow = (e: Effect): e is ShadowEffect => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW';

/** Layer shadows from a value (without references). */
export function shadowEffectsOf(v: ShadowVariableValue): ShadowEffect[] {
  return v.shadows.map((s) => {
    const c = s.color as RGBA;
    const e: ShadowEffect = { type: s.inner ? 'INNER_SHADOW' : 'DROP_SHADOW', color: { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 }, offset: { x: s.x, y: s.y }, radius: Math.max(0, s.blur), visible: true, blendMode: 'NORMAL' };
    if (s.spread) e.spread = s.spread;
    return e;
  });
}

/** Layer effects with shadows from the variable: shadows are replaced, blur and the rest stay after them. */
export function withShadows(effects: readonly Effect[] | undefined, v: ShadowVariableValue): Effect[] {
  return [...shadowEffectsOf(v), ...(effects ?? []).filter((e) => !isShadow(e))];
}

/** Variable value from the layer's (visible) shadows. */
export function shadowValueOf(effects: readonly Effect[] | undefined): ShadowVariableValue {
  return {
    type: 'SHADOWS',
    shadows: (effects ?? []).filter((e): e is ShadowEffect => isShadow(e) && e.visible !== false).map((e) => ({ ...(e.type === 'INNER_SHADOW' ? { inner: true } : {}), color: { ...e.color }, x: e.offset.x, y: e.offset.y, blur: e.radius, spread: e.spread ?? 0 })),
  };
}

// ---------- Typography ----------

/** Text properties from a value (without references). */
export function typographyPropsOf(v: TypographyVariableValue): Pick<Props, 'fontName' | 'fontSize' | 'lineHeight' | 'letterSpacing'> {
  return {
    fontName: { family: v.fontFamily as string, style: v.fontStyle as string },
    fontSize: Math.max(1, v.fontSize as number),
    lineHeight: { ...v.lineHeight } as LineHeight,
    letterSpacing: { ...v.letterSpacing } as LetterSpacing,
  };
}

/** Variable value from text styling. */
export function typographyValueOf(p: Props): TypographyVariableValue {
  const f = p.fontName ?? { family: 'Inter', style: 'Regular' };
  return { type: 'TYPOGRAPHY', fontFamily: f.family, fontStyle: f.style, fontSize: p.fontSize ?? 16, lineHeight: { ...(p.lineHeight ?? { unit: 'AUTO' }) } as LineHeight, letterSpacing: { ...(p.letterSpacing ?? { unit: 'PERCENT', value: 0 }) } as LetterSpacing };
}

// ---------- CSS ----------

const n = (v: number, d = 3) => String(Math.round(v * 10 ** d) / 10 ** d);
const pct = (v: number) => `${n(v * 100, 2)}%`;

/**
 * Value for CSS. color — a color without references in CSS; ref — CSS for a variable reference (var(--x)) or
 * null (then its value via resolve).
 */
export function compositeCss(v: CompositeValue, color: (c: RGBA) => string, resolve: (id: string) => VariableValue | undefined, ref: (id: string) => string | null = () => null): string[] {
  const col = (c: RGBA | VariableAlias) => {
    if (!isRef(c)) return color(c);
    const r = ref(c.id);
    if (r) return r;
    const x = resolve(c.id);
    return color(isRgba(x) ? x : BLACK);
  };
  if (v.type === 'GRADIENT') {
    const stops = [...v.stops].sort((a, b) => a.position - b.position).map((s) => `${col(s.color)} ${pct(s.position)}`).join(', ');
    if (v.gradientType === 'GRADIENT_LINEAR') return [`linear-gradient(${n(v.angle, 2)}deg, ${stops})`];
    if (v.gradientType === 'GRADIENT_ANGULAR') return [`conic-gradient(from 90deg, ${stops})`];
    return [`radial-gradient(50% 50% at 50% 50%, ${stops})`];
  }
  if (v.type === 'SHADOWS') return [v.shadows.map((s) => `${s.inner ? 'inset ' : ''}${n(s.x)}px ${n(s.y)}px ${n(s.blur)}px ${n(s.spread)}px ${col(s.color)}`).join(', ') || 'none'];
  const r = resolveComposite(v, resolve);
  const size = isRef(v.fontSize) ? (ref(v.fontSize.id) ?? `${n(r.fontSize as number)}px`) : `${n(v.fontSize as number)}px`;
  const lh = v.lineHeight.unit === 'AUTO' ? 'normal' : v.lineHeight.unit === 'PIXELS' ? `${n(v.lineHeight.value)}px` : n(v.lineHeight.value / 100);
  const family = isRef(v.fontFamily) ? (ref(v.fontFamily.id) ?? `"${r.fontFamily}"`) : `"${v.fontFamily}"`;
  const w = styleWeight(r.fontStyle as string);
  const font = `${w.italic ? 'italic ' : ''}${w.weight} ${size}/${lh} ${family}`;
  const ls = v.letterSpacing.value ? (v.letterSpacing.unit === 'PIXELS' ? `${n(v.letterSpacing.value)}px` : `${n(v.letterSpacing.value / 100)}em`) : null;
  // Letter spacing is not part of font — it goes as a second value (the “-letter-spacing” property).
  return ls ? [font, ls] : [font];
}
