// Animated SVG → timeline: CSS (@keyframes, transform-origin) and SMIL (animateTransform,
// animate, the “line drawing” dash), <style> stylesheet.

import { describe, expect, it } from 'vitest';
import { Document, animatedProps, animatedValue, multiply, type Matrix } from '@mfp/core';
import { importSvgText, pathKit, parseCss, dashTrim } from '../src/index.ts';

function load(svg: string, animate = true) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = importSvgText(doc, svg, { kit: pathKit, parent: page, name: 'svg', origin: [0, 0], animate })!;
  const all = [...doc.descendants(frame)];
  const byName = (name: string) => all.find((id) => doc.get(id, 'name') === name)!;
  return { doc, frame, byName, all };
}

/** World matrix of a layer in the frame at moment t (animation pose of all ancestors). */
function worldAt(doc: Document, frame: string, id: string, t: number): Matrix {
  let m = (animatedProps(doc, id, t)?.transform ?? doc.get(id, 'transform')) as Matrix;
  for (let p = doc.parent(id); p && p !== frame; p = doc.parent(p)) m = multiply((animatedProps(doc, p, t)?.transform ?? doc.get(p, 'transform')) as Matrix, m);
  return m;
}

const center = (doc: Document, frame: string, id: string, t: number) => {
  const m = worldAt(doc, frame, id, t);
  const w = doc.get(id, 'width')!;
  const h = doc.get(id, 'height')!;
  return [m[0] * (w / 2) + m[1] * (h / 2) + m[2], m[3] * (w / 2) + m[4] * (h / 2) + m[5]];
};

describe('animated SVG', () => {
  it('CSS: a spinner rotates around its own center (transform-box: fill-box), one turn in 1 s', () => {
    const { doc, frame, byName } = load(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
      <style>.s { transform-origin: center; transform-box: fill-box; animation: spin 1s linear infinite } @keyframes spin { to { transform: rotate(360deg) } }</style>
      <rect id="bar" class="s" x="40" y="10" width="20" height="20" fill="red"/></svg>`);
    const bar = byName('bar');
    expect(doc.get(frame, 'timeline')).toMatchObject({ duration: 1, playback: 'LOOP' });
    // CSS rotate is clockwise; on the timeline, counterclockwise rotation is negative.
    expect(animatedValue(doc, bar, 'rotation', 0.25)).toBeCloseTo(-90, 0);
    expect(animatedValue(doc, bar, 'rotation', 0.75)).toBeCloseTo(-270, 0);
    const c0 = center(doc, frame, bar, 0);
    const c1 = center(doc, frame, bar, 0.4);
    expect(c1[0]).toBeCloseTo(c0[0]!, 1);
    expect(c1[1]).toBeCloseTo(c0[1]!, 1);
    expect(c0).toEqual([50, 20]);
  });

  it('SMIL: a group rotates around a point (rotate 0 50 50 → 360 50 50) — a point on the circle', () => {
    const { doc, frame, byName } = load(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
      <g id="orbit"><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="2s" repeatCount="indefinite"/>
      <circle id="dot" cx="50" cy="20" r="5" fill="blue"/></g></svg>`);
    const dot = byName('dot');
    expect(doc.type(byName('orbit'))).toBe('FRAME');
    const [x, y] = center(doc, frame, dot, 0.5);
    // Quarter turn clockwise: (50, 20) → (80, 50).
    expect(x).toBeCloseTo(80, 0);
    expect(y).toBeCloseTo(50, 0);
    expect(doc.get(frame, 'timeline')).toMatchObject({ duration: 2, playback: 'LOOP' });
  });

  it('SMIL: a “line drawing” dash via path trimming, the dash removed, played once', () => {
    const { doc, frame, byName } = load(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20" width="100" height="20">
      <path id="line" d="M10 10 L90 10" stroke="black" fill="none" stroke-dasharray="80" stroke-dashoffset="80">
      <animate attributeName="stroke-dashoffset" from="80" to="0" dur="1s" fill="freeze"/></path></svg>`);
    const line = byName('line');
    expect(doc.get(line, 'dashPattern') ?? []).toEqual([]);
    expect(animatedValue(doc, line, 'trimEnd', 0)).toBeCloseTo(0, 2);
    expect(animatedValue(doc, line, 'trimEnd', 0.5)).toBeCloseTo(0.5, 2);
    expect(animatedValue(doc, line, 'trimEnd', 1)).toBeCloseTo(1, 2);
    expect(doc.get(frame, 'timeline')).toMatchObject({ duration: 1, playback: 'ONCE' });
    // The pose at zero is in the layer properties: the line is not visible yet.
    expect(doc.get(line, 'pathTrimEnd')).toBeCloseTo(0, 2);
  });

  it('CSS: opacity pulse back and forth (alternate) — the cycle is twice as long', () => {
    const { doc, frame, byName } = load(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10">
      <style>@keyframes pulse { from { opacity: 0.2 } to { opacity: 1 } } #p { animation: pulse 2s linear infinite alternate }</style>
      <circle id="p" cx="5" cy="5" r="4"/></svg>`);
    const p = byName('p');
    expect(doc.get(frame, 'timeline')?.duration).toBe(4);
    expect(animatedValue(doc, p, 'opacity', 0)).toBeCloseTo(0.2, 2);
    expect(animatedValue(doc, p, 'opacity', 2)).toBeCloseTo(1, 2);
    expect(animatedValue(doc, p, 'opacity', 3)).toBeCloseTo(0.6, 2);
  });

  it('exact keys: an ease-in-out alternate pulse gives three keys with a curve, not per frame', () => {
    const { doc, byName } = load(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10">
      <style>@keyframes pulse { from { opacity: 0.2 } to { opacity: 1 } } #p { animation: pulse 2s ease-in-out infinite alternate }</style>
      <circle id="p" cx="5" cy="5" r="4"/></svg>`);
    const tr = doc.get(byName('p'), 'animation')!.find((t) => t.property === 'opacity')!;
    expect(tr.keys.map((k) => k.t)).toEqual([0, 2, 4]);
    expect(tr.keys[0]!.easing).toEqual({ type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } });
    expect(animatedValue(doc, byName('p'), 'opacity', 1)).toBeCloseTo(0.6, 2);
    expect(animatedValue(doc, byName('p'), 'opacity', 0.5)).toBeLessThan(0.4);
  });

  it('SMIL: fill color values red;blue;red', () => {
    const { doc, byName } = load(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10">
      <rect id="c" width="10" height="10" fill="red"><animate attributeName="fill" values="red;blue;red" dur="2s" repeatCount="indefinite"/></rect></svg>`);
    const mid = animatedValue(doc, byName('c'), 'fill', 1) as { r: number; b: number };
    expect(mid.r).toBeCloseTo(0, 2);
    expect(mid.b).toBeCloseTo(1, 2);
  });

  it('stylesheet: a class sets the color (style="" wins), without animate — no keys', () => {
    const { doc, byName, frame } = load(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10">
      <style><![CDATA[ .a { fill: #00ff00 } svg .b { fill: #0000ff } ]]></style>
      <rect id="one" class="a" width="5" height="5"/><rect id="two" class="a b" x="5" width="5" height="5" style="fill:#ff0000"/>
      <rect id="three" class="b" y="5" width="5" height="5"><animate attributeName="opacity" from="0" to="1" dur="1s"/></rect></svg>`, false);
    expect(doc.get(byName('one'), 'fills')).toEqual([{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }]);
    expect(doc.get(byName('two'), 'fills')).toEqual([{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]);
    expect(doc.get(byName('three'), 'fills')).toEqual([{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }]);
    expect(doc.get(byName('three'), 'animation')).toBeUndefined();
    expect(doc.get(frame, 'timeline')).toBeUndefined();
  });

  it('parsing CSS and dashes', () => {
    const sheet = parseCss('/* x */ @media (min-width: 1px) { .q { fill: red } } @-webkit-keyframes k { 0%, 50% { opacity: 0 } 100% { opacity: 1 } }');
    expect(sheet.rules).toHaveLength(1);
    expect(sheet.keyframes.get('k')!.map((f) => f.offsets)).toEqual([[0, 0.5], [1]]);
    // Dash 100 on a 100-long path: offset 25 shows 0…75 %, −25 shows 25…100 %.
    expect(dashTrim([100], 25, 100)).toEqual([0, 0.75]);
    expect(dashTrim([100], -25, 100)).toEqual([0.25, 1]);
    expect(dashTrim([5, 5], 0, 100)).toBeNull();
  });
});
