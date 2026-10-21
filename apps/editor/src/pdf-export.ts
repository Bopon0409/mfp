// PDF export: a page per frame (or the combined bounds of the selection), vector — from the same
// scene the canvas draws. Paths, fills (color, linear and radial gradient, images), strokes (as
// outlines), text as outlines (text-outline.ts), frame clipping, opacity and blend modes as
// transparency groups. What PDF lacks (shadows, blur, masks, angular and diamond gradients, image
// adjustments, gradients with varying stop opacity) — the node is rendered as an image.
// Page coordinates: 1 px = 1 pt, Y axis down (flipped at the start of the page).
// CMYK print (print.cmyk): colors via k / K operators, gradients and images in DeviceCMYK
// (conversion via the print profile the user chose, or approximate), transparency groups in CMYK,
// crop marks in registration color; the profile is embedded in the file (OutputIntent).

import type { SceneRenderer } from '@mfp/renderer';
import { blobToSvgPath, hashToHex, type FigPaint, type Matrix2D, type SceneNode } from '@mfp/io-figma';
import { cmykTable, invert, multiply, type Matrix } from '@mfp/core';
import type { Editor } from './editor.ts';
import { textOutlines } from './text-outline.ts';

type M = Matrix2D;
type Rect = [number, number, number, number];
const enc = new TextEncoder();
const RECT_LIKE = new Set(['FRAME', 'SYMBOL', 'INSTANCE', 'SECTION', 'RECTANGLE', 'ROUNDED_RECTANGLE']);
const BLEND: Record<string, string> = {
  MULTIPLY: 'Multiply',
  SCREEN: 'Screen',
  OVERLAY: 'Overlay',
  DARKEN: 'Darken',
  LIGHTEN: 'Lighten',
  COLOR_DODGE: 'ColorDodge',
  COLOR_BURN: 'ColorBurn',
  HARD_LIGHT: 'HardLight',
  SOFT_LIGHT: 'SoftLight',
  DIFFERENCE: 'Difference',
  EXCLUSION: 'Exclusion',
  HUE: 'Hue',
  SATURATION: 'Saturation',
  COLOR: 'Color',
  LUMINOSITY: 'Luminosity',
};
/** Raster embedding: pixels per page unit (soft shadows need fewer). */
const RASTER_SCALE = 2;
const SHADOW_SCALE = 1;

const f = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const mat = (m: M) => `${f(m[0])} ${f(m[3])} ${f(m[1])} ${f(m[4])} ${f(m[2])} ${f(m[5])} cm`;
const mul = (a: M, b: M) => multiply(a as Matrix, b as Matrix) as M;
const inv = (m: M) => invert(m as Matrix) as M;

async function deflate(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The PDF file itself: numbered objects, cross-reference table. */
export class PdfFile {
  private objs: Uint8Array[] = [];
  alloc(): number {
    this.objs.push(new Uint8Array());
    return this.objs.length;
  }
  put(n: number, body: string | Uint8Array) {
    this.objs[n - 1] = typeof body === 'string' ? enc.encode(body) : body;
  }
  add(body: string | Uint8Array): number {
    const n = this.alloc();
    this.put(n, body);
    return n;
  }
  async stream(dict: string, data: Uint8Array | string, filter?: string, n = this.alloc()): Promise<number> {
    let bytes = typeof data === 'string' ? enc.encode(data) : data;
    if (!filter) {
      bytes = await deflate(bytes);
      filter = '/FlateDecode';
    }
    this.put(n, concat([enc.encode(`<< ${dict} /Length ${bytes.length} /Filter ${filter} >>\nstream\n`), bytes, enc.encode('\nendstream')]));
    return n;
  }
  finish(root: number, info: number): Uint8Array {
    const parts: Uint8Array[] = [enc.encode('%PDF-1.7\n'), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
    let offset = parts[0]!.length + parts[1]!.length;
    const offsets: number[] = [];
    this.objs.forEach((body, i) => {
      offsets.push(offset);
      const chunk = concat([enc.encode(`${i + 1} 0 obj\n`), body, enc.encode('\nendobj\n')]);
      parts.push(chunk);
      offset += chunk.length;
    });
    const xref = [`xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(enc.encode(`${xref}trailer\n<< /Size ${this.objs.length + 1} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
    return concat(parts);
  }
}

/** Page or group resources: names → objects. */
class Resources {
  gs = new Map<string, number>();
  shading = new Map<string, number>();
  xobject = new Map<string, number>();
  dict(): string {
    const part = (key: string, m: Map<string, number>) => (m.size ? `/${key} << ${[...m].map(([k, v]) => `/${k} ${v} 0 R`).join(' ')} >>` : '');
    return `<< ${part('ExtGState', this.gs)} ${part('Shading', this.shading)} ${part('XObject', this.xobject)} >>`;
  }
}

/** SVG path (M L H V C Q Z, absolute and relative) → PDF path operators. */
export function svgToPdfPath(d: string): string {
  const tok = d.match(/[MmLlHhVvCcQqSsTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const n = () => Number(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i]!)) cmd = tok[i++]!;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + n();
        y = oy + n();
        sx = x;
        sy = y;
        out.push(`${f(x)} ${f(y)} m`);
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
        x = ox + n();
        y = oy + n();
        out.push(`${f(x)} ${f(y)} l`);
        break;
      case 'H':
        x = ox + n();
        out.push(`${f(x)} ${f(y)} l`);
        break;
      case 'V':
        y = oy + n();
        out.push(`${f(x)} ${f(y)} l`);
        break;
      case 'C': {
        const x1 = ox + n();
        const y1 = oy + n();
        const x2 = ox + n();
        const y2 = oy + n();
        x = ox + n();
        y = oy + n();
        out.push(`${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(x)} ${f(y)} c`);
        break;
      }
      case 'Q': {
        const qx = ox + n();
        const qy = oy + n();
        const ex = ox + n();
        const ey = oy + n();
        out.push(`${f(x + ((qx - x) * 2) / 3)} ${f(y + ((qy - y) * 2) / 3)} ${f(ex + ((qx - ex) * 2) / 3)} ${f(ey + ((qy - ey) * 2) / 3)} ${f(ex)} ${f(ey)} c`);
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        out.push('h');
        x = sx;
        y = sy;
        break;
      default:
        i++; // S, T and the rest don't occur in our paths
    }
  }
  return out.join('\n');
}

const hex = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

/** JPEG size and channel count (SOF marker). */
function jpegInfo(b: Uint8Array): { w: number; h: number; c: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]!, c: b[i + 9]! };
    i += 2 + len;
  }
  return null;
}

export interface PdfPageSpec {
  /** Page nodes (in layer order). */
  ids: string[];
  /** Page area (slice); absent — the nodes' bounds. */
  rect?: Rect;
}

/** Print: bleed (document units = pt) and crop marks; colors in CMYK. */
export interface PdfPrint {
  bleed: number;
  marks: boolean;
  cmyk?: PdfCmyk;
}

/** CMYK for print: sRGB → inks conversion (0…1) and the print profile (embedded in the file). */
export interface PdfCmyk {
  convert(r: number, g: number, b: number): [number, number, number, number];
  /** Print profile (OutputIntent); absent — approximate conversion, no profile in the file. */
  profile?: { name: string; bytes: Uint8Array };
  /** Black (and near-black) uses only K ink: text and lines without a “rainbow” on misregistration. */
  pureBlack: boolean;
}

/** Margin beyond the bleed for crop marks, pt. */
const SLUG = 24;

/**
 * PDF: a page per node set. print — for a print shop: the page is enlarged by the bleed (and a margin
 * for marks), TrimBox and BleedBox; the top frame's background and its content extend into the bleed.
 */
export async function exportPdf(ed: Editor, pages: PdfPageSpec[], title = 'MFP', print?: PdfPrint): Promise<Uint8Array> {
  const scene = ed.scene;
  const renderer = (ed as unknown as { renderer: SceneRenderer }).renderer;
  const pdf = new PdfFile();
  const pagesNum = pdf.alloc();
  const kids: number[] = [];
  const images = new Map<string, { n: number; w: number; h: number } | null>();
  const gsCache = new Map<string, number>();
  // CMYK: conversion table (fast, and for images) and color operators.
  const cmyk = print?.cmyk ?? null;
  const ink = cmyk ? cmykTable(cmyk.convert) : null;
  const SPACE = cmyk ? 'DeviceCMYK' : 'DeviceRGB';
  /** Color in the page color space components (for CMYK — inks, pure black — K only). */
  const comps = (c: { r: number; g: number; b: number }): number[] => {
    if (!ink) return [c.r, c.g, c.b];
    if (cmyk!.pureBlack && Math.max(c.r, c.g, c.b) <= 0.02) return [0, 0, 0, 1];
    return ink.at(c.r, c.g, c.b);
  };
  const fillOp = (c: { r: number; g: number; b: number }) => `${comps(c).map(f).join(' ')} ${ink ? 'k' : 'rg'}`;

  /** Graphics state (fill and stroke opacity, blending) — one object per value. */
  const gs = (res: Resources, alpha: number, blend?: string): string => {
    const key = `${f(alpha)}|${blend ?? ''}`;
    let n = gsCache.get(key);
    if (!n) gsCache.set(key, (n = pdf.add(`<< /Type /ExtGState /ca ${f(alpha)} /CA ${f(alpha)}${blend ? ` /BM /${blend}` : ''} >>`)));
    const name = `G${n}`;
    res.gs.set(name, n);
    return `/${name} gs`;
  };

  /** Document image → XObject (JPEG as is, the rest as RGB with a soft mask). */
  const imageObj = async (hash: string): Promise<{ n: number; w: number; h: number } | null> => {
    if (images.has(hash)) return images.get(hash)!;
    let r: { n: number; w: number; h: number } | null = null;
    const bytes = await ed.store.readImage(hash);
    if (bytes) {
      const jpg = hex(bytes) ? jpegInfo(bytes) : null;
      if (jpg && (jpg.c === 1 || (jpg.c === 3 && !ink))) {
        const n = await pdf.stream(`/Type /XObject /Subtype /Image /Width ${jpg.w} /Height ${jpg.h} /ColorSpace /${jpg.c === 3 ? 'DeviceRGB' : 'DeviceGray'} /BitsPerComponent 8`, bytes, '/DCTDecode');
        r = { n, w: jpg.w, h: jpg.h };
      } else {
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart])).catch(() => null);
        if (bmp) {
          const oc = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = oc.getContext('2d')!;
          ctx.drawImage(bmp, 0, 0);
          const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
          r = await rgbaObj(new Uint8Array(data.buffer), bmp.width, bmp.height);
          bmp.close();
        }
      }
    }
    images.set(hash, r);
    return r;
  };

  /** Identical pixels (shadows of instances of one component, repeated images) — one object. */
  const byContent = new Map<string, { n: number; w: number; h: number }>();
  /** RGBA pixels → image: opaque — JPEG, otherwise RGB with a soft mask. */
  const rgbaObj = async (px: Uint8Array, w: number, h: number) => {
    const key = `${w}x${h}:${[...new Uint8Array(await crypto.subtle.digest('SHA-1', px as BufferSource))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const known = byContent.get(key);
    if (known) return known;
    const made = await encodeRgba(px, w, h);
    byContent.set(key, made);
    return made;
  };
  const encodeRgba = async (px: Uint8Array, w: number, h: number) => {
    let solid = true;
    for (let j = 3; j < px.length; j += 4) {
      if (px[j]! < 255) {
        solid = false;
        break;
      }
    }
    // Opaque (photos, backgrounds) — JPEG: many times smaller, no visible difference.
    if (solid && w * h > 4096 && !ink) {
      const oc = new OffscreenCanvas(w, h);
      oc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), w, h), 0, 0);
      const jpg = new Uint8Array(await (await oc.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer());
      const n = await pdf.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8`, jpg, '/DCTDecode');
      return { n, w, h };
    }
    const rgb = new Uint8Array(w * h * 3);
    const alpha = new Uint8Array(w * h);
    let opaque = true;
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      rgb[i * 3] = px[j]!;
      rgb[i * 3 + 1] = px[j + 1]!;
      rgb[i * 3 + 2] = px[j + 2]!;
      alpha[i] = px[j + 3]!;
      if (px[j + 3]! < 255) opaque = false;
    }
    const smask = opaque ? 0 : await pdf.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha);
    const n = await pdf.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${SPACE} /BitsPerComponent 8${smask ? ` /SMask ${smask} 0 R` : ''}`, ink ? ink.pixels(px) : rgb);
    return { n, w, h };
  };

  /** Gradient color function: segments between stops (Type 2), stitched (Type 3). */
  const colorFunction = (stops: { position: number; color: { r: number; g: number; b: number } }[]): number => {
    const s = [...stops].sort((a, b) => a.position - b.position);
    const c = (k: { color: { r: number; g: number; b: number } }) => `[${comps(k.color).map(f).join(' ')}]`;
    if (s.length === 1) return pdf.add(`<< /FunctionType 2 /Domain [0 1] /C0 ${c(s[0]!)} /C1 ${c(s[0]!)} /N 1 >>`);
    const parts: number[] = [];
    for (let i = 0; i < s.length - 1; i++) parts.push(pdf.add(`<< /FunctionType 2 /Domain [0 1] /C0 ${c(s[i]!)} /C1 ${c(s[i + 1]!)} /N 1 >>`));
    const first = s[0]!.position;
    const last = s[s.length - 1]!.position;
    if (parts.length === 1 && first === 0 && last === 1) return parts[0]!;
    // The area before the first and after the last stop uses their colors (Extend does this itself).
    const bounds = s.slice(1, -1).map((k) => f(k.position)).join(' ');
    const encode = parts.map(() => '0 1').join(' ');
    return pdf.add(`<< /FunctionType 3 /Domain [${f(first)} ${f(last)}] /Functions [${parts.map((p) => `${p} 0 R`).join(' ')}] /Bounds [${bounds}] /Encode [${encode}] >>`);
  };

  /** Is the node's paint supported as vector? */
  const vectorPaint = (p: FigPaint): boolean => {
    if (p.visible === false) return true;
    if (p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') return false;
    if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
      const a = (p.stops ?? []).map((s) => s.color.a);
      return a.every((v) => Math.abs(v - (a[0] ?? 1)) < 0.01);
    }
    if (p.type === 'IMAGE') {
      const pf = p.paintFilter as Record<string, number> | undefined;
      return !pf || Object.values(pf).every((v) => !v);
    }
    return p.type === 'SOLID';
  };

  /**
   * The whole node as an image: 3D rotation, blur, masks, unsupported paints and blend modes. Not for shadows:
   * only they become an image, the node itself stays vector.
   */
  const needsRaster = (n: SceneNode): boolean => {
    if (n.persp) return true;
    if (n.effects.some((e) => e.visible !== false && (e.type === 'SHADER' || e.type === 'FOREGROUND_BLUR' || e.type === 'BACKGROUND_BLUR' || e.type === 'NOISE' || e.type === 'GRAIN' || e.type === 'GLASS'))) return true;
    if (n.blendMode && n.blendMode !== 'PASS_THROUGH' && n.blendMode !== 'NORMAL' && !BLEND[n.blendMode]) return true;
    if (![...n.fills, ...n.strokes].every(vectorPaint)) return true;
    if (n.children.some((c) => c.isMask && c.visible)) return true;
    return false;
  };
  const hasShadow = (n: SceneNode, type: 'DROP_SHADOW' | 'INNER_SHADOW') => n.effects.some((e) => e.visible !== false && e.type === type);

  const shapeD = (n: SceneNode): { d: string; evenOdd: boolean } | null => {
    if (n.fillGeometry.length) return { d: n.fillGeometry.map((g) => blobToSvgPath(scene.blobs[g.blob]!)).join(''), evenOdd: n.fillGeometry.some((g) => g.windingRule === 'EVENODD') };
    if (RECT_LIKE.has(n.type)) return { d: `M0 0H${f(n.size.x)}V${f(n.size.y)}H0Z`, evenOdd: false };
    return null;
  };

  /** Fill a path with paints (in order, like fill layers). */
  const paintPath = async (out: string[], res: Resources, d: string, evenOdd: boolean, paints: FigPaint[], w: number, h: number) => {
    const path = svgToPdfPath(d);
    for (const p of paints) {
      if (p.visible === false || (p.opacity ?? 1) <= 0) continue;
      const op = p.opacity ?? 1;
      if (p.type === 'SOLID') {
        const c = p.color ?? { r: 0, g: 0, b: 0, a: 1 };
        const a = (c.a ?? 1) * op;
        out.push('q');
        if (a < 1) out.push(gs(res, a));
        out.push(fillOp(c), path, evenOdd ? 'f*' : 'f', 'Q');
        continue;
      }
      const t: M = p.transform ? [p.transform.m00, p.transform.m01, p.transform.m02, p.transform.m10, p.transform.m11, p.transform.m12] : [1, 0, 0, 0, 1, 0];
      if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
        const stops = p.stops ?? [];
        const a = (stops[0]?.color.a ?? 1) * op;
        const fn = colorFunction(stops);
        const sh =
          p.type === 'GRADIENT_LINEAR'
            ? pdf.add(`<< /ShadingType 2 /ColorSpace /${SPACE} /Coords [0 0.5 1 0.5] /Function ${fn} 0 R /Extend [true true] >>`)
            : pdf.add(`<< /ShadingType 3 /ColorSpace /${SPACE} /Coords [0.5 0.5 0 0.5 0.5 0.5] /Function ${fn} 0 R /Extend [true true] >>`);
        const name = `S${sh}`;
        res.shading.set(name, sh);
        // Gradient in paint space: unit square → node (as in SVG and the render shader).
        const local = mul([w, 0, 0, 0, h, 0], inv(t));
        out.push('q', path, evenOdd ? 'W* n' : 'W n');
        if (a < 1) out.push(gs(res, a));
        out.push(mat(local), `/${name} sh`, 'Q');
        continue;
      }
      if (p.type === 'IMAGE') {
        const img = await imageObj(hashToHex(p.image?.hash));
        if (!img) continue;
        const { w: iw, h: ih } = img;
        const name = `X${img.n}`;
        res.xobject.set(name, img.n);
        out.push('q', path, evenOdd ? 'W* n' : 'W n');
        if (op < 1) out.push(gs(res, op));
        // A PDF image is a unit square from bottom to top: flipped inside.
        const draw = (m: M) => out.push('q', mat(mul(m, [iw, 0, 0, 0, -ih, ih])), `/${name} Do`, 'Q');
        if (p.imageScaleMode === 'TILE') {
          const s = p.scale ?? 1;
          const tw = iw * s;
          const th = ih * s;
          const count = Math.ceil(w / tw) * Math.ceil(h / th);
          if (count <= 2000) for (let ty = 0; ty < h; ty += th) for (let tx = 0; tx < w; tx += tw) draw([s, 0, tx, 0, s, ty]);
        } else if (p.imageScaleMode === 'FIT') {
          const s = Math.min(w / iw, h / ih);
          draw([s, 0, (w - iw * s) / 2, 0, s, (h - ih * s) / 2]);
        } else if (p.imageScaleMode === 'STRETCH') draw(mul(mul([w, 0, 0, 0, h, 0], inv(t)), [1 / iw, 0, 0, 0, 1 / ih, 0]));
        else {
          const s = Math.max(w / iw, h / ih);
          draw([s, 0, (w - iw * s) / 2, 0, s, (h - ih * s) / 2]);
        }
        out.push('Q');
      }
    }
  };

  /** A node (or only its shadows) as an image — in world coordinates; cur — the current matrix. */
  const raster = async (out: string[], res: Resources, n: SceneNode, cur: M, shadows?: 'drop' | 'inner') => {
    const id = scene.id(n);
    if (!id) return;
    try {
      const r = await ed.exportImage([id], shadows ? SHADOW_SCALE : RASTER_SCALE, 'RGBA', { shadows });
      const img = await rgbaObj(r.bytes, r.width, r.height);
      const name = `X${img.n}`;
      res.xobject.set(name, img.n);
      const [x0, y0, x1, y1] = r.rect;
      out.push('q', mat(inv(cur)), mat([x1 - x0, 0, x0, 0, -(y1 - y0), y1]), `/${name} Do`, 'Q');
    } catch {
      // nothing to draw (empty node)
    }
  };

  /** Top-level frames of print pages: background with bleed, content isn't clipped at the edge. */
  const bleedRoots = new Set<SceneNode>();
  const bleed = print?.bleed ?? 0;
  /** Frame background with bleed: a rectangle enlarged by the bleed (rounded ones keep their own shape). */
  const bleedShape = (n: SceneNode): { d: string; evenOdd: boolean } | null => {
    const id = scene.id(n);
    const doc = ed.doc;
    const rounded = !!id && ['cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].some((k) => (doc.get(id, k as 'cornerRadius') ?? 0) > 0);
    if (rounded) return shapeD(n);
    const [x0, y0, x1, y1] = [-bleed, -bleed, n.size.x + bleed, n.size.y + bleed];
    return { d: `M${f(x0)} ${f(y0)}H${f(x1)}V${f(y1)}H${f(x0)}Z`, evenOdd: false };
  };

  /** Node content (without its opacity and blending): fill, text, children, stroke. */
  const body = async (out: string[], res: Resources, n: SceneNode, world: M) => {
    const w = n.size.x;
    const h = n.size.y;
    if (n.type === 'TEXT') {
      const runs = textOutlines(ed.ck, renderer, ed.fonts, n);
      if (!runs) return raster(out, res, n, world);
      if (hasShadow(n, 'DROP_SHADOW')) await raster(out, res, n, world, 'drop');
      for (const r of runs) await paintPath(out, res, r.d, false, r.fills ?? n.fills, w, h);
    } else {
      // Shadows under the node as an image, then the fill as vector, inner shadows on top of it.
      if (hasShadow(n, 'DROP_SHADOW')) await raster(out, res, n, world, 'drop');
      const shape = bleedRoots.has(n) ? bleedShape(n) : shapeD(n);
      if (shape) await paintPath(out, res, shape.d, shape.evenOdd, n.fills, w, h);
      if (hasShadow(n, 'INNER_SHADOW')) await raster(out, res, n, world, 'inner');
    }
    if (n.children.length && n.type !== 'BOOLEAN_OPERATION') {
      const clip = n.clipsContent && !bleedRoots.has(n) ? shapeD(n) : null;
      if (clip) out.push('q', svgToPdfPath(clip.d), clip.evenOdd ? 'W* n' : 'W n');
      for (const c of n.children) await emit(out, res, c, world);
      if (clip) out.push('Q');
    }
    const stroke = n.strokes.some((p) => p.visible !== false) ? renderer.strokeSvg(n) : null;
    if (stroke) await paintPath(out, res, stroke, false, n.strokes, w, h);
  };

  /** Node: pw — the parent's world matrix (current coordinate system). */
  const emit = async (out: string[], res: Resources, n: SceneNode, pw: M): Promise<void> => {
    if (!n.visible || n.opacity <= 0 || n.isMask) return;
    if (needsRaster(n)) return raster(out, res, n, pw);
    const world = mul(pw, n.transform);
    const blend = n.blendMode && BLEND[n.blendMode];
    if (n.opacity < 1 || blend) {
      // Transparency group: the content as a separate object, opacity and blending applied as a whole.
      const inner: string[] = [];
      const ires = new Resources();
      await body(inner, ires, n, world);
      const b = renderer.boundsOf(n);
      const box = b ? transformRect(inv(world), b) : [0, 0, n.size.x, n.size.y];
      const form = await pdf.stream(`/Type /XObject /Subtype /Form /BBox [${box.map(f).join(' ')}] /Group << /S /Transparency /CS /${SPACE} >> /Resources ${ires.dict()}`, inner.join('\n'));
      const name = `X${form}`;
      res.xobject.set(name, form);
      out.push('q', mat(n.transform), gs(res, n.opacity, blend || undefined), `/${name} Do`, 'Q');
      return;
    }
    out.push('q', mat(n.transform));
    await body(out, res, n, world);
    out.push('Q');
  };

  for (const page of pages) {
    const nodes = page.ids.map((id) => scene.node(id)).filter((n): n is SceneNode => !!n && !!renderer.boundsOf(n));
    if (!nodes.length) continue;
    let r: Rect = [Infinity, Infinity, -Infinity, -Infinity];
    for (const n of nodes) {
      const b = renderer.boundsOf(n)!;
      r = [Math.min(r[0], b[0] + 2), Math.min(r[1], b[1] + 2), Math.max(r[2], b[2] - 2), Math.max(r[3], b[3] - 2)];
    }
    if (page.rect) r = [...page.rect];
    const W = Math.max(1, r[2] - r[0]);
    const H = Math.max(1, r[3] - r[1]);
    const res = new Resources();
    // Print: page margin — bleed and room for crop marks.
    const pad = print ? bleed + (print.marks ? SLUG : 0) : 0;
    const MW = W + 2 * pad;
    const MH = H + 2 * pad;
    if (print) for (const n of nodes) bleedRoots.add(n);
    // Y axis down, origin at the top-left corner of the bounds (with the margin for print).
    const out: string[] = ['q', `1 0 0 -1 0 ${f(MH)} cm`, `1 0 0 1 ${f(pad - r[0])} ${f(pad - r[1])} cm`];
    // Area (slice; with bleed for print) — clip to it.
    if (page.rect || print) out.push(`${f(r[0] - bleed)} ${f(r[1] - bleed)} ${f(W + 2 * bleed)} ${f(H + 2 * bleed)} re W n`);
    for (const n of nodes) {
      const pw = scene.worldMatrix(scene.parent(n)) as M;
      out.push('q', mat(pw));
      await emit(out, res, n, pw);
      out.push('Q');
    }
    out.push('Q');
    // Crop marks: along the edge lines, in the margin beyond the bleed (they don't enter the bleed).
    if (print?.marks) {
      const end = SLUG - 3;
      // Marks in registration color (all inks), black for RGB.
      out.push(ink ? 'q 0.25 w 1 1 1 1 K' : 'q 0.25 w 0 0 0 RG');
      for (const y of [pad, pad + H]) out.push(`0 ${f(y)} m ${f(end)} ${f(y)} l S`, `${f(MW - end)} ${f(y)} m ${f(MW)} ${f(y)} l S`);
      for (const x of [pad, pad + W]) out.push(`${f(x)} 0 m ${f(x)} ${f(end)} l S`, `${f(x)} ${f(MH - end)} m ${f(x)} ${f(MH)} l S`);
      out.push('Q');
    }
    const content = await pdf.stream('', out.join('\n'));
    const boxes = print ? ` /TrimBox [${f(pad)} ${f(pad)} ${f(pad + W)} ${f(pad + H)}] /BleedBox [${f(pad - bleed)} ${f(pad - bleed)} ${f(pad + W + bleed)} ${f(pad + H + bleed)}]` : '';
    kids.push(pdf.add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${f(MW)} ${f(MH)}]${boxes} /Resources ${res.dict()} /Contents ${content} 0 R >>`));
    bleedRoots.clear();
  }
  if (!kids.length) throw new Error('Нечего экспортировать');
  pdf.put(pagesNum, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  // Print profile embedded in the file: the printer and prepress know which conditions the inks are prepared for.
  let intents = '';
  if (cmyk?.profile) {
    const icc = await pdf.stream('/N 4', cmyk.profile.bytes);
    const name = pdfString(cmyk.profile.name);
    intents = ` /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier ${name} /Info ${name} /DestOutputProfile ${icc} 0 R >>]`;
  }
  const root = pdf.add(`<< /Type /Catalog /Pages ${pagesNum} 0 R${intents} >>`);
  const info = pdf.add(`<< /Title ${pdfString(title)} /Producer (MFP) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
  return pdf.finish(root, info);
}

/** Bounds after transformation (bounding box of the four corners). */
function transformRect(m: M, r: Rect): [number, number, number, number] {
  const pts = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ].map(([x, y]) => [m[0] * x! + m[1] * y! + m[2], m[3] * x! + m[4] * y! + m[5]]);
  const xs = pts.map((p) => p[0]!);
  const ys = pts.map((p) => p[1]!);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** PDF string in UTF-16BE (Cyrillic in the title). */
function pdfString(s: string): string {
  let hexs = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hexs += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hexs += cp.toString(16).padStart(4, '0');
  }
  return `<${hexs.toUpperCase()}>`;
}
