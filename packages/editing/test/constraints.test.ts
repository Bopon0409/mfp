import { describe, expect, it } from 'vitest';
import { Document, type ConstraintType } from '@mfp/core';
import { applyConstraints, resizeToFit, resizeWithConstraints } from '../src/sizing.ts';
import { snapshotProps } from '../src/scale.ts';

/** Frame 200×100 and a 40×20 rectangle at (20, 30) with the given constraints. */
function setup(horizontal: ConstraintType, vertical: ConstraintType) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { width: 200, height: 100 });
  const box = doc.create('RECTANGLE', frame, { transform: [1, 0, 20, 0, 1, 30], width: 40, height: 20, constraints: { horizontal, vertical } });
  return { doc, frame, box };
}

const place = (doc: Document, id: string) => {
  const t = doc.get(id, 'transform')!;
  return [t[2], t[5], doc.get(id, 'width'), doc.get(id, 'height')];
};

describe('Constraints', () => {
  it('left / top — position does not change', () => {
    const { doc, frame, box } = setup('MIN', 'MIN');
    resizeWithConstraints(doc, frame, { width: 300, height: 150 });
    expect(place(doc, box)).toEqual([20, 30, 40, 20]);
  });

  it('right / bottom — distance to the right and bottom edge is preserved', () => {
    const { doc, frame, box } = setup('MAX', 'MAX');
    resizeWithConstraints(doc, frame, { width: 300, height: 150 });
    expect(place(doc, box)).toEqual([120, 80, 40, 20]);
  });

  it('center — shifted by half', () => {
    const { doc, frame, box } = setup('CENTER', 'CENTER');
    resizeWithConstraints(doc, frame, { width: 300, height: 150 });
    expect(place(doc, box)).toEqual([70, 55, 40, 20]);
  });

  it('left and right — stretches', () => {
    const { doc, frame, box } = setup('STRETCH', 'STRETCH');
    resizeWithConstraints(doc, frame, { width: 300, height: 150 });
    expect(place(doc, box)).toEqual([20, 30, 140, 70]);
  });

  it('scale — proportionally', () => {
    const { doc, frame, box } = setup('SCALE', 'SCALE');
    resizeWithConstraints(doc, frame, { width: 300, height: 150 });
    expect(place(doc, box)).toEqual([30, 45, 60, 30]);
  });

  it('nested: a stretched frame drives its children', () => {
    const { doc, frame, box } = setup('STRETCH', 'MIN');
    doc.set(box, {});
    const inner = doc.create('FRAME', frame, { transform: [1, 0, 0, 0, 1, 0], width: 200, height: 100, constraints: { horizontal: 'STRETCH', vertical: 'STRETCH' } });
    const dot = doc.create('ELLIPSE', inner, { transform: [1, 0, 180, 0, 1, 0], width: 10, height: 10, constraints: { horizontal: 'MAX', vertical: 'MIN' } });
    resizeWithConstraints(doc, frame, { width: 260, height: 100 });
    expect(doc.get(inner, 'width')).toBe(260);
    expect(place(doc, dot)).toEqual([240, 0, 10, 10]);
  });

  it('group children scale along with the group', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const group = doc.create('GROUP', page, { width: 100, height: 100 });
    const a = doc.create('RECTANGLE', group, { transform: [1, 0, 50, 0, 1, 0], width: 50, height: 50 });
    resizeWithConstraints(doc, group, { width: 200, height: 100 });
    expect(place(doc, a)).toEqual([100, 0, 100, 50]);
  });

  it('dragging from a snapshot: positions do not accumulate and return', () => {
    const { doc, frame, box } = setup('MAX', 'STRETCH');
    const snap = snapshotProps(doc, [frame]);
    const src = (id: string) => snap.get(id)!;
    for (const w of [220, 260, 300]) {
      doc.set(frame, { width: w });
      applyConstraints(doc, frame, [200, 100], [w, 100], src);
    }
    expect(place(doc, box)).toEqual([120, 30, 40, 20]);
    applyConstraints(doc, frame, [200, 100], [200, 100], src);
    expect(place(doc, box)).toEqual([20, 30, 40, 20]);
  });

  it('fit to content: bounds follow the children, children stay in place', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const frame = doc.create('FRAME', page, { transform: [1, 0, 100, 0, 1, 100], width: 400, height: 300 });
    const a = doc.create('RECTANGLE', frame, { transform: [1, 0, 50, 0, 1, 40], width: 30, height: 30 });
    const b = doc.create('RECTANGLE', frame, { transform: [1, 0, 120, 0, 1, 90], width: 40, height: 20 });
    expect(resizeToFit(doc, frame)).toBe(true);
    expect(place(doc, frame)).toEqual([150, 140, 110, 70]);
    expect(place(doc, a)).toEqual([0, 0, 30, 30]);
    expect(place(doc, b)).toEqual([70, 50, 40, 20]);
  });
});
