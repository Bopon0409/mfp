import { expect, it, vi } from 'vitest';
import { Document } from '@mfp/core';
import { Tools } from '../src/tools.ts';

it('keeps group children inside their group when dragged outside or over another frame', () => {
  const doc = new Document();
  const page = doc.create('PAGE', doc.root);
  const group = doc.create('GROUP', page, { width: 100, height: 100 });
  const child = doc.create('RECTANGLE', group, { width: 20, height: 20, transform: [1, 0, 300, 0, 1, 300] });
  const frame = doc.create('FRAME', page);
  const hitPath = vi.fn(() => []);
  const ed = { doc, pageId: page, scene: { hitPath }, drop: {}, dirty: false };
  const tools = Object.assign(Object.create(Tools.prototype), { ed });
  const m = { origins: new Map([[child, [1, 0, 0, 0, 1, 0]]]), target: frame, index: 1 };
  tools.updateDrop(m, 300, 300, 300, 300);
  expect(ed.drop).toBeNull();
  expect(hitPath).not.toHaveBeenCalled();
  for (const target of [page, frame]) {
    tools.drop({ ...m, target });
    expect(doc.parent(child)).toBe(group);
    expect(doc.get(child, 'transform')).toEqual([1, 0, 300, 0, 1, 300]);
  }
});

it('still reparents a whole group dragged into a frame and supports undo', () => {
  const doc = new Document();
  const page = doc.create('PAGE', doc.root);
  const group = doc.create('GROUP', page);
  const child = doc.create('RECTANGLE', group);
  const frame = doc.create('FRAME', page);
  const tools = Object.assign(Object.create(Tools.prototype), { ed: { doc, pageId: page, worldMatrix: () => [1, 0, 0, 0, 1, 0] } });
  tools.drop({ origins: new Map([[group, [1, 0, 0, 0, 1, 0]]]), target: frame });
  expect(doc.parent(group)).toBe(frame);
  expect(doc.parent(child)).toBe(group);
  doc.undo();
  expect(doc.parent(group)).toBe(page);
  expect(doc.parent(child)).toBe(group);
});
