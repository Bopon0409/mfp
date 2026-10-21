import { beforeAll, describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { layoutEngineReady, layoutFrame } from '../src/autolayout.ts';
import { canFill, canHug, getSizing, percentOfParent, setLimit, setPercent, setSizing, sizingProps } from '../src/sizing.ts';

/** Auto layout row (hug contents) with a rectangle and text inside a top-level frame. */
function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const row = doc.create('FRAME', page, { layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', width: 300, height: 60 });
  const box = doc.create('RECTANGLE', row, { width: 40, height: 40 });
  const text = doc.create('TEXT', row, { characters: 'Привет', width: 50, height: 16 });
  const plain = doc.create('RECTANGLE', page, { width: 10, height: 10 });
  return { doc, page, row, box, text, plain };
}

describe('sizing modes (Fixed / Hug / Fill)', () => {
  beforeAll(() => layoutEngineReady);

  it('read from model properties', () => {
    const { doc, row, box, text, plain } = setup();
    expect(getSizing(doc, row, 'width')).toBe('HUG');
    expect(getSizing(doc, box, 'width')).toBe('FIXED');
    expect(getSizing(doc, text, 'width')).toBe('HUG');
    doc.set(text, { textAutoResize: 'HEIGHT' });
    expect([getSizing(doc, text, 'width'), getSizing(doc, text, 'height')]).toEqual(['FIXED', 'HUG']);
    expect(canHug(doc, plain)).toBe(false);
    expect(canFill(doc, plain)).toBe(false);
    expect(canFill(doc, box)).toBe(true);
  });

  it('“fill” makes a “hug” parent fixed along that axis', () => {
    const { doc, row, box } = setup();
    setSizing(doc, box, 'width', 'FILL');
    expect(doc.get(box, 'layoutGrow')).toBe(1);
    expect(doc.get(row, 'primaryAxisSizingMode')).toBe('FIXED');
    expect(doc.get(row, 'counterAxisSizingMode')).toBe('AUTO');
    setSizing(doc, box, 'height', 'FILL');
    expect(doc.get(box, 'layoutAlign')).toBe('STRETCH');
    expect(getSizing(doc, box, 'height')).toBe('FILL');
    expect(doc.get(row, 'counterAxisSizingMode')).toBe('FIXED');
  });

  it('“hug” on a frame switches filling children to a fixed size', () => {
    const { doc, row, box } = setup();
    setSizing(doc, box, 'width', 'FILL');
    setSizing(doc, row, 'width', 'HUG');
    expect(doc.get(row, 'primaryAxisSizingMode')).toBe('AUTO');
    expect(getSizing(doc, box, 'width')).toBe('FIXED');
  });

  it('text: content width drives height, fixed height gives a fixed box', () => {
    const { doc, text } = setup();
    setSizing(doc, text, 'width', 'FIXED');
    expect(doc.get(text, 'textAutoResize')).toBe('HEIGHT');
    setSizing(doc, text, 'height', 'FIXED');
    expect(doc.get(text, 'textAutoResize')).toBe('NONE');
    setSizing(doc, text, 'height', 'HUG');
    expect(doc.get(text, 'textAutoResize')).toBe('HEIGHT');
    setSizing(doc, text, 'width', 'FILL');
    expect(getSizing(doc, text, 'width')).toBe('FILL');
    setSizing(doc, text, 'width', 'HUG');
    expect(doc.get(text, 'textAutoResize')).toBe('WIDTH_AND_HEIGHT');
    expect(doc.get(text, 'layoutGrow')).toBe(0);
  });

  it('an explicit size clears “fill” and “hug” (number input, handle drag)', () => {
    const { doc, row, box } = setup();
    setSizing(doc, box, 'width', 'FILL');
    expect(sizingProps(doc, box, 'width', 'FIXED')).toEqual({ layoutGrow: 0 });
    expect(sizingProps(doc, row, 'height', 'FIXED')).toEqual({ counterAxisSizingMode: 'FIXED' });
  });

  it('min/max limits constrain the layout', () => {
    const { doc, row, box } = setup();
    doc.set(row, { itemSpacing: 10, paddingLeft: 0, paddingRight: 0 });
    layoutFrame(doc, row);
    const hugWidth = doc.get(row, 'width')!;
    setLimit(doc, row, 'minWidth', hugWidth + 100);
    layoutFrame(doc, row);
    expect(doc.get(row, 'width')).toBe(hugWidth + 100);
    setLimit(doc, row, 'minWidth', null);
    setLimit(doc, row, 'maxWidth', 60);
    layoutFrame(doc, row);
    expect(doc.get(row, 'width')).toBe(60);
    // A “fill” child limited to the maximum width.
    setLimit(doc, row, 'maxWidth', null);
    setSizing(doc, box, 'width', 'FILL');
    doc.set(row, { width: 400 });
    setLimit(doc, box, 'maxWidth', 120);
    layoutFrame(doc, row);
    expect(doc.get(box, 'width')).toBe(120);
  });
});

describe('size in percent of the parent (like width: 50% in CSS)', () => {
  beforeAll(() => layoutEngineReady);

  it('share of the inner area: 25% of 360 = 90, a “fill” sibling takes the rest; height as a percentage too', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const row = doc.create('FRAME', page, { layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED', width: 400, height: 100, paddingLeft: 20, paddingRight: 20, paddingTop: 10, paddingBottom: 10 });
    const side = doc.create('RECTANGLE', row, { width: 10, height: 10 });
    const main = doc.create('RECTANGLE', row, { width: 10, height: 10 });
    setPercent(doc, side, 'width', 25);
    setPercent(doc, side, 'height', 50);
    setSizing(doc, main, 'width', 'FILL');
    layoutFrame(doc, row);
    expect(getSizing(doc, side, 'width')).toBe('PERCENT');
    expect([doc.get(side, 'width'), doc.get(side, 'height')]).toEqual([90, 40]);
    expect(doc.get(main, 'width')).toBe(270);
    expect(percentOfParent(doc, main, 'width')).toBe(75);
    // The parent got wider — the share is the same.
    doc.set(row, { width: 840 });
    layoutFrame(doc, row);
    expect(doc.get(side, 'width')).toBe(200);
    // A number in the field means a fixed size; the percentage is cleared.
    doc.set(side, { ...sizingProps(doc, side, 'width', 'FIXED'), width: 120 });
    expect(doc.get(side, 'widthPercent')).toBeUndefined();
    expect(getSizing(doc, side, 'width')).toBe('FIXED');
  });

  it('a parent that hugs along that axis becomes fixed; outside auto layout — not allowed', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const col = doc.create('FRAME', page, { layoutMode: 'VERTICAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', width: 200, height: 300 });
    const item = doc.create('RECTANGLE', col, { width: 50, height: 50 });
    const plain = doc.create('RECTANGLE', page, { width: 10, height: 10 });
    expect(setPercent(doc, item, 'width', 50)).toBe(true);
    expect(doc.get(col, 'counterAxisSizingMode')).toBe('FIXED');
    layoutFrame(doc, col);
    expect(doc.get(item, 'width')).toBe(100);
    expect(setPercent(doc, plain, 'width', 50)).toBe(false);
  });
});

describe('limits in percent of the parent', () => {
  it('min and max “%” work like clamp(): the width percentage is limited by percentages of the parent', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const row = doc.create('FRAME', page, { layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED', width: 400, height: 100 });
    const a = doc.create('RECTANGLE', row, { width: 10, height: 10, widthPercent: 10, minWidthPercent: 25 });
    const b = doc.create('RECTANGLE', row, { width: 300, height: 10, maxWidthPercent: 50 });
    layoutFrame(doc, row);
    expect(doc.get(a, 'width')).toBe(100);
    expect(doc.get(b, 'width')).toBe(200);
  });
});
