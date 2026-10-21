// TS SVG paths and SVG import without DOM (plugin Worker: createNodeFromSvg).

import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { importSvgText, parsePath, parseXml, pathBounds, pathKit, pathToSvg, transformPath } from '../src/index.ts';

const close = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

describe('SVG paths without Skia', () => {
  it('parses all commands: relative, H/V, S/T, implicit lines after M, concatenated numbers and arc flags', () => {
    const segs = parsePath('m10 10 20 0v10h-5s-5 5-10 0q5-10 10 0t10 0a5 5 0 00 10 0z M1.5.5-1-2e1')!;
    expect(segs.map((s) => s.c).join('')).toBe('MLLLCQQCCZML');
    expect(segs[1]!.v).toEqual([30, 10]); // the implicit line after m is relative too
    expect(segs[3]!.v).toEqual([25, 20]); // h-5
    // S: the first control point is the reflection of the previous one (if none, the current point).
    expect(segs[4]!.v).toEqual([25, 20, 20, 25, 15, 20]);
    // T: the control point is the reflection of the previous quadratic one about the current point.
    expect(segs[6]!.v).toEqual([30, 30, 35, 20]);
    expect(segs.at(-2)!.v).toEqual([1.5, 0.5]);
    expect(segs.at(-1)!.v).toEqual([-1, -20]);
  });

  it('exact bounds: curve and arc extrema; a lone M does not count', () => {
    // Circle r = 10 centered at (50, 50) as two arcs.
    const circle = parsePath('M40 50A10 10 0 1 0 60 50A10 10 0 1 0 40 50Z M500 500')!;
    expect(close(pathBounds(circle), [40, 40, 60, 60], 1e-9)).toBe(true);
    // Cubic bulging upward: bounds follow the curve apex, not the control points.
    const b = pathBounds(parsePath('M0 0C0 -40 100 -40 100 0')!);
    expect(close(b, [0, -30, 100, 0])).toBe(true);
  });

  it('matrix and string serialization', () => {
    const segs = transformPath(parsePath('M0 0L10 0L10 10Z')!, [2, 0, 5, 0, 2, 7]);
    expect(pathToSvg(segs)).toBe('M5 7L25 7L25 27Z');
    expect(pathToSvg(segs, -5, -7)).toBe('M0 0L20 0L20 20Z');
  });
});

describe('SVG import without DOM', () => {
  it('parses XML: comments, DOCTYPE, CDATA, entities, self-closing tags; errors give null', () => {
    const el = parseXml(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><!-- c --><svg id="a&amp;b"><g><![CDATA[ <x> ]]><rect width='1'/></g></svg>`)!;
    expect(el.tagName).toBe('svg');
    expect(el.id).toBe('a&b');
    const g = [...el.children][0]!;
    expect([...g.children].map((c) => c.getAttribute('width'))).toEqual(['1']);
    expect(parseXml('<svg><g></svg>')).toBeNull();
    expect(parseXml('<svg a=1></svg>')).toBeNull();
  });

  it('shapes, a group with a matrix, a gradient, clip-path from two shapes (mask group), use and symbol', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'P' });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50">
      <defs>
        <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="#00f"/></linearGradient>
        <clipPath id="c"><rect width="10" height="10"/><circle cx="30" cy="5" r="5"/></clipPath>
        <symbol id="s"><rect width="4" height="4" fill="green"/></symbol>
      </defs>
      <rect x="10" y="10" width="20" height="10" fill="url(#g)"/>
      <g transform="translate(50 0) scale(2)"><circle cx="5" cy="5" r="5" stroke="black" stroke-width="1" fill="none"/></g>
      <g clip-path="url(#c)"><rect width="40" height="10" fill="#123456"/></g>
      <use href="#s" x="90" y="40"/>
    </svg>`;
    const frame = importSvgText(doc, svg, { kit: pathKit, parent: page, name: 'svg', origin: [0, 0] })!;
    expect(doc.get(frame, 'transform')).toEqual([1, 0, 0, 0, 1, 0]);
    expect([doc.get(frame, 'width'), doc.get(frame, 'height')]).toEqual([200, 100]);
    const kids = doc.children(frame);
    expect(kids.map((k) => doc.type(k))).toEqual(['VECTOR', 'VECTOR', 'GROUP', 'VECTOR']);
    // Rectangle: viewBox 0.5 → scale 2.
    const rect = doc.props(kids[0]!);
    expect([rect.transform![2], rect.transform![5], rect.width, rect.height]).toEqual([20, 20, 40, 20]);
    expect(rect.fills![0]!.type).toBe('GRADIENT_LINEAR');
    // Circle in a group with scale(2) and viewBox ×2: radius 20, stroke 4.
    const circle = doc.props(kids[1]!);
    expect([circle.transform![2], circle.transform![5], circle.width, circle.height]).toEqual([100, 0, 40, 40]);
    expect(circle.strokeWeight).toBe(4);
    expect(circle.fills).toEqual([]);
    // clip-path without path union: a mask group of two shapes.
    const clip = doc.children(kids[2]!);
    expect(clip.map((k) => doc.type(k))).toEqual(['GROUP', 'VECTOR']);
    expect(doc.get(clip[0]!, 'isMask')).toBe(true);
    expect(doc.children(clip[0]!)).toHaveLength(2);
    // <use> of a symbol.
    const used = doc.props(kids[3]!);
    expect([used.transform![2], used.transform![5], used.width]).toEqual([180, 80, 8]);
    expect(used.fills).toEqual([{ type: 'SOLID', color: { r: 0, g: 128 / 255, b: 0 } }]);
  });
});
