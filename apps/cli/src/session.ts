// CLI and MCP server session: open document, PNG rendering (CanvasKit on the CPU),
// edits with the same rules as in the editor (text size, auto layout, groups, components).

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, basename } from 'node:path';
import CanvasKitInit from 'canvaskit-wasm/full';
import type { CanvasKit, Image } from 'canvaskit-wasm';
import { Document, userPages, type Op, type Props } from '@mfp/core';
import { buildScene, decodeFigKiwi, imageHashes, openFig, readMfp, sceneToCore, writeMfp, type ImageBytesSource } from '@mfp/io-figma';
import { FileSource } from '@mfp/io-figma/node';
import { CoreScene, FontLibrary, SceneRenderer, fitTextProps, type ImageSource } from '@mfp/renderer';
import { DesignSync, FIT_TYPES, fitGroup, isAutoLayout, layoutEngineReady, layoutFrame } from '@mfp/editing';

let ckPromise: Promise<CanvasKit> | null = null;
function canvasKit(): Promise<CanvasKit> {
  const require = createRequire(import.meta.url);
  // canvaskit.wasm lies next to canvaskit.js.
  const dir = dirname(require.resolve('canvaskit-wasm/full'));
  ckPromise ??= CanvasKitInit({ locateFile: (f: string) => `${dir}/${f}` });
  return ckPromise;
}

/** Images for rendering in Node: decoded by CanvasKit (Node has no createImageBitmap). */
class NodeImages implements ImageSource {
  readonly mipmaps = true;
  private map = new Map<string, Image>();
  private ck: CanvasKit;
  private src: ImageBytesSource | null;
  constructor(ck: CanvasKit, src: ImageBytesSource | null) {
    this.ck = ck;
    this.src = src;
  }
  async preload(hashes: Iterable<string>) {
    for (const h of hashes) {
      if (this.map.has(h) || !this.src) continue;
      const bytes = await this.src.readImage(h);
      // Skia builds the mipmap levels itself on the first downscale (mipmaps flag on the source).
      const img = bytes ? this.ck.MakeImageFromEncoded(bytes) : null;
      if (img) this.map.set(h, img);
    }
  }
  get(hash: string): Image | undefined {
    return this.map.get(hash);
  }
  dispose() {
    for (const img of this.map.values()) img.delete();
    this.map.clear();
  }
}

export class Session {
  doc: Document;
  images: ImageBytesSource | null;
  path: string;
  /** For .fig files: Figma node id (“1:925”) → id in the document. */
  figmaIds: ReadonlyMap<string, string> | null = null;
  private sync: DesignSync;
  private fonts: FontLibrary | null = null;
  /** Operations of the current edit (to recompute derived data). */
  private pending: Op[] = [];
  /** Editing is not allowed (server file with the “viewer” role): error text for edits. */
  readOnly: string | null = null;

  private constructor(doc: Document, images: ImageBytesSource | null, path: string) {
    this.doc = doc;
    this.images = images;
    this.path = path;
    this.sync = new DesignSync(doc);
    doc.onChange((ops, origin) => {
      this.sync.observe(ops);
      if (origin === 'local' || origin === 'layout') this.pending.push(...ops);
    });
  }

  static async open(path: string): Promise<Session> {
    if (extname(path).toLowerCase() === '.fig') {
      const archive = await openFig(new FileSource(path));
      // Constant client number: imported node ids are the same from run to run (handy in commands).
      const { doc, ids } = sceneToCore(buildScene(decodeFigKiwi(archive.kiwi).message), new Document({ clientId: 1 }));
      doc.clearHistory();
      const readImage = archive.readImage;
      const s = new Session(doc, { readImage }, path);
      s.figmaIds = ids;
      return s;
    }
    const { doc, images } = await readMfp(new FileSource(path));
    return new Session(doc, images, path);
  }

  /** Session over a ready document (server file — its document is already bound to Loro). */
  static fromDocument(doc: Document, images: ImageBytesSource | null, name: string): Session {
    return new Session(doc, images, name);
  }

  static create(path: string): Session {
    const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
    doc.create('PAGE', doc.root, { name: 'Страница 1' });
    doc.clearHistory();
    return new Session(doc, null, path);
  }

  get name() {
    return basename(this.path).replace(/\.(mfp|fig)$/i, '');
  }

  /**
   * Edit with editor rules: own changes become overrides in instances; then text size,
   * group bounds, auto layout and component copies — in the same undo step.
   */
  async edit<T>(fn: () => T): Promise<T> {
    if (this.readOnly) throw new Error(this.readOnly);
    this.pending = [];
    const result = this.doc.transact(fn, 'local');
    const ops = this.pending;
    this.doc.amend(() => this.sync.trackOverrides(ops));
    await this.settle(ops);
    return result;
  }

  private async settle(first: Op[]) {
    await layoutEngineReady;
    const doc = this.doc;
    let ops = first;
    for (let round = 0; round < 16 && ops.length; round++) {
      // Fonts of texts that need fitting (layout is synchronous, fonts are loaded in advance).
      const texts = new Set<string>();
      const frames = new Set<string>();
      const groups = new Set<string>();
      for (const o of ops) {
        if (o.op === 'blob') continue;
        const id = o.op === 'delete' ? null : o.id;
        if (id && doc.has(id)) {
          if (doc.type(id) === 'TEXT') texts.add(id);
          if (isAutoLayout(doc, id)) frames.add(id);
          const p = doc.parent(id);
          if (p && isAutoLayout(doc, p)) frames.add(p);
          if (p && FIT_TYPES.has(doc.type(p)!)) groups.add(p);
        }
        if ((o.op === 'create' || o.op === 'move') && doc.has(o.parent)) {
          if (isAutoLayout(doc, o.parent)) frames.add(o.parent);
          if (FIT_TYPES.has(doc.type(o.parent)!)) groups.add(o.parent);
        }
      }
      if (texts.size) {
        const fonts = await this.fontLibrary();
        await Promise.all([...texts].map((id) => fonts.ensure(doc.get(id, 'fontName') ?? { family: 'Inter', style: 'Regular' })));
      }
      this.pending = [];
      const ck = texts.size ? await canvasKit() : null;
      doc.amend(() => {
        for (const id of texts) {
          if (!doc.has(id) || !ck) continue;
          const p = fitTextProps(ck, this.fonts!, doc, id);
          if (p) doc.set(id, p);
        }
        for (const g of groups) fitGroup(doc, g);
        for (const f of frames) layoutFrame(doc, f);
        this.sync.propagate(ops);
      });
      ops = this.pending;
    }
  }

  private async fontLibrary(): Promise<FontLibrary> {
    this.fonts ??= new FontLibrary(await canvasKit());
    return this.fonts;
  }

  /** Node's page. */
  pageOf(id: string): string {
    let p = id;
    while (this.doc.parent(p) && this.doc.parent(p) !== this.doc.root) p = this.doc.parent(p)!;
    return p;
  }

  /**
   * PNG of a node (or the whole page) at scale; side no more than 8192 px.
   * box — frame by the node's own bounds, not by everything it draws.
   */
  async render(id: string, scale = 1, opts: { box?: boolean } = {}): Promise<{ png: Uint8Array; width: number; height: number }> {
    const ck = await canvasKit();
    const doc = this.doc;
    const isPage = doc.type(id) === 'PAGE';
    const pageId = isPage ? id : this.pageOf(id);
    const scene = new CoreScene(doc, pageId);
    const images = new NodeImages(ck, this.images);
    const subtree = isPage ? [...doc.descendants(id)] : [id, ...doc.descendants(id)];
    const hashes = new Set<string>();
    const fonts = await this.fontLibrary();
    // Pattern sources (may be on another page) — their images and fonts are needed too.
    const seen = new Set(subtree);
    for (let i = 0; i < subtree.length; i++) {
      for (const k of ['fills', 'strokes'] as const)
        for (const p of doc.get(subtree[i]!, k) ?? [])
          if (p.type === 'PATTERN' && doc.has(p.sourceNodeId) && !seen.has(p.sourceNodeId))
            for (const x of [p.sourceNodeId, ...doc.descendants(p.sourceNodeId)]) {
              if (seen.has(x)) continue;
              seen.add(x);
              subtree.push(x);
            }
    }
    for (const n of subtree) {
      for (const k of ['fills', 'strokes'] as const) for (const p of doc.get(n, k) ?? []) if (p.type === 'IMAGE' && p.imageHash) hashes.add(p.imageHash);
      if (doc.type(n) === 'TEXT' && !doc.get(n, 'textGlyphs')) await fonts.ensure(doc.get(n, 'fontName') ?? { family: 'Inter', style: 'Regular' });
    }
    await images.preload(hashes);
    const renderer = new SceneRenderer(ck, scene.blobs, images);
    renderer.setFonts(fonts);
    if (process.env.MFP_NO_IMAGE_FILTERS) renderer.flags.imageFilters = false;
    scene.attach(renderer);
    const nodes = isPage ? scene.page.children : [scene.node(id)!];
    let r: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const n of nodes) {
      const b = renderer.boundsOf(n);
      if (b) r = [Math.min(r[0], b[0] + 2), Math.min(r[1], b[1] + 2), Math.max(r[2], b[2] - 2), Math.max(r[3], b[3] - 2)];
    }
    if (opts.box && !isPage) {
      const m = scene.worldMatrix(scene.node(id)!);
      const w = doc.get(id, 'width') ?? 0;
      const h = doc.get(id, 'height') ?? 0;
      const xs = [0, w, 0, w].map((x, i) => m[0] * x + m[1] * [0, 0, h, h][i]! + m[2]);
      const ys = [0, w, 0, w].map((x, i) => m[3] * x + m[4] * [0, 0, h, h][i]! + m[5]);
      r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    if (!Number.isFinite(r[0])) throw new Error('Пустой узел — рисовать нечего');
    const s = Math.min(scale, 8192 / Math.max(1, r[2] - r[0]), 8192 / Math.max(1, r[3] - r[1]));
    const W = Math.max(1, Math.ceil((r[2] - r[0]) * s - 1e-6));
    const H = Math.max(1, Math.ceil((r[3] - r[1]) * s - 1e-6));
    const surface = ck.MakeSurface(W, H);
    if (!surface) throw new Error('Не удалось создать поверхность');
    try {
      const canvas = surface.getCanvas();
      const bg = isPage ? doc.get(id, 'backgrounds')?.[0] : undefined;
      canvas.clear(bg?.type === 'SOLID' ? ck.Color4f(bg.color.r, bg.color.g, bg.color.b, 1) : ck.TRANSPARENT);
      canvas.concat([s, 0, -r[0] * s, 0, s, -r[1] * s, 0, 0, 1]);
      if (isPage) renderer.render(canvas, nodes, r, s);
      else renderer.renderLive(canvas, nodes[0]!, scene.worldProj(scene.parent(nodes[0]!)), r, s);
      surface.flush();
      const snap = surface.makeImageSnapshot();
      const png = snap.encodeToBytes();
      snap.delete();
      if (!png) throw new Error('Не удалось закодировать PNG');
      return { png, width: W, height: H };
    } finally {
      surface.delete();
      renderer.dispose();
      images.dispose();
    }
  }

  /** Save .mfp (with images). */
  async save(path = this.path): Promise<{ path: string; bytes: number; missing: number }> {
    const out = extname(path).toLowerCase() === '.mfp' ? path : path.replace(/\.[^.\\/]*$/, '') + '.mfp';
    const { blob, missing } = await writeMfp(this.doc, this.images);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    writeFileSync(out, bytes);
    // From now on images come from the saved file (the source .fig could have been temporary).
    if (out !== this.path && extname(this.path).toLowerCase() !== '.fig') this.path = out;
    return { path: out, bytes: bytes.length, missing: missing.length };
  }

  /** Document summary. */
  info() {
    const doc = this.doc;
    const pages = userPages(doc).map((p) => {
      let nodes = 0;
      for (const _ of doc.descendants(p)) nodes++;
      return { id: p, name: doc.get(p, 'name') ?? '', nodes, topLevel: doc.children(p).length };
    });
    return { file: this.path, pages, images: imageHashes(doc).size };
  }

  /** Node properties for the agent to read (without bulky geometry). */
  describe(id: string, depth = 0): Record<string, unknown> {
    const doc = this.doc;
    const p = doc.node(id)!.props as Record<string, unknown>;
    const out: Record<string, unknown> = { id, type: doc.type(id) };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      if (k === 'textGlyphs') out[k] = '(готовые глифы из Figma)';
      else if (k === 'vectorPaths' || k === 'strokePaths') out[k] = `(${(v as unknown[]).length} контур(ов))`;
      else out[k] = v;
    }
    if (depth > 0) out.children = doc.children(id).map((c) => this.describe(c, depth - 1));
    else if (doc.children(id).length) out.childCount = doc.children(id).length;
    return out;
  }

  /** Short tree: id, type, name, position and size. */
  tree(id: string, depth: number): Record<string, unknown> {
    const doc = this.doc;
    const t = doc.get(id, 'transform');
    const out: Record<string, unknown> = { id, type: doc.type(id), name: doc.get(id, 'name') };
    if (t) Object.assign(out, { x: round(t[2]), y: round(t[5]), w: round(doc.get(id, 'width') ?? 0), h: round(doc.get(id, 'height') ?? 0) });
    if (doc.type(id) === 'TEXT') out.text = (doc.get(id, 'characters') ?? '').slice(0, 80);
    const kids = doc.children(id);
    if (kids.length) {
      if (depth > 0) out.children = kids.map((c) => this.tree(c, depth - 1));
      else out.childCount = kids.length;
    }
    return out;
  }

  find(q: { name?: string; type?: string; text?: string; within?: string; limit?: number }): Record<string, unknown>[] {
    const doc = this.doc;
    const out: Record<string, unknown>[] = [];
    const name = q.name?.toLowerCase();
    const text = q.text?.toLowerCase();
    for (const id of doc.descendants(q.within ?? doc.root)) {
      if (q.type && doc.type(id) !== q.type) continue;
      if (name && !(doc.get(id, 'name') ?? '').toLowerCase().includes(name)) continue;
      if (text && !(doc.get(id, 'characters') ?? '').toLowerCase().includes(text)) continue;
      out.push(this.tree(id, 0));
      if (out.length >= (q.limit ?? 50)) break;
    }
    return out;
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

export function readText(path: string) {
  return readFileSync(path, 'utf8');
}

export type { Props };
