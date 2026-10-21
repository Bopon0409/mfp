import { expect, it, vi } from 'vitest';
import { Document } from '@mfp/core';
import type { Editor, Rect } from '../src/editor.ts';
import { KeyboardSelection, keyboardSelectionShortcut, regionShortcut } from '../src/keyboard-selection.ts';

const key = (value: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...value }) as KeyboardEvent;
function setup() {
  const doc = new Document({ clientId: 1 });
  const pageId = doc.create('PAGE', doc.root);
  const a = doc.create('RECTANGLE', pageId, { width: 20, height: 20 });
  const hidden = doc.create('RECTANGLE', pageId, { visible: false });
  const locked = doc.create('RECTANGLE', pageId, { locked: true });
  const bounds = new Map<string, Rect>([[a, [40, 40, 60, 60]], [hidden, [0, 0, 100, 100]], [locked, [0, 0, 100, 100]]]);
  const ed = {
    doc, pageId, camera: { x: 0, y: 0, zoom: 2 }, selection: [] as string[], dirty: false,
    overlays: [], onPage: [] as (() => void)[], onDocumentSet: [] as (() => void)[],
    canvasEl: { focus: vi.fn(), addEventListener: vi.fn() }, notify: vi.fn(),
    viewportRect(): Rect { return [this.camera.x, this.camera.y, this.camera.x + 100, this.camera.y + 100]; },
    selectionBounds(ids: string[]) { return bounds.get(ids[0]!); },
    select(ids: string[]) { this.selection = ids; },
    setCamera(c: typeof this.camera) { this.camera = c; },
  };
  const pick = vi.fn(() => a);
  const selection = new KeyboardSelection(ed as unknown as Editor, pick);
  return { ed, selection, pick, a };
}

it('activation on Windows and Mac without stealing preview or AltGr', () => {
  expect(keyboardSelectionShortcut(key({ code: 'Space', ctrlKey: true }), false)).toBe(true);
  expect(keyboardSelectionShortcut(key({ code: 'Space', altKey: true }), true)).toBe(true);
  expect(keyboardSelectionShortcut(key({ code: 'Space', ctrlKey: true }), true)).toBe(false);
  expect(keyboardSelectionShortcut(key({ code: 'Space', shiftKey: true }), false)).toBe(false);
  expect(keyboardSelectionShortcut(key({ code: 'Space', ctrlKey: true, getModifierState: () => true }), false)).toBe(false);
  expect(regionShortcut(key({ key: 'F6', ctrlKey: true, shiftKey: true }), false)).toBe(true);
  expect(regionShortcut(key({ key: 'F6', ctrlKey: true }), true)).toBe(false);
});

it('moves the cursor in screen pixels, selects with Enter and never edits document geometry', () => {
  const { ed, selection, pick, a } = setup();
  const before = ed.doc.snapshot();
  selection.start();
  expect(selection.point).toEqual([50, 50]);
  selection.key(key({ key: 'ArrowRight' }));
  expect(selection.point).toEqual([55, 50]);
  selection.key(key({ key: 'Enter' }));
  expect(pick).toHaveBeenCalledWith(55, 50);
  expect(ed.selection).toEqual([a]);
  expect(ed.doc.snapshot()).toEqual(before);
});

it('resizes a box in either direction and excludes locked and hidden layers', () => {
  const { ed, selection, a } = setup();
  selection.start();
  selection.key(key({ key: 'ArrowLeft', ctrlKey: true }));
  selection.key(key({ key: 'ArrowUp', ctrlKey: true }));
  expect(selection.anchor).toEqual([50, 50]);
  expect(selection.point).toEqual([45, 45]);
  expect(ed.selection).toEqual([a]);
  selection.key(key({ key: 'ArrowRight' }));
  expect(selection.anchor).toBeNull();
});

it('keeps the cursor visible as it leaves the viewport; Escape preserves selection', () => {
  const { ed, selection, a } = setup();
  selection.start();
  selection.key(key({ key: 'ArrowRight', shiftKey: true }));
  expect(ed.camera.x).toBe(12);
  selection.key(key({ key: 'Enter' }));
  expect(selection.key(key({ key: 'Escape' }))).toBe(true);
  expect(selection.point).toBeNull();
  expect(ed.selection).toEqual([a]);
  expect(selection.key(key({ key: 'ArrowRight' }))).toBe(false);
});

it('page changes cancel the cursor so it cannot select coordinates from the previous page', () => {
  const { ed, selection } = setup();
  selection.start();
  ed.onPage.forEach((fn) => fn());
  expect(selection.point).toBeNull();
});
