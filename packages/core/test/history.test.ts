import { describe, expect, it } from 'vitest';
import { Document } from '../src/index.ts';

const state = (doc: Document) => JSON.stringify(doc.snapshot());

describe('history (undo and redo)', () => {
  it('undoes and redoes creation, change, move', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const s0 = state(doc);
    const frame = doc.create('FRAME', page, { name: 'F' });
    const rect = doc.create('RECTANGLE', page, { name: 'R' });
    const s1 = state(doc);
    doc.set(rect, { name: 'Renamed', opacity: 0.3 });
    doc.move(rect, frame);
    const s2 = state(doc);

    expect(doc.undo()).toBe(true); // move
    expect(doc.parent(rect)).toBe(page);
    expect(doc.undo()).toBe(true); // set
    expect(state(doc)).toBe(s1);
    doc.undo(); // create rect
    doc.undo(); // create frame
    expect(state(doc)).toBe(s0);

    while (doc.redo());
    expect(state(doc)).toBe(s2);
  });

  it('restores a deleted subtree entirely, with the same ids and order', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const a = doc.create('RECTANGLE', page);
    const frame = doc.create('FRAME', page);
    const inner = doc.create('FRAME', frame);
    doc.create('ELLIPSE', inner, { name: 'deep' });
    doc.create('TEXT', frame, { characters: 'x' });
    const b = doc.create('RECTANGLE', page);
    const before = state(doc);
    doc.delete(frame);
    expect(doc.children(page)).toEqual([a, b]);
    doc.undo();
    expect(state(doc)).toBe(before);
    doc.redo();
    expect(doc.has(frame)).toBe(false);
  });

  it('groups a drag into one undo step', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { transform: [1, 0, 0, 0, 1, 0] });
    doc.beginGroup();
    for (let x = 1; x <= 30; x++) doc.set(r, { transform: [1, 0, x, 0, 1, x] });
    doc.endGroup();
    expect(doc.get(r, 'transform')![2]).toBe(30);
    doc.undo();
    expect(doc.get(r, 'transform')![2]).toBe(0);
    doc.redo();
    expect(doc.get(r, 'transform')![2]).toBe(30);
  });

  it('a new edit clears redo; other clients\' edits do not enter history', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { name: 'A' });
    doc.set(r, { name: 'B' });
    doc.undo();
    expect(doc.canRedo).toBe(true);
    doc.set(r, { name: 'C' });
    expect(doc.canRedo).toBe(false);
    // A change from another client.
    doc.apply([{ op: 'set', id: r, props: { opacity: 0.2 } }], 'remote');
    doc.undo(); // undoes only its own “C”
    expect(doc.get(r, 'name')).toBe('A');
    expect(doc.get(r, 'opacity')).toBe(0.2);
  });

  it('a transaction is one step', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const before = state(doc);
    doc.transact(() => {
      const f = doc.create('FRAME', page);
      doc.create('RECTANGLE', f);
      doc.create('ELLIPSE', f);
    });
    doc.undo();
    expect(state(doc)).toBe(before);
  });
});

describe('groups without a history entry', () => {
  it('endGroup(false) keeps the changes but creates no undo step', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const depth = doc.undoDepth;
    doc.beginGroup();
    const text = doc.create('TEXT', page, { characters: '' });
    doc.beginGroup(); // a nested group (text editor inside creation)
    doc.set(text, { characters: 'x' });
    doc.set(text, { characters: '' });
    doc.endGroup();
    doc.delete(text);
    doc.endGroup(false);
    expect(doc.has(text)).toBe(false);
    expect(doc.undoDepth).toBe(depth);
  });

  it('nested groups yield one step', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const depth = doc.undoDepth;
    doc.beginGroup();
    const t = doc.create('TEXT', page, { characters: '' });
    doc.beginGroup();
    doc.set(t, { characters: 'Привет' });
    doc.endGroup();
    doc.set(t, { name: 'Привет' });
    doc.endGroup();
    expect(doc.undoDepth).toBe(depth + 1);
    doc.undo();
    expect(doc.has(t)).toBe(false);
    doc.redo();
    expect(doc.get(t, 'characters')).toBe('Привет');
  });

  it('changes with origin layout do not enter history', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const t = doc.create('TEXT', page, { characters: 'a' });
    const depth = doc.undoDepth;
    doc.transact(() => doc.set(t, { width: 42 }), 'layout');
    expect(doc.undoDepth).toBe(depth);
    expect(doc.get(t, 'width')).toBe(42);
  });
});

describe('derived edits in an undo step (amend)', () => {
  it('are appended to the last step and roll back with it', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 40 });
    const depth = doc.undoDepth;
    doc.set(r, { layoutAlign: 'STRETCH' });
    doc.amend(() => doc.set(r, { width: 70 }));
    expect(doc.undoDepth).toBe(depth + 1);
    doc.undo();
    expect(doc.get(r, 'layoutAlign')).toBe('INHERIT');
    expect(doc.get(r, 'width')).toBe(40);
    doc.redo();
    expect(doc.get(r, 'width')).toBe(70);
    expect(doc.get(r, 'layoutAlign')).toBe('STRETCH');
  });

  it('inside a group they go into the group', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 10 });
    const depth = doc.undoDepth;
    doc.beginGroup();
    doc.set(r, { width: 20 });
    doc.amend(() => doc.set(r, { height: 5 }));
    doc.endGroup();
    expect(doc.undoDepth).toBe(depth + 1);
    doc.undo();
    expect([doc.get(r, 'width'), doc.get(r, 'height')]).toEqual([10, 100]);
  });
});
