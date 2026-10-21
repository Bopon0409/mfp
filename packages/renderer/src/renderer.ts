// Scene tree rendering via CanvasKit (Skia → WebGL).
// Used by the tile cache (tiles.ts) to draw tiles, and directly — for comparison.
//
// Key points for GPU performance:
// - intermediate layers (saveLayer) only when unavoidable, and with exact node bounds;
// - opacity and blend mode of simple leaf nodes are applied directly to the paint;
// - Paint, filters and paths are cached; text glyphs are merged into one path per style;
// - images are decoded at screen size, no mipmaps needed.

import type { Canvas, CanvasKit, Image, ImageFilter, Paint, Paragraph, Path, RuntimeEffect, Shader, SkPicture, TileMode } from 'canvaskit-wasm';
import type { FontLibrary } from './fonts.ts';
import { layoutText, type TextLayout } from './text.ts';
import { graphemes, PathTextMap } from './text-path.ts';
import { sideStrokePath, strokePath, variableStrokePath } from './stroke.ts';
import { brushStrokePath } from './brushes.ts';
import { shaderParams, shaderContractError } from './shader-paint.ts';
import { WgslFillCache, WGSL_FRAME } from './wgsl-fill.ts';
import type { LottieClip, LottieSource } from './lottie.ts';
import { decodePathCommands, invert, multiply, type Matrix2D, type SceneNode } from '@mfp/io-figma';
import { mapRect3, mul3, textUnitProgress, type TextAnimation } from '@mfp/core';
import type { FigEffect, FigPaint } from '@mfp/io-figma';

type Rect = [number, number, number, number]; // x0, y0, x1, y1

/** Pattern tile: source recorded into a Picture; w × h — source bounds, rect — tile with spacing. */
interface PatternTile {
  picture: SkPicture;
  rect: Rect;
  w: number;
  h: number;
  /** All of the source's images were ready (otherwise — re-record in the next frame). */
  complete: boolean;
  frame: number;
}

/**
 * Tile “image” with animated shaders: the tiles where they are drawn remember it; the editor
 * updates the time and invalidates such tiles (invalidateImage) — like video frames.
 */
export const SHADER_CLOCK = 'shader:time';

const shaderDefaults = new Map<string, Record<string, number[]>>();
/** Default shader parameter values (from the comments on the uniforms). */
function DEFAULTS(code: string): Record<string, number[]> {
  let d = shaderDefaults.get(code);
  if (!d) {
    d = Object.fromEntries(shaderParams(code).map((p) => [p.name, p.value]));
    if (shaderDefaults.size > 64) shaderDefaults.clear();
    shaderDefaults.set(code, d);
  }
  return d;
}

/** No clipping to an area (pattern tile recording). */
const EVERYWHERE: Rect = [-Infinity, -Infinity, Infinity, Infinity];

export interface ImageSource {
  /**
   * Best available version of the image for size screenPx (screen pixels along the longer side).
   * undefined — the image is still loading or is too small to load.
   */
  get(hash: string, screenPx: number, originalWidth?: number): Image | undefined;
  /** Animated image (GIF): the frame changes — the paint is held per frame, as with video. */
  animated?(hash: string): boolean;
  /**
   * Images are provided at their original size, with mipmaps (rendering in Node): with strong
   * downscaling use mipmap levels, otherwise the image shimmers. In the browser the cache itself
   * decodes at screen size.
   */
  readonly mipmaps?: boolean;
  /** Images were released (memory budget): drop paints holding them. Returns an unsubscribe. */
  onEvict?(listener: (hashes: ReadonlySet<string>) => void): () => void;
}

/**
 * Video frames for fills (in the browser — video elements; Node has no video). key — whose frame:
 * in presentation each layer has its own playback (the key is its paint), in the editor — one per video.
 */
export interface VideoSource {
  frame(hash: string, key: object): Image | undefined;
}

/** 3D model frame settings (from a MODEL3D fill). */
export interface ModelView {
  camera: { yaw: number; pitch: number; zoom: number };
  clip?: string;
  pose: number;
  lighting: string;
  fill: boolean;
  /** The clip frame is set by timeline keys (pose) — the clip doesn't play by itself on the canvas or in presentation. */
  keyed?: boolean;
}

/**
 * 3D model frames (in the browser — three.js; Node has no models): frame of model hash in a w × h px
 * window (by the layer bounds). time — clip moment (null — per source: a pose freeze frame on the
 * canvas, in presentation — its own playback for paint key). undefined — the model is still loading.
 */
export interface ModelSource {
  frame(hash: string, key: object, view: ModelView, w: number, h: number, time: number | null): Image | undefined;
  /** The frame changes by itself (animation or rotation in presentation) — draw the next frame. */
  live?(key: object): boolean;
}

export interface FrameStats {
  drawn: number;
  culled: number;
}

/** Containers smaller than this size (screen pixels) are drawn without their contents. */
const LOD_CONTAINER_PX = 4;

const RECT_LIKE = new Set(['FRAME', 'SYMBOL', 'INSTANCE', 'SECTION', 'RECTANGLE', 'ROUNDED_RECTANGLE']);

/** Matrix for canvas.concat: affine 2×3 or projective 3×3 (3D layer rotation). */
const toMat3 = (m: Matrix2D | readonly number[]) => (m.length === 9 ? [...m] : [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, 0, 0, 1]);

/** Node world matrix: parent × position × 3D projection (if present anywhere — 3×3). */
export function nodeWorld(parent: Matrix2D | readonly number[], n: SceneNode): Matrix2D | number[] {
  if (parent.length !== 9 && !n.persp) return multiply(parent as Matrix2D, n.transform);
  const m = mul3(parent, n.transform);
  return n.persp ? mul3(m, n.persp) : m;
}

/** Bounds of a rectangle after the world matrix (affine or projective). */
const worldBox = (m: Matrix2D | readonly number[], r: Rect): Rect => (m.length === 9 ? mapRect3(m, r) : transformBox(m as Matrix2D, r));

/** Bounds of rectangle r after affine transform m. */
function transformBox(m: Matrix2D, r: Rect): Rect {
  const [x0, y0, x1, y1] = r;
  const px = [m[0] * x0 + m[1] * y0, m[0] * x1 + m[1] * y0, m[0] * x0 + m[1] * y1, m[0] * x1 + m[1] * y1];
  const py = [m[3] * x0 + m[4] * y0, m[3] * x1 + m[4] * y0, m[3] * x0 + m[4] * y1, m[3] * x1 + m[4] * y1];
  return [Math.min(...px) + m[2], Math.min(...py) + m[5], Math.max(...px) + m[2], Math.max(...py) + m[5]];
}

const unionRect = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

const outset = (r: Rect, d: number): Rect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];

const intersects = (a: Rect, b: Rect) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function effectOutset(effects: FigEffect[]): number {
  let out = 0;
  for (const e of effects) {
    // Glass and noise don't extend beyond the shape.
    if (e.visible === false || e.type === 'GLASS' || e.type === 'NOISE') continue;
    const r = Math.max(e.radius ?? 0, e.startRadius ?? 0) * 1.5 + (e.spread ?? 0);
    const off = Math.max(Math.abs(e.offset?.x ?? 0), Math.abs(e.offset?.y ?? 0));
    out = Math.max(out, r + off);
  }
  return out;
}

const isNormalBlend = (mode: string) => mode === 'PASS_THROUGH' || mode === 'NORMAL';

/** Shader goes into the Paint; our own JS reference is released immediately (otherwise the shader and its image are never freed). */
/** Diamond gradient: t = (|x − ½| + |y − ½|) · 2 in gradient space, color from the linear ramp. */
const DIAMOND_SKSL = `
uniform shader ramp;
half4 main(float2 p) {
  float t = (abs(p.x - 0.5) + abs(p.y - 0.5)) * 2.0;
  return ramp.eval(float2(clamp(t, 0.0, 1.0), 0.5));
}`;

/** Per-cell random number (hash without sines — identical on all GPUs). */
const HASH_SKSL = `
uniform float seed;
float hash(float2 p) {
  float3 q = fract(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973) + seed * 0.618);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}`;

/**
 * Noise: grains of size cell; fraction of filled ones — density; color — single,
 * one of two, or random with opacity alpha. Colors are not premultiplied by alpha.
 */
const NOISE_SKSL = `${HASH_SKSL}
uniform float2 cell;
uniform float density;
uniform float kind;
uniform float4 c1;
uniform float4 c2;
uniform float alpha;
half4 main(float2 xy) {
  float2 c = floor(xy / cell);
  if (hash(c) >= density) return half4(0);
  if (kind > 1.5) {
    float3 rgb = float3(hash(c + 11.7), hash(c + 23.1), hash(c + 37.9));
    return half4(half3(rgb * alpha), half(alpha));
  }
  float4 col = (kind > 0.5 && hash(c + 5.3) >= 0.5) ? c2 : c1;
  return half4(half3(col.rgb * col.a), half(col.a));
}`;

/** Displacement map for texture: random x and y offset per cell (R and G channels). */
const GRAIN_SKSL = `${HASH_SKSL}
uniform float2 cell;
half4 main(float2 xy) {
  float2 c = floor(xy / cell);
  return half4(half(hash(c)), half(hash(c + 19.19)), 0.5, 1.0);
}`;

/**
 * Glass: the shape is a rounded rectangle (distance to the edge is exact). mode 0 — displacement map
 * for refraction (R, G: inward shift, stronger near the edge, to depth depth); mode 1 — highlight: a
 * thin rim at the edges facing the light (and weaker at the opposite ones).
 */
const GLASS_SKSL = `
uniform float2 size;
uniform float radius;
uniform float depth;
uniform float mode;
uniform float2 light;
uniform float intensity;
float sdRound(float2 p, float2 b, float r) {
  float2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
half4 main(float2 xy) {
  float2 c = size * 0.5;
  float2 p = xy - c;
  float r = min(radius, min(c.x, c.y));
  float d = sdRound(p, c, r);
  float k = clamp(1.0 + d / max(depth, 0.001), 0.0, 1.0);
  float e = 0.5;
  float2 g = float2(sdRound(p + float2(e, 0.0), c, r) - sdRound(p - float2(e, 0.0), c, r), sdRound(p + float2(0.0, e), c, r) - sdRound(p - float2(0.0, e), c, r));
  float2 n = g / max(length(g), 0.0001);
  if (mode < 0.5) {
    float2 v = -n * k * k;
    return half4(half(0.5 + 0.5 * v.x), half(0.5 + 0.5 * v.y), 0.5, 1.0);
  }
  float rim = pow(k, 6.0);
  float facing = max(0.0, dot(n, light)) + 0.5 * max(0.0, -dot(n, light));
  float a = clamp(intensity * rim * facing, 0.0, 1.0);
  return half4(half(a), half(a), half(a), half(a));
}`;

function setShader(p: Paint, shader: Shader) {
  p.setShader(shader);
  shader.delete();
}

/**
 * Image adjustments (exposure, contrast, shadows, highlights, saturation, temperature, tint).
 * The formulas were tuned by comparing against samples from files: the mean
 * channel difference dropped from 12–34 to 1.4–5.5 out of 255. Order: exposure (in linear light) →
 * shadows and highlights (by luminance) → contrast → temperature and tint → saturation. Negative
 * “highlights” are not applied: they did not occur in the samples, and the image darkens too much with them.
 */
export const IMAGE_FILTER_SKSL = `
uniform shader image;
uniform float exposure;
uniform float contrast;
uniform float saturation;
uniform float temperature;
uniform float tint;
uniform float highlights;
uniform float shadows;

float toLin(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float toSrgb(float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }

half4 main(float2 p) {
  half4 src = image.eval(p);
  if (src.a <= 0.0) return src;
  float3 c = float3(src.rgb) / float(src.a);
  float m = exp2(3.085 * exposure);
  c = clamp(float3(toSrgb(toLin(c.r) * m), toSrgb(toLin(c.g) * m), toSrgb(toLin(c.b) * m)), 0.0, 1.0);
  float l = dot(c, float3(0.299, 0.587, 0.114));
  float d = 1.135 * shadows * pow(1.0 - l, 2.865) * l + 9.968 * max(highlights, 0.0) * pow(l, 5.669) * (1.0 - l);
  c = clamp(c + d, 0.0, 1.0);
  c = clamp((c - 0.5) * (1.0 + CONTRAST * contrast) + 0.5, 0.0, 1.0);
  c = clamp(c + float3(0.1 * temperature, -0.1 * tint, -0.1 * temperature), 0.0, 1.0);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float s = mx > 0.0 ? (mx - mn) / mx : 0.0;
  float k = saturation >= 0.0 ? 1.0 + 2.773 * saturation * (1.0 - s) : 1.0 + saturation;
  float gray = dot(c, float3(0.299, 0.587, 0.114));
  c = clamp(gray + (c - gray) * k, 0.0, 1.0);
  return half4(half3(c) * src.a, src.a);
}
`.replace('CONTRAST', '-0.39');

type PaintFilter = NonNullable<FigPaint['paintFilter']>;
const hasFilter = (f: PaintFilter | undefined): f is PaintFilter =>
  !!f && !!(f.exposure || f.contrast || f.vibrance || f.temperature || f.tint || f.highlights || f.shadows);

export function hashToHex(hash: Uint8Array | undefined): string {
  if (!hash) return '';
  let s = '';
  for (const b of hash) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Freeform gradient: how many points the shader accepts. */
const FREEFORM_MAX = 16;
/**
 * Freeform gradient (SkSL): point weight — (d² / s² + ε)^−1.5 (s — point strength, px); color —
 * weighted average (exactly the point's color at the point, smooth between points). Alpha is premultiplied.
 */
const FREEFORM_SKSL = `
uniform float count;
uniform float2 pts[16];
uniform float4 cols[16];
uniform float spread[16];
half4 main(float2 p) {
  float4 acc = float4(0);
  float sum = 0;
  for (int i = 0; i < 16; i++) {
    if (float(i) >= count) { break; }
    float2 d = p - pts[i];
    float s = max(spread[i], 1.0);
    float wgt = pow(dot(d, d) / (s * s) + 0.00001, -1.5);
    acc += cols[i] * wgt;
    sum += wgt;
  }
  float4 c = acc / max(sum, 1e-9);
  return half4(half3(c.rgb * c.a), half(c.a));
}`;

export class SceneRenderer {
  private paths = new Map<string, Path>();
  /** Node bounds in page coordinates (for culling). */
  private bounds = new WeakMap<SceneNode, Rect>();
  /** Node bounds in their own coordinates (for layer bounds). */
  private local = new WeakMap<SceneNode, Rect>();
  private stats: FrameStats = { drawn: 0, culled: 0 };
  private ck: CanvasKit;
  private blobs: Uint8Array[];
  private images: ImageSource;
  /** Paint cache: Figma fill → Paint for the node size and opacity multiplier. */
  private paints = new WeakMap<FigPaint, Map<string, Paint | null>>();
  private crossfadePaints = new WeakMap<FigPaint, { key: string; from: Paint | null; to: Paint | null; paint: Paint }>();
  /** Image paints with cached shaders — by image hash (a released image drops their shaders). */
  private imagePaints = new Map<string, Set<FigPaint>>();
  private unsubscribeEvict: (() => void) | undefined;
  /** Cache of node effect filters (layer blur, shadow, background blur). */
  private filters = new WeakMap<FigEffect, ImageFilter>();
  /** Image adjustment shader (created on the first image with adjustments). */
  private imageFilterEffect: RuntimeEffect | null | undefined;
  private diamondEffect: RuntimeEffect | null | undefined;
  private freeformEffect: RuntimeEffect | null | undefined;
  private videos: VideoSource | null = null;
  /** Video paint — per frame: paint → frame, size key and shader (the previous one is deleted). */
  private videoPaints = new WeakMap<FigPaint, { image: Image; key: string; paint: Paint | null }>();
  /**
   * Drawn nodes whose fill frame changes (video, animated image), and the hashes of those
   * frames. The editor draws their area every frame on top of the tiles, and doesn't redraw tiles
   * with them on every frame of the clip (otherwise — stutter and pieces of different frames across tiles).
   */
  readonly frameNodes = new Set<SceneNode>();
  readonly frameHashes = new Set<string>();
  private lotties: LottieSource | null = null;
  private models: ModelSource | null = null;
  private modelPaints = new WeakMap<FigPaint, { image: Image; key: string; paint: Paint | null }>();
  /** A live 3D model was drawn (the frame changes); reset by takeModelAnimated. */
  private modelDrawn = false;
  /** 3D model files that were drawn (tiles with them are redrawn when the timeline time changes). */
  readonly modelHashes = new Set<string>();
  /** Clip moment for 3D models without frame keys (timeline on canvas, export); null — per source. */
  modelTime: number | null = null;
  /** Lottie frame — one recording (SkPicture) per animation: frame and recording. */
  private lottiePictures = new Map<string, { frame: number; pic: SkPicture }>();
  private lottiePaints = new WeakMap<FigPaint, { pic: SkPicture; key: string; paint: Paint | null }>();
  /** Lottie was drawn (draw the next frame too); reset by takeLottieAnimated. */
  private lottieDrawn = false;
  /** Moment for all Lottie animations (timeline frame export); null — per source (clock, presentation). */
  lottieTime: number | null = null;
  private noiseEffect: RuntimeEffect | null | undefined;
  private grainEffect: RuntimeEffect | null | undefined;
  private glassEffect: RuntimeEffect | null | undefined;
  /** Shape corner radius for glass (estimated from the outline): node → radius. */
  private glassRadii = new WeakMap<SceneNode, number>();
  /** Filters that depend on node size (progressive blur): effect → key and filter. */
  private sizedFilters = new WeakMap<FigEffect, { key: string; f: ImageFilter }>();
  private shadowPaints = new WeakMap<FigEffect, Paint>();
  /** Text: all of a node's glyphs merged into one path per fill style. */
  private textPaths = new WeakMap<SceneNode, { fills: FigPaint[] | undefined; path: Path }[]>();
  private owned = new Set<{ delete(): void }>();
  private placeholder: Paint;
  private layerPaint: Paint;
  private maskPaint: Paint;
  /** Size of one device pixel in page coordinates. */
  private pixel = 1;
  /** Hashes of images requested during drawing (for tile invalidation). */
  private tracked: Set<string> | null = null;
  /** Debug toggles for profiling. */
  flags = { images: true, effects: true, masks: true, text: true, imageFilters: true, outline: false };
  /** Line color in outline mode (matches the page background). */
  outlineColor: [number, number, number] = [0, 0, 0];
  private outlinePaint: Paint | null = null;
  /** “Live layer” nodes (being edited right now): excluded from tiles, drawn separately. */
  private excluded = new Set<SceneNode>();
  private fonts: FontLibrary | null = null;
  /** Laid-out text paragraphs (key — layout parameters, color and font version). */
  private paragraphs = new WeakMap<SceneNode, { key: string; p: TextLayout }>();
  /** Shadow shapes with spread. */
  private spreadPaths = new WeakMap<SceneNode, { key: string; path: Path | null }>();
  /** Inner shadow paints (fill and “knockout”), one pair per effect. */
  private innerPaints = new WeakMap<FigEffect, { fill: Paint; hole: Paint; layer: Paint }>();
  /** Masks: luminance (DstIn after converting luminance to alpha) and shape (opaque paint). */
  private lumaMaskPaint: Paint;
  private shapeMaskPaint: Paint;
  /** Shadow not behind transparent areas: group (shadow blend mode) and cutout by the layer's alpha. */
  private shadowGroupPaint: Paint;
  private knockoutPaint: Paint;
  /** Outlines of our own strokes (built from the node's shape). */
  private strokeOutlines = new WeakMap<SceneNode, { key: string; path: Path | null }>();
  /** Node shape for clipping a ready stroke (union of fill outlines). */
  private shapeClips = new WeakMap<SceneNode, { key: string; path: Path | null }>();
  private bypass: SceneNode | null = null;
  /** Pattern source layer by document id (provided by the scene: a layer from any page). */
  private patternNodes: ((key: string) => SceneNode | undefined) | null = null;
  /** Recorded pattern tiles: source, grid kind, spacing and font version → tile. */
  private patternTiles = new Map<string, PatternTile>();
  /** Pattern paint — per paint: tile, size key and shader (new tile — new shader). */
  private patternPaints = new WeakMap<FigPaint, { tile: PatternTile; key: string; paint: Paint | null }>();
  /** Sources whose tiles are being recorded now: a pattern is not drawn inside its own source. */
  private recording = new Set<string>();
  /** How many times a placeholder was drawn instead of an image (image still loading). */
  private placeholders = 0;
  /** Frame number: an incomplete pattern tile is re-recorded at most once per frame. */
  private frame = 0;
  /** Fill shaders: code → effect (null — failed to compile) and error text. */
  private shaderEffects = new Map<string, { effect: RuntimeEffect | null; error: string | null }>();
  /** Shader paint — per paint: key (size, time, parameters) and shader. */
  private shaderPaints = new WeakMap<FigPaint, { key: string; paint: Paint | null }>();
  /** Shader time, seconds (set by the editor or presentation). */
  time = 0;
  /** Animated shaders were drawn since the last query (presentation: keep drawing). */
  private shaderAnimated = false;
  private wgslFills: WgslFillCache;
  onShaderFrame: (() => void) | null = null;
  onShaderError: ((message: string) => void) | null = null;
  waitShaders() { return this.wgslFills.ready(); }

  takeShaderAnimated(): boolean {
    const v = this.shaderAnimated;
    this.shaderAnimated = false;
    return v;
  }

  constructor(ck: CanvasKit, blobs: Uint8Array[], images: ImageSource) {
    this.wgslFills = new WgslFillCache(ck, () => this.onShaderFrame?.(), (message) => this.onShaderError?.(message));
    this.ck = ck;
    this.blobs = blobs;
    this.images = images;
    this.unsubscribeEvict = images.onEvict?.((hashes) => this.dropImagePaints(hashes));
    this.placeholder = new ck.Paint();
    this.placeholder.setColor(ck.Color4f(0.5, 0.5, 0.5, 0.15));
    this.layerPaint = new ck.Paint();
    this.maskPaint = new ck.Paint();
    this.maskPaint.setBlendMode(ck.BlendMode.DstIn);
    this.lumaMaskPaint = new ck.Paint();
    this.lumaMaskPaint.setBlendMode(ck.BlendMode.DstIn);
    this.lumaMaskPaint.setColorFilter(ck.ColorFilter.MakeLuma());
    this.shapeMaskPaint = new ck.Paint();
    this.shapeMaskPaint.setAntiAlias(true);
    this.shapeMaskPaint.setColor(ck.BLACK);
    this.shadowGroupPaint = new ck.Paint();
    this.knockoutPaint = new ck.Paint();
    this.knockoutPaint.setBlendMode(ck.BlendMode.DstOut);
    for (const o of [this.placeholder, this.layerPaint, this.maskPaint, this.lumaMaskPaint, this.shapeMaskPaint, this.shadowGroupPaint, this.knockoutPaint]) this.owned.add(o);
  }

  /** Images were released: drop shaders holding them (the next draw will rebuild them). */
  private dropImagePaints(hashes: ReadonlySet<string>) {
    for (const hash of hashes) {
      const fps = this.imagePaints.get(hash);
      if (!fps) continue;
      for (const fp of fps) {
        const bySize = this.paints.get(fp);
        if (!bySize) continue;
        for (const p of bySize.values()) {
          if (p && p !== this.placeholder) {
            p.delete();
            this.owned.delete(p);
          }
        }
        this.paints.delete(fp);
      }
      this.imagePaints.delete(hash);
    }
  }

  dispose() {
    this.wgslFills.dispose();
    this.unsubscribeEvict?.();
    this.unsubscribeEvict = undefined;
    this.imagePaints.clear();
    for (const p of this.paths.values()) p.delete();
    this.paths.clear();
    for (const o of this.owned) o.delete();
    this.owned.clear();
    this.imageFilterEffect?.delete();
    this.imageFilterEffect = undefined;
  }

  /** Node bounds in page coordinates. Computed once per page. */
  computeBounds(nodes: SceneNode[], parent: Matrix2D | readonly number[] = [1, 0, 0, 0, 1, 0]): Rect | undefined {
    let total: Rect | undefined;
    for (const n of nodes) {
      const world = nodeWorld(parent, n);
      let r = outset(worldBox(world, [0, 0, n.size.x, n.size.y]), effectOutset(n.effects) + (n.strokeOutset ?? 0) + 2);
      const childBounds = this.computeBounds(n.children, world);
      if (childBounds && !n.clipsContent) r = unionRect(r, childBounds);
      this.bounds.set(n, r);
      // Hidden nodes don't affect parent and page bounds.
      if (n.visible) total = total ? unionRect(total, r) : r;
    }
    return total;
  }

  /** Start tracking which images were used during drawing. */
  trackImages() {
    this.tracked = new Set();
  }

  takeTrackedImages(): Set<string> {
    const t = this.tracked ?? new Set<string>();
    this.tracked = null;
    return t;
  }

  boundsOf(node: SceneNode): Rect | undefined {
    return this.bounds.get(node);
  }

  // ---------- Incremental changes (editor) ----------

  /** Recompute bounds of a node's subtree; parentWorld — the parent's world matrix. */
  refreshBounds(node: SceneNode, parentWorld: Matrix2D | readonly number[]): Rect | undefined {
    this.local.delete(node);
    return this.computeBounds([node], parentWorld);
  }

  /** Recompute a container's bounds from its children's known bounds (without traversing the subtree). */
  refreshContainerBounds(node: SceneNode, world: Matrix2D | readonly number[]) {
    this.local.delete(node);
    let r = outset(worldBox(world, [0, 0, node.size.x, node.size.y]), effectOutset(node.effects) + 2);
    if (!node.clipsContent) {
      for (const c of node.children) {
        const b = this.bounds.get(c);
        if (b && c.visible) r = unionRect(r, b);
      }
    }
    this.bounds.set(node, r);
    return r;
  }

  /** Forget a node's caches (fill shaders, text paths, local bounds) — the node changed or was deleted. */
  forget(node: SceneNode) {
    this.local.delete(node);
    const outline = this.strokeOutlines.get(node);
    if (outline) {
      if (outline.path) {
        this.owned.delete(outline.path);
        outline.path.delete();
      }
      this.strokeOutlines.delete(node);
    }
    const para = this.paragraphs.get(node);
    if (para) {
      para.p.delete();
      this.paragraphs.delete(node);
    }
    const runs = this.textPaths.get(node);
    if (runs) {
      for (const r of runs) {
        r.path.delete();
        this.owned.delete(r.path);
      }
      this.textPaths.delete(node);
    }
    this.forgetFills([...node.fills, ...node.strokes, ...node.fillGeometry.flatMap((g) => g.fills ?? [])]);
  }

  /** Release transient prototype paints when a transition finishes/interruption occurs. */
  forgetFills(fills: FigPaint[]) {
    for (const fp of fills) {
      const fade = this.crossfadePaints.get(fp);
      if (fade) { this.owned.delete(fade.paint); fade.paint.delete(); this.crossfadePaints.delete(fp); }
      if (fp.type === 'IMAGE') this.imagePaints.get(hashToHex(fp.image?.hash))?.delete(fp);
      const sp = this.shaderPaints.get(fp);
      if (sp) {
        if (sp.paint) {
          this.owned.delete(sp.paint);
          sp.paint.delete();
        }
        this.shaderPaints.delete(fp);
      }
      const pp = this.patternPaints.get(fp);
      if (pp) {
        if (pp.paint) {
          this.owned.delete(pp.paint);
          pp.paint.delete();
        }
        this.patternPaints.delete(fp);
      }
      const bySize = this.paints.get(fp);
      if (!bySize) continue;
      for (const p of bySize.values()) {
        if (p && p !== this.placeholder) {
          p.delete();
          this.owned.delete(p);
        }
      }
      this.paints.delete(fp);
    }
  }

  /** Free a path from the cache (the node's geometry was replaced). */
  dropPath(blob: number) {
    for (const k of [`${blob}:0`, `${blob}:1`]) {
      const p = this.paths.get(k);
      if (p) {
        p.delete();
        this.paths.delete(k);
      }
    }
  }

  /**
   * @param viewport — visible area in page coordinates.
   * @param scale — device pixels per page unit (for the level of detail).
   */
  render(canvas: Canvas, nodes: SceneNode[], viewport: Rect, scale: number): FrameStats {
    this.stats = { drawn: 0, culled: 0 };
    this.frame++;
    this.pixel = 1 / scale;
    this.drawChildren(canvas, nodes, viewport);
    return this.stats;
  }

  /** Fonts for text laid out by the renderer (created or modified in the editor). */
  setFonts(fonts: FontLibrary) {
    this.fonts = fonts;
  }

  /** Exclude nodes from regular (tile) drawing — they are drawn separately as a “live layer”. */
  setExcluded(nodes: SceneNode[]) {
    this.excluded = new Set(nodes);
  }

/** Shadows under a node (in its coordinates): by shape, or, if there is no shape, by content via a layer. */
  private drawDropShadows(canvas: Canvas, n: SceneNode, effects: FigEffect[], viewport: Rect) {
    const ck = this.ck;
    for (const e of effects) {
      if (e.type !== 'DROP_SHADOW') continue;
      if (this.fastShadow(canvas, n, e)) continue;
      let f = this.filters.get(e);
      if (!f) {
        const c = e.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
        const sigma = (e.radius ?? 0) / 2;
        f = ck.ImageFilter.MakeDropShadowOnly(e.offset?.x ?? 0, e.offset?.y ?? 0, sigma, sigma, ck.Color4f(c.r, c.g, c.b, c.a), null);
        this.filters.set(e, f);
        this.owned.add(f);
      }
      const content = () => {
        this.drawOwn(canvas, n);
        if (!n.clipsContent) this.drawChildren(canvas, n.reverseZ ? [...n.children].reverse() : n.children, viewport);
      };
      // Shadow by content alpha (image, text, group). By default it is not present under
      // the layer: a cutout by the same alpha — the shadow shows through transparent image pixels.
      const cut = e.showShadowBehindNode !== true;
      const bounds = this.localBounds(n);
      if (cut) {
        this.shadowGroupPaint.setBlendMode(this.blendMode(e.blendMode));
        canvas.saveLayer(this.shadowGroupPaint, bounds);
      }
      const sp = this.layerPaint;
      sp.setAlphaf(1);
      sp.setBlendMode(cut ? ck.BlendMode.SrcOver : this.blendMode(e.blendMode));
      sp.setImageFilter(f);
      canvas.saveLayer(sp, bounds);
      content();
      canvas.restore();
      if (cut) {
        canvas.saveLayer(this.knockoutPaint, bounds);
        content();
        canvas.restore();
        canvas.restore();
      }
    }
  }

  /**
   * Only the node's shadows — for export (PDF: shadow as an image, the node itself as vector). drop —
   * shadows under the node, inner — inner shadows (over the fill).
   */
  renderShadows(canvas: Canvas, node: SceneNode, parentWorld: Matrix2D | readonly number[], viewport: Rect, scale: number, kind: 'drop' | 'inner') {
    this.pixel = 1 / scale;
    const effects = node.effects.filter((e) => e.visible !== false && e.type === (kind === 'drop' ? 'DROP_SHADOW' : 'INNER_SHADOW'));
    if (!effects.length) return;
    canvas.save();
    canvas.concat(toMat3(parentWorld));
    canvas.concat(toMat3(node.transform));
    if (node.persp) canvas.concat(node.persp);
    if (kind === 'drop') this.drawDropShadows(canvas, node, effects, viewport);
    else for (const e of effects) this.innerShadow(canvas, node, e);
    canvas.restore();
  }

  /** Draw one node (with its subtree) with the given parent world matrix — for the “live layer”. */
  renderLive(canvas: Canvas, node: SceneNode, parentWorld: Matrix2D | readonly number[], viewport: Rect, scale: number) {
    this.pixel = 1 / scale;
    this.bypass = node;
    canvas.save();
    canvas.concat(toMat3(parentWorld));
    this.drawNode(canvas, node, viewport);
    canvas.restore();
    this.bypass = null;
  }

  private path(blob: number, evenOdd: boolean): Path | undefined {
    const key = `${blob}:${evenOdd ? 1 : 0}`;
    let p = this.paths.get(key);
    if (p) return p;
    const bytes = this.blobs[blob];
    if (!bytes) return undefined;
    const b = new this.ck.PathBuilder();
    decodePathCommands(bytes, {
      moveTo: (x, y) => b.moveTo(x, y),
      lineTo: (x, y) => b.lineTo(x, y),
      quadTo: (x1, y1, x, y) => b.quadTo(x1, y1, x, y),
      cubicTo: (x1, y1, x2, y2, x, y) => b.cubicTo(x1, y1, x2, y2, x, y),
      close: () => b.close(),
    });
    b.setFillType(evenOdd ? this.ck.FillType.EvenOdd : this.ck.FillType.Winding);
    p = b.detachAndDelete();
    this.paths.set(key, p);
    return p;
  }

  /** Bounds of a node's content in its own coordinates (geometry, text, children, effects). */
  contentBounds(n: SceneNode): Rect {
    return [...this.localBounds(n)];
  }

  /** Bounds of a node's content in its own coordinates (geometry, text, children, effects). */
  private localBounds(n: SceneNode): Rect {
    const cached = this.local.get(n);
    if (cached) return cached;
    let r: Rect = [0, 0, n.size.x, n.size.y];
    const addPath = (p: Path | undefined) => {
      if (!p) return;
      const b = p.getBounds();
      r = unionRect(r, [b[0]!, b[1]!, b[2]!, b[3]!]);
    };
    for (const g of n.fillGeometry) addPath(this.path(g.blob, g.windingRule === 'EVENODD'));
    for (const g of n.strokeGeometry) addPath(this.path(g.blob, g.windingRule === 'EVENODD'));
    addPath(this.strokeOutline(n));
    if (n.type === 'TEXT') for (const run of this.textRuns(n)) addPath(run.path);
    if (!n.clipsContent) {
      for (const c of n.children) {
        if (c.visible) r = unionRect(r, c.persp ? mapRect3(mul3(c.transform, c.persp), this.localBounds(c)) : transformBox(c.transform, this.localBounds(c)));
      }
    }
    r = outset(r, effectOutset(n.effects) + 1);
    this.local.set(n, r);
    return r;
  }

  private blendMode(mode: string | undefined) {
    const B = this.ck.BlendMode;
    switch (mode) {
      case 'MULTIPLY': return B.Multiply;
      case 'SCREEN': return B.Screen;
      case 'OVERLAY': return B.Overlay;
      case 'DARKEN': return B.Darken;
      case 'LIGHTEN': return B.Lighten;
      case 'COLOR_DODGE': return B.ColorDodge;
      case 'COLOR_BURN': return B.ColorBurn;
      case 'HARD_LIGHT': return B.HardLight;
      case 'SOFT_LIGHT': return B.SoftLight;
      case 'DIFFERENCE': return B.Difference;
      case 'EXCLUSION': return B.Exclusion;
      case 'HUE': return B.Hue;
      case 'SATURATION': return B.Saturation;
      case 'COLOR': return B.Color;
      case 'LUMINOSITY': return B.Luminosity;
      case 'LINEAR_DODGE': return B.Plus;
      case 'LINEAR_BURN': return B.Multiply; // approximation: Skia has no linear burn
      default: return B.SrcOver;
    }
  }

  /**
   * Paint for a Figma fill from the cache. null — nothing to draw. Do not delete: the cache owns it.
   * alphaMul and nodeBlend — the node's opacity and blend mode if it doesn't need a layer.
   */
  /** Video frame source (editor and presentation). */
  setVideos(videos: VideoSource | null) {
    this.videos = videos;
  }

  /** 3D models for MODEL3D fills. */
  setModels(models: ModelSource | null) {
    this.models = models;
  }

  /** A live 3D model was drawn since the last call (draw the next frame too). */
  takeModelAnimated(): boolean {
    const v = this.modelDrawn;
    this.modelDrawn = false;
    return v;
  }

  /** 3D model paint: frame (an image at the layer's on-screen bounds size) — by the layer bounds. */
  private modelPaint(fp: FigPaint, w: number, h: number, alphaMul: number, nodeBlend?: string): Paint | null {
    const m = fp.model;
    const hash = hashToHex(m?.hash);
    this.tracked?.add(hash);
    this.modelHashes.add(hash);
    // Frame size: the layer bounds on screen, in power-of-two steps (fewer redraws when zooming).
    const longest = Math.max(w, h) / this.pixel;
    const side = Math.min(2048, 2 ** Math.ceil(Math.log2(Math.max(32, longest))));
    const k = side / Math.max(w, h, 1e-6);
    const wpx = Math.max(8, Math.round(w * k));
    const hpx = Math.max(8, Math.round(h * k));
    const view: ModelView = {
      camera: m?.camera ?? { yaw: 30, pitch: 15, zoom: 1 },
      clip: m?.clip,
      pose: m?.pose ?? 0,
      lighting: m?.lighting ?? 'STUDIO',
      fill: fp.imageScaleMode === 'FILL',
      ...(m?.keyed ? { keyed: true } : {}),
    };
    // Clip moment: timeline keys (pose) or timeline time (canvas with the panel open, export).
    const image = this.flags.images ? this.models?.frame(hash, fp, view, wpx, hpx, view.keyed ? view.pose : this.modelTime) : undefined;
    if (!image) {
      this.placeholders++;
      return this.placeholder;
    }
    if (this.models?.live?.(fp)) this.modelDrawn = true;
    const key = `${w}:${h}|${alphaMul}|${nodeBlend ?? ''}`;
    const prev = this.modelPaints.get(fp);
    if (prev && prev.image === image && prev.key === key) return prev.paint;
    if (prev?.paint) {
      this.owned.delete(prev.paint);
      prev.paint.delete();
    }
    let paint: Paint | null = null;
    const alpha = (fp.opacity ?? 1) * alphaMul;
    if (fp.visible !== false && alpha > 0) {
      const ck = this.ck;
      const shader = image.makeShaderOptions(ck.TileMode.Decal, ck.TileMode.Decal, ck.FilterMode.Linear, ck.MipmapMode.None, toMat3([w / image.width(), 0, 0, 0, h / image.height(), 0]));
      if (shader) {
        paint = new ck.Paint();
        paint.setAntiAlias(true);
        const paintBlend = fp.blendMode && !isNormalBlend(fp.blendMode) ? fp.blendMode : nodeBlend;
        paint.setBlendMode(this.blendMode(paintBlend));
        setShader(paint, shader);
        paint.setAlphaf(alpha);
        this.owned.add(paint);
      }
    }
    this.modelPaints.set(fp, { image, key, paint });
    return paint;
  }

  /** Lottie animations for LOTTIE fills. */
  setLotties(lotties: LottieSource | null) {
    this.lotties = lotties;
  }

  /** Whether Lottie was drawn since the last call (the frame changes — keep drawing). */
  takeLottieAnimated(): boolean {
    const v = this.lottieDrawn;
    this.lottieDrawn = false;
    return v;
  }

  /** Lottie updated (loaded, replaced) — forget frame recordings. */
  forgetLottie(hash: string) {
    this.lottiePictures.get(hash)?.pic.delete();
    this.lottiePictures.delete(hash);
  }

  /** Frame of animation hash at moment t (seconds): a frame recording shared by all fills using it. */
  private lottiePicture(hash: string, clip: LottieClip, t: number): SkPicture | null {
    const loop = clip.duration > 0 ? ((t % clip.duration) + clip.duration) % clip.duration : 0;
    const frame = Math.min(clip.frames - 1, Math.floor(loop * clip.fps + 1e-6));
    const cached = this.lottiePictures.get(hash);
    if (cached && cached.frame === frame) return cached.pic;
    const ck = this.ck;
    const rec = new ck.PictureRecorder();
    try {
      const c = rec.beginRecording(ck.LTRBRect(0, 0, clip.width, clip.height));
      clip.anim.seekFrame(frame);
      clip.anim.render(c, ck.LTRBRect(0, 0, clip.width, clip.height));
      const pic = rec.finishRecordingAsPicture();
      cached?.pic.delete();
      this.lottiePictures.set(hash, { frame, pic });
      return pic;
    } finally {
      rec.delete();
    }
  }

  /** Whether the node has a fill with a changing frame (video, animated image). */
  hasFrameFill(n: SceneNode): boolean {
    let found = false;
    for (const fp of n.fills) {
      if (fp.visible === false) continue;
      if (fp.type === 'VIDEO' || fp.type === 'LOTTIE') {
        this.frameHashes.add(hashToHex(fp.type === 'VIDEO' ? fp.video?.hash : fp.lottie?.hash));
        found = true;
      } else if (fp.type === 'MODEL3D' && this.modelTime !== null) {
        // 3D model while the timeline plays: the frame changes — an area over the tiles.
        found = true;
      } else if (fp.type === 'IMAGE' && this.images.animated) {
        const hash = hashToHex(fp.image?.hash);
        if (this.images.animated(hash)) {
          this.frameHashes.add(hash);
          found = true;
        }
      }
    }
    return found;
  }

  private getPaint(fp: FigPaint, w: number, h: number, alphaMul = 1, nodeBlend?: string): Paint | null {
    if (fp.crossfade) return this.crossfadePaint(fp, w, h, alphaMul, nodeBlend);
    if (fp.visible === false || (fp.opacity ?? 1) <= 0) return null;
    if (fp.type === 'PATTERN') return this.patternPaint(fp, w, h, alphaMul, nodeBlend);
    if (fp.type === 'SHADER') return this.shaderPaint(fp, w, h, alphaMul, nodeBlend);
    if (fp.type === 'LOTTIE') return this.lottiePaint(fp, w, h, alphaMul, nodeBlend);
    if (fp.type === 'MODEL3D') return this.modelPaint(fp, w, h, alphaMul, nodeBlend);
    // Animated image — like video: the frame changes, the shader is per frame.
    const animatedHash = fp.type === 'IMAGE' && this.images.animated ? hashToHex(fp.image?.hash) : '';
    if (fp.type === 'VIDEO' || (animatedHash && this.images.animated!(animatedHash))) {
      const hash = fp.type === 'VIDEO' ? hashToHex(fp.video?.hash) : animatedHash;
      this.tracked?.add(hash);
      const frame = !this.flags.images ? undefined : fp.type === 'VIDEO' ? this.videos?.frame(hash, fp) : this.images.get(hash, Math.max(w, h) / this.pixel, fp.originalImageWidth);
      if (!frame) {
        this.placeholders++;
        return this.placeholder;
      }
      // The frame changes — the shader lives until the next frame (or a different size).
      const key = `${w}:${h}|${alphaMul}|${nodeBlend ?? ''}`;
      const prev = this.videoPaints.get(fp);
      if (prev && prev.image === frame && prev.key === key) return prev.paint;
      if (prev?.paint) {
        this.owned.delete(prev.paint);
        prev.paint.delete();
      }
      const paint = this.makePaint(fp, w, h, frame, alphaMul, nodeBlend);
      if (paint) this.owned.add(paint);
      this.videoPaints.set(fp, { image: frame, key, paint });
      return paint;
    }
    let image: Image | undefined;
    let imageHash = '';
    if (fp.type === 'IMAGE') {
      const screenPx = Math.max(w, h) / this.pixel;
      const hash = (imageHash = hashToHex(fp.image?.hash));
      this.tracked?.add(hash);
      image = this.flags.images ? this.images.get(hash, screenPx, fp.originalImageWidth) : undefined;
      // While the image is loading (or is too small) — a neutral placeholder, not cached.
      if (!image) {
        this.placeholders++;
        return this.placeholder;
      }
    }
    // A solid color doesn't depend on size; gradients and images do.
    const sizeKey =
      (fp.type === 'SOLID' ? '' : `${w}:${h}:${image?.width() ?? 0}`) + `|${alphaMul}|${nodeBlend ?? ''}`;
    let bySize = this.paints.get(fp);
    if (!bySize) this.paints.set(fp, (bySize = new Map()));
    const cached = bySize.get(sizeKey);
    if (cached !== undefined) return cached;
    const paint = this.makePaint(fp, w, h, image, alphaMul, nodeBlend);
    bySize.set(sizeKey, paint);
    if (paint) this.owned.add(paint);
    if (imageHash && paint) {
      let fps = this.imagePaints.get(imageHash);
      if (!fps) this.imagePaints.set(imageHash, (fps = new Set()));
      fps.add(fp);
    }
    return paint;
  }

  /** Mix premultiplied samples; source-over of two faded images would lose alpha. */
  private crossfadePaint(fp: FigPaint, w: number, h: number, alphaMul: number, nodeBlend?: string): Paint | null {
    const fade = fp.crossfade!;
    const from = this.getPaint(fade.from, w, h), to = this.getPaint(fade.to, w, h);
    const { effect } = this.shaderEffect('uniform shader before; uniform shader after; uniform float progress; half4 main(float2 p) { return mix(before.eval(p), after.eval(p), progress); }');
    if (!effect) return to;
    const key = `${w}:${h}:${alphaMul}:${nodeBlend ?? ''}:${fade.progress}`;
    const old = this.crossfadePaints.get(fp);
    if (old?.key === key && old.from === from && old.to === to) return old.paint;
    if (old) { this.owned.delete(old.paint); old.paint.delete(); }
    const ck = this.ck;
    const rect = ck.XYWHRect(0, 0, w, h);
    const sample = (paint: Paint | null) => {
      const recorder = new ck.PictureRecorder();
      const canvas = recorder.beginRecording(rect);
      if (paint) canvas.drawRect(rect, paint);
      const picture = recorder.finishRecordingAsPicture(); recorder.delete();
      const shader = picture.makeShader(ck.TileMode.Decal, ck.TileMode.Decal, ck.FilterMode.Linear, undefined, rect);
      picture.delete(); return shader;
    };
    const a = sample(from), b = sample(to);
    const paint = new ck.Paint(); paint.setAntiAlias(true);
    setShader(paint, effect.makeShaderWithChildren([fade.progress], [a, b]));
    a.delete(); b.delete();
    paint.setAlphaf(alphaMul); paint.setBlendMode(this.blendMode(nodeBlend));
    this.owned.add(paint); this.crossfadePaints.set(fp, { key, from, to, paint });
    return paint;
  }

  /** Build a shader (from the cache): effect and compile error. */
  private shaderEffect(code: string): { effect: RuntimeEffect | null; error: string | null } {
    let e = this.shaderEffects.get(code);
    if (!e) {
      let error: string | null = null;
      const effect = this.ck.RuntimeEffect?.Make(code, (err) => (error = err)) ?? null;
      e = { effect, error: effect ? null : (error ?? 'Шейдер не собрался') };
      if (effect) this.owned.add(effect);
      this.shaderEffects.set(code, e);
    }
    return e;
  }

  /** Shader code compile error (null — compiles). */
  shaderError(code: string, kind: 'fill' | 'effect' = 'fill'): string | null {
    return shaderContractError(code, kind) ?? this.shaderEffect(code).error;
  }

  /** A single paint as a PNG image (w × h at scale scale, without paint opacity) — for SVG. */
  paintPng(fp: FigPaint, w: number, h: number, scale: number): Uint8Array | null {
    const ck = this.ck;
    const W = Math.max(1, Math.min(4096, Math.round(w * scale)));
    const H = Math.max(1, Math.min(4096, Math.round(h * scale)));
    const surf = ck.MakeSurface(W, H);
    if (!surf) return null;
    const one: FigPaint = { ...fp, opacity: 1, blendMode: undefined };
    try {
      const canvas = surf.getCanvas();
      canvas.scale(W / w, H / h);
      const p = this.getPaint(one, w, h);
      if (p) canvas.drawRect(ck.XYWHRect(0, 0, w, h), p);
      const img = surf.makeImageSnapshot();
      const bytes = img.encodeToBytes();
      img.delete();
      return bytes;
    } finally {
      for (const cache of [this.shaderPaints, this.patternPaints, this.lottiePaints] as WeakMap<FigPaint, { paint: Paint | null }>[]) {
        const e = cache.get(one);
        if (e?.paint) {
          this.owned.delete(e.paint);
          e.paint.delete();
        }
        cache.delete(one);
      }
      surf.delete();
    }
  }

  /** Shader fill paint: uniforms size and time come from the renderer, the rest are paint parameters. */
  private shaderPaint(fp: FigPaint, w: number, h: number, alphaMul: number, nodeBlend?: string): Paint | null {
    const sh = fp.shader;
    if (!sh) return null;
    if (sh.wgsl) {
      this.tracked?.add(WGSL_FRAME);
      if (sh.animate) { this.tracked?.add(SHADER_CLOCK); this.shaderAnimated = true; }
      const entry = this.wgslFills.get(sh.wgsl, sh.params, w, h, sh.animate ? this.time : 0);
      if (!entry.image) { this.placeholders++; return this.placeholder; }
      const key = `wgsl:${w}:${h}:${entry.revision}:${alphaMul}:${nodeBlend ?? ''}`;
      const prev = this.shaderPaints.get(fp);
      if (prev?.key === key) return prev.paint;
      if (prev?.paint) { this.owned.delete(prev.paint); prev.paint.delete(); }
      const paint = new this.ck.Paint();
      paint.setAntiAlias(true);
      paint.setBlendMode(this.blendMode(fp.blendMode && !isNormalBlend(fp.blendMode) ? fp.blendMode : nodeBlend));
      paint.setAlphaf((fp.opacity ?? 1) * alphaMul);
      setShader(paint, entry.image.makeShaderOptions(this.ck.TileMode.Clamp, this.ck.TileMode.Clamp, this.ck.FilterMode.Linear, this.ck.MipmapMode.None, [w / entry.image.width(), 0, 0, 0, h / entry.image.height(), 0, 0, 0, 1]));
      this.owned.add(paint); this.shaderPaints.set(fp, { key, paint });
      return paint;
    }
    if (shaderContractError(sh.code, 'fill')) return this.placeholder;
    const { effect } = this.shaderEffect(sh.code);
    if (!effect) return this.placeholder;
    const names = Array.from({ length: effect.getUniformCount() }, (_, i) => effect.getUniformName(i));
    const animated = sh.animate && names.includes('time');
    if (animated) {
      this.tracked?.add(SHADER_CLOCK);
      this.shaderAnimated = true;
    }
    const key = `${w}:${h}|${alphaMul}|${nodeBlend ?? ''}|${animated ? this.time : 0}`;
    const prev = this.shaderPaints.get(fp);
    if (prev && prev.key === key) return prev.paint;
    if (prev?.paint) {
      this.owned.delete(prev.paint);
      prev.paint.delete();
    }
    const alpha = (fp.opacity ?? 1) * alphaMul;
    let paint: Paint | null = null;
    if (alpha > 0) {
      const uniforms = new Float32Array(effect.getUniformFloatCount());
      names.forEach((name, i) => {
        const u = effect.getUniform(i);
        const n = u.columns * u.rows;
        const v = name === 'size' ? [w, h] : name === 'time' ? [animated ? this.time : 0] : (sh.params[name] ?? DEFAULTS(sh.code)[name] ?? []);
        for (let k = 0; k < n; k++) uniforms[u.slot + k] = v[k] ?? v[0] ?? 0;
      });
      paint = new this.ck.Paint();
      paint.setAntiAlias(true);
      const blend = fp.blendMode && !isNormalBlend(fp.blendMode) ? fp.blendMode : nodeBlend;
      paint.setBlendMode(this.blendMode(blend));
      setShader(paint, effect.makeShader(uniforms));
      paint.setAlphaf(alpha);
      this.owned.add(paint);
    }
    this.shaderPaints.set(fp, { key, paint });
    return paint;
  }

  /** The scene provides the lookup of pattern source layers. */
  setPatternSource(fn: ((key: string) => SceneNode | undefined) | null) {
    this.patternNodes = fn;
  }

  /** A pattern source changed: re-record its tiles (shaders are recreated from the new tile). */
  dropPattern(key: string) {
    for (const [k, t] of this.patternTiles) {
      if (!k.startsWith(`${key}|`)) continue;
      this.owned.delete(t.picture);
      t.picture.delete();
      this.patternTiles.delete(k);
    }
  }

  /**
   * Pattern tile: the source recorded into a Picture without offset (with rotation — by its bounds).
   * A grid has one copy per tile, hexagonal ones have three: every other row (or column) is shifted by half a tile.
   */
  private patternTile(pt: NonNullable<FigPaint['pattern']>): PatternTile | null {
    const sx = Math.max(0, pt.spacing?.x ?? 0);
    const sy = Math.max(0, pt.spacing?.y ?? 0);
    const key = `${pt.source}|${pt.tileType}|${sx}|${sy}|${this.fonts?.version ?? 0}`;
    const cached = this.patternTiles.get(key);
    if (cached && (cached.complete || cached.frame === this.frame)) return cached;
    if (this.recording.has(pt.source)) return null;
    const node = this.patternNodes?.(pt.source);
    if (!node) return null;
    const t = node.transform;
    const box = transformBox([t[0], t[1], 0, t[3], t[4], 0], [0, 0, node.size.x, node.size.y]);
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    if (!(w > 1e-3 && h > 1e-3)) return null;
    const cw = w * (1 + sx);
    const ch = h * (1 + sy);
    const hex = pt.tileType === 'HORIZONTAL_HEXAGONAL' ? 1 : pt.tileType === 'VERTICAL_HEXAGONAL' ? 2 : 0;
    const copies: [number, number][] =
      hex === 1 ? [[0, 0], [cw / 2, ch], [-cw / 2, ch]] : hex === 2 ? [[0, 0], [cw, ch / 2], [cw, -ch / 2]] : [[0, 0]];
    const rect: Rect = [0, 0, hex === 2 ? 2 * cw : cw, hex === 1 ? 2 * ch : ch];
    const ck = this.ck;
    const rec = new ck.PictureRecorder();
    const canvas = rec.beginRecording(ck.LTRBRect(rect[0], rect[1], rect[2], rect[3]));
    // The tile doesn't depend on canvas zoom: no small-detail simplifications, and with “live layer” nodes.
    const saved = { pixel: this.pixel, excluded: this.excluded, placeholders: this.placeholders };
    this.pixel = 1e-3;
    this.excluded = new Set();
    this.recording.add(pt.source);
    try {
      for (const [dx, dy] of copies) {
        canvas.save();
        canvas.translate(dx - box[0] - t[2], dy - box[1] - t[5]);
        this.drawNode(canvas, node, EVERYWHERE);
        canvas.restore();
      }
    } finally {
      this.recording.delete(pt.source);
      this.pixel = saved.pixel;
      this.excluded = saved.excluded;
    }
    const picture = rec.finishRecordingAsPicture();
    rec.delete();
    if (cached) {
      this.owned.delete(cached.picture);
      cached.picture.delete();
    }
    const tile: PatternTile = { picture, rect, w, h, complete: this.placeholders === saved.placeholders, frame: this.frame };
    this.owned.add(picture);
    this.patternTiles.set(key, tile);
    return tile;
  }

  /** Pattern paint: the tile repeats across the layer with scale; the first one at the left edge, center or right. */
  private patternPaint(fp: FigPaint, w: number, h: number, alphaMul: number, nodeBlend?: string): Paint | null {
    const pt = fp.pattern;
    if (!pt) return null;
    const tile = this.patternTile(pt);
    if (!tile) return null;
    const key = `${w}:${h}|${alphaMul}|${nodeBlend ?? ''}`;
    const prev = this.patternPaints.get(fp);
    if (prev && prev.tile === tile && prev.key === key) return prev.paint;
    if (prev?.paint) {
      this.owned.delete(prev.paint);
      prev.paint.delete();
    }
    const ck = this.ck;
    const alpha = (fp.opacity ?? 1) * alphaMul;
    let paint: Paint | null = null;
    if (alpha > 0) {
      paint = new ck.Paint();
      paint.setAntiAlias(true);
      const blend = fp.blendMode && !isNormalBlend(fp.blendMode) ? fp.blendMode : nodeBlend;
      paint.setBlendMode(this.blendMode(blend));
      const k = Math.max(1e-3, pt.scale || 1);
      const ox = pt.align === 'CENTER' ? (w - tile.w * k) / 2 : pt.align === 'END' ? w - tile.w * k : 0;
      const r = tile.rect;
      setShader(paint, tile.picture.makeShader(ck.TileMode.Repeat, ck.TileMode.Repeat, ck.FilterMode.Linear, toMat3([k, 0, ox, 0, k, 0]), ck.LTRBRect(r[0], r[1], r[2], r[3])));
      paint.setAlphaf(alpha);
      this.owned.add(paint);
    }
    this.patternPaints.set(fp, { tile, key, paint });
    return paint;
  }

  /** Image with adjustments (if set and shaders are available); the source shader is owned by the result. */
  private filteredImage(shader: Shader, f: PaintFilter | undefined): Shader {
    if (!hasFilter(f) || !this.flags.imageFilters) return shader;
    if (this.imageFilterEffect === undefined) this.imageFilterEffect = this.ck.RuntimeEffect?.Make(IMAGE_FILTER_SKSL) ?? null;
    const effect = this.imageFilterEffect;
    if (!effect) return shader;
    const u = [f.exposure ?? 0, f.contrast ?? 0, f.vibrance ?? 0, f.temperature ?? 0, f.tint ?? 0, f.highlights ?? 0, f.shadows ?? 0];
    const out = effect.makeShaderWithChildren(u, [shader]);
    shader.delete();
    return out;
  }

  /** Creates a Paint for a Figma fill. Returns null if the fill type is not supported. */
  private makePaint(fp: FigPaint, w: number, h: number, image: Image | undefined, alphaMul: number, nodeBlend?: string): Paint | null {
    if (fp.visible === false) return null;
    const ck = this.ck;
    const alpha = (fp.opacity ?? 1) * alphaMul;
    if (alpha <= 0) return null;
    const p = new ck.Paint();
    p.setAntiAlias(true);
    const paintBlend = fp.blendMode && !isNormalBlend(fp.blendMode) ? fp.blendMode : nodeBlend;
    p.setBlendMode(this.blendMode(paintBlend));

    const gradientLocal = () => {
      const t: Matrix2D = fp.transform
        ? [fp.transform.m00, fp.transform.m01, fp.transform.m02, fp.transform.m10, fp.transform.m11, fp.transform.m12]
        : [1, 0, 0, 0, 1, 0];
      // Lines and flat vector paths have a zero extent on one axis, but their
      // strokes are still visible. Skia rejects a singular local shader matrix.
      return toMat3(multiply([w === 0 ? 1 : w, 0, 0, 0, h === 0 ? 1 : h, 0], invert(t)));
    };
    const shaderPaint = (shader: Shader | null): Paint | null => {
      if (!shader) { p.delete(); return null; }
      setShader(p, shader);
      p.setAlphaf(alpha);
      return p;
    };
    const stops = () => {
      // Skia expects positions in ascending order.
      const s = [...(fp.stops ?? [])].sort((a, b) => a.position - b.position);
      return {
        colors: s.map((st) => ck.Color4f(st.color.r, st.color.g, st.color.b, st.color.a)),
        pos: s.map((st) => st.position),
      };
    };

    switch (fp.type) {
      case 'SOLID': {
        const c = fp.color ?? { r: 0, g: 0, b: 0, a: 1 };
        p.setColor(ck.Color4f(c.r, c.g, c.b, c.a * alpha));
        return p;
      }
      case 'GRADIENT_LINEAR': {
        const { colors, pos } = stops();
        return shaderPaint(ck.Shader.MakeLinearGradient([0, 0.5], [1, 0.5], colors, pos, ck.TileMode.Clamp, gradientLocal()));
      }
      case 'GRADIENT_DIAMOND': {
        const { colors, pos } = stops();
        if (this.diamondEffect === undefined) this.diamondEffect = ck.RuntimeEffect?.Make(DIAMOND_SKSL) ?? null;
        if (this.diamondEffect) {
          const ramp = ck.Shader.MakeLinearGradient([0, 0.5], [1, 0.5], colors, pos, ck.TileMode.Clamp);
          if (!ramp) { p.delete(); return null; }
          try { return shaderPaint(this.diamondEffect.makeShaderWithChildren([], [ramp], gradientLocal())); }
          finally { ramp.delete(); }
        } else {
          // Without shaders — approximate with a radial one.
          return shaderPaint(ck.Shader.MakeRadialGradient([0.5, 0.5], 0.5, colors, pos, ck.TileMode.Clamp, gradientLocal()));
        }
      }
      case 'GRADIENT_FREEFORM': {
        // Freeform gradient: color is the inverse-distance weighted average of the points (up to 16 points).
        const pts = (fp.freeform ?? []).slice(0, FREEFORM_MAX);
        if (!pts.length) { p.delete(); return null; }
        if (this.freeformEffect === undefined) this.freeformEffect = ck.RuntimeEffect?.Make(FREEFORM_SKSL) ?? null;
        if (!this.freeformEffect) {
          const n = pts.length;
          const avg = pts.reduce((a, q) => [a[0]! + q.color.r / n, a[1]! + q.color.g / n, a[2]! + q.color.b / n, a[3]! + q.color.a / n], [0, 0, 0, 0]);
          p.setColor(ck.Color4f(avg[0]!, avg[1]!, avg[2]!, avg[3]! * alpha));
          return p;
        }
        const big = Math.max(w, h, 1);
        const u = new Array<number>(1 + FREEFORM_MAX * 7).fill(0);
        u[0] = pts.length;
        pts.forEach((q, i) => {
          u[1 + i * 2] = q.x * w;
          u[2 + i * 2] = q.y * h;
          u.splice(1 + FREEFORM_MAX * 2 + i * 4, 4, q.color.r, q.color.g, q.color.b, q.color.a);
          u[1 + FREEFORM_MAX * 6 + i] = Math.max(0.02, q.spread ?? 0.5) * big;
        });
        return shaderPaint(this.freeformEffect.makeShader(u));
      }
      case 'GRADIENT_RADIAL': {
        const { colors, pos } = stops();
        return shaderPaint(ck.Shader.MakeRadialGradient([0.5, 0.5], 0.5, colors, pos, ck.TileMode.Clamp, gradientLocal()));
      }
      case 'GRADIENT_ANGULAR': {
        const { colors, pos } = stops();
        return shaderPaint(ck.Shader.MakeSweepGradient(0.5, 0.5, colors, pos, ck.TileMode.Clamp, gradientLocal()));
      }
      case 'IMAGE':
      case 'VIDEO': {
        if (!image) {
          p.delete();
          return null;
        }
        const { local, tile } = this.mediaPlacement(fp, w, h, image.width(), image.height());
        // Usually the image is already decoded at screen size — no mipmaps needed.
        const mip = this.images.mipmaps ? ck.MipmapMode.Linear : ck.MipmapMode.None;
        const shader = image.makeShaderOptions(tile, tile, ck.FilterMode.Linear, mip, local);
        if (!shader) { p.delete(); return null; }
        return shaderPaint(this.filteredImage(shader, fp.paintFilter));
      }
      default:
        p.delete();
        return null;
    }
  }

  /** Lottie paint: the frame (recording) as a shader per fill mode; the frame changes — the shader is per frame. */
  private lottiePaint(fp: FigPaint, w: number, h: number, alphaMul: number, nodeBlend?: string): Paint | null {
    const hash = hashToHex(fp.lottie?.hash);
    this.tracked?.add(hash);
    const clip = this.flags.images ? this.lotties?.clip(hash) : undefined;
    if (!clip) {
      this.placeholders++;
      return this.placeholder;
    }
    const speed = fp.lottie?.speed ?? 1;
    const t = this.lottieTime !== null ? this.lottieTime * speed : this.lotties?.time ? this.lotties.time(hash, fp, clip) : (performance.now() / 1000) * speed;
    const pic = this.lottiePicture(hash, clip, t);
    if (!pic) return null;
    this.lottieDrawn = true;
    const key = `${w}:${h}|${alphaMul}|${nodeBlend ?? ''}`;
    const prev = this.lottiePaints.get(fp);
    if (prev && prev.pic === pic && prev.key === key) return prev.paint;
    if (prev?.paint) {
      this.owned.delete(prev.paint);
      prev.paint.delete();
    }
    const alpha = (fp.opacity ?? 1) * alphaMul;
    let paint: Paint | null = null;
    if (fp.visible !== false && alpha > 0) {
      const ck = this.ck;
      const { local, tile } = this.mediaPlacement(fp, w, h, clip.width, clip.height);
      const shader = pic.makeShader(tile, tile, ck.FilterMode.Linear, local, ck.LTRBRect(0, 0, clip.width, clip.height));
      if (shader) {
        paint = new ck.Paint();
        paint.setAntiAlias(true);
        const paintBlend = fp.blendMode && !isNormalBlend(fp.blendMode) ? fp.blendMode : nodeBlend;
        paint.setBlendMode(this.blendMode(paintBlend));
        setShader(paint, shader);
        paint.setAlphaf(alpha);
        this.owned.add(paint);
      }
    }
    this.lottiePaints.set(fp, { pic, key, paint });
    return paint;
  }

  /** Matrix (and tiling) of an image, video or Lottie of size iw × ih in a w × h layer per fill mode. */
  private mediaPlacement(fp: FigPaint, w: number, h: number, iw: number, ih: number): { local: number[]; tile: TileMode } {
    const ck = this.ck;
    let local: number[];
    let tile = ck.TileMode.Decal;
    // Rotation by 90°·k: the image rotates around its center and is fitted already rotated.
    const quarter = fp.imageScaleMode === 'STRETCH' ? 0 : ((Math.round((fp.rotation ?? 0) / 90) % 4) + 4) % 4;
    const [rw, rh] = quarter % 2 ? [ih, iw] : [iw, ih];
    const rot: Matrix2D = [
      [1, 0, 0, 0, 1, 0],
      [0, -1, 0, 1, 0, 0],
      [-1, 0, 0, 0, -1, 0],
      [0, 1, 0, -1, 0, 0],
    ][quarter] as Matrix2D;
    /** An image of size s·(rw × rh) centered at point (cx, cy) of the layer. */
    const placed = (s: number, cx: number, cy: number) => toMat3(multiply([s, 0, cx, 0, s, cy], multiply(rot, [1, 0, -iw / 2, 0, 1, -ih / 2])));
    switch (fp.imageScaleMode) {
      case 'FIT': {
        const s = Math.min(w / rw, h / rh);
        local = placed(s, w / 2, h / 2);
        break;
      }
      case 'TILE': {
        const s = fp.scale ?? 1;
        local = quarter ? placed(s, (rw * s) / 2, (rh * s) / 2) : toMat3([s, 0, 0, 0, s, 0]);
        tile = ck.TileMode.Repeat;
        break;
      }
      case 'STRETCH': {
        const t: Matrix2D = fp.transform
          ? [fp.transform.m00, fp.transform.m01, fp.transform.m02, fp.transform.m10, fp.transform.m11, fp.transform.m12]
          : [1, 0, 0, 0, 1, 0];
        local = toMat3(multiply(multiply([w, 0, 0, 0, h, 0], invert(t)), [1 / iw, 0, 0, 0, 1 / ih, 0]));
        break;
      }
      default: {
        // FILL: like object-fit: cover
        const s = Math.max(w / rw, h / rh);
        local = quarter ? placed(s, w / 2, h / 2) : toMat3([s, 0, (w - iw * s) / 2, 0, s, (h - ih * s) / 2]);
      }
    }
    return { local, tile };
  }

  private fillGeometry(
    canvas: Canvas,
    n: SceneNode,
    paints: FigPaint[],
    geometry: SceneNode['fillGeometry'],
    fallbackRect: boolean,
    alphaMul = 1,
    nodeBlend?: string,
  ) {
    // Vector network regions with their own fills: each contour uses its own (in contour order).
    if (geometry.some((g) => g.fills)) {
      for (const g of geometry) {
        const path = this.path(g.blob, g.windingRule === 'EVENODD');
        if (!path) continue;
        for (const fp of g.fills ?? paints) {
          const p = this.getPaint(fp, n.size.x, n.size.y, alphaMul, nodeBlend);
          if (p) canvas.drawPath(path, p);
        }
      }
      return;
    }
    if (!paints.length) return;
    for (const fp of paints) {
      const p = this.getPaint(fp, n.size.x, n.size.y, alphaMul, nodeBlend);
      if (!p) continue;
      if (geometry.length) {
        for (const g of geometry) {
          const path = this.path(g.blob, g.windingRule === 'EVENODD');
          if (path) canvas.drawPath(path, p);
        }
      } else if (fallbackRect) {
        canvas.drawRect(this.ck.XYWHRect(0, 0, n.size.x, n.size.y), p);
      }
    }
  }

  private drawStrokes(canvas: Canvas, n: SceneNode) {
    if (n.strokeGeometry.length) {
      // A ready .fig stroke for “inside” and “outside” is a center stroke of double width (for vectors,
      // frames, instances): the node's shape clips it. Clipping doesn't change an already exact one (ellipses).
      const shape = n.strokeAlign ? this.shapeClip(n) : null;
      if (shape) {
        canvas.save();
        canvas.clipPath(shape, n.strokeAlign === 'INSIDE' ? this.ck.ClipOp.Intersect : this.ck.ClipOp.Difference, true);
      }
      this.fillGeometry(canvas, n, n.strokes, n.strokeGeometry, false);
      if (shape) canvas.restore();
      return;
    }
    const path = this.strokeOutline(n);
    if (!path) return;
    for (const fp of n.strokes) {
      const p = this.getPaint(fp, n.size.x, n.size.y, 1);
      if (p) canvas.drawPath(path, p);
    }
  }

  /** Node shape (union of fill outlines) — for clipping a ready stroke; null — no shape. */
  private shapeClip(n: SceneNode): Path | null {
    if (!n.fillGeometry.length) return null;
    const key = n.fillGeometry.map((g) => `${g.blob}${g.windingRule[0]}`).join(',');
    const cached = this.shapeClips.get(n);
    if (cached?.key === key) return cached.path;
    if (cached?.path) {
      this.owned.delete(cached.path);
      cached.path.delete();
    }
    let out: Path | null = null;
    for (const g of n.fillGeometry) {
      const p = this.path(g.blob, g.windingRule === 'EVENODD');
      if (!p) continue;
      if (!out) out = p.copy();
      else {
        const u = this.ck.Path.MakeFromOp(out, p, this.ck.PathOp.Union);
        out.delete();
        out = u;
      }
    }
    if (out) this.owned.add(out);
    this.shapeClips.set(n, { key, path: out });
    return out;
  }

  /**
   * Outline of our own stroke (cached per node): the node's shape thickened by the stroke width;
   * inside — intersection with the shape, outside — difference (Skia PathOps).
   */
  private strokeOutline(n: SceneNode): Path | undefined {
    const s = n.strokeStyle;
    if (!s || n.strokeGeometry.length) return undefined;
    const source = n.strokeSource?.length ? n.strokeSource : n.fillGeometry;
    const key = JSON.stringify([s, n.size, source.map((g) => g.blob)]);
    const cached = this.strokeOutlines.get(n);
    if (cached?.key === key) return cached.path ?? undefined;
    if (cached?.path) {
      this.owned.delete(cached.path);
      cached.path.delete();
    }
    const out = this.buildStrokeOutline(n, s, source);
    if (out) this.owned.add(out);
    this.strokeOutlines.set(n, { key, path: out });
    return out ?? undefined;
  }

  private buildStrokeOutline(n: SceneNode, s: NonNullable<SceneNode['strokeStyle']>, source: SceneNode['fillGeometry']): Path | null {
    const ck = this.ck;
    // Per-side widths — only for rectangular nodes.
    if (s.sides && RECT_LIKE.has(n.type)) return sideStrokePath(ck, n.size.x, n.size.y, s.sides, s.radii ?? [0, 0, 0, 0], s.align);
    let base: Path | undefined;
    if (n.type === 'LINE') {
      const b = new ck.PathBuilder();
      b.moveTo(0, 0);
      b.lineTo(n.size.x, 0);
      base = b.detachAndDelete();
    } else if (source.length) {
      const b = new ck.PathBuilder();
      for (const g of source) {
        const p = this.path(g.blob, g.windingRule === 'EVENODD');
        if (p) b.addPath(p);
      }
      b.setFillType(source[0]!.windingRule === 'EVENODD' ? ck.FillType.EvenOdd : ck.FillType.Winding);
      base = b.detachAndDelete();
    } else {
      // Without its own shape (e.g. a group) no border is drawn.
      if (!RECT_LIKE.has(n.type)) return null;
      const b = new ck.PathBuilder();
      b.addRect(ck.XYWHRect(0, 0, n.size.x, n.size.y));
      base = b.detachAndDelete();
    }
    // Path trim: only part of the path is stroked — fractions of the total length. If the start is
    // not before the end — no stroke.
    if (s.trim) {
      const [a, b] = s.trim;
      const cut = b - a <= 1e-4 ? null : base.makeTrimmed(Math.max(0, a), Math.min(1, b), false);
      base.delete();
      if (!cut) return null;
      base = cut;
    }
    // Variable width — along the centerline (width points); otherwise — a regular stroke.
    // “Inside” and “outside” for a vector with centerlines are relative to the fill regions.
    // Brush — along the centerline (over variable width and stroke position).
    const out = s.brush
      ? brushStrokePath(ck, base, s)
      : s.widths?.length
        ? variableStrokePath(ck, base, s)
        : strokePath(ck, base, s, n.type !== 'LINE', n.strokeSource?.length ? this.shapeClip(n) : null);
    base.delete();
    return out;
  }

  /**
   * Node stroke outline for “Outline stroke” (Ctrl+Shift+O): SVG path moved to the origin,
   * its bounds in node coordinates, and the fill rule.
   */
  strokeOutlineSvg(n: SceneNode): { svg: string; x: number; y: number; width: number; height: number; windingRule: 'NONZERO' | 'EVENODD' } | null {
    const ck = this.ck;
    let path: Path | null = null;
    let own = false;
    if (n.strokeGeometry.length) {
      path = this.importedStroke(n);
      own = true;
    } else path = this.strokeOutline(n) ?? null;
    if (!path) return null;
    const r = path.computeTightBounds();
    const evenOdd = path.getFillType() === ck.FillType.EvenOdd;
    const b = new ck.PathBuilder();
    b.addPath(path, [1, 0, -r[0]!, 0, 1, -r[1]!, 0, 0, 1]);
    const moved = b.detachAndDelete();
    const svg = moved.toSVGString();
    moved.delete();
    if (own) path.delete();
    if (!svg) return null;
    return { svg, x: r[0]!, y: r[1]!, width: r[2]! - r[0]!, height: r[3]! - r[1]!, windingRule: evenOdd ? 'EVENODD' : 'NONZERO' };
  }

  /**
   * Boolean operation result (SVG path in node coordinates): operands are sets of contours
   * from the geometry table with matrices. Subtraction is from the first (bottom) operand.
   */
  booleanSvg(op: 'UNION' | 'INTERSECT' | 'SUBTRACT' | 'EXCLUDE', operands: { blob: number; evenOdd: boolean; m: Matrix2D }[][]): string | null {
    const ck = this.ck;
    const kind = { UNION: ck.PathOp.Union, INTERSECT: ck.PathOp.Intersect, SUBTRACT: ck.PathOp.Difference, EXCLUDE: ck.PathOp.XOR }[op];
    const shape = (parts: { blob: number; evenOdd: boolean; m: Matrix2D }[]) => {
      // Parts of one operand are unioned (each may have its own fill rule).
      let acc: Path | null = null;
      for (const part of parts) {
        const src = this.path(part.blob, part.evenOdd);
        if (!src) continue;
        const b = new ck.PathBuilder();
        b.addPath(src, toMat3(part.m));
        b.setFillType(part.evenOdd ? ck.FillType.EvenOdd : ck.FillType.Winding);
        const p = b.detachAndDelete();
        if (!acc) acc = p;
        else {
          const u: Path | null = ck.Path.MakeFromOp(acc, p, ck.PathOp.Union);
          acc.delete();
          p.delete();
          acc = u;
        }
      }
      return acc;
    };
    let acc: Path | null = null;
    for (const parts of operands) {
      const p = shape(parts);
      if (!p) continue;
      if (!acc) {
        acc = p;
        continue;
      }
      const next: Path | null = ck.Path.MakeFromOp(acc, p, kind);
      acc.delete();
      p.delete();
      acc = next;
      if (!acc) return null;
    }
    const svg = acc ? acc.toSVGString() : null;
    acc?.delete();
    return svg;
  }

  /** For export: text outlines per fill set (SVG path, node coordinates). */
  textRunsSvg(n: SceneNode): { fills: FigPaint[] | undefined; d: string }[] {
    return this.textRuns(n).map((r) => ({ fills: r.fills, d: r.path.toSVGString() }));
  }

  /** For export: stroke outline (our own — built, imported — ready-made). */
  strokeSvg(n: SceneNode): string | null {
    if (n.strokeGeometry.length) {
      const p = this.importedStroke(n);
      const svg = p?.toSVGString() || null;
      p?.delete();
      return svg;
    }
    return this.strokeOutline(n)?.toSVGString() ?? null;
  }

  /**
   * A ready .fig stroke as a single outline; for “inside” and “outside” — clipped by the node's shape
   * (in the file it is a center stroke of double width). The caller deletes the path.
   */
  private importedStroke(n: SceneNode): Path | null {
    const ck = this.ck;
    const b = new ck.PathBuilder();
    for (const g of n.strokeGeometry) {
      const p = this.path(g.blob, g.windingRule === 'EVENODD');
      if (p) b.addPath(p);
    }
    if (n.strokeGeometry[0]?.windingRule === 'EVENODD') b.setFillType(ck.FillType.EvenOdd);
    const raw = b.detachAndDelete();
    const shape = n.strokeAlign ? this.shapeClip(n) : null;
    if (!shape) return raw;
    const out = ck.Path.MakeFromOp(raw, shape, n.strokeAlign === 'INSIDE' ? ck.PathOp.Intersect : ck.PathOp.Difference);
    raw.delete();
    return out;
  }

  /** For export: lines of text laid out by the renderer (null — fonts are still loading). */
  paragraphLines(n: SceneNode): { text: string; x: number; baseline: number; start: number; end: number; marker?: boolean }[] | null {
    const t = n.textLayout;
    if (!t || !this.fonts) return null;
    const layout = layoutText(this.ck, this.fonts, { ...t, color: { r: 0, g: 0, b: 0, a: 1 }, width: t.autoWidth ? undefined : n.size.x, height: t.autoWidth ? undefined : n.size.y });
    const y0 = t.alignV === 'TOP' ? 0 : (n.size.y - layout.height) * (t.alignV === 'CENTER' ? 0.5 : 1);
    const text = t.characters;
    const lines: { text: string; x: number; baseline: number; start: number; end: number; marker?: boolean }[] = layout.lines().map((m) => ({ text: text.slice(m.start, m.endText), x: m.x, baseline: y0 + m.baseline, start: m.start, end: m.endText }));
    // List markers — as lines with the style of the item's first character.
    for (const k of layout.markers()) lines.push({ text: k.text, x: k.x, baseline: y0 + k.baseline, start: k.start, end: k.start, marker: true });
    layout.delete();
    return lines;
  }

  /** Node text layout as drawn (for editing on the canvas); null — no fonts. The caller calls delete(). */
  textLayoutFor(n: SceneNode): { layout: TextLayout; y: number } | null {
    const t = n.textLayout;
    if (!t || !this.fonts) return null;
    const layout = layoutText(this.ck, this.fonts, { ...t, color: { r: 0, g: 0, b: 0, a: 1 }, width: t.autoWidth ? undefined : n.size.x, height: t.autoWidth ? undefined : n.size.y });
    const y = t.alignV === 'TOP' ? 0 : (n.size.y - layout.height) * (t.alignV === 'CENTER' ? 0.5 : 1);
    return { layout, y };
  }

  /** Collects text glyphs into paths (one per fill set) in node coordinates. */
  private textRuns(n: SceneNode) {
    let runs = this.textPaths.get(n);
    if (runs) return runs;
    const builders = new Map<FigPaint[] | undefined, InstanceType<CanvasKit['PathBuilder']>>();
    for (const g of n.glyphs ?? []) {
      const glyph = this.path(g.blob, false);
      if (!glyph) continue;
      let b = builders.get(g.fills);
      if (!b) builders.set(g.fills, (b = new this.ck.PathBuilder()));
      // Glyph outlines are in em units with the Y axis up.
      b.addPath(glyph, [g.fontSize, 0, g.x, 0, -g.fontSize, g.y, 0, 0, 1]);
    }
    runs = [];
    for (const [fills, b] of builders) {
      const path = b.detachAndDelete();
      this.owned.add(path);
      runs.push({ fills, path });
    }
    this.textPaths.set(n, runs);
    return runs;
  }

  private drawText(canvas: Canvas, n: SceneNode, alphaMul = 1, nodeBlend?: string) {
    for (const run of this.textRuns(n)) {
      for (const fp of run.fills ?? n.fills) {
        const p = this.getPaint(fp, n.size.x, n.size.y, alphaMul, nodeBlend);
        if (p) canvas.drawPath(run.path, p);
      }
    }
  }

  private drawOwn(canvas: Canvas, n: SceneNode, alphaMul = 1, nodeBlend?: string) {
    // If there is no ready geometry, rectangular nodes draw a rectangle of their size.
    if (n.type === 'TEXT') {
      if (!this.flags.text) return;
      if (n.glyphs) this.drawText(canvas, n, alphaMul, nodeBlend);
      else if (n.textLayout) this.drawParagraph(canvas, n, alphaMul);
    } else {
      this.fillGeometry(canvas, n, n.fills, n.fillGeometry, RECT_LIKE.has(n.type), alphaMul, nodeBlend);
    }
  }

  /** Text laid out by the renderer (Paragraph): color is the first visible solid fill. */
  private drawParagraph(canvas: Canvas, n: SceneNode, alphaMul: number, colorOverride?: { r: number; g: number; b: number; a: number }) {
    const t = n.textLayout;
    if (!t || !this.fonts) return;
    // Fonts not loaded yet — request them; once loaded, the editor re-lays out and redraws the text.
    for (const r of t.runs ?? [{ family: t.family, style: t.style }]) {
      const font = { family: r.family, style: r.style };
      if (!this.fonts.has(font)) void this.fonts.ensure(font);
    }
    // Color of runs without their own — the node's first visible solid fill (for a gradient — the first stop).
    const fill = n.fills.find((f) => f.visible !== false && f.type !== 'IMAGE');
    const c = fill?.type === 'SOLID' ? fill.color : fill?.stops?.[0]?.color;
    const color = { r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: (c?.a ?? 1) * (fill ? (fill.opacity ?? 1) : 1) };
    // Text on a path — a single line (no wrapping to the frame width).
    const width = t.autoWidth || n.textPath ? undefined : n.size.x;
    const height = t.autoWidth || n.textPath ? undefined : n.size.y;
    const key = JSON.stringify([t, width, height, color, alphaMul, colorOverride, this.fonts.version]);
    let cached = this.paragraphs.get(n);
    if (!cached || cached.key !== key) {
      cached?.p.delete();
      cached = { key, p: layoutText(this.ck, this.fonts, { ...t, color, alpha: alphaMul, override: colorOverride, width, height }) };
      this.paragraphs.set(n, cached);
    }
    if (n.textPath) return this.drawPathText(canvas, n, cached.p);
    // Vertical alignment inside a fixed-size box.
    const y = t.alignV === 'TOP' ? 0 : (n.size.y - cached.p.height) * (t.alignV === 'CENTER' ? 0.5 : 1);
    if (n.textAnim) return this.drawAnimatedText(canvas, n, cached.p, y);
    cached.p.draw(canvas, 0, y);
  }

  /**
   * Text animation: pieces (letters, words, lines) — by their rectangles; fully appeared ones —
   * in one pass under a shared clip, appearing ones — one by one with their own opacity and offset.
   */
  private drawAnimatedText(canvas: Canvas, n: SceneNode, layout: TextLayout, y: number) {
    const a = n.textAnim!;
    const ck = this.ck;
    const text = n.textLayout!.characters;
    const units: [number, number][] =
      a.by === 'LINE'
        ? layout.lines().map((l) => [l.start, l.end] as [number, number])
        : a.by === 'WORD'
          ? [...text.matchAll(/\S+/g)].map((m) => [m.index!, m.index! + m[0].length] as [number, number])
          : graphemes(text).filter(([s0, e0]) => text.slice(s0, e0).trim());
    const anim = a as unknown as TextAnimation;
    const full = new ck.PathBuilder();
    let anyFull = false;
    const partial: { rects: [number, number, number, number][]; p: number }[] = [];
    units.forEach(([s0, e0], i) => {
      const p = textUnitProgress(anim, i, a.time);
      if (p <= 0) return;
      const rects = layout.rects(s0, e0);
      if (p >= 1) {
        for (const r of rects) full.addRect(ck.LTRBRect(r[0], r[1] + y, r[2], r[3] + y));
        anyFull = anyFull || rects.length > 0;
      } else partial.push({ rects, p });
    });
    const path = full.detach();
    full.delete();
    if (anyFull) {
      canvas.save();
      canvas.clipPath(path, ck.ClipOp.Intersect, true);
      layout.draw(canvas, 0, y);
      canvas.restore();
    }
    path.delete();
    for (const { rects, p } of partial) {
      if (!rects.length) continue;
      const x0 = Math.min(...rects.map((r) => r[0]));
      const y0 = Math.min(...rects.map((r) => r[1])) + y;
      const x1 = Math.max(...rects.map((r) => r[2]));
      const y1 = Math.max(...rects.map((r) => r[3])) + y;
      const h = y1 - y0;
      canvas.save();
      if (a.effect === 'RISE') canvas.translate(0, (1 - p) * h * 0.6);
      else if (a.effect === 'DROP') canvas.translate(0, -(1 - p) * h * 0.6);
      else if (a.effect === 'SCALE') {
        const k = 0.4 + 0.6 * p;
        canvas.translate((x0 + x1) / 2, (y0 + y1) / 2);
        canvas.scale(k, k);
        canvas.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      }
      const b = new ck.PathBuilder();
      for (const r of rects) b.addRect(ck.LTRBRect(r[0], r[1] + y, r[2], r[3] + y));
      const clip = b.detach();
      b.delete();
      canvas.clipPath(clip, ck.ClipOp.Intersect, true);
      clip.delete();
      this.layerPaint.setAlphaf(Math.max(0, Math.min(1, p)));
      this.layerPaint.setBlendMode(ck.BlendMode.SrcOver);
      this.layerPaint.setImageFilter(null);
      canvas.saveLayer(this.layerPaint, ck.LTRBRect(x0 - 2, y0 - 2, x1 + 2, y1 + 2));
      layout.draw(canvas, 0, y);
      canvas.restore();
      canvas.restore();
    }
  }

  /** Path for text on a path (cached per node: string → path). */
  private pathMaps = new WeakMap<SceneNode, { key: string; map: PathTextMap }>();

  /** “Line ↔ path” map for text on a path (for drawing and editing on the canvas). */
  pathTextMap(n: SceneNode, layout: TextLayout): PathTextMap | null {
    const tp = n.textPath;
    if (!tp) return null;
    const baseline = layout.lines()[0]?.baseline ?? 0;
    const align = n.textLayout?.align ?? 'LEFT';
    const key = JSON.stringify([tp, layout.width, baseline, align]);
    const cached = this.pathMaps.get(n);
    if (cached?.key === key) return cached.map;
    cached?.map.delete();
    const map = new PathTextMap(this.ck, tp.data, tp.offset, layout.width, align, baseline, tp.sx, tp.sy);
    this.pathMaps.set(n, { key, map });
    return map;
  }

  /**
   * Point (node coordinates) on a line of text on a path. null — the text hasn't been laid out yet
   * (not drawn): then hit testing uses the bounds.
   */
  insidePathText(n: SceneNode, x: number, y: number, tol = 0): boolean | null {
    const layout = this.paragraphs.get(n)?.p;
    if (!layout) return null;
    const map = this.pathTextMap(n, layout);
    if (!map?.ok) return false;
    const [s, d] = map.fromLocal(x, y);
    return s >= -tol && s <= layout.width + tol && d >= -tol && d <= layout.height + tol;
  }

  /** Text on a path: each character at its place on the path, rotated along the tangent. */
  private drawPathText(canvas: Canvas, n: SceneNode, layout: TextLayout) {
    const map = this.pathTextMap(n, layout);
    if (!map?.ok) return;
    const text = n.textLayout?.characters ?? '';
    for (const line of layout.lines()) {
      for (const [a, b] of graphemes(text.slice(line.start, line.end))) {
        const rect = layout.rects(line.start + a, line.start + b)[0];
        if (!rect) continue;
        const [x0, y0, x1, y1] = rect;
        const cx = (x0 + x1) / 2;
        const [px, py, angle] = map.toLocal(cx, line.baseline);
        const pad = (y1 - y0) * 0.3;
        canvas.save();
        canvas.translate(px, py);
        canvas.rotate((angle * 180) / Math.PI, 0, 0);
        canvas.translate(-cx, -line.baseline);
        canvas.clipRect(this.ck.LTRBRect(x0 - pad * 0.5, y0 - pad, x1 + pad * 0.5, y1 + pad), this.ck.ClipOp.Intersect, true);
        layout.draw(canvas, 0, 0);
        canvas.restore();
      }
    }
  }

  /** How many separate draws a childless node has — if one, opacity can be given to the paint. */
  private isSingleDrawLeaf(n: SceneNode): boolean {
    if (n.children.length) return false;
    const visibleStrokes = n.strokeGeometry.length || n.strokeStyle ? n.strokes.filter((p) => p.visible !== false).length : 0;
    const visibleFills = n.fills.filter((p) => p.visible !== false).length;
    if (n.type === 'TEXT') return visibleStrokes === 0 && visibleFills <= 1;
    const geometry = Math.max(1, n.fillGeometry.length);
    return visibleStrokes === 0 && visibleFills * geometry <= 1;
  }

  private blurFilter(e: FigEffect, tile: boolean, n?: SceneNode): ImageFilter {
    if (e.blurOpType === 'PROGRESSIVE' && n) return this.progressiveFilter(e, n, tile);
    let f = this.filters.get(e);
    if (!f) {
      const sigma = (e.radius ?? 0) / 2;
      f = this.ck.ImageFilter.MakeBlur(sigma, sigma, tile ? this.ck.TileMode.Clamp : this.ck.TileMode.Decal, null);
      this.filters.set(e, f);
      this.owned.add(f);
    }
    return f;
  }

  /**
   * Progressive blur in one filter: blur levels from startRadius to radius, each with a weight
   * along the gradient from start to end (triangles summing to 1); levels are added (Plus).
   * Before the start — startRadius, after the end — radius. The same filter blurs the background under the layer.
   */
  private progressiveFilter(e: FigEffect, n: SceneNode, tile: boolean): ImageFilter {
    const key = `${n.size.x}|${n.size.y}|${tile}`;
    const cached = this.sizedFilters.get(e);
    if (cached?.key === key) return cached.f;
    if (cached) {
      this.owned.delete(cached.f);
      cached.f.delete();
    }
    const ck = this.ck;
    const r0 = Math.max(0, e.startRadius ?? 0);
    const r1 = Math.max(0, e.radius ?? 0);
    const p0 = [(e.startOffset?.x ?? 0.5) * n.size.x, (e.startOffset?.y ?? 0) * n.size.y];
    const p1 = [(e.endOffset?.x ?? 0.5) * n.size.x, (e.endOffset?.y ?? 1) * n.size.y];
    if (Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!) < 1e-3) p1[1] = p0[1]! + 1;
    const levels = Math.max(2, Math.min(8, Math.ceil(Math.abs(r1 - r0) / 4) + 1));
    const clear = ck.Color4f(1, 1, 1, 0);
    const solid = ck.Color4f(1, 1, 1, 1);
    let sum: ImageFilter | null = null;
    for (let i = 0; i < levels; i++) {
      const t = i / (levels - 1);
      const sigma = (r0 + (r1 - r0) * t) / 2;
      const blur = sigma > 0.01 ? ck.ImageFilter.MakeBlur(sigma, sigma, tile ? ck.TileMode.Clamp : ck.TileMode.Decal, null) : null;
      const colors: Float32Array[] = [];
      const pos: number[] = [];
      if (i > 0) colors.push(clear), pos.push((i - 1) / (levels - 1));
      colors.push(solid), pos.push(t);
      if (i < levels - 1) colors.push(clear), pos.push((i + 1) / (levels - 1));
      const shader = ck.Shader.MakeLinearGradient(p0, p1, colors, pos, ck.TileMode.Clamp);
      const mask = ck.ImageFilter.MakeShader(shader);
      shader.delete();
      const level = ck.ImageFilter.MakeBlend(ck.BlendMode.DstIn, blur, mask);
      blur?.delete();
      mask.delete();
      if (sum) {
        const next = ck.ImageFilter.MakeBlend(ck.BlendMode.Plus, sum, level);
        sum.delete();
        level.delete();
        sum = next;
      } else sum = level;
    }
    this.sizedFilters.set(e, { key, f: sum! });
    this.owned.add(sum!);
    return sum!;
  }

  /** Texture (GRAIN): the layer's content is displaced by a random map — edges and fill become “grainy”. */
  private textureFilter(e: FigEffect): ImageFilter | null {
    const ck = this.ck;
    let f = this.filters.get(e);
    if (f) return f;
    if (this.grainEffect === undefined) this.grainEffect = ck.RuntimeEffect?.Make(GRAIN_SKSL) ?? null;
    if (!this.grainEffect) return null;
    const cell = Math.max(0.5, e.noiseSize?.x ?? 1);
    const shader = this.grainEffect.makeShader([e.seed ?? 0, cell, cell]);
    const map = ck.ImageFilter.MakeShader(shader);
    shader.delete();
    f = ck.ImageFilter.MakeDisplacementMap(ck.ColorChannel.Red, ck.ColorChannel.Green, (e.radius ?? 0) * 2, map, null);
    map.delete();
    this.filters.set(e, f);
    this.owned.add(f);
    return f;
  }

  /**
   * Shape corner radius for glass: an ellipse — half the shorter side; otherwise — where the diagonal
   * from the bounds' corner enters the shape (for corner radius r this is r·(1 − 1/√2)).
   */
  private glassRadius(n: SceneNode): number {
    const cached = this.glassRadii.get(n);
    if (cached !== undefined) return cached;
    const half = Math.min(n.size.x, n.size.y) / 2;
    let r = 0;
    const g = n.fillGeometry[0];
    const path = g ? this.path(g.blob, g.windingRule === 'EVENODD') : undefined;
    if (n.type === 'ELLIPSE') r = half;
    else if (path) {
      const step = Math.max(0.25, half / 200);
      for (let t = 0; t < half; t += step) {
        if (path.contains(t + 0.01, t + 0.01)) {
          r = Math.min(half, t / (1 - Math.SQRT1_2));
          break;
        }
      }
    }
    this.glassRadii.set(n, r);
    return r;
  }

  /** Glass: the background under the layer — frost, refraction at the edges and color dispersion (background filter). */
  private glassFilter(e: FigEffect, n: SceneNode): ImageFilter | null {
    const ck = this.ck;
    const key = `${n.size.x}|${n.size.y}|glass`;
    const cached = this.sizedFilters.get(e);
    if (cached?.key === key) return cached.f;
    if (cached) {
      this.owned.delete(cached.f);
      cached.f.delete();
    }
    if (this.glassEffect === undefined) this.glassEffect = ck.RuntimeEffect?.Make(GLASS_SKSL) ?? null;
    const frostR = Math.max(0, e.radius ?? 0);
    const frost = frostR > 0.01 ? ck.ImageFilter.MakeBlur(frostR / 2, frostR / 2, ck.TileMode.Clamp, null) : null;
    const depth = Math.max(0, e.refractionRadius ?? 20);
    const shift = Math.max(0, e.refractionIntensity ?? 0.5) * depth;
    let out: ImageFilter | null = frost;
    if (this.glassEffect && shift > 0.25) {
      const shader = this.glassEffect.makeShader([n.size.x, n.size.y, this.glassRadius(n), depth, 0, 0, 0, 0]);
      const map = ck.ImageFilter.MakeShader(shader);
      shader.delete();
      const bend = (scale: number) => ck.ImageFilter.MakeDisplacementMap(ck.ColorChannel.Red, ck.ColorChannel.Green, scale, map, frost);
      const spread = Math.max(0, Math.min(1, e.chromaticAberration ?? 0)) * 0.5;
      if (spread < 0.005) out = bend(shift * 2);
      else {
        // Color dispersion: channels are shifted differently and added (alpha — saturating).
        const only = (k: number, input: ImageFilter) => {
          const m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
          m[k * 6] = 1;
          const cf = ck.ColorFilter.MakeMatrix(m);
          const f = ck.ImageFilter.MakeColorFilter(cf, input);
          cf.delete();
          input.delete();
          return f;
        };
        const red = only(0, bend(shift * 2 * (1 + spread)));
        const green = only(1, bend(shift * 2));
        const blue = only(2, bend(shift * 2 * (1 - spread)));
        const rg = ck.ImageFilter.MakeBlend(ck.BlendMode.Plus, red, green);
        out = ck.ImageFilter.MakeBlend(ck.BlendMode.Plus, rg, blue);
        red.delete();
        green.delete();
        blue.delete();
        rg.delete();
      }
      map.delete();
      if (frost && out !== frost) frost.delete();
    }
    if (out) {
      this.sizedFilters.set(e, { key, f: out });
      this.owned.add(out);
    }
    return out;
  }

  /** Glass: refracted background in the layer's shape and a highlight toward the light (layer fills on top, as usual). */
  private drawGlass(canvas: Canvas, n: SceneNode, e: FigEffect) {
    const ck = this.ck;
    canvas.save();
    this.clipToShape(canvas, n);
    const filter = this.glassFilter(e, n);
    if (filter) {
      canvas.saveLayer(undefined, [0, 0, n.size.x, n.size.y], filter);
      canvas.restore();
    }
    const intensity = Math.max(0, Math.min(1, e.specularIntensity ?? 0.5));
    if (this.glassEffect && intensity > 0.005) {
      const a = ((e.specularAngle ?? -45) * Math.PI) / 180;
      const shader = this.glassEffect.makeShader([n.size.x, n.size.y, this.glassRadius(n), Math.max(2, Math.min(n.size.x, n.size.y) * 0.15), 1, Math.cos(a), Math.sin(a), intensity]);
      const p = new ck.Paint();
      setShader(p, shader);
      p.setBlendMode(ck.BlendMode.Plus);
      canvas.drawRect(ck.XYWHRect(0, 0, n.size.x, n.size.y), p);
      p.delete();
    }
    canvas.restore();
  }

  /** Noise (NOISE) over the node drawn in a layer: grains only where the layer is opaque. */
  private drawNoise(canvas: Canvas, n: SceneNode, e: FigEffect) {
    const ck = this.ck;
    if (this.noiseEffect === undefined) this.noiseEffect = ck.RuntimeEffect?.Make(NOISE_SKSL) ?? null;
    if (!this.noiseEffect) return;
    const cell = Math.max(0.5, e.noiseSize?.x ?? 1);
    const kind = e.noiseType === 'DUOTONE' ? 1 : e.noiseType === 'MULTITONE' ? 2 : 0;
    const c1 = e.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
    const c2 = e.secondaryColor ?? { r: 1, g: 1, b: 1, a: 0.25 };
    const shader = this.noiseEffect.makeShader([e.seed ?? 0, cell, cell, e.density ?? 0.5, kind, c1.r, c1.g, c1.b, c1.a ?? 1, c2.r, c2.g, c2.b, c2.a ?? 1, e.opacity ?? 1]);
    const bounds = this.localBounds(n);
    // A copy of the drawn layer, noise with blend mode, back — only over opaque areas (SrcATop).
    const top = new ck.Paint();
    top.setBlendMode(ck.BlendMode.SrcATop);
    canvas.saveLayer(top, bounds, null, ck.SaveLayerInitWithPrevious);
    const p = new ck.Paint();
    setShader(p, shader);
    p.setBlendMode(this.blendMode(e.blendMode));
    canvas.drawRect(bounds, p);
    canvas.restore();
    p.delete();
    top.delete();
  }

  /**
   * Shadow by the node's shape via a mask filter — without a separate layer. Returns false if not possible.
   * A shape's shadow follows its shape at full strength, even with a semi-transparent fill
   * (glass card); for an image (PNG with transparency) — by alpha, via a layer.
   */
  private fastShadow(canvas: Canvas, n: SceneNode, e: FigEffect): boolean {
    const opaque = (f: FigPaint) =>
      (f.opacity ?? 1) >= 0.999 &&
      (f.type === 'SOLID' ? (f.color?.a ?? 1) >= 0.999 : f.type?.startsWith('GRADIENT') ? (f.stops ?? []).every((s) => s.color.a >= 0.999) : false);
    const visible = n.fills.filter((f) => f.visible !== false && (f.opacity ?? 1) > 0);
    const shape = n.type !== 'TEXT' && (n.children.length === 0 || n.clipsContent) && visible.length > 0 && !visible.some((f) => f.type === 'IMAGE');
    if (!shape) return false;
    // Under an opaque fill the shadow isn't visible anyway; under a semi-transparent one — cut out by shape
    // (by default the shadow is only outside the layer).
    const cut = e.showShadowBehindNode !== true && !visible.some(opaque);
    const ck = this.ck;
    let p = this.shadowPaints.get(e);
    if (!p) {
      const c = e.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
      const sigma = (e.radius ?? 0) / 2;
      p = new ck.Paint();
      p.setAntiAlias(true);
      p.setColor(ck.Color4f(c.r, c.g, c.b, c.a));
      p.setBlendMode(this.blendMode(e.blendMode));
      // respectCTM: radius in node coordinates, at any scale.
      if (sigma > 0) p.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, sigma, true));
      this.shadowPaints.set(e, p);
      this.owned.add(p);
    }
    canvas.save();
    if (cut) this.clipToShape(canvas, n, ck.ClipOp.Difference);
    canvas.translate(e.offset?.x ?? 0, e.offset?.y ?? 0);
    const spread = e.spread ? this.spreadPath(n, e.spread) : undefined;
    if (spread) canvas.drawPath(spread, p);
    else if (n.fillGeometry.length) {
      for (const g of n.fillGeometry) {
        const path = this.path(g.blob, g.windingRule === 'EVENODD');
        if (path) canvas.drawPath(path, p);
      }
    } else {
      canvas.drawRect(ck.XYWHRect(0, 0, n.size.x, n.size.y), p);
    }
    canvas.restore();
    return true;
  }

  /**
   * Shape expanded by spread (shadow with spread): shape ∪ its stroke of width 2·spread;
   * negative — shrunk: shape minus stroke.
   */
  private spreadPath(n: SceneNode, spread: number): Path | undefined {
    const key = JSON.stringify([spread, n.size, n.fillGeometry.map((g) => g.blob)]);
    const cached = this.spreadPaths.get(n);
    if (cached?.key === key) return cached.path ?? undefined;
    if (cached?.path) {
      this.owned.delete(cached.path);
      cached.path.delete();
    }
    const ck = this.ck;
    const g = n.fillGeometry[0];
    let base = g ? this.path(g.blob, g.windingRule === 'EVENODD')?.copy() : undefined;
    if (!base) {
      const b = new ck.PathBuilder();
      b.addRect(ck.XYWHRect(0, 0, n.size.x, n.size.y));
      base = b.detachAndDelete();
    }
    const stroked = base.makeStroked({ width: 2 * Math.abs(spread), join: ck.StrokeJoin.Miter, miter_limit: 4 });
    const out = stroked ? ck.Path.MakeFromOp(base, stroked, spread > 0 ? ck.PathOp.Union : ck.PathOp.Difference) : null;
    stroked?.delete();
    base.delete();
    if (out) this.owned.add(out);
    this.spreadPaths.set(n, { key, path: out });
    return out ?? undefined;
  }

  /**
   * Inner shadow: fill the inside of the shape with the shadow color and “knock out” the blurred shape
   * shifted by offset — a soft shadow remains along the edges (no path operations).
   */
  private innerShadow(canvas: Canvas, n: SceneNode, e: FigEffect) {
    if (n.type === 'TEXT' || (!n.fillGeometry.length && !RECT_LIKE.has(n.type))) return;
    const ck = this.ck;
    let paints = this.innerPaints.get(e);
    if (!paints) {
      const c = e.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
      const sigma = (e.radius ?? 0) / 2;
      const fill = new ck.Paint();
      fill.setColor(ck.Color4f(c.r, c.g, c.b, c.a));
      const hole = new ck.Paint();
      hole.setAntiAlias(true);
      hole.setBlendMode(ck.BlendMode.DstOut);
      if (sigma > 0) hole.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, sigma, true));
      const layer = new ck.Paint();
      layer.setBlendMode(this.blendMode(e.blendMode));
      paints = { fill, hole, layer };
      this.innerPaints.set(e, paints);
      this.owned.add(fill);
      this.owned.add(hole);
      this.owned.add(layer);
    }
    canvas.save();
    this.clipToShape(canvas, n);
    canvas.saveLayer(paints.layer, this.localBounds(n));
    canvas.drawPaint(paints.fill);
    canvas.translate(e.offset?.x ?? 0, e.offset?.y ?? 0);
    const spread = e.spread ? this.spreadPath(n, -e.spread) : undefined;
    if (spread) canvas.drawPath(spread, paints.hole);
    else if (n.fillGeometry.length) {
      for (const g of n.fillGeometry) {
        const path = this.path(g.blob, g.windingRule === 'EVENODD');
        if (path) canvas.drawPath(path, paints.hole);
      }
    } else canvas.drawRect(ck.XYWHRect(0, 0, n.size.x, n.size.y), paints.hole);
    canvas.restore();
    canvas.restore();
  }

  /** Record the layer without its outer transform/opacity, then compose input shaders in order. */
  private drawShaderEffects(canvas: Canvas, n: SceneNode, effects: FigEffect[]) {
    const ck = this.ck;
    const rect = this.localBounds(n);
    const recorder = new ck.PictureRecorder();
    let picture: SkPicture | undefined;
    let shader: Shader | undefined;
    const paint = new ck.Paint();
    const oldPixel = this.pixel;
    try {
      const target = recorder.beginRecording(rect);
      this.pixel = 1e-3;
      this.drawNode(target, n, EVERYWHERE, true);
      picture = recorder.finishRecordingAsPicture();
      shader = picture.makeShader(ck.TileMode.Decal, ck.TileMode.Decal, ck.FilterMode.Linear, undefined, rect);
      for (const e of effects) {
        const sh = e.shader;
        if (!sh || shaderContractError(sh.code, 'effect')) continue;
        const { effect } = this.shaderEffect(sh.code);
        if (!effect) continue; // Invalid code keeps the input visible.
        const uniforms = new Float32Array(effect.getUniformFloatCount());
        for (let i = 0; i < effect.getUniformCount(); i++) {
          const name = effect.getUniformName(i);
          const u = effect.getUniform(i);
          const value = name === 'size' ? [n.size.x, n.size.y] : name === 'time' ? [sh.animate ? this.time : 0] : sh.params[name] ?? DEFAULTS(sh.code)[name] ?? [];
          if (name === 'time' && sh.animate) {
            this.tracked?.add(SHADER_CLOCK);
            this.shaderAnimated = true;
          }
          for (let k = 0; k < u.columns * u.rows; k++) uniforms[u.slot + k] = value[k] ?? value[0] ?? 0;
        }
        const next = effect.makeShaderWithChildren(uniforms, [shader]);
        shader.delete();
        shader = next;
      }
      paint.setShader(shader);
      paint.setAlphaf(n.opacity);
      paint.setBlendMode(this.blendMode(n.blendMode));
      canvas.drawRect(rect, paint);
    } finally {
      this.pixel = oldPixel;
      paint.delete();
      shader?.delete();
      picture?.delete();
      recorder.delete();
    }
  }

  private drawNode(canvas: Canvas, n: SceneNode, viewport: Rect, shaderSource = false) {
    if (!n.visible || n.opacity <= 0) return;
    if (this.excluded.has(n) && this.bypass !== n) return;
    const b = this.bounds.get(n);
    if (b && (!intersects(b, viewport) || (b[2] - b[0] < this.pixel * 0.5 && b[3] - b[1] < this.pixel * 0.5))) {
      // Off-screen or smaller than half a pixel — not drawn.
      this.stats.culled++;
      return;
    }
    this.stats.drawn++;
    if (n.fills.length && !this.frameNodes.has(n) && this.hasFrameFill(n)) this.frameNodes.add(n);
    const ck = this.ck;
    if (this.flags.outline) {
      this.drawOutline(canvas, n, viewport);
      return;
    }
    canvas.save();
    if (!shaderSource) {
      canvas.concat(toMat3(n.transform));
      if (n.persp) canvas.concat(n.persp);
    }
    const shaders = !shaderSource && this.flags.effects ? n.effects.filter((e) =>
      e.type === 'SHADER' && e.visible !== false && e.shader &&
      !shaderContractError(e.shader.code, 'effect') && this.shaderEffect(e.shader.code).effect,
    ) : [];
    if (shaders.length) {
      this.drawShaderEffects(canvas, n, shaders);
      canvas.restore();
      return;
    }

    // Simplified drawing: a tiny on-screen container is drawn as a single fill, without content.
    if (b && n.children.length && Math.max(b[2] - b[0], b[3] - b[1]) < this.pixel * LOD_CONTAINER_PX) {
      this.drawOwn(canvas, n);
      canvas.restore();
      return;
    }

    // Effects smaller than a pixel on screen are not drawn: when zoomed out they are invisible but costly.
    const effects =
      n.effects.length && this.flags.effects
        ? n.effects.filter(
            (e) =>
              e.visible !== false &&
              Math.max(e.radius ?? 0, Math.abs(e.offset?.x ?? 0), Math.abs(e.offset?.y ?? 0)) > this.pixel * 0.5,
          )
        : [];
    const layerBlur = effects.find((e) => e.type === 'FOREGROUND_BLUR');
    const texture = effects.find((e) => e.type === 'GRAIN');
    const noises = this.flags.effects ? n.effects.filter((e) => e.visible !== false && e.type === 'NOISE') : [];
    const glasses = this.flags.effects ? n.effects.filter((e) => e.visible !== false && e.type === 'GLASS') : [];
    const blend = shaderSource || isNormalBlend(n.blendMode) ? undefined : n.blendMode;
    const opacity = shaderSource ? 1 : n.opacity;

    // Opacity and blending of a simple leaf go to the paint; otherwise — a layer with exact bounds.
    const foldIntoPaint = !layerBlur && (opacity < 1 || blend) && this.isSingleDrawLeaf(n) && !effects.length && !noises.length;
    let layers = 0;
    if (!foldIntoPaint && (opacity < 1 || blend || layerBlur || texture || noises.length)) {
      const lp = this.layerPaint;
      lp.setAlphaf(opacity);
      lp.setBlendMode(this.blendMode(blend));
      // Texture — content displaced by a random map, then layer blur.
      const grain = texture ? this.textureFilter(texture) : null;
      const blurF = layerBlur ? this.blurFilter(layerBlur, false, n) : null;
      const filter = grain && blurF ? this.ck.ImageFilter.MakeCompose(blurF, grain) : (grain ?? blurF);
      lp.setImageFilter(filter);
      // Texture “clipped to shape” — grains don't extend beyond the layer's shape.
      if (texture && texture.clipToShape !== false) {
        canvas.save();
        this.clipToShape(canvas, n);
        layers++;
      }
      canvas.saveLayer(lp, this.localBounds(n));
      if (grain && blurF) filter!.delete();
      layers++;
    }

    // Background blur: blur what has already been drawn under the shape.
    for (const e of effects) {
      if (e.type !== 'BACKGROUND_BLUR') continue;
      canvas.save();
      this.clipToShape(canvas, n);
      canvas.saveLayer(undefined, [0, 0, n.size.x, n.size.y], this.blurFilter(e, true, n));
      canvas.restore();
      canvas.restore();
    }
    // Glass: the background under the layer refracts at the edges, a highlight on top.
    for (const e of glasses) this.drawGlass(canvas, n, e);

    // Shadows: by the node's shape, or, if there is no shape, by content via a layer.
    this.drawDropShadows(canvas, n, effects, viewport);

    if (foldIntoPaint) this.drawOwn(canvas, n, opacity, blend);
    else this.drawOwn(canvas, n);
    // Noise — over the layer's fills (under the children).
    for (const e of noises) this.drawNoise(canvas, n, e);

    // Inner shadows — over the fill, under the content.
    for (const e of effects) if (e.type === 'INNER_SHADOW') this.innerShadow(canvas, n, e);

    // A boolean group draws the operation result (its shape), not the operands.
    if (n.children.length && n.type !== 'BOOLEAN_OPERATION') {
      // Scrolling (prototype presentation): content is offset inside the frame's clip.
      const scrolled = n.scroll && (n.scroll.x || n.scroll.y);
      if (n.clipsContent) {
        canvas.save();
        this.clipToShape(canvas, n);
        if (scrolled) canvas.translate(-n.scroll!.x, -n.scroll!.y);
        this.drawChildren(canvas, n.reverseZ ? [...n.children].reverse() : n.children, viewport);
        canvas.restore();
      } else {
        if (scrolled) {
          canvas.save();
          canvas.translate(-n.scroll!.x, -n.scroll!.y);
        }
        this.drawChildren(canvas, n.reverseZ ? [...n.children].reverse() : n.children, viewport);
        if (scrolled) canvas.restore();
      }
    }

    // Stroke on top of content.
    this.drawStrokes(canvas, n);

    while (layers-- > 0) canvas.restore();
    canvas.restore();
  }

  /**
   * Outline mode: only thin lines along layer shapes, without fills,
   * effects or clipping; text — as is, in the line color.
   */
  private drawOutline(canvas: Canvas, n: SceneNode, viewport: Rect) {
    const ck = this.ck;
    if (!this.outlinePaint) {
      this.outlinePaint = new ck.Paint();
      this.outlinePaint.setStyle(ck.PaintStyle.Stroke);
      this.outlinePaint.setStrokeWidth(0);
      this.outlinePaint.setAntiAlias(true);
      this.owned.add(this.outlinePaint);
    }
    const [r, g, b] = this.outlineColor;
    this.outlinePaint.setColor(ck.Color(r, g, b, 0.85));
    const p = this.outlinePaint;
    canvas.save();
    canvas.concat(toMat3(n.transform));
    if (n.persp) canvas.concat(n.persp);
    if (n.type === 'TEXT') {
      if (n.glyphs) for (const run of this.textRuns(n)) canvas.drawPath(run.path, p);
      else if (n.textLayout) this.drawParagraph(canvas, n, 1, { r: r / 255, g: g / 255, b: b / 255, a: 0.85 });
    } else if (n.fillGeometry.length) {
      for (const geo of n.fillGeometry) {
        const path = this.path(geo.blob, geo.windingRule === 'EVENODD');
        if (path) canvas.drawPath(path, p);
      }
    } else if (RECT_LIKE.has(n.type) || n.type === 'GROUP' || n.type === 'COMPONENT') {
      canvas.drawRect(ck.XYWHRect(0, 0, n.size.x, n.size.y), p);
    }
    if (n.type !== 'BOOLEAN_OPERATION') for (const c of n.children) this.drawNode(canvas, c, viewport);
    canvas.restore();
  }

  private clipToShape(canvas: Canvas, n: SceneNode, op = this.ck.ClipOp.Intersect) {
    const g = n.fillGeometry[0];
    const path = g ? this.path(g.blob, g.windingRule === 'EVENODD') : undefined;
    if (path) canvas.clipPath(path, op, true);
    else canvas.clipRect(this.ck.XYWHRect(0, 0, n.size.x, n.size.y), op, true);
  }

  private drawChildren(canvas: Canvas, children: SceneNode[], viewport: Rect) {
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      if (c.isMask && c.visible && this.flags.masks) {
        // A mask affects all siblings above it in layer order;
        // everything outside the mask is invisible, so the layers are limited to its bounds.
        // The next mask above nests into this one (masks intersect).
        const maskBounds = c.persp ? mapRect3(mul3(c.transform, c.persp), this.localBounds(c)) : transformBox(c.transform, this.localBounds(c));
        canvas.saveLayer(undefined, maskBounds);
        this.drawChildren(canvas, children.slice(i + 1), viewport);
        canvas.saveLayer(c.maskType === 'LUMINANCE' ? this.lumaMaskPaint : this.maskPaint, maskBounds);
        if ((c.maskType === 'VECTOR' || c.maskType === 'OUTLINE') && (c.fillGeometry.length || RECT_LIKE.has(c.type))) {
          canvas.save();
          canvas.concat(toMat3(c.transform));
          if (c.persp) canvas.concat(c.persp);
          if (c.fillGeometry.length) {
            for (const g of c.fillGeometry) {
              const path = this.path(g.blob, g.windingRule === 'EVENODD');
              if (path) canvas.drawPath(path, this.shapeMaskPaint);
            }
          } else canvas.drawRect(this.ck.XYWHRect(0, 0, c.size.x, c.size.y), this.shapeMaskPaint);
          canvas.restore();
        } else {
          // The whole layer acts as the mask: fills, strokes, content, opacity.
          const prev = this.bypass;
          this.bypass = c;
          this.drawNode(canvas, c, viewport);
          this.bypass = prev;
        }
        canvas.restore();
        canvas.restore();
        return;
      }
      this.drawNode(canvas, c, viewport);
    }
  }
}
