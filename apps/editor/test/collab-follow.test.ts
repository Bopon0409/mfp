import { afterEach, expect, it, vi } from 'vitest';
import { Collab } from '../src/collab.ts';
import type { Editor } from '../src/editor.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function client(id: string, width: number, height: number) {
  const ed = {
    camera: { x: 0, y: 0, zoom: 1 }, viewW: width, viewH: height, pageId: 'page', selection: [],
    overlays: [], onSelection: [], onCamera: [] as (() => void)[], onPage: [],
    canvasEl: { addEventListener() {} }, doc: { has: () => true, type: () => 'PAGE' },
    setCamera(c: { x: number; y: number; zoom: number }) { this.camera = c; this.onCamera.forEach(cb => cb()); },
  };
  const collab = new Collab(ed as unknown as Editor, id);
  collab.me.id = id;
  const sent: Uint8Array[] = [];
  const wire = collab as unknown as { ws: unknown; bridge: unknown; receive: (bytes: Uint8Array) => void; sendPresence: (at?: undefined, force?: boolean) => void };
  wire.ws = { readyState: 1, send: (b: Uint8Array) => sent.push(b) }; wire.bridge = {};
  return { ed, collab, wire, sent };
}

it('mutual following is refused; differing viewport shapes forward the original view', () => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', { OPEN: 1 });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const a = client('a', 1000, 400), b = client('b', 400, 1000);
  a.wire.sendPresence(undefined, true); b.wire.receive(a.sent.at(-1)!);
  b.wire.sendPresence(undefined, true); a.wire.receive(b.sent.at(-1)!);
  expect(a.collab.follow('b')).toBe(true);
  a.wire.sendPresence(undefined, true); b.wire.receive(a.sent.at(-1)!);
  expect(b.collab.follow('a')).toBe(false);
  expect(a.collab.following).toBe('b'); expect(b.collab.following).toBeNull();
  const presence = JSON.parse(new TextDecoder().decode(a.sent.at(-1)!.subarray(1)));
  expect(presence.view).toEqual([0, 0, 400, 1000]);
  // Local navigation interrupts follow without letting a later animation undo it.
  a.ed.setCamera({ x: 7, y: 8, zoom: 1 }); expect(a.collab.following).toBeNull();
});

it('simultaneous requests break a cycle when the delayed presence arrives', () => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', { OPEN: 1 });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const a = client('a', 1000, 400), b = client('b', 400, 1000);
  a.wire.sendPresence(undefined, true); b.wire.receive(a.sent.at(-1)!);
  b.wire.sendPresence(undefined, true); a.wire.receive(b.sent.at(-1)!);
  a.collab.follow('b'); b.collab.follow('a');
  a.wire.sendPresence(undefined, true); b.wire.sendPresence(undefined, true);
  const ap = a.sent.at(-1)!, bp = b.sent.at(-1)!;
  a.wire.receive(bp); b.wire.receive(ap);
  expect(a.collab.following).toBeNull(); expect(b.collab.following).toBeNull();
});
