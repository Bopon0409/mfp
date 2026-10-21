// MFP document model (@mfp/core) → render tree (SceneNode), incrementally.
//
// CoreScene keeps a mirror of one document page for rendering and updates it
// from document operations: only the affected node changes, its bounds and its
// ancestors' bounds are recomputed, and the regions for tile redraw are returned.
// Shape geometry is built here (path commands in the format the renderer understands).

import { invert3, layerProjection, mapPoint3, perspectiveMatrix, type Document, type Effect, type Op, type Paint, type Props } from '@mfp/core';
import { resolveFigmaShader, strokeOutsetOf, type FigEffect, type FigPaint, type Matrix2D, type SceneNode, type ScenePage } from '@mfp/io-figma';
import { textLayoutOf } from './text.ts';
import { textPathScale } from './text-path.ts';
import { capExtent, sidesOutset } from './stroke.ts';
import { brushReach } from './brushes.ts';
import { nodeWorld, type SceneRenderer } from './renderer.ts';

type Rect = [number, number, number, number];

/**
 * Parsed paths (SVG path → renderer format), shared by all scenes of the document: a page
 * you return to is built without re-parsing. Key: the blob key, or the path itself plus the scale.
 */
const PARSED = new WeakMap<Document, Map<string, Uint8Array>>();

/** Encodes path commands into the blob format: 0 close, 1 move, 2 line, 4 cubic; float32 LE. */
class PathWriter {
  private bytes: number[] = [];
  private view = new DataView(new ArrayBuffer(4));
  private num(v: number) {
    this.view.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) this.bytes.push(this.view.getUint8(i));
  }
  move(x: number, y: number) {
    this.bytes.push(1);
    this.num(x);
    this.num(y);
    return this;
  }
  line(x: number, y: number) {
    this.bytes.push(2);
    this.num(x);
    this.num(y);
    return this;
  }
  quad(x1: number, y1: number, x: number, y: number) {
    this.bytes.push(3);
    for (const v of [x1, y1, x, y]) this.num(v);
    return this;
  }
  cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.bytes.push(4);
    for (const v of [x1, y1, x2, y2, x, y]) this.num(v);
    return this;
  }
  close() {
    this.bytes.push(0);
    return this;
  }
  done() {
    return new Uint8Array(this.bytes);
  }
}

const K = 0.5522847498; // quarter-circle approximation with a cubic curve

/**
 * Rectangle with rounded corners: a single radius or per corner [tl, tr, br, bl].
 * As in CSS: if adjacent radii do not fit on a side, all are reduced proportionally.
 * smoothing — corner smoothing (0…1), see smoothRectPath.
 */
export function roundedRectPath(w: number, h: number, r: number | [number, number, number, number], smoothing = 0): Uint8Array {
  let [tl, tr, br, bl] = (typeof r === 'number' ? [r, r, r, r] : r).map((v) => Math.max(0, v)) as [number, number, number, number];
  const fit = (side: number, a: number, b: number) => (a + b > side ? side / (a + b) : 1);
  const f = Math.min(fit(w, tl, tr), fit(w, bl, br), fit(h, tl, bl), fit(h, tr, br));
  [tl, tr, br, bl] = [tl * f, tr * f, br * f, bl * f];
  if (smoothing > 0 && (tl || tr || br || bl)) return smoothRectPath(w, h, [tl, tr, br, bl], Math.min(1, smoothing));
  const p = new PathWriter();
  if (!tl && !tr && !br && !bl) return p.move(0, 0).line(w, 0).line(w, h).line(0, h).close().done();
  p.move(tl, 0).line(w - tr, 0);
  if (tr) p.cubic(w - tr + tr * K, 0, w, tr - tr * K, w, tr);
  p.line(w, h - br);
  if (br) p.cubic(w, h - br + br * K, w - br + br * K, h, w - br, h);
  p.line(bl, h);
  if (bl) p.cubic(bl - bl * K, h, 0, h - bl + bl * K, 0, h - bl);
  p.line(0, tl);
  if (tl) p.cubic(0, tl - tl * K, tl - tl * K, 0, tl, 0);
  return p.close().done();
}

/**
 * Smoothed corners (superellipse, “iOS-style”): a corner is a transition curve, a circular arc of
 * (1 − ξ)·90° and the same curve back; the corner occupies (1 + ξ)·R of the side. The construction follows
 * the public description of corner smoothing (“Desperately seeking squircles”). If it does not fit, smoothing
 * is reduced.
 */
function smoothRectPath(w: number, h: number, radii: [number, number, number, number], smoothing: number): Uint8Array {
  const budget = Math.min(w, h) / 2;
  type P = [number, number];
  /** Corner points in its own frame: vertex (0; 0), incoming side along +x, outgoing along +y. */
  const corner = (R0: number): { pts: P[] } | null => {
    const R = Math.min(R0, budget);
    if (R <= 0) return null;
    const xi = Math.max(0, Math.min(smoothing, budget / R - 1));
    const p = Math.min((1 + xi) * R, budget);
    const arcMeasure = 90 * (1 - xi);
    const rad = Math.PI / 180;
    const arcLen = Math.sin((arcMeasure / 2) * rad) * R * Math.SQRT2;
    const alpha = (90 - arcMeasure) / 2;
    const p34 = R * Math.tan((alpha / 2) * rad);
    const beta = 45 * xi;
    const c = p34 * Math.cos(beta * rad);
    const d = c * Math.tan(beta * rad);
    const b = (p - arcLen - c - d) / 3;
    const a = 2 * b;
    const s1: P = [-p + a + b + c, d];
    const s2: P = [s1[0] + arcLen, s1[1] + arcLen];
    // Arc S1→S2 as one cubic curve: center (−R; R), tangents in traversal direction.
    const th = arcMeasure * rad;
    const k = (4 / 3) * Math.tan(th / 4) * R;
    const phi1 = Math.atan2(s1[1] - R, s1[0] + R);
    const phi2 = phi1 + th;
    const a1: P = [s1[0] - Math.sin(phi1) * k, s1[1] + Math.cos(phi1) * k];
    const a2: P = [s2[0] + Math.sin(phi2) * k, s2[1] - Math.cos(phi2) * k];
    return {
      pts: [[-p, 0], [-p + a, 0], [-p + a + b, 0], s1, a1, a2, s2, [s2[0] + d, s2[1] + c], [s2[0] + d, s2[1] + b + c], [0, p]],
    };
  };
  // Corners in traversal order: the vertex and the rotation of the corner frame (entering along the side toward the vertex).
  const maps: ((q: P) => P)[] = [
    ([x, y]) => [w + x, y], // top right
    ([x, y]) => [w - y, h + x], // bottom right
    ([x, y]) => [-x, h - y], // bottom left
    ([x, y]) => [y, -x], // top left
  ];
  const order = [radii[1], radii[2], radii[3], radii[0]];
  const vertex: P[] = [
    [w, 0],
    [w, h],
    [0, h],
    [0, 0],
  ];
  const corners = order.map((r) => corner(r));
  const out = new PathWriter();
  // Start: the end of the top-left corner (or the vertex itself).
  const tlc = corners[3];
  const start: P = tlc ? maps[3]!(tlc.pts[9]!) : vertex[3]!;
  out.move(start[0], start[1]);
  corners.forEach((c, i) => {
    const m = maps[i]!;
    if (!c) {
      out.line(vertex[i]![0], vertex[i]![1]);
      return;
    }
    const q = c.pts.map(m);
    out.line(q[0]![0], q[0]![1]);
    out.cubic(q[1]![0], q[1]![1], q[2]![0], q[2]![1], q[3]![0], q[3]![1]);
    if (Math.abs(q[6]![0] - q[3]![0]) > 1e-6 || Math.abs(q[6]![1] - q[3]![1]) > 1e-6) out.cubic(q[4]![0], q[4]![1], q[5]![0], q[5]![1], q[6]![0], q[6]![1]);
    out.cubic(q[7]![0], q[7]![1], q[8]![0], q[8]![1], q[9]![0], q[9]![1]);
  });
  return out.close().done();
}

const radiiTuple = (r: number | [number, number, number, number]): [number, number, number, number] => (typeof r === 'number' ? [r, r, r, r] : r);

/** Per-side stroke weights [top, right, bottom, left] if at least one is set individually. */
export function sideWeights(p: Props): [number, number, number, number] | undefined {
  if (p.strokeTopWeight === undefined && p.strokeRightWeight === undefined && p.strokeBottomWeight === undefined && p.strokeLeftWeight === undefined) return undefined;
  const w = p.strokeWeight ?? 1;
  return [p.strokeTopWeight ?? w, p.strokeRightWeight ?? w, p.strokeBottomWeight ?? w, p.strokeLeftWeight ?? w];
}

/** Node corner radii: shared or per corner (if at least one is set individually). */
export function cornerRadii(p: Props): number | [number, number, number, number] {
  const r = p.cornerRadius ?? 0;
  if (p.topLeftRadius === undefined && p.topRightRadius === undefined && p.bottomRightRadius === undefined && p.bottomLeftRadius === undefined) return r;
  return [p.topLeftRadius ?? r, p.topRightRadius ?? r, p.bottomRightRadius ?? r, p.bottomLeftRadius ?? r];
}

const TAU = Math.PI * 2;

/** Ellipse arc as cubic Béziers (pieces of at most 90°); angles are parametric, as for a stretched circle. */
function arcSegments(p: PathWriter, cx: number, cy: number, rx: number, ry: number, a0: number, sweep: number, first: 'move' | 'line') {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const x0 = cx + rx * Math.cos(a0);
  const y0 = cy + ry * Math.sin(a0);
  if (first === 'move') p.move(x0, y0);
  else p.line(x0, y0);
  let a = a0;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const ax = cx + rx * Math.cos(a);
    const ay = cy + ry * Math.sin(a);
    const bx = cx + rx * Math.cos(b);
    const by = cy + ry * Math.sin(b);
    p.cubic(ax - k * rx * Math.sin(a), ay + k * ry * Math.cos(a), bx + k * rx * Math.sin(b), by - k * ry * Math.cos(b), bx, by);
    a = b;
  }
}

/** Arc sweep (0, 2π]: end before start — clockwise through 0; equal — a full ellipse. */
export function arcSweep(arc: { startingAngle: number; endingAngle: number }): number {
  const s = (((arc.endingAngle - arc.startingAngle) % TAU) + TAU) % TAU;
  return s < 1e-6 ? TAU : s;
}

/** Ellipse; with an arc — a sector, a ring or part of a ring. */
export function ellipsePath(w: number, h: number, arc?: { startingAngle: number; endingAngle: number; innerRadius: number }): Uint8Array {
  const rx = w / 2;
  const ry = h / 2;
  if (arc) {
    const sweep = arcSweep(arc);
    const ratio = Math.max(0, Math.min(1, arc.innerRadius));
    const full = sweep >= TAU - 1e-6;
    if (!full || ratio > 0) {
      const p = new PathWriter();
      const a0 = full ? 0 : arc.startingAngle;
      if (full) {
        // Ring: the outer ellipse and the inner one in the opposite direction (a hole with NONZERO).
        arcSegments(p, rx, ry, rx, ry, 0, TAU, 'move');
        p.close();
        arcSegments(p, rx, ry, rx * ratio, ry * ratio, 0, -TAU, 'move');
        return p.close().done();
      }
      if (ratio > 0) {
        arcSegments(p, rx, ry, rx, ry, a0, sweep, 'move');
        arcSegments(p, rx, ry, rx * ratio, ry * ratio, a0 + sweep, -sweep, 'line');
      } else {
        p.move(rx, ry);
        arcSegments(p, rx, ry, rx, ry, a0, sweep, 'line');
      }
      return p.close().done();
    }
  }
  const cx = rx * K;
  const cy = ry * K;
  return new PathWriter()
    .move(w, ry)
    .cubic(w, ry + cy, rx + cx, h, rx, h)
    .cubic(rx - cx, h, 0, ry + cy, 0, ry)
    .cubic(0, ry - cy, rx - cx, 0, rx, 0)
    .cubic(rx + cx, 0, w, ry - cy, w, ry)
    .close()
    .done();
}

export function polygonPath(w: number, h: number, points: number, star: boolean, ratio = 0.382): Uint8Array {
  const p = new PathWriter();
  const n = star ? points * 2 : points;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const k = star && i % 2 === 1 ? Math.max(0, Math.min(1, ratio)) : 1;
    const x = w / 2 + (Math.cos(a) * w * k) / 2;
    const y = h / 2 + (Math.sin(a) * h * k) / 2;
    if (i === 0) p.move(x, y);
    else p.line(x, y);
  }
  return p.close().done();
}

const hexToBytes = (hex: string) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export function toFigPaint(p: Paint): FigPaint | null {
  const base = { visible: p.visible, opacity: p.opacity, blendMode: p.blendMode };
  switch (p.type) {
    case 'SOLID':
      return { ...base, type: 'SOLID', color: { ...p.color, a: 1 } };
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND': {
      const t = p.gradientTransform;
      return {
        ...base,
        type: p.type,
        stops: p.gradientStops.map((s) => ({ position: s.position, color: s.color })),
        transform: { m00: t[0][0], m01: t[0][1], m02: t[0][2], m10: t[1][0], m11: t[1][1], m12: t[1][2] },
      };
    }
    case 'GRADIENT_FREEFORM':
      return p.points.length ? { ...base, type: 'GRADIENT_FREEFORM', freeform: p.points.map((q) => ({ x: q.x, y: q.y, color: { ...q.color }, spread: q.spread })) } : null;
    case 'IMAGE': {
      if (!p.imageHash) return null;
      const t = p.imageTransform;
      return {
        ...base,
        type: 'IMAGE',
        image: { hash: hexToBytes(p.imageHash) },
        imageScaleMode: p.scaleMode === 'CROP' ? 'STRETCH' : p.scaleMode,
        scale: p.scalingFactor,
        originalImageWidth: p.originalWidth,
        rotation: p.rotation,
        transform: t ? { m00: t[0][0], m01: t[0][1], m02: t[0][2], m10: t[1][0], m11: t[1][1], m12: t[1][2] } : undefined,
        paintFilter: p.filters ? { ...p.filters, vibrance: p.filters.saturation } : undefined,
      };
    }
    case 'VIDEO': {
      if (!p.videoHash) return null;
      const t = p.videoTransform;
      return {
        ...base,
        type: 'VIDEO',
        video: { hash: hexToBytes(p.videoHash) },
        imageScaleMode: p.scaleMode === 'CROP' ? 'STRETCH' : p.scaleMode,
        scale: p.scalingFactor,
        rotation: p.rotation,
        transform: t ? { m00: t[0][0], m01: t[0][1], m02: t[0][2], m10: t[1][0], m11: t[1][1], m12: t[1][2] } : undefined,
        paintFilter: p.filters ? { ...p.filters, vibrance: p.filters.saturation } : undefined,
      };
    }
    case 'MODEL3D':
      if (!p.modelHash) return null;
      return { ...base, type: 'MODEL3D', model: { hash: hexToBytes(p.modelHash), camera: p.camera, clip: p.clip, pose: p.pose, lighting: p.lighting, orbit: p.orbit, autoRotate: p.autoRotate }, imageScaleMode: p.scaleMode };
    case 'LOTTIE':
      if (!p.lottieHash) return null;
      return { ...base, type: 'LOTTIE', lottie: { hash: hexToBytes(p.lottieHash), speed: p.speed }, imageScaleMode: p.scaleMode, scale: p.scalingFactor };
    case 'SHADER': {
      const sh = resolveFigmaShader(p);
      return { ...base, type: 'SHADER', shader: { code: sh.code, params: sh.params ?? {}, animate: sh.animate !== false, wgsl: sh.wgsl } };
    }
    case 'PATTERN':
      return {
        ...base,
        type: 'PATTERN',
        pattern: { source: p.sourceNodeId, tileType: p.tileType, scale: p.scalingFactor, spacing: { x: p.spacing?.x ?? 0, y: p.spacing?.y ?? 0 }, align: p.horizontalAlignment },
      };
    default:
      return null;
  }
}

/** Layer path trim [start, end] (length fractions); null — the whole stroke. */
function pathTrim(p: { pathTrimStart?: number; pathTrimEnd?: number }): [number, number] | null {
  const a = Math.max(0, Math.min(1, p.pathTrimStart ?? 0));
  const b = Math.max(0, Math.min(1, p.pathTrimEnd ?? 1));
  return a <= 1e-4 && b >= 1 - 1e-4 ? null : [a, b];
}

/** Parse an SVG path (M, L, Q, C, Z, space-separated numbers) into renderer commands with a scale. */
export function svgPathToBlob(data: string, sx = 1, sy = 1): Uint8Array {
  // SVG path tokens: commands and numbers (sign, fraction, exponent; a command may be adjacent
  // to a number — that is how Skia writes it: “M149.2 40C116.4…”). Absolute M, L, Q, C, Z; a repeated command
  // without a letter is the same command (after M — L).
  const p = new PathWriter();
  const t = data.match(/[MLQCZmlqcz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  const n = () => Number(t[i++]);
  let cmd = '';
  while (i < t.length) {
    const tok = t[i]!;
    if (/[A-Za-z]/.test(tok)) {
      cmd = tok.toUpperCase();
      i++;
    } else if (cmd === 'M') cmd = 'L';
    else if (!cmd || cmd === 'Z') return p.done();
    switch (cmd) {
      case 'M':
        p.move(n() * sx, n() * sy);
        break;
      case 'L':
        p.line(n() * sx, n() * sy);
        break;
      case 'Q': {
        const x1 = n() * sx, y1 = n() * sy, x = n() * sx, y = n() * sy;
        p.quad(x1, y1, x, y);
        break;
      }
      case 'C': {
        const x1 = n() * sx, y1 = n() * sy, x2 = n() * sx, y2 = n() * sy;
        p.cubic(x1, y1, x2, y2, n() * sx, n() * sy);
        break;
      }
      case 'Z':
        p.close();
        break;
      default:
        return p.done();
    }
  }
  return p.done();
}

/** Model effect (as in the Plugin API) → scene effect (as in .fig): the renderer draws them the same way. */
function toFigEffect(e: Effect): FigEffect {
  switch (e.type) {
    case 'UNSUPPORTED_FIGMA':
      // Never pass unrecognized source data into the renderer's effect dispatch.
      return { type: 'UNSUPPORTED_FIGMA', visible: false };
    case 'SHADER':
      return { type: 'SHADER', visible: e.visible, shader: { code: e.code, params: e.params ?? {}, animate: e.animate !== false } };
    case 'DROP_SHADOW':
    case 'INNER_SHADOW':
      return { type: e.type, color: e.color, offset: e.offset, radius: e.radius, spread: e.spread, visible: e.visible, blendMode: e.blendMode, showShadowBehindNode: e.showShadowBehindNode };
    case 'NOISE':
      return {
        type: 'NOISE',
        noiseType: e.noiseType,
        color: e.color,
        secondaryColor: e.secondaryColor,
        opacity: e.opacity,
        noiseSize: { x: e.noiseSize, y: e.noiseSize },
        density: e.density,
        blendMode: e.blendMode,
        visible: e.visible,
      };
    case 'TEXTURE':
      return { type: 'GRAIN', noiseSize: { x: e.noiseSize, y: e.noiseSize }, radius: e.radius, clipToShape: e.clipToShape, visible: e.visible };
    case 'GLASS':
      return {
        type: 'GLASS',
        specularAngle: e.lightAngle,
        specularIntensity: e.lightIntensity,
        refractionIntensity: e.refraction,
        refractionRadius: e.depth,
        chromaticAberration: e.dispersion,
        radius: e.radius,
        visible: e.visible,
      };
    default: {
      const out: FigEffect = { type: e.type === 'LAYER_BLUR' ? 'FOREGROUND_BLUR' : 'BACKGROUND_BLUR', radius: e.radius, visible: e.visible };
      if (e.blurType === 'PROGRESSIVE') {
        out.blurOpType = 'PROGRESSIVE';
        out.startRadius = e.startRadius ?? 0;
        out.startOffset = e.startOffset ?? { x: 0.5, y: 0 };
        out.endOffset = e.endOffset ?? { x: 0.5, y: 1 };
      }
      return out;
    }
  }
}

const IDENTITY: Matrix2D = [1, 0, 0, 0, 1, 0];
const mul = (a: Matrix2D, b: Matrix2D): Matrix2D => [
  a[0] * b[0] + a[1] * b[3],
  a[0] * b[1] + a[1] * b[4],
  a[0] * b[2] + a[1] * b[5] + a[2],
  a[3] * b[0] + a[4] * b[3],
  a[3] * b[1] + a[4] * b[4],
  a[3] * b[2] + a[4] * b[5] + a[5],
];

/** Shapes whose form is defined by parameters (size, corner radius, vertex count). */
const PARAMETRIC = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'FRAME', 'COMPONENT', 'INSTANCE', 'SECTION']);

export class CoreScene {
  /** “Live layer” nodes whose bounds are recomputed after dragging. */
  private deferred = new Set<string>();
  readonly page: ScenePage;
  readonly blobs: Uint8Array[];
  private doc: Document;
  /** Mirror of a pattern source outside the scene: only these roots (paths and renderer shared with the main scene). */
  private readonly only: Set<string> | null;
  /** Pattern sources not on the scene page (another page, outside the roots): id → mirror of its subtree. */
  private externals = new Map<string, CoreScene>();
  /** Patterns: layer → its sources and source → layers using it (redraw when the source is edited). */
  private usesOf = new Map<string, Set<string>>();
  private usersOf = new Map<string, Set<string>>();
  readonly pageId: string;
  private byId = new Map<string, SceneNode>();
  private parentOf = new Map<SceneNode, SceneNode | null>();
  private idOf = new WeakMap<SceneNode, string>();
  private renderer: SceneRenderer | null = null;
  /** Path key (+ scale) → renderer blob index. */
  private parsed = new Map<string, number>();
  private shared = new Set<number>();
  /** Incremental build (background page preparation): nodes still to build; null — the scene is built. */
  private pending: { id: string; parent: SceneNode | null; parentId: string }[] | null = null;
  /** Incremental renderer attachment: how many top-level nodes already have bounds. */
  private attachAt = 0;

  /**
   * roots — only these page nodes (component thumbnails from any page); shared — a pattern source
   * mirror: the main scene's path table, and new page nodes other than the roots are not taken.
   */
  constructor(doc: Document, pageId: string, roots?: readonly string[], shared?: { blobs: Uint8Array[] }) {
    this.doc = doc;
    this.pageId = pageId;
    this.blobs = shared?.blobs ?? [];
    this.only = shared ? new Set(roots) : null;
    const bg = doc.get(pageId, 'backgrounds')?.[0];
    this.page = {
      key: pageId,
      name: doc.get(pageId, 'name') ?? 'Page',
      backgroundColor: bg?.type === 'SOLID' ? { ...bg.color, a: 1 } : undefined,
      children: [],
    };
    for (const c of roots ?? doc.children(pageId)) this.page.children.push(this.build(c, null));
  }

  /**
   * Page scene built in chunks (buildStep), for example during idle time: switching to the page
   * has no wait. Edits touching what is already built are a reason to start over (touches); what is not
   * built yet is later read from the document as is.
   */
  static incremental(doc: Document, pageId: string): CoreScene {
    const scene = new CoreScene(doc, pageId, []);
    scene.pending = [...doc.children(pageId)].reverse().map((id) => ({ id, parent: null, parentId: pageId }));
    return scene;
  }

  /** Number of nodes in the scene. */
  get size(): number {
    return this.byId.size;
  }

  /** Only complete top-level subtrees may be published while building. */
  get completedRoots(): number {
    return this.page.children.length - (this.pending?.at(-1)?.parent ? 1 : 0);
  }

  get attachedRoots(): number { return this.attachAt; }

  /** Build the next nodes until the deadline (performance.now()); true — the scene is built. */
  buildStep(deadline: number): boolean {
    const stack = this.pending;
    if (!stack) return true;
    let n = 0;
    while (stack.length) {
      if ((++n & 63) === 0 && performance.now() > deadline) return false;
      const { id, parent, parentId } = stack.pop()!;
      // The node was removed or moved: its new parent will build it (or it is not needed).
      if (this.byId.has(id) || !this.doc.has(id) || this.doc.parent(id) !== parentId) continue;
      const sn = this.newNode(id, parent);
      (parent ? parent.children : this.page.children).push(sn);
      const kids = this.doc.children(id);
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i]!, parent: sn, parentId: id });
    }
    this.pending = null;
    return true;
  }

  /** Edits touch what is already built (an incremental build or attachment is in progress): rebuild. */
  touches(ops: Op[]): boolean {
    for (const o of ops) {
      if (o.op === 'blob') continue;
      if (this.byId.has(o.id)) return true;
      if ((o.op === 'create' || o.op === 'move') && (o.parent === this.pageId || this.byId.has(o.parent))) return true;
    }
    return false;
  }

  /** Attach the renderer in chunks (top-level page nodes): true — bounds are computed. */
  attachStep(renderer: SceneRenderer, deadline: number, limit = this.page.children.length): boolean {
    if (this.renderer !== renderer) {
      this.renderer = renderer;
      this.attachAt = 0;
      renderer.setPatternSource((id) => this.patternSource(id));
    }
    const top = this.page.children;
    while (this.attachAt < Math.min(top.length, limit)) {
      if (this.attachAt > 0 && performance.now() > deadline) return false;
      const n = top[this.attachAt++]!;
      const booleans: SceneNode[] = [];
      const walk = (x: SceneNode) => {
        for (const c of x.children) walk(c);
        if (x.type === 'BOOLEAN_OPERATION') booleans.push(x);
      };
      walk(n);
      for (const b of booleans) this.computeBoolean(b);
      renderer.computeBounds([n]);
    }
    return true;
  }

  /** Attach the renderer: bounds are computed right away and maintained on edits. */
  attach(renderer: SceneRenderer) {
    this.renderer = renderer;
    if (!this.only) renderer.setPatternSource((id) => this.patternSource(id));
    // Boolean groups bottom-up (a nested one is an operand of the outer one).
    const all: SceneNode[] = [];
    const walk = (nodes: SceneNode[]) => {
      for (const n of nodes) {
        walk(n.children);
        if (n.type === 'BOOLEAN_OPERATION') all.push(n);
      }
    };
    walk(this.page.children);
    for (const n of all) this.computeBoolean(n);
    renderer.computeBounds(this.page.children);
  }

  /** Node paths (with the subtree) as a boolean operand: in coordinates m. */
  private operandShapes(n: SceneNode, m: Matrix2D): { blob: number; evenOdd: boolean; m: Matrix2D }[] {
    if (!n.visible) return [];
    if (n.fillGeometry.length) return n.fillGeometry.map((g) => ({ blob: g.blob, evenOdd: g.windingRule === 'EVENODD', m }));
    return n.children.flatMap((c) => this.operandShapes(c, mul(m, c.transform)));
  }

  /** Recompute the shape of a boolean group from its children. */
  private computeBoolean(sn: SceneNode) {
    const r = this.renderer;
    const id = this.idOf.get(sn);
    if (!r || !id) return;
    for (const g of sn.fillGeometry) if (!this.isShared(g.blob)) r.dropPath(g.blob);
    const op = this.doc.get(id, 'booleanOperation') ?? 'UNION';
    const svg = r.booleanSvg(
      op,
      sn.children.map((c) => this.operandShapes(c, c.transform)),
    );
    if (svg) {
      this.blobs.push(svgPathToBlob(svg));
      sn.fillGeometry = [{ windingRule: 'NONZERO', blob: this.blobs.length - 1 }];
    } else sn.fillGeometry = [];
    r.forget(sn);
  }

  /** SVG path of a node as a single shape (for “Flatten”): a boolean group gives its result, a group the union. */
  flattenSvg(id: string): string | null {
    const sn = this.byId.get(id);
    if (!sn || !this.renderer) return null;
    return this.renderer.booleanSvg('UNION', [this.operandShapes(sn, IDENTITY)]);
  }

  /** Stroke outline of a node (for “Outline stroke”). */
  strokeOutline(id: string) {
    const sn = this.byId.get(id);
    return sn && this.renderer ? this.renderer.strokeOutlineSvg(sn) : null;
  }

  node(id: string): SceneNode | undefined {
    return this.byId.get(id);
  }

  /**
   * Pattern source layer: from the scene page, or, if it is not there (another page, outside the scene roots),
   * from a separate mirror of its subtree with the shared path table and renderer.
   */
  patternSource(id: string): SceneNode | undefined {
    const resolved = this.doc.patternSourceNode(id) ?? id;
    const own = this.byId.get(resolved);
    if (own) return own;
    const r = this.renderer;
    const parent = this.doc.has(resolved) ? this.doc.parent(resolved) : null;
    if (!r || !parent) return undefined;
    let sub = this.externals.get(id);
    if (!sub) {
      sub = new CoreScene(this.doc, parent, [resolved], { blobs: this.blobs });
      sub.attach(r);
      this.externals.set(id, sub);
    }
    return sub.node(resolved);
  }

  /** Layers with a pattern from this source (document id). */
  patternUsers(source: string): string[] {
    return [...(this.usersOf.get(source) ?? [])];
  }

  /** Free the renderer caches of all nodes (the pattern source mirror is no longer needed). */
  dispose() {
    for (const n of this.page.children) this.dropSubtree(n);
    this.page.children.length = 0;
    for (const sub of this.externals.values()) sub.dispose();
    this.externals.clear();
  }

  id(node: SceneNode): string | undefined {
    return this.idOf.get(node);
  }

  parent(node: SceneNode): SceneNode | null {
    return this.parentOf.get(node) ?? null;
  }

  /** World matrix of the node (relative to the page). */
  worldMatrix(node: SceneNode | null): Matrix2D {
    let m: Matrix2D = IDENTITY;
    for (let n = node; n; n = this.parentOf.get(n) ?? null) m = mul(n.transform, m);
    return m;
  }

  /**
   * Matrix from node content coordinates to the page, with 3D projections (own and ancestors'):
   * 3×3 if there are any, otherwise like worldMatrix. For bounds, separate drawing and export.
   */
  worldProj(node: SceneNode | null): Matrix2D | number[] {
    const chain: SceneNode[] = [];
    for (let n = node; n; n = this.parentOf.get(n) ?? null) chain.unshift(n);
    let m: Matrix2D | number[] = IDENTITY;
    for (const n of chain) m = nodeWorld(m, n);
    return m;
  }

  /**
   * Applies document operations to the mirror. Returns the regions (page coordinates)
   * where the picture changed: old and new bounds of the affected nodes.
   */
  /** Recompute deferred bounds of “live layer” nodes; returns regions to redraw. */
  flushDeferred(): Rect[] {
    if (!this.deferred.size) return [];
    const ops: Op[] = [...this.deferred].filter((id) => this.byId.has(id)).map((id) => ({ op: 'set', id, props: {} }));
    this.deferred.clear();
    return this.apply(ops);
  }

  /**
   * quiet — “live layer” nodes (their regions are not redrawn in tiles);
   * defer — live nodes moved as a prebuilt texture: their bounds are handled in flushDeferred.
   */
  apply(ops: Op[], quiet?: Set<string>, defer?: Set<string>): Rect[] {
    const dirty: Rect[] = [];
    const isDeferred = (id: string) => {
      if (!defer?.size) return false;
      for (let cur: string | null = id; cur; cur = this.doc.parent(cur)) if (defer.has(cur)) return true;
      return false;
    };
    // “Live layer” nodes are drawn separately: their regions need no tile redraw.
    const isQuiet = (id: string) => {
      if (!quiet?.size) return false;
      for (let cur: string | null = id; cur; cur = this.doc.parent(cur)) if (quiet.has(cur)) return true;
      return false;
    };
    const touched = new Set<string>();
    const reorder = new Set<SceneNode | null>();
    const ancestors = new Set<SceneNode>();
    const r = this.renderer;
    const remember = (n: SceneNode) => {
      const b = r?.boundsOf(n);
      if (b) dirty.push(b);
      for (let p = this.parentOf.get(n) ?? null; p; p = this.parentOf.get(p) ?? null) ancestors.add(p);
    };
    const onPage = (parentId: string, id: string) => (parentId === this.pageId && (!this.only || this.only.has(id))) || this.byId.has(parentId);

    for (const op of ops) {
      switch (op.op) {
        case 'create': {
          if (this.byId.has(op.id) || !onPage(op.parent, op.id)) break;
          const parent = op.parent === this.pageId ? null : this.byId.get(op.parent)!;
          const sn = this.build(op.id, parent);
          (parent ? parent.children : this.page.children).push(sn);
          reorder.add(parent);
          touched.add(op.id);
          break;
        }
        case 'set': {
          const sn = this.byId.get(op.id);
          if (!sn) break;
          if (!isQuiet(op.id)) remember(sn);
          r?.forget(sn);
          this.refresh(sn, op.id);
          touched.add(op.id);
          break;
        }
        case 'move': {
          const sn = this.byId.get(op.id);
          if (sn) {
            remember(sn);
            this.detach(sn);
          }
          if (onPage(op.parent, op.id)) {
            const parent = op.parent === this.pageId ? null : this.byId.get(op.parent)!;
            const node = sn ?? this.build(op.id, parent);
            this.parentOf.set(node, parent);
            (parent ? parent.children : this.page.children).push(node);
            reorder.add(parent);
            touched.add(op.id);
          } else if (sn) {
            this.dropSubtree(sn);
          }
          break;
        }
        case 'delete': {
          const sn = this.byId.get(op.id);
          if (!sn) break;
          const removed = [sn];
          while (removed.length) {
            const n = removed.pop()!;
            const id = this.idOf.get(n);
            if (id) touched.add(id);
            removed.push(...n.children);
          }
          remember(sn);
          this.detach(sn);
          this.dropSubtree(sn);
          break;
        }
      }
    }

    // Child order as in the document.
    for (const parent of reorder) {
      const parentId = parent ? this.idOf.get(parent)! : this.pageId;
      const list = parent ? parent.children : this.page.children;
      const ordered = this.doc
        .children(parentId)
        .map((id) => this.byId.get(id))
        .filter((n): n is SceneNode => !!n);
      list.length = 0;
      list.push(...ordered);
    }

    // Boolean groups whose operands (or themselves) changed: recompute the shape, bottom-up.
    if (r) {
      const booleans = new Set<SceneNode>();
      for (const id of touched) {
        for (let n: SceneNode | null | undefined = this.byId.get(id); n; n = this.parentOf.get(n) ?? null) {
          if (n.type === 'BOOLEAN_OPERATION') booleans.add(n);
        }
      }
      for (const a of ancestors) if (a.type === 'BOOLEAN_OPERATION') booleans.add(a);
      const depthOf = (n: SceneNode) => {
        let d = 0;
        for (let p = this.parentOf.get(n) ?? null; p; p = this.parentOf.get(p) ?? null) d++;
        return d;
      };
      for (const b of [...booleans].sort((x, y) => depthOf(y) - depthOf(x))) {
        if (this.idOf.has(b)) this.computeBoolean(b);
      }
    }

    // Bounds: affected nodes (with subtrees), then ancestors bottom-up.
    // For “live layer” nodes, after dragging (flushDeferred): during the frame their subtree
    // is drawn as a prebuilt texture, and recomputing the bounds of a large subtree would take the whole frame.
    if (r) {
      for (const id of touched) {
        if (isDeferred(id)) {
          this.deferred.add(id);
          continue;
        }
        const sn = this.byId.get(id);
        if (!sn) continue;
        const parent = this.parentOf.get(sn) ?? null;
        const b = r.refreshBounds(sn, this.worldProj(parent));
        if (b && !isQuiet(id)) dirty.push(b);
        for (let p = parent; p; p = this.parentOf.get(p) ?? null) ancestors.add(p);
      }
      const depth = (n: SceneNode) => {
        let d = 0;
        for (let p = this.parentOf.get(n) ?? null; p; p = this.parentOf.get(p) ?? null) d++;
        return d;
      };
      for (const a of [...ancestors].filter((a) => this.idOf.has(a) && this.byId.get(this.idOf.get(a)!) === a).sort((x, y) => depth(y) - depth(x))) {
        // A shader can sample any child anywhere in its output, not only in that child's box.
        const shader = a.effects.some((e) => e.type === 'SHADER' && e.visible !== false);
        const before = shader ? r.boundsOf(a) : null;
        if (before) dirty.push([...before]);
        r.refreshContainerBounds(a, this.worldProj(a));
        const after = shader ? r.boundsOf(a) : null;
        if (after) dirty.push([...after]);
      }
    }
    // Patterns: the source (itself or something in it) changed — rewrite the tiles, redraw the layers using them.
    if (r && (this.usersOf.size || this.externals.size)) this.refreshPatterns(ops, ancestors, dirty, touched);
    return dirty;
  }

  private refreshPatterns(ops: Op[], ancestors: Set<SceneNode>, dirty: Rect[], touched: Set<string>) {
    const r = this.renderer!;
    const changed = new Set<string>(touched);
    // Mirrors of sources not on this page: an edit in them means the source changed; moved — rebuild.
    for (const [id, sub] of this.externals) {
      const resolved = this.doc.patternSourceNode(id);
      const moved = !resolved || this.byId.has(resolved) || this.doc.parent(resolved) !== sub.pageId || !sub.node(resolved);
      if (moved || sub.apply(ops).length) changed.add(id);
      if (moved) {
        sub.dispose();
        this.externals.delete(id);
      }
    }
    if (!this.usersOf.size) return;
    for (const op of ops) {
      if (op.op === 'blob') continue;
      changed.add(op.id);
      const from = op.op === 'create' || op.op === 'move' ? op.parent : op.op === 'set' ? this.doc.parent(op.id) : null;
      for (let cur = from; cur; cur = this.doc.parent(cur)) changed.add(cur);
    }
    // Former ancestors of removed and moved nodes.
    for (const a of ancestors) {
      const id = this.idOf.get(a);
      if (id) changed.add(id);
    }
    const queue = [...this.usersOf.keys()].filter((src) => changed.has(src));
    const seen = new Set<string>();
    while (queue.length) {
      const src = queue.pop()!;
      if (seen.has(src)) continue;
      seen.add(src);
      r.dropPattern(src);
      for (const user of this.usersOf.get(src) ?? []) {
        const sn = this.byId.get(user);
        const b = sn && r.boundsOf(sn);
        if (b) dirty.push(b);
        // A layer with a pattern is itself inside another source, so that one changed too.
        for (let cur: string | null = user; cur; cur = this.doc.parent(cur)) if (this.usersOf.has(cur) && !seen.has(cur)) queue.push(cur);
      }
    }
  }

  /** Pattern sources of a layer (fills, strokes, vector network regions). */
  private setPatternUses(id: string, sn: SceneNode | null) {
    const sources = new Set<string>();
    if (sn) for (const fp of [...sn.fills, ...sn.strokes, ...sn.fillGeometry.flatMap((g) => g.fills ?? [])]) if (fp.pattern) sources.add(fp.pattern.source);
    const prev = this.usesOf.get(id);
    if (!prev && !sources.size) return;
    for (const src of prev ?? []) {
      const users = this.usersOf.get(src);
      users?.delete(id);
      if (users && !users.size) this.usersOf.delete(src);
    }
    if (!sources.size) {
      this.usesOf.delete(id);
      return;
    }
    this.usesOf.set(id, sources);
    for (const src of sources) {
      let users = this.usersOf.get(src);
      if (!users) this.usersOf.set(src, (users = new Set()));
      users.add(id);
    }
  }

  /**
   * Nodes under a point (page coordinates): the path from the top level to the deepest one.
   * Accounts for visibility, frame clipping and ellipse shape.
   */
  /**
   * Path from the top level to the node under a point; tol — tolerance for lines (world units),
   * ignore — nodes (with subtrees) to skip (for example, ones being dragged).
   */
  hitPath(x: number, y: number, tol = 0, ignore?: Set<string>): SceneNode[] {
    const visit = (nodes: SceneNode[], parentWorld: Matrix2D | number[]): SceneNode[] | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]!;
        if (!n.visible) continue;
        if (ignore?.has(n.key)) continue;
        const b = this.renderer?.boundsOf(n);
        if (b && (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol)) continue;
        const world = nodeWorld(parentWorld, n);
        // 3D rotation: the screen point is mapped into the layer plane by inverse projection.
        const local = world.length === 9 ? toLocal3(world, x, y) : toLocal(world as Matrix2D, x, y);
        const scaleK = Math.max(1e-9, Math.hypot(world[0], world[3]));
        // Text on a path: hit-tested by the line along the path (not by the path bounds).
        const onPath = n.textPath && local ? this.renderer?.insidePathText(n, local[0], local[1], tol / scaleK) : undefined;
        let inside = onPath ?? (local && insideShape(n, local[0], local[1], tol / scaleK));
        if (inside && local && n.type === 'SLICE') {
          const edge = Math.max(4, tol) / scaleK;
          inside = local[0] < edge || local[1] < edge || n.size.x - local[0] < edge || n.size.y - local[1] < edge;
        }
        if (n.children.length && (!n.clipsContent || inside)) {
          const deeper = visit(n.children, world);
          if (deeper) return [n, ...deeper];
        }
        // A group by itself does not “catch” clicks — only through its children.
        if (inside && n.type !== 'GROUP') return [n];
      }
      return null;
    };
    return visit(this.page.children, IDENTITY) ?? [];
  }

  // ---------- Building ----------

  private build(id: string, parent: SceneNode | null): SceneNode {
    const existing = this.byId.get(id);
    if (existing) return existing;
    const sn = this.newNode(id, parent);
    for (const c of this.doc.children(id)) sn.children.push(this.build(c, sn));
    return sn;
  }

  /** Scene node for a document node (without children). */
  private newNode(id: string, parent: SceneNode | null): SceneNode {
    const sn: SceneNode = {
      key: id,
      type: 'FRAME',
      name: '',
      visible: true,
      opacity: 1,
      blendMode: 'PASS_THROUGH',
      transform: IDENTITY,
      size: { x: 0, y: 0 },
      fills: [],
      strokes: [],
      fillGeometry: [],
      strokeGeometry: [],
      effects: [],
      clipsContent: false,
      isMask: false,
      maskType: 'ALPHA',
      glyphs: undefined,
      children: [],
    };
    this.byId.set(id, sn);
    this.idOf.set(sn, id);
    this.parentOf.set(sn, parent);
    this.refresh(sn, id);
    return sn;
  }

  /** Update scene node fields from the document (geometry is rebuilt). */
  private refresh(sn: SceneNode, id: string) {
    const rec = this.doc.node(id);
    if (!rec) return;
    // Read-only: properties without copying default values (building pages of tens of thousands of nodes).
    const p = this.doc.view(id);
    const w = p.width ?? 0;
    const h = p.height ?? 0;
    // The node's own (non-shared) paths are freed; shared ones from the table stay in the cache.
    for (const g of sn.fillGeometry) if (!this.isShared(g.blob)) this.renderer?.dropPath(g.blob);
    const own = (bytes: Uint8Array) => {
      this.blobs.push(bytes);
      return this.blobs.length - 1;
    };
    // Prebuilt paths (import): scaled if the node was stretched relative to the size they were computed at.
    const gs = p.geometrySize;
    const sx = gs && gs.width > 0 ? w / gs.width : 1;
    const sy = gs && gs.height > 0 ? h / gs.height : 1;
    const fromPaths = (paths: { windingRule: 'NONZERO' | 'EVENODD'; data?: string; blob?: string; fills?: Paint[] }[]) =>
      paths
        .map((vp) => {
          const data = vp.blob ? this.doc.blob(vp.blob) : vp.data;
          if (!data) return null;
          const key = `${vp.blob ?? data}|${sx}|${sy}`;
          let index = this.parsed.get(key);
          if (index === undefined) {
            index = own(this.parsedBytes(key, () => svgPathToBlob(data, sx, sy)));
            this.parsed.set(key, index);
            this.shared.add(index);
          }
          const g: SceneNode['fillGeometry'][number] = { windingRule: vp.windingRule, blob: index };
          // A region with its own fills.
          if (vp.fills) g.fills = vp.fills.map(toFigPaint).filter((x): x is FigPaint => !!x);
          return g;
        })
        .filter((g): g is SceneNode['fillGeometry'][number] => !!g);

    // A parametric shape stretched after import: Figma's prebuilt paths would distort corner radii and stroke
    // weight when stretched, so the shape and stroke are rebuilt from the parameters.
    const regenerate = PARAMETRIC.has(rec.type) && !!gs && (Math.abs(gs.width - w) > 0.01 || Math.abs(gs.height - h) > 0.01);
    let fillGeometry: SceneNode['fillGeometry'] = [];
    if (p.vectorPaths?.length && !regenerate) fillGeometry = fromPaths(p.vectorPaths);
    else {
      let geometry: Uint8Array | null = null;
      switch (rec.type) {
        case 'ELLIPSE':
          geometry = ellipsePath(w, h, p.arcData);
          break;
        case 'POLYGON':
          geometry = polygonPath(w, h, p.pointCount ?? 3, false);
          break;
        case 'STAR':
          geometry = polygonPath(w, h, p.pointCount ?? 5, true, p.innerRadius ?? 0.382);
          break;
        case 'TEXT':
        case 'LINE':
        case 'GROUP':
        case 'VECTOR':
        case 'BOOLEAN_OPERATION': // the shape is the result of the operation on the children (computeBoolean)
          break;
        default:
          geometry = roundedRectPath(w, h, cornerRadii(p), p.cornerSmoothing ?? 0);
      }
      if (geometry) fillGeometry = [{ windingRule: 'NONZERO', blob: own(geometry) }];
    }

    // Text: glyphs (em, Y axis up) from the geometry table, styles follow the fills.
    let glyphs: SceneNode['glyphs'];
    if (rec.type === 'TEXT' && p.textGlyphs) {
      const runs = p.textGlyphs.runs.map((r) => (r.fills ? r.fills.map(toFigPaint).filter((x): x is FigPaint => !!x) : undefined));
      glyphs = [];
      for (const [key, x, y, size, run] of p.textGlyphs.glyphs) {
        const data = this.doc.blob(key);
        if (!data) continue;
        let index = this.parsed.get(key);
        if (index === undefined) {
          index = own(this.parsedBytes(key, () => svgPathToBlob(data)));
          this.parsed.set(key, index);
          this.shared.add(index);
        }
        glyphs.push({ blob: index, x, y, fontSize: size, fills: runs[run] });
      }
    }

    sn.type = rec.type === 'COMPONENT' ? 'SYMBOL' : rec.type;
    sn.name = p.name ?? '';
    sn.visible = p.visible !== false;
    sn.opacity = p.opacity ?? 1;
    sn.blendMode = p.blendMode ?? 'PASS_THROUGH';
    sn.transform = (p.transform ?? IDENTITY) as Matrix2D;
    sn.size = { x: w, y: h };
    const persp = layerProjection(p, w, h);
    if (persp) sn.persp = persp;
    else delete sn.persp;
    sn.fills = (p.fills ?? []).map(toFigPaint).filter((x): x is FigPaint => !!x);
    // 3D model clip frame from timeline keys: the clip does not play by itself (the renderer takes pose).
    if ((p.animation ?? []).some((tr) => tr.property === 'modelTime')) for (const fp of sn.fills) if (fp.model) fp.model = { ...fp.model, keyed: true };
    sn.strokes = (p.strokes ?? []).map(toFigPaint).filter((x): x is FigPaint => !!x);
    sn.fillGeometry = fillGeometry;
    // Path trim: the renderer builds the stroke from the shape (the prebuilt .fig stroke outline is not trimmed).
    const trim = pathTrim(p);
    const strokePaths = regenerate || trim ? undefined : p.strokePaths;
    sn.strokeGeometry = strokePaths?.length ? fromPaths(strokePaths) : [];
    sn.strokeSource = !strokePaths?.length && p.centerPaths?.length ? fromPaths(p.centerPaths) : undefined;
    const align = rec.type === 'LINE' ? 'CENTER' : (p.strokeAlign ?? 'INSIDE');
    sn.strokeAlign = align === 'CENTER' ? undefined : align;
    // Custom stroke (no prebuilt outline): the renderer builds it from the node shape.
    const weight = p.strokeWeight ?? 1;
    const sides = sideWeights(p);
    const startCap = p.strokeStartCap ?? 'NONE';
    const endCap = p.strokeEndCap ?? 'NONE';
    sn.strokeStyle =
      !strokePaths?.length && rec.type !== 'TEXT' && (weight > 0 || sides) && sn.strokes.some((s) => s.visible !== false)
        ? {
            weight,
            // Lines and open paths are stroked only at the center.
            align,
            join: p.strokeJoin ?? 'MITER',
            dashes: p.dashPattern ?? [],
            ...(sides ? { sides, radii: radiiTuple(cornerRadii(p)) } : {}),
            ...(trim ? { trim } : {}),
            ...(startCap !== 'NONE' ? { startCap } : {}),
            ...(endCap !== 'NONE' ? { endCap } : {}),
            ...(p.strokeMiterLimit !== undefined && p.strokeMiterLimit !== 4 ? { miterLimit: p.strokeMiterLimit } : {}),
            ...(p.variableWidthPoints?.length ? { widths: p.variableWidthPoints.map((w) => ({ position: w.position, ascent: w.ascent, descent: w.descent })) } : {}),
            ...(p.strokeBrush ? { brush: { ...p.strokeBrush } } : {}),
          }
        : undefined;
    const widest = Math.max(0, ...(p.variableWidthPoints ?? []).map((w) => Math.max(w.ascent, w.descent)));
    sn.strokeOutset = Math.max(
      strokeOutsetOf(sn.strokes, sides ? 0 : weight, align),
      sn.strokeStyle?.widths ? widest + 1 : 0,
      sides && sn.strokes.some((s) => s.visible !== false) ? sidesOutset(sides, align) * 2 : 0,
      sn.strokeStyle ? Math.max(capExtent(startCap, weight), capExtent(endCap, weight)) : 0,
      sn.strokeStyle?.brush ? weight * brushReach(sn.strokeStyle.brush) + 2 : 0,
    );
    sn.effects = (p.effects ?? []).map(toFigEffect);
    sn.clipsContent = p.clipsContent === true;
    sn.reverseZ = p.itemReverseZIndex === true || undefined;
    sn.isMask = p.isMask === true;
    sn.maskType = p.maskType ?? 'ALPHA';
    sn.glyphs = glyphs;
    sn.textLayout = rec.type === 'TEXT' && !p.textGlyphs ? textLayoutOf(p) : undefined;
    sn.textAnim = sn.textLayout && p.textAnimation && p.textAnimationTime !== undefined ? { ...p.textAnimation, time: p.textAnimationTime } : undefined;
    // Text animation pieces shift by half a line: extra bounds margin for tiles.
    if (sn.textAnim) sn.strokeOutset = Math.max(sn.strokeOutset ?? 0, p.fontSize ?? 12);
    if (rec.type === 'TEXT' && p.textPath?.data) {
      const [sx, sy] = textPathScale(p);
      sn.textPath = { data: p.textPath.data, offset: p.textPath.offset ?? 0, sx, sy };
    } else sn.textPath = undefined;
    // Text on a path extends beyond the path bounds by the line height (bounds for tiles).
    if (sn.textPath) sn.strokeOutset = Math.max(sn.strokeOutset ?? 0, (p.fontSize ?? 12) * 2);
    this.setPatternUses(id, sn);
  }

  /** Parsed path from the document cache (or parse and remember it). */
  private parsedBytes(key: string, parse: () => Uint8Array): Uint8Array {
    let cache = PARSED.get(this.doc);
    if (!cache) PARSED.set(this.doc, (cache = new Map()));
    let bytes = cache.get(key);
    if (!bytes) cache.set(key, (bytes = parse()));
    return bytes;
  }

  /** Path from the shared cache (used by several nodes): it must not be freed when one of them is edited. */
  private isShared(blob: number): boolean {
    return this.shared.has(blob);
  }

  private detach(sn: SceneNode) {
    const parent = this.parentOf.get(sn) ?? null;
    const list = parent ? parent.children : this.page.children;
    const i = list.indexOf(sn);
    if (i >= 0) list.splice(i, 1);
  }

  private dropSubtree(sn: SceneNode) {
    for (const c of sn.children) this.dropSubtree(c);
    this.renderer?.forget(sn);
    for (const g of sn.fillGeometry) if (!this.isShared(g.blob)) this.renderer?.dropPath(g.blob);
    const id = this.idOf.get(sn);
    if (id && this.byId.get(id) === sn) {
      this.byId.delete(id);
      this.setPatternUses(id, null);
    }
    this.parentOf.delete(sn);
  }
}

function toLocal3(m: readonly number[], x: number, y: number): [number, number] | null {
  const inv = invert3(m);
  return inv ? mapPoint3(inv, x, y) : null;
}

function toLocal(m: Matrix2D, x: number, y: number): [number, number] | null {
  const det = m[0] * m[4] - m[1] * m[3];
  if (Math.abs(det) < 1e-12) return null;
  const dx = x - m[2];
  const dy = y - m[5];
  return [(m[4] * dx - m[1] * dy) / det, (-m[3] * dx + m[0] * dy) / det];
}

function insideShape(n: SceneNode, x: number, y: number, tol = 0): boolean {
  const w = n.size.x;
  const h = n.size.y;
  // A line is a segment along the x axis; hit within half the stroke weight or the tolerance.
  if (n.type === 'LINE') {
    const r = Math.max(tol, (n.strokeStyle?.weight ?? 1) / 2);
    return x >= -r && x <= w + r && Math.abs(y) <= r;
  }
  if (n.type === 'ELLIPSE') {
    const rx = w / 2;
    const ry = h / 2;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (x - rx) / rx;
    const dy = (y - ry) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return x >= 0 && y >= 0 && x <= w && y <= h;
}

/** Snapshot of a document page as a scene (without change tracking). */
export function coreToScene(doc: Document, pageId: string): { page: ScenePage; blobs: Uint8Array[] } {
  const scene = new CoreScene(doc, pageId);
  return { page: scene.page, blobs: scene.blobs };
}
