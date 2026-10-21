import { describe, expect, it } from 'vitest';
import { Document, animatedProps, animatedValue, lottieFillColor, lottieTransform, lottieValueAt, type LottieProp, type LottieTransform, type Matrix } from '@mfp/core';

const FR = 60;

function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { width: 400, height: 300 });
  const box = doc.create('RECTANGLE', frame, { width: 100, height: 50, transform: [1, 0, 20, 0, 1, 40] });
  return { doc, frame, box };
}

const val = (p: LottieProp, frame: number) => lottieValueAt(p, frame);

/** Lottie layer matrix: T(p) · R(r) · S(s) · T(−a), rotation r is clockwise (screen, y down). */
function lottieMatrix(ks: LottieTransform, frame: number): Matrix {
  const [ax, ay] = val(ks.a, frame) as [number, number];
  const p = 's' in ks.p ? [val(ks.p.x, frame)[0]!, val(ks.p.y, frame)[0]!] : val(ks.p, frame);
  const r = (val(ks.r, frame)[0]! * Math.PI) / 180;
  const [sx, sy] = val(ks.s, frame).map((v) => v / 100) as [number, number];
  const c = Math.cos(r);
  const s = Math.sin(r);
  // R·S = [c·sx, −s·sy; s·sx, c·sy]
  const a = c * sx;
  const b = -s * sy;
  const d = s * sx;
  const e = c * sy;
  return [a, b, p[0]! - (a * ax + b * ay), d, e, p[1]! - (d * ax + e * ay)];
}

describe('Lottie: layer position from tracks', () => {
  it('one track — its keys and curve; values match the pose', () => {
    const { doc, box } = setup();
    doc.set(box, { animation: [{ property: 'x', keys: [{ t: 0.5, value: 20 }, { t: 1.5, value: 220 }] }] });
    const ks = lottieTransform(doc, box, FR);
    expect('s' in ks.p && ks.p.x.a).toBe(1);
    for (const t of [0, 0.5, 0.7, 1, 1.3, 1.5, 2]) {
      const m = lottieMatrix(ks, t * FR);
      animatedProps(doc, box, t)!.transform!.forEach((v, i) => expect(m[i]).toBeCloseTo(v, 4));
    }
  });

  it('rotation, scale, width and x together (position per frame) — the same matrix as the pose', () => {
    const { doc, box } = setup();
    doc.set(box, {
      animation: [
        { property: 'x', keys: [{ t: 0, value: 20 }, { t: 1, value: 120, easing: { type: 'LINEAR' } }, { t: 2, value: 60 }] },
        { property: 'width', keys: [{ t: 0.5, value: 100, easing: { type: 'EASE_OUT' } }, { t: 1.5, value: 180 }] },
        { property: 'rotation', keys: [{ t: 0, value: 0, easing: { type: 'EASE_IN_AND_OUT_BACK' } }, { t: 2, value: 135 }] },
        { property: 'scale', keys: [{ t: 0, value: 1 }, { t: 1, value: 0.5 }] },
      ],
    });
    const ks = lottieTransform(doc, box, FR);
    for (const t of [0, 0.25, 0.5, 0.8, 1, 1.25, 1.6, 2, 2.5]) {
      const m = lottieMatrix(ks, t * FR);
      animatedProps(doc, box, t)!.transform!.forEach((v, i) => expect(m[i]).toBeCloseTo(v, 1));
    }
  });

  it('without position tracks — matrix decomposition (with reflection)', () => {
    const { doc, box } = setup();
    const a = (30 * Math.PI) / 180;
    // Rotation by 30° and a horizontal flip.
    const m: Matrix = [-Math.cos(a), -Math.sin(a), 50, -Math.sin(a), Math.cos(a), 70];
    doc.set(box, { transform: m, animation: [{ property: 'opacity', keys: [{ t: 0, value: 1 }, { t: 1, value: 0 }] }] });
    const ks = lottieTransform(doc, box, FR);
    lottieMatrix(ks, 0).forEach((v, i) => expect(v).toBeCloseTo(m[i]!, 6));
    expect(val(ks.o, 0)[0]).toBeCloseTo(100, 6);
    expect(val(ks.o, 0.5 * FR)[0]).toBeCloseTo(50, 1);
  });

  it('spring — per frame: values at the frames match', () => {
    const { doc, box } = setup();
    doc.set(box, { animation: [{ property: 'y', keys: [{ t: 0, value: 40, easing: { type: 'BOUNCY' } }, { t: 1, value: 200 }] }] });
    const ks = lottieTransform(doc, box, FR);
    const py = 's' in ks.p ? ks.p.y : null;
    expect(py?.a === 1 && py.k.length).toBeGreaterThan(30);
    for (const t of [0.1, 0.25, 0.5, 0.75]) expect(val(py!, t * FR)[0]).toBeCloseTo((animatedValue(doc, box, 'y', t) as number) + 25, 3);
  });

  it('fill color and its opacity — via the color track', () => {
    const { doc, box } = setup();
    doc.set(box, { animation: [{ property: 'fill', keys: [{ t: 0, value: { r: 1, g: 0, b: 0, a: 1 }, easing: { type: 'LINEAR' } }, { t: 1, value: { r: 0, g: 0, b: 1, a: 0.5 } }] }] });
    const f = lottieFillColor(doc, box, FR, { r: 0, g: 0, b: 0, a: 1 }, 1);
    expect(val(f.c, 30)).toEqual([0.5, 0, 0.5, 1]);
    expect(val(f.o, 30)[0]).toBeCloseTo(75, 6);
  });
});
