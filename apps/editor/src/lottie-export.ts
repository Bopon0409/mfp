// Export of a frame's animation to Lottie (bodymovin 5.x JSON: lottie-web, Android and iOS players).
// The frame is the composition, its layers are Lottie layers: shapes are vector (paths with the same geometry
// the canvas draws; rectangle and ellipse as primitives so size and corner radius animate),
// text as glyph outlines, stroke as an outline; fills are a color or a linear or radial
// gradient. Images, video, effects, conic gradients and text without outlines are rasterized (PNG in the
// file). Nested frames and groups are nested compositions: opacity and clipping belong to them
// (clipping with corner radius via a mask); non-clipping ones get margins. Keys are in core/lottie.ts.

import { invert, lottieColor, lottieFillColor, lottieNumber, lottieRect, lottieSizeScale, lottieTransform, multiply, timelineDuration, trackOf, type LottieProp, type Matrix } from '@mfp/core';
import { decodePathCommands, type FigPaint, type SceneNode } from '@mfp/io-figma';
import type { SceneRenderer } from '@mfp/renderer';
import type { Editor } from './editor.ts';
import { textOutlines } from './text-outline.ts';
import { t } from './i18n/index.ts';

type Json = Record<string, unknown>;

/** Lottie path: vertices and handles (relative to the vertices). */
interface LPath {
  c: boolean;
  v: [number, number][];
  i: [number, number][];
  o: [number, number][];
}

interface Ctx {
  ed: Editor;
  renderer: SceneRenderer;
  fr: number;
  op: number;
  assets: Json[];
  /** Running index of layers (ind) and assets. */
  ind: number;
  ids: number;
  /** Margin around nested compositions without clipping. */
  margin: number;
  warnings: Set<string>;
}

export interface LottieResult {
  json: string;
  warnings: string[];
}

const FPS = 60;
const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
const BLEND: Record<string, number> = {
  MULTIPLY: 1,
  SCREEN: 2,
  OVERLAY: 3,
  DARKEN: 4,
  LIGHTEN: 5,
  COLOR_DODGE: 6,
  COLOR_BURN: 7,
  HARD_LIGHT: 8,
  SOFT_LIGHT: 9,
  DIFFERENCE: 10,
  EXCLUSION: 11,
  HUE: 12,
  SATURATION: 13,
  COLOR: 14,
  LUMINOSITY: 15,
};
const round = (v: number) => Math.round(v * 1000) / 1000;
const stat = (k: number | number[]): LottieProp => ({ a: 0, k });
/** A constant value of any kind (mask path). */
const fixed = (k: unknown) => ({ a: 0, k });

/** A top-level frame with its animation, to Lottie. */
export async function exportLottie(ed: Editor, root: string): Promise<LottieResult> {
  const doc = ed.doc;
  const renderer = (ed as unknown as { renderer: SceneRenderer }).renderer;
  const sn = ed.scene.node(root);
  if (!sn) throw new Error('Фрейм не на открытой странице');
  const w = doc.get(root, 'width') ?? sn.size.x;
  const h = doc.get(root, 'height') ?? sn.size.y;
  const ctx: Ctx = {
    ed,
    renderer,
    fr: FPS,
    op: Math.max(1, Math.round(timelineDuration(doc, root) * FPS)),
    assets: [],
    ind: 0,
    ids: 0,
    margin: Math.ceil(Math.max(w, h)),
    warnings: new Set(),
  };
  const layers = await childLayers(ctx, sn, [0, 0]);
  // The frame background is the bottom layer.
  const bg = backgroundLayer(ctx, root, sn, [0, 0]);
  if (bg) layers.push(bg);
  const json = {
    v: '5.7.4',
    fr: ctx.fr,
    ip: 0,
    op: ctx.op,
    w: Math.round(w),
    h: Math.round(h),
    nm: doc.get(root, 'name') ?? t('Анимация'),
    ddd: 0,
    assets: ctx.assets,
    layers,
    markers: [],
  };
  return { json: JSON.stringify(json), warnings: [...ctx.warnings] };
}

// ---------- Layers ----------

function base(ctx: Ctx, ty: number, name: string, extra: Json): Json {
  return { ddd: 0, ind: ++ctx.ind, ty, nm: name, sr: 1, ao: 0, ip: 0, op: ctx.op, st: 0, bm: 0, ...extra };
}

/** Layers for a node's children (top to bottom, as in Lottie); offset is the node's origin in its composition. */
async function childLayers(ctx: Ctx, sn: SceneNode, offset: [number, number]): Promise<Json[]> {
  const out: Json[] = [];
  const kids = sn.reverseZ ? [...sn.children].reverse() : sn.children;
  for (const c of kids) {
    const cid = ctx.ed.scene.id(c);
    if (!cid || !c.visible) continue;
    out.unshift(...(await nodeLayers(ctx, cid, c, offset)));
  }
  return out;
}

async function nodeLayers(ctx: Ctx, id: string, sn: SceneNode, offset: [number, number]): Promise<Json[]> {
  const doc = ctx.ed.doc;
  const type = doc.type(id) ?? '';
  const effects = sn.effects.some((e) => e.visible !== false);
  if (CONTAINERS.has(type) && sn.children.length) {
    if (sn.children.some((c) => c.isMask && c.visible)) {
      ctx.warnings.add('Маски — растром (без анимации внутри)');
      return rasterLayers(ctx, id, sn, offset);
    }
    if (effects) ctx.warnings.add('Эффекты фреймов и групп не переносятся');
    return [await precompLayer(ctx, id, sn, offset)];
  }
  const raster = effects || [...sn.fills, ...sn.strokes].some((p) => p.visible !== false && !vectorPaint(p));
  if (raster) return rasterLayers(ctx, id, sn, offset);
  const shapes = leafShapes(ctx, id, sn, [0, 0]);
  if (!shapes) return rasterLayers(ctx, id, sn, offset);
  return [base(ctx, 4, sn.name, { ks: lottieTransform(doc, id, ctx.fr, offset), shapes, bm: BLEND[sn.blendMode] ?? 0 })];
}

/** A frame or group as a nested composition: background, children; clipped by its edges (and a corner radius mask). */
async function precompLayer(ctx: Ctx, id: string, sn: SceneNode, offset: [number, number]): Promise<Json> {
  const doc = ctx.ed.doc;
  const w = sn.size.x;
  const h = sn.size.y;
  const clip = sn.clipsContent;
  const m = clip ? 0 : ctx.margin;
  if (clip && (trackOf(doc, id, 'width') || trackOf(doc, id, 'height'))) ctx.warnings.add('Обрезка фрейма с анимацией размера — по обычному размеру');
  const inner = await childLayers(ctx, sn, [m, m]);
  const bg = backgroundLayer(ctx, id, sn, [m, m]);
  if (bg) inner.push(bg);
  const ref = `comp_${++ctx.ids}`;
  ctx.assets.push({ id: ref, nm: sn.name, fr: ctx.fr, layers: inner });
  const layer = base(ctx, 0, sn.name, { refId: ref, w: Math.ceil(w + 2 * m), h: Math.ceil(h + 2 * m), ks: lottieTransform(doc, id, ctx.fr, offset, [m, m]), bm: BLEND[sn.blendMode] ?? 0 });
  const r = cornerRadius(ctx, id);
  if (clip && r && r > 0) layer.masksProperties = [{ inv: false, mode: 'a', nm: 'Обрезка', pt: fixed(roundRect(0, 0, w, h, r)), o: stat(100), x: stat(0) }];
  return layer;
}

/** Container background (its fills and strokes) as a shape layer at its origin. */
function backgroundLayer(ctx: Ctx, id: string, sn: SceneNode, origin: [number, number]): Json | null {
  if (![...sn.fills, ...sn.strokes].some((p) => p.visible !== false)) return null;
  if ([...sn.fills, ...sn.strokes].some((p) => p.visible !== false && !vectorPaint(p))) ctx.warnings.add('Картинки в фоне фреймов не переносятся');
  const shapes = leafShapes(ctx, id, sn, origin);
  if (!shapes?.length) return null;
  return base(ctx, 4, `${sn.name} — фон`, { ks: { a: stat([0, 0]), p: stat([0, 0]), r: stat(0), s: stat([100, 100]), o: stat(100) }, shapes });
}

/** Raster: an empty layer with position and rotation, the image is its child (placement and scale of the snapshot). */
async function rasterLayers(ctx: Ctx, id: string, sn: SceneNode, offset: [number, number]): Promise<Json[]> {
  const doc = ctx.ed.doc;
  const img = await ctx.ed.renderLocal(id, 2);
  if (!img) return [];
  const ref = `image_${++ctx.ids}`;
  const W = Math.round((img.rect[2] - img.rect[0]) * img.scale);
  const H = Math.round((img.rect[3] - img.rect[1]) * img.scale);
  ctx.assets.push({ id: ref, w: W, h: H, u: '', p: `data:image/png;base64,${base64(img.bytes)}`, e: 1 });
  const ks = lottieTransform(doc, id, ctx.fr, offset);
  const holder = base(ctx, 3, `${sn.name} — положение`, { ks: { ...ks, o: stat(100) } });
  // Size is animated: the snapshot stretches (the path is like the shape's).
  const scale = lottieSizeScale(doc, id, ctx.fr);
  const k = 100 / img.scale;
  const s: LottieProp = scale.a === 0 ? stat([k, k]) : { a: 1, k: scale.k.map((f) => ({ ...f, s: [(f.s[0]! * k) / 100, (f.s[1]! * k) / 100] })) };
  const picture = base(ctx, 2, sn.name, { refId: ref, parent: holder.ind, ks: { a: stat([0, 0]), p: stat([img.rect[0], img.rect[1]]), r: stat(0), s, o: ks.o }, bm: BLEND[sn.blendMode] ?? 0 });
  if (scale.a === 1) ctx.warnings.add('Растровые слои с анимацией размера — растягиваются');
  return [picture, holder];
}

// ---------- Shapes ----------

/** A paint Lottie draws by itself. */
function vectorPaint(p: FigPaint): boolean {
  return p.type === 'SOLID' || p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL';
}

function cornerRadius(ctx: Ctx, id: string): number | null {
  const doc = ctx.ed.doc;
  const r = doc.get(id, 'cornerRadius') ?? 0;
  const corners = [doc.get(id, 'topLeftRadius'), doc.get(id, 'topRightRadius'), doc.get(id, 'bottomRightRadius'), doc.get(id, 'bottomLeftRadius')];
  if (corners.some((c) => c !== undefined && Math.abs(c - r) > 1e-6)) return null;
  if ((doc.get(id, 'cornerSmoothing') ?? 0) > 0) return null;
  return r;
}

/**
 * Lottie groups of a shape layer (top to bottom): stroke as an outline, then fills. origin is where the
 * layer origin sits in its Lottie layer (container background with margin). null: a raster is needed (text without outlines).
 */
function leafShapes(ctx: Ctx, id: string, sn: SceneNode, origin: [number, number]): Json[] | null {
  const doc = ctx.ed.doc;
  const type = doc.type(id) ?? '';
  const groups: Json[] = [];
  const fillIndex = sn.fills.findIndex((p) => p.type === 'SOLID');
  const paintItems = (paints: FigPaint[], evenOdd: boolean, animated: boolean, w: number, h: number) =>
    paints
      .map((p, i) => (p.visible === false ? null : paintItem(ctx, id, p, evenOdd, animated && i === fillIndex, w, h)))
      .filter((x): x is Json => !!x)
      .reverse();
  if (type === 'TEXT') {
    const runs = textOutlines(ctx.ed.ck, ctx.renderer, ctx.ed.fonts, sn);
    if (!runs) return null;
    for (const run of runs) {
      const paths = parseSvgPath(run.d);
      if (!paths.length) continue;
      const items = paintItems(run.fills ?? sn.fills, false, !run.fills, sn.size.x, sn.size.y);
      if (items.length) groups.unshift(group('Текст', [...paths.map(shapePath), ...items], origin));
    }
  } else {
    const prim = primitive(ctx, id);
    const evenOdd = sn.fillGeometry.some((g) => g.windingRule === 'EVENODD');
    let geometry: Json[];
    if (prim) geometry = [prim];
    else {
      const paths: LPath[] = [];
      for (const g of sn.fillGeometry) {
        const bytes = ctx.ed.scene.blobs[g.blob];
        if (bytes) paths.push(...decodePaths(bytes));
      }
      if (!paths.length && CONTAINERS.has(type)) paths.push(roundRect(0, 0, sn.size.x, sn.size.y, 0));
      geometry = sizeScaled(ctx, id, paths.map(shapePath));
    }
    const items = paintItems(sn.fills, evenOdd, true, sn.size.x, sn.size.y);
    if (geometry.length && items.length) groups.push(group('Заливка', [...geometry, ...items], origin));
  }
  // Stroke on top. A rectangle or ellipse with a uniform-width solid stroke uses a Lottie stroke on the same shape
  // (offset by half the width inward or outward): it follows size and corner radius animation.
  // Everything else is an outline, as the canvas draws it (per side, variable width, caps).
  const strokes = sn.strokes.filter((p) => p.visible !== false);
  const st = sn.strokeStyle;
  if (strokes.length && st && !st.sides && !st.widths?.length && !st.brush && strokes.every((p) => p.type === 'SOLID')) {
    const inset = st.align === 'INSIDE' ? st.weight / 2 : st.align === 'OUTSIDE' ? -st.weight / 2 : 0;
    // Center line: a primitive (offset by half the width) or a path (centered stroke: open
    // paths and lines): the Lottie stroke and trim path follow it.
    const geom = primitive(ctx, id, inset);
    const center = !geom && (st.align === 'CENTER' || type === 'LINE') ? centerLine(ctx, id, sn) : null;
    if (geom || center?.length) {
      const all = sn.strokes;
      const items = strokes.map((p) => strokeItem(p, st, ctx, id, all.indexOf(p), all)).reverse();
      const trim = trimItem(ctx, id);
      groups.unshift(group('Обводка', [...(geom ? [geom] : center!), ...(trim ? [trim] : []), ...items], origin));
      return groups;
    }
  }
  if (trackOf(doc, id, 'trimStart') || trackOf(doc, id, 'trimEnd')) ctx.warnings.add('Обрезка контура переносится только у обводки цветом по центру (или у прямоугольника и эллипса)');
  if (strokes.length) {
    const d = ctx.renderer.strokeSvg(sn);
    const paths = d ? parseSvgPath(d) : [];
    if (paths.length) {
      if (trackOf(doc, id, 'width') || trackOf(doc, id, 'height') || trackOf(doc, id, 'cornerRadius')) ctx.warnings.add('Обводка не следует за анимацией размера');
      const items = strokes.map((p) => paintItem(ctx, id, p, false, false, sn.size.x, sn.size.y)).filter((x): x is Json => !!x).reverse();
      groups.unshift(group('Обводка', [...paths.map(shapePath), ...items], origin));
    }
  }
  return groups;
}

/**
 * A rectangle with equal corners and a full ellipse as Lottie primitives (size animates);
 * inset is an inward offset (for the stroke).
 */
function primitive(ctx: Ctx, id: string, inset = 0): Json | null {
  const doc = ctx.ed.doc;
  const type = doc.type(id);
  // The primitive sits at the layer origin: the group shifts by origin, not done here.
  if (type === 'RECTANGLE' || (CONTAINERS.has(type ?? '') && type !== 'GROUP')) {
    if (cornerRadius(ctx, id) === null) return null;
    const r = lottieRect(doc, id, ctx.fr, [0, 0], inset);
    return { ty: 'rc', nm: 'Прямоугольник', d: 1, s: r.s, p: r.p, r: r.r };
  }
  if (type === 'ELLIPSE') {
    const arc = doc.get(id, 'arcData');
    if (arc && (Math.abs(arc.endingAngle - arc.startingAngle) < Math.PI * 2 - 1e-6 || arc.innerRadius > 0)) return null;
    const r = lottieRect(doc, id, ctx.fr, [0, 0], inset);
    return { ty: 'el', nm: 'Эллипс', d: 1, s: r.s, p: r.p };
  }
  return null;
}

/** Paths at the layer's normal size; width and height animation via group scale. */
function sizeScaled(ctx: Ctx, id: string, shapes: Json[]): Json[] {
  const doc = ctx.ed.doc;
  if (!shapes.length || !(trackOf(doc, id, 'width') || trackOf(doc, id, 'height'))) return shapes;
  return [{ ty: 'gr', nm: 'Размер', it: [...shapes, transformItem([0, 0], lottieSizeScale(doc, id, ctx.fr))], np: shapes.length, cix: 2, bm: 0 }];
}

function group(name: string, items: Json[], origin: [number, number]): Json {
  return { ty: 'gr', nm: name, it: [...items, transformItem(origin)], np: items.length, cix: 2, bm: 0 };
}

function transformItem(p: [number, number], s: LottieProp = stat([100, 100])): Json {
  return { ty: 'tr', p: stat(p), a: stat([0, 0]), s, r: stat(0), o: stat(100), sk: stat(0), sa: stat(0) };
}

const shapePath = (p: LPath): Json => ({ ty: 'sh', nm: 'Контур', ks: fixed(p) });

/** Stroke center line (line, open paths, vector paths); size via group scale. */
function centerLine(ctx: Ctx, id: string, sn: SceneNode): Json[] {
  if (ctx.ed.doc.type(id) === 'LINE') return sizeScaled(ctx, id, [shapePath({ c: false, v: [[0, 0], [sn.size.x, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] } as LPath)]);
  const paths: LPath[] = [];
  for (const g of sn.strokeSource ?? sn.fillGeometry) {
    const bytes = ctx.ed.scene.blobs[g.blob];
    if (bytes) paths.push(...decodePaths(bytes));
  }
  return sizeScaled(ctx, id, paths.map(shapePath));
}

/** Trim path (tm): start and end, %, from tracks or constant; null: no trim. */
function trimItem(ctx: Ctx, id: string): Json | null {
  const doc = ctx.ed.doc;
  const start = doc.get(id, 'pathTrimStart') ?? 0;
  const end = doc.get(id, 'pathTrimEnd') ?? 1;
  if (!trackOf(doc, id, 'trimStart') && !trackOf(doc, id, 'trimEnd') && start <= 0 && end >= 1) return null;
  return { ty: 'tm', nm: 'Обрезка', s: lottieNumber(doc, id, 'trimStart', ctx.fr, 100), e: lottieNumber(doc, id, 'trimEnd', ctx.fr, 100), o: stat(0), m: 1 };
}

/**
 * Solid stroke (st): width, join, dashes (an odd count is repeated, as in SVG); color and width
 * from tracks (the stroke color is the first solid one, or stroke.N with the paint index).
 */
function strokeItem(p: FigPaint, st: NonNullable<SceneNode['strokeStyle']>, ctx: Ctx, id: string, index: number, all: FigPaint[]): Json {
  const doc = ctx.ed.doc;
  const c = p.color ?? { r: 0, g: 0, b: 0, a: 1 };
  const firstSolid = all.findIndex((x) => x.type === 'SOLID') === index;
  const prop = trackOf(doc, id, `stroke.${index}`) ? (`stroke.${index}` as const) : firstSolid && trackOf(doc, id, 'stroke') ? ('stroke' as const) : null;
  const color = prop ? lottieColor(doc, id, prop, ctx.fr, { r: c.r, g: c.g, b: c.b, a: 1 }, (c.a ?? 1) * (p.opacity ?? 1)) : { c: stat([c.r, c.g, c.b, 1]), o: stat(100 * (c.a ?? 1) * (p.opacity ?? 1)) };
  const lc = st.startCap === 'ROUND' || st.endCap === 'ROUND' ? 2 : st.startCap === 'SQUARE' || st.endCap === 'SQUARE' ? 3 : 1;
  const item: Json = { ty: 'st', nm: 'Обводка', c: color.c, o: color.o, w: trackOf(doc, id, 'strokeWeight') ? lottieNumber(doc, id, 'strokeWeight', ctx.fr) : stat(st.weight), lc, lj: st.join === 'ROUND' ? 2 : st.join === 'BEVEL' ? 3 : 1, ml: st.miterLimit ?? 4, bm: 0 };
  const dashes = st.dashes.length % 2 ? [...st.dashes, ...st.dashes] : st.dashes;
  if (dashes.some((d) => d > 0)) item.d = [...dashes.map((v, i) => ({ n: i % 2 ? 'g' : 'd', nm: i % 2 ? 'Пробел' : 'Черта', v: stat(v) })), { n: 'o', nm: 'Сдвиг', v: stat(0) }];
  return item;
}

/** Paint → Lottie fill (fl or gf); animated means the color follows the “Fill color” track. */
function paintItem(ctx: Ctx, id: string, p: FigPaint, evenOdd: boolean, animated: boolean, w: number, h: number): Json | null {
  const r = evenOdd ? 2 : 1;
  const op = p.opacity ?? 1;
  if (p.type === 'SOLID') {
    const c = p.color ?? { r: 0, g: 0, b: 0, a: 1 };
    if (animated) {
      const f = lottieFillColor(ctx.ed.doc, id, ctx.fr, { r: c.r, g: c.g, b: c.b, a: 1 }, (c.a ?? 1) * op);
      return { ty: 'fl', nm: 'Заливка', c: f.c, o: f.o, r, bm: 0 };
    }
    return { ty: 'fl', nm: 'Заливка', c: stat([c.r, c.g, c.b, 1]), o: stat(100 * (c.a ?? 1) * op), r, bm: 0 };
  }
  if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
    const stops = [...(p.stops ?? [])].sort((a, b) => a.position - b.position);
    if (!stops.length) return null;
    const t: Matrix = p.transform ? [p.transform.m00, p.transform.m01, p.transform.m02, p.transform.m10, p.transform.m11, p.transform.m12] : [1, 0, 0, 0, 1, 0];
    // Gradient space → layer coordinates (as in SVG export).
    const local = multiply([w, 0, 0, 0, h, 0], invert(t));
    const at = (x: number, y: number): [number, number] => [round(local[0] * x + local[1] * y + local[2]), round(local[3] * x + local[4] * y + local[5])];
    const linear = p.type === 'GRADIENT_LINEAR';
    const colors = stops.flatMap((s) => [round(s.position), s.color.r, s.color.g, s.color.b]);
    const alpha = stops.some((s) => s.color.a < 1) ? stops.flatMap((s) => [round(s.position), s.color.a]) : [];
    return {
      ty: 'gf',
      nm: 'Градиент',
      o: stat(100 * op),
      r,
      bm: 0,
      g: { p: stops.length, k: stat([...colors, ...alpha]) },
      s: stat(linear ? at(0, 0.5) : at(0.5, 0.5)),
      e: stat(at(1, 0.5)),
      t: linear ? 1 : 2,
      h: stat(0),
      a: stat(0),
    };
  }
  return null;
}

// ---------- Paths ----------

/** A rounded rectangle as a Lottie path (handles are a quarter circle). */
function roundRect(x: number, y: number, w: number, h: number, r: number): LPath {
  const k = 0.5523;
  const q = Math.min(r, w / 2, h / 2);
  if (q <= 0) return { c: true, v: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]] };
  const c = q * k;
  return {
    c: true,
    v: [[x + q, y], [x + w - q, y], [x + w, y + q], [x + w, y + h - q], [x + w - q, y + h], [x + q, y + h], [x, y + h - q], [x, y + q]],
    i: [[-c, 0], [0, 0], [0, -c], [0, 0], [c, 0], [0, 0], [0, c], [0, 0]],
    o: [[0, 0], [c, 0], [0, 0], [0, c], [0, 0], [-c, 0], [0, 0], [0, -c]],
  };
}

/** Path builder from commands (moveTo, lineTo, quadTo, cubicTo, close). */
class PathSink {
  paths: LPath[] = [];
  private cur: LPath | null = null;
  private last: [number, number] = [0, 0];

  moveTo(x: number, y: number) {
    this.finish();
    this.cur = { c: false, v: [[round(x), round(y)]], i: [[0, 0]], o: [[0, 0]] };
    this.last = [x, y];
  }

  lineTo(x: number, y: number) {
    if (!this.cur) this.moveTo(...this.last);
    this.cur!.v.push([round(x), round(y)]);
    this.cur!.i.push([0, 0]);
    this.cur!.o.push([0, 0]);
    this.last = [x, y];
  }

  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    if (!this.cur) this.moveTo(...this.last);
    const c = this.cur!;
    const [lx, ly] = this.last;
    c.o[c.o.length - 1] = [round(x1 - lx), round(y1 - ly)];
    c.v.push([round(x), round(y)]);
    c.i.push([round(x2 - x), round(y2 - y)]);
    c.o.push([0, 0]);
    this.last = [x, y];
  }

  quadTo(x1: number, y1: number, x: number, y: number) {
    const [lx, ly] = this.last;
    this.cubicTo(lx + ((x1 - lx) * 2) / 3, ly + ((y1 - ly) * 2) / 3, x + ((x1 - x) * 2) / 3, y + ((y1 - y) * 2) / 3, x, y);
  }

  close() {
    const c = this.cur;
    if (!c) return;
    // Merge the last vertex into the first (the in-handle belongs to the first).
    const n = c.v.length;
    if (n > 1 && Math.abs(c.v[n - 1]![0] - c.v[0]![0]) < 1e-3 && Math.abs(c.v[n - 1]![1] - c.v[0]![1]) < 1e-3) {
      c.i[0] = c.i[n - 1]!;
      c.v.pop();
      c.i.pop();
      c.o.pop();
    }
    c.c = true;
    this.last = c.v[0]!;
    this.finish();
  }

  finish() {
    if (this.cur && this.cur.v.length > 1) this.paths.push(this.cur);
    this.cur = null;
  }
}

function decodePaths(bytes: Uint8Array): LPath[] {
  const sink = new PathSink();
  decodePathCommands(bytes, {
    moveTo: (x, y) => sink.moveTo(x, y),
    lineTo: (x, y) => sink.lineTo(x, y),
    quadTo: (x1, y1, x, y) => sink.quadTo(x1, y1, x, y),
    cubicTo: (x1, y1, x2, y2, x, y) => sink.cubicTo(x1, y1, x2, y2, x, y),
    close: () => sink.close(),
  });
  sink.finish();
  return sink.paths;
}

/** SVG path (M L H V C S Q T Z, absolute and relative; arcs as a line segment) → Lottie paths. */
export function parseSvgPath(d: string): LPath[] {
  const sink = new PathSink();
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let prev: [number, number] | null = null;
  let prevQ: [number, number] | null = null;
  const n = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + n();
        y = oy + n();
        sink.moveTo(x, y);
        [sx, sy] = [x, y];
        cmd = rel ? 'l' : 'L';
        prev = prevQ = null;
        break;
      case 'L':
        x = ox + n();
        y = oy + n();
        sink.lineTo(x, y);
        prev = prevQ = null;
        break;
      case 'H':
        x = ox + n();
        sink.lineTo(x, y);
        prev = prevQ = null;
        break;
      case 'V':
        y = oy + n();
        sink.lineTo(x, y);
        prev = prevQ = null;
        break;
      case 'C': {
        const x1 = ox + n();
        const y1 = oy + n();
        const x2 = ox + n();
        const y2 = oy + n();
        x = ox + n();
        y = oy + n();
        sink.cubicTo(x1, y1, x2, y2, x, y);
        prev = [x2, y2];
        prevQ = null;
        break;
      }
      case 'S': {
        const [x1, y1] = reflect(prev, x, y);
        const x2 = ox + n();
        const y2 = oy + n();
        x = ox + n();
        y = oy + n();
        sink.cubicTo(x1, y1, x2, y2, x, y);
        prev = [x2, y2];
        prevQ = null;
        break;
      }
      case 'Q': {
        const x1 = ox + n();
        const y1 = oy + n();
        x = ox + n();
        y = oy + n();
        sink.quadTo(x1, y1, x, y);
        prevQ = [x1, y1];
        prev = null;
        break;
      }
      case 'T': {
        const [x1, y1] = reflect(prevQ, x, y);
        x = ox + n();
        y = oy + n();
        sink.quadTo(x1, y1, x, y);
        prevQ = [x1, y1];
        prev = null;
        break;
      }
      case 'A': {
        i += 5;
        x = ox + n();
        y = oy + n();
        sink.lineTo(x, y);
        prev = prevQ = null;
        break;
      }
      case 'Z':
        sink.close();
        [x, y] = [sx, sy];
        prev = prevQ = null;
        break;
      default:
        i++;
    }
  }
  sink.finish();
  return sink.paths;
}

/** Reflection of the previous segment's handle through the current point (S and T in SVG). */
function reflect(p: [number, number] | null, x: number, y: number): [number, number] {
  return p ? [2 * x - p[0], 2 * y - p[1]] : [x, y];
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
