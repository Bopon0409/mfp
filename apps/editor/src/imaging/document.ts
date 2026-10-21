// Everything “Image enhancements” writes to the document: replacing the image in layer fills, a new image
// on the page, and frames of the required sizes (icons) on the chosen page. Each action is one undo step.

import type { ExportSetting, ImagePaint, Paint } from '@mfp/core';
import type { Editor } from '../editor.ts';
import type { ImageOrigin } from './projects.ts';
import { t } from '../i18n/index.ts';

/** The server accepts images up to 64 MB; larger ones are not put into the document. */
export const DOC_MAX_BYTES = 64 * 2 ** 20;

/** Image of the selected layers: all selected layers whose fill has that same image. */
export interface ImageTarget {
  ids: string[];
  hash: string;
  name: string;
  /** Taken via “From project…”: a layer in this or another file. */
  origin?: ImageOrigin;
}

export function imageTarget(editor: Editor, ids: string[]): ImageTarget | null {
  const doc = editor.doc;
  let hash: string | null = null;
  const owners: string[] = [];
  for (const id of ids) {
    if (!doc.has(id)) continue;
    const fills = (doc.get(id, 'fills') ?? []) as Paint[];
    const top = [...fills].reverse().find((p): p is ImagePaint => p.type === 'IMAGE' && !!p.imageHash && p.visible !== false);
    if (!top) continue;
    hash ??= top.imageHash;
    if (fills.some((p) => p.type === 'IMAGE' && p.imageHash === hash)) owners.push(id);
  }
  if (!hash || !owners.length) return null;
  return { ids: owners, hash, name: String(doc.get(owners[0]!, 'name') || t('Картинка')) };
}

const grouped = <T>(editor: Editor, fn: () => T): T => {
  editor.doc.beginGroup();
  try {
    return fn();
  } finally {
    editor.doc.endGroup();
  }
};

/** A new image replaces the old one in layer fills; factor is how many times it grew (for TILE). */
export async function replaceImage(editor: Editor, target: ImageTarget, blob: Blob, width: number, factor: number): Promise<string[]> {
  const doc = editor.doc;
  const ids = target.ids.filter((id) => doc.has(id));
  if (!ids.length) throw new Error('Слоя с этой картинкой больше нет в документе');
  const hash = await editor.store.add(new Uint8Array(await blob.arrayBuffer()));
  grouped(editor, () => {
    for (const id of ids) {
      const fills = (doc.get(id, 'fills') ?? []) as Paint[];
      doc.set(id, {
        fills: fills.map((p) =>
          p.type === 'IMAGE' && p.imageHash === target.hash
            ? { ...p, imageHash: hash, originalWidth: width, ...(p.scaleMode === 'TILE' ? { scalingFactor: (p.scalingFactor ?? 1) / factor } : {}) }
            : p,
        ),
      });
    }
  });
  editor.select(ids);
  return ids;
}

/** Image as a new layer in the center of the visible part of the current page (a large one is scaled down to 80% of the view). */
export async function insertImage(editor: Editor, blob: Blob, width: number, height: number, name: string): Promise<string> {
  const hash = await editor.store.add(new Uint8Array(await blob.arrayBuffer()));
  const v = editor.viewportRect();
  const s = Math.min(1, ((v[2] - v[0]) * 0.8) / width, ((v[3] - v[1]) * 0.8) / height);
  const [w, h] = [Math.round(width * s), Math.round(height * s)];
  const [cx, cy] = [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2];
  const id = grouped(editor, () =>
    editor.doc.create('RECTANGLE', editor.pageId, {
      name,
      transform: [1, 0, Math.round(cx - w / 2), 0, 1, Math.round(cy - h / 2)],
      width: w,
      height: h,
      fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: hash, originalWidth: width }],
    }),
  );
  editor.select([id]);
  return id;
}

export const pages = (editor: Editor) => editor.doc.children(editor.doc.root).filter((id) => editor.doc.type(id) === 'PAGE');

/** Page by name; if there is none, it is created at the end of the list. */
export function findOrCreatePage(editor: Editor, name: string): string {
  const doc = editor.doc;
  const found = pages(editor).find((id) => String(doc.get(id, 'name')) === name);
  if (found) return found;
  return grouped(editor, () => doc.create('PAGE', doc.root, { name }));
}

/** Bottom edge of the page content: new rows go below it without overlapping anything. */
function contentBottom(editor: Editor, pageId: string): { left: number; bottom: number } | null {
  const doc = editor.doc;
  let left = Infinity;
  let bottom = -Infinity;
  for (const id of doc.children(pageId)) {
    const t = doc.get(id, 'transform') as number[] | undefined;
    const x = t?.[2] ?? 0;
    const y = t?.[5] ?? 0;
    left = Math.min(left, x);
    bottom = Math.max(bottom, y + Number(doc.get(id, 'height') ?? 0));
  }
  return Number.isFinite(bottom) ? { left, bottom } : null;
}

export interface Variant {
  width: number;
  height: number;
  blob: Blob;
}

const EXPORT_PNG: ExportSetting[] = [{ format: 'PNG', suffix: '', constraint: { type: 'SCALE', value: 1 } }];
const GAP = 40;
const ROW_GAP = 80;

/** Row layout on the page: each row is one image in all sizes, left to right. */
export class PagePlacer {
  private readonly editor: Editor;
  readonly pageId: string;
  private x: number;
  private y: number;

  constructor(editor: Editor, pageId: string) {
    this.editor = editor;
    this.pageId = pageId;
    const b = contentBottom(editor, pageId);
    this.x = b ? Math.round(b.left) : 0;
    this.y = b ? Math.round(b.bottom + ROW_GAP * 2) : 0;
  }

  /** Frames “name/width” with the image and a PNG 1x export; transparent background. */
  place(name: string, variants: Variant[]): Promise<string[]> {
    return this.placeRow(variants.map((v) => ({ ...v, name: `${name}/${v.width === v.height ? v.width : `${v.width}x${v.height}`}` })));
  }

  /** A row of frames with their own names (graph outputs for one item of a batch). */
  async placeRow(variants: (Variant & { name: string })[]): Promise<string[]> {
    const doc = this.editor.doc;
    const hashes = await Promise.all(variants.map(async (v) => this.editor.store.add(new Uint8Array(await v.blob.arrayBuffer()))));
    const ids = grouped(this.editor, () => {
      let x = this.x;
      const out: string[] = [];
      variants.forEach((v, i) => {
        out.push(
          doc.create('FRAME', this.pageId, {
            name: v.name,
            transform: [1, 0, x, 0, 1, this.y],
            width: v.width,
            height: v.height,
            fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: hashes[i]!, originalWidth: v.width }],
            exportSettings: EXPORT_PNG,
          }),
        );
        x += v.width + GAP;
      });
      return out;
    });
    this.y += Math.max(...variants.map((v) => v.height)) + ROW_GAP;
    return ids;
  }
}
