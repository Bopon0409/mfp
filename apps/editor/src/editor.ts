// Editor state and rendering: document → scene → tiles → overlay (selection, handles).

import type { Canvas, CanvasKit, Image, Paint, Surface } from 'canvaskit-wasm';
import { encodeAvif } from './avif.ts';
import { Document, invert, mapPoint3, mul3, multiply as mulCore, userPages, type Matrix, type Op } from '@mfp/core';
import { SHADER_CLOCK, CoreScene, FontLibrary, ImageCache, LottieLibrary, SceneRenderer, TileCache, fitTextProps, layoutText, textLayoutOf } from '@mfp/renderer';
import { VideoCache } from './video-cache.ts';
import { ModelLibrary } from './model3d.ts';
import type { ImageBytesSource } from '@mfp/io-figma';
import { ImageStore } from './image-store.ts';
import { LAYOUT_CHILD_KEYS, LAYOUT_SELF_KEYS, isAutoLayout, layoutFrame, setTextBaseline } from '@mfp/editing';
import { FIT_CHILD_KEYS, FIT_TYPES, fitGroup } from '@mfp/editing';
import { DesignSync } from '@mfp/editing';
import type { Matrix2D, SceneNode } from '@mfp/io-figma';
import type { Guide } from './snap.ts';

export type Tool = 'select' | 'scale' | 'frame' | 'section' | 'slice' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'star' | 'pen' | 'pencil' | 'brush' | 'width' | 'text' | 'hand' | 'comment' | 'annotate' | 'measure';
export type Rect = [number, number, number, number];
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

const HANDLE = 8; // handle size in CSS pixels

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 256;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
/** Smooth camera time constant (mouse wheel), ms: after ~3τ the motion is almost finished. */
const WHEEL_TAU = 55;
/** Layout reordering during a drag: travel to the new place, ms. */
const GLIDE_MS = 180;
/** How many pages to keep ready (scene, render, tiles) besides the open one: no more than this… */
const PAGE_CACHE = 6;
/** …and no more than this many nodes across all of them (memory). */
const PAGE_CACHE_NODES = 250_000;

/** A ready page in the cache: returning to it needs no scene rebuild and its tiles are already drawn. */
interface CachedPage {
  scene: CoreScene;
  renderer: SceneRenderer;
  /** null — tiles are released (the surface changed) and get recreated. */
  tiles: TileCache | null;
}

/** Properties the text box size depends on. */
/** Text content and styling (without the sizes set by layout). */
const TEXT_CONTENT_KEYS = new Set(['characters', 'fontSize', 'fontName', 'lineHeight', 'letterSpacing', 'textCase', 'textRuns', 'openTypeFeatures', 'fontVariations', 'paragraphSpacing', 'paragraphIndent', 'listSpacing', 'leadingTrim']);
const TEXT_LAYOUT_KEYS = new Set(['characters', 'fontSize', 'fontName', 'textAutoResize', 'lineHeight', 'letterSpacing', 'textCase', 'textGlyphs', 'width', 'textAlignHorizontal', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'textRuns', 'openTypeFeatures', 'fontVariations', 'hangingList', 'hangingPunctuation', 'listType', 'indentation', 'paragraphSpacing', 'paragraphIndent', 'listSpacing', 'maxLines', 'textTruncation', 'leadingTrim', 'textWrap', 'textFit', 'textFitMinSize']);

/** Camera coordinate limit, px. */
const CAMERA_LIMIT = 1e7;

export class Editor {
  readonly ck: CanvasKit;
  readonly canvasEl: HTMLCanvasElement;
  private surface: Surface | null = null;
  dpr = 1;
  doc: Document;
  pageId: string;
  scene!: CoreScene;
  renderer!: SceneRenderer;
  tiles!: TileCache;
  sceneBuilding = false;
  private sceneFrame = 0;
  private visibleRoots: SceneNode[] = [];
  private images: ImageCache;
  /** Fill videos: frames for rendering; a new frame redraws the tiles with it. */
  private videos: VideoCache;
  /** Fill Lottie animations (Skottie): loop on the canvas, their area drawn over the tiles. */
  lotties: LottieLibrary;
  /** Fill 3D models (three.js): on the canvas — a still frame from the fill's camera angle. */
  models: ModelLibrary;
  /** Document images (the document source + those added in the editor). */
  store: ImageStore;
  /** Component-to-instance links (propagating main edits). */
  /** Document design system: component copies, properties, styles, variables. */
  components!: DesignSync;
  /** Fonts for text laid out by the editor. */
  readonly fonts: FontLibrary;
  camera: Camera = { x: -100, y: -100, zoom: 1 };
  selection: string[] = [];
  /**
   * Key object of the selection (our own, as in Illustrator): the others align to it, it stays
   * in place. Alt+click a selected layer among several; reset when it is no longer in the selection.
   */
  keyObject: string | null = null;
  /** New layers go above the selected layer, not on top of everything (a setting, remembered). */
  insertAboveSelection = (() => {
    try {
      return localStorage.getItem('mfp.insertAbove') === '1';
    } catch {
      return false;
    }
  })();
  /** Isolation mode: selecting and marquee selection only inside these layers (empty — off). */
  isolation: string[] = [];
  /** Module recomputations (grid repeat, etc.) after user or plugin edits — in the same undo step. */
  derivers: ((ops: Op[]) => void)[] = [];
  hover: string | null = null;
  marquee: Rect | null = null;
  /** Smart guides (world coordinates) while something is being dragged. */
  guides: Guide[] = [];
  /** Extra drawing over the canvas (pen, path editing); screen coordinates. */
  overlays: ((canvas: Canvas) => void)[] = [];
  /** Hint layers under the selection (layout grids). */
  underlays: ((canvas: Canvas) => void)[] = [];
  /** Snap to whole pixels. */
  pixelSnap = true;
  /** Pixel grid at high zoom. */
  pixelGrid = true;
  /** Pixel preview: 0 — off, 1 or 2 — 1x / 2x export pixels when zoomed in. */
  pixelPreview = 0;
  /** Outline mode. */
  get outline() {
    return this.renderer.flags.outline;
  }
  set outline(on: boolean) {
    this.renderer.flags.outline = on;
    this.tiles.invalidateAll();
    this.dirty = true;
  }
  /** Rounding of coordinates and sizes: to a pixel, or to hundredths if snapping is off. */
  snapPx(v: number): number {
    return this.pixelSnap ? Math.round(v) : Math.round(v * 100) / 100;
  }
  /** Equal spacing marks while dragging (drawn by measure.ts). */
  spacings: { a: [number, number]; b: [number, number]; label: string }[] = [];
  /** Don't show the bounding box handles (path editing or pen drawing in progress). */
  hideHandles = false;
  /** Where dragged layers will drop: the target frame and the insertion line (auto layout). */
  drop: { target: string; line: Guide | null; cell?: [number, number][] } | null = null;
  tool: Tool = 'select';
  /** The frame needs to be redrawn. */
  dirty = true;
  private firstFrame = true;
  private unsubscribe: (() => void) | null = null;
  private paints: Record<'sel' | 'hover' | 'flat' | 'handleFill' | 'handleStroke' | 'marqueeFill' | 'marqueeStroke' | 'guide' | 'dropLine' | 'key', Paint>;
  lastFrameMs = 0;
  /**
   * “Live layer”: nodes currently being dragged or changed. They are excluded from the tiles
   * (the tiles under them are redrawn once) and drawn separately: when moving —
   * as a ready texture with an offset, when resizing — directly.
   */
  private live: {
    ids: string[];
    nodes: SceneNode[];
    mode: 'translate' | 'direct' | 'hidden';
    cache: { image: Image; zoom: number; x0: number; y0: number; ref: Matrix2D } | null;
  } | null = null;

  // Interface subscriptions (panels redraw on events).
  onSelection: (() => void)[] = [];
  onDocument: ((ops: Op[]) => void)[] = [];
  /** The editor has a different document (file opened, version preview or restore, room). */
  onDocumentSet: ((doc: Document) => void)[] = [];
  /** Pages are loading in the background: save the document after that. */
  importing: Promise<void> | null = null;
  /** A short message to the user (toast). */
  notify: ((message: string) => void) | null = null;
  onCamera: (() => void)[] = [];
  onPage: (() => void)[] = [];
  /** Developer mode (devmode.ts): view only, no resize handles. */
  devMode = false;

  constructor(ck: CanvasKit, canvas: HTMLCanvasElement, doc: Document, pageId: string) {
    this.ck = ck;
    this.canvasEl = canvas;
    this.doc = doc;
    this.pageId = pageId;
    this.store = new ImageStore(null);
    this.images = this.imageCache();
    // A new video frame: its area is drawn over the tiles (drawFrameRegions), the tiles are left alone.
    this.videos = new VideoCache(ck, () => this.store, () => (this.dirty = true));
    this.lotties = this.lottieLibrary();
    this.models = this.modelLibrary();
    this.fonts = new FontLibrary(ck);
    // A font finished loading — re-lay out and redraw the page's own text
    // (including text temporarily drawn with a fallback font).
    this.fonts.onLoad.push(() => {
      const ids: string[] = [];
      for (const id of this.doc.descendants(this.pageId)) {
        if (this.doc.type(id) !== 'TEXT' || this.doc.get(id, 'textGlyphs')) continue;
        ids.push(id);
        const n = this.scene.node(id);
        const b = n && this.renderer.boundsOf(n);
        if (n) this.renderer.forget(n);
        if (b) this.tiles.invalidateRect(b);
      }
      this.fitTexts(ids);
      this.dropPageCache();
      if (this.prep) {
        this.prep.renderer?.dispose();
        this.prep = null;
      }
      this.prepareOtherPages();
      this.dirty = true;
    });
    void this.fonts.ensure({ family: 'Inter', style: 'Regular' });
    // Baseline alignment in auto layout: the baseline comes from the same layout as on the canvas.
    setTextBaseline((doc, id) => this.textBaseline(doc, id));
    const stroke = (r: number, g: number, b: number, a: number, w: number) => {
      const p = new ck.Paint();
      p.setStyle(ck.PaintStyle.Stroke);
      p.setStrokeWidth(w);
      p.setAntiAlias(true);
      p.setColor(ck.Color4f(r, g, b, a));
      return p;
    };
    const fill = (r: number, g: number, b: number, a: number) => {
      const p = new ck.Paint();
      p.setAntiAlias(true);
      p.setColor(ck.Color4f(r, g, b, a));
      return p;
    };
    this.paints = {
      sel: stroke(0.302, 0.482, 0.992, 1, 1.5),
      hover: stroke(0.302, 0.482, 0.992, 1, 1.5),
      flat: stroke(0.302, 0.482, 0.992, 0.45, 1),
      handleFill: fill(1, 1, 1, 1),
      handleStroke: stroke(0.302, 0.482, 0.992, 1, 1.5),
      marqueeFill: fill(0.302, 0.482, 0.992, 0.08),
      marqueeStroke: stroke(0.302, 0.482, 0.992, 1, 1),
      guide: stroke(1, 0.478, 0.18, 1, 1),
      dropLine: stroke(0.302, 0.482, 0.992, 1, 3),
      key: stroke(0.302, 0.482, 0.992, 1, 3.5),
    };
    this.resize();
    this.setDocument(doc, pageId);
  }

  /** Selection color (appearance): boxes, hover, handles, selection box, insertion line. */
  setAccent(c: { r: number; g: number; b: number }) {
    const p = this.paints;
    const ck = this.ck;
    for (const k of ['sel', 'hover', 'handleStroke', 'marqueeStroke', 'dropLine'] as const) p[k].setColor(ck.Color4f(c.r, c.g, c.b, 1));
    p.marqueeFill.setColor(ck.Color4f(c.r, c.g, c.b, 0.08));
    this.dirty = true;
  }

  /**
   * Pivot point: fractions of the bounds per axis (0, ½, 1 — corners, side midpoints, center), like the reference point
   * in Affinity and XD. Rotation with the mouse and the “Rotation” field is around it. Session only, not written to the file.
   */
  rotationOrigin: [number, number] = [0.5, 0.5];
  /** Mouse rotation in progress — the pivot point is visible on the canvas. */
  rotating = false;

  /** Pivot point in page coordinates: for one layer — by its rotated bounds, for several — by the common bounds. */
  rotationPivot(ids: string[] = this.selection): [number, number] | null {
    const live = ids.filter((id) => this.doc.has(id));
    if (!live.length) return null;
    const [fx, fy] = this.rotationOrigin;
    if (live.length === 1) {
      const m = this.worldMatrix(live[0]!);
      const w = (this.doc.get(live[0]!, 'width') ?? 0) * fx;
      const h = (this.doc.get(live[0]!, 'height') ?? 0) * fy;
      return [m[0] * w + m[1] * h + m[2], m[3] * w + m[4] * h + m[5]];
    }
    const b = this.selectionBounds(live);
    return b ? [b[0] + (b[2] - b[0]) * fx, b[1] + (b[3] - b[1]) * fy] : null;
  }

  /** High contrast: selection and hover boxes and handles are thicker. */
  setHighContrast(on: boolean) {
    const p = this.paints;
    p.sel.setStrokeWidth(on ? 2.5 : 1.5);
    p.hover.setStrokeWidth(on ? 2.5 : 1.5);
    p.handleStroke.setStrokeWidth(on ? 2 : 1.5);
    p.marqueeStroke.setStrokeWidth(on ? 2 : 1);
    this.dirty = true;
  }

  // ---------- Document and pages ----------

  /** Image from the cache for size screenPx on screen (queues the needed level). */
  imageFor(hash: string, screenPx: number) {
    return this.images.get(hash, screenPx);
  }

  /** Image cache: decoded bytes, loaded levels (problem report). */
  imageStats(): { bytes: number; loaded: number } {
    return { bytes: this.images.bytes, loaded: this.images.loaded };
  }

  /**
   * Timeline time for 3D model clips without keyframes (null — the timeline is closed: still frame).
   * While set, model areas are drawn over the tiles every frame.
   */
  setModelClock(t: number | null) {
    const was = this.renderer.modelTime;
    if (was === t) return;
    this.renderer.modelTime = t;
    // The timeline was opened or closed: tiles with models are redrawn (live area or still frame again).
    if ((was === null) !== (t === null)) for (const hash of this.renderer.modelHashes) this.tiles?.invalidateImage(hash);
    this.dirty = true;
  }

  private modelLibrary() {
    const lib = new ModelLibrary(this.ck, () => this.store, (hash) => {
      this.tiles?.invalidateImage(hash);
      for (const c of this.pageCache.values()) c.tiles?.invalidateImage(hash);
      this.dirty = true;
    });
    lib.onError = (m) => this.notify?.(m);
    return lib;
  }

  private lottieLibrary() {
    return new LottieLibrary(this.ck, () => this.store, (hash) => {
      this.tiles?.invalidateImage(hash);
      for (const c of this.pageCache.values()) c.tiles?.invalidateImage(hash);
      this.dirty = true;
    });
  }

  private imageCache() {
    this.store.onAdd = (hash) => {
      this.images?.invalidate(hash);
      this.tiles?.invalidateImage(hash);
      for (const c of this.pageCache.values()) c.tiles?.invalidateImage(hash);
      this.dirty = true;
    };
    return new ImageCache(this.ck, this.store, (hash) => {
      // A frame of an animated image already drawn over the tiles — leave the tiles alone.
      if (!this.renderer?.frameHashes.has(hash)) this.tiles?.invalidateImage(hash);
      for (const c of this.pageCache.values()) if (!c.renderer.frameHashes.has(hash)) c.tiles?.invalidateImage(hash);
      this.dirty = true;
    });
  }

  /** Open a document. images — the document's image source (.fig archive, .mfp file). */
  setDocument(doc: Document, pageId?: string, images?: ImageBytesSource | null) {
    this.unsubscribe?.();
    this.doc = doc;
    if (images !== undefined) {
      this.images.dispose();
      this.videos.dispose();
      this.lotties.dispose();
      this.models.dispose();
      this.store = new ImageStore(images);
      this.images = this.imageCache();
      this.lotties = this.lottieLibrary();
      this.models = this.modelLibrary();
      this.renderer?.setLotties(this.lotties);
      this.renderer?.setModels(this.models);
    }
    const pages = userPages(doc);
    this.components = new DesignSync(doc);
    this.unsubscribe = doc.onChange((ops, origin) => this.handleOps(ops, origin));
    // Pages of the previous document are not needed.
    this.cancelPrep();
    this.dropPageCache();
    this.setPage(pageId && doc.has(pageId) ? pageId : pages[0]!, true);
    for (const cb of this.onDocumentSet) cb(doc);
    // The remaining pages — in the background once they load (importing is set right after setDocument).
    window.setTimeout(() => {
      void (this.importing ?? Promise.resolve()).then(() => {
        if (this.doc === doc) this.prepareOtherPages();
      });
    }, 0);
  }

  /** Recent pages (except the open one), oldest first. */
  private pageCache = new Map<string, CachedPage>();

  private dropPageCache() {
    for (const c of this.pageCache.values()) {
      c.tiles?.dispose();
      c.renderer.dispose();
    }
    this.pageCache.clear();
  }

  /** fresh — the previous page's scene is unusable (another document): release it instead of caching. */
  setPage(pageId: string, fresh = false) {
    const wasBuilding = this.sceneBuilding;
    cancelAnimationFrame(this.sceneFrame);
    this.sceneBuilding = false;
    // Take the page from the cache before the previous one goes there (otherwise the queue would evict it).
    // An unfinished background scene must not block switching.
    if (this.prep?.pageId === pageId) { this.prep.renderer?.dispose(); this.prep = null; }
    const cached = fresh ? undefined : this.pageCache.get(pageId);
    if (cached) this.pageCache.delete(pageId);
    if (this.scene && !fresh && !wasBuilding && this.pageId !== pageId && this.doc.has(this.pageId)) {
      // Leaving the page: it stays ready (scene, render, tiles).
      this.cachePage(this.pageId, { scene: this.scene, renderer: this.renderer, tiles: this.tiles });
    } else if (this.scene) {
      this.tiles?.dispose();
      this.renderer?.dispose();
    }
    // Images of the previous page that haven't started loading yet are not needed.
    this.images.cancelPending();
    this.pageId = pageId;
    this.glides.clear();
    if (cached) {
      this.scene = cached.scene;
      this.renderer = cached.renderer;
      this.renderer.setExcluded([]);
      this.visibleRoots = this.scene.page.children;
      this.tiles = cached.tiles ?? new TileCache(this.ck, this.renderer, this.scene.page.children, this.webgl());
      // The page background may have changed while it was in the cache.
      const bg = this.doc.get(pageId, 'backgrounds')?.[0];
      this.scene.page.backgroundColor = bg?.type === 'SOLID' ? { ...bg.color, a: 1 } : undefined;
    } else {
      if (fresh) this.dropPageCache();
      this.scene = CoreScene.incremental(this.doc, pageId);
      this.renderer = new SceneRenderer(this.ck, this.scene.blobs, this.images);
      this.renderer.setVideos(this.videos);
      this.renderer.setLotties(this.lotties);
      this.renderer.setModels(this.models);
      this.renderer.setFonts(this.fonts);
      this.visibleRoots = [];
      this.tiles = new TileCache(this.ck, this.renderer, this.visibleRoots, this.webgl());
      this.sceneBuilding = true;
      const scene = this.scene;
      const build = () => {
        if (this.scene !== scene) return;
        const built = scene.buildStep(performance.now() + 6);
        const attached = scene.attachStep(this.renderer, performance.now() + 6, scene.completedRoots);
        const count = scene.attachedRoots;
        if (this.visibleRoots.length !== count) {
          this.visibleRoots = scene.page.children.slice(0, count);
          this.tiles.setNodes(this.visibleRoots);
          this.tiles.invalidateAll();
          this.dirty = true;
        }
        if (built && attached) {
          this.sceneBuilding = false;
          this.visibleRoots = scene.page.children;
          this.tiles.setNodes(this.visibleRoots);
          this.dirty = true;
          this.schedulePrep();
        } else this.sceneFrame = requestAnimationFrame(build);
      };
      this.sceneFrame = requestAnimationFrame(build);
    }
    const shaderRenderer = this.renderer, shaderTiles = this.tiles;
    shaderRenderer.onShaderFrame = () => { shaderTiles.invalidateImage('shader:wgsl-frame'); if (this.renderer === shaderRenderer) this.dirty = true; };
    shaderRenderer.onShaderError = (message) => this.notify?.(message);
    this.selection = [];
    this.hover = null;
    this.firstFrame = true;
    this.dirty = true;
    for (const cb of this.onPage) cb();
    for (const cb of this.onSelection) cb();
    // Preparation of the other pages continues (the open one is skipped).
    this.schedulePrep();
  }

  /** Put the page into the cache; release the oldest ones beyond the count and node budget (always keep one). */
  private cachePage(id: string, page: CachedPage) {
    this.pageCache.delete(id);
    this.pageCache.set(id, page);
    let nodes = 0;
    for (const c of this.pageCache.values()) nodes += c.scene.size;
    while (this.pageCache.size > 1 && (this.pageCache.size > PAGE_CACHE || nodes > PAGE_CACHE_NODES)) {
      const [k, c] = this.pageCache.entries().next().value as [string, CachedPage];
      this.pageCache.delete(k);
      nodes -= c.scene.size;
      c.tiles?.dispose();
      c.renderer.dispose();
    }
  }

  // ---------- Background page preparation ----------
  // After a file opens, the other pages are built during idle time (requestIdleCallback) in chunks
  // of a few milliseconds: scene, then bounds. Switching to them doesn't wait.

  /** Pages in the preparation queue (nearest to the open one first). */
  private prepQueue: string[] = [];
  /** The page being prepared right now. */
  private prep: { pageId: string; scene: CoreScene; renderer: SceneRenderer | null } | null = null;
  private prepHandle: number | null = null;

  /** Prepare the other pages in the background. */
  prepareOtherPages() {
    const pages = userPages(this.doc);
    const at = Math.max(0, pages.indexOf(this.pageId));
    this.prepQueue = pages
      .map((p, i) => [p, Math.abs(i - at) + (i < at ? 0.5 : 0)] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([p]) => p)
      .filter((p) => p !== this.pageId && !this.pageCache.has(p));
    this.schedulePrep();
  }

  private cancelPrep() {
    this.prepQueue = [];
    this.prep?.renderer?.dispose();
    this.prep = null;
    if (this.prepHandle !== null) {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(this.prepHandle);
      else clearTimeout(this.prepHandle);
      this.prepHandle = null;
    }
  }

  private schedulePrep() {
    if (this.sceneBuilding) return;
    if (this.prepHandle !== null || (!this.prep && !this.prepQueue.length)) return;
    const run = (d?: IdleDeadline) => {
      this.prepHandle = null;
      if (this.sceneBuilding) return;
      // Fonts are still loading — wait (once they load, the page cache is reset).
      if (!this.fonts.idle) {
        this.prepHandle = window.setTimeout(() => {
          this.prepHandle = null;
          this.schedulePrep();
        }, 400);
        return;
      }
      this.prepStep(performance.now() + Math.max(3, Math.min(12, d ? d.timeRemaining() : 8)));
      this.schedulePrep();
    };
    this.prepHandle = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 2000 }) : window.setTimeout(run, 30);
  }

  private prepStep(until: number) {
    while (performance.now() < until) {
      if (!this.prep) {
        const next = this.prepQueue.shift();
        if (!next) return;
        if (next === this.pageId || this.pageCache.has(next) || !this.doc.has(next)) continue;
        let nodes = 0;
        for (const c of this.pageCache.values()) nodes += c.scene.size;
        if (nodes >= PAGE_CACHE_NODES || this.pageCache.size >= PAGE_CACHE) {
          this.prepQueue = [];
          return;
        }
        this.prep = { pageId: next, scene: CoreScene.incremental(this.doc, next), renderer: null };
      }
      const p = this.prep;
      if (!p.scene.buildStep(until)) return;
      if (!p.renderer) {
        p.renderer = new SceneRenderer(this.ck, p.scene.blobs, this.images);
        p.renderer.setVideos(this.videos);
        p.renderer.setLotties(this.lotties);
        p.renderer.setModels(this.models);
        p.renderer.setFonts(this.fonts);
      }
      if (!p.scene.attachStep(p.renderer, until)) return;
      this.prep = null;
      this.cachePage(p.pageId, { scene: p.scene, renderer: p.renderer, tiles: null });
    }
  }

  private handleOps(ops: Op[], origin: string) {
    if (this.sceneBuilding && this.scene.touches(ops)) {
      // A live change must not be applied to a half-built subtree. Finish this
      // uncommon path before normal notifications (autosave must see every op).
      cancelAnimationFrame(this.sceneFrame);
      this.scene.buildStep(Infinity);
      this.scene.attachStep(this.renderer, Infinity);
      this.sceneBuilding = false;
      this.visibleRoots = this.scene.page.children;
      this.tiles.setNodes(this.visibleRoots);
      this.tiles.invalidateAll();
    }
    // Auto layout frames that need re-layout — before applying to the scene:
    // for deleted and moved nodes the previous parent is still known there.
    const layoutRoots = this.layoutCandidates(ops, origin);
    const groupRoots = this.groupCandidates(ops, origin);
    // Layout reordering during a drag — smoothly: from where the nodes were before it.
    const glideFrom = origin === 'layout' && performance.now() < this.layoutAnimUntil ? this.glideStarts(ops) : null;
    // Changes on the current page go to the scene and tiles (except live layer nodes).
    const rects = this.scene.apply(ops, this.live ? new Set(this.live.ids) : undefined, this.live?.mode === 'translate' ? new Set(this.live.ids) : undefined);
    if (glideFrom) this.startGlides(glideFrom);
    const prep = this.prep;
    if (prep && (!this.doc.has(prep.pageId) || prep.scene.touches(ops))) {
      prep.renderer?.dispose();
      this.prep = this.doc.has(prep.pageId) ? { pageId: prep.pageId, scene: CoreScene.incremental(this.doc, prep.pageId), renderer: null } : null;
    }
    for (const [id, c] of this.pageCache) {
      if (!this.doc.has(id)) {
        this.pageCache.delete(id);
        c.tiles?.dispose();
        c.renderer.dispose();
        continue;
      }
      for (const r of c.scene.apply(ops)) c.tiles?.invalidateRect(r);
    }
    for (const r of rects) this.tiles.invalidateRect(r);
    // Background loading of other pages of a large file: nothing changed on the current one —
    // panels, autosave and selection are left alone, only the component index.
    if (origin === 'import' && !rects.length) {
      this.components.observe(ops);
      return;
    }
    // Page background.
    if (ops.some((o) => o.op === 'set' && o.id === this.pageId)) {
      const bg = this.doc.get(this.pageId, 'backgrounds')?.[0];
      this.scene.page.backgroundColor = bg?.type === 'SOLID' ? { ...bg.color, a: 1 } : undefined;
    }
    // Deleted nodes leave the selection.
    const before = this.selection.length;
    this.selection = this.selection.filter((id) => this.doc.has(id) && this.isOnPage(id));
    if (this.hover && !this.doc.has(this.hover)) this.hover = null;
    // The current page was deleted (e.g. undoing its creation) — go to the first one.
    if (!this.doc.has(this.pageId)) {
      this.setPage(userPages(this.doc)[0]!);
      return;
    }
    this.dirty = true;
    for (const cb of this.onDocument) cb(ops);
    if (this.selection.length !== before) for (const cb of this.onSelection) cb();
    else if (ops.some((o) => o.op === 'set' && this.selection.includes(o.id))) for (const cb of this.onSelection) cb();
    // The text box size follows the text. Only for own edits (including undo):
    // others' edits arrive already sized, and recomputing with other fonts would fight them endlessly.
    // Recomputation after a user or plugin action is part of its undo step;
    // after undo and redo (and cascading from them) — outside history.
    const amend = origin === 'local' || origin === 'plugin' || origin === 'clipboard' || (origin === 'layout' && this.amendDerived);
    // Derived edits (values of component properties, variables, styles) also change text;
    // width from layout does not (fitting imported texts to our fonts would be pointless).
    if (origin === 'local' || origin === 'plugin' || origin === 'clipboard' || origin === 'undo' || origin === 'redo' || origin === 'layout' || origin === 'preview') {
      const keys = origin === 'layout' ? TEXT_CONTENT_KEYS : TEXT_LAYOUT_KEYS;
      const ids = new Set<string>();
      for (const o of ops) {
        if (o.op === 'create' && o.type === 'TEXT' && origin !== 'layout') ids.add(o.id);
        else if (o.op === 'set' && Object.keys(o.props).some((k) => keys.has(k)) && this.doc.type(o.id) === 'TEXT') ids.add(o.id);
      }
      if (ids.size) this.fitTexts([...ids], amend);
    }
    if (groupRoots.size) this.fitGroups(groupRoots, amend);
    if (layoutRoots.size) this.relayout(layoutRoots, amend);
    // Components: own edits in an instance become overrides; main edits go into the copies.
    this.components.observe(ops);
    if (origin === 'local' || origin === 'plugin') this.derived(true, () => this.components.trackOverrides(ops));
    // Clipboard remaps references without introducing user overrides, but still resolves resources.
    if (origin === 'local' || origin === 'plugin' || origin === 'clipboard' || origin === 'layout') {
      if (this.layoutDepth <= 32) {
        this.layoutDepth++;
        try {
          this.derived(amend, () => this.components.propagate(ops));
        } finally {
          this.layoutDepth--;
        }
      }
    }
    if ((origin === 'local' || origin === 'plugin') && this.derivers.length && this.layoutDepth <= 32) {
      this.layoutDepth++;
      try {
        this.derived(true, () => {
          for (const d of this.derivers) d(ops);
        });
      } finally {
        this.layoutDepth--;
      }
    }
  }

  /** Groups whose children changed (except dragged ones — their groups are fitted on release). */
  private groupCandidates(ops: Op[], origin: string): Set<string> {
    const roots = new Set<string>();
    if (!Editor.LAYOUT_ORIGINS.has(origin)) return roots;
    const live = this.live ? new Set(this.live.ids) : null;
    const oldParent = (id: string) => {
      const n = this.scene.node(id);
      const p = n && this.scene.parent(n);
      return p ? this.scene.id(p) : undefined;
    };
    for (const o of ops) {
      if (o.op === 'blob') continue;
      if (o.op === 'delete' || o.op === 'move') {
        const p = oldParent(o.id);
        if (p) roots.add(p);
      }
      if (o.op === 'create' || o.op === 'move') roots.add(o.parent);
      if (o.op === 'set' && !live?.has(o.id) && Object.keys(o.props).some((k) => FIT_CHILD_KEYS.has(k))) {
        const p = this.doc.parent(o.id);
        if (p) roots.add(p);
      }
    }
    for (const id of roots) if (!this.doc.has(id) || !FIT_TYPES.has(this.doc.type(id)!)) roots.delete(id);
    return roots;
  }

  /** Fit group bounds to children; the upward cascade goes through new changes. */
  fitGroups(ids: Iterable<string>, amend = false) {
    if (this.layoutDepth > 32) return;
    this.layoutDepth++;
    try {
      this.derived(amend, () => {
        for (const id of ids) fitGroup(this.doc, id);
      });
    } finally {
      this.layoutDepth--;
    }
  }

  /** Own edits and derived recomputations; others' edits arrive already laid out. */
  // Preview (hovering a menu item) is re-laid out too — outside history, like undo.
  private static LAYOUT_ORIGINS = new Set(['local', 'plugin', 'clipboard', 'undo', 'redo', 'layout', 'preview']);
  private layoutDepth = 0;

  private layoutCandidates(ops: Op[], origin: string): Set<string> {
    const roots = new Set<string>();
    if (!Editor.LAYOUT_ORIGINS.has(origin)) return roots;
    const oldParent = (id: string) => {
      const n = this.scene.node(id);
      const p = n && this.scene.parent(n);
      return p ? this.scene.id(p) : undefined;
    };
    for (const o of ops) {
      if (o.op === 'blob') continue;
      if (o.op === 'delete' || o.op === 'move') {
        const p = oldParent(o.id);
        if (p) roots.add(p);
      }
      if (o.op === 'create' || o.op === 'move') roots.add(o.parent);
      if (o.op === 'set') {
        const keys = Object.keys(o.props);
        if (keys.some((k) => LAYOUT_SELF_KEYS.has(k))) roots.add(o.id);
        if (keys.some((k) => LAYOUT_CHILD_KEYS.has(k))) {
          const p = this.doc.parent(o.id);
          if (p) roots.add(p);
        }
      }
    }
    for (const id of roots) if (!this.doc.has(id) || !isAutoLayout(this.doc, id)) roots.delete(id);
    return roots;
  }

  /** Re-lay out auto layout frames. The upward cascade goes through new changes. */
  relayout(ids: Iterable<string>, amend = false) {
    if (this.layoutDepth > 32) {
      console.warn('Auto layout: каскад пересчётов не сошёлся');
      return;
    }
    this.layoutDepth++;
    try {
      this.derived(amend, () => {
        for (const id of ids) layoutFrame(this.doc, id);
      });
    } finally {
      this.layoutDepth--;
    }
  }

  /** Fit text box sizes; amend — append to the undo step of the action that caused the edit. */
  fitTexts(ids: string[], amend = false) {
    this.derived(amend, () => {
      for (const id of ids) {
        if (!this.doc.has(id)) continue;
        const p = fitTextProps(this.ck, this.fonts, this.doc, id);
        if (p) this.doc.set(id, p);
      }
    });
  }

  /** Recompute derived data: into the action's undo step (amend) or outside history; the cascade inherits the mode. */
  private amendDerived = false;
  private derived(amend: boolean, fn: () => void) {
    const prev = this.amendDerived;
    this.amendDerived = amend;
    try {
      if (amend) this.doc.amend(fn);
      else this.doc.transact(fn, 'layout');
    } finally {
      this.amendDerived = prev;
    }
  }

  isOnPage(id: string): boolean {
    for (let p = this.doc.parent(id); p; p = this.doc.parent(p)) if (p === this.pageId) return true;
    return false;
  }

  // ---------- Selection ----------

  select(ids: string[]) {
    this.selection = [...new Set(ids)].filter((id) => this.doc.has(id));
    if (this.keyObject && (this.selection.length < 2 || !this.selection.includes(this.keyObject))) this.keyObject = null;
    this.dirty = true;
    for (const cb of this.onSelection) cb();
  }

  /** World matrix of a document node (relative to the page). */
  worldMatrix(id: string): Matrix2D {
    const chain: Matrix2D[] = [];
    for (let cur: string | null = id; cur && cur !== this.pageId; cur = this.doc.parent(cur)) {
      chain.unshift((this.doc.get(cur, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix2D);
    }
    return chain.reduce((acc, m) => mulCore(acc, m), [1, 0, 0, 0, 1, 0] as Matrix2D);
  }

  /** Node corners in page coordinates (rotation included). */
  corners(id: string): [number, number][] {
    const m = this.worldMatrix(id);
    const w = this.doc.get(id, 'width') ?? 0;
    const h = this.doc.get(id, 'height') ?? 0;
    return (
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ] as const
    ).map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
  }

  /**
   * Visible corners of a node on the page: for a layer with 3D rotation (its own or an ancestor's) — the projection of its bounds;
   * otherwise — same as corners. The box with handles stays at corners: size is edited on the flat layer.
   */
  visualCorners(id: string): [number, number][] {
    const n = this.scene.node(id);
    const m = n && this.scene.worldProj(n);
    if (!n || !m || m.length !== 9) return this.corners(id);
    const w = n.size.x;
    const h = n.size.y;
    const pts = ([[0, 0], [w, 0], [w, h], [0, h]] as const).map(([x, y]) => mapPoint3(m, x, y));
    return pts.every((p) => p) ? (pts as [number, number][]) : this.corners(id);
  }

  /** The layer is shown in 3D (itself or inside a 3D layer). */
  in3d(id: string): boolean {
    const n = this.scene.node(id);
    return !!n && this.scene.worldProj(n).length === 9;
  }

  /** Text baselines by layout key (size, font, width, fonts version). */
  private baselines = new Map<string, number>();

  /**
   * Rectangles of text ranges [start, end) in layer coordinates (as the canvas draws it, including
   * vertical alignment) and the height of the whole text; for text on a path and pre-built glyphs — null.
   */
  textBoxes(id: string, ranges: readonly [number, number][]): { rects: [number, number, number, number][][]; height: number } | null {
    const p = this.doc.props(id);
    if (p.textPath || p.textGlyphs) return null;
    const spec = textLayoutOf(p);
    const width = spec.autoWidth ? undefined : (p.width ?? 1);
    const height = spec.autoWidth ? undefined : p.height;
    const layout = layoutText(this.ck, this.fonts, { ...spec, color: { r: 0, g: 0, b: 0, a: 1 }, width, height });
    const dy = spec.alignV === 'TOP' || height === undefined ? 0 : ((p.height ?? 0) - layout.height) * (spec.alignV === 'CENTER' ? 0.5 : 1);
    const rects = ranges.map(([a, b]) => layout.rects(a, b).map(([x0, y0, x1, y1]) => [x0, y0 + dy, x1, y1 + dy] as [number, number, number, number]));
    const out = { rects, height: layout.height };
    layout.delete();
    return out;
  }

  /** Width of “0” in the text's main font and size (like the ch unit in CSS); null — not text. */
  chWidth(id: string): number | null {
    if (this.doc.type(id) !== 'TEXT') return null;
    const p = this.doc.props(id);
    const spec = textLayoutOf({ characters: '0'.repeat(20), fontName: p.fontName, fontSize: p.fontSize, letterSpacing: p.letterSpacing });
    const layout = layoutText(this.ck, this.fonts, { ...spec, color: { r: 0, g: 0, b: 0, a: 1 } });
    const w = layout.width / 20;
    layout.delete();
    return w > 0 ? w : null;
  }

  /** Baseline of the first text line from the top of its bounds — as the canvas draws it. */
  textBaseline(doc: Document, id: string): number | undefined {
    const p = doc.props(id);
    const g = p.textGlyphs?.glyphs[0];
    if (g) return g[2];
    if (p.textPath) return undefined;
    const spec = textLayoutOf(p);
    const width = spec.autoWidth ? undefined : (p.width ?? 1);
    const height = spec.autoWidth ? undefined : p.height;
    const key = JSON.stringify([spec, width, height, this.fonts.version]);
    const hit = this.baselines.get(key);
    if (hit !== undefined) return hit;
    const layout = layoutText(this.ck, this.fonts, { ...spec, color: { r: 0, g: 0, b: 0, a: 1 }, width, height });
    const first = layout.lines()[0];
    const y = spec.alignV === 'TOP' || height === undefined ? 0 : ((p.height ?? 0) - layout.height) * (spec.alignV === 'CENTER' ? 0.5 : 1);
    const b = (first?.baseline ?? 0) + y;
    layout.delete();
    if (this.baselines.size > 2000) this.baselines.clear();
    this.baselines.set(key, b);
    return b;
  }

  /**
   * What is visible of the nodes (with shadows and outside strokes), in page coordinates. The render has a margin
   * of 2 px on each side — remove it: the box will match the node.
   */
  renderBounds(ids: readonly string[]): Rect | null {
    let r: Rect | null = null;
    for (const id of ids) {
      const n = this.scene.node(id);
      const b = n && this.renderer.boundsOf(n);
      if (!b) continue;
      r = r ? [Math.min(r[0], b[0] + 2), Math.min(r[1], b[1] + 2), Math.max(r[2], b[2] - 2), Math.max(r[3], b[3] - 2)] : [b[0] + 2, b[1] + 2, b[2] - 2, b[3] - 2];
    }
    return r;
  }

  /** Selection bounds (AABB) in page coordinates. */
  selectionBounds(ids: readonly string[] = this.selection): Rect | null {
    let r: Rect | null = null;
    for (const id of ids) {
      for (const [x, y] of this.corners(id)) {
        r = r ? [Math.min(r[0], x), Math.min(r[1], y), Math.max(r[2], x), Math.max(r[3], y)] : [x, y, x, y];
      }
    }
    return r;
  }

  // ---------- Live layer ----------

  /** A child of a shader must be rendered together with the processed ancestor. */
  private shaderRoot(node: SceneNode): SceneNode | null {
    let root: SceneNode | null = null;
    for (let n: SceneNode | null = node; n; n = this.scene.parent(n))
      if (n.effects.some((e) => e.type === 'SHADER' && e.visible !== false)) root = n;
    return root;
  }

  beginLive(ids: string[], mode: 'translate' | 'direct' | 'hidden') {
    this.endLive();
    const nodes = ids.map((id) => this.scene.node(id)).filter((n): n is SceneNode => !!n);
    if (!nodes.length) return;
    // The ordinary dirty-tile path preserves shaders while dragging/resizing children.
    if (mode !== 'hidden' && nodes.some((n) => this.shaderRoot(n))) return;
    // Dragging: neighbors in auto layout part and close smoothly.
    if (mode === 'translate') this.layoutAnimUntil = Infinity;
    for (const n of nodes) this.glides.delete(n);
    this.live = { ids, nodes, mode, cache: null };
    this.syncExcluded();
    for (const n of nodes) {
      const b = this.renderer.boundsOf(this.shaderRoot(n) ?? n);
      if (b) this.tiles.invalidateRect(b);
    }
    this.dirty = true;
  }

  endLive() {
    // Bounds of the dragged nodes were deferred — recompute and redraw their areas.
    for (const r of this.scene.flushDeferred()) this.tiles.invalidateRect(r);
    const live = this.live;
    if (!live) return;
    // Groups of the dragged nodes — fit once, within the drag's undo step.
    const groups = new Set(live.ids.map((id) => this.doc.parent(id)).filter((p): p is string => !!p && this.doc.has(p) && FIT_TYPES.has(this.doc.type(p)!)));
    if (groups.size) {
      this.live = null;
      this.fitGroups(groups, true);
      this.live = live;
    }
    this.live = null;
    // Drop: layout puts the layers in place — smoothly too.
    if (live.mode === 'translate') this.layoutAnimUntil = performance.now() + 350;
    this.syncExcluded();
    for (const n of live.nodes) {
      const b = this.renderer.boundsOf(this.shaderRoot(n) ?? n);
      if (b) this.tiles.invalidateRect(b);
    }
    live.cache?.image.delete();
    this.dirty = true;
  }

  // ---------- Smooth layout ----------

  /** Until what time layout reordering is shown smoothly. */
  layoutAnimUntil = 0;
  /** Nodes in transit: offset (world) from the new place at the start, and the start time. */
  private glides = new Map<SceneNode, { dx: number; dy: number; t0: number }>();

  /** Show layout reordering smoothly for the next ms (lifting a layer out of auto layout). */
  glideLayout(ms = 350) {
    this.layoutAnimUntil = Math.max(this.layoutAnimUntil, performance.now() + ms);
  }

  /** Remaining offset of a node in transit (world). */
  private glideOffset(n: SceneNode, now: number): [number, number] {
    const g = this.glides.get(n);
    if (!g) return [0, 0];
    const k = (1 - Math.min(1, (now - g.t0) / GLIDE_MS)) ** 3;
    return [g.dx * k, g.dy * k];
  }

  /** Where nodes from layout edits are visible right now (including the ongoing travel). */
  private glideStarts(ops: Op[]): Map<SceneNode, [number, number]> | null {
    const now = performance.now();
    const live = new Set(this.live?.ids ?? []);
    const out = new Map<SceneNode, [number, number]>();
    for (const o of ops) {
      if (o.op !== 'set' || !('transform' in o.props) || live.has(o.id)) continue;
      const n = this.scene.node(o.id);
      if (!n) continue;
      if (this.shaderRoot(n)) continue;
      const m = this.scene.worldMatrix(n);
      const [ox, oy] = this.glideOffset(n, now);
      out.set(n, [m[2] + ox, m[5] + oy]);
    }
    return out.size ? out : null;
  }

  /** Nodes moved by layout travel from the old place to the new one. */
  private startGlides(from: Map<SceneNode, [number, number]>) {
    const now = performance.now();
    for (const [n, [x0, y0]] of from) {
      if (this.scene.id(n) === undefined) continue;
      const m = this.scene.worldMatrix(n);
      const dx = x0 - m[2];
      const dy = y0 - m[5];
      if (Math.hypot(dx, dy) * this.camera.zoom < 0.5) this.glides.delete(n);
      else this.glides.set(n, { dx, dy, t0: now });
    }
    // Nested ones travel together with their ancestor.
    for (const n of [...this.glides.keys()]) {
      for (let p = this.scene.parent(n); p; p = this.scene.parent(p)) {
        if (this.glides.has(p)) {
          this.glides.delete(n);
          break;
        }
      }
    }
    this.syncExcluded();
    this.dirty = true;
  }

  /** Outside tiles: dragged and traveling nodes (drawn on top). */
  private syncExcluded() {
    this.renderer.setExcluded([...(this.live?.nodes ?? []), ...this.glides.keys()]);
  }

  private drawGlides(canvas: Canvas) {
    if (!this.glides.size) return;
    const now = performance.now();
    const d = this.camera.zoom * this.dpr;
    const view = this.viewportRect();
    canvas.save();
    canvas.concat([d, 0, -this.camera.x * d, 0, d, -this.camera.y * d, 0, 0, 1]);
    const done: SceneNode[] = [];
    for (const [n, g] of this.glides) {
      if (this.scene.id(n) === undefined) {
        done.push(n);
        continue;
      }
      const [ox, oy] = this.glideOffset(n, now);
      const pw = this.scene.worldProj(this.scene.parent(n));
      this.renderer.renderLive(canvas, n, pw.length === 9 ? mul3([1, 0, ox, 0, 1, oy, 0, 0, 1], pw) : [pw[0]!, pw[1]!, pw[2]! + ox, pw[3]!, pw[4]!, pw[5]! + oy], [view[0] - ox, view[1] - oy, view[2] - ox, view[3] - oy], d);
      if (now - g.t0 >= GLIDE_MS) done.push(n);
    }
    canvas.restore();
    if (done.length) {
      for (const n of done) {
        this.glides.delete(n);
        const b = this.renderer.boundsOf(n);
        if (b) this.tiles.invalidateRect(b);
      }
      this.syncExcluded();
    }
    this.dirty = true;
  }

  private drawLive(surface: Surface, canvas: Canvas) {
    const live = this.live;
    if (!live) return;
    const d = this.camera.zoom * this.dpr;
    const viewport: Rect = [this.camera.x, this.camera.y, this.camera.x + this.viewW / this.camera.zoom, this.camera.y + this.viewH / this.camera.zoom];
    const direct = () => {
      canvas.save();
      canvas.concat([d, 0, -this.camera.x * d, 0, d, -this.camera.y * d, 0, 0, 1]);
      for (const n of live.nodes) this.renderer.renderLive(canvas, n, this.scene.worldProj(this.scene.parent(n)), viewport, d);
      canvas.restore();
    };
    if (live.mode === 'hidden') return; // the node shows a text editing field
    if (live.mode === 'direct') return direct();
    // Moving: the texture is drawn once (and on zoom change), then only shifted.
    const ref = this.scene.worldMatrix(live.nodes[0]!);
    if (!live.cache || live.cache.zoom !== d) {
      live.cache?.image.delete();
      live.cache = null;
      let box: Rect | null = null;
      for (const n of live.nodes) {
        const b = this.renderer.boundsOf(n);
        if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [...b];
      }
      if (!box) return;
      const w = Math.ceil((box[2] - box[0]) * d);
      const h = Math.ceil((box[3] - box[1]) * d);
      // Texture too large — draw directly.
      if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return direct();
      const off = surface.makeSurface({ width: w, height: h, colorType: this.ck.ColorType.RGBA_8888, alphaType: this.ck.AlphaType.Premul, colorSpace: this.ck.ColorSpace.SRGB });
      if (!off) return direct();
      const c = off.getCanvas();
      c.clear(this.ck.TRANSPARENT);
      c.concat([d, 0, -box[0] * d, 0, d, -box[1] * d, 0, 0, 1]);
      for (const n of live.nodes) this.renderer.renderLive(c, n, this.scene.worldProj(this.scene.parent(n)), box, d);
      live.cache = { image: off.makeImageSnapshot(), zoom: d, x0: box[0], y0: box[1], ref };
      off.delete();
    }
    const cache = live.cache;
    const dx = ref[2] - cache.ref[2];
    const dy = ref[5] - cache.ref[5];
    canvas.drawImage(cache.image, Math.round((cache.x0 + dx - this.camera.x) * d), Math.round((cache.y0 + dy - this.camera.y) * d));
  }

  // ---------- Export ----------

  /**
   * Render a node to an image (PNG or JPEG) at scale — by the same rules as the canvas.
   * Draw in 2048 px chunks on the GPU and assemble into one buffer; side no more than 8192 px
   * (the scale is reduced). Before drawing, wait for images of the needed resolution and fonts.
   */
  /**
   * Image of nodes; RGBA — raw uncompressed pixels (PDF embeds). rect — what was captured (page
   * coordinates). region — capture this area (slice); shadows — only the nodes' shadows (PDF: shadow as an image).
   */
  private shaderTick = 0;
  /** Animated shaders on screen: advance time and redraw their tiles (30 times per second). */
  stepShaders(now: number) {
    if (!this.tiles?.hasImage(SHADER_CLOCK) || now - this.shaderTick < 33) return;
    this.shaderTick = now;
    this.renderer.time = now / 1000;
    this.tiles.invalidateImage(SHADER_CLOCK);
    this.dirty = true;
  }

  /** Shader code compilation error (null — compiles). */
  shaderError(code: string, kind: 'fill' | 'effect' = 'fill'): string | null {
    return this.renderer.shaderError(code, kind);
  }

  async exportImage(ids: string[], scale: number, format: 'PNG' | 'JPEG' | 'WEBP' | 'AVIF' | 'RGBA', opts: { region?: Rect; shadows?: 'drop' | 'inner'; warm?: boolean; quality?: number; lottieTime?: number } = {}): Promise<{ bytes: Uint8Array; width: number; height: number; scale: number; rect: Rect }> {
    const ck = this.ck;
    // Several nodes — one image, in layer order.
    const order = new Map<string, number>();
    if (ids.length > 1) {
      let i = 0;
      for (const id of this.doc.descendants(this.pageId)) order.set(id, i++);
    }
    const nodes = [...ids]
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .map((id) => this.scene.node(id))
      .filter((n): n is SceneNode => !!n && !!this.renderer.boundsOf(n));
    if (!nodes.length || !this.surface) throw new Error('Нечего экспортировать');
    let r: Rect = opts.region ? [...opts.region] : this.renderBounds(ids)!;
    const MAX = 8192;
    const s = Math.min(scale, MAX / Math.max(1e-6, r[2] - r[0]), MAX / Math.max(1e-6, r[3] - r[1]));
    const W = Math.max(1, Math.ceil((r[2] - r[0]) * s - 1e-6));
    const H = Math.max(1, Math.ceil((r[3] - r[1]) * s - 1e-6));
    const parents = nodes.map((n) => this.scene.worldProj(this.scene.parent(n)));
    const TILE = 2048;
    const tile = this.surface.makeSurface({ width: Math.min(TILE, W), height: Math.min(TILE, H), colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB });
    if (!tile) throw new Error('Не удалось создать поверхность для экспорта');
    const exportImages = new ImageCache(ck, { readImage: hash => this.store.readImage(hash) }, () => {});
    const exportRenderer = new SceneRenderer(ck, this.scene.blobs, exportImages);
    exportRenderer.setFonts(this.fonts); exportRenderer.setVideos(this.videos); exportRenderer.setLotties(this.lotties); exportRenderer.setModels(this.models);
    // Timeline frame: Lottie at the same moment (otherwise by the clock, as on the canvas).
    if (opts.lottieTime !== undefined) exportRenderer.lottieTime = exportRenderer.modelTime = opts.lottieTime;
    const canvas = tile.getCanvas();
    const drawTile = (tx: number, ty: number) => {
      canvas.clear(format === 'JPEG' ? ck.WHITE : ck.TRANSPARENT);
      canvas.save();
      canvas.concat([s, 0, -tx - r[0] * s, 0, s, -ty - r[1] * s, 0, 0, 1]);
      const view: Rect = [r[0] + tx / s, r[1] + ty / s, r[0] + (tx + TILE) / s, r[1] + (ty + TILE) / s];
      nodes.forEach((n, i) => (opts.shadows ? exportRenderer.renderShadows(canvas, n, parents[i]!, view, s, opts.shadows) : exportRenderer.renderLive(canvas, n, parents[i]!, view, s)));
      canvas.restore();
    };
    const tiles: [number, number][] = [];
    for (let ty = 0; ty < H; ty += TILE) for (let tx = 0; tx < W; tx += TILE) tiles.push([tx, ty]);
    try {
      // Warm-up pass: the render requests images of the needed resolution and fonts; wait for them
      // (everything already loaded — straight to the snapshot).
      // The export owns a fresh original-only cache, including subsequent animation frames.
      for (let round = 0; round < 3 && !(round === 0 && opts.shadows); round++) {
        for (const [tx, ty] of tiles) drawTile(tx, ty);
        tile.flush();
        await exportRenderer.waitShaders();
        const t0 = performance.now();
        await new Promise((res) => setTimeout(res, 30));
        if (exportImages.idle && this.fonts.idle && this.lotties.idle && this.models.idle) break;
        while (!(exportImages.idle && this.fonts.idle && this.lotties.idle && this.models.idle) && performance.now() - t0 < 15000) await new Promise((res) => setTimeout(res, 30));
      }
      const pixels = new Uint8Array(W * H * 4);
      for (const [tx, ty] of tiles) {
        drawTile(tx, ty);
        const tw = Math.min(TILE, W - tx);
        const th = Math.min(TILE, H - ty);
        const data = canvas.readPixels(0, 0, { width: tw, height: th, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array | null;
        if (!data) throw new Error('Не удалось прочитать пиксели');
        for (let row = 0; row < th; row++) pixels.set(data.subarray(row * tw * 4, (row + 1) * tw * 4), ((ty + row) * W + tx) * 4);
      }
      if (format === 'RGBA') return { bytes: pixels, width: W, height: H, scale: s, rect: r };
      // AVIF: the browser's AV1 (WebCodecs) and our own container — convertToBlob can't do it.
      if (format === 'AVIF') return { bytes: await encodeAvif(pixels, W, H, opts.quality ?? 80), width: W, height: H, scale: s, rect: r };
      // Everything else is encoded by the browser (faster than WASM encoders): PNG, JPEG, WebP.
      const oc = new OffscreenCanvas(W, H);
      oc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), W, H), 0, 0);
      const type = format === 'PNG' ? 'image/png' : format === 'WEBP' ? 'image/webp' : 'image/jpeg';
      const blob = await oc.convertToBlob({ type, quality: (opts.quality ?? (format === 'WEBP' ? 90 : 92)) / 100 });
      if (blob.type !== type) throw new Error(`Браузер не умеет ${format}`);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width: W, height: H, scale: s, rect: r };
    } finally {
      exportRenderer.dispose(); exportImages.dispose();
      tile.delete();
      this.dirty = true;
    }
  }

  /**
   * Thumbnail of a node from any page (including the service page): PNG with a side no more than size px.
   * Its own scene of one node; images and fonts are shared with the canvas.
   */
  async renderThumbnail(id: string, size: number): Promise<Blob | null> {
    return (await this.renderNode(id, size))?.blob ?? null;
  }

  /**
   * Layer image no more than size px per side — from this document or another (a file version,
   * a component playground). rect — what was captured (page coordinates of that document).
   * opts.scale — scale instead of size (plugins' exportAsync: a layer from any page), type — PNG or JPEG.
   */
  async renderNode(id: string, size: number, doc: Document = this.doc, opts: { scale?: number; type?: 'image/png' | 'image/jpeg' } = {}): Promise<{ blob: Blob; rect: Rect } | null> {
    const ck = this.ck;
    const parent = doc.parent(id);
    if (!parent || !this.surface) return null;
    const scene = new CoreScene(doc, parent, [id]);
    const images = opts.scale === undefined ? this.images : new ImageCache(ck, { readImage: hash => this.store.readImage(hash) }, () => {});
    const renderer = new SceneRenderer(ck, scene.blobs, images);
    renderer.setFonts(this.fonts);
    scene.attach(renderer);
    try {
      const n = scene.node(id);
      const b = n && renderer.boundsOf(n);
      if (!n || !b) return null;
      const r: Rect = [b[0] + 2, b[1] + 2, b[2] - 2, b[3] - 2];
      const w0 = Math.max(1e-6, r[2] - r[0]);
      const h0 = Math.max(1e-6, r[3] - r[1]);
      const s = opts.scale !== undefined ? Math.min(opts.scale, 8192 / w0, 8192 / h0) : Math.min(size / w0, size / h0, 4);
      const W = Math.max(1, Math.ceil(w0 * s));
      const H = Math.max(1, Math.ceil(h0 * s));
      const surf = this.surface.makeSurface({ width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB });
      if (!surf) return null;
      const canvas = surf.getCanvas();
      const draw = () => {
        canvas.clear(opts.type === 'image/jpeg' ? ck.WHITE : ck.TRANSPARENT);
        canvas.save();
        canvas.concat([s, 0, -r[0] * s, 0, s, -r[1] * s, 0, 0, 1]);
        renderer.renderLive(canvas, n, [1, 0, 0, 0, 1, 0], r, s);
        canvas.restore();
        surf.flush();
      };
      try {
        draw();
        await renderer.waitShaders();
        // Images and fonts are still loading — redraw when they arrive (briefly).
        for (let i = 0; i < (opts.scale === undefined ? 40 : 300) && !(images.idle && this.fonts.idle); i++) await new Promise((res) => setTimeout(res, 50));
        draw();
        const data = canvas.readPixels(0, 0, { width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array | null;
        if (!data) return null;
        const oc = new OffscreenCanvas(W, H);
        oc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0);
        return { blob: await oc.convertToBlob({ type: opts.type ?? 'image/png', quality: 0.92 }), rect: r };
      } finally {
        surf.delete();
        this.dirty = true;
      }
    } finally {
      renderer.dispose();
      if (images !== this.images) images.dispose();
    }
  }

  /**
   * A layer of the open page in its own coordinates (without its position and rotation), with effects
   * and children: PNG at scale and what was captured (layer coordinates). For animation export.
   */
  async renderLocal(id: string, scale: number): Promise<{ bytes: Uint8Array; rect: Rect; scale: number } | null> {
    const ck = this.ck;
    const n = this.scene.node(id);
    if (!n || !this.surface) return null;
    const b = this.renderer.contentBounds(n);
    const r: Rect = [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])];
    const s = Math.min(scale, 4096 / Math.max(1, r[2] - r[0]), 4096 / Math.max(1, r[3] - r[1]));
    const W = Math.max(1, Math.ceil((r[2] - r[0]) * s));
    const H = Math.max(1, Math.ceil((r[3] - r[1]) * s));
    const surf = this.surface.makeSurface({ width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB });
    if (!surf) return null;
    const images = new ImageCache(ck, { readImage: hash => this.store.readImage(hash) }, () => {});
    const renderer = new SceneRenderer(ck, this.scene.blobs, images);
    renderer.setFonts(this.fonts); renderer.setVideos(this.videos); renderer.setLotties(this.lotties); renderer.setModels(this.models);
    const canvas = surf.getCanvas();
    // Parent's world matrix — the inverse of its own: the layer is drawn in its own coordinates.
    const parent = invert(n.transform as Matrix) as Matrix2D;
    const draw = () => {
      canvas.clear(ck.TRANSPARENT);
      canvas.save();
      canvas.concat([s, 0, -r[0] * s, 0, s, -r[1] * s, 0, 0, 1]);
      // Clipping by bounds — in page coordinates: the area is the whole layer there.
      renderer.renderLive(canvas, n, parent, this.renderer.boundsOf(n) ?? r, s);
      canvas.restore();
      surf.flush();
    };
    try {
      draw();
      await renderer.waitShaders();
      for (let i = 0; i < 300 && !(images.idle && this.fonts.idle); i++) await new Promise((res) => setTimeout(res, 50));
      draw();
      const data = canvas.readPixels(0, 0, { width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array | null;
      if (!data) return null;
      const oc = new OffscreenCanvas(W, H);
      oc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/png' });
      return { bytes: new Uint8Array(await blob.arrayBuffer()), rect: r, scale: s };
    } finally {
      renderer.dispose(); images.dispose();
      surf.delete();
      this.dirty = true;
    }
  }

  // ---------- Camera ----------

  /** Visible canvas area in world coordinates. */
  viewportRect(): Rect {
    const z = this.camera.zoom;
    return [this.camera.x, this.camera.y, this.camera.x + this.viewW / z, this.camera.y + this.viewH / z];
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [this.camera.x + sx / this.camera.zoom, this.camera.y + sy / this.camera.zoom];
  }

  worldToScreen(x: number, y: number): [number, number] {
    return [(x - this.camera.x) * this.camera.zoom, (y - this.camera.y) * this.camera.zoom];
  }

  get viewW() {
    return this.canvasEl.clientWidth;
  }

  get viewH() {
    return this.canvasEl.clientHeight;
  }

  /** Camera immediately (canvas drag, touchpad, programmatic jumps): smooth transitions are canceled. */
  setCamera(c: Camera) {
    this.zoomGoal = this.panGoal = this.flight = null;
    this.applyCamera(c);
  }

  private applyCamera(c: Camera) {
    // Guard: the camera doesn't go beyond ±10 million px and doesn't accept NaN (otherwise tiles and rendering at such
    // coordinates eat memory).
    const lim = (v: number) => (Number.isFinite(v) ? Math.max(-CAMERA_LIMIT, Math.min(CAMERA_LIMIT, v)) : 0);
    this.camera = { x: lim(c.x), y: lim(c.y), zoom: clampZoom(Number.isFinite(c.zoom) ? c.zoom : this.camera.zoom) };
    this.dirty = true;
    for (const cb of this.onCamera) cb();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const zoom = clampZoom(this.camera.zoom * factor);
    this.setCamera({ zoom, x: wx - sx / zoom, y: wy - sy / zoom });
  }

  // ---------- Smooth camera ----------
  // A mouse wheel click is a big step: the camera catches up with the target in ~150 ms (without a jerk).
  // A touchpad sends small steps often — they are applied immediately (setCamera, zoomAt).

  /** Zoom target from wheel clicks; the screen point (sx, sy) stays under the cursor. */
  private zoomGoal: { zoom: number; sx: number; sy: number } | null = null;
  /** Remaining scroll from wheel clicks, screen px. */
  private panGoal: { x: number; y: number } | null = null;
  /** Flight to a camera (zoom to fit, to selection, 100%, zoom keys). */
  private flight: { from: Camera; to: Camera; t0: number; ms: number } | null = null;
  private stepAt = 0;

  /** Zoom by a wheel click: smoothly, toward the target. */
  zoomSmooth(sx: number, sy: number, factor: number) {
    if (!this.zoomGoal && !this.panGoal) this.stepAt = performance.now();
    this.flight = null;
    this.zoomGoal = { zoom: clampZoom((this.zoomGoal?.zoom ?? this.camera.zoom) * factor), sx, sy };
    this.dirty = true;
  }

  /** Scroll by a wheel click (screen px): smoothly. */
  panSmooth(dx: number, dy: number) {
    if (!this.zoomGoal && !this.panGoal) this.stepAt = performance.now();
    this.flight = null;
    this.panGoal = { x: (this.panGoal?.x ?? 0) + dx, y: (this.panGoal?.y ?? 0) + dy };
    this.dirty = true;
  }

  /** Smooth transition to a camera (zoom — logarithmic, screen center — linear). */
  flyTo(to: Camera, ms = 260) {
    this.zoomGoal = this.panGoal = null;
    this.flight = { from: { ...this.camera }, to: { ...to, zoom: clampZoom(to.zoom) }, t0: performance.now(), ms };
    this.dirty = true;
  }

  /** Camera in motion (smooth scroll, zoom or flight). */
  get cameraMoving(): boolean {
    return !!(this.zoomGoal || this.panGoal || this.flight);
  }

  /** Smooth camera step — from the render loop. */
  stepCamera(now: number) {
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.t0) / f.ms);
      const e = 1 - (1 - t) ** 3;
      const [w, h] = [this.viewW / 2, this.viewH / 2];
      const zoom = Math.exp(Math.log(f.from.zoom) + (Math.log(f.to.zoom) - Math.log(f.from.zoom)) * e);
      const cx = f.from.x + w / f.from.zoom + (f.to.x + w / f.to.zoom - (f.from.x + w / f.from.zoom)) * e;
      const cy = f.from.y + h / f.from.zoom + (f.to.y + h / f.to.zoom - (f.from.y + h / f.from.zoom)) * e;
      if (t >= 1) this.flight = null;
      this.applyCamera(t >= 1 ? f.to : { zoom, x: cx - w / zoom, y: cy - h / zoom });
      return;
    }
    if (!this.zoomGoal && !this.panGoal) return;
    const dt = Math.min(64, Math.max(1, now - this.stepAt));
    this.stepAt = now;
    const k = 1 - Math.exp(-dt / WHEEL_TAU);
    let { x, y, zoom } = this.camera;
    const pan = this.panGoal;
    if (pan) {
      const done = Math.hypot(pan.x * (1 - k), pan.y * (1 - k)) < 0.5;
      const ax = done ? pan.x : pan.x * k;
      const ay = done ? pan.y : pan.y * k;
      x += ax / zoom;
      y += ay / zoom;
      this.panGoal = done ? null : { x: pan.x - ax, y: pan.y - ay };
    }
    const g = this.zoomGoal;
    if (g) {
      const ratio = g.zoom / zoom;
      const next = Math.abs(Math.log(ratio)) < 0.002 ? g.zoom : zoom * ratio ** k;
      const wx = x + g.sx / zoom;
      const wy = y + g.sy / zoom;
      x = wx - g.sx / next;
      y = wy - g.sy / next;
      zoom = next;
      if (next === g.zoom) this.zoomGoal = null;
    }
    this.applyCamera({ x, y, zoom });
  }

  /** Camera at which the rectangle is fully visible (with margins). */
  private cameraFor(r: Rect, maxZoom: number): Camera {
    const pad = 60;
    const zoom = clampZoom(Math.min(maxZoom, (this.viewW - pad * 2) / Math.max(1, r[2] - r[0]), (this.viewH - pad * 2) / Math.max(1, r[3] - r[1])));
    return { zoom, x: (r[0] + r[2]) / 2 - this.viewW / 2 / zoom, y: (r[1] + r[3]) / 2 - this.viewH / 2 / zoom };
  }

  /** Show a rectangle; animate — with a smooth flight (keyboard shortcuts, menu). */
  fitRect(r: Rect | null, maxZoom = 8, animate = false) {
    if (!r) return;
    const c = this.cameraFor(r, maxZoom);
    if (animate) this.flyTo(c);
    else this.setCamera(c);
  }

  fitPage(animate = false) {
    const ids = this.doc.children(this.pageId).filter((id) => this.doc.get(id, 'visible') !== false);
    this.fitRect(this.selectionBounds(ids), 1, animate);
  }

  zoomTo100(animate = false) {
    const [cx, cy] = this.screenToWorld(this.viewW / 2, this.viewH / 2);
    const c = { zoom: 1, x: cx - this.viewW / 2, y: cy - this.viewH / 2 };
    if (animate) this.flyTo(c);
    else this.setCamera(c);
  }

  /** Zoom toward the screen center with a flight (+/− keys, menu). */
  zoomCenter(factor: number) {
    const base = this.flight?.to ?? this.camera;
    const zoom = clampZoom(base.zoom * factor);
    const cx = base.x + this.viewW / 2 / base.zoom;
    const cy = base.y + this.viewH / 2 / base.zoom;
    this.flyTo({ zoom, x: cx - this.viewW / 2 / zoom, y: cy - this.viewH / 2 / zoom }, 180);
  }

  // ---------- Rendering ----------

  webgl(): WebGL2RenderingContext | null {
    return this.canvasEl.getContext('webgl2') as WebGL2RenderingContext | null;
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvasEl.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvasEl.clientHeight * this.dpr));
    if (this.canvasEl.width === w && this.canvasEl.height === h && this.surface) return;
    this.canvasEl.width = w;
    this.canvasEl.height = h;
    this.surface?.delete();
    this.surface = this.ck.MakeWebGLCanvasSurface(this.canvasEl);
    // Tiles are bound to the surface's GPU context.
    if (this.scene) {
      this.tiles?.dispose();
      this.tiles = new TileCache(this.ck, this.renderer, this.visibleRoots, this.webgl());
      this.firstFrame = true;
      for (const c of this.pageCache.values()) {
        c.tiles?.dispose();
        c.tiles = null;
      }
    }
    this.dirty = true;
  }

  draw() {
    const surface = this.surface;
    if (!surface) return;
    const t0 = performance.now();
    const canvas = surface.getCanvas();
    const bg = this.scene.page.backgroundColor ?? { r: 0.96, g: 0.96, b: 0.96 };
    canvas.clear(this.ck.Color4f(bg.r, bg.g, bg.b, 1));
    // While a layer is dragged (and auto layout neighbors travel), missing tiles — only within the budget.
    const busy = !!this.live || this.glides.size > 0;
    const more = this.tiles.draw(surface, canvas, this.camera, this.dpr, this.viewW, this.viewH, this.firstFrame, busy, this.pixelPreview);
    this.firstFrame = false;
    this.drawFrameRegions(canvas, bg);
    this.drawGlides(canvas);
    this.drawLive(surface, canvas);
    this.drawOverlay(canvas);
    surface.flush();
    this.lastFrameMs = performance.now() - t0;
    if (more) this.dirty = true;
  }

  /**
   * Videos and animated images on screen: their area is redrawn every frame over the
   * tiles (the page background and all layers in it — with overlaps and clipping), while the tiles themselves
   * are not redrawn for every video frame. The area follows the layer bounds, aligned to pixels.
   */
  private drawFrameRegions(canvas: Canvas, bg: { r: number; g: number; b: number }) {
    const nodes = this.renderer.frameNodes;
    if (!nodes.size) return;
    const d = this.camera.zoom * this.dpr;
    const view = this.viewportRect();
    const regions: Rect[] = [];
    for (const n of nodes) {
      if (this.scene.id(n) === undefined || !this.renderer.hasFrameFill(n)) {
        nodes.delete(n);
        continue;
      }
      const b = this.renderer.boundsOf(n);
      if (!n.visible || !b || b[0] >= view[2] || b[2] <= view[0] || b[1] >= view[3] || b[3] <= view[1]) continue;
      // Device pixels are whole (no semi-transparent seam along the area edge).
      const px = (v: number, o: number, up: boolean) => (up ? Math.ceil((v - o) * d) : Math.floor((v - o) * d)) / d + o;
      regions.push([
        px(Math.max(b[0], view[0]), this.camera.x, false),
        px(Math.max(b[1], view[1]), this.camera.y, false),
        px(Math.min(b[2], view[2]), this.camera.x, true),
        px(Math.min(b[3], view[3]), this.camera.y, true),
      ]);
    }
    if (!regions.length) return;
    const ck = this.ck;
    canvas.save();
    canvas.concat([d, 0, -this.camera.x * d, 0, d, -this.camera.y * d, 0, 0, 1]);
    for (const r of regions) {
      canvas.save();
      canvas.clipRect(ck.LTRBRect(r[0], r[1], r[2], r[3]), ck.ClipOp.Intersect, false);
      canvas.clear(ck.Color4f(bg.r, bg.g, bg.b, 1));
      this.renderer.render(canvas, this.visibleRoots, r, d);
      canvas.restore();
    }
    canvas.restore();
    // Lottie is playing — draw the next frame too.
    if (this.renderer.takeLottieAnimated()) this.dirty = true;
  }

  private drawOverlay(canvas: Canvas) {
    const ck = this.ck;
    const d = this.dpr;
    canvas.save();
    canvas.scale(d, d);
    const toScreen = (pts: [number, number][]) => pts.map(([x, y]) => this.worldToScreen(x, y));
    const polygon = (pts: [number, number][], paint: Paint) => {
      const b = new ck.PathBuilder();
      pts.forEach(([x, y], i) => (i ? b.lineTo(x, y) : b.moveTo(x, y)));
      b.close();
      const path = b.detachAndDelete();
      canvas.drawPath(path, paint);
      path.delete();
    };
    for (const u of this.underlays) u(canvas);
    if (this.hover && !this.selection.includes(this.hover) && this.doc.has(this.hover)) {
      polygon(toScreen(this.visualCorners(this.hover)), this.paints.hover);
    }
    for (const id of this.selection) {
      // 3D: the visible projection with the selection outline, the flat box (it has the handles) — fainter.
      if (this.in3d(id)) {
        polygon(toScreen(this.visualCorners(id)), this.paints.sel);
        polygon(toScreen(this.corners(id)), this.paints.flat);
      } else polygon(toScreen(this.corners(id)), this.paints.sel);
    }
    // Key object — with a thick box.
    if (this.keyObject && this.selection.includes(this.keyObject) && this.doc.has(this.keyObject)) polygon(toScreen(this.corners(this.keyObject)), this.paints.key);
    // Handles: for one node — by its rotated bounds, for several — by the common bounds.
    const handles = this.handlePositions();
    if (handles.length && this.selection.length > 1) {
      const b = this.selectionBounds()!;
      const [x0, y0] = this.worldToScreen(b[0], b[1]);
      const [x1, y1] = this.worldToScreen(b[2], b[3]);
      canvas.drawRect(ck.LTRBRect(x0, y0, x1, y1), this.paints.sel);
    }
    for (const [x, y] of handles) {
      if (Number.isNaN(x)) continue;
      const r = ck.XYWHRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      canvas.drawRect(r, this.paints.handleFill);
      canvas.drawRect(r, this.paints.handleStroke);
    }
    // Pivot point: during rotation and when it is not at the center.
    if (handles.length && (this.rotating || this.rotationOrigin[0] !== 0.5 || this.rotationOrigin[1] !== 0.5)) {
      const p = this.rotationPivot();
      if (p) {
        const [x, y] = this.worldToScreen(p[0], p[1]);
        canvas.drawLine(x - 7, y, x + 7, y, this.paints.handleStroke);
        canvas.drawLine(x, y - 7, x, y + 7, this.paints.handleStroke);
        canvas.drawCircle(x, y, 3.5, this.paints.handleFill);
        canvas.drawCircle(x, y, 3.5, this.paints.handleStroke);
      }
    }
    if (this.drop && this.drop.target !== this.pageId && this.doc.has(this.drop.target)) {
      polygon(toScreen(this.corners(this.drop.target)), this.paints.hover);
      // The grid cell where the layer will land.
      if (this.drop.cell) polygon(toScreen(this.drop.cell), this.paints.dropLine);
      if (this.drop.line) {
        const [x0, y0] = this.worldToScreen(this.drop.line[0], this.drop.line[1]);
        const [x1, y1] = this.worldToScreen(this.drop.line[2], this.drop.line[3]);
        canvas.drawLine(x0, y0, x1, y1, this.paints.dropLine);
      }
    }
    // Guides on whole screen pixels so that a 1 px line is crisp.
    for (const [ax, ay, bx, by] of this.guides) {
      const [x0, y0] = this.worldToScreen(ax, ay);
      const [x1, y1] = this.worldToScreen(bx, by);
      const px = (v: number) => Math.round(v) + 0.5;
      if (ax === bx) canvas.drawLine(px(x0), y0, px(x1), y1, this.paints.guide);
      else canvas.drawLine(x0, px(y0), x1, px(y1), this.paints.guide);
    }
    if (this.marquee) {
      const [x0, y0] = this.worldToScreen(this.marquee[0], this.marquee[1]);
      const [x1, y1] = this.worldToScreen(this.marquee[2], this.marquee[3]);
      const r = ck.LTRBRect(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
      canvas.drawRect(r, this.paints.marqueeFill);
      canvas.drawRect(r, this.paints.marqueeStroke);
    }
    this.drawPixelGrid(canvas);
    for (const o of this.overlays) o(canvas);
    canvas.restore();
  }

  /** Pixel grid from 800% zoom: lines at whole page coordinates. */
  private drawPixelGrid(canvas: Canvas) {
    const z = this.camera.zoom;
    if (!this.pixelGrid || z < 8) return;
    const ck = this.ck;
    const bg = this.doc.get(this.pageId, 'backgrounds')?.[0];
    const c = bg?.type === 'SOLID' ? bg.color : { r: 0.96, g: 0.96, b: 0.96 };
    const dark = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b < 0.5;
    const paint = new ck.Paint();
    paint.setColor(dark ? ck.Color(255, 255, 255, 0.08) : ck.Color(0, 0, 0, 0.08));
    paint.setStrokeWidth(1);
    const [x0, y0, x1, y1] = this.viewportRect();
    for (let x = Math.ceil(x0); x <= x1; x++) {
      const sx = Math.round((x - this.camera.x) * z) + 0.5;
      canvas.drawLine(sx, 0, sx, this.viewH, paint);
    }
    for (let y = Math.ceil(y0); y <= y1; y++) {
      const sy = Math.round((y - this.camera.y) * z) + 0.5;
      canvas.drawLine(0, sy, this.viewW, sy, paint);
    }
    paint.delete();
  }

  /**
   * Resize handles (screen coordinates): 0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w.
   * For one node — by its rotated bounds, for several — by the common bounds.
   */
  handlePositions(): [number, number][] {
    if (!this.selection.length || (this.tool !== 'select' && this.tool !== 'scale') || this.hideHandles || this.devMode) return [];
    let c: [number, number][];
    if (this.selection.length === 1) c = this.corners(this.selection[0]!).map(([x, y]) => this.worldToScreen(x, y));
    else {
      const b = this.selectionBounds()!;
      c = [
        this.worldToScreen(b[0], b[1]),
        this.worldToScreen(b[2], b[1]),
        this.worldToScreen(b[2], b[3]),
        this.worldToScreen(b[0], b[3]),
      ];
    }
    const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const all: [number, number][] = [c[0]!, mid(c[0]!, c[1]!), c[1]!, mid(c[1]!, c[2]!), c[2]!, mid(c[2]!, c[3]!), c[3]!, mid(c[3]!, c[0]!)];
    // A line has only end handles (3 and 7), the others are unavailable.
    if (this.selection.length === 1 && this.doc.type(this.selection[0]!) === 'LINE') return all.map((p, i) => (i === 3 || i === 7 ? p : [NaN, NaN]));
    return all;
  }

  /** Scene node by document id (for hit testing under the cursor). */
  sceneNode(id: string): SceneNode | undefined {
    return this.scene.node(id);
  }
}
