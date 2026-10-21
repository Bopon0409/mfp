// Images from projects: team files on the server (and the open file), their pages and layers with images;
// replacing a layer's image happens in the open file through the editor (Ctrl+Z), in the others by updating
// the document on the server (like branches); the layer's previous properties are remembered for reverting.

import type { ImagePaint, Paint, Props } from '@mfp/core';
import { userPages } from '@mfp/core';
import type { Editor } from '../editor.ts';
import { docFromLoro } from '../loro-docs.ts';
import type { ServerLink } from './magnific.ts';
import { t } from '../i18n/index.ts';

type Doc = Editor['doc'];
type Bridge = Awaited<ReturnType<typeof docFromLoro>>['bridge'];

/** The MFP server on behalf of the signed-in user. */
export interface Cloud {
  api: <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<T>;
  signedIn(): boolean;
  teams(): { id: string; name: string }[];
  projects(): { id: string; teamId: string; name: string }[];
  /** The server file currently open in the editor; null for a local file. */
  openFileId(): string | null;
}

export interface FileRef {
  id: string;
  name: string;
  role?: string;
}

/** Where the image comes from: a layer in a file. hash is the layer's current image (new one after replacement). */
export interface ImageOrigin {
  /** Server file; null for the open local file (then doc). */
  fileId: string | null;
  fileName: string;
  /** Document of the open file (edited through the editor); null for the others. */
  doc: Doc | null;
  nodeId: string;
  hash: string;
  name: string;
  width: number;
  height: number;
}

export interface ImageLayer {
  id: string;
  name: string;
  hash: string;
  width: number;
  height: number;
}

export const topImage = (fills: Paint[] | undefined): ImagePaint | undefined =>
  [...(fills ?? [])].reverse().find((p): p is ImagePaint => p.type === 'IMAGE' && !!p.imageHash && p.visible !== false);

export const pagesOf = (doc: Doc) => userPages(doc).map((id) => ({ id, name: String(doc.get(id, 'name') || t('Страница')) }));

/** Layers with an image fill on the page (deep, in layer order). */
export function pageImages(doc: Doc, pageId: string, limit = 2000): ImageLayer[] {
  const out: ImageLayer[] = [];
  const walk = (id: string) => {
    for (const c of doc.children(id)) {
      if (out.length >= limit) return;
      const img = topImage(doc.get(c, 'fills') as Paint[] | undefined);
      if (img) out.push({ id: c, name: String(doc.get(c, 'name') || t('Картинка')), hash: img.imageHash!, width: Math.round(Number(doc.get(c, 'width') ?? 0)), height: Math.round(Number(doc.get(c, 'height') ?? 0)) });
      walk(c);
    }
  };
  walk(pageId);
  return out;
}

/** Name without the trailing size: “sword/200” → “sword” (icons laid out by graphs). */
export const baseName = (name: string) => name.replace(/\/\d+(?:[x×]\d+)?$/, '') || name;

/** “sword/200” becomes “sword/256” when 200×200 changes to 256×256; other names are left alone. */
export function renameSize(name: string, oldW: number, oldH: number, w: number, h: number): string {
  const m = /^(.*\/)(\d+)(?:[x×](\d+))?$/.exec(name);
  if (!m) return name;
  const a = Number(m[2]);
  const b = m[3] ? Number(m[3]) : a;
  if (a !== Math.round(oldW) || b !== Math.round(oldH)) return name;
  return `${m[1]}${w === h ? w : `${w}x${h}`}`;
}

/** New layer properties: the image is replaced; resize means the layer takes the image size. */
export function replacedProps(doc: Doc, origin: ImageOrigin, hash: string, width: number, height: number, resize: boolean): { before: Props; after: Props } {
  const id = origin.nodeId;
  if (!doc.has(id)) throw new Error(`Слоя «${origin.name}» больше нет в файле «${origin.fileName}»`);
  const fills = (doc.get(id, 'fills') ?? []) as Paint[];
  if (!fills.some((p) => p.type === 'IMAGE' && p.imageHash === origin.hash)) throw new Error(`Картинку слоя «${origin.name}» уже заменили — выберите её заново`);
  const oldW = Number(doc.get(id, 'width') ?? 0);
  const oldH = Number(doc.get(id, 'height') ?? 0);
  const name = String(doc.get(id, 'name') ?? '');
  const before: Props = { fills, width: oldW, height: oldH, name };
  const after: Props = {
    fills: fills.map((p) => {
      if (p.type !== 'IMAGE' || p.imageHash !== origin.hash) return p;
      // Tile: keep the previous pattern size on the canvas with a different image width
      const k = p.originalWidth ? width / p.originalWidth : 1;
      return { ...p, imageHash: hash, originalWidth: width, ...(p.scaleMode === 'TILE' ? { scalingFactor: (p.scalingFactor ?? 1) / k } : {}) };
    }),
  };
  if (resize) {
    after.width = width;
    after.height = height;
    const renamed = renameSize(name, oldW, oldH, width, height);
    if (renamed !== name) after.name = renamed;
  }
  return { before, after };
}

const fail = (e: unknown, file: string) => {
  const status = (e as { status?: number }).status;
  return new Error(status === 403 ? `Нет права на правку файла «${file}»` : `Файл «${file}»: ${(e as Error).message}`);
};

/** Documents of server files (snapshot + bridge for edits), one per file. */
export class CloudDocs {
  private readonly cloud: Cloud;
  private readonly editor: Editor;
  private cache = new Map<string, Promise<{ doc: Doc; bridge: Bridge | null }>>();

  constructor(editor: Editor, cloud: Cloud) {
    this.editor = editor;
    this.cloud = cloud;
  }

  /** File document: for the open one, the editor's live document; for the rest, a snapshot from the server. */
  open(fileId: string): Promise<{ doc: Doc; bridge: Bridge | null }> {
    if (fileId === this.cloud.openFileId()) return Promise.resolve({ doc: this.editor.doc, bridge: null });
    let p = this.cache.get(fileId);
    if (!p) {
      p = this.cloud.api<Uint8Array>('GET', `/api/files/${fileId}/doc`).then((bytes) => docFromLoro(bytes));
      p.catch(() => this.cache.delete(fileId));
      this.cache.set(fileId, p);
    }
    return p;
  }

  dispose() {
    for (const p of this.cache.values()) void p.then((x) => x.bridge?.dispose()).catch(() => undefined);
    this.cache.clear();
  }
}

/** Image bytes: from the editor store (open file) or from the server. */
export async function imageBlob(editor: Editor, server: ServerLink, origin: { doc: Doc | null; hash: string }, size?: number): Promise<Blob> {
  if (origin.doc && !size) {
    const bytes = await editor.store.readImage(origin.hash);
    if (bytes) return new Blob([bytes as BlobPart]);
  }
  const token = server.token();
  const res = await fetch(`${server.base()}/image/${origin.hash}${size ? `?size=${size}` : ''}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Картинка не загрузилась (${res.status})`);
  return res.blob();
}

/**
 * Image replacements in layers. Open file: an edit of the editor document (one group is one Ctrl+Z);
 * server file: an edit of its snapshot and sending the update (the CRDT merges it with others' edits).
 */
export class ImageWriter {
  private readonly editor: Editor;
  private readonly server: ServerLink;
  private readonly cloud: Cloud | null;
  private readonly docs: CloudDocs | null;
  private remote = new Map<string, ReturnType<Bridge['loro']['oplogVersion']>>();
  /** Replacements made, for “Revert”. */
  readonly done: { origin: ImageOrigin; before: Props; prev: { hash: string; width: number; height: number } }[] = [];

  constructor(editor: Editor, server: ServerLink, cloud: Cloud | null) {
    this.editor = editor;
    this.server = server;
    this.cloud = cloud;
    this.docs = cloud ? new CloudDocs(editor, cloud) : null;
  }

  private liveDoc(origin: ImageOrigin): Doc | null {
    if (origin.doc && origin.doc === this.editor.doc) return origin.doc;
    if (origin.fileId && origin.fileId === this.cloud?.openFileId()) return this.editor.doc;
    if (!origin.fileId) throw new Error(`Файл «${origin.fileName}» закрыт — откройте его снова`);
    return null;
  }

  private async upload(hash: string, bytes: Uint8Array) {
    const token = this.server.token();
    const url = `${this.server.base()}/image/${hash}`;
    const headers: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
    if ((await fetch(url, { method: 'HEAD', headers })).ok) return;
    const res = await fetch(url, { method: 'PUT', headers, body: bytes as BufferSource });
    if (!res.ok) throw new Error(`Картинка не загрузилась на сервер (${res.status})`);
  }

  /** Layer properties in a file: in the open one, immediately; on the server, by sending an update. */
  private async write(origin: ImageOrigin, build: (doc: Doc) => Props) {
    const live = this.liveDoc(origin);
    if (live) {
      const props = build(live);
      live.beginGroup();
      try {
        live.set(origin.nodeId, props);
      } finally {
        live.endGroup();
      }
      return;
    }
    const fileId = origin.fileId!;
    const { doc, bridge } = await this.docs!.open(fileId);
    if (!bridge) throw new Error('Файл открыт — повторите');
    if (!this.remote.has(fileId)) this.remote.set(fileId, bridge.loro.oplogVersion());
    doc.set(origin.nodeId, build(doc));
    try {
      await this.cloud!.api('POST', `/api/files/${fileId}/doc`, bridge.exportUpdate(this.remote.get(fileId)));
    } catch (e) {
      throw fail(e, origin.fileName);
    }
    this.remote.set(fileId, bridge.loro.oplogVersion());
  }

  /** Replace a layer's image; resize means the layer takes the image size (name “x/200” → “x/256”). */
  async replace(origin: ImageOrigin, blob: Blob, width: number, height: number, resize: boolean) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await this.editor.store.add(bytes);
    if (!this.liveDoc(origin)) await this.upload(hash, bytes);
    let before: Props = {};
    await this.write(origin, (doc) => {
      const p = replacedProps(doc, origin, hash, width, height, resize);
      before = p.before;
      return p.after;
    });
    this.done.push({ origin, before, prev: { hash: origin.hash, width: origin.width, height: origin.height } });
    origin.hash = hash;
    origin.width = resize ? width : origin.width;
    origin.height = resize ? height : origin.height;
  }

  /** Revert everything that was replaced (in reverse order). */
  async revert(): Promise<number> {
    let n = 0;
    while (this.done.length) {
      const d = this.done.pop()!;
      await this.write(d.origin, () => d.before);
      Object.assign(d.origin, d.prev);
      n++;
    }
    return n;
  }

  get remoteCount() {
    return this.done.filter((d) => d.origin.fileId && d.origin.fileId !== this.cloud?.openFileId()).length;
  }

  dispose() {
    this.docs?.dispose();
  }
}
