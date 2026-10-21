import { describe, expect, it } from 'vitest';
import { Document, multiply, type Matrix } from '@mfp/core';
import { align, distribute } from '../src/arrange.ts';
import { labeledLayers, setLabel } from '../src/layer-labels.ts';
import type { Editor } from '../src/editor.ts';

/** Stub editor: only what arrangement needs (layers on a page without rotation). */
function scene() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const make = (x: number, y: number, w: number, h: number) => doc.create('RECTANGLE', page, { width: w, height: h, transform: [1, 0, x, 0, 1, y] });
  const a = make(0, 0, 40, 20);
  const b = make(100, 50, 60, 60);
  const c = make(300, 200, 20, 10);
  const world = (id: string): Matrix => {
    const chain: Matrix[] = [];
    for (let cur: string | null = id; cur && cur !== page; cur = doc.parent(cur)) chain.unshift(doc.get(cur, 'transform') as Matrix);
    return chain.reduce((m, t) => multiply(m, t), [1, 0, 0, 0, 1, 0] as Matrix);
  };
  const corners = (id: string) => {
    const m = world(id);
    const w = doc.get(id, 'width') ?? 0;
    const h = doc.get(id, 'height') ?? 0;
    return ([[0, 0], [w, 0], [w, h], [0, h]] as const).map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]] as [number, number]);
  };
  const ed = {
    doc,
    pageId: page,
    keyObject: null as string | null,
    worldMatrix: world,
    corners,
    selectionBounds: (ids: string[]) => {
      const pts = ids.flatMap(corners);
      return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    },
  };
  const pos = (id: string) => [doc.get(id, 'transform')![2], doc.get(id, 'transform')![5]];
  return { ed: ed as unknown as Editor & { keyObject: string | null }, doc, page, a, b, c, pos };
}

describe('align to key object (MFP-specific)', () => {
  it('without a key — to the common bounds; with a key — to it, the key stays in place', () => {
    const s = scene();
    align(s.ed, [s.a, s.b, s.c], 'left');
    expect([s.pos(s.a)[0], s.pos(s.b)[0], s.pos(s.c)[0]]).toEqual([0, 0, 0]);
    const t = scene();
    t.ed.keyObject = t.b;
    align(t.ed, [t.a, t.b, t.c], 'right');
    // B's right edge is 160: A (40) goes to 120, C (20) — to 140.
    expect([t.pos(t.a)[0], t.pos(t.b)[0], t.pos(t.c)[0]]).toEqual([120, 100, 140]);
    align(t.ed, [t.a, t.b, t.c], 'vcenter');
    expect([t.pos(t.a)[1], t.pos(t.b)[1], t.pos(t.c)[1]]).toEqual([70, 50, 75]);
  });

  it('spacing from the key: specified and the current average; two layers are enough', () => {
    const s = scene();
    s.ed.keyObject = s.b;
    distribute(s.ed, [s.a, s.b, s.c], 'x', 8);
    // B stays (100..160): A on the left by 8 (52..92), C on the right by 8 (168..188).
    expect([s.pos(s.a)[0], s.pos(s.b)[0], s.pos(s.c)[0]]).toEqual([52, 100, 168]);
    const t = scene();
    t.ed.keyObject = t.a;
    distribute(t.ed, [t.a, t.c], 'y');
    // A single gap (200 − 20 = 180) — and that is what remains.
    expect(t.pos(t.c)[1]).toBe(200);
    distribute(t.ed, [t.a, t.c], 'y', 0);
    expect(t.pos(t.c)[1]).toBe(20);
  });
});

describe('layer tags (MFP-specific)', () => {
  it('set and removed in one undo step; selecting page layers by tag', () => {
    const s = scene();
    setLabel(s.doc, [s.a, s.c], 'RED');
    setLabel(s.doc, [s.b], 'BLUE');
    expect(labeledLayers(s.doc, s.page, 'RED')).toEqual([s.a, s.c]);
    setLabel(s.doc, [s.a, s.c], null);
    expect(labeledLayers(s.doc, s.page, 'RED')).toEqual([]);
    s.doc.undo();
    expect(labeledLayers(s.doc, s.page, 'RED')).toEqual([s.a, s.c]);
  });
});
