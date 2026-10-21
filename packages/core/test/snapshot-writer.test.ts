import { describe, expect, it } from 'vitest';
import { Document, SnapshotWriter, type Snapshot } from '../src/index.ts';

/** Snapshot regardless of node order (it is also read regardless of order). */
const canon = (s: Snapshot) => ({ ...s, nodes: [...s.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)) });

function big(): { doc: Document; page: string; frames: string[] } {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Страница' });
  const frames: string[] = [];
  for (let i = 0; i < 40; i++) {
    const f = doc.create('FRAME', page, { name: `Фрейм ${i}`, width: 100, height: 100 });
    frames.push(f);
    for (let j = 0; j < 30; j++) {
      const props = j % 7 === 0 ? { fills: [{ type: 'IMAGE' as const, imageHash: `h${i % 5}`, scaleMode: 'FILL' as const }] } : { name: `Слой ${j}` };
      doc.create('RECTANGLE', f, props);
    }
  }
  doc.create('VECTOR', page, { vectorPaths: [{ windingRule: 'NONZERO', data: 'M 0 0 L 10 0 L 10 10 Z' }] });
  // Paths in the geometry table — more than one chunk.
  for (let i = 0; i < 1200; i++) doc.create('VECTOR', frames[i % frames.length]!, { vectorPaths: [{ windingRule: 'NONZERO', blob: doc.putBlob(`M 0 0 L ${i} 0 L ${i} ${i} Z`) }] });
  // An unused path does not get into the snapshot.
  doc.putBlob('M 1 1 L 2 2 Z');
  return { doc, page, frames };
}

describe('SnapshotWriter', () => {
  it('without edits — the same snapshot as doc.snapshot(), plus the document\'s images', () => {
    const { doc } = big();
    const w = new SnapshotWriter(doc);
    let steps = 0;
    while (!w.step(-Infinity)) steps++;
    expect(steps).toBeGreaterThan(3); // really in chunks
    const json = w.chunks.join('');
    expect(json.length).toBe(w.length);
    expect(canon(JSON.parse(json) as Snapshot)).toEqual(canon(doc.snapshot()));
    expect([...w.images].sort()).toEqual(['h0', 'h1', 'h2', 'h3', 'h4']);
  });

  it('edits between chunks get into the snapshot: properties, new nodes, nodes moved with their subtree, deleted nodes', () => {
    const { doc, page, frames } = big();
    const w = new SnapshotWriter(doc);
    w.step(-Infinity);
    // Traversal goes from the top: the first frames are already visited, the last ones are not yet.
    doc.set(frames[0]!, { name: 'Переименован' });
    doc.set(frames[39]!, { name: 'Тоже' });
    const fresh = doc.create('FRAME', frames[0]!, { name: 'Новый' });
    doc.create('TEXT', fresh, { name: 'Внутри нового' });
    // A subtree from the unvisited part into the visited one: traversal would have missed it.
    doc.move(frames[38]!, frames[1]!);
    doc.delete(frames[2]!);
    doc.delete(frames[37]!);
    w.step(-Infinity);
    doc.set(frames[20]!, { visible: false });
    while (!w.step(-Infinity));
    expect(canon(JSON.parse(w.chunks.join('')) as Snapshot)).toEqual(canon(doc.snapshot()));
    // The snapshot reads back.
    const back = Document.fromSnapshot(JSON.parse(w.chunks.join('')) as Snapshot);
    expect(back.children(page).length).toBe(doc.children(page).length);
    expect(back.get(fresh, 'name')).toBe('Новый');
  });

  it('stops tracking edits once ready', () => {
    const { doc, frames } = big();
    const w = new SnapshotWriter(doc);
    while (!w.step(Infinity));
    const before = w.chunks.join('');
    doc.set(frames[0]!, { name: 'Позже' });
    expect(w.step(Infinity)).toBe(true);
    expect(w.chunks.join('')).toBe(before);
  });
});

describe('vector centerlines in the snapshot', () => {
  it('centerPaths contours get into the snapshot and SnapshotWriter; dangling references are removed on read', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const center = doc.putBlob('M 0 0 L 50 0');
    const v = doc.create('VECTOR', page, { centerPaths: [{ windingRule: 'NONZERO', blob: center }], strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] });
    const snap = doc.snapshot();
    expect(snap.blobs?.[center]).toBe('M 0 0 L 50 0');
    const w = new SnapshotWriter(doc);
    while (!w.step(Infinity));
    expect((JSON.parse(w.chunks.join('')) as Snapshot).blobs?.[center]).toBe('M 0 0 L 50 0');
    expect(Document.fromSnapshot(snap).get(v, 'centerPaths')?.[0]?.blob).toBe(center);
    // An old save: the reference exists, the path does not.
    const broken = { ...snap, blobs: {} };
    expect(Document.fromSnapshot(broken).get(v, 'centerPaths')).toBeUndefined();
  });
});
