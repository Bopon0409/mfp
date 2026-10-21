import { expect, it } from 'vitest';
import { Document, layerLocked } from '../src/index.ts';
it('inherits parent locks, preserves child locks, and follows undo/reparenting', () => {
  const doc = new Document({ clientId: 1 }); const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page), child = doc.create('FRAME', frame), leaf = doc.create('RECTANGLE', child);
  doc.set(frame, { locked: true });
  expect(layerLocked(doc, leaf)).toBe(true); expect(doc.get(leaf, 'locked')).not.toBe(true);
  doc.undo(); expect(layerLocked(doc, leaf)).toBe(false);
  doc.set(child, { locked: true }); doc.set(frame, { locked: true }); doc.set(frame, { locked: false });
  expect(layerLocked(doc, leaf)).toBe(true);
  doc.move(leaf, page); expect(layerLocked(doc, leaf)).toBe(false);
});
