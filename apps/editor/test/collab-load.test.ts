import { afterEach, expect, it, vi } from 'vitest';
import { Document } from '@mfp/core';
import { LoroBridge, loroReady } from '@mfp/sync';
import { LoroDoc } from 'loro-crdt';
import { Collab } from '../src/collab.ts';
import type { Editor } from '../src/editor.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('opens populated and empty server snapshots with a single CRDT import', async () => {
  await loroReady();
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  for (const populated of [true, false]) {
    const source = new Document();
    if (populated) { const page = source.create('PAGE', source.root, { name: 'Test' }); source.create('RECTANGLE', page, { name: 'Shape', width: 120 }); }
    const bridge = new LoroBridge(source);
    const snapshot = bridge.loro.export({ mode: 'snapshot' });
    const ed = { camera: { x: 0, y: 0, zoom: 1 }, viewW: 1000, viewH: 800, pageId: '', selection: [], overlays: [], onSelection: [], onCamera: [], onPage: [], canvasEl: { addEventListener() {} }, doc: new Document() };
    const client = new Collab(ed as unknown as Editor, 'test');
    const internals = client as unknown as { mode: string; file: unknown; joinFile(bytes: Uint8Array): void; bridge: LoroBridge };
    internals.mode = 'file'; internals.file = { id: 'test', name: 'Test', role: 'edit', link: null };
    let loaded: Document | undefined;
    client.onFile = doc => { loaded = doc; };
    const imported = vi.spyOn(LoroDoc.prototype, 'import');
    internals.joinFile(snapshot);
    expect(imported).toHaveBeenCalledTimes(1);
    expect(loaded!.children(loaded!.root)).toHaveLength(1);
    if (populated) expect(loaded!.get(loaded!.children(loaded!.children(loaded!.root)[0]!)[0]!, 'width')).toBe(120);
    expect(loaded!.canUndo).toBeFalsy();
    imported.mockRestore(); internals.bridge.dispose(); bridge.dispose();
  }
});
