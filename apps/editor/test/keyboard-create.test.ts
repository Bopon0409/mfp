import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Document, type Matrix } from '@mfp/core';
import type { Editor, Tool } from '../src/editor.ts';
import { Tools } from '../src/tools.ts';

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => vi.unstubAllGlobals());

const key = (key: string, extra: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }) as KeyboardEvent;
function setup(tool: Tool = 'rect') {
  const doc = new Document({ clientId: 1 });
  const pageId = doc.create('PAGE', doc.root);
  const ed = {
    doc, pageId, tool, devMode: false, viewW: 800, viewH: 600,
    camera: { x: 10, y: 20, zoom: 2 }, selection: [] as string[], dirty: false,
    canvasEl: { addEventListener: vi.fn(), focus: vi.fn() }, overlays: [],
    scene: { hitPath: vi.fn(() => [] as string[]), id: (id: string) => id },
    screenToWorld(x: number, y: number): [number, number] { return [this.camera.x + x / this.camera.zoom, this.camera.y + y / this.camera.zoom]; },
    setCamera(c: typeof this.camera) { this.camera = c; },
    worldMatrix: vi.fn((): Matrix => [1, 0, 100, 0, 1, 100]),
    snapPx: Math.round, beginLive: vi.fn(), endLive: vi.fn(),
    select(ids: string[]) { this.selection = ids; },
  };
  const tools = new Tools(ed as unknown as Editor);
  return { ed, tools, doc, pageId };
}

it('only exposes section rotation handles after explicit opt-in, including mixed selections', () => {
  const { ed, tools, doc, pageId } = setup();
  const section = doc.create('SECTION', pageId), rect = doc.create('RECTANGLE', pageId);
  Object.assign(ed, { handlePositions: () => [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100], [50, 100], [0, 100], [0, 50]] });
  ed.selection = [section]; expect(tools['rotateZoneAt'](-10, -10)).toBe(false);
  doc.set(section, { sectionRotationEnabled: true }); expect(tools['rotateZoneAt'](-10, -10)).toBe(true);
  doc.undo(); expect(tools['rotateZoneAt'](-10, -10)).toBe(false);
  ed.selection = [section, rect]; expect(tools['rotateZoneAt'](-10, -10)).toBe(false);
  ed.selection = [rect]; expect(tools['rotateZoneAt'](-10, -10)).toBe(true);
});

it('cannot deep-pick a descendant of a locked frame', () => {
  const { ed, tools, doc, pageId } = setup();
  const frame = doc.create('FRAME', pageId, { locked: true });
  const child = doc.create('RECTANGLE', frame);
  ed.scene.hitPath.mockReturnValue([frame, child]);
  expect(tools.pick(0, 0, true)).toBeNull();
  doc.set(frame, { locked: false });
  expect(tools.pick(0, 0, true)).toBe(child);
});

it('places a standard shape at viewport center and undoes creation in one step', () => {
  const { ed, tools, doc, pageId } = setup();
  const depth = doc.undoDepth;
  expect(tools.creationKey(key('Enter'))).toBe(true);
  const id = ed.selection[0]!;
  expect(doc.props(id)).toMatchObject({ width: 100, height: 100, transform: [1, 0, 210, 0, 1, 170] });
  expect(ed.tool).toBe('select');
  expect(doc.undoDepth).toBe(depth + 1);
  doc.undo(); expect(doc.children(pageId)).toEqual([]);
  doc.redo(); expect(doc.has(id)).toBe(true);
});

it('pans while a creation tool is active without moving existing selection', () => {
  const { ed, tools, doc, pageId } = setup();
  ed.selection = [doc.create('RECTANGLE', pageId, { width: 50 })];
  const before = doc.snapshot();
  tools.creationKey(key('ArrowRight'));
  tools.creationKey(key('ArrowDown', { shiftKey: true }));
  expect(ed.camera).toEqual({ x: 50, y: 220, zoom: 2 });
  expect(doc.snapshot()).toEqual(before);
  tools.creationKey(key('Escape'));
  expect(ed.tool).toBe('select');
  expect(doc.snapshot()).toEqual(before);
});

it('inserts in transformed containers but never inside a locked frame or instance', () => {
  const { ed, tools, doc, pageId } = setup();
  const frame = doc.create('FRAME', pageId, { width: 400, height: 400 });
  ed.scene.hitPath.mockReturnValue([frame]);
  tools.creationKey(key('Enter'));
  expect(doc.parent(ed.selection[0]!)).toBe(frame);
  expect(doc.get(ed.selection[0]!, 'transform')).toEqual([1, 0, 110, 0, 1, 70]);
  doc.set(frame, { locked: true }); ed.tool = 'rect';
  tools.creationKey(key('Enter'));
  expect(doc.parent(ed.selection[0]!)).toBe(pageId);
  const instance = doc.create('INSTANCE', pageId);
  ed.scene.hitPath.mockReturnValue([instance, frame]); ed.tool = 'rect';
  tools.creationKey(key('Enter'));
  expect(doc.parent(ed.selection[0]!)).toBe(pageId);
});

it('starts editing new text and groups typing with its creation', () => {
  const { ed, tools, doc, pageId } = setup('text');
  tools.onEditText = (id, fresh) => {
    expect(fresh).toBe(true);
    expect(doc.get(id, 'textAutoResize')).toBe('WIDTH_AND_HEIGHT');
    doc.beginGroup(); doc.set(id, { characters: 'Keyboard' });
  };
  const depth = doc.undoDepth;
  tools.creationKey(key('Enter')); doc.endGroup();
  expect(doc.get(ed.selection[0]!, 'characters')).toBe('Keyboard');
  expect(doc.undoDepth).toBe(depth + 1);
  doc.undo(); expect(doc.children(pageId)).toEqual([]);
});

it('does not create using unsupported tools, view mode, modifiers or key repeats', () => {
  const { ed, tools, doc } = setup();
  const before = doc.snapshot();
  for (const tool of ['line', 'arrow', 'pen', 'select'] as Tool[]) {
    ed.tool = tool; expect(tools.creationKey(key('Enter'))).toBe(false);
  }
  ed.tool = 'frame'; ed.devMode = true;
  expect(tools.creationKey(key('Enter'))).toBe(false);
  ed.devMode = false;
  expect(tools.creationKey(key('Enter', { ctrlKey: true }))).toBe(false);
  expect(tools.creationKey(key('Enter', { repeat: true }))).toBe(true);
  expect(doc.snapshot()).toEqual(before);
});
