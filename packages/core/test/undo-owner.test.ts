import { expect, it } from 'vitest';
import { Document } from '../src/index.ts';

it('coalesces owned history with derived amendments without swallowing intervening edits', () => {
  const d = new Document({ clientId: 12 }); const p = d.create('PAGE', d.root);
  d.clearHistory(); const owner = {};
  const a = d.withUndoGroup(owner, () => d.create('RECTANGLE', p));
  d.amend(() => d.set(a, { width: 150 }));
  d.withUndoGroup(owner, () => d.set(a, { height: 80 }));
  expect(d.undoDepth).toBe(1);
  const user = d.create('TEXT', p);
  d.withUndoGroup(owner, () => d.set(a, { width: 200 }));
  expect(d.undoDepth).toBe(3);
  d.undo(); expect(d.get(a, 'width')).toBe(150); expect(d.has(user)).toBe(true);
  d.undo(); expect(d.has(user)).toBe(false);
  d.undo(); expect(d.has(a)).toBe(false);
  d.redo(); expect(d.get(a, 'width')).toBe(150); expect(d.get(a, 'height')).toBe(80);
});

it('does not merge into an exposed old group after Undo, Redo, or an exception', () => {
  const d = new Document({ clientId: 12 }); const p = d.create('PAGE', d.root);
  d.clearHistory(); const owner = {};
  d.withUndoGroup(owner, () => d.create('RECTANGLE', p));
  const other = d.create('TEXT', p); d.undo();
  d.withUndoGroup(owner, () => d.create('ELLIPSE', p));
  expect(d.undoDepth).toBe(2); expect(d.canRedo).toBe(false); expect(d.has(other)).toBe(false);
  d.undo(); d.redo();
  d.withUndoGroup(owner, () => d.create('LINE', p)); expect(d.undoDepth).toBe(3);
  expect(() => d.withUndoGroup(owner, () => { throw new Error('test'); })).toThrow('test');
  d.create('FRAME', p); expect(d.undoDepth).toBe(4);
});

it('preserves owned history when a guard rejects Undo', () => {
  const d = new Document({ clientId: 12 }); const p = d.create('PAGE', d.root);
  d.clearHistory(); const owner = {};
  d.withUndoGroup(owner, () => d.create('RECTANGLE', p));
  d.guard = () => 'Denied'; expect(d.undo()).toBe(false); expect(d.undoDepth).toBe(1);
  d.guard = null;
  d.withUndoGroup(owner, () => d.create('ELLIPSE', p));
  expect(d.undoDepth).toBe(1); d.undo(); expect(d.children(p)).toEqual([]);
});

it('separates a plugin action arriving during an open user drag group', () => {
  const d = new Document({ clientId: 12 }); const p = d.create('PAGE', d.root);
  const user = d.create('RECTANGLE', p, { width: 100 }); d.clearHistory();
  d.beginGroup(); d.set(user, { width: 120 });
  const plugin = d.withUndoGroup({}, () => {
    const id = d.create('ELLIPSE', p);
    d.amend(() => d.set(id, { height: 75 }));
    return id;
  });
  d.set(user, { width: 150 }); d.endGroup();
  expect(d.undoDepth).toBe(3);
  d.undo(); expect(d.get(user, 'width')).toBe(120); expect(d.has(plugin)).toBe(true);
  d.undo(); expect(d.has(plugin)).toBe(false); expect(d.get(user, 'width')).toBe(120);
  d.undo(); expect(d.get(user, 'width')).toBe(100);
});
