// Prototype presentation: screen and overlays from its own copy of the document, transitions
// (dissolve, move, slide, push, morph), scrolling with fixed and sticky layers,
// interactive components, hotspot highlighting on clicks outside them.
//
// The logic (what leads where) lives in PrototypeSession (@mfp/core); here — geometry, input and rendering.
// Screen animation (frame timeline) plays from the moment a screen or overlay is shown — as a pose in the copy.

import type { CanvasKit, Image, Paint as SkPaint, Surface } from 'canvaskit-wasm';
import { DesignSync, PrototypeSession, animatedNodes, timelinePlayback, pageOf, easingFunction, framePose, reactionsOf, timelineDuration, reverseTransition, transitionDuration, type Document, type NodeSnapshot, type Op, type OverlayState, type Paint, type SessionEvent, type Transition } from '@mfp/core';
import { CoreScene, ImageCache, SceneRenderer, toFigPaint, type FontLibrary } from '@mfp/renderer';
import type { FigPaint, ImageBytesSource, SceneNode } from '@mfp/io-figma';
import { deviceKind, drawFrameBody, drawFrameOverlay, frameGeometry } from './device-frame.ts';
import { PlayerVideos } from './videos.ts';
import { PlayerLotties } from './lotties.ts';
import { PlayerModels } from './models.ts';
import { interpolateTransform } from './interpolate-transform.ts';
import { interpolateFills } from './interpolate-fills.ts';
import { compensateContainerChildren } from './resize-container.ts';

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 0, 1, 0];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2], a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];
const inv = (m: M): M => {
  const d = m[0] * m[4] - m[1] * m[3] || 1e-12;
  return [m[4] / d, -m[1] / d, (m[1] * m[5] - m[4] * m[2]) / d, -m[3] / d, m[0] / d, (m[3] * m[2] - m[0] * m[5]) / d];
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** No culling: bounds change on the fly during scrolling and animation. */
const ALL: [number, number, number, number] = [-1e9, -1e9, 1e9, 1e9];

interface Layer {
  id: string;
  scene: CoreScene;
  renderer: SceneRenderer;
  root: SceneNode;
  used: number;
}

/** A layer animated by a morph transition. */
interface Lerp {
  sn: SceneNode;
  fromT: M;
  toT: M;
  fromO: number;
  toO: number;
  fromFills?: FigPaint[];
  toFills?: FigPaint[];
  /** A leaf changes size: scale from the “before” size to the “after” size. */
  size?: [number, number, number, number];
  children?: { sn: SceneNode; transform: M }[];
  /** Intermediate fills by step (the renderer caches brushes per fill object — the number of steps is limited). */
  steps?: Map<number, FigPaint[]>;
}

interface Anim {
  kind: 'screen' | 'overlay-open' | 'change' | 'scroll';
  start: number;
  dur: number;
  ease: (p: number) => number;
  transition: Transition | null;
  from?: string | null;
  to?: string;
  overlay?: OverlayState;
  lerps?: Lerp[];
  fadeIn?: { sn: SceneNode; o: number }[];
  hidden?: SceneNode[];
  image?: { img: Image; layer: string; m: M; w: number; h: number };
  scroll?: { container: string; x0: number; y0: number; x1: number; y1: number };
}

export interface PlayerOptions {
  ck: CanvasKit;
  canvas: HTMLCanvasElement;
  doc: Document;
  page: string;
  start: string | null;
  images: ImageBytesSource;
  fonts: FontLibrary;
  /** The screen changed (title, buttons). */
  onScreen?(screen: string | null): void;
  onUrl?(url: string, newTab: boolean): void;
  onError?(message: string): void;
}

export class Player {
  suspended = false;
  setSuspended(value: boolean) { this.suspended = value; this.dirty = true; }
  readonly doc: Document;
  readonly session: PrototypeSession;
  private ck: CanvasKit;
  private canvas: HTMLCanvasElement;
  private surface: Surface | null = null;
  private dpr = 1;
  private sync: DesignSync;
  private layers = new Map<string, Layer>();
  private images: ImageCache;
  private fonts: FontLibrary;
  private anims: Anim[] = [];
  private flashUntil = 0;
  /** Always highlight hotspots. */
  hotspots = false;
  zoom: 'fit' | 'actual' = 'fit';
  /** Device frame around the screen (for the page's device preset). */
  frame = true;
  private dirty = true;
  private raf = 0;
  private down: { x: number; y: number; path: string[] } | null = null;
  private pending: { instance: string; img: Image; layer: string; m: M; w: number; h: number } | null = null;
  private opts: PlayerOptions;
  private paint: SkPaint;
  private disposed = false;
  private cleanup: (() => void)[] = [];
  private videos: PlayerVideos;
  private lotties: PlayerLotties;
  private models: PlayerModels;
  /** Rotating a 3D model by dragging: layer and previous point. */
  private orbitDrag: { node: string; x: number; y: number; id: number } | null = null;

  /** Scrolls during rendering: container → scroll before and after the frame. */
  private scrolled = new Map<string, { prev: { x: number; y: number }; next: { x: number; y: number } }>();

  /** Frame rendered (same tick: the canvas buffer is still intact) — presentation recording copies it. */
  onDrawn: (() => void) | null = null;

  /** Page of the current screen: navigating to a screen on another page — its background and device. */
  private get screenPage(): string {
    const screen = this.session.screen;
    return (screen && this.doc.has(screen) ? pageOf(this.doc, screen) : null) ?? this.opts.page;
  }

  /** Redraw in the next frame (recording started: it needs a frame, and presentation draws only changes). */
  redraw() {
    this.dirty = true;
  }

  constructor(opts: PlayerOptions) {
    this.opts = opts;
    this.ck = opts.ck;
    this.canvas = opts.canvas;
    this.doc = opts.doc;
    this.fonts = opts.fonts;
    this.paint = new this.ck.Paint();
    this.paint.setAntiAlias(true);
    this.images = new ImageCache(this.ck, opts.images, () => (this.dirty = true));
    // Layer videos: own playback, a new frame means redraw; end and time points fire triggers.
    this.videos = new PlayerVideos(
      this.ck,
      this.doc,
      opts.images,
      () => (this.dirty = true),
      (node, kind, from, to) => this.session.media(node, kind, from, to),
    );
    // Layer Lottie: own playback (as with video), the end without loop fires a trigger.
    this.lotties = new PlayerLotties(this.ck, this.doc, opts.images, () => (this.dirty = true), (node) => this.session.media(node, 'end'));
    // Layer 3D models: clip and rotation per layer, the end of a non-looping clip fires a trigger.
    this.models = new PlayerModels(this.ck, this.doc, opts.images, () => (this.dirty = true), (node) => this.session.media(node, 'end'));
    this.sync = new DesignSync(this.doc);
    // Variant switches and variable values change the copy: derived edits immediately, rendering per operation.
    this.doc.onChange((ops: Op[], origin: string) => {
      this.sync.observe(ops);
      if (origin === 'prototype' || origin === 'layout') this.doc.transact(() => this.sync.propagate(ops), 'layout');
      for (const l of this.layers.values()) l.scene.apply(ops);
      this.dirty = true;
    });
    this.fonts.onLoad.push(() => {
      for (const l of this.layers.values()) for (const sn of walkNodes(l.root)) if (sn.type === 'TEXT') l.renderer.forget(sn);
      this.dirty = true;
    });
    this.session = new PrototypeSession(
      this.doc,
      opts.page,
      {
        emit: (e) => this.onEvent(e),
        setTimer: (fn, ms) => {
          const t = window.setTimeout(fn, ms);
          return () => clearTimeout(t);
        },
        willChange: (id) => this.captureBefore(id),
      },
      opts.start,
    );
    this.bindInput();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.canvas);
    this.cleanup.push(() => ro.disconnect());
    this.resize();
    this.session.begin();
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (this.suspended || document.hidden) return;
      this.pollGamepads();
      this.animate(now);
      if (this.dirty || this.anims.length || now < this.flashUntil + 50) this.draw(now);
      this.flushScrolled();
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    this.finishInput();
    this.cancelAnims(() => true);
    for (const u of this.sounds.values()) void u.then((x) => x && URL.revokeObjectURL(x));
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanup) c();
    for (const l of this.layers.values()) l.renderer.dispose();
    this.layers.clear();
    this.images.dispose();
    this.videos.dispose();
    this.lotties.dispose();
    this.models.dispose();
    this.surface?.delete();
    this.paint.delete();
  }

  restart(start?: string | null) {
    this.cancelAnims(() => true);
    this.timelines.clear();
    this.session.begin(start ?? undefined);
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.surface) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.surface?.delete();
    this.surface = this.ck.MakeWebGLCanvasSurface(this.canvas);
    this.dirty = true;
  }

  // ---------- Screen animation ----------

  /** Timelines of shown screens and overlays: start (frame time) and whether it has finished. */
  private timelines = new Map<string, { start: number; done: boolean }>();

  /** Pose of animated layers of shown screens for this frame (outside history, by editing the copy). */
  private animate(now: number) {
    const doc = this.doc;
    const shown = new Set<string>();
    if (this.session.screen) shown.add(this.session.screen);
    for (const o of this.session.overlays) shown.add(o.id);
    for (const a of this.anims) if (a.to) shown.add(a.to);
    // Left the screen — it will restart from the beginning.
    for (const id of [...this.timelines.keys()]) if (!shown.has(id)) this.timelines.delete(id);
    for (const id of shown) {
      let tl = this.timelines.get(id);
      if (!tl) {
        const off = !doc.has(id) || doc.get(id, 'timeline')?.autoplay === false || !animatedNodes(doc, id).length;
        this.timelines.set(id, (tl = { start: now, done: off }));
      }
      if (tl.done) continue;
      const t = (now - tl.start) / 1000;
      const pose = framePose(doc, id, t);
      doc.transact(() => {
        for (const [n, p] of pose) doc.set(n, p);
      }, 'animation');
      if (timelinePlayback(doc.get(id, 'timeline')) === 'ONCE' && t >= timelineDuration(doc, id)) tl.done = true;
    }
  }

  // ---------- Layers ----------

  private layer(id: string): Layer | null {
    let l = this.layers.get(id);
    if (l) {
      l.used = performance.now();
      return l;
    }
    if (!this.doc.has(id)) return null;
    const parent = this.doc.parent(id)!;
    const scene = new CoreScene(this.doc, parent, [id]);
    const renderer = new SceneRenderer(this.ck, scene.blobs, this.images);
    renderer.onShaderFrame = () => { this.dirty = true; };
    renderer.onShaderError = (message) => this.opts.onError?.(message);
    renderer.setFonts(this.fonts);
    scene.attach(renderer);
    const root = scene.node(id);
    if (!root) {
      renderer.dispose();
      return null;
    }
    // Fonts of the texts laid out by the renderer; fill videos — to their layers.
    renderer.setVideos(this.videos);
    renderer.setLotties(this.lotties);
    renderer.setModels(this.models.library);
    for (const sn of walkNodes(root)) {
      const tid = scene.id(sn);
      const f = tid && sn.type === 'TEXT' ? this.doc.get(tid, 'fontName') : undefined;
      if (f) void this.fonts.ensure(f);
      if (tid) for (const fp of sn.fills) if (fp.type === 'VIDEO') this.videos.bind(fp, tid);
      else if (fp.type === 'LOTTIE') this.lotties.bind(fp, tid);
      else if (fp.type === 'MODEL3D') this.models.bind(fp, tid);
    }
    l = { id, scene, renderer, root, used: performance.now() };
    this.layers.set(id, l);
    // Keep a few screens (fast “back”), free the rest.
    if (this.layers.size > 8) {
      const keep = new Set([this.session.screen, ...this.session.overlays.map((o) => o.id), ...this.anims.flatMap((a) => [a.from, a.to, a.overlay?.id])]);
      const old = [...this.layers.values()].filter((x) => !keep.has(x.id)).sort((a, b) => a.used - b.used);
      for (const x of old.slice(0, this.layers.size - 8)) {
        x.renderer.dispose();
        this.layers.delete(x.id);
      }
    }
    return l;
  }

  // ---------- Geometry ----------

  /** Presentation area (in screen units) and its place on the canvas (CSS px). */
  view() {
    const screen = this.session.screen;
    const sw = screen ? (this.doc.get(screen, 'width') ?? 100) : 100;
    const sh = screen ? (this.doc.get(screen, 'height') ?? 100) : 100;
    // The flow's own device takes precedence over the page device.
    const dev = this.session.flowDevice ?? this.doc.get(this.screenPage, 'prototypeDevice') ?? { type: 'PRESENTATION' };
    let [vw, vh] = [sw, sh];
    if ((dev.type === 'PRESET' || dev.type === 'CUSTOM') && dev.size) {
      [vw, vh] = [dev.size.width, dev.size.height];
      if (dev.rotation === 'CCW_90') [vw, vh] = [vh, vw];
    }
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    const margin = 16;
    // The device frame is fitted together with the screen.
    const kind = this.frame ? deviceKind(dev) : null;
    const g = kind ? frameGeometry(kind, vw, vh) : null;
    const [l, t, r, b] = g?.insets ?? [0, 0, 0, 0];
    const fit = Math.min((W - margin * 2) / (vw + l + r), (H - margin * 2) / (vh + t + b));
    const scale = this.zoom === 'fit' ? Math.max(0.05, fit) : 1;
    return { vw, vh, scale, ox: (W - (vw + l + r) * scale) / 2 + l * scale, oy: Math.max(t * scale, (H - (vh + t + b) * scale) / 2 + t * scale), kind, radius: g?.radius ?? 0 };
  }

  /** Screen scrolling (top level): if the screen is larger than the presentation area. */
  private screenScroll(id: string) {
    return this.session.scroll.get(id) ?? { x: 0, y: 0 };
  }

  /** Lay out scrolling of a layer's frames: shift the content, keep fixed and sticky layers in place. */
  private applyScroll(l: Layer) {
    const doc = this.doc;
    const fix = (container: string, sx: number, sy: number) => {
      for (const c of doc.children(container)) {
        const csn = l.scene.node(c);
        if (!csn) continue;
        const b = (doc.get(c, 'transform') ?? IDENTITY) as M;
        const mode = doc.get(c, 'scrollBehavior') ?? 'SCROLLS';
        if (mode === 'FIXED') csn.transform = [b[0], b[1], b[2] + sx, b[3], b[4], b[5] + sy];
        else if (mode === 'STICKY_SCROLLS') csn.transform = [b[0], b[1], b[2], b[3], b[4], b[5] + Math.max(0, sy - b[5])];
        else if (csn.transform[2] !== b[2] || csn.transform[5] !== b[5]) csn.transform = b;
      }
    };
    for (const [id, s] of this.session.scroll) {
      if (id === l.id) {
        // The whole screen shifts the presentation; fixed layers stay in place.
        fix(id, s.x, s.y);
        continue;
      }
      const sn = l.scene.node(id);
      if (!sn) continue;
      sn.scroll = { x: s.x, y: s.y };
      fix(id, 0, 0);
      // Fixed layers inside a scroll: shifted back by the scroll amount.
      for (const c of doc.children(id)) {
        const csn = l.scene.node(c);
        if (!csn) continue;
        const b = (doc.get(c, 'transform') ?? IDENTITY) as M;
        const mode = doc.get(c, 'scrollBehavior') ?? 'SCROLLS';
        if (mode === 'FIXED') csn.transform = [b[0], b[1], b[2] + s.x, b[3], b[4], b[5] + s.y];
        else if (mode === 'STICKY_SCROLLS') csn.transform = [b[0], b[1], b[2], b[3], b[4], b[5] + Math.max(0, s.y - b[5])];
      }
    }
  }

  /** Node matrix in layer coordinates (root at the origin, with scrolls). */
  private matrixIn(l: Layer, id: string): M | null {
    const chain: SceneNode[] = [];
    for (let sn: SceneNode | null | undefined = l.scene.node(id); sn && sn !== l.root; sn = l.scene.parent(sn)) chain.unshift(sn);
    if (!l.scene.node(id)) return null;
    let m: M = IDENTITY;
    let parent: SceneNode = l.root;
    for (const sn of chain) {
      if (parent.scroll) m = mul(m, [1, 0, -parent.scroll.x, 0, 1, -parent.scroll.y]);
      m = mul(m, sn.transform as M);
      parent = sn;
    }
    return m;
  }

  /** Overlay position in the presentation area. */
  private overlayPos(o: OverlayState, vw: number, vh: number): [number, number] {
    const doc = this.doc;
    const w = doc.get(o.id, 'width') ?? 0;
    const h = doc.get(o.id, 'height') ?? 0;
    switch (doc.get(o.id, 'overlayPositionType') ?? 'CENTER') {
      case 'TOP_LEFT':
        return [0, 0];
      case 'TOP_CENTER':
        return [(vw - w) / 2, 0];
      case 'TOP_RIGHT':
        return [vw - w, 0];
      case 'BOTTOM_LEFT':
        return [0, vh - h];
      case 'BOTTOM_CENTER':
        return [(vw - w) / 2, vh - h];
      case 'BOTTOM_RIGHT':
        return [vw - w, vh - h];
      case 'MANUAL': {
        const r = o.trigger ? this.nodeRect(o.trigger) : null;
        return r ? [r[0] + (o.relative?.x ?? 0), r[1] + (o.relative?.y ?? 0)] : [(vw - w) / 2, (vh - h) / 2];
      }
      default:
        return [(vw - w) / 2, (vh - h) / 2];
    }
  }

  /** Node bounds in the presentation area: [x, y, w, h]. */
  private nodeRect(id: string): [number, number, number, number] | null {
    const { vw, vh } = this.view();
    const roots = [...this.session.overlays.map((o) => ({ id: o.id, pos: this.overlayPos(o, vw, vh) })), ...(this.session.screen ? [{ id: this.session.screen, pos: [0, 0] as [number, number] }] : [])];
    for (const r of roots) {
      const l = this.layers.get(r.id);
      if (!l || !l.scene.node(id)) continue;
      const m = this.matrixIn(l, id);
      if (!m) continue;
      const s = r.id === this.session.screen ? this.screenScroll(r.id) : { x: 0, y: 0 };
      const w = this.doc.get(id, 'width') ?? 0;
      const h = this.doc.get(id, 'height') ?? 0;
      const xs = [0, w, 0, w].map((x, i) => m[0] * x + m[1] * [0, 0, h, h][i]! + m[2]);
      const ys = [0, w, 0, w].map((x, i) => m[3] * x + m[4] * [0, 0, h, h][i]! + m[5]);
      return [Math.min(...xs) + r.pos[0] - s.x, Math.min(...ys) + r.pos[1] - s.y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    }
    return null;
  }

  /** A screen point (its coordinates) → presentation canvas (CSS px): for comment badges. */
  toCanvas(x: number, y: number): [number, number] {
    const { scale, ox, oy } = this.view();
    const screen = this.session.screen;
    const s = screen ? this.screenScroll(screen) : { x: 0, y: 0 };
    return [ox + (x - s.x) * scale, oy + (y - s.y) * scale];
  }

  /** Presentation canvas (CSS px) → screen point (null — outside it). */
  fromCanvas(cx: number, cy: number): [number, number] | null {
    const { vw, vh, scale, ox, oy } = this.view();
    const vx = (cx - ox) / scale;
    const vy = (cy - oy) / scale;
    if (vx < 0 || vy < 0 || vx > vw || vy > vh) return null;
    const screen = this.session.screen;
    const s = screen ? this.screenScroll(screen) : { x: 0, y: 0 };
    return [vx + s.x, vy + s.y];
  }

  /** Path of nodes under a canvas point (CSS px): from the root (screen or overlay) inward. */
  hit(cx: number, cy: number): string[] {
    const { vw, vh, scale, ox, oy } = this.view();
    const vx = (cx - ox) / scale;
    const vy = (cy - oy) / scale;
    if (vx < 0 || vy < 0 || vx > vw || vy > vh) return [];
    for (let i = this.session.overlays.length - 1; i >= 0; i--) {
      const o = this.session.overlays[i]!;
      const [x, y] = this.overlayPos(o, vw, vh);
      const l = this.layer(o.id);
      if (!l) continue;
      const path = this.hitLayer(l, vx - x, vy - y);
      if (path.length) return path;
    }
    const screen = this.session.screen;
    const l = screen ? this.layer(screen) : null;
    if (!l) return [];
    const s = this.screenScroll(l.id);
    return this.hitLayer(l, vx + s.x, vy + s.y);
  }

  /**
   * Path of layers under a point: the topmost hotspot (a layer with reactions or inside one);
   * layers without reactions on top don't cover it — borders, highlights and dimming over buttons
   * are common in mockups. No hotspot — just the top layer (then the screen's own reaction fires).
   */
  private hitLayer(l: Layer, px: number, py: number): string[] {
    this.applyScroll(l);
    const hits: SceneNode[][] = [];
    const stack: SceneNode[] = [];
    const visit = (sn: SceneNode, m: M) => {
      if (!sn.visible) return;
      const local = inv(m);
      const lx = local[0] * px + local[1] * py + local[2];
      const ly = local[3] * px + local[4] * py + local[5];
      const inside = lx >= 0 && ly >= 0 && lx <= sn.size.x && ly <= sn.size.y;
      stack.push(sn);
      if (sn.children.length && (!sn.clipsContent || inside)) {
        const cm = sn.scroll ? mul(m, [1, 0, -sn.scroll.x, 0, 1, -sn.scroll.y]) : m;
        // Top to bottom: the first hits are the topmost.
        for (let i = sn.children.length - 1; i >= 0; i--) {
          const c = sn.children[i]!;
          visit(c, mul(cm, c.transform as M));
        }
      }
      if (inside && sn.type !== 'GROUP') hits.push([...stack]);
      stack.pop();
    };
    visit(l.root, IDENTITY);
    const ids = (p: SceneNode[]) => p.map((sn) => l.scene.id(sn)!).filter(Boolean);
    const active = new Map<string, boolean>();
    const isActive = (id: string) => {
      let a = active.get(id);
      if (a === undefined) active.set(id, (a = this.doc.has(id) && reactionsOf(this.doc, id).length > 0));
      return a;
    };
    for (const p of hits) {
      const path = ids(p);
      if (path.slice(1).some(isActive)) return path;
    }
    return hits.length ? ids(hits[0]!) : [];
  }

  // ---------- Input ----------

  private bindInput() {
    const c = this.canvas;
    const pos = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const onMove = (e: PointerEvent) => {
      const [x, y] = pos(e);
      // Rotating a 3D model by dragging.
      const od = this.orbitDrag;
      if (od && od.id === e.pointerId) {
        this.models.orbit(od.node, x - od.x, y - od.y);
        od.x = x;
        od.y = y;
        this.dirty = true;
        return;
      }
      const path = this.hit(x, y);
      this.session.hover(path);
      // Hand cursor over a hotspot.
      const active = path.some((id) => this.doc.has(id) && reactionsOf(this.doc, id).some((r) => r.trigger && ['ON_CLICK', 'ON_DRAG', 'ON_PRESS', 'MOUSE_DOWN', 'MOUSE_UP', 'ON_DOUBLE_CLICK', 'ON_RIGHT_CLICK'].includes(r.trigger.type)));
      c.style.cursor = active ? 'pointer' : 'default';
    };
    // A single click waiting for a second one (there is an “On double click” on the path).
    let single: { x: number; y: number; at: number; timer: number; path: string[] } | null = null;
    const DOUBLE_MS = 300;
    const onDown = (e: PointerEvent) => {
      if (e.button === 2) {
        const [x, y] = pos(e);
        this.session.rightClick(this.hit(x, y));
        return;
      }
      if (e.button !== 0) return;
      const [x, y] = pos(e);
      const path = this.hit(x, y);
      this.down = { x, y, path };
      // A layer with a rotatable 3D model: dragging rotates it (a click works as usual).
      const model = [...path].reverse().find((id) => this.doc.has(id) && this.models.canOrbit(id));
      if (model) {
        this.orbitDrag = { node: model, x, y, id: e.pointerId };
        c.setPointerCapture?.(e.pointerId);
      }
      // Touch (and a click without mouse movement) — first hover over that spot.
      this.session.hover(path);
      this.session.pointerDown(path);
    };
    const onUp = (e: PointerEvent) => {
      if (this.orbitDrag?.id === e.pointerId) this.orbitDrag = null;
      if (e.button !== 0 || !this.down) return;
      const [x, y] = pos(e);
      const path = this.hit(x, y);
      this.session.pointerUp(path);
      const moved = Math.hypot(x - this.down.x, y - this.down.y) > 6;
      const down = this.down;
      this.down = null;
      if (!moved) {
        // Input field — edit it (click reactions fire too).
        const field = this.inputAt(path);
        if (field) this.startInput(field);
        else this.finishInput();
        // A second click nearby and in time is a double click; the first one doesn't fire.
        if (single && Math.hypot(x - single.x, y - single.y) <= 6 && performance.now() - single.at <= DOUBLE_MS) {
          clearTimeout(single.timer);
          single = null;
          this.session.doubleClick(path);
        } else if (this.session.wantsDoubleClick(path)) {
          if (single) clearTimeout(single.timer);
          const first = { x, y, at: performance.now(), path, timer: 0 };
          first.timer = window.setTimeout(() => {
            if (single === first) single = null;
            this.session.click(first.path);
          }, DOUBLE_MS);
          single = first;
        } else this.session.click(path);
      } else this.session.click(down.path.filter((id) => this.doc.has(id) && reactionsOf(this.doc, id).some((r) => r.trigger?.type === 'ON_DRAG')).length ? down.path : []);
    };
    const onLeave = () => this.session.hover([]);
    // Right-click is a prototype trigger, not the browser menu.
    const onMenu = (e: MouseEvent) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x, y] = pos(e);
      this.wheel(x, y, e.deltaX + (e.shiftKey ? e.deltaY : 0), e.shiftKey ? 0 : e.deltaY);
    };
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointerleave', onLeave);
    c.addEventListener('contextmenu', onMenu);
    c.addEventListener('wheel', onWheel, { passive: false });
    this.cleanup.push(() => {
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('pointerleave', onLeave);
      c.removeEventListener('contextmenu', onMenu);
      c.removeEventListener('wheel', onWheel);
      if (single) clearTimeout(single.timer);
    });
  }

  /** The input field being edited: layer, its text, page element and the text's previous opacity. */
  private editing: { id: string; textId: string; el: HTMLInputElement | HTMLTextAreaElement; opacity: number } | null = null;
  /** Values entered in fields (by layer) and the layer text before input (default placeholder). */
  private inputValues = new Map<string, string>();
  private inputPlaceholders = new Map<string, string>();

  /** Input field on the click path (the deepest one). */
  private inputAt(path: string[]): string | null {
    for (let i = path.length - 1; i >= 0; i--) if (this.doc.has(path[i]!) && this.doc.get(path[i]!, 'prototypeInput')) return path[i]!;
    return null;
  }

  /** Edit a field: a real page input over the layer text (the text on the canvas becomes transparent). */
  private startInput(id: string) {
    if (this.editing?.id === id) return;
    this.finishInput();
    const doc = this.doc;
    const spec = doc.get(id, 'prototypeInput') ?? {};
    const textId = doc.type(id) === 'TEXT' ? id : [...doc.descendants(id)].find((x) => doc.type(x) === 'TEXT');
    if (!textId) return;
    if (!this.inputPlaceholders.has(id)) this.inputPlaceholders.set(id, doc.get(textId, 'characters') ?? '');
    const multiline = spec.kind === 'MULTILINE';
    const el = document.createElement(multiline ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
    if (el instanceof HTMLInputElement) el.type = spec.kind === 'PASSWORD' ? 'password' : spec.kind === 'EMAIL' ? 'email' : spec.kind === 'NUMBER' ? 'number' : 'text';
    el.placeholder = spec.placeholder ?? this.inputPlaceholders.get(id) ?? '';
    const variable = spec.variableId && doc.has(spec.variableId) ? doc.get(spec.variableId, 'valuesByMode') : undefined;
    const fromVar = variable ? Object.values(variable).find((v) => typeof v === 'string') : undefined;
    el.value = this.inputValues.get(id) ?? (typeof fromVar === 'string' ? fromVar : '');
    el.className = 'p-input';
    el.spellcheck = false;
    const opacity = doc.get(textId, 'opacity') ?? 1;
    doc.transact(() => doc.set(textId, { opacity: 0 }), 'prototype');
    this.editing = { id, textId, el, opacity };
    this.styleInput();
    el.addEventListener('input', () => {
      this.inputValues.set(id, el.value);
      this.session.input(id, el.value, false);
    });
    el.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      e.stopPropagation();
      if (e.key === 'Escape') el.blur();
      else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.session.input(id, el.value, true);
        el.blur();
      }
    });
    el.addEventListener('blur', () => this.finishInput());
    document.body.append(el);
    el.focus();
  }

  /** The field matches the layer text's position and style (presentation zoom, scroll). */
  private styleInput() {
    const e = this.editing;
    if (!e) return;
    const r = this.nodeRect(e.textId) ?? this.nodeRect(e.id);
    if (!r) return this.finishInput();
    const { scale, ox, oy } = this.view();
    const doc = this.doc;
    const st = e.el.style;
    const size = (doc.get(e.textId, 'fontSize') ?? 14) * scale;
    const font = doc.get(e.textId, 'fontName') ?? { family: 'Inter', style: 'Regular' };
    const fill = (doc.get(e.textId, 'fills') ?? []).find((p) => p.type === 'SOLID' && p.visible !== false);
    const c = fill?.type === 'SOLID' ? fill.color : { r: 0, g: 0, b: 0 };
    const color = `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
    const weight = /black|heavy/i.test(font.style) ? 900 : /extra ?bold/i.test(font.style) ? 800 : /semi ?bold/i.test(font.style) ? 600 : /bold/i.test(font.style) ? 700 : /medium/i.test(font.style) ? 500 : /light/i.test(font.style) ? 300 : 400;
    Object.assign(st, {
      left: `${ox + r[0] * scale}px`,
      top: `${oy + r[1] * scale}px`,
      width: `${Math.max(40, r[2] * scale)}px`,
      height: `${Math.max(size * 1.3, r[3] * scale)}px`,
      font: `${/italic/i.test(font.style) ? 'italic ' : ''}${weight} ${size}px "${font.family}", Inter, system-ui, sans-serif`,
      color,
      caretColor: color,
      textAlign: ({ CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' } as Record<string, string>)[doc.get(e.textId, 'textAlignHorizontal') ?? 'LEFT'] ?? 'left',
    });
  }

  /** End of field editing: the layer text becomes the input (dots for a password) or the previous text if empty. */
  private finishInput() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const doc = this.doc;
    if (doc.has(e.textId)) {
      const v = e.el.value;
      const kind = doc.has(e.id) ? doc.get(e.id, 'prototypeInput')?.kind : undefined;
      const shown = v ? (kind === 'PASSWORD' ? '•'.repeat(v.length) : v) : (this.inputPlaceholders.get(e.id) ?? '');
      doc.transact(() => doc.set(e.textId, { opacity: e.opacity, characters: shown }), 'prototype');
    }
    e.el.remove();
    this.dirty = true;
  }

  /** Action sounds: hash → file URL (bytes from the editor's storage). */
  private sounds = new Map<string, Promise<string | null>>();

  private async playSound(hash: string, volume: number) {
    let url = this.sounds.get(hash);
    if (!url) this.sounds.set(hash, (url = this.opts.images.readImage(hash).then((b) => (b ? URL.createObjectURL(new Blob([b as BlobPart])) : null))));
    const u = await url;
    if (!u || this.disposed) return;
    const audio = new Audio(u);
    audio.volume = Math.max(0, Math.min(1, volume));
    void audio.play().catch(() => {});
  }

  /** Gamepad buttons pressed in the previous frame (by gamepad index). */
  private pads = new Map<number, boolean[]>();

  /** Gamepads: a button press (W3C standard mapping) fires the “Key” trigger with a controller. */
  private pollGamepads() {
    const list = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of list) {
      if (!g) continue;
      const prev = this.pads.get(g.index) ?? [];
      const now = g.buttons.map((b) => b.pressed);
      now.forEach((pressed, i) => {
        if (pressed && !prev[i]) this.session.key(i, true);
      });
      this.pads.set(g.index, now);
    }
  }

  /** A key for the prototype; true — a reaction fired. */
  key(e: KeyboardEvent): boolean {
    return this.session.key(e.keyCode);
  }

  /** Wheel scrolling: the most deeply nested scrollable frame that can still move; otherwise the screen. */
  private wheel(x: number, y: number, dx: number, dy: number) {
    const path = this.hit(x, y);
    const { scale, vw, vh } = this.view();
    const candidates: string[] = [];
    for (let i = path.length - 1; i >= 0; i--) if ((this.doc.get(path[i]!, 'overflowDirection') ?? 'NONE') !== 'NONE') candidates.push(path[i]!);
    if (this.session.screen) candidates.push(this.session.screen);
    for (const id of candidates) {
      const isScreen = id === this.session.screen;
      const dir = isScreen ? 'BOTH' : (this.doc.get(id, 'overflowDirection') ?? 'NONE');
      const [maxX, maxY] = isScreen ? [Math.max(0, (this.doc.get(id, 'width') ?? 0) - vw), Math.max(0, (this.doc.get(id, 'height') ?? 0) - vh)] : this.scrollRange(id);
      const cur = this.session.scroll.get(id) ?? { x: 0, y: 0 };
      const nx = dir === 'HORIZONTAL' || dir === 'BOTH' ? Math.max(0, Math.min(maxX, cur.x + dx / scale)) : cur.x;
      const ny = dir === 'VERTICAL' || dir === 'BOTH' ? Math.max(0, Math.min(maxY, cur.y + dy / scale)) : cur.y;
      if (nx === cur.x && ny === cur.y) continue;
      this.setScroll(id, { x: nx, y: ny });
      this.dirty = true;
      // Hover follows the new content position.
      this.session.hover(this.hit(x, y));
      return;
    }
  }

  /**
   * New container scroll — and “On scroll” triggers (the session decides by the old/new difference).
   * During rendering (scroll animation) — after the frame: reactions change the animation list.
   */
  private setScroll(id: string, next: { x: number; y: number }, later = false) {
    const prev = this.session.scroll.get(id) ?? { x: 0, y: 0 };
    this.session.scroll.set(id, next);
    if (prev.x === next.x && prev.y === next.y) return;
    if (later) {
      const was = this.scrolled.get(id);
      this.scrolled.set(id, { prev: was?.prev ?? prev, next });
      return;
    }
    this.session.scrolled(id, prev, next, this.scrollView(id));
  }

  /** Deferred frame scrolls — for the session. */
  private flushScrolled() {
    if (!this.scrolled.size) return;
    const list = [...this.scrolled];
    this.scrolled.clear();
    for (const [id, { prev, next }] of list) if (this.doc.has(id)) this.session.scrolled(id, prev, next, this.scrollView(id));
  }

  /** Container viewport: for a screen — the device viewport, for a frame — its size. */
  private scrollView(id: string): { w: number; h: number } {
    if (id === this.session.screen) {
      const { vw, vh } = this.view();
      return { w: vw, h: vh };
    }
    return { w: this.doc.get(id, 'width') ?? 0, h: this.doc.get(id, 'height') ?? 0 };
  }

  /** How far a frame can scroll: content minus size. */
  private scrollRange(id: string): [number, number] {
    const doc = this.doc;
    let right = 0;
    let bottom = 0;
    for (const c of doc.children(id)) {
      if (doc.get(c, 'visible') === false || (doc.get(c, 'scrollBehavior') ?? 'SCROLLS') === 'FIXED') continue;
      const t = doc.get(c, 'transform') ?? IDENTITY;
      right = Math.max(right, t[2] + (doc.get(c, 'width') ?? 0));
      bottom = Math.max(bottom, t[5] + (doc.get(c, 'height') ?? 0));
    }
    // Bottom auto layout padding counts as content too.
    right += doc.get(id, 'layoutMode') !== 'NONE' ? (doc.get(id, 'paddingRight') ?? 0) : 0;
    bottom += doc.get(id, 'layoutMode') !== 'NONE' ? (doc.get(id, 'paddingBottom') ?? 0) : 0;
    return [Math.max(0, right - (doc.get(id, 'width') ?? 0)), Math.max(0, bottom - (doc.get(id, 'height') ?? 0))];
  }

  /** Highlight hotspots (on a click outside them or via the button). */
  flashHotspots() {
    this.flashUntil = performance.now() + 700;
    this.dirty = true;
  }

  // ---------- Session events ----------

  private animOf(kind: Anim['kind'], t: Transition | null, extra: Partial<Anim> = {}): Anim | null {
    const dur = transitionDuration(t);
    if (!t || dur <= 0) return null;
    return { kind, start: performance.now(), dur: dur * 1000, ease: easingFunction(t.easing, dur), transition: t, ...extra };
  }

  private onEvent(e: SessionEvent) {
    this.dirty = true;
    switch (e.type) {
      case 'navigate': {
        this.cancelAnims((a) => a.kind === 'screen');
        if (e.to) this.layer(e.to);
        const t = e.back ? reverseTransition(e.transition) : e.transition;
        const a = e.from ? this.animOf('screen', t, { from: e.from, to: e.to }) : null;
        if (a && t?.type === 'SMART_ANIMATE') this.planScreens(a);
        if (a) this.anims.push(a);
        this.opts.onScreen?.(e.to);
        return;
      }
      case 'overlay-open': {
        this.layer(e.overlay.id);
        const a = this.animOf('overlay-open', e.transition, { overlay: e.overlay });
        if (a) this.anims.push(a);
        return;
      }
      case 'overlay-close':
        this.cancelAnims((a) => a.overlay === e.overlay);
        return;
      case 'change': {
        const before = this.pending?.instance === e.instance ? this.pending : null;
        this.pending = null;
        const a = this.animOf('change', e.transition);
        if (!a) {
          before?.img.delete();
          return;
        }
        if (e.transition?.type === 'SMART_ANIMATE') this.planChange(a, e.instance, e.before);
        if (before) a.image = { img: before.img, layer: before.layer, m: before.m, w: before.w, h: before.h };
        // Dissolve and others: the old view fades out on top of the new one; morph too (disappearing layers).
        this.anims.push(a);
        return;
      }
      case 'scroll': {
        const cur = this.session.scroll.get(e.container) ?? { x: 0, y: 0 };
        const a = this.animOf('scroll', e.transition, { scroll: { container: e.container, x0: cur.x, y0: cur.y, x1: e.x, y1: e.y } });
        if (a) {
          this.session.scroll.set(e.container, { x: cur.x, y: cur.y });
          this.anims.push(a);
        }
        return;
      }
      case 'url':
        this.opts.onUrl?.(e.url, e.newTab);
        return;
      case 'sound':
        void this.playSound(e.hash, e.volume);
        return;
      case 'media':
        this.videos.apply(e.action);
        this.lotties.apply(e.action);
        this.models.apply(e.action);
        this.dirty = true;
        return;
      case 'no-hotspot':
        this.flashHotspots();
        return;
      default:
        return;
    }
  }

  /** Before a variant switch: an image of the instance as it is (for dissolve and disappearing layers). */
  private captureBefore(instance: string) {
    this.pending?.img.delete();
    this.pending = null;
    const roots = [...this.session.overlays.map((o) => o.id), this.session.screen].filter((x): x is string => !!x);
    for (const r of roots) {
      const l = this.layers.get(r);
      const sn = l?.scene.node(instance);
      if (!l || !sn || !this.surface) continue;
      this.applyScroll(l);
      const m = this.matrixIn(l, instance);
      if (!m) return;
      const w = sn.size.x;
      const h = sn.size.y;
      const s = this.view().scale * this.dpr;
      const W = Math.max(1, Math.ceil(w * s));
      const H = Math.max(1, Math.ceil(h * s));
      if (W * H > 4096 * 4096) return;
      const surf = this.surface.makeSurface({ width: W, height: H, colorType: this.ck.ColorType.RGBA_8888, alphaType: this.ck.AlphaType.Premul, colorSpace: this.ck.ColorSpace.SRGB });
      if (!surf) return;
      const cv = surf.getCanvas();
      cv.clear(this.ck.TRANSPARENT);
      cv.scale(s, s);
      // Node at the origin: parent = inverse of the node's own matrix.
      l.renderer.renderLive(cv, sn, inv(sn.transform as M), ALL, s);
      surf.flush();
      const img = surf.makeImageSnapshot();
      surf.delete();
      this.pending = { instance, img, layer: r, m, w, h };
      return;
    }
  }

  // ---------- Morph ----------

  /** Node paths by name (the way morph matches them): “/Button/Label”. */
  private paths(root: SceneNode): Map<string, SceneNode> {
    const out = new Map<string, SceneNode>();
    const walk = (sn: SceneNode, path: string) => {
      const seen = new Map<string, number>();
      for (const c of sn.children) {
        const k = seen.get(c.name) ?? 0;
        seen.set(c.name, k + 1);
        const p = `${path}/${c.name}${k ? `#${k}` : ''}`;
        out.set(p, c);
        walk(c, p);
      }
    };
    walk(root, '');
    return out;
  }

  private lerpFor(sn: SceneNode, fromT: M, fromO: number, fromFills: FigPaint[] | undefined, fromSize: [number, number]): Lerp {
    const container = ['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(sn.type);
    const resizable = container || (!sn.children.length && sn.type !== 'TEXT');
    const sized = resizable && fromSize[0] > 0 && fromSize[1] > 0 && (Math.abs(fromSize[0] - sn.size.x) > 0.01 || Math.abs(fromSize[1] - sn.size.y) > 0.01);
    return {
      sn,
      fromT,
      toT: [...sn.transform] as M,
      fromO,
      toO: sn.opacity,
      fromFills,
      toFills: sn.fills,
      size: sized && sn.size.x > 0 && sn.size.y > 0 ? [fromSize[0], fromSize[1], sn.size.x, sn.size.y] : undefined,
      children: sized && container ? sn.children.map(child => ({ sn: child, transform: [...child.transform] as M })) : undefined,
    };
  }

  /** Morph between screens: layers matched by path animate from the “before” state, the rest dissolve. */
  private planScreens(a: Anim) {
    const from = a.from ? this.layer(a.from) : null;
    const to = a.to ? this.layer(a.to) : null;
    if (!from || !to) return;
    const fm = this.paths(from.root);
    const tm = this.paths(to.root);
    a.lerps = [];
    a.fadeIn = [];
    a.hidden = [];
    for (const [p, sn] of tm) {
      const f = fm.get(p);
      if (!f) {
        a.fadeIn.push({ sn, o: sn.opacity });
        continue;
      }
      a.lerps.push(this.lerpFor(sn, [...f.transform] as M, f.opacity, f.fills, [f.size.x, f.size.y]));
      a.hidden.push(f);
    }
  }

  /** Morph on a variant switch: “before” comes from a snapshot of properties by path. */
  private planChange(a: Anim, instance: string, before: NodeSnapshot) {
    const roots = [...this.session.overlays.map((o) => o.id), this.session.screen].filter((x): x is string => !!x);
    const l = roots.map((r) => this.layers.get(r)).find((x) => x?.scene.node(instance));
    const root = l?.scene.node(instance);
    if (!l || !root) return;
    const prev = new Map(before.nodes.map((n) => [n.path, n]));
    a.lerps = [];
    a.fadeIn = [];
    const fillsOf = (props: Record<string, unknown>) => ((props.fills as Paint[] | undefined) ?? []).map(toFigPaint).filter((p): p is FigPaint => !!p);
    const rootPrev = prev.get('');
    if (rootPrev) a.lerps.push(this.lerpFor(root, [...root.transform] as M, (rootPrev.props.opacity as number | undefined) ?? 1, fillsOf(rootPrev.props), [(rootPrev.props.width as number | undefined) ?? root.size.x, (rootPrev.props.height as number | undefined) ?? root.size.y]));
    for (const [p, sn] of this.paths(root)) {
      const f = prev.get(p);
      if (!f) {
        a.fadeIn.push({ sn, o: sn.opacity });
        continue;
      }
      const t = ((f.props.transform as M | undefined) ?? IDENTITY) as M;
      a.lerps.push(this.lerpFor(sn, [...t] as M, (f.props.opacity as number | undefined) ?? 1, fillsOf(f.props), [(f.props.width as number | undefined) ?? sn.size.x, (f.props.height as number | undefined) ?? sn.size.y]));
    }
  }

  /** Intermediate values of morphing layers (e — the easing curve value). */
  private applyLerps(a: Anim, e: number) {
    for (const x of a.lerps ?? []) for (const c of x.children ?? []) c.sn.transform = [...c.transform];
    for (const x of a.lerps ?? []) {
      let t = interpolateTransform(x.fromT, x.toT, e);
      if (x.size) {
        const sx = Math.max(1e-6, lerp(x.size[0], x.size[2], e) / x.size[2]);
        const sy = Math.max(1e-6, lerp(x.size[1], x.size[3], e) / x.size[3]);
        t = mul(t, [sx, 0, 0, 0, sy, 0]);
      }
      x.sn.transform = t;
      // Opacity and color in steps: the renderer creates a brush for every new value.
      x.sn.opacity = Math.round(lerp(x.fromO, x.toO, e) * 32) / 32;
      if (x.fromFills && x.toFills && JSON.stringify(x.fromFills) !== JSON.stringify(x.toFills)) {
        const step = Math.round(Math.max(0, Math.min(1, e)) * 24);
        x.steps ??= new Map();
        let fills = x.steps.get(step);
        if (!fills) x.steps.set(step, (fills = interpolateFills(x.fromFills, x.toFills, step / 24)));
        x.sn.fills = fills;
      }
    }
    for (const x of a.lerps ?? []) if (x.children && x.size) {
      compensateContainerChildren(x.sn, Math.max(1e-6, lerp(x.size[0], x.size[2], e) / x.size[2]), Math.max(1e-6, lerp(x.size[1], x.size[3], e) / x.size[3]));
    }
    for (const f of a.fadeIn ?? []) f.sn.opacity = Math.round(f.o * Math.max(0, Math.min(1, e)) * 32) / 32;
  }

  /** End of animation: the “after” values. */
  private cancelAnims(matches: (a: Anim) => boolean) {
    this.anims = this.anims.filter(a => {
      if (!matches(a)) return true;
      this.finishLerps(a);
      return false;
    });
  }

  private finishLerps(a: Anim) {
    for (const x of a.lerps ?? []) for (const c of x.children ?? []) c.sn.transform = [...c.transform];
    for (const x of a.lerps ?? []) {
      for (const fills of x.steps?.values() ?? []) for (const layer of this.layers.values()) layer.renderer.forgetFills(fills);
      x.steps?.clear();
      x.sn.transform = x.toT;
      x.sn.opacity = x.toO;
      if (x.toFills) x.sn.fills = x.toFills;
    }
    for (const f of a.fadeIn ?? []) f.sn.opacity = f.o;
    for (const h of a.hidden ?? []) h.visible = true;
    a.image?.img.delete();
    // Renderer caches (fills, bounds) follow the new values.
    for (const l of this.layers.values()) for (const x of a.lerps ?? []) l.renderer.forget(x.sn);
  }

  // ---------- Rendering ----------

  private drawLayer(id: string, dx: number, dy: number, alpha: number, scroll = true) {
    const l = this.layer(id);
    const surface = this.surface;
    if (!l || !surface || alpha <= 0) return;
    this.applyScroll(l);
    const canvas = surface.getCanvas();
    canvas.save();
    canvas.translate(dx, dy);
    if (alpha < 1) {
      this.paint.setAlphaf(alpha);
      canvas.saveLayer(this.paint);
    }
    const s = scroll ? this.screenScroll(id) : { x: 0, y: 0 };
    const t = l.root.transform;
    l.renderer.time = performance.now() / 1000;
    l.renderer.renderLive(canvas, l.root, [1, 0, -t[2] - s.x, 0, 1, -t[5] - s.y], ALL, this.view().scale * this.dpr);
    // The input field follows the layer (scroll, transition).
    if (this.editing) this.styleInput();
    // An animated shader in a fill — draw the next frame too.
    if (l.renderer.takeShaderAnimated()) this.dirty = true;
    // Lottie is playing — draw the next frame too.
    l.renderer.takeLottieAnimated();
    if (this.lotties.takeRunning()) this.dirty = true;
    // A 3D model is playing a clip or rotating — draw the next frame too.
    l.renderer.takeModelAnimated();
    if (this.models.takeRunning()) this.dirty = true;
    if (alpha < 1) canvas.restore();
    canvas.restore();
  }

  private draw(now: number) {
    const surface = this.surface;
    if (!surface) return;
    this.dirty = false;
    const ck = this.ck;
    const canvas = surface.getCanvas();
    const bg = this.doc.get(this.screenPage, 'prototypeBackgrounds')?.[0];
    const c = bg?.type === 'SOLID' ? bg.color : { r: 0.12, g: 0.12, b: 0.12 };
    canvas.clear(ck.Color4f(c.r, c.g, c.b, 1));
    const { vw, vh, scale, ox, oy, kind, radius } = this.view();
    canvas.save();
    canvas.scale(this.dpr, this.dpr);
    canvas.translate(ox, oy);
    canvas.scale(scale, scale);
    // Device body under the screen; the screen has rounded corners.
    if (kind) drawFrameBody(ck, canvas, kind, vw, vh);
    canvas.save();
    if (radius > 0) canvas.clipRRect(ck.RRectXY(ck.XYWHRect(0, 0, vw, vh), radius, radius), ck.ClipOp.Intersect, true);
    else canvas.clipRect(ck.XYWHRect(0, 0, vw, vh), ck.ClipOp.Intersect, true);
    if (kind) {
      // Under the screen — the presentation background (the body doesn't show through transparent parts of the screen).
      this.paint.setColor(ck.Color4f(c.r, c.g, c.b, 1));
      canvas.drawRect(ck.XYWHRect(0, 0, vw, vh), this.paint);
      this.paint.setColor(ck.BLACK);
    }
    // Animations: progress and curve value.
    const progress = (a: Anim) => Math.max(0, Math.min(1, (now - a.start) / a.dur));
    for (const a of this.anims) {
      const p = progress(a);
      const e = a.ease(p);
      if (a.lerps || a.fadeIn) this.applyLerps(a, e);
      if (a.hidden) for (const h of a.hidden) h.visible = false;
      if (a.kind === 'scroll' && a.scroll) this.setScroll(a.scroll.container, { x: lerp(a.scroll.x0, a.scroll.x1, e), y: lerp(a.scroll.y0, a.scroll.y1, e) }, true);
    }
    // Screen (or a transition between screens).
    const sa = this.anims.find((a) => a.kind === 'screen');
    const screen = this.session.screen;
    if (sa && sa.from && sa.to && sa.transition) this.drawScreenTransition(sa, sa.ease(progress(sa)), vw, vh);
    else if (screen) this.drawLayer(screen, 0, 0, 1);
    // The old look of switched instances (dissolve) on top of the new one.
    for (const a of this.anims) {
      if (a.kind !== 'change' || !a.image) continue;
      const fade = 1 - a.ease(progress(a));
      if (fade <= 0) continue;
      const img = a.image;
      const pos = img.layer === screen ? [0, 0] : this.overlayPos(this.session.overlays.find((o) => o.id === img.layer) ?? { id: img.layer, trigger: null }, vw, vh);
      const s = img.layer === screen ? this.screenScroll(img.layer) : { x: 0, y: 0 };
      canvas.save();
      canvas.translate(pos[0]! - s.x, pos[1]! - s.y);
      canvas.concat([img.m[0], img.m[1], img.m[2], img.m[3], img.m[4], img.m[5], 0, 0, 1]);
      this.paint.setAlphaf(Math.min(1, fade));
      canvas.drawImageRect(img.img, ck.XYWHRect(0, 0, img.img.width(), img.img.height()), ck.XYWHRect(0, 0, img.w, img.h), this.paint);
      canvas.restore();
    }
    // Overlays: background dimming and the overlay itself (with its enter transition).
    for (const o of this.session.overlays) {
      const a = this.anims.find((x) => x.kind === 'overlay-open' && x.overlay === o);
      const e = a ? a.ease(progress(a)) : 1;
      const bgc = this.doc.get(o.id, 'overlayBackground');
      if (bgc?.type === 'SOLID_COLOR') {
        this.paint.setColor(ck.Color4f(bgc.color.r, bgc.color.g, bgc.color.b, bgc.color.a * Math.min(1, Math.max(0, e))));
        canvas.drawRect(ck.XYWHRect(0, 0, vw, vh), this.paint);
        this.paint.setColor(ck.BLACK);
      }
      let [x, y] = this.overlayPos(o, vw, vh);
      let alpha = 1;
      const t = a?.transition;
      if (t && 'direction' in t) {
        const d = DIR[t.direction];
        x += -d[0] * (1 - e) * vw;
        y += -d[1] * (1 - e) * vh;
      } else if (t) alpha = Math.max(0, Math.min(1, e));
      this.drawLayer(o.id, x, y, alpha, false);
    }
    // Hotspots.
    if (now < this.flashUntil || this.hotspots) this.drawHotspots(now);
    canvas.restore();
    // Camera cutout over the screen.
    if (kind) drawFrameOverlay(ck, canvas, kind, vw, vh);
    canvas.restore();
    surface.flush();
    this.onDrawn?.();
    // Finished animations.
    const done = this.anims.filter((a) => now - a.start >= a.dur);
    if (done.length) {
      for (const a of done) {
        this.finishLerps(a);
        if (a.kind === 'scroll' && a.scroll) this.setScroll(a.scroll.container, { x: a.scroll.x1, y: a.scroll.y1 }, true);
      }
      this.anims = this.anims.filter((a) => !done.includes(a));
      this.dirty = true;
    }
  }

  private drawScreenTransition(a: Anim, e: number, vw: number, vh: number) {
    const t = a.transition!;
    const from = a.from!;
    const to = a.to!;
    if (t.type === 'DISSOLVE' || t.type === 'SCROLL_ANIMATE') {
      this.drawLayer(from, 0, 0, 1);
      this.drawLayer(to, 0, 0, e);
      return;
    }
    if (t.type === 'SMART_ANIMATE') {
      // Unmatched layers of the old screen fade out, new ones fade in; matched ones move.
      this.drawLayer(from, 0, 0, Math.max(0, 1 - e));
      this.drawLayer(to, 0, 0, a.lerps?.length ? 1 : e);
      return;
    }
    if (!('direction' in t)) return;
    const d = DIR[t.direction];
    const [w, h] = [vw * d[0], vh * d[1]];
    switch (t.type) {
      case 'MOVE_IN':
        this.drawLayer(from, 0, 0, 1);
        this.drawLayer(to, -w * (1 - e), -h * (1 - e), 1);
        return;
      case 'MOVE_OUT':
        this.drawLayer(to, 0, 0, 1);
        this.drawLayer(from, w * e, h * e, 1);
        return;
      case 'PUSH':
        this.drawLayer(from, w * e, h * e, 1);
        this.drawLayer(to, -w * (1 - e), -h * (1 - e), 1);
        return;
      case 'SLIDE_IN':
        this.drawLayer(from, w * 0.3 * e, h * 0.3 * e, 1);
        this.drawLayer(to, -w * (1 - e), -h * (1 - e), 1);
        return;
      case 'SLIDE_OUT':
        this.drawLayer(to, -w * 0.3 * (1 - e), -h * 0.3 * (1 - e), 1);
        this.drawLayer(from, w * e, h * e, 1);
        return;
    }
  }

  /** Hotspot highlighting: bounds of layers with pointer reactions. */
  private drawHotspots(now: number) {
    const ck = this.ck;
    const canvas = this.surface!.getCanvas();
    const fade = this.hotspots ? 1 : Math.max(0, Math.min(1, (this.flashUntil - now) / 250));
    const pointer = new Set(['ON_CLICK', 'ON_DRAG', 'ON_PRESS', 'ON_HOVER', 'MOUSE_DOWN', 'MOUSE_UP', 'MOUSE_ENTER', 'MOUSE_LEAVE', 'ON_DOUBLE_CLICK', 'ON_RIGHT_CLICK']);
    const roots = [...(this.session.screen ? [this.session.screen] : []), ...this.session.overlays.map((o) => o.id)];
    const seen = new Set<string>();
    for (const root of roots) {
      const l = this.layers.get(root);
      if (!l) continue;
      for (const sn of walkNodes(l.root)) {
        const id = l.scene.id(sn);
        if (!id || seen.has(id) || !sn.visible) continue;
        if (!reactionsOf(this.doc, id).some((r) => r.trigger && pointer.has(r.trigger.type))) continue;
        seen.add(id);
        const r = this.nodeRect(id);
        if (!r) continue;
        this.paint.setStyle(ck.PaintStyle.Fill);
        this.paint.setColor(ck.Color4f(0.302, 0.482, 0.992, 0.18 * fade));
        canvas.drawRect(ck.XYWHRect(r[0], r[1], r[2], r[3]), this.paint);
        this.paint.setStyle(ck.PaintStyle.Stroke);
        this.paint.setStrokeWidth(2 / this.view().scale);
        this.paint.setColor(ck.Color4f(0.302, 0.482, 0.992, 0.9 * fade));
        canvas.drawRect(ck.XYWHRect(r[0], r[1], r[2], r[3]), this.paint);
        this.paint.setStyle(ck.PaintStyle.Fill);
      }
    }
    this.paint.setColor(ck.BLACK);
  }
}

/** Direction of a layer's movement during a transition. */
const DIR: Record<'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM', [number, number]> = { LEFT: [-1, 0], RIGHT: [1, 0], TOP: [0, -1], BOTTOM: [0, 1] };

function* walkNodes(root: SceneNode): Generator<SceneNode> {
  yield root;
  for (const c of root.children) yield* walkNodes(c);
}
