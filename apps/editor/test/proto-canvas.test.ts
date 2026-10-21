import { expect, it, vi } from 'vitest';
import { Document } from '@mfp/core';
import { ProtoCanvas, hitsPrototypeCurve } from '../src/proto-canvas.ts';
import type { Editor } from '../src/editor.ts';

it('opens the correct reaction by clicking its curve without selecting a frame first', () => {
  const doc = new Document({ clientId: 1 }); const page = doc.create('PAGE', doc.root);
  const from = doc.create('FRAME', page), to = doc.create('FRAME', page);
  doc.set(from, { reactions: [
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'URL', url: 'https://example.com' }] },
    { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: to, navigation: 'NAVIGATE', transition: null }] },
  ] });
  const ed = { doc, pageId: page, selection: [], overlays: [], dirty: false,
    isOnPage: () => true, worldToScreen: (x: number, y: number) => [x, y], select: vi.fn(),
    corners: (id: string) => id === from ? [[0, 0], [100, 0], [100, 100], [0, 100]] : [[300, 0], [400, 0], [400, 100], [300, 100]],
  } as unknown as Editor;
  const proto = new ProtoCanvas(ed, {} as HTMLElement); proto.on = true; proto.onCreated = vi.fn();
  expect(proto.down({ button: 0 } as PointerEvent, 200, 45)).toBe(true);
  expect(ed.select).toHaveBeenCalledWith([from]); expect(proto.onCreated).toHaveBeenCalledWith(from, 1);
  expect(proto.down({ button: 0 } as PointerEvent, 200, 100)).toBe(false);
});

it('uses screen-space tolerance for curved and cross-page links', () => {
  expect(hitsPrototypeCurve([50, 5], [0, 0], [100, 0], 1)).toBe(true);
  expect(hitsPrototypeCurve([50, 12], [0, 0], [100, 0], 1)).toBe(false);
  expect(hitsPrototypeCurve([25, 0], [0, 0], [32, 0], 1, true)).toBe(true);
});
