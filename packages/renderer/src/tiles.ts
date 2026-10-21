// Renderer tile cache.
//
// The world is split into tiles per zoom level: at level L the scale is s = 2^L
// (device pixels per world unit), a tile covers TILE / s world units.
// For the current scale d we take L = ceil(log2 d): tiles are drawn at a resolution
// no lower than needed and are downscaled at most 2× when composited — the image stays sharp.
//
// Frame = compositing of ready textures (fractions of a millisecond). New tiles are drawn
// within a budget that accounts for real GPU time (EXT_disjoint_timer_query):
// - while the camera moves we draw only what fits in the frame budget,
//   the rest is temporarily shown with a tile from a neighboring level;
// - a tile that would otherwise leave a gap is drawn out of turn;
// - when the camera is still — sharp tiles are completed and neighbors are prepared ahead.
// A margin (padding) is drawn around each tile so blurs and shadows aren't cut at the seams.

import type { Canvas, CanvasKit, Image, Paint, Surface } from 'canvaskit-wasm';
import type { SceneNode } from '@mfp/io-figma';
import type { SceneRenderer } from './renderer.ts';

export interface TileOptions {
  /** Size of a tile's useful area in device pixels. */
  tileSize: number;
  /** Margin around a tile (device pixels) for effects at seams. */
  padding: number;
  /** How many tiles to keep in video memory (LRU). */
  maxTiles: number;
  /** Frame budget for drawing while the camera moves (CPU + GPU estimate), ms. */
  movingBudgetMs: number;
  /** Frame budget when the camera is still (completion and prefetch), ms. */
  idleBudgetMs: number;
  /** How many levels to search for a substitute for a missing tile. */
  fallbackLevels: number;
  /**
   * First display without ready tiles: first a level this much coarser (fast — small layers are
   * culled; blurry on screen), sharp tiles follow within the frame budget. 0 — sharp right away.
   */
  previewLevels: number;
}

export const DEFAULT_TILE_OPTIONS: TileOptions = {
  tileSize: 512,
  padding: 32,
  maxTiles: 192,
  movingBudgetMs: 3,
  idleBudgetMs: 6,
  fallbackLevels: 6,
  previewLevels: 2,
};

interface Tile {
  level: number;
  i: number;
  j: number;
  image: Image;
  stale: boolean;
  /** Stale due to a user edit: redraw in this same frame, otherwise the delay would be visible. */
  urgent: boolean;
  lastUsed: number;
  images: Set<string>;
  /** Last measured GPU time to draw this tile, ms. */
  gpuMs: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface TileFrameStats {
  level: number;
  visible: number;
  rendered: number;
  prefetched: number;
  fallback: number;
  missing: number;
  pending: number;
  cached: number;
  renderMs: number;
  moving: boolean;
}

const key = (level: number, i: number, j: number) => `${level}:${i}:${j}`;

/** Exact GPU time via EXT_disjoint_timer_query_webgl2 (if available). */
class GpuTimer {
  private gl: WebGL2RenderingContext | null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: { q: WebGLQuery; cb: (ms: number) => void }[] = [];
  private active = false;

  constructor(gl: WebGL2RenderingContext | null) {
    this.gl = gl;
    this.ext = gl ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimer['ext']) : null;
  }

  get available() {
    return !!this.ext;
  }

  begin(): WebGLQuery | null {
    if (!this.gl || !this.ext || this.active) return null;
    const q = this.gl.createQuery();
    if (!q) return null;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = true;
    return q;
  }

  end(q: WebGLQuery | null, cb: (ms: number) => void) {
    if (!q || !this.gl || !this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
    this.pending.push({ q, cb });
  }

  /** Collects ready results (they arrive with a delay of a frame or two). */
  poll() {
    const gl = this.gl;
    if (!gl || !this.ext || !this.pending.length) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    this.pending = this.pending.filter(({ q, cb }) => {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!disjoint) cb(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
      return false;
    });
  }
}

export class TileCache {
  private tiles = new Map<string, Tile>();
  private byImage = new Map<string, Set<string>>();
  private scratch: Surface | null = null;
  private frame = 0;
  private compositePaint: Paint;
  private ck: CanvasKit;
  private renderer: SceneRenderer;
  private nodes: SceneNode[];
  private timer: GpuTimer;
  private lastCamera: Camera | null = null;
  /** Moving estimate of GPU time per tile, ms. */
  private gpuCostEma = 4;
  readonly opts: TileOptions;
  /** Profiling: tile time history (CPU, GPU). */
  profile = { cpuMs: [] as number[], gpuMs: [] as number[] };
  stats: TileFrameStats = {
    level: 0,
    visible: 0,
    rendered: 0,
    prefetched: 0,
    fallback: 0,
    missing: 0,
    pending: 0,
    cached: 0,
    renderMs: 0,
    moving: false,
  };

  constructor(ck: CanvasKit, renderer: SceneRenderer, nodes: SceneNode[], gl: WebGL2RenderingContext | null, opts: Partial<TileOptions> = {}) {
    this.ck = ck;
    this.renderer = renderer;
    this.nodes = nodes;
    this.timer = new GpuTimer(gl);
    this.opts = { ...DEFAULT_TILE_OPTIONS, ...opts };
    this.compositePaint = new ck.Paint();
    this.compositePaint.setAntiAlias(false);
  }

  dispose() {
    for (const t of this.tiles.values()) t.image.delete();
    this.tiles.clear();
    this.byImage.clear();
    this.scratch?.delete();
    this.scratch = null;
    this.compositePaint.delete();
  }

  /** New scene root (page rebuilt). Tiles are kept until invalidated. */
  setNodes(nodes: SceneNode[]) {
    this.nodes = nodes;
  }

  /**
   * Edit in area rect (page coordinates): affected tiles are redrawn in the next frame
   * (visible ones — immediately, without a budget), the rest — when needed.
   */
  invalidateRect(rect: [number, number, number, number]) {
    for (const t of this.tiles.values()) {
      const tw = this.opts.tileSize / 2 ** t.level;
      const pad = this.opts.padding / 2 ** t.level;
      const x0 = t.i * tw - pad;
      const y0 = t.j * tw - pad;
      if (rect[0] <= x0 + tw + 2 * pad && rect[2] >= x0 && rect[1] <= y0 + tw + 2 * pad && rect[3] >= y0) {
        t.stale = true;
        t.urgent = true;
      }
    }
  }

  /** All tiles are stale (e.g. the document changed): they are redrawn gradually. */
  invalidateAll() {
    for (const t of this.tiles.values()) t.stale = true;
  }

  /** An image has loaded: only the tiles where it was used become stale. */
  /** There are tiles drawn with this image (or with the shader clock). */
  hasImage(hash: string): boolean {
    return !!this.byImage.get(hash)?.size;
  }

  invalidateImage(hash: string) {
    const keys = this.byImage.get(hash);
    if (!keys) return;
    for (const k of keys) {
      const t = this.tiles.get(k);
      if (t) t.stale = true;
    }
  }

  get gpuTimerAvailable() {
    return this.timer.available;
  }

  get size() {
    return this.tiles.size;
  }

  static levelFor(deviceScale: number): number {
    return Math.ceil(Math.log2(deviceScale) - 1e-9);
  }

  private tileRange(level: number, vx0: number, vy0: number, vx1: number, vy1: number, margin = 0) {
    const tw = this.opts.tileSize / 2 ** level;
    return {
      tw,
      i0: Math.floor(vx0 / tw) - margin,
      i1: Math.floor(vx1 / tw) + margin,
      j0: Math.floor(vy0 / tw) - margin,
      j1: Math.floor(vy1 / tw) + margin,
    };
  }

  private hasFallback(level: number, i: number, j: number): boolean {
    for (let k = 1; k <= this.opts.fallbackLevels; k++) {
      const f = 2 ** k;
      if (this.tiles.has(key(level - k, Math.floor(i / f), Math.floor(j / f)))) return true;
    }
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) if (this.tiles.has(key(level + 1, i * 2 + di, j * 2 + dj))) return true;
    return false;
  }

  /**
   * Draws a frame. Returns true if work remains (another frame is needed).
   * @param blockUntilComplete — draw all visible tiles at once (first display, no “holes”).
   * @param busy — the user is dragging something: budget as during camera movement, no prefetching.
   */
  /**
   * pixelPreview: 1 or 2 — tiles of that level (1x / 2x),
   * no smoothing when zoomed in: shows which pixels the export will produce. 0 — normal view.
   */
  draw(surface: Surface, canvas: Canvas, camera: Camera, dpr: number, viewW: number, viewH: number, blockUntilComplete = false, busy = false, pixelPreview = 0): boolean {
    this.frame++;
    this.timer.poll();
    const moving =
      busy ||
      (!!this.lastCamera && (this.lastCamera.x !== camera.x || this.lastCamera.y !== camera.y || this.lastCamera.zoom !== camera.zoom));
    this.lastCamera = { ...camera };

    const d = camera.zoom * dpr;
    const pixels = pixelPreview > 0 && d > pixelPreview;
    const level = TileCache.levelFor(pixels ? pixelPreview : d);
    const vx0 = camera.x;
    const vy0 = camera.y;
    const vx1 = camera.x + viewW / camera.zoom;
    const vy1 = camera.y + viewH / camera.zoom;
    const { tw, i0, i1, j0, j1 } = this.tileRange(level, vx0, vy0, vx1, vy1);
    const cx = (vx0 + vx1) / 2;
    const cy = (vy0 + vy1) / 2;
    const dist = (i: number, j: number, w: number) => Math.hypot((i + 0.5) * w - cx, (j + 0.5) * w - cy);

    const visible: [number, number][] = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) visible.push([i, j]);
    visible.sort((a, b) => dist(a[0], a[1], tw) - dist(b[0], b[1], tw));

    const stats: TileFrameStats = {
      level,
      visible: visible.length,
      rendered: 0,
      prefetched: 0,
      fallback: 0,
      missing: 0,
      pending: 0,
      cached: 0,
      renderMs: 0,
      moving,
    };
    const start = performance.now();
    // First display with nothing to show (no tiles, no substitute): a fast coarse level, sharp ones follow.
    const preview = Math.min(this.opts.previewLevels, this.opts.fallbackLevels);
    if (blockUntilComplete && preview > 0 && !visible.some(([i, j]) => this.tiles.has(key(level, i, j)) || this.hasFallback(level, i, j))) {
      const coarse = level - preview;
      const r = this.tileRange(coarse, vx0, vy0, vx1, vy1);
      for (let j = r.j0; j <= r.j1; j++) {
        for (let i = r.i0; i <= r.i1; i++) {
          if (this.tiles.has(key(coarse, i, j))) continue;
          this.renderTile(surface, coarse, i, j);
          stats.prefetched++;
        }
      }
      blockUntilComplete = false;
    }
    const budget = moving ? this.opts.movingBudgetMs : this.opts.idleBudgetMs;
    // Account for both CPU (measured immediately) and GPU (estimated from previous tiles).
    const spent = () => performance.now() - start + stats.rendered * this.gpuCostEma + stats.prefetched * this.gpuCostEma;
    const canAfford = () => blockUntilComplete || spent() + this.gpuCostEma <= budget || stats.rendered + stats.prefetched === 0 && !moving;

    // 1. Visible tiles with no substitute at all (otherwise there'd be a gap) and those hit by an edit — always.
    for (const [i, j] of visible) {
      const existing = this.tiles.get(key(level, i, j));
      if (existing && !existing.urgent) continue;
      if (!existing && !blockUntilComplete && this.hasFallback(level, i, j)) continue;
      this.renderTile(surface, level, i, j);
      stats.rendered++;
    }
    // 2. Missing ones (with a substitute), then stale ones — within the budget.
    for (const pass of ['missing', 'stale'] as const) {
      for (const [i, j] of visible) {
        const t = this.tiles.get(key(level, i, j));
        const needs = pass === 'missing' ? !t : t?.stale === true;
        if (!needs) continue;
        if (!canAfford()) {
          stats.pending++;
          continue;
        }
        this.renderTile(surface, level, i, j);
        stats.rendered++;
      }
    }
    // 3. The camera is still and everything visible is ready — prepare neighbors ahead:
    //    a coarser level (for zooming out), a ring around the screen (for scrolling), a finer level (for zooming in).
    if (!moving && stats.pending === 0 && !blockUntilComplete) {
      const plan: [number, number, number][] = [];
      for (const [lv, margin] of [
        [level - 1, 1],
        [level, 1],
        [level + 1, 0],
      ] as const) {
        const r = this.tileRange(lv, vx0, vy0, vx1, vy1, margin);
        for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) if (!this.tiles.has(key(lv, i, j))) plan.push([lv, i, j]);
      }
      for (const [lv, i, j] of plan) {
        if (!canAfford() || this.tiles.size >= this.opts.maxTiles - 8) {
          stats.pending++;
          break;
        }
        this.renderTile(surface, lv, i, j);
        stats.prefetched++;
      }
    }
    stats.renderMs = performance.now() - start;

    // 4. Compositing.
    canvas.save();
    canvas.concat([d, 0, -camera.x * d, 0, d, -camera.y * d, 0, 0, 1]);
    const pad = this.opts.padding;
    const T = this.opts.tileSize;
    for (const [i, j] of visible) {
      const t = this.tiles.get(key(level, i, j));
      if (t) {
        t.lastUsed = this.frame;
        canvas.drawImageRectOptions(
          t.image,
          this.ck.XYWHRect(pad, pad, T, T),
          this.ck.LTRBRect(i * tw, j * tw, (i + 1) * tw, (j + 1) * tw),
          pixels ? this.ck.FilterMode.Nearest : this.ck.FilterMode.Linear,
          this.ck.MipmapMode.None,
          this.compositePaint,
        );
        stats.cached++;
        continue;
      }
      if (this.drawFallback(canvas, level, i, j, tw)) stats.fallback++;
      else stats.missing++;
    }
    canvas.restore();

    this.evict();
    this.stats = stats;
    return stats.pending > 0 || stats.missing > 0 || stats.fallback > 0;
  }

  /** Substitute for a missing tile: coarser levels first (part of a parent), then finer ones (children). */
  private drawFallback(canvas: Canvas, level: number, i: number, j: number, tw: number): boolean {
    const pad = this.opts.padding;
    const T = this.opts.tileSize;
    for (let k = 1; k <= this.opts.fallbackLevels; k++) {
      const f = 2 ** k;
      const parent = this.tiles.get(key(level - k, Math.floor(i / f), Math.floor(j / f)));
      if (!parent) continue;
      parent.lastUsed = this.frame;
      const sub = T / f;
      const sx = pad + (((i % f) + f) % f) * sub;
      const sy = pad + (((j % f) + f) % f) * sub;
      canvas.drawImageRectOptions(
        parent.image,
        this.ck.XYWHRect(sx, sy, sub, sub),
        this.ck.LTRBRect(i * tw, j * tw, (i + 1) * tw, (j + 1) * tw),
        this.ck.FilterMode.Linear,
        this.ck.MipmapMode.None,
        this.compositePaint,
      );
      return true;
    }
    // Children one level finer: draw the quarters that exist.
    let any = false;
    const half = tw / 2;
    for (let dj = 0; dj < 2; dj++) {
      for (let di = 0; di < 2; di++) {
        const child = this.tiles.get(key(level + 1, i * 2 + di, j * 2 + dj));
        if (!child) continue;
        child.lastUsed = this.frame;
        const x = i * tw + di * half;
        const y = j * tw + dj * half;
        canvas.drawImageRectOptions(
          child.image,
          this.ck.XYWHRect(pad, pad, T, T),
          this.ck.LTRBRect(x, y, x + half, y + half),
          this.ck.FilterMode.Linear,
          this.ck.MipmapMode.None,
          this.compositePaint,
        );
        any = true;
      }
    }
    return any;
  }

  private renderTile(surface: Surface, level: number, i: number, j: number) {
    const ck = this.ck;
    const T = this.opts.tileSize;
    const pad = this.opts.padding;
    const size = T + pad * 2;
    if (!this.scratch) {
      this.scratch = surface.makeSurface({
        width: size,
        height: size,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Premul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      if (!this.scratch) throw new Error('Не удалось создать поверхность тайла');
    }
    const s = 2 ** level;
    const tw = T / s;
    const ox = i * tw;
    const oy = j * tw;
    const t0 = performance.now();
    const query = this.timer.begin();
    const c = this.scratch.getCanvas();
    c.clear(ck.TRANSPARENT);
    c.save();
    c.concat([s, 0, -ox * s + pad, 0, s, -oy * s + pad, 0, 0, 1]);
    const world: [number, number, number, number] = [ox - pad / s, oy - pad / s, ox + tw + pad / s, oy + tw + pad / s];
    this.renderer.trackImages();
    this.renderer.render(c, this.nodes, world, s);
    const used = this.renderer.takeTrackedImages();
    c.restore();
    this.scratch.flush();
    const k = key(level, i, j);
    this.timer.end(query, (ms) => {
      this.gpuCostEma = this.gpuCostEma * 0.8 + ms * 0.2;
      this.profile.gpuMs.push(ms);
      const t = this.tiles.get(k);
      if (t) t.gpuMs = ms;
    });
    const image = this.scratch.makeImageSnapshot();
    this.profile.cpuMs.push(performance.now() - t0);

    const old = this.tiles.get(k);
    if (old) {
      old.image.delete();
      for (const h of old.images) this.byImage.get(h)?.delete(k);
    }
    this.tiles.set(k, { level, i, j, image, stale: false, urgent: false, lastUsed: this.frame, images: used, gpuMs: old?.gpuMs ?? 0 });
    for (const h of used) {
      let set = this.byImage.get(h);
      if (!set) this.byImage.set(h, (set = new Set()));
      set.add(k);
    }
  }

  private evict() {
    if (this.tiles.size <= this.opts.maxTiles) return;
    const victims = [...this.tiles.entries()]
      .filter(([, t]) => t.lastUsed < this.frame)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let excess = this.tiles.size - this.opts.maxTiles;
    for (const [k, t] of victims) {
      if (excess-- <= 0) break;
      t.image.delete();
      for (const h of t.images) this.byImage.get(h)?.delete(k);
      this.tiles.delete(k);
    }
  }
}
