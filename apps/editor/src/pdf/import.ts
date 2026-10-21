// PDF import: each page becomes a frame (in a grid on one canvas page). Paths become vectors
// (color or gradient, stroke with width, caps and dashes), text becomes text layers (lines along the
// baseline, font by name, known ones as metric-compatible free fonts), images become rectangles
// with an image fill (JPEG as is, the rest as PNG with alpha from SMask), clipping becomes groups
// with a mask (a rectangular clip that fully contains the object — no group).

import { Document, type Paint as DocPaint, type Props } from '@mfp/core';
import { fitGroup } from '@mfp/editing';
import type { ImageBytesSource } from '@mfp/io-figma';
import { colorSpace, runPage, type Clip, type Item, type M, type Paint, type PathData, type RGBA } from './content.ts';
import { PdfDict, PdfFile, PdfName, PdfStream, type PdfObj } from './parser.ts';

export interface PdfImport {
  doc: Document;
  images: ImageBytesSource;
  pages: number;
  warnings: string[];
}

const GAP = 100;
const PER_ROW = 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export async function importPdf(bytes: Uint8Array, name: string, onProgress?: (page: number, total: number) => void): Promise<PdfImport> {
  const file = await PdfFile.open(bytes);
  if (file.trailer.get('Encrypt')) throw new Error('PDF зашифрован — откройте его без пароля и сохраните заново');
  const catalog = await file.dict(file.trailer.get('Root'));
  if (!catalog) throw new Error('Не PDF или файл повреждён');
  const pages = await collectPages(file, await file.dict(catalog.get('Pages')));
  if (!pages.length) throw new Error('В PDF нет страниц');
  const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
  const canvas = doc.create('PAGE', doc.root, { name });
  const images = new Map<string, Uint8Array>();
  const imageCache = new Map<PdfStream, Promise<string | null>>();
  const warnings = new Set<string>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i, pages.length);
    const p = pages[i]!;
    const box = p.box;
    const rot = ((p.rotate % 360) + 360) % 360;
    const W = box[2] - box[0];
    const H = box[3] - box[1];
    const [fw, fh] = rot === 90 || rot === 270 ? [H, W] : [W, H];
    // PDF page space (y up) → frame (y down) with page rotation.
    const base: M =
      rot === 90 ? [0, 1, -box[1], 1, 0, -box[0]] : rot === 180 ? [-1, 0, box[2], 0, 1, -box[1]] : rot === 270 ? [0, -1, box[3], -1, 0, box[2]] : [1, 0, -box[0], 0, -1, box[3]];
    const content = await pageContent(file, p.dict);
    const { items, warnings: w } = await runPage(file, content, p.resources, base);
    for (const k of w) warnings.add(k);
    if (i && i % PER_ROW === 0) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    const frame = doc.create('FRAME', canvas, { name: `Страница ${i + 1}`, transform: [1, 0, x, 0, 1, y], width: r2(fw), height: r2(fh), fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], clipsContent: true });
    x += fw + GAP;
    rowH = Math.max(rowH, fh);
    await buildItems(doc, frame, items, file, images, imageCache, warnings, [fw, fh]);
  }
  doc.clearHistory();
  return { doc, images: { readImage: async (h) => images.get(h) }, pages: pages.length, warnings: [...warnings] };
}

interface PageInfo {
  dict: PdfDict;
  resources: PdfDict | null;
  box: [number, number, number, number];
  rotate: number;
}

/** Pages from the /Pages tree (resources, boxes and rotation are inherited). */
async function collectPages(file: PdfFile, root: PdfDict | null): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  const seen = new Set<PdfDict>();
  const box = async (o: PdfObj | undefined): Promise<[number, number, number, number] | null> => {
    const a = await file.array(o);
    if (!a || a.length < 4) return null;
    const v = await Promise.all(a.slice(0, 4).map((x) => file.num(x)));
    return [Math.min(v[0]!, v[2]!), Math.min(v[1]!, v[3]!), Math.max(v[0]!, v[2]!), Math.max(v[1]!, v[3]!)];
  };
  const walk = async (node: PdfDict, inherited: { resources: PdfDict | null; media: [number, number, number, number] | null; crop: [number, number, number, number] | null; rotate: number }) => {
    if (seen.has(node) || out.length > 5000) return;
    seen.add(node);
    const resources = (await file.dict(node.get('Resources'))) ?? inherited.resources;
    const media = (await box(node.get('MediaBox'))) ?? inherited.media;
    const crop = (await box(node.get('CropBox'))) ?? inherited.crop;
    const rotate = node.has('Rotate') ? await file.num(node.get('Rotate')) : inherited.rotate;
    const kids = await file.array(node.get('Kids'));
    const type = (node.get('Type') as PdfName | undefined)?.v;
    if (kids && type !== 'Page') {
      for (const k of kids) {
        const d = await file.dict(k);
        if (d) await walk(d, { resources, media, crop, rotate });
      }
      return;
    }
    const m = media ?? [0, 0, 612, 792];
    // Crop box within the page.
    const c = crop ? ([Math.max(m[0], crop[0]), Math.max(m[1], crop[1]), Math.min(m[2], crop[2]), Math.min(m[3], crop[3])] as [number, number, number, number]) : m;
    out.push({ dict: node, resources, box: c[2] > c[0] && c[3] > c[1] ? c : m, rotate });
  };
  if (root) await walk(root, { resources: null, media: null, crop: null, rotate: 0 });
  return out;
}

async function pageContent(file: PdfFile, page: PdfDict): Promise<Uint8Array> {
  const c = await file.resolve(page.get('Contents'));
  const streams = Array.isArray(c) ? await Promise.all(c.map((x) => file.resolve(x))) : [c];
  const parts: Uint8Array[] = [];
  for (const s of streams) if (s instanceof PdfStream) parts.push(await file.decode(s), new Uint8Array([10]));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------- Layers ----------

const pathSvg = (p: PathData, dx: number, dy: number) =>
  p.cmds
    .map((c) => {
      if (c[0] === 'Z') return 'Z';
      const pts: string[] = [];
      for (let i = 1; i < c.length; i += 2) pts.push(`${r2((c[i] as number) - dx)} ${r2((c[i + 1] as number) - dy)}`);
      return `${c[0]} ${pts.join(' ')}`;
    })
    .join(' ');

const clipKey = (c: Clip) => `${c.evenOdd ? 'e' : 'n'}${pathSvg(c.path, 0, 0)}`;

/** Whether a path is an axis-aligned rectangle — and its bounds. */
function rectOf(p: PathData): [number, number, number, number] | null {
  const pts = p.cmds.filter((c) => c[0] === 'M' || c[0] === 'L') as ['M' | 'L', number, number][];
  if (p.cmds.some((c) => c[0] === 'C') || pts.length < 4 || pts.length > 5) return null;
  const xs = new Set(pts.map((c) => Math.round(c[1] * 100)));
  const ys = new Set(pts.map((c) => Math.round(c[2] * 100)));
  return xs.size <= 2 && ys.size <= 2 ? p.box : null;
}

function itemBox(it: Item): [number, number, number, number] {
  if (it.kind === 'path') {
    const s = it.stroke ? it.stroke.width / 2 : 0;
    return [it.path.box[0] - s, it.path.box[1] - s, it.path.box[2] + s, it.path.box[3] + s];
  }
  if (it.kind === 'image') {
    const m = it.m;
    const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => [m[0] * u! + m[1] * v! + m[2], m[3] * u! + m[4] * v! + m[5]]);
    return [Math.min(...pts.map((p) => p[0]!)), Math.min(...pts.map((p) => p[1]!)), Math.max(...pts.map((p) => p[0]!)), Math.max(...pts.map((p) => p[1]!))];
  }
  return [it.x - 1, it.y - it.size, it.x + it.width + 1, it.y + it.size * 0.3];
}

/** The object's clip chain (outside in) without rectangles that fully contain it. */
function clipChain(it: Item, frame: [number, number]): Clip[] {
  const box = itemBox(it);
  const out: Clip[] = [];
  for (let c = it.clip; c; c = c.parent) {
    const r = rectOf(c.path);
    // Clipping to the whole page or wider is not needed (the frame clips anyway).
    if (r && r[0] <= Math.max(box[0], 0) + 0.5 && r[1] <= Math.max(box[1], 0) + 0.5 && r[2] >= Math.min(box[2], frame[0]) - 0.5 && r[3] >= Math.min(box[3], frame[1]) - 0.5) continue;
    out.unshift(c);
  }
  return out;
}

const solid = (c: RGBA): DocPaint => ({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, ...(c.a < 1 ? { opacity: c.a } : {}) });

/** Paint in layer coordinates (bounds — box). */
function docPaint(p: Paint, box: [number, number, number, number]): DocPaint | null {
  if (p.kind === 'solid') return p.color.a > 0 ? solid(p.color) : null;
  const w = Math.max(1e-6, box[2] - box[0]);
  const h = Math.max(1e-6, box[3] - box[1]);
  // G: gradient space → layer pixels; gradientTransform = G⁻¹ · (w, h).
  let G: M;
  if (p.kind === 'linear') {
    const x0 = p.p0[0] - box[0];
    const y0 = p.p0[1] - box[1];
    const dx = p.p1[0] - p.p0[0];
    const dy = p.p1[1] - p.p0[1];
    if (Math.hypot(dx, dy) < 1e-9) return p.stops[0] ? solid(p.stops[0].color) : null;
    G = [dx, -dy, x0 + 0.5 * dy, dy, dx, y0 - 0.5 * dx];
  } else {
    const r = Math.max(1e-6, p.r1 ?? 1);
    const cx = p.p1[0] - box[0];
    const cy = p.p1[1] - box[1];
    G = [2 * r, 0, cx - r, 0, 2 * r, cy - r];
  }
  const det = G[0] * G[4] - G[1] * G[3];
  if (Math.abs(det) < 1e-12) return null;
  const inv: M = [G[4] / det, -G[1] / det, (G[1] * G[5] - G[4] * G[2]) / det, -G[3] / det, G[0] / det, (G[3] * G[2] - G[0] * G[5]) / det];
  const t: M = [inv[0] * w, inv[1] * h, inv[2], inv[3] * w, inv[4] * h, inv[5]];
  return {
    type: p.kind === 'linear' ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL',
    gradientTransform: [
      [t[0], t[1], t[2]],
      [t[3], t[4], t[5]],
    ],
    gradientStops: p.stops.map((s) => ({ position: s.pos, color: { ...s.color } })),
    ...(p.alpha < 1 ? { opacity: p.alpha } : {}),
  } as DocPaint;
}

async function buildItems(doc: Document, frame: string, items: Item[], file: PdfFile, images: Map<string, Uint8Array>, cache: Map<PdfStream, Promise<string | null>>, warnings: Set<string>, size: [number, number]) {
  // Open clip groups: path key and group id.
  const open: { key: string; id: string }[] = [];
  const parentOf = () => open[open.length - 1]?.id ?? frame;
  const close = (n: number) => {
    while (open.length > n) {
      const g = open.pop()!;
      if (doc.children(g.id).length > 1) fitGroup(doc, g.id);
      else doc.delete(g.id);
    }
  };
  let n = 0;
  for (const it of items) {
    const chain = clipChain(it, size);
    const keys = chain.map(clipKey);
    let common = 0;
    while (common < open.length && common < keys.length && open[common]!.key === keys[common]) common++;
    close(common);
    for (let k = common; k < chain.length; k++) {
      const c = chain[k]!;
      const g = doc.create('GROUP', parentOf(), { name: 'Обрезка', width: size[0], height: size[1] });
      const b = c.path.box;
      const w = Math.max(0.01, b[2] - b[0]);
      const h = Math.max(0.01, b[3] - b[1]);
      doc.create('VECTOR', g, {
        name: 'Маска',
        transform: [1, 0, b[0], 0, 1, b[1]],
        width: w,
        height: h,
        geometrySize: { width: w, height: h },
        vectorPaths: [{ windingRule: c.evenOdd ? 'EVENODD' : 'NONZERO', data: pathSvg(c.path, b[0], b[1]) }],
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
        isMask: true,
        maskType: 'VECTOR',
      });
      open.push({ key: keys[k]!, id: g });
    }
    const parent = parentOf();
    if (it.kind === 'path') {
      const b = it.path.box;
      if (!Number.isFinite(b[0])) continue;
      const w = Math.max(0.01, b[2] - b[0]);
      const h = Math.max(0.01, b[3] - b[1]);
      const fill = it.fill ? docPaint(it.fill, b) : null;
      const stroke = it.stroke ? docPaint(it.stroke.paint, b) : null;
      if (!fill && !stroke) continue;
      const props: Props = {
        name: 'Контур',
        transform: [1, 0, b[0], 0, 1, b[1]],
        width: w,
        height: h,
        geometrySize: { width: w, height: h },
        vectorPaths: [{ windingRule: it.evenOdd ? 'EVENODD' : 'NONZERO', data: pathSvg(it.path, b[0], b[1]) }],
        fills: fill ? [fill] : [],
        strokes: stroke ? [stroke] : [],
        strokeWeight: it.stroke ? r2(it.stroke.width) : 1,
        strokeAlign: 'CENTER',
        ...(it.blend ? { blendMode: it.blend as Props['blendMode'] } : {}),
      };
      if (it.stroke) {
        props.strokeJoin = it.stroke.join === 1 ? 'ROUND' : it.stroke.join === 2 ? 'BEVEL' : 'MITER';
        const cap = it.stroke.cap === 1 ? 'ROUND' : it.stroke.cap === 2 ? 'SQUARE' : null;
        if (cap) props.strokeStartCap = props.strokeEndCap = cap;
        if (it.stroke.miter !== 4) props.strokeMiterLimit = Math.max(1, it.stroke.miter);
        const dash = it.stroke.dash.filter((v) => Number.isFinite(v) && v >= 0);
        if (dash.some((v) => v > 0)) props.dashPattern = dash.length % 2 ? [...dash, ...dash] : dash;
      }
      doc.create('VECTOR', parent, props);
    } else if (it.kind === 'text') {
      const asc = it.font.ascent * it.size;
      const cos = Math.cos(it.angle);
      const sin = Math.sin(it.angle);
      doc.create('TEXT', parent, {
        name: it.text.trim().slice(0, 40),
        characters: it.text.replace(/\s+$/, ''),
        fontName: { family: it.font.family, style: it.font.style },
        fontSize: r2(it.size),
        textAutoResize: 'WIDTH_AND_HEIGHT',
        transform: [cos, -sin, it.x + sin * asc, sin, cos, it.y - cos * asc],
        fills: it.stroke ? [] : [solid(it.color)],
        ...(it.stroke ? { strokes: [solid(it.color)], strokeWeight: Math.max(0.5, it.size / 30) } : {}),
      });
    } else {
      let p = cache.get(it.image);
      if (!p) {
        p = decodeImage(file, it.image, it.stencil, images, warnings);
        cache.set(it.image, p);
      }
      const hash = await p;
      if (!hash) continue;
      const m = it.m;
      const w = Math.hypot(m[0], m[3]);
      const h = Math.hypot(m[1], m[4]);
      if (w < 0.01 || h < 0.01) continue;
      doc.create('RECTANGLE', parent, {
        name: 'Картинка',
        transform: [m[0] / w, -m[1] / h, m[1] + m[2], m[3] / w, -m[4] / h, m[4] + m[5]],
        width: r2(w),
        height: r2(h),
        fills: [{ type: 'IMAGE', scaleMode: 'CROP', imageHash: hash, imageTransform: [[1, 0, 0], [0, 1, 0]] }],
        ...(it.alpha < 1 ? { opacity: it.alpha } : {}),
        ...(it.blend ? { blendMode: it.blend as Props['blendMode'] } : {}),
      });
    }
    // Don't block the thread: yield occasionally (large pages).
    if (++n % 2000 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  close(0);
}

// ---------- Images ----------

async function sha1(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function png(rgba: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const oc = new OffscreenCanvas(w, h);
  oc.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

/** Image samples (not compressed with image filters) → RGBA. */
async function samples(file: PdfFile, s: PdfStream, stencil?: RGBA): Promise<{ rgba: Uint8ClampedArray; w: number; h: number } | null> {
  const d = s.dict;
  const w = await file.num(d.get('Width'), 0);
  const h = await file.num(d.get('Height'), 0);
  if (!w || !h || w * h > 64e6) return null;
  const data = await file.decode(s);
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (stencil) {
    // Stencil: 0 — paint, 1 — transparent (Decode [1 0] — the other way round).
    const dec = (await file.array(d.get('Decode'))) ?? [0, 1];
    const inv = dec[0] === 1;
    const row = Math.ceil(w / 8);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bit = (data[y * row + (x >> 3)]! >> (7 - (x & 7))) & 1;
        const on = inv ? bit === 1 : bit === 0;
        const o = (y * w + x) * 4;
        rgba[o] = stencil.r * 255;
        rgba[o + 1] = stencil.g * 255;
        rgba[o + 2] = stencil.b * 255;
        rgba[o + 3] = on ? stencil.a * 255 : 0;
      }
    return { rgba, w, h };
  }
  const bpc = await file.num(d.get('BitsPerComponent'), 8);
  const cs = await colorSpace(file, d.get('ColorSpace'), null);
  const n = cs.n;
  const decode = ((await file.array(d.get('Decode'))) ?? []).map((x) => (typeof x === 'number' ? x : 0));
  const max = 2 ** bpc - 1;
  const rowBytes = Math.ceil((w * n * bpc) / 8);
  const csName = await file.resolve(d.get('ColorSpace'));
  const indexed = Array.isArray(csName) && csName[0] instanceof PdfName && (csName[0].v === 'Indexed' || csName[0].v === 'I');
  // Fast paths: 8-bit RGB, gray, CMYK, indexed.
  if (bpc === 8 && !decode.length && (n === 3 || n === 1 || n === 4) && !indexed && csName instanceof PdfName) {
    for (let i = 0, j = 0; i < w * h; i++, j += n) {
      const o = i * 4;
      if (n === 3) {
        rgba[o] = data[j]!;
        rgba[o + 1] = data[j + 1]!;
        rgba[o + 2] = data[j + 2]!;
      } else if (n === 1) rgba[o] = rgba[o + 1] = rgba[o + 2] = data[j]!;
      else {
        const k = 1 - data[j + 3]! / 255;
        rgba[o] = (255 - data[j]!) * k;
        rgba[o + 1] = (255 - data[j + 1]!) * k;
        rgba[o + 2] = (255 - data[j + 2]!) * k;
      }
      rgba[o + 3] = 255;
    }
    return { rgba, w, h };
  }
  const lut = indexed ? Array.from({ length: max + 1 }, (_, i) => cs.toRGB([i])) : null;
  for (let y = 0; y < h; y++) {
    let bit = y * rowBytes * 8;
    for (let x = 0; x < w; x++) {
      const comps: number[] = [];
      for (let c = 0; c < n; c++) {
        let v = 0;
        if (bpc === 8) v = data[bit >> 3]!;
        else if (bpc === 16) v = (data[bit >> 3]! << 8) | data[(bit >> 3) + 1]!;
        else for (let k = 0; k < bpc; k++) v = (v << 1) | ((data[(bit + k) >> 3]! >> (7 - ((bit + k) & 7))) & 1);
        bit += bpc;
        if (indexed) comps.push(decode.length ? decode[0]! + (v * (decode[1]! - decode[0]!)) / max : v);
        else comps.push(decode.length ? decode[2 * c]! + (v / max) * (decode[2 * c + 1]! - decode[2 * c]!) : v / max);
      }
      const col = lut ? lut[Math.max(0, Math.min(max, Math.round(comps[0]!)))]! : cs.toRGB(comps);
      const o = (y * w + x) * 4;
      rgba[o] = col.r * 255;
      rgba[o + 1] = col.g * 255;
      rgba[o + 2] = col.b * 255;
      rgba[o + 3] = 255;
    }
  }
  return { rgba, w, h };
}

/** PDF image → hash in storage (JPEG as is if it has no transparency; otherwise PNG). */
async function decodeImage(file: PdfFile, s: PdfStream, stencil: RGBA | undefined, store: Map<string, Uint8Array>, warnings: Set<string>): Promise<string | null> {
  try {
    const filter = await file.imageFilter(s);
    const smask = await file.resolve(s.dict.get('SMask'));
    const mask = await file.resolve(s.dict.get('Mask'));
    let img: { rgba: Uint8ClampedArray; w: number; h: number } | null = null;
    if (filter === 'DCTDecode' || filter === 'DCT' || filter === 'JPXDecode') {
      const coded = await file.decode(s);
      if (filter !== 'JPXDecode' && !(smask instanceof PdfStream) && !(mask instanceof PdfStream) && !Array.isArray(mask)) {
        const h = await sha1(coded);
        store.set(h, coded);
        return h;
      }
      const bmp = await createImageBitmap(new Blob([coded as BlobPart], { type: filter === 'JPXDecode' ? 'image/jp2' : 'image/jpeg' })).catch(() => null);
      if (!bmp) {
        warnings.add(filter === 'JPXDecode' ? 'Картинки JPEG 2000 не открываются браузером — пропущены' : 'Часть картинок не прочиталась');
        return null;
      }
      const oc = new OffscreenCanvas(bmp.width, bmp.height);
      const g = oc.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      img = { rgba: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
      bmp.close();
    } else if (filter) {
      warnings.add('Картинки CCITT и JBIG2 (сканы) пока не переносятся');
      return null;
    } else img = await samples(file, s, stencil);
    if (!img) return null;
    // Transparency: SMask (gray is alpha), Mask (stencil or color key).
    const alphaFrom = async (m: PdfStream, invert: boolean) => {
      const a = await samples(file, m, invert ? { r: 0, g: 0, b: 0, a: 1 } : undefined);
      if (!a) return;
      for (let y = 0; y < img!.h; y++)
        for (let x = 0; x < img!.w; x++) {
          const sx = Math.min(a.w - 1, Math.floor((x * a.w) / img!.w));
          const sy = Math.min(a.h - 1, Math.floor((y * a.h) / img!.h));
          const so = (sy * a.w + sx) * 4;
          img!.rgba[(y * img!.w + x) * 4 + 3] = invert ? a.rgba[so + 3]! : a.rgba[so]!;
        }
    };
    if (smask instanceof PdfStream) await alphaFrom(smask, false);
    else if (mask instanceof PdfStream) await alphaFrom(mask, true);
    const bytes = await png(img.rgba, img.w, img.h);
    const h = await sha1(bytes);
    store.set(h, bytes);
    return h;
  } catch (e) {
    warnings.add('Часть картинок не прочиталась');
    console.warn('PDF: картинка', e);
    return null;
  }
}

