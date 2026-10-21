import { beforeAll, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { enableAutoLayout, layoutEngineReady, layoutFrame } from '../src/autolayout.ts';
beforeAll(() => layoutEngineReady);

it('repeated layout preserves scaled children instead of shrinking them to zero', () => {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { width: 200, height: 100, layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'AUTO' });
  const child = doc.create('RECTANGLE', frame, { width: 80, height: 60, layoutGrow: 1, transform: [0.5, 0, 0, 0, 0.5, 0] });
  for (let i = 0; i < 12; i++) layoutFrame(doc, frame);
  expect(doc.get(child, 'height')).toBe(60);
  expect(doc.get(child, 'width')).toBe(400);
  expect(doc.get(frame, 'height')).toBe(30);
});

it('enabling layout preserves a clipping frame containing only absolute children', () => {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { width: 200, height: 100, clipsContent: true });
  const child = doc.create('RECTANGLE', frame, { width: 200, height: 100, layoutPositioning: 'ABSOLUTE' });
  doc.transact(() => enableAutoLayout(doc, frame));
  layoutFrame(doc, frame);
  expect(doc.get(frame, 'width')).toBe(200);
  expect(doc.get(frame, 'height')).toBe(100);
  expect(doc.get(child, 'layoutPositioning')).toBe('ABSOLUTE');
});

it('grid Fill preserves local dimensions across repeated scaled layouts', () => {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { width: 200, height: 100, layoutMode: 'GRID' });
  const child = doc.create('RECTANGLE', frame, { width: 80, height: 60, layoutAlign: 'STRETCH', layoutGrow: 1, transform: [0.5, 0, 0, 0, 2, 0] });
  for (let i = 0; i < 12; i++) layoutFrame(doc, frame);
  expect(doc.get(child, 'width')).toBe(400);
  expect(doc.get(child, 'height')).toBe(50);
});
