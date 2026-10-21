import { describe, expect, it } from 'vitest';
import { Document, canEditPage, pageGuard, type Op } from '@mfp/core';

function setup(who: { id: string | null; owner: boolean }) {
  const doc = new Document({ clientId: 1 });
  const brand = doc.create('PAGE', doc.root, { name: 'Бренд', pageProtection: { editors: ['viktor'] } });
  const drafts = doc.create('PAGE', doc.root, { name: 'Черновики' });
  const a = doc.create('RECTANGLE', brand, { width: 10 });
  const b = doc.create('RECTANGLE', drafts, { width: 10 });
  doc.clearHistory();
  const seen: Op[] = [];
  doc.onChange((ops) => seen.push(...ops));
  const reasons: string[] = [];
  doc.guard = pageGuard(doc, () => who);
  doc.onGuard = (r) => reasons.push(r);
  return { doc, brand, drafts, a, b, seen, reasons };
}

describe('page-level permissions: document safeguard', () => {
  it('keeps rejected undo and redo available after page access is restored', () => {
    const who = { id: 'viktor', owner: false };
    const t = setup(who);
    t.doc.set(t.a, { width: 20 });
    t.seen.length = 0;
    who.id = 'boris';
    expect(t.doc.undo()).toBe(false);
    expect(t.doc.get(t.a, 'width')).toBe(20);
    expect(t.doc.undoDepth).toBe(1);
    expect(t.doc.canRedo).toBe(false);
    expect(t.seen).toEqual([]);
    who.id = 'viktor';
    expect(t.doc.undo()).toBe(true);
    expect(t.doc.get(t.a, 'width')).toBe(10);
    who.id = 'boris';
    t.seen.length = 0;
    expect(t.doc.redo()).toBe(false);
    expect(t.doc.canRedo).toBe(true);
    expect(t.doc.canUndo).toBe(false);
    expect(t.doc.get(t.a, 'width')).toBe(10);
    expect(t.seen).toEqual([]);
    who.id = 'viktor';
    expect(t.doc.redo()).toBe(true);
    expect(t.doc.get(t.a, 'width')).toBe(20);
  });

  it('rejects nested history replay without consuming steps', () => {
    const t = setup({ id: 'viktor', owner: false });
    t.doc.set(t.a, { width: 20 });
    t.doc.transact(() => expect(t.doc.undo()).toBe(false));
    expect(t.doc.undoDepth).toBe(1);
    expect(t.doc.undo()).toBe(true);
    t.doc.transact(() => expect(t.doc.redo()).toBe(false));
    expect(t.doc.canRedo).toBe(true);
    expect(t.doc.redo()).toBe(true);
  });

  it('an edit of a locked page rolls back without a trace: subscribers do not see it, it is not in history', () => {
    const t = setup({ id: 'boris', owner: false });
    t.doc.transact(() => t.doc.set(t.a, { width: 99 }));
    expect(t.doc.get(t.a, 'width')).toBe(10);
    expect(t.seen).toEqual([]);
    expect(t.doc.canUndo).toBe(false);
    expect(t.reasons).toEqual(['Бренд']);
    // Own page — allowed.
    t.doc.transact(() => t.doc.set(t.b, { width: 20 }));
    expect(t.doc.get(t.b, 'width')).toBe(20);
    expect(t.seen.length).toBe(1);
    // Moving a layer to a protected page and deleting a protected page are not allowed either.
    t.doc.transact(() => t.doc.move(t.b, t.brand));
    expect(t.doc.parent(t.b)).toBe(t.drafts);
    t.doc.transact(() => t.doc.delete(t.brand));
    expect(t.doc.has(t.brand)).toBe(true);
    expect(t.doc.has(t.a)).toBe(true);
    // Only the owner changes protection: neither removing nor setting it.
    t.doc.transact(() => t.doc.set(t.brand, { pageProtection: undefined }));
    expect(t.doc.get(t.brand, 'pageProtection')).toEqual({ editors: ['viktor'] });
    t.doc.transact(() => t.doc.set(t.drafts, { pageProtection: { editors: ['boris'] } }));
    expect(t.doc.get(t.drafts, 'pageProtection')).toBeUndefined();
    // Others' edits (from the server) — without the check.
    t.doc.transact(() => t.doc.set(t.a, { width: 55 }), 'loro');
    expect(t.doc.get(t.a, 'width')).toBe(55);
  });

  it('users listed in the protection and the owner can edit', () => {
    const v = setup({ id: 'viktor', owner: false });
    v.doc.transact(() => v.doc.set(v.a, { width: 30 }));
    expect(v.doc.get(v.a, 'width')).toBe(30);
    expect(canEditPage(v.doc, v.brand, { id: 'viktor', owner: false })).toBe(true);
    const o = setup({ id: 'anna', owner: true });
    o.doc.transact(() => o.doc.set(o.brand, { pageProtection: undefined }));
    expect(o.doc.get(o.brand, 'pageProtection')).toBeUndefined();
  });
});
