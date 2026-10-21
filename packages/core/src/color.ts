// Color as in CSS Color 4: perceptual OKLab and OKLCH (Björn Ottosson), CSS parsing and serialization.
// The model stores sRGB; OKLCH is a way of input and display: equal L steps look
// equally light at any hue — palettes and themes are built on this.

import type { RGBA } from './types.ts';

/** OKLCH: lightness 0…1, chroma 0…~0.4, hue in degrees 0…360. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Linear sRGB → OKLab. */
export function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab → linear sRGB (out of gamut — channels below 0 or above 1). */
export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** sRGB (0…1) → OKLCH. Gray has no hue — h = 0. */
export function rgbToOklch(c: { r: number; g: number; b: number }): Oklch {
  const [L, a, b] = linearToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b));
  const ch = Math.hypot(a, b);
  const h = ch < 1e-4 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
  return { l: L, c: ch, h: ch < 1e-4 ? 0 : (h + 360) % 360 };
}

const linearOf = (l: number, c: number, h: number) => {
  const r = (h * Math.PI) / 180;
  return oklabToLinear(l, c * Math.cos(r), c * Math.sin(r));
};

/** The OKLCH color fits in sRGB. */
export function inSrgb(l: number, c: number, h: number, eps = 1e-4): boolean {
  return linearOf(l, c, h).every((v) => v >= -eps && v <= 1 + eps);
}

/** The largest chroma at lightness l and hue h that still fits in sRGB. */
export function maxChroma(l: number, h: number): number {
  if (l <= 0 || l >= 1) return 0;
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inSrgb(l, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * OKLCH → sRGB. Outside the sRGB gamut chroma is reduced at the same lightness and hue
 * (gamut mapping from CSS Color 4 — without the hue shift that plain channel clipping causes).
 */
export function oklchToRgb(l: number, c: number, h: number, a = 1): RGBA {
  const L = clamp01(l);
  const C = Math.max(0, c);
  const ch = inSrgb(L, C, h) ? C : Math.min(C, maxChroma(L, h));
  const [r, g, b] = linearOf(L, ch, h).map((v) => clamp01(fromLinear(clamp01(v))));
  return { r: r!, g: g!, b: b!, a };
}

const trim = (v: number, digits: number) => String(+v.toFixed(digits));

/** CSS serialization: “oklch(62.8% 0.258 29.2)”, with transparency — “… / 0.5”. */
export function formatOklch(c: RGBA | { r: number; g: number; b: number; a?: number }): string {
  const o = rgbToOklch(c);
  const a = c.a ?? 1;
  return `oklch(${trim(o.l * 100, 1)}% ${trim(o.c, 3)} ${trim(o.h, 1)}${a < 1 ? ` / ${trim(a, 2)}` : ''})`;
}

/** CSS number: “50%” → fraction of full, “0.5” as is, “none” — 0. */
function cssNumber(s: string, full: number): number {
  const t = s.trim().toLowerCase();
  if (t === 'none') return 0;
  if (t.endsWith('%')) return (parseFloat(t) / 100) * full;
  if (t.endsWith('deg')) return parseFloat(t);
  if (t.endsWith('turn')) return parseFloat(t) * 360;
  if (t.endsWith('rad')) return (parseFloat(t) * 180) / Math.PI;
  return parseFloat(t);
}

/** CSS function parts: “oklch(70% 0.1 200 / 50%)” → ['70%', '0.1', '200'], alpha '50%'. */
function fnArgs(s: string, name: RegExp): { args: string[]; alpha: string | null } | null {
  const m = name.exec(s);
  if (!m) return null;
  const body = m[1]!.trim();
  const [main, alpha] = body.split('/');
  const args = main!.split(/[\s,]+/).filter(Boolean);
  return { args, alpha: alpha?.trim() ?? (args.length === 4 ? args.pop()! : null) };
}

const alphaOf = (s: string | null) => (s === null ? 1 : clamp01(cssNumber(s, 1)));

/**
 * Color from CSS notation: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla(), oklch(),
 * oklab(). The hash sign for hex is optional. Not parsed — null.
 */
export function parseCssColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  let f = fnArgs(s, /^oklch\(([^)]*)\)$/);
  if (f && f.args.length === 3) {
    const [l, c, h] = f.args;
    return oklchToRgb(cssNumber(l!, 1), cssNumber(c!, 0.4), cssNumber(h!, 360), alphaOf(f.alpha));
  }
  f = fnArgs(s, /^oklab\(([^)]*)\)$/);
  if (f && f.args.length === 3) {
    const [l, a, b] = f.args;
    const L = cssNumber(l!, 1);
    const A = cssNumber(a!, 0.4);
    const B = cssNumber(b!, 0.4);
    const o = { l: L, c: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI };
    return oklchToRgb(o.l, o.c, o.h, alphaOf(f.alpha));
  }
  f = fnArgs(s, /^rgba?\(([^)]*)\)$/);
  if (f && f.args.length === 3) {
    const [r, g, b] = f.args.map((x) => clamp01(cssNumber(x, 255) / 255));
    return { r: r!, g: g!, b: b!, a: alphaOf(f.alpha) };
  }
  f = fnArgs(s, /^hsla?\(([^)]*)\)$/);
  if (f && f.args.length === 3) {
    const h = (((cssNumber(f.args[0]!, 360) % 360) + 360) % 360) / 60;
    const sat = clamp01(cssNumber(f.args[1]!, 1));
    const l = clamp01(cssNumber(f.args[2]!, 1));
    const c = (1 - Math.abs(2 * l - 1)) * sat;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    return { r: r + m, g: g + m, b: b + m, a: alphaOf(f.alpha) };
  }
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

/** Color from DTCG components in color space space (srgb, srgb-linear, oklch, oklab); otherwise null. */
export function colorFromSpace(space: string, comps: number[], alpha = 1): RGBA | null {
  const [x = 0, y = 0, z = 0] = comps;
  switch (space) {
    case 'srgb':
      return { r: x, g: y, b: z, a: alpha };
    case 'srgb-linear':
      return { r: clamp01(fromLinear(clamp01(x))), g: clamp01(fromLinear(clamp01(y))), b: clamp01(fromLinear(clamp01(z))), a: alpha };
    case 'oklch':
      return oklchToRgb(x, y, z, alpha);
    case 'oklab':
      return oklchToRgb(x, Math.hypot(y, z), (Math.atan2(z, y) * 180) / Math.PI, alpha);
    default:
      return null;
  }
}
