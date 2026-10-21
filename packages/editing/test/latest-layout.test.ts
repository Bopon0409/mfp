import { beforeAll, expect, it } from 'vitest';
import { Document, type Props } from '@mfp/core';
import { layoutEngineReady, layoutFrame, LAYOUT_CHILD_KEYS, LAYOUT_SELF_KEYS } from '../src/autolayout.ts';
beforeAll(() => layoutEngineReady);
const stroke = [{ type: 'SOLID' as const, color: { r: 0, g: 0, b: 0 } }];
function setup(props: Props = {}) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { layoutMode: 'HORIZONTAL', layoutVersion: 'LATEST', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED', width: 50, height: 50, paddingLeft: 30, paddingRight: 30, ...props });
  const child = doc.create('RECTANGLE', frame, { width: 10, height: 10 });
  return { doc, frame, child };
}

it('writes the padding minimum back to the document and adds inside strokes per edge', () => {
  const { doc, frame, child } = setup({ strokes: stroke, strokeWeight: 10, strokeLeftWeight: 5, strokeRightWeight: 15, maxWidth: 50 });
  layoutFrame(doc, frame);
  expect(doc.get(frame, 'width')).toBe(80);
  expect(doc.get(child, 'transform')![2]).toBe(35);
  expect(doc.get(child, 'transform')![5]).toBe(10);
});

it('outside, center and hidden strokes do not affect Latest spacing', () => {
  for (const props of [{ strokeAlign: 'OUTSIDE' }, { strokeAlign: 'CENTER' }, { strokes: [{ ...stroke[0]!, visible: false }] } ] as Props[]) {
    const { doc, frame, child } = setup({ strokes: stroke, strokeWeight: 10, ...props });
    layoutFrame(doc, frame);
    expect(doc.get(frame, 'width')).toBe(60);
    expect(doc.get(child, 'transform')![2]).toBe(30);
  }
});

it('Latest parent does not inherit its stroke setting into children', () => {
  const { doc, frame, child } = setup({ width: 300, paddingLeft: 0, paddingRight: 0, strokesIncludedInLayout: true });
  doc.set(child, { strokes: stroke, strokeWeight: 10, strokeAlign: 'OUTSIDE' });
  const nested = doc.create('FRAME', frame, { layoutMode: 'HORIZONTAL', layoutVersion: 'LATEST', width: 100, height: 20, strokesIncludedInLayout: false, strokes: stroke, strokeWeight: 15 });
  const nestedChild = doc.create('RECTANGLE', nested, { width: 10, height: 10 });
  layoutFrame(doc, nested);
  layoutFrame(doc, frame);
  expect(doc.get(child, 'transform')![2]).toBe(0);
  expect(doc.get(nested, 'transform')![2]).toBe(10);
  expect(doc.get(nestedChild, 'transform')![2]).toBe(0);
});

it('Fill distributes content space including each child own inside strokes', () => {
  const { doc, frame, child } = setup({ width: 300, paddingLeft: 0, paddingRight: 0 });
  doc.set(child, { layoutGrow: 1, strokes: stroke, strokeWeight: 20 });
  const other = doc.create('RECTANGLE', frame, { layoutGrow: 1, width: 1, height: 10 });
  layoutFrame(doc, frame);
  expect(doc.get(child, 'width')).toBe(170);
  expect(doc.get(other, 'width')).toBe(130);
});

it('version is saved, reverting the grouped upgrade restores old geometry', () => {
  const { doc, frame } = setup({ layoutVersion: 'LEGACY' });
  layoutFrame(doc, frame);
  expect(doc.get(frame, 'width')).toBe(50);
  doc.transact(() => { doc.set(frame, { layoutVersion: 'LATEST' }); layoutFrame(doc, frame); });
  expect(doc.get(frame, 'width')).toBe(60);
  expect(Document.fromSnapshot(doc.snapshot()).get(frame, 'layoutVersion')).toBe('LATEST');
  doc.undo();
  expect(doc.get(frame, 'layoutVersion')).toBe('LEGACY');
  expect(doc.get(frame, 'width')).toBe(50);
});

it('changes to borders, padding and version schedule both local and parent layout', () => {
  for (const k of ['layoutVersion', 'strokesIncludedInLayout', 'strokeLeftWeight', 'paddingLeft']) {
    expect(LAYOUT_SELF_KEYS.has(k)).toBe(true);
    expect(LAYOUT_CHILD_KEYS.has(k)).toBe(true);
  }
});
