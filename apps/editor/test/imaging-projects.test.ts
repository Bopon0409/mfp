import { Document, type Paint } from '@mfp/core';
import { LoroBridge, loroReady } from '@mfp/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '../src/editor.ts';
import { BUILTIN_MAP } from '../src/imaging/nodes/defs.ts';
import { newId, type Graph } from '../src/imaging/nodes/model.ts';
import { batchItems, runItem, type ReplaceOutput, type Services } from '../src/imaging/nodes/runner.ts';
import { ImageWriter, baseName, pageImages, renameSize, replacedProps, type Cloud, type ImageOrigin } from '../src/imaging/projects.ts';

// Document: page “Icons” with frame “sword/200” (image old) and a tile
function iconsDoc(doc = new Document()) {
  const page = doc.create('PAGE', doc.root, { name: 'Icons' });
  const icon = doc.create('FRAME', page, { name: 'sword/200', width: 200, height: 200, fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: 'old', originalWidth: 200 }] });
  const tile = doc.create('RECTANGLE', page, { name: 'background', width: 400, height: 400, fills: [{ type: 'IMAGE', scaleMode: 'TILE', imageHash: 'tex', originalWidth: 100, scalingFactor: 1 }] });
  doc.create('RECTANGLE', page, { name: 'no image', width: 10, height: 10, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] });
  return { doc, page, icon, tile };
}

const origin = (doc: Document | null, nodeId: string, hash: string, fileId: string | null = null): ImageOrigin => ({ fileId, fileName: 'File', doc: doc as unknown as Editor['doc'], nodeId, hash, name: 'sword/200', width: 200, height: 200 });
const hashOf = (doc: Document, id: string) => ((doc.get(id, 'fills') ?? []) as Paint[]).find((p) => p.type === 'IMAGE')?.imageHash;

describe('image enhancements: images from projects', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('icon names: a trailing size changes, other names do not', () => {
    expect(renameSize('sword/200', 200, 200, 256, 256)).toBe('sword/256');
    expect(renameSize('sword/512x256', 512, 256, 300, 150)).toBe('sword/300x150');
    expect(renameSize('sword/200', 180, 180, 256, 256)).toBe('sword/200');
    expect(renameSize('Sword', 200, 200, 256, 256)).toBe('Sword');
    expect(baseName('sword/200')).toBe('sword');
    expect(baseName('shield/450x300')).toBe('shield');
    expect(baseName('just a name')).toBe('just a name');
  });

  it('image layers on the page and new layer properties', () => {
    const { doc, page, icon, tile } = iconsDoc();
    expect(pageImages(doc as unknown as Editor['doc'], page).map((l) => `${l.name} ${l.hash} ${l.width}`)).toEqual(['sword/200 old 200', 'background tex 400']);
    const d = doc as unknown as Editor['doc'];
    const r = replacedProps(d, origin(doc, icon, 'old'), 'new', 256, 256, true);
    expect(r.after).toMatchObject({ width: 256, height: 256, name: 'sword/256' });
    expect((r.after.fills as Paint[])[0]).toMatchObject({ imageHash: 'new', originalWidth: 256 });
    expect(r.before).toMatchObject({ width: 200, height: 200, name: 'sword/200' });
    // Without fitting the layer stays the same; the tile keeps the same pattern size on the canvas
    const t = replacedProps(d, { ...origin(doc, tile, 'tex'), name: 'background' }, 'tex4', 400, 400, false);
    expect(t.after.width).toBeUndefined();
    expect((t.after.fills as Paint[])[0]).toMatchObject({ imageHash: 'tex4', originalWidth: 400, scalingFactor: 0.25 });
    expect(() => replacedProps(d, origin(doc, icon, 'other'), 'x', 1, 1, false)).toThrow(/уже заменили/);
  });

  it('open file: replacement as one group (Ctrl+Z) and “Restore”', async () => {
    const { doc, icon } = iconsDoc();
    const editor = { doc, store: { add: async () => 'new' } } as unknown as Editor;
    const w = new ImageWriter(editor, { base: () => '', token: () => null }, null);
    const o = origin(doc, icon, 'old');
    await w.replace(o, new Blob(['png']), 256, 256, true);
    expect([hashOf(doc, icon), doc.get(icon, 'width'), doc.get(icon, 'name')]).toEqual(['new', 256, 'sword/256']);
    expect(o).toMatchObject({ hash: 'new', width: 256 });
    doc.undo();
    expect([hashOf(doc, icon), doc.get(icon, 'name')]).toEqual(['old', 'sword/200']);
    doc.redo();
    expect(await w.revert()).toBe(1);
    expect([hashOf(doc, icon), doc.get(icon, 'width'), o.hash]).toEqual(['old', 200, 'old']);
  });

  it('file on the server: the image is uploaded, the edit goes out as a Loro update and merges with the file', async () => {
    await loroReady();
    // “Server”: the file's document in Loro
    const server = new Document();
    const serverBridge = new LoroBridge(server);
    const { icon } = iconsDoc(server);
    const puts: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      if (init?.method === 'PUT') puts.push(url);
      return new Response(null, { status: 200 });
    });
    const cloud: Cloud = {
      api: (async (method: string, path: string, body?: unknown) => {
        if (method === 'GET' && path === '/api/files/f1/doc') return serverBridge.loro.export({ mode: 'snapshot' });
        if (method === 'POST' && path === '/api/files/f1/doc') return void serverBridge.importUpdate(body as Uint8Array);
        throw new Error(`${method} ${path}`);
      }) as Cloud['api'],
      signedIn: () => true,
      teams: () => [],
      projects: () => [],
      openFileId: () => null,
    };
    const local = new Document();
    const editor = { doc: local, store: { add: async () => 'sha-new' } } as unknown as Editor;
    const w = new ImageWriter(editor, { base: () => 'http://srv', token: () => 't' }, cloud);
    const o = origin(null, icon, 'old', 'f1');
    await w.replace(o, new Blob(['png']), 256, 256, true);
    expect(puts).toEqual(['http://srv/image/sha-new']);
    expect([hashOf(server, icon), server.get(icon, 'width'), server.get(icon, 'name')]).toEqual(['sha-new', 256, 'sword/256']);
    expect(w.remoteCount).toBe(1);
    await w.revert();
    expect([hashOf(server, icon), server.get(icon, 'width'), server.get(icon, 'name')]).toEqual(['old', 200, 'sword/200']);
    w.dispose();
  });

  it('“Replace in document” node: only for images from the document, layer size per setting', async () => {
    const img = (w: number) => new Blob(['x'], { type: `image/x-test;${w}x${w}` });
    const services: Services = {
      generate: async () => img(1),
      upscale: async () => img(1),
      removeBackground: async (b) => b,
      fit: async (_b, w) => img(w),
      sizeOf: async (b) => {
        const n = Number(b.type.split(';')[1]!.split('x')[0]);
        return { width: n, height: n };
      },
    };
    const src = { id: newId(), type: 'images', x: 0, y: 0, params: {} };
    const fit = { id: newId(), type: 'fit', x: 0, y: 0, params: { width: 256, height: 256 } };
    const out = { id: newId(), type: 'replace', x: 0, y: 0, params: { layer: 'image' } };
    const graph: Graph = { id: 'g', name: 'g', nodes: [src, fit, out], edges: [{ from: { node: src.id, pin: 'image' }, to: { node: fit.id, pin: 'image' } }, { from: { node: fit.id, pin: 'image' }, to: { node: out.id, pin: 'image' } }], macros: [] };
    const o = origin(null, 'n1', 'old', 'f1');
    const [withOrigin, plain] = batchItems(graph, BUILTIN_MAP, new Map([[src.id, [{ name: 'sword', blob: img(200), origin: o }, { name: 'file', blob: img(200) }]]]), 'g');
    const got: ReplaceOutput[] = [];
    const ctx = (item: typeof withOrigin) => ({ item: item!, services, signal: new AbortController().signal, status: () => undefined, emit: () => undefined, replace: (r: ReplaceOutput) => void got.push(r) });
    await runItem(graph, BUILTIN_MAP, ctx(withOrigin));
    expect(got.map((r) => [r.origin.nodeId, r.width, r.resize])).toEqual([['n1', 256, true]]);
    await expect(runItem(graph, BUILTIN_MAP, ctx(plain))).rejects.toThrow(/картинки, взятые из документа/);
  });
});
