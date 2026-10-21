// SVG export: from the same scene the canvas draws.
// Shapes — paths from the geometry table; fills — color, gradients (gradientTransform — the same
// matrix as in the render shader), images (pattern with a data URL); strokes — as a path
// (own — built by the renderer, imported — ready-made); text — glyph outlines
// (import) or <text> per layout line (own); shadows and blur — filters; frame
// clipping — clipPath; masks — mask; opacity and blending — on the group.

import { applyTextCase, PathTextMap, type SceneRenderer } from '@mfp/renderer';
import { blobToSvgPath, hashToHex, type FigEffect, type FigPaint, type Matrix2D, type SceneNode, type SceneTextRun } from '@mfp/io-figma';
import { invert, multiply, type Matrix } from '@mfp/core';
import type { Editor } from './editor.ts';
import { textOutlines } from './text-outline.ts';

export interface SvgOptions {
  /** Text as outlines. */
  outlineText?: boolean;
  /** Group ids — layer names. */
  idAttribute?: boolean;
  /** Capture a page area (slice), not the nodes' box. */
  region?: [number, number, number, number];
}

const RECT_LIKE = new Set(['FRAME', 'SYMBOL', 'INSTANCE', 'SECTION', 'RECTANGLE', 'ROUNDED_RECTANGLE']);
const BLEND: Record<string, string> = {
  MULTIPLY: 'multiply',
  SCREEN: 'screen',
  OVERLAY: 'overlay',
  DARKEN: 'darken',
  LIGHTEN: 'lighten',
  COLOR_DODGE: 'color-dodge',
  COLOR_BURN: 'color-burn',
  HARD_LIGHT: 'hard-light',
  SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

const num = (v: number) => String(Math.round(v * 1000) / 1000);
/** Our matrix [a, b, c, d, e, f] (x' = a·x + b·y + c) → SVG matrix(a d b e c f). */
const svgMatrix = (m: Matrix2D) => `matrix(${num(m[0])} ${num(m[3])} ${num(m[1])} ${num(m[4])} ${num(m[2])} ${num(m[5])})`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (c: { r: number; g: number; b: number }) =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

interface ImageInfo {
  url: string;
  w: number;
  h: number;
}

export async function exportSvg(ed: Editor, ids: string[], opts: SvgOptions = {}): Promise<string> {
  const scene = ed.scene;
  const renderer = (ed as unknown as { renderer: SceneRenderer }).renderer;
  const nodes = ids.map((id) => scene.node(id)).filter((n): n is SceneNode => !!n && !!renderer.boundsOf(n));
  if (!nodes.length) throw new Error('Нечего экспортировать');
  let r: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    const b = renderer.boundsOf(n)!;
    r = [Math.min(r[0], b[0] + 2), Math.min(r[1], b[1] + 2), Math.max(r[2], b[2] - 2), Math.max(r[3], b[3] - 2)];
  }
  if (opts.region) r = [...opts.region];
  const W = Math.max(1, Math.ceil(r[2] - r[0]));
  const H = Math.max(1, Math.ceil(r[3] - r[1]));

  // Images: bytes from document storage → data URL, size — for scale modes.
  const images = new Map<string, ImageInfo>();
  const visited = new Set<SceneNode>();
  const collect = (n: SceneNode) => {
    if (visited.has(n)) return;
    visited.add(n);
    for (const p of [...n.fills, ...n.strokes]) {
      if (p.type === 'IMAGE' && p.visible !== false) images.set(hashToHex(p.image?.hash), { url: '', w: 0, h: 0 });
      // Images in a pattern source too.
      const src = p.type === 'PATTERN' && p.pattern ? scene.patternSource(p.pattern.source) : undefined;
      if (src) collect(src);
    }
    n.children.forEach(collect);
  };
  nodes.forEach(collect);
  for (const hash of images.keys()) {
    const bytes = await ed.store.readImage(hash);
    if (!bytes) continue;
    const blob = new Blob([bytes as BlobPart]);
    const bmp = await createImageBitmap(blob).catch(() => null);
    const url = await new Promise<string>((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.readAsDataURL(new Blob([bytes as BlobPart], { type: sniffMime(bytes) }));
    });
    images.set(hash, { url, w: bmp?.width ?? 1, h: bmp?.height ?? 1 });
    bmp?.close();
  }

  // Shaders and Lottie — as an image (they can't be expressed in SVG; for Lottie — the current frame).
  const shaderUrls = new Map<FigPaint, string>();
  const shaders = async (n: SceneNode): Promise<void> => {
    for (const p of [...n.fills, ...n.strokes]) {
      if ((p.type !== 'SHADER' && p.type !== 'LOTTIE') || p.visible === false || shaderUrls.has(p)) continue;
      const png = renderer.paintPng(p, Math.max(1, n.size.x), Math.max(1, n.size.y), 2);
      if (png)
        shaderUrls.set(
          p,
          await new Promise<string>((res) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.readAsDataURL(new Blob([png as BlobPart], { type: 'image/png' }));
          }),
        );
    }
    for (const c of n.children) await shaders(c);
  };
  for (const n of nodes) await shaders(n);

  // 3D-rotated layers and 3D models — as an image (SVG has only affine matrices): a snapshot in page coordinates.
  const flat = new Map<SceneNode, { url: string; rect: [number, number, number, number] }>();
  const projected = async (n: SceneNode): Promise<void> => {
    const id = scene.id(n);
    if ((n.persp || n.effects.some((e) => e.type === 'SHADER' && e.visible !== false) || n.fills.some((f) => (f.type === 'MODEL3D' || f.type === 'GRADIENT_FREEFORM') && f.visible !== false) || n.strokes.some((f) => f.type === 'GRADIENT_FREEFORM' && f.visible !== false)) && id && n.visible) {
      try {
        const img = await ed.exportImage([id], 2, 'PNG');
        const url = await new Promise<string>((res) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.readAsDataURL(new Blob([img.bytes as BlobPart], { type: 'image/png' }));
        });
        flat.set(n, { url, rect: img.rect });
      } catch {
        // Empty layer — nothing to output.
      }
      return;
    }
    for (const c of n.children) await projected(c);
  };
  for (const n of nodes) await projected(n);

  const defs: string[] = [];
  let counter = 0;
  const usedIds = new Map<string, number>();
  /** id from a layer name: allowed characters, duplicates get a number. */
  const uniqueId = (name: string) => {
    const base = name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^(?=\d)/, '_') || 'layer';
    const k = usedIds.get(base) ?? 0;
    usedIds.set(base, k + 1);
    return k ? `${base}_${k + 1}` : base;
  };
  const uid = (p: string) => `${p}${++counter}`;
  /** Pattern sources currently being output (a pattern inside its own source — skip). */
  const patternStack = new Set<string>();

  /** fill value for a paint (color or a reference to a definition) and its opacity. */
  const paintRef = (fp: FigPaint, w: number, h: number): { fill: string; opacity: number } | null => {
    if (fp.visible === false || (fp.opacity ?? 1) <= 0) return null;
    const op = fp.opacity ?? 1;
    if (fp.type === 'SOLID') {
      const c = fp.color ?? { r: 0, g: 0, b: 0, a: 1 };
      return { fill: hex(c), opacity: (c.a ?? 1) * op };
    }
    const stops = [...(fp.stops ?? [])].sort((a, b) => a.position - b.position).map((s) => `<stop offset="${num(s.position)}" stop-color="${hex(s.color)}"${s.color.a < 1 ? ` stop-opacity="${num(s.color.a)}"` : ''}/>`).join('');
    const t: Matrix2D = fp.transform ? [fp.transform.m00, fp.transform.m01, fp.transform.m02, fp.transform.m10, fp.transform.m11, fp.transform.m12] : [1, 0, 0, 0, 1, 0];
    const local = multiply([w, 0, 0, 0, h, 0], invert(t as Matrix)) as Matrix2D;
    if (fp.type === 'GRADIENT_LINEAR') {
      const id = uid('g');
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="${svgMatrix(local)}">${stops}</linearGradient>`);
      return { fill: `url(#${id})`, opacity: op };
    }
    if (fp.type === 'GRADIENT_RADIAL' || fp.type === 'GRADIENT_DIAMOND') {
      const id = uid('g');
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0.5" cy="0.5" r="0.5" gradientTransform="${svgMatrix(local)}">${stops}</radialGradient>`);
      return { fill: `url(#${id})`, opacity: op };
    }
    if (fp.type === 'GRADIENT_ANGULAR') {
      // SVG has no conic gradients — the first color.
      const s = fp.stops?.[0];
      return s ? { fill: hex(s.color), opacity: s.color.a * op } : null;
    }
    if (fp.type === 'SHADER' || fp.type === 'LOTTIE') {
      const url = shaderUrls.get(fp);
      if (!url) return null;
      const id = uid('sh');
      defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${num(w)}" height="${num(h)}"><image href="${url}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"/></pattern>`);
      return { fill: `url(#${id})`, opacity: op };
    }
    if (fp.type === 'PATTERN' && fp.pattern) {
      const pt = fp.pattern;
      const src = scene.patternSource(pt.source);
      if (!src || patternStack.has(pt.source)) return null;
      // Tile — the source box with rotation (as on the canvas), spacing — fractions of the tile.
      const st = src.transform;
      const corners = [[0, 0], [src.size.x, 0], [0, src.size.y], [src.size.x, src.size.y]].map(([x, y]) => [st[0] * x! + st[1] * y!, st[3] * x! + st[4] * y!] as const);
      const bx = Math.min(...corners.map((c) => c[0]));
      const by = Math.min(...corners.map((c) => c[1]));
      const bw = Math.max(...corners.map((c) => c[0])) - bx;
      const bh = Math.max(...corners.map((c) => c[1])) - by;
      if (!(bw > 1e-3 && bh > 1e-3)) return null;
      const cw = bw * (1 + Math.max(0, pt.spacing.x));
      const ch = bh * (1 + Math.max(0, pt.spacing.y));
      const hexMode = pt.tileType === 'HORIZONTAL_HEXAGONAL' ? 1 : pt.tileType === 'VERTICAL_HEXAGONAL' ? 2 : 0;
      const copies: [number, number][] = hexMode === 1 ? [[0, 0], [cw / 2, ch], [-cw / 2, ch]] : hexMode === 2 ? [[0, 0], [cw, ch / 2], [cw, -ch / 2]] : [[0, 0]];
      const k = Math.max(1e-3, pt.scale || 1);
      const ox = pt.align === 'CENTER' ? (w - bw * k) / 2 : pt.align === 'END' ? w - bw * k : 0;
      patternStack.add(pt.source);
      const content = copies.map(([dx, dy]) => `<g transform="translate(${num(dx - bx - st[2])} ${num(dy - by - st[5])})">${emit(src)}</g>`).join('');
      patternStack.delete(pt.source);
      const id = uid('pt');
      defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${num(hexMode === 2 ? 2 * cw : cw)}" height="${num(hexMode === 1 ? 2 * ch : ch)}" patternTransform="${svgMatrix([k, 0, ox, 0, k, 0])}">${content}</pattern>`);
      return { fill: `url(#${id})`, opacity: op };
    }
    if (fp.type === 'IMAGE') {
      const img = images.get(hashToHex(fp.image?.hash));
      if (!img?.url) return null;
      let m: Matrix2D;
      const { w: iw, h: ih } = img;
      if (fp.imageScaleMode === 'FIT') {
        const s = Math.min(w / iw, h / ih);
        m = [s, 0, (w - iw * s) / 2, 0, s, (h - ih * s) / 2];
      } else if (fp.imageScaleMode === 'TILE') {
        const s = fp.scale ?? 1;
        m = [s, 0, 0, 0, s, 0];
      } else if (fp.imageScaleMode === 'STRETCH') {
        m = multiply(multiply([w, 0, 0, 0, h, 0], invert(t as Matrix)), [1 / iw, 0, 0, 0, 1 / ih, 0]) as Matrix2D;
      } else {
        const s = Math.max(w / iw, h / ih);
        m = [s, 0, (w - iw * s) / 2, 0, s, (h - ih * s) / 2];
      }
      const id = uid('p');
      const tile = fp.imageScaleMode === 'TILE';
      defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${tile ? iw : w / Math.abs(m[0] || 1)}" height="${tile ? ih : h / Math.abs(m[4] || 1)}" patternTransform="${svgMatrix(m)}">` +
          `<image href="${img.url}" width="${iw}" height="${ih}"/></pattern>`,
      );
      return { fill: `url(#${id})`, opacity: op };
    }
    return null;
  };

  const filled = (d: string, paints: FigPaint[], w: number, h: number, evenOdd: boolean) =>
    paints
      .map((fp) => paintRef(fp, w, h))
      .filter((p): p is { fill: string; opacity: number } => !!p)
      .map((p) => `<path d="${d}" fill="${p.fill}"${p.opacity < 1 ? ` fill-opacity="${num(p.opacity)}"` : ''}${evenOdd ? ' fill-rule="evenodd"' : ''}/>`)
      .join('');

  const shapeD = (n: SceneNode): { d: string; evenOdd: boolean } | null => {
    if (n.fillGeometry.length) {
      const evenOdd = n.fillGeometry.some((g) => g.windingRule === 'EVENODD');
      return { d: n.fillGeometry.map((g) => blobToSvgPath(scene.blobs[g.blob]!)).join(''), evenOdd };
    }
    if (RECT_LIKE.has(n.type)) return { d: `M0 0H${num(n.size.x)}V${num(n.size.y)}H0Z`, evenOdd: false };
    return null;
  };

  const effectFilter = (effects: FigEffect[]): string | null => {
    const parts: string[] = [];
    for (const e of effects) {
      if (e.visible === false) continue;
      if (e.type === 'DROP_SHADOW') {
        const c = e.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
        parts.push(`<feDropShadow dx="${num(e.offset?.x ?? 0)}" dy="${num(e.offset?.y ?? 0)}" stdDeviation="${num((e.radius ?? 0) / 2)}" flood-color="${hex(c)}" flood-opacity="${num(c.a)}"/>`);
      } else if (e.type === 'FOREGROUND_BLUR') parts.push(`<feGaussianBlur stdDeviation="${num((e.radius ?? 0) / 2)}"/>`);
    }
    if (!parts.length) return null;
    const id = uid('f');
    defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${parts.join('')}</filter>`);
    return id;
  };

  const emit = (n: SceneNode): string => {
    if (!n.visible || n.opacity <= 0) return '';
    const shot = flat.get(n);
    if (shot) {
      // The snapshot already has the layer's opacity and effects; page coordinates — back to the parent's space.
      const [x0, y0, x1, y1] = shot.rect;
      return `<g transform="${svgMatrix(invert(scene.worldMatrix(scene.parent(n)) as Matrix) as Matrix2D)}"><image x="${num(x0)}" y="${num(y0)}" width="${num(x1 - x0)}" height="${num(y1 - y0)}" href="${shot.url}"/></g>`;
    }
    const w = n.size.x;
    const h = n.size.y;
    const attrs: string[] = [`transform="${svgMatrix(n.transform)}"`];
    if (opts.idAttribute && n.name) attrs.unshift(`id="${esc(uniqueId(n.name))}"`);
    if (n.opacity < 1) attrs.push(`opacity="${num(n.opacity)}"`);
    const blend = BLEND[n.blendMode];
    if (blend) attrs.push(`style="mix-blend-mode:${blend}"`);
    const filter = effectFilter(n.effects);
    if (filter) attrs.push(`filter="url(#${filter})"`);
    let inner = '';
    // Text on a path — as outlines (glyphs on the path).
    // “Fitted” text (size chosen to fit the box) — also as outlines: SVG can't pick the size itself.
    const outlined = n.type === 'TEXT' && (opts.outlineText || n.glyphs || n.textPath || n.textLayout?.fit) ? textOutlines(ed.ck, renderer, ed.fonts, n) : null;
    if (outlined) for (const run of outlined) inner += filled(run.d, run.fills ?? n.fills, w, h, false);
    else if (n.type === 'TEXT') {
      if (n.glyphs) for (const run of renderer.textRunsSvg(n)) inner += filled(run.d, run.fills ?? n.fills, w, h, false);
      else if (n.textLayout) {
        const t = n.textLayout;
        const fill = n.fills.find((f) => f.visible !== false && f.type === 'SOLID');
        const base = { ...(fill?.color ?? { r: 0, g: 0, b: 0, a: 1 }), a: (fill?.color?.a ?? 1) * (fill?.opacity ?? 1) };
        const runs: SceneTextRun[] = t.runs?.length ? t.runs : [{ start: 0, end: t.characters.length, family: t.family, style: t.style, fontSize: t.fontSize, letterSpacing: t.letterSpacing, textCase: t.textCase, decoration: t.decoration }];
        const weightOf = (style: string) =>
          /bold|black|heavy/i.test(style) ? (/semi|demi/i.test(style) ? 600 : /extra|black|heavy/i.test(style) ? 800 : 700) : /medium/i.test(style) ? 500 : /light|thin/i.test(style) ? 300 : 400;
        /** Run formatting as SVG attributes. */
        const attrsOf = (r: (typeof runs)[number] & { color?: { r: number; g: number; b: number; a: number } }) => {
          const c = r.color ?? base;
          // Variable font axes — via a CSS property (SVG has no attribute of its own).
          const axes = r.variations?.length ? ` style="font-variation-settings:${r.variations.map((v) => `'${v.axis}' ${num(v.value)}`).join(', ')}"` : '';
          return `font-family="${esc(r.family)}" font-size="${num(r.fontSize)}" font-weight="${weightOf(r.style)}"${axes}${/italic/i.test(r.style) ? ' font-style="italic"' : ''}${r.letterSpacing ? ` letter-spacing="${num(r.letterSpacing)}"` : ''}${r.decoration === 'UNDERLINE' ? ' text-decoration="underline"' : r.decoration === 'STRIKETHROUGH' ? ' text-decoration="line-through"' : ''} fill="${hex(c)}"${c.a < 1 ? ` fill-opacity="${num(c.a)}"` : ''}`;
        };
        const runAt = (i: number) => runs.find((r) => i >= r.start && i < r.end) ?? runs[runs.length - 1]!;
        // Text on a path without glyph outlines (font failed to load) — <textPath> along the same path:
        // line start (for center and right — middle and end) at the same path length as on the canvas.
        const tp = n.textPath;
        if (tp) {
          // Left-aligned line without width: start — offset of the start (with path stretching).
          const map = new PathTextMap(ed.ck, tp.data, tp.offset, 0, 'LEFT', 0, tp.sx, tp.sy);
          const { length, start: offset } = map;
          const data = map.svg();
          map.delete();
          const id = uid('tp');
          defs.push(`<path id="${id}" d="${esc(data)}"/>`);
          const parts = runs.map((r) => `<tspan ${attrsOf(r)}>${esc(applyTextCase(t.characters.slice(r.start, r.end), r.textCase))}</tspan>`);
          const [anchor, start] = t.align === 'CENTER' ? [' text-anchor="middle"', length / 2] : t.align === 'RIGHT' ? [' text-anchor="end"', length] : ['', 0];
          inner += `<text xml:space="preserve"${anchor}><textPath href="#${id}" startOffset="${num(start + offset)}">${parts.join('')}</textPath></text>`;
        }
        for (const line of tp ? [] : (renderer.paragraphLines(n) ?? [])) {
          if (line.marker) {
            inner += `<text x="${num(line.x)}" y="${num(line.baseline)}" ${attrsOf({ ...runAt(line.start), decoration: 'NONE' })} xml:space="preserve">${esc(line.text)}</text>`;
            continue;
          }
          // A line — as runs, each with its own formatting.
          const parts: string[] = [];
          for (const r of runs) {
            const a = Math.max(line.start, r.start);
            const b = Math.min(line.end, r.end);
            if (b <= a) continue;
            parts.push(`<tspan ${attrsOf(r)}>${esc(applyTextCase(t.characters.slice(a, b), r.textCase))}</tspan>`);
          }
          inner += `<text x="${num(line.x)}" y="${num(line.baseline)}" xml:space="preserve">${parts.join('')}</text>`;
        }
      }
    } else {
      const shape = shapeD(n);
      if (shape) inner += filled(shape.d, n.fills, w, h, shape.evenOdd);
    }
    if (n.children.length && n.type !== 'BOOLEAN_OPERATION') {
      let kids = '';
      // A mask affects the siblings above it.
      for (let i = 0; i < n.children.length; i++) {
        const c = n.children[i]!;
        if (c.isMask && c.visible) {
          const id = uid('m');
          defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><g transform="${svgMatrix(c.transform)}">${(() => {
            const s = shapeD(c);
            return s ? `<path d="${s.d}" fill="#fff"/>` : '';
          })()}</g></mask>`);
          const rest = n.children.slice(i + 1).map(emit).join('');
          kids += `<g mask="url(#${id})">${rest}</g>`;
          break;
        }
        kids += emit(c);
      }
      if (n.clipsContent) {
        const shape = shapeD(n);
        if (shape) {
          const id = uid('c');
          defs.push(`<clipPath id="${id}"><path d="${shape.d}"/></clipPath>`);
          kids = `<g clip-path="url(#${id})">${kids}</g>`;
        }
      }
      inner += kids;
    }
    const stroke = n.strokes.some((p) => p.visible !== false) ? renderer.strokeSvg(n) : null;
    if (stroke) inner += filled(stroke, n.strokes, w, h, false);
    return inner ? `<g ${attrs.join(' ')}>${inner}</g>` : '';
  };

  const body = nodes
    .map((n) => {
      const parent = scene.parent(n);
      const pw = scene.worldMatrix(parent);
      return `<g transform="${svgMatrix(pw)}">${emit(n)}</g>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    `<g transform="translate(${num(-r[0])} ${num(-r[1])})">${body}</g></svg>`
  );
}

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  return 'application/octet-stream';
}
