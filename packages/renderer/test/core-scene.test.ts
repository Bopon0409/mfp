import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { CoreScene, roundedRectPath } from '../src/core-scene.ts';

function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { name: 'Frame', width: 400, height: 300, transform: [1, 0, 100, 0, 1, 100] });
  const rect = doc.create('RECTANGLE', frame, { name: 'Rect', width: 50, height: 50, transform: [1, 0, 10, 0, 1, 10] });
  const scene = new CoreScene(doc, page);
  doc.onChange((ops) => scene.apply(ops));
  return { doc, page, frame, rect, scene };
}

const names = (scene: CoreScene) => {
  const walk = (nodes: { name: string; children: never[] }[]): unknown => nodes.map((n) => (n.children.length ? [n.name, walk(n.children)] : n.name));
  return walk(scene.page.children as never);
};

/** Points on the path (endpoints of move, line, cubic commands) from a PathWriter blob. */
function points(bytes: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length; ) {
    const cmd = bytes[i++]!;
    const n = cmd === 1 || cmd === 2 ? 1 : cmd === 3 ? 2 : cmd === 4 ? 3 : 0;
    for (let k = 0; k < n; k++, i += 8) if (k === n - 1) out.push([dv.getFloat32(i, true), dv.getFloat32(i + 4, true)]);
  }
  return out;
}

describe('smoothed corners', () => {
  it('without smoothing — regular rounding', () => {
    expect(roundedRectPath(100, 80, 20, 0)).toEqual(roundedRectPath(100, 80, 20));
  });

  it('the corner starts at (1 + ξ)·R from the vertex, the arc lies on a circle of radius R', () => {
    const pts = points(roundedRectPath(100, 100, 20, 0.6));
    const xs = pts.filter(([, y]) => Math.abs(y) < 1e-4).map(([x]) => x);
    // Top side: a straight line from 32 to 68 (1.6 · 20 = 32 from each vertex).
    expect(Math.min(...xs)).toBeCloseTo(32, 3);
    expect(Math.max(...xs)).toBeCloseTo(68, 3);
    // Top-right corner: circle center (80; 20); arc endpoints at distance 20.
    const onCircle = pts.filter(([x, y]) => x > 68 && y < 32 && Math.abs(Math.hypot(x - 80, y - 20) - 20) < 1e-3);
    expect(onCircle.length).toBeGreaterThanOrEqual(2);
    // Shape inside the bounds.
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(-1e-4);
      expect(x).toBeLessThanOrEqual(100 + 1e-4);
      expect(y).toBeGreaterThanOrEqual(-1e-4);
      expect(y).toBeLessThanOrEqual(100 + 1e-4);
    }
  });

  it('doesn\'t fit — smoothing is reduced, the corner does not go past the middle of the side', () => {
    const pts = points(roundedRectPath(40, 40, 18, 1));
    const xs = pts.filter(([, y]) => Math.abs(y) < 1e-4).map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(20, 3);
  });
});

describe('CoreScene', () => {
  it('wrapping existing layers reuses their scene nodes without leaving ghost roots', () => {
    const { doc, page, frame, rect, scene } = setup();
    const original = scene.node(frame);
    let wrapper = '';
    doc.transact(() => {
      wrapper = doc.create('FRAME', page, { name: 'Wrapper', width: 400, height: 300, layoutMode: 'HORIZONTAL' });
      doc.move(frame, wrapper);
    });
    expect(scene.node(frame)).toBe(original);
    expect(names(scene)).toEqual([['Wrapper', [['Frame', ['Rect']]]]]);
    expect(scene.parent(scene.node(rect)!)).toBe(scene.node(frame));
    doc.undo();
    expect(names(scene)).toEqual([['Frame', ['Rect']]]);
    doc.redo();
    expect(names(scene)).toEqual([['Wrapper', [['Frame', ['Rect']]]]]);
  });
  it('builds a page mirror and follows document edits', () => {
    const { doc, page, frame, rect, scene } = setup();
    expect(names(scene)).toEqual([['Frame', ['Rect']]]);
    const e = doc.create('ELLIPSE', page, { name: 'Circle' });
    doc.set(rect, { name: 'Renamed', width: 80 });
    expect(scene.node(rect)!.size.x).toBe(80);
    doc.move(rect, page, 0);
    expect(names(scene)).toEqual(['Renamed', 'Frame', 'Circle']);
    doc.delete(frame);
    expect(names(scene)).toEqual(['Renamed', 'Circle']);
    doc.undo(); // frame restore
    expect(names(scene)).toEqual(['Renamed', 'Frame', 'Circle']);
    expect(scene.node(e)!.fillGeometry).toHaveLength(1);
  });

  it('finds the node under a point, respecting nesting and clipping', () => {
    const { doc, frame, rect, scene } = setup();
    const ids = (path: unknown[]) => path.map((n) => scene.id(n as never));
    expect(ids(scene.hitPath(115, 115))).toEqual([frame, rect]); // in the rectangle inside the frame
    expect(ids(scene.hitPath(300, 300))).toEqual([frame]); // frame background
    expect(scene.hitPath(50, 50)).toEqual([]); // miss
    // A child outside a clipping frame is not hit.
    doc.set(rect, { transform: [1, 0, 500, 0, 1, 10] });
    expect(ids(scene.hitPath(615, 115))).toEqual([]);
    doc.set(frame, { clipsContent: false });
    expect(ids(scene.hitPath(615, 115))).toEqual([frame, rect]);
  });

  it('an ellipse catches a click only inside its shape', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const e = doc.create('ELLIPSE', page, { width: 100, height: 100 });
    const scene = new CoreScene(doc, page);
    expect(scene.hitPath(50, 50).map((n) => scene.id(n))).toEqual([e]);
    expect(scene.hitPath(3, 3)).toEqual([]); // bounds corner, outside the circle
  });
});

describe('ellipse arc and star', () => {
  it('sector, ring and partial ring; the sweep is clockwise through 0', async () => {
    const { arcSweep, ellipsePath, polygonPath } = await import('../src/core-scene.ts');
    expect(arcSweep({ startingAngle: Math.PI / 2, endingAngle: -Math.PI / 2 })).toBeCloseTo(Math.PI);
    expect(arcSweep({ startingAngle: 0, endingAngle: Math.PI * 2 })).toBeCloseTo(Math.PI * 2);
    expect(arcSweep({ startingAngle: 1, endingAngle: 1 })).toBeCloseTo(Math.PI * 2);
    // Quarter sector: center, right point, bottom (Y axis down — clockwise).
    const pie = points(ellipsePath(100, 100, { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0 }));
    expect(pie[0]).toEqual([50, 50]);
    expect(pie[1]![0]).toBeCloseTo(100);
    expect(pie[1]![1]).toBeCloseTo(50);
    expect(pie.at(-1)![0]).toBeCloseTo(50);
    expect(pie.at(-1)![1]).toBeCloseTo(100);
    // Midpoint of the quarter arc — on the circle.
    const mid = pie[1]!;
    void mid;
    // Ring: outer and inner contours (4 segments each), inner radius 25.
    const ring = points(ellipsePath(100, 100, { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0.5 }));
    expect(ring.length).toBe(10);
    expect(ring[5]![0]).toBeCloseTo(75);
    // Part of a ring: outer arc, then to the inner one and back.
    const part = points(ellipsePath(100, 100, { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0.5 }));
    expect(part[0]![0]).toBeCloseTo(100);
    expect(part.at(-1)![0]).toBeCloseTo(75);
    expect(part.at(-1)![1]).toBeCloseTo(50);
    // No arc — the plain ellipse.
    expect(ellipsePath(100, 100, { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 })).toEqual(ellipsePath(100, 100));
    // Star: inner vertices at a fraction of the radius.
    const star = points(polygonPath(100, 100, 5, true, 0.5));
    expect(Math.hypot(star[1]![0] - 50, star[1]![1] - 50)).toBeCloseTo(25);
  });

  it('editing the arc of an imported ellipse rebuilds the shape', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const e = doc.create('ELLIPSE', page, { width: 100, height: 100, vectorPaths: [{ windingRule: 'NONZERO', data: 'M0 0L1 1Z' }] });
    doc.set(e, { arcData: { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 } });
    expect(doc.node(e)!.props.vectorPaths).toBeUndefined();
  });
});

describe('incremental scene building (background page preparation)', () => {
  const tree = (nodes: { key: string; children: unknown[] }[]): unknown => nodes.map((n) => [n.key, tree(n.children as { key: string; children: unknown[] }[])]);

  function bigDoc() {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'P' });
    const frames: string[] = [];
    for (let f = 0; f < 12; f++) {
      const fr = doc.create('FRAME', page, { name: `F${f}`, width: 300, height: 300, transform: [1, 0, f * 320, 0, 1, 0] });
      frames.push(fr);
      for (let i = 0; i < 30; i++) {
        const g = doc.create('GROUP', fr, { name: `G${i}`, width: 20, height: 20 });
        doc.create('RECTANGLE', g, { name: `R${i}`, width: 10, height: 10, transform: [1, 0, i, 0, 1, i] });
      }
    }
    return { doc, page, frames };
  }

  it('chunk by chunk gives the same scene as all at once', () => {
    const { doc, page } = bigDoc();
    const full = new CoreScene(doc, page);
    const inc = CoreScene.incremental(doc, page);
    let steps = 0;
    // The deadline has already passed: each step builds the minimum (64 nodes) — many steps.
    while (!inc.buildStep(performance.now() - 1)) steps++;
    expect(steps).toBeGreaterThan(5);
    expect(inc.size).toBe(full.size);
    expect(tree(inc.page.children as never)).toEqual(tree(full.page.children as never));
  });

  it('publishes only fully built root subtrees during progressive loading', () => {
    const { doc, page } = bigDoc();
    const full = new CoreScene(doc, page);
    const inc = CoreScene.incremental(doc, page);
    let done = false;
    while (!done) {
      done = inc.buildStep(performance.now() - 1);
      const count = inc.completedRoots;
      expect(tree(inc.page.children.slice(0, count) as never)).toEqual(tree(full.page.children.slice(0, count) as never));
    }
    expect(inc.completedRoots).toBe(full.page.children.length);
  });

  it('edits to already built parts are rebuilt; unbuilt parts are read from the document as is', () => {
    const { doc, page, frames } = bigDoc();
    const inc = CoreScene.incremental(doc, page);
    inc.buildStep(performance.now() - 1); // first chunk: start of the first frame
    const built = frames[0]!;
    const later = frames[11]!;
    expect(inc.touches([{ op: 'set', id: built, props: { name: 'x' } }])).toBe(true);
    expect(inc.touches([{ op: 'set', id: later, props: { name: 'x' } }])).toBe(false);
    expect(inc.touches([{ op: 'create', id: '9:9', type: 'RECTANGLE', parent: page, index: 'a0', props: {} }])).toBe(true);
    // Unbuilt nodes are edited — the scene will see the edit when it reaches the node.
    doc.set(later, { name: 'Переименован' });
    const kid = doc.children(later)[0]!;
    doc.delete(kid);
    while (!inc.buildStep(performance.now() - 1));
    const full = new CoreScene(doc, page);
    expect(tree(inc.page.children as never)).toEqual(tree(full.page.children as never));
    expect(inc.size).toBe(full.size);
  });
});
