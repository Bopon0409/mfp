import { describe, expect, it } from 'vitest';
import { formatOklch, inSrgb, maxChroma, oklchToRgb, parseCssColor, parseDtcgColor, rgbToOklch } from '@mfp/core';

const near = (a: number, b: number, eps = 2e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('OKLCH', () => {
  it('known colors: red, white, black (as in CSS Color 4)', () => {
    const red = rgbToOklch({ r: 1, g: 0, b: 0 });
    near(red.l, 0.6279);
    near(red.c, 0.2577);
    near(red.h, 29.23, 0.05);
    expect(formatOklch({ r: 1, g: 0, b: 0, a: 1 })).toBe('oklch(62.8% 0.258 29.2)');
    const white = rgbToOklch({ r: 1, g: 1, b: 1 });
    near(white.l, 1);
    expect(white.c).toBeLessThan(1e-4);
    expect(rgbToOklch({ r: 0, g: 0, b: 0 }).l).toBeLessThan(1e-6);
  });

  it('round trip — the same color', () => {
    for (const c of [
      { r: 0.2, g: 0.4, b: 0.9 },
      { r: 0.95, g: 0.6, b: 0.1 },
      { r: 0.5, g: 0.5, b: 0.5 },
      { r: 0.02, g: 0.8, b: 0.33 },
    ]) {
      const o = rgbToOklch(c);
      const back = oklchToRgb(o.l, o.c, o.h);
      near(back.r, c.r);
      near(back.g, c.g);
      near(back.b, c.b);
    }
  });

  it('outside sRGB — chroma is reduced, lightness and hue unchanged', () => {
    expect(inSrgb(0.7, 0.4, 150)).toBe(false);
    const c = oklchToRgb(0.7, 0.4, 150);
    const o = rgbToOklch(c);
    near(o.l, 0.7, 3e-3);
    near(o.h, 150, 0.5);
    near(o.c, maxChroma(0.7, 150), 3e-3);
    for (const v of [c.r, c.g, c.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('parsing CSS notations: hex, rgb(), hsl(), oklch(), oklab()', () => {
    expect(parseCssColor('#0f08')).toMatchObject({ r: 0, g: 1, b: 0 });
    near(parseCssColor('#0f08')!.a, 0.533);
    expect(parseCssColor('rgb(255 0 0 / 50%)')).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor('rgba(0, 0, 255, 0.25)')).toEqual({ r: 0, g: 0, b: 1, a: 0.25 });
    const g = parseCssColor('hsl(120 100% 50%)')!;
    near(g.r, 0);
    near(g.g, 1);
    const red = parseCssColor('oklch(62.8% 0.2577 29.23)')!;
    near(red.r, 1, 3e-3);
    near(red.g, 0, 3e-3);
    near(red.b, 0, 3e-3);
    const lab = parseCssColor('oklab(0.628 0.2249 0.1258)')!;
    near(lab.r, 1, 5e-3);
    expect(parseCssColor('oklch(50% 0.1 200 / 0.4)')!.a).toBe(0.4);
    expect(parseCssColor('не цвет')).toBeNull();
  });

  it('DTCG: color in oklch and as an oklch() string', () => {
    const a = parseDtcgColor({ colorSpace: 'oklch', components: [0.6279, 0.2577, 29.23] })!;
    near(a.r, 1, 3e-3);
    const b = parseDtcgColor('oklch(62.8% 0.258 29.2)')!;
    near(b.r, 1, 3e-3);
    const lin = parseDtcgColor({ colorSpace: 'srgb-linear', components: [0.214, 0.214, 0.214] })!;
    near(lin.r, 0.5, 3e-3);
  });
});
