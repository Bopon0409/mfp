import { expect, it } from 'vitest';
import { Document } from '../src/document.ts';
import type { PatternPaint } from '../src/types.ts';
import { resourcesPage, resourceNodes } from '../src/styles.ts';

const paint = (sourceNodeId: string): PatternPaint => ({ type: 'PATTERN', sourceNodeId, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' });
function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const source = doc.create('FRAME', page, { name: 'Motif', width: 10, height: 10 });
  const child = doc.create('RECTANGLE', source, { width: 5, height: 5 });
  const target = doc.create('RECTANGLE', page, { fills: [paint(source)] });
  return { doc, page, source, child, target };
}

it('keeps the latest source subtree, shares its copy across users and undoes atomically', () => {
  const { doc, page, source, child, target } = setup();
  doc.create('RECTANGLE', page, { strokes: [paint(source)] });
  doc.set(child, { width: 7 });
  const before = doc.snapshot(), depth = doc.undoDepth;
  doc.delete(source);
  expect(doc.has(source)).toBe(false);
  const saved = doc.patternSourceNode(source)!;
  expect(doc.get(doc.parent(saved)!, 'internal')).toBe(true);
  expect(doc.get(doc.children(saved)[0]!, 'width')).toBe(7);
  expect((doc.get(target, 'fills')![0] as PatternPaint).sourceNodeId).toBe(source);
  expect(doc.undoDepth).toBe(depth + 1);
  const after = doc.snapshot();
  doc.undo(); expect(doc.snapshot()).toEqual(before);
  expect(doc.patternSourceNode(source)).toBe(source);
  doc.redo(); expect(doc.snapshot()).toEqual(after);
  const loaded = Document.fromSnapshot(after);
  expect(loaded.patternSourceNode(source)).toBe(saved);
});

it('archives dependencies and overlapping sources once when their page is deleted', () => {
  const { doc, page, source, child } = setup();
  const other = doc.create('PAGE', doc.root);
  const nested = doc.create('ELLIPSE', page, { width: 3, height: 3 });
  doc.set(child, { fills: [paint(nested)] });
  doc.create('RECTANGLE', other, { fills: [paint(source), paint(child)] });
  doc.delete(page);
  const saved = doc.patternSourceNode(source)!;
  expect(doc.children(saved)).toEqual([doc.patternSourceNode(child)]);
  expect(doc.type(doc.patternSourceNode(nested)!)).toBe('ELLIPSE');
  expect(doc.children(doc.parent(saved)!)).toHaveLength(2);
});

it('does not archive unused motifs or motifs whose only users are deleted together', () => {
  const { doc, page, source, target } = setup();
  doc.set(target, { fills: [] }); doc.delete(source);
  expect(doc.children(doc.root)).toEqual([page]);
  expect(doc.patternSourceNode(source)).toBeUndefined();
  const next = setup(); next.doc.delete(next.page);
  expect(next.doc.children(next.doc.root)).toEqual([]);
});

it('preserves sources referenced by text ranges and keeps archived masters out of libraries', () => {
  const { doc, page, source, target } = setup();
  doc.set(target, { fills: [] });
  doc.create('TEXT', page, { characters: 'x', textRuns: [{ length: 1, style: { fills: [paint(source)] } }] });
  doc.create('COMPONENT', source, { name: 'Original master' });
  doc.delete(source);
  expect(doc.patternSourceNode(source)).toBeDefined();
  expect(resourceNodes(doc, 'COMPONENT')).toEqual([]);
  expect(resourcesPage(doc)).not.toBe(doc.parent(doc.patternSourceNode(source)!));
});

it('replaying deletion ops in another document yields the same archive, with no extra copies', () => {
  const { doc, source } = setup();
  const peer = Document.fromSnapshot(doc.snapshot(), 2);
  doc.onChange((ops) => peer.apply(ops));
  doc.delete(source);
  expect(peer.snapshot()).toEqual(doc.snapshot());
  doc.undo(); expect(peer.snapshot()).toEqual(doc.snapshot());
  doc.redo(); expect(peer.snapshot()).toEqual(doc.snapshot());
});
