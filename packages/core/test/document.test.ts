import { describe, expect, it } from 'vitest';
import { Document, rotationOf, withRotation } from '../src/index.ts';
import type { Op } from '../src/index.ts';

it('asynchronous restore preserves blobs, pattern references and snapshot exactly', async () => {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const source = doc.create('RECTANGLE', page);
  const blob = doc.putBlob('M0 0L10 0L0 10Z');
  for (let i=0;i<2500;i++) doc.create('VECTOR', page, { name: `Layer ${i}`, vectorPaths: [{ windingRule: 'NONZERO', blob }] });
  const snapshot = doc.snapshot();
  const restored = await Document.fromSnapshotAsync(snapshot, 2);
  expect(restored.snapshot()).toEqual(Document.fromSnapshot(snapshot, 2).snapshot());
  expect(restored.patternSourceNode(source)).toBe(source);
  expect(restored.canUndo).toBe(false);
});

describe('baked import paths', () => {
  it('a stroke edit resets the baked stroke on shapes and vectors with centerlines', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const rect = doc.create('RECTANGLE', page, { strokePaths: [{ windingRule: 'NONZERO', data: 'M 0 0 L 1 0 L 1 1 Z' }] });
    const vec = doc.create('VECTOR', page, { strokePaths: [{ windingRule: 'NONZERO', data: 'M 0 0 L 1 1 Z' }], centerPaths: [{ windingRule: 'NONZERO', data: 'M 0 0 L 1 1' }] });
    const bare = doc.create('VECTOR', page, { strokePaths: [{ windingRule: 'NONZERO', data: 'M 0 0 L 1 1 Z' }] });
    doc.set(rect, { strokeTopWeight: 4 });
    doc.set(vec, { strokeEndCap: 'ARROW_LINES' });
    doc.set(bare, { strokeWeight: 3 });
    expect(doc.get(rect, 'strokePaths')).toBeUndefined();
    expect(doc.get(vec, 'strokePaths')).toBeUndefined();
    // Without center lines and a path there is nothing to build from — the prepared stroke stays.
    expect(doc.get(bare, 'strokePaths')).toBeDefined();
  });

  it('stroke color does not touch the baked path', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const rect = doc.create('RECTANGLE', page, { strokePaths: [{ windingRule: 'NONZERO', data: 'M 0 0 L 1 0 L 1 1 Z' }] });
    doc.set(rect, { strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] });
    expect(doc.get(rect, 'strokePaths')).toBeDefined();
  });
});

describe('Document', () => {
  it('creates nodes with default values and keeps layer order', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Page 1' });
    const a = doc.create('RECTANGLE', page, { name: 'A' });
    const b = doc.create('ELLIPSE', page, { name: 'B' });
    const c = doc.create('FRAME', page, { name: 'C' }, 0); // inserting at the start — the bottommost layer
    expect(doc.children(page)).toEqual([c, a, b]);
    expect(doc.get(a, 'fills')).toEqual([{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }]);
    expect(doc.get(c, 'clipsContent')).toBe(true);
    expect(doc.get(a, 'name')).toBe('A');
  });

  it('moves nodes, prevents cycles and deletes subtrees', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const frame = doc.create('FRAME', page);
    const inner = doc.create('FRAME', frame);
    const rect = doc.create('RECTANGLE', inner);
    expect(() => doc.move(frame, inner)).toThrow();
    doc.move(rect, page, 0);
    expect(doc.children(page)).toEqual([rect, frame]);
    expect(doc.parent(rect)).toBe(page);
    doc.delete(frame);
    expect(doc.has(frame)).toBe(false);
    expect(doc.has(inner)).toBe(false);
    expect(doc.children(page)).toEqual([rect]);
    expect(() => doc.create('RECTANGLE', rect)).toThrow(); // a rectangle has no children
  });

  it('batches operations into transactions and replays them on a copy', () => {
    const source = new Document({ clientId: 1 });
    const replica = Document.fromSnapshot(source.snapshot(), 2);
    const batches: Op[][] = [];
    source.onChange((ops) => {
      batches.push(ops);
      replica.apply(ops);
    });
    source.transact(() => {
      const page = source.create('PAGE', source.root);
      const r = source.create('RECTANGLE', page, { width: 50 });
      source.set(r, { name: 'Renamed', opacity: 0.5 });
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((o) => o.op)).toEqual(['create', 'create', 'set']);
    expect(replica.snapshot()).toEqual(source.snapshot());
  });

  it('new ids of a copy do not collide with existing ones', () => {
    const a = new Document({ clientId: 7 });
    const page = a.create('PAGE', a.root);
    a.create('RECTANGLE', page);
    const b = Document.fromSnapshot(a.snapshot(), 7);
    const id = b.create('RECTANGLE', page);
    expect(a.has(id)).toBe(false);
  });

  it('rotation matches the plugin API convention', () => {
    const m = withRotation([1, 0, 10, 0, 1, 20], 30);
    expect(rotationOf(m)).toBeCloseTo(30);
    expect(m[2]).toBe(10);
    // Plugin API: [[cos, sin, x], [-sin, cos, y]]
    expect(m[1]).toBeCloseTo(Math.sin(Math.PI / 6));
    expect(m[3]).toBeCloseTo(-Math.sin(Math.PI / 6));
  });
});

describe('size of baked geometry', () => {
  it('the first resize of a node with baked paths remembers the original size', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 50, vectorPaths: [{ windingRule: 'NONZERO', data: 'M0 0L100 0L100 50L0 50Z' }] });
    doc.set(r, { width: 200 });
    expect(doc.get(r, 'geometrySize')).toEqual({ width: 100, height: 50 });
    doc.set(r, { width: 300 });
    expect(doc.get(r, 'geometrySize')).toEqual({ width: 100, height: 50 });
    doc.undo();
    doc.undo();
    expect(doc.get(r, 'geometrySize')).toBeUndefined();
    expect(doc.get(r, 'width')).toBe(100);
  });

  it('text on a path: the path stretches with the frame — the original size is remembered', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const t = doc.create('TEXT', page, { characters: 'а', width: 100, height: 50, textAutoResize: 'NONE', textPath: { data: 'M0 50L100 0', offset: 5 } });
    doc.set(t, { width: 200, height: 100 });
    expect(doc.get(t, 'geometrySize')).toEqual({ width: 100, height: 50 });
  });

  it('stroke width points are a stroke edit: the baked import stroke is reset', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const v = doc.create('VECTOR', page, { width: 100, height: 10, strokePaths: [{ windingRule: 'NONZERO', data: 'M0 0L100 0L100 2L0 2Z' }], centerPaths: [{ windingRule: 'NONZERO', data: 'M0 1L100 1' }] });
    doc.set(v, { variableWidthPoints: [{ position: 0.5, ascent: 4, descent: 4 }] });
    expect(doc.get(v, 'strokePaths')).toBeUndefined();
  });

  it('own shapes do not record a geometry size', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 50 });
    doc.set(r, { width: 200 });
    expect(doc.get(r, 'geometrySize')).toBeUndefined();
  });
});

describe('preview (hovering a menu item)', () => {
  it('changes are visible, no undo step, rollback restores the previous state; source — preview', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 50 });
    doc.set(r, { width: 120 });
    const origins: string[] = [];
    doc.onChange((_ops, origin) => origins.push(origin));
    const revert = doc.preview(() => doc.set(r, { width: 300, height: 10 }));
    expect(doc.get(r, 'width')).toBe(300);
    revert();
    expect(doc.get(r, 'width')).toBe(120);
    expect(doc.get(r, 'height')).toBe(50);
    expect(origins).toEqual(['preview', 'preview']);
    // Undo goes to the previous step (width 120 → 100); the preview did not stay in history.
    doc.undo();
    expect(doc.get(r, 'width')).toBe(100);
    // A repeated rollback does nothing.
    revert();
    expect(doc.get(r, 'width')).toBe(100);
  });
});

describe('preview and derived edits', () => {
  it('layout in response to a preview rolls back with it and does not enter history', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const a = doc.create('RECTANGLE', page, { width: 10, height: 10 });
    const b = doc.create('RECTANGLE', page, { width: 20, height: 20 });
    // “Layout”: the width of b follows the width of a.
    doc.onChange((ops, origin) => {
      if (origin === 'layout' || !ops.some((o) => o.op === 'set' && o.id === a)) return;
      doc.transact(() => doc.set(b, { width: (doc.get(a, 'width') ?? 0) * 2 }), 'layout');
    });
    const undoBefore = (doc as unknown as { undoStack: unknown[] }).undoStack.length;
    const revert = doc.preview(() => doc.set(a, { width: 50 }));
    expect(doc.get(b, 'width')).toBe(100);
    revert();
    expect(doc.get(a, 'width')).toBe(10);
    expect(doc.get(b, 'width')).toBe(20);
    expect((doc as unknown as { undoStack: unknown[] }).undoStack.length).toBe(undoBefore);
  });
});

describe('real edits during a preview', () => {
  it('rollback does not touch them, undo restores the value from before the preview, redo — the edit', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 50, opacity: 1 });
    doc.clearHistory();
    // Pose (as from the timeline): width 300 and opacity 0.5.
    const revert = doc.preview(() => doc.set(r, { width: 300, opacity: 0.5 }));
    // The user changes the displayed width.
    doc.set(r, { width: 320 });
    revert();
    expect(doc.get(r, 'width')).toBe(320);
    expect(doc.get(r, 'opacity')).toBe(1);
    doc.undo();
    expect(doc.get(r, 'width')).toBe(100);
    doc.redo();
    expect(doc.get(r, 'width')).toBe(320);
  });

  it('undo during a preview is real too: rollback does not override it', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 50 });
    doc.clearHistory();
    doc.set(r, { width: 150 });
    const revert = doc.preview(() => doc.set(r, { width: 300 }));
    doc.undo();
    revert();
    expect(doc.get(r, 'width')).toBe(100);
    doc.redo();
    expect(doc.get(r, 'width')).toBe(150);
  });

  it('deleting a layer during a preview: undo restores the layer without the pose', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 50 });
    doc.clearHistory();
    const revert = doc.preview(() => doc.set(r, { width: 300 }));
    doc.delete(r);
    revert();
    expect(doc.has(r)).toBe(false);
    doc.undo();
    expect(doc.get(r, 'width')).toBe(100);
  });

  it('a nested preview inside an open one: no undo step, rolls back together with it', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 50 });
    doc.clearHistory();
    const revert = doc.preview(() => doc.set(r, { width: 300 }));
    const origins: string[] = [];
    doc.onChange((_ops, origin) => origins.push(origin));
    doc.preview(() => doc.set(r, { height: 70 }))();
    expect(doc.get(r, 'height')).toBe(70);
    expect(origins).toEqual(['preview']);
    expect(doc.canUndo).toBe(false);
    revert();
    expect(doc.get(r, 'width')).toBe(100);
    expect(doc.get(r, 'height')).toBe(50);
  });
});

describe('saving during a preview', () => {
  it('snapshot and chunked writes — values from before the preview (and without new keys)', async () => {
    const { SnapshotWriter } = await import('@mfp/core');
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 50 });
    const revert = doc.preview(() => doc.set(r, { width: 300, opacity: 0.5 }));
    const rec = doc.snapshot().nodes.find((n) => n.id === r)!;
    expect(rec.props.width).toBe(100);
    expect('opacity' in rec.props).toBe(false);
    const w = new SnapshotWriter(doc);
    while (!w.step(Infinity));
    const json = JSON.parse(w.chunks.join(''));
    expect(json.nodes.find((n: { id: string }) => n.id === r).props.width).toBe(100);
    // A real edit during preview ends up in the snapshot.
    doc.set(r, { width: 320 });
    expect(doc.snapshot().nodes.find((n) => n.id === r)!.props.width).toBe(320);
    expect(doc.get(r, 'opacity')).toBe(0.5);
    revert();
    expect(doc.snapshot().nodes.find((n) => n.id === r)!.props.width).toBe(320);
  });
});
