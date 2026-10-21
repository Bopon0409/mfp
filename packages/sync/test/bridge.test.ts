import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { LoroBridge } from '../src/index.ts';

/** Canonical tree representation: no internal fractional indices, only order and properties. */
function canonical(doc: Document) {
  const walk = (id: string): unknown => {
    const rec = doc.node(id)!;
    return { id, type: rec.type, props: rec.props, children: doc.children(id).map(walk) };
  };
  return walk(doc.root);
}

function sync(a: LoroBridge, b: LoroBridge) {
  const va = a.loro.oplogVersion();
  const vb = b.loro.oplogVersion();
  const toB = a.loro.export({ mode: 'update', from: vb });
  const toA = b.loro.export({ mode: 'update', from: va });
  b.importUpdate(toB);
  a.importUpdate(toA);
}

describe('LoroBridge', () => {
  it('transfers the document to another client and merges concurrent edits', () => {
    const docA = new Document({ clientId: 1 });
    const bridgeA = new LoroBridge(docA, { peer: 1 });
    const page = docA.create('PAGE', docA.root, { name: 'Page 1' });
    const frame = docA.create('FRAME', page, { name: 'Card', width: 300, height: 200 });
    const r1 = docA.create('RECTANGLE', page, { name: 'R1' });
    const r2 = docA.create('RECTANGLE', page, { name: 'R2' });
    const r3 = docA.create('ELLIPSE', page, { name: 'R3' });

    // The second client receives the document only via Loro.
    const docB = new Document({ clientId: 2 });
    const bridgeB = new LoroBridge(docB, { peer: 2 });
    bridgeB.importUpdate(bridgeA.exportUpdate());
    expect(canonical(docB)).toEqual(canonical(docA));

    // Concurrently, without a connection:
    docA.transact(() => {
      docA.set(r1, { name: 'Renamed by A' });
      docA.move(r2, frame);
      docA.create('TEXT', frame, { name: 'Title', characters: 'Hi' });
    });
    docB.transact(() => {
      docB.set(r1, { opacity: 0.5 });
      docB.delete(r3);
      docB.create('STAR', page, { name: 'Star from B' });
    });
    sync(bridgeA, bridgeB);

    expect(canonical(docA)).toEqual(canonical(docB));
    expect(docA.get(r1, 'name')).toBe('Renamed by A');
    expect(docA.get(r1, 'opacity')).toBe(0.5);
    expect(docA.has(r3)).toBe(false);
    expect(docA.children(frame).map((id) => docA.get(id, 'name'))).toEqual(['R2', 'Title']);
  });

  it('concurrent moves into a cycle do not break the tree', () => {
    const docA = new Document({ clientId: 1 });
    const bridgeA = new LoroBridge(docA, { peer: 1 });
    const page = docA.create('PAGE', docA.root);
    const f1 = docA.create('FRAME', page, { name: 'F1' });
    const f2 = docA.create('FRAME', page, { name: 'F2' });
    const docB = new Document({ clientId: 2 });
    const bridgeB = new LoroBridge(docB, { peer: 2 });
    bridgeB.importUpdate(bridgeA.exportUpdate());

    docA.move(f1, f2); // A: F1 inside F2
    docB.move(f2, f1); // B: F2 inside F1 — together this would be a cycle
    sync(bridgeA, bridgeB);

    expect(canonical(docA)).toEqual(canonical(docB));
    const cycle = docA.parent(f1) === f2 && docA.parent(f2) === f1;
    expect(cycle).toBe(false);
  });
});

describe('Loro bridge: geometry and deleted properties', () => {
  it('the geometry table and undefined reach the other participant', () => {
    const a = new Document({ clientId: 1 });
    const page = a.create('PAGE', a.root, { name: 'P' });
    const key = a.putBlob('M0 0L10 0L10 10Z');
    const v = a.create('VECTOR', page, { vectorPaths: [{ windingRule: 'NONZERO', blob: key }], textGlyphs: undefined });
    const ba = new LoroBridge(a, { peer: 1 });
    const b = new Document({ clientId: 2 });
    const bb = new LoroBridge(b, { peer: 2 });
    bb.importUpdate(ba.exportUpdate());
    expect(b.blob(key)).toBe('M0 0L10 0L10 10Z');
    expect(b.get(v, 'vectorPaths')).toEqual([{ windingRule: 'NONZERO', blob: key }]);
    // An edit with undefined (remove glyphs) — the property disappears for the other participant.
    a.set(v, { name: 'Кривая' });
    a.set(v, { name: undefined });
    bb.importUpdate(ba.exportUpdate());
    expect(b.get(v, 'name')).toBe('Vector');
  });
});

describe('Loro bridge: document properties', () => {
  it('root properties (team libraries, annotation categories) reach the other participant', () => {
    const a = new Document({ clientId: 1 });
    a.create('PAGE', a.root, { name: 'P' });
    a.set(a.root, { teamLibraries: { F1: { name: 'UI Kit', version: 1 } } });
    const ba = new LoroBridge(a, { peer: 1 });
    const b = new Document({ clientId: 2 });
    const bb = new LoroBridge(b, { peer: 2 });
    bb.importUpdate(ba.exportUpdate());
    expect(b.get(b.root, 'teamLibraries')).toEqual({ F1: { name: 'UI Kit', version: 1 } });
    a.transact(() => a.set(a.root, { teamLibraries: { F1: { name: 'UI Kit', version: 2 } } }));
    bb.importUpdate(ba.exportUpdate());
    expect(b.get(b.root, 'teamLibraries')).toEqual({ F1: { name: 'UI Kit', version: 2 } });
  });
});
