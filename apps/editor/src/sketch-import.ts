// Sketch import (.sketch — ZIP with JSON: document.json, pages/<id>.json, images/…). Pages become
// pages, artboards — frames, symbols — components (library symbols — on a service
// page), their instances — instances with text overrides; groups and boolean groups
// (shapeGroup); shapes — paths from points (curvePoint: point and “to” and “from” handles,
// coordinates are fractions of the layer box), rectangle and ellipse — their own types; text — with run
// styles; images — as fills; fills (color, gradients, image), strokes, shadows, blur,
// masks, opacity and blending. Rotation — around the box center, flips — along the axes.

import { Document, instantiate, restyleText, type Effect, type Matrix, type Paint, type Props, type RGBA } from '@mfp/core';
import { MemorySource, readZipDirectory, readZipEntry, type ByteSource, type ImageBytesSource, type ZipEntry } from '@mfp/io-figma';
import { fontFace } from './pdf/fonts.ts';

type J = Record<string, any>;

export interface SketchImport {
  doc: Document;
  images: ImageBytesSource;
  pages: number;
  warnings: string[];
}

const BLEND = ['NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'];

/** «{0.5, 0.25}» → [0.5, 0.25]. */
export function sketchPoint(s: unknown): [number, number] {
  const m = /\{\s*([-\d.e+]+)\s*,\s*([-\d.e+]+)\s*\}/i.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

const color = (c: J | undefined): RGBA => ({ r: c?.red ?? 0, g: c?.green ?? 0, b: c?.blue ?? 0, a: c?.alpha ?? 1 });

/** SVG path from Sketch points (fractions of the w × h box). */
export function sketchPath(points: J[], closed: boolean, w: number, h: number): string {
  if (!points.length) return '';
  const P = (s: unknown) => {
    const [x, y] = sketchPoint(s);
    return [x * w, y * h] as [number, number];
  };
  const f = (v: number) => String(Math.round(v * 1000) / 1000);
  const curved = (p: J, k: 'From' | 'To') => (p[`hasCurve${k}`] !== undefined ? p[`hasCurve${k}`] === true : p.curveMode !== 1 && String(p[`curve${k}`]) !== String(p.point));
  const seg = (a: J, b: J) => {
    const pb = P(b.point);
    if (!curved(a, 'From') && !curved(b, 'To')) return `L ${f(pb[0])} ${f(pb[1])}`;
    const c1 = curved(a, 'From') ? P(a.curveFrom) : P(a.point);
    const c2 = curved(b, 'To') ? P(b.curveTo) : pb;
    return `C ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(pb[0])} ${f(pb[1])}`;
  };
  const p0 = P(points[0]!.point);
  const out = [`M ${f(p0[0])} ${f(p0[1])}`];
  for (let i = 0; i + 1 < points.length; i++) out.push(seg(points[i]!, points[i + 1]!));
  if (closed) out.push(seg(points[points.length - 1]!, points[0]!), 'Z');
  return out.join(' ');
}

/** Box, rotation (around the center) and flips → layer matrix in the parent. */
export function sketchTransform(l: J): Matrix {
  const fr = l.frame ?? {};
  const w = fr.width ?? 0;
  const h = fr.height ?? 0;
  const rad = (-(l.rotation ?? 0) * Math.PI) / 180;
  const fx = l.isFlippedHorizontal ? -1 : 1;
  const fy = l.isFlippedVertical ? -1 : 1;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const a = cos * fx;
  const b = -sin * fy;
  const c = sin * fx;
  const d = cos * fy;
  const cx = (fr.x ?? 0) + w / 2;
  const cy = (fr.y ?? 0) + h / 2;
  return [a, b, cx - (a * w) / 2 - (b * h) / 2, c, d, cy - (c * w) / 2 - (d * h) / 2];
}

/** Sketch gradient (from, to — fractions of the box) → paint. */
function gradientPaint(g: J, opacity: number): Paint | null {
  const type = g.gradientType === 1 ? 'GRADIENT_RADIAL' : g.gradientType === 2 ? 'GRADIENT_ANGULAR' : 'GRADIENT_LINEAR';
  const from = sketchPoint(g.from);
  const to = sketchPoint(g.to);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  let G: Matrix;
  if (type === 'GRADIENT_LINEAR') G = [dx, -dy, from[0] + dy / 2, dy, dx, from[1] - dx / 2];
  else {
    const e = g.elipseLength ?? 1;
    const px = -dy * e;
    const py = dx * e;
    G = [2 * dx, 2 * px, from[0] - dx - px, 2 * dy, 2 * py, from[1] - dy - py];
  }
  const det = G[0] * G[4] - G[1] * G[3];
  if (Math.abs(det) < 1e-12) return null;
  const t = [G[4] / det, -G[1] / det, (G[1] * G[5] - G[4] * G[2]) / det, -G[3] / det, G[0] / det, (G[3] * G[2] - G[0] * G[5]) / det];
  return {
    type,
    gradientTransform: [
      [t[0]!, t[1]!, t[2]!],
      [t[3]!, t[4]!, t[5]!],
    ],
    gradientStops: (g.stops ?? []).map((s: J) => ({ position: s.position ?? 0, color: color(s.color) })),
    ...(opacity < 1 ? { opacity } : {}),
  } as Paint;
}

export async function importSketch(src: ByteSource | Uint8Array, name: string): Promise<SketchImport> {
  const source = src instanceof Uint8Array ? new MemorySource(src) : src;
  const entries = new Map<string, ZipEntry>();
  for (const e of await readZipDirectory(source)) entries.set(e.name, e);
  const json = async (path: string): Promise<J | null> => {
    const e = entries.get(path);
    return e ? (JSON.parse(new TextDecoder().decode(await readZipEntry(source, e))) as J) : null;
  };
  const document = await json('document.json');
  if (!document) throw new Error('Не файл Sketch (нет document.json); старые версии Sketch (до 43) не поддерживаются');
  const warnings = new Set<string>();
  const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
  const images = new Map<string, Uint8Array>();
  const imageRefs = new Map<string, string | null>();
  const imageOf = async (ref: J | undefined): Promise<string | null> => {
    const path = ref?._ref ? (String(ref._ref).match(/\.[a-z]+$/i) ? String(ref._ref) : `${ref._ref}.png`) : null;
    if (!path) return null;
    if (imageRefs.has(path)) return imageRefs.get(path)!;
    const e = entries.get(path);
    let hash: string | null = null;
    if (e) {
      const bytes = await readZipEntry(source, e);
      const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
      hash = Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
      images.set(hash, bytes);
    } else warnings.add('Часть картинок не найдена в файле');
    imageRefs.set(path, hash);
    return hash;
  };

  // ---------- Style ----------
  const style = async (s: J | undefined, frame: { w: number; h: number }): Promise<Props> => {
    const out: Props = {};
    if (!s) return out;
    const fills: Paint[] = [];
    for (const f of s.fills ?? []) {
      if (f.isEnabled === false) continue;
      const op = f.contextSettings?.opacity ?? 1;
      if (f.fillType === 1 && f.gradient) {
        const g = gradientPaint(f.gradient, op);
        if (g) fills.push(g);
      } else if (f.fillType === 4 && f.image) {
        const hash = await imageOf(f.image);
        if (hash) fills.push({ type: 'IMAGE', scaleMode: (['TILE', 'FILL', 'CROP', 'FIT'] as const)[f.patternFillType ?? 1] ?? 'FILL', imageHash: hash, ...(f.patternFillType === 2 ? { imageTransform: [[1, 0, 0], [0, 1, 0]] } : {}), ...(op < 1 ? { opacity: op } : {}) } as Paint);
      } else {
        const c = color(f.color);
        fills.push({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, ...(c.a * op < 1 ? { opacity: c.a * op } : {}) });
      }
    }
    out.fills = fills;
    const borders = (s.borders ?? []).filter((b: J) => b.isEnabled !== false);
    if (borders.length) {
      out.strokes = borders.map((b: J) => {
        if (b.fillType === 1 && b.gradient) return gradientPaint(b.gradient, b.contextSettings?.opacity ?? 1);
        const c = color(b.color);
        return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, ...(c.a < 1 ? { opacity: c.a } : {}) } as Paint;
      }).filter((p: Paint | null): p is Paint => !!p);
      out.strokeWeight = borders[0].thickness ?? 1;
      out.strokeAlign = borders[0].position === 1 ? 'INSIDE' : borders[0].position === 2 ? 'OUTSIDE' : 'CENTER';
      const bo = s.borderOptions ?? {};
      if (bo.dashPattern?.length) out.dashPattern = bo.dashPattern.length % 2 ? [...bo.dashPattern, ...bo.dashPattern] : bo.dashPattern;
      if (bo.lineJoinStyle) out.strokeJoin = bo.lineJoinStyle === 1 ? 'ROUND' : bo.lineJoinStyle === 2 ? 'BEVEL' : 'MITER';
      if (bo.lineCapStyle) out.strokeStartCap = out.strokeEndCap = bo.lineCapStyle === 1 ? 'ROUND' : 'SQUARE';
    }
    const effects: Effect[] = [];
    for (const sh of s.shadows ?? []) if (sh.isEnabled !== false) effects.push({ type: 'DROP_SHADOW', color: color(sh.color), offset: { x: sh.offsetX ?? 0, y: sh.offsetY ?? 0 }, radius: sh.blurRadius ?? 0, spread: sh.spread ?? 0, visible: true, blendMode: 'NORMAL' } as Effect);
    for (const sh of s.innerShadows ?? []) if (sh.isEnabled !== false) effects.push({ type: 'INNER_SHADOW', color: color(sh.color), offset: { x: sh.offsetX ?? 0, y: sh.offsetY ?? 0 }, radius: sh.blurRadius ?? 0, spread: sh.spread ?? 0, visible: true, blendMode: 'NORMAL' } as Effect);
    if (s.blur?.isEnabled) effects.push({ type: s.blur.type === 3 ? 'BACKGROUND_BLUR' : 'LAYER_BLUR', radius: s.blur.radius ?? 0, visible: true } as Effect);
    if (effects.length) out.effects = effects;
    const ctx = s.contextSettings ?? {};
    if (ctx.opacity !== undefined && ctx.opacity < 1) out.opacity = ctx.opacity;
    if (ctx.blendMode) out.blendMode = BLEND[ctx.blendMode] as Props['blendMode'];
    void frame;
    return out;
  };

  // ---------- Layers ----------
  const masters = new Map<string, string>();
  /** Main layer objectID → our id (text overrides in instances). */
  const byObject = new Map<string, string>();
  const deferred: { parent: string; index: number; layer: J }[] = [];

  const common = (l: J): Props => {
    const fr = l.frame ?? {};
    return {
      name: String(l.name ?? l._class),
      transform: sketchTransform(l),
      width: Math.max(0.01, fr.width ?? 0),
      height: Math.max(0.01, fr.height ?? 0),
      ...(l.isVisible === false ? { visible: false } : {}),
      ...(l.isLocked ? { locked: true } : {}),
      ...(l.hasClippingMask ? { isMask: true, maskType: 'VECTOR' } : {}),
    } as Props;
  };

  const shapeProps = async (l: J, path: string): Promise<Props> => {
    const fr = l.frame ?? {};
    const w = Math.max(0.01, fr.width ?? 0);
    const h = Math.max(0.01, fr.height ?? 0);
    return {
      ...common(l),
      ...(await style(l.style, { w, h })),
      geometrySize: { width: w, height: h },
      vectorPaths: [{ windingRule: l.style?.windingRule === 1 ? 'EVENODD' : 'NONZERO', data: path }],
    };
  };

  const text = async (l: J, parent: string, index: number) => {
    const as = l.attributedString ?? {};
    const chars = String(as.string ?? '');
    const runs: J[] = as.attributes ?? [];
    const enc = l.style?.textStyle?.encodedAttributes ?? {};
    const fontOf = (a: J) => {
      const f = a.MSAttributedStringFontAttribute?.attributes ?? {};
      const face = fontFace(String(f.name ?? 'Helvetica'));
      return { fontName: face, fontSize: f.size ?? 12 };
    };
    const first = runs[0]?.attributes ?? enc;
    const base = fontOf(first);
    const c = color(first.MSAttributedStringColorAttribute ?? enc.MSAttributedStringColorAttribute);
    const para = first.paragraphStyle ?? enc.paragraphStyle ?? {};
    const st = await style(l.style, { w: l.frame?.width ?? 0, h: l.frame?.height ?? 0 });
    const props: Props = {
      ...common(l),
      ...st,
      characters: chars,
      fontName: base.fontName,
      fontSize: base.fontSize,
      fills: [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, ...(c.a < 1 ? { opacity: c.a } : {}) }],
      textAlignHorizontal: (['LEFT', 'RIGHT', 'CENTER', 'JUSTIFIED', 'LEFT'] as const)[para.alignment ?? 0] ?? 'LEFT',
      textAutoResize: l.textBehaviour === 0 ? 'WIDTH_AND_HEIGHT' : l.textBehaviour === 2 ? 'NONE' : 'HEIGHT',
      ...(para.maximumLineHeight ? { lineHeight: { unit: 'PIXELS', value: para.maximumLineHeight } } : {}),
      ...(first.kerning ? { letterSpacing: { unit: 'PIXELS', value: first.kerning } } : {}),
    } as Props;
    const id = doc.create('TEXT', parent, props, index);
    // Runs with a different font, size or color.
    for (const r of runs.slice(1)) {
      const a = r.attributes ?? {};
      const f = fontOf(a);
      const rc = color(a.MSAttributedStringColorAttribute);
      const start = r.location ?? 0;
      const end = start + (r.length ?? 0);
      if (end <= start) continue;
      try {
        restyleText(doc, id, start, end, () => ({ fontName: f.fontName, fontSize: f.fontSize, fills: [{ type: 'SOLID', color: { r: rc.r, g: rc.g, b: rc.b }, ...(rc.a < 1 ? { opacity: rc.a } : {}) }] }));
      } catch {
        warnings.add('Часть оформления текста не перенеслась');
      }
    }
    return id;
  };

  const layer = async (l: J, parent: string, index: number): Promise<string | null> => {
    const cls = String(l._class);
    let id: string | null = null;
    switch (cls) {
      case 'artboard':
      case 'symbolMaster': {
        const fr = l.frame ?? {};
        const bg = l.hasBackgroundColor ? color(l.backgroundColor) : { r: 1, g: 1, b: 1, a: 1 };
        const st = await style(l.style, { w: fr.width ?? 0, h: fr.height ?? 0 });
        id = doc.create(cls === 'symbolMaster' ? 'COMPONENT' : 'FRAME', parent, { ...common(l), ...st, fills: [{ type: 'SOLID', color: { r: bg.r, g: bg.g, b: bg.b }, ...(bg.a < 1 ? { opacity: bg.a } : {}) }], clipsContent: true }, index);
        if (cls === 'symbolMaster' && l.symbolID) masters.set(String(l.symbolID), id);
        break;
      }
      case 'group':
        id = doc.create('GROUP', parent, { ...common(l), ...(await style(l.style, { w: 0, h: 0 })) }, index);
        break;
      case 'shapeGroup': {
        const ops = (l.layers ?? []).slice(1).map((c: J) => c.booleanOperation ?? -1);
        const op = ops.find((o: number) => o >= 0);
        const st = await style(l.style, { w: l.frame?.width ?? 0, h: l.frame?.height ?? 0 });
        id = doc.create(op === undefined ? 'GROUP' : 'BOOLEAN_OPERATION', parent, { ...common(l), ...st, ...(op !== undefined ? { booleanOperation: (['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'] as const)[op] ?? 'UNION' } : {}) }, index);
        if (op !== undefined && new Set(ops.filter((o: number) => o >= 0)).size > 1) warnings.add('Булевы группы с разными операциями — одной операцией');
        break;
      }
      case 'rectangle':
      case 'oval':
      case 'star':
      case 'polygon':
      case 'triangle':
      case 'shapePath': {
        const fr = l.frame ?? {};
        const pts: J[] = l.points ?? [];
        const radii = pts.map((p) => p.cornerRadius ?? 0);
        const uniform = cls === 'rectangle' && radii.every((r) => Math.abs(r - (radii[0] ?? 0)) < 1e-6);
        if (uniform) {
          id = doc.create('RECTANGLE', parent, { ...common(l), ...(await style(l.style, { w: fr.width ?? 0, h: fr.height ?? 0 })), cornerRadius: l.fixedRadius ?? radii[0] ?? 0 }, index);
        } else if (cls === 'oval') {
          id = doc.create('ELLIPSE', parent, { ...common(l), ...(await style(l.style, { w: fr.width ?? 0, h: fr.height ?? 0 })) }, index);
        } else {
          id = doc.create('VECTOR', parent, await shapeProps(l, sketchPath(pts, l.isClosed !== false, fr.width ?? 0, fr.height ?? 0)), index);
        }
        break;
      }
      case 'text':
        id = await text(l, parent, index);
        break;
      case 'bitmap': {
        const hash = await imageOf(l.image);
        id = doc.create('RECTANGLE', parent, { ...common(l), ...(await style(l.style, { w: 0, h: 0 })), fills: hash ? [{ type: 'IMAGE', scaleMode: 'CROP', imageHash: hash, imageTransform: [[1, 0, 0], [0, 1, 0]] }] : [] }, index);
        break;
      }
      case 'symbolInstance':
        deferred.push({ parent, index, layer: l });
        return null;
      case 'slice':
      case 'MSImmutableHotspotLayer':
        return null;
      default:
        warnings.add(`Слои «${cls}» не переносятся`);
        return null;
    }
    if (id && l.do_objectID) byObject.set(String(l.do_objectID), id);
    if (id && Array.isArray(l.layers) && cls !== 'text') {
      let i = 0;
      for (const c of l.layers) if (await layer(c, id, i)) i++;
    }
    return id;
  };

  // Pages, then library symbols (service page), then instances.
  const pageRefs: J[] = document.pages ?? [];
  let pageCount = 0;
  for (const ref of pageRefs) {
    const p = await json(`${ref._ref}.json`);
    if (!p) continue;
    const page = doc.create('PAGE', doc.root, { name: String(p.name ?? `Страница ${pageCount + 1}`) });
    pageCount++;
    let i = 0;
    for (const l of p.layers ?? []) if (await layer(l, page, i)) i++;
  }
  const foreign: J[] = (document.foreignSymbols ?? []).map((f: J) => f.symbolMaster ?? f.originalMaster).filter(Boolean);
  if (foreign.length) {
    const lib = doc.create('PAGE', doc.root, { name: 'Символы библиотек', internal: true });
    let i = 0;
    for (const m of foreign) if (await layer(m, lib, i)) i++;
  }
  // Instances: in ascending order of position in the parent (an insert doesn't shift those not yet inserted).
  deferred.sort((a, b) => a.index - b.index);
  for (const d of deferred) {
    const l = d.layer;
    const master = masters.get(String(l.symbolID));
    if (!master) {
      warnings.add('Экземпляры символов без мастера (библиотека недоступна) — пропущены');
      continue;
    }
    const at = Math.min(d.index, doc.children(d.parent).length);
    const inst = instantiate(doc, master, d.parent, sketchTransform(l), at);
    const c = common(l);
    doc.set(inst, { name: c.name, width: c.width, height: c.height, ...(c.visible === false ? { visible: false } : {}) });
    // Text overrides: “<main layer objectID>_stringValue”.
    for (const ov of l.overrideValues ?? []) {
      const m = /^(.+)_stringValue$/.exec(String(ov.overrideName ?? ''));
      const masterLayer = m ? byObject.get(m[1]!.split('/').pop()!) : undefined;
      if (!masterLayer) continue;
      const target = findRef(doc, inst, masterLayer);
      if (target && doc.type(target) === 'TEXT') doc.set(target, { characters: String(ov.value ?? ''), overrides: [...(doc.get(target, 'overrides') ?? []), 'characters'] });
    }
  }
  doc.clearHistory();
  return { doc, images: { readImage: async (h) => images.get(h) }, pages: pageCount, warnings: [...warnings] };
}

/** Copy of the main layer ref inside an instance. */
function findRef(doc: Document, root: string, ref: string): string | null {
  for (const c of doc.children(root)) {
    if (doc.get(c, 'componentRef') === ref) return c;
    const deep = findRef(doc, c, ref);
    if (deep) return deep;
  }
  return null;
}
