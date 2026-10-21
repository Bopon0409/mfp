import CanvasKitInit, { type CanvasKit, type Surface } from 'canvaskit-wasm';
import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';
import {
  BlobSource,
  HttpRangeSource,
  buildScene,
  decodeFigKiwi,
  openFig,
  type ByteSource,
  type FigArchive,
  type Scene,
  type SceneNode,
  type ScenePage,
} from '@mfp/io-figma';
import { SceneRenderer, ImageCache, TileCache } from '@mfp/renderer';

import { makeStressPage } from './stress.ts';

import { Document } from '@mfp/core';
import { parseManifest, type PluginBundle } from '@mfp/plugin-host';
import type { Canvas } from 'canvaskit-wasm';
import { coreToScene } from '@mfp/renderer';
import { PluginHost } from '@mfp/plugin-host/browser';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvasEl = $<HTMLCanvasElement>('canvas');
const fileSelect = $<HTMLSelectElement>('file');
const pageSelect = $<HTMLSelectElement>('page');
const statsEl = $('stats');
const statusEl = $('status');

const ck: CanvasKit = await CanvasKitInit({ locateFile: () => wasmUrl });

let surface: Surface | null = null;
let dpr = 1;

interface Doc {
  name: string;
  archive: FigArchive | null;
  scene: Scene;
  renderer: SceneRenderer;
  images: ImageCache;
  tiles: TileCache | null;
}
let doc: Doc | null = null;
let page: ScenePage | null = null;
let pageBounds: [number, number, number, number] | undefined;

const camera = { x: 0, y: 0, zoom: 1 };
let dirty = true;
let lastFrameMs = 0;
let lastStats = { drawn: 0, culled: 0 };
/** Render through the tile cache (default) or directly — for comparison. */
let useTiles = new URLSearchParams(location.search).get('tiles') !== '0';
/** The first frame of a page is drawn completely, without “holes”; after that — within a budget. */
let firstFrame = true;

function setStatus(text: string) {
  statusEl.textContent = text;
}

// ---------- Document loading ----------

async function openSource(name: string, source: ByteSource) {
  setStatus(`Открываю ${name}…`);
  const t0 = performance.now();
  const archive = await openFig(source);
  setStatus(`Декодирую ${name}…`);
  await new Promise((r) => setTimeout(r, 0));
  const { message } = decodeFigKiwi(archive.kiwi);
  const t1 = performance.now();
  const scene = buildScene(message);
  const t2 = performance.now();
  setDoc({ name, archive, scene });
  setStatus(
    `${name}: ${(source.size / 2 ** 20).toFixed(0)} МБ, узлов в сцене ${scene.stats.nodes}, ` +
      `картинок ${archive.images.size} · открытие+декодирование ${(t1 - t0).toFixed(0)} мс, сцена ${(t2 - t1).toFixed(0)} мс`,
  );
}

function setDoc(next: { name: string; archive: FigArchive | null; scene: Scene }, keepCamera = false) {
  doc?.tiles?.dispose();
  doc?.renderer.dispose();
  doc?.images.dispose();
  const images = new ImageCache(ck, next.archive, (hash) => {
    doc?.tiles?.invalidateImage(hash);
    dirty = true;
  });
  doc = { ...next, images, renderer: new SceneRenderer(ck, next.scene.blobs, images), tiles: null };
  pageSelect.innerHTML = '';
  // Pages are built when opened: for the list, the number of top-level nodes is enough.
  const size = (p: Scene['pages'][number]) => p.size ?? p.children.length;
  // The internal canvas (styles, variables, library masters) is not shown.
  next.scene.pages.forEach((p, i) => p.internal || pageSelect.add(new Option(`${p.name} (${size(p)})`, String(i))));
  const firstNonEmpty = Math.max(0, next.scene.pages.findIndex((p) => !p.internal && size(p) > 0));
  pageSelect.value = String(firstNonEmpty);
  selectPage(firstNonEmpty, keepCamera);
}

function selectPage(index: number, keepCamera = false) {
  if (!doc) return;
  page = doc.scene.pages[index] ?? null;
  pageBounds = page ? doc.renderer.computeBounds(page.children) : undefined;
  doc.tiles?.dispose();
  doc.tiles = page ? new TileCache(ck, doc.renderer, page.children, webgl()) : null;
  firstFrame = true;
  if (keepCamera) dirty = true;
  else fit();
}

async function loadFixtureList() {
  const res = await fetch('/api/fixtures');
  const files: { name: string; size: number }[] = await res.json();
  fileSelect.innerHTML = '';
  fileSelect.add(new Option('— файл из fixtures —', ''));
  for (const f of files) fileSelect.add(new Option(`${f.name} (${(f.size / 2 ** 20).toFixed(0)} МБ)`, f.name));
}

// ---------- Camera and drawing ----------

/** The canvas WebGL2 context (the same one CanvasKit created) — for GPU timers and synchronization. */
function webgl(): WebGL2RenderingContext | null {
  return canvasEl.getContext('webgl2') as WebGL2RenderingContext | null;
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvasEl.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvasEl.clientHeight * dpr));
  if (canvasEl.width !== w || canvasEl.height !== h || !surface) {
    canvasEl.width = w;
    canvasEl.height = h;
    surface?.delete();
    surface = ck.MakeWebGLCanvasSurface(canvasEl);
    if (!surface) setStatus('Не удалось создать WebGL-поверхность');
    // Tile textures belong to the old GPU context — recreate the cache.
    if (doc && page) {
      doc.tiles?.dispose();
      doc.tiles = new TileCache(ck, doc.renderer, page.children, webgl());
      firstFrame = true;
    }
  }
  dirty = true;
}

type Cam = { x: number; y: number; zoom: number };

/** Camera at which the bounds fit the screen with a margin. */
function fitTarget(bounds = pageBounds): Cam | undefined {
  if (!bounds) return undefined;
  const [x0, y0, x1, y1] = bounds;
  const vw = canvasEl.clientWidth;
  const vh = canvasEl.clientHeight;
  const pad = 40;
  const zoom = Math.min((vw - pad * 2) / Math.max(1, x1 - x0), (vh - pad * 2) / Math.max(1, y1 - y0));
  return { zoom, x: (x0 + x1) / 2 - vw / 2 / zoom, y: (y0 + y1) / 2 - vh / 2 / zoom };
}

/** Camera at 100% zoom around the current one's center. */
function zoom100Target(from: Cam = camera): Cam {
  const vw = canvasEl.clientWidth;
  const vh = canvasEl.clientHeight;
  const cx = from.x + vw / 2 / from.zoom;
  const cy = from.y + vh / 2 / from.zoom;
  return { zoom: 1, x: cx - vw / 2, y: cy - vh / 2 };
}

/** Camera interpolation: zoom in log space, screen center linearly; t ∈ [0, 1] with ease-out. */
function lerpCamera(from: Cam, to: Cam, t: number): Cam {
  const vw = canvasEl.clientWidth;
  const vh = canvasEl.clientHeight;
  const k = 1 - (1 - t) ** 3;
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * k);
  const c0x = from.x + vw / 2 / from.zoom;
  const c0y = from.y + vh / 2 / from.zoom;
  const c1x = to.x + vw / 2 / to.zoom;
  const c1y = to.y + vh / 2 / to.zoom;
  const cx = c0x + (c1x - c0x) * k;
  const cy = c0y + (c1y - c0y) * k;
  return { zoom, x: cx - vw / 2 / zoom, y: cy - vh / 2 / zoom };
}

function fit(bounds = pageBounds, animate = false) {
  const target = fitTarget(bounds);
  if (!target) return;
  if (animate) animateCamera(target);
  else Object.assign(camera, target), (dirty = true);
}

/** 100% zoom relative to the screen center. */
function zoomTo100(animate = true) {
  const target = zoom100Target();
  if (animate) animateCamera(target);
  else Object.assign(camera, target), (dirty = true);
}

/** Smooth camera transition (for “fit” and “100%”). */
let cameraAnimation = 0;
const ANIMATION_MS = 250;
function animateCamera(target: Cam, durationMs = ANIMATION_MS) {
  const from = { ...camera };
  const start = performance.now();
  const id = ++cameraAnimation;
  const step = () => {
    if (id !== cameraAnimation) return;
    const t = Math.min(1, (performance.now() - start) / durationMs);
    Object.assign(camera, lerpCamera(from, target, t));
    dirty = true;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function draw() {
  if (!surface) return;
  const canvas = surface.getCanvas();
  const t0 = performance.now();
  const bg = page?.backgroundColor ?? { r: 0.118, g: 0.118, b: 0.118, a: 1 };
  canvas.clear(ck.Color4f(bg.r, bg.g, bg.b, 1));
  if (doc && page) {
    if (useTiles && doc.tiles) {
      const more = doc.tiles.draw(surface, canvas, camera, dpr, canvasEl.clientWidth, canvasEl.clientHeight, firstFrame);
      firstFrame = false;
      if (more) dirty = true;
    } else {
      const z = camera.zoom * dpr;
      canvas.save();
      canvas.concat([z, 0, -camera.x * z, 0, z, -camera.y * z, 0, 0, 1]);
      const viewport: [number, number, number, number] = [
        camera.x,
        camera.y,
        camera.x + canvasEl.clientWidth / camera.zoom,
        camera.y + canvasEl.clientHeight / camera.zoom,
      ];
      lastStats = doc.renderer.render(canvas, page.children, viewport, z);
      canvas.restore();
    }
  }
  drawSelection(canvas);
  surface.flush();
  lastFrameMs = performance.now() - t0;
  const ts = useTiles ? doc?.tiles?.stats : undefined;
  statsEl.textContent =
    `${(camera.zoom * 100).toFixed(1)}% · кадр ${lastFrameMs.toFixed(1)} мс · ` +
    (ts
      ? `тайлы L${ts.level}: ${ts.cached}/${ts.visible}, +${ts.rendered}, ожидают ${ts.pending}`
      : `нарисовано ${lastStats.drawn}, отсечено ${lastStats.culled}`) +
    (doc ? ` · картинок ${doc.images.loaded}` : '');
}

function loop() {
  if (rebuildPending) rebuildCoreScene();
  if (dirty) {
    dirty = false;
    draw();
  }
  requestAnimationFrame(loop);
}

// ---------- Input ----------

let drag: { x: number; y: number } | null = null;
canvasEl.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvasEl.setPointerCapture(e.pointerId);
  canvasEl.classList.add('dragging');
});
canvasEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  camera.x -= (e.clientX - drag.x) / camera.zoom;
  camera.y -= (e.clientY - drag.y) / camera.zoom;
  drag = { x: e.clientX, y: e.clientY };
  dirty = true;
});
canvasEl.addEventListener('pointerup', () => {
  drag = null;
  canvasEl.classList.remove('dragging');
});

function zoomAt(clientX: number, clientY: number, factor: number) {
  const rect = canvasEl.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const wx = camera.x + sx / camera.zoom;
  const wy = camera.y + sy / camera.zoom;
  camera.zoom = Math.min(256, Math.max(0.002, camera.zoom * factor));
  camera.x = wx - sx / camera.zoom;
  camera.y = wy - sy / camera.zoom;
  dirty = true;
}

canvasEl.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else {
      camera.x += e.deltaX / camera.zoom;
      camera.y += e.deltaY / camera.zoom;
      dirty = true;
    }
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
  // Shortcuts: Shift+1 — fit, Shift+0 — 100%.
  if (e.shiftKey && e.code === 'Digit1') fit(pageBounds, true);
  else if (e.shiftKey && e.code === 'Digit0') zoomTo100();
  else if (e.key === '=' || e.key === '+') zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
  else if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
});

fileSelect.addEventListener('change', async () => {
  if (!fileSelect.value) return;
  try {
    await openSource(fileSelect.value, await HttpRangeSource.open(`/fixtures/${encodeURIComponent(fileSelect.value)}`));
  } catch (e) {
    setStatus(`Ошибка: ${(e as Error).message}`);
    console.error(e);
  }
});

$<HTMLInputElement>('upload').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await openSource(file.name, new BlobSource(file));
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragover');
});
document.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const file = e.dataTransfer?.files[0];
  if (file) await openSource(file.name, new BlobSource(file));
});

pageSelect.addEventListener('change', () => selectPage(Number(pageSelect.value)));
$('fit').addEventListener('click', () => fit());
$('stress').addEventListener('click', () => {
  const t0 = performance.now();
  const stressPage = makeStressPage(100_000);
  setDoc({ name: 'stress', archive: null, scene: { pages: [stressPage], blobs: [], stats: { nodes: 100_000, instancesExpanded: 0, missingSymbols: 0, overridesApplied: 0 } } });
  setStatus(`Стресс: 100 000 прямоугольников, сцена за ${(performance.now() - t0).toFixed(0)} мс`);
});

// ---------- Benchmark: 3 seconds of pan + zoom, mean and p95 frame ----------

async function bench(seconds = 3) {
  const times: number[] = [];
  const start = performance.now();
  const base = { ...camera };
  // Intervals between rAF frames give the real FPS, including GPU work and compositing.
  const intervals: number[] = [];
  let prev = performance.now();
  while (performance.now() - start < seconds * 1000) {
    const t = (performance.now() - start) / 1000;
    camera.zoom = base.zoom * (1 + 0.5 * Math.sin(t * 2));
    camera.x = base.x + Math.sin(t) * 200 / camera.zoom;
    camera.y = base.y + Math.cos(t) * 200 / camera.zoom;
    draw();
    times.push(lastFrameMs);
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    intervals.push(now - prev);
    prev = now;
  }
  Object.assign(camera, base);
  dirty = true;
  times.sort((a, b) => a - b);
  intervals.sort((a, b) => a - b);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  const fps = (1000 * intervals.length) / intervals.reduce((s, x) => s + x, 0);
  const worst = intervals[Math.floor(intervals.length * 0.95)] ?? 0;
  const result = {
    frames: times.length,
    fps: +fps.toFixed(1),
    p95IntervalMs: +worst.toFixed(1),
    cpuAvgMs: +avg.toFixed(2),
    cpuP95Ms: +p95.toFixed(2),
    drawn: lastStats.drawn,
  };
  setStatus(
    `Бенчмарк: ${result.fps} FPS (p95 интервал ${result.p95IntervalMs} мс), ` +
      `CPU на кадр: среднее ${result.cpuAvgMs} мс, p95 ${result.cpuP95Ms} мс`,
  );
  return result;
}
$('bench').addEventListener('click', () => void bench());

// ---------- Synchronous benchmark: CPU + GPU, independent of tab visibility ----------

const syncPixel = new Uint8Array(4);
let glCtx: WebGL2RenderingContext | WebGLRenderingContext | null = null;
/** Wait until the GPU actually finishes the frame: reading a single pixel is a sync point. */
function gpuSync() {
  glCtx ??= (canvasEl.getContext('webgl2') ?? canvasEl.getContext('webgl')) as WebGL2RenderingContext | null;
  glCtx?.readPixels(0, 0, 1, 1, glCtx.RGBA, glCtx.UNSIGNED_BYTE, syncPixel);
}

function summarize(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  const pct = (p: number) => +(v[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0).toFixed(2);
  return { n: v.length, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: +(v[v.length - 1] ?? 0).toFixed(2) };
}

/**
 * Scenario: N “fit ↔ 100%” transitions of 250 ms with 0.35 s pauses,
 * then scrolling at 100%. Each frame is draw + GPU sync.
 * intervals — simulated rAF intervals at hz: max(frame, 1000/hz),
 * idle frames count as 1000/hz.
 */
/**
 * Warm-up before measuring: the same camera path, but yielding to the browser between frames
 * so that images of the needed resolutions load and tiles finish drawing (during the measurement).
 */
/** Yield to the browser. MessageChannel is not throttled in a hidden tab, unlike setTimeout. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

async function benchWarmup(hz = 144) {
  const animFrames = Math.round((ANIMATION_MS / 1000) * hz);
  const settle = async () => {
    for (let i = 0; i < 20000; i++) {
      dirty = false;
      draw();
      await yieldToBrowser();
      if (!dirty && (doc?.images.idle ?? true)) return;
    }
  };
  const start = fitTarget();
  if (!start) return;
  for (let pass = 0; pass < 2; pass++) {
    Object.assign(camera, start);
    await settle();
    for (const to of [zoom100Target(start), start]) {
      const from = { ...camera };
      for (let f = 1; f <= animFrames; f++) {
        Object.assign(camera, lerpCamera(from, to, f / animFrames));
        dirty = false;
        draw();
        await yieldToBrowser();
      }
      await settle();
    }
  }
}

function benchSync(opts: { transitions?: number; panFrames?: number; hz?: number; repeat?: number } = {}) {
  const hz = opts.hz ?? 144;
  const vsync = 1000 / hz;
  const transitions = opts.transitions ?? 12;
  const panFrames = opts.panFrames ?? 144;
  const animFrames = Math.round((ANIMATION_MS / 1000) * hz);
  const pauseFrames = Math.round(0.35 * hz);
  const runs: unknown[] = [];
  for (let run = 0; run < (opts.repeat ?? 2); run++) {
    let frames: number[] = [];
    let intervals: number[] = [];
    const slow: unknown[] = [];
    const frame = () => {
      const t0 = performance.now();
      dirty = false;
      draw();
      gpuSync();
      const ms = performance.now() - t0;
      frames.push(ms);
      intervals.push(Math.max(ms, vsync));
      if (ms > 16.7 && slow.length < 20) slow.push({ ms: +ms.toFixed(1), zoom: +camera.zoom.toFixed(4), tiles: doc?.tiles ? { ...doc.tiles.stats } : null, images: doc?.images.loaded });
    };
    const section = () => {
      const r = { frames: summarize(frames), intervals: summarize(intervals), over16: intervals.filter((x) => x > 16.7).length, over33: intervals.filter((x) => x > 33.4).length };
      frames = [];
      intervals = [];
      return r;
    };
    const start = fitTarget();
    if (!start) return { error: 'нет документа' };
    Object.assign(camera, start);
    frame();
    section();
    for (let k = 0; k < transitions; k++) {
      const from = { ...camera };
      const to = k % 2 === 0 ? zoom100Target(from) : (fitTarget() as Cam);
      for (let f = 1; f <= animFrames; f++) {
        Object.assign(camera, lerpCamera(from, to, f / animFrames));
        frame();
      }
      // Pause: frames are drawn only if work remains (finishing tiles).
      for (let f = 0; f < pauseFrames; f++) {
        if (dirty) frame();
        else intervals.push(vsync);
      }
    }
    const zoomPart = section();
    Object.assign(camera, zoom100Target());
    for (let f = 0; f < panFrames; f++) {
      camera.x += 2400 / hz / camera.zoom; // ~2400 px/s — fast scrolling
      frame();
    }
    runs.push({ run, zoom: zoomPart, pan: section(), slow });
  }
  fit();
  return { tiles: useTiles, file: doc?.name, runs };
}


// For debugging from the console and for automated tests.
// ---------- Plugin sandbox: an MFP document + plugins in Figma format ----------

const pluginSelect = $<HTMLSelectElement>('plugin');
const sideloadLabel = $('sideload-label');
const toastsEl = $('toasts');
let coreDoc: Document | null = null;
let corePage = '';
let coreSelection: string[] = [];
let coreNodes = new Map<string, SceneNode>();
let rebuildPending = false;
let pluginHost: PluginHost | null = null;

const selectionPaint = new ck.Paint();
selectionPaint.setStyle(ck.PaintStyle.Stroke);
selectionPaint.setStrokeWidth(1.5);
selectionPaint.setAntiAlias(true);
selectionPaint.setColor(ck.Color4f(0.302, 0.482, 0.992, 1));

function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = document.createElement('div');
  el.className = kind === 'error' ? 'toast error' : 'toast';
  el.textContent = message;
  toastsEl.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

/** Boxes of selected nodes (in screen coordinates, above the scene). */
function drawSelection(canvas: Canvas) {
  if (!coreDoc || !doc || !coreSelection.length) return;
  const d = camera.zoom * dpr;
  for (const id of coreSelection) {
    const n = coreNodes.get(id);
    const b = n && doc.renderer.boundsOf(n);
    if (!b) continue;
    canvas.drawRect(
      ck.LTRBRect((b[0] + 2 - camera.x) * d, (b[1] + 2 - camera.y) * d, (b[2] - 2 - camera.x) * d, (b[3] - 2 - camera.y) * d),
      selectionPaint,
    );
  }
}

function rebuildCoreScene(fitView = false) {
  rebuildPending = false;
  if (!coreDoc) return;
  const { page: p, blobs } = coreToScene(coreDoc, corePage);
  coreNodes = new Map();
  const index = (nodes: SceneNode[]) =>
    nodes.forEach((n) => {
      coreNodes.set(n.key, n);
      index(n.children);
    });
  index(p.children);
  setDoc(
    {
      name: 'Песочница плагинов',
      archive: null,
      scene: { pages: [p], blobs, stats: { nodes: coreNodes.size, instancesExpanded: 0, missingSymbols: 0, overridesApplied: 0 } },
    },
    !fitView,
  );
}

async function enterPlayground() {
  pluginHost?.stop();
  const d = new Document({ clientId: 1 });
  corePage = d.create('PAGE', d.root, { name: 'Песочница', backgrounds: [{ type: 'SOLID', color: { r: 0.12, g: 0.12, b: 0.12 } }] });
  d.create('FRAME', corePage, {
    name: 'Холст',
    width: 900,
    height: 400,
    transform: [1, 0, -100, 0, 1, -100],
    cornerRadius: 16,
    fills: [{ type: 'SOLID', color: { r: 0.18, g: 0.18, b: 0.2 } }],
  });
  coreDoc = d;
  coreSelection = [];
  d.onChange(() => {
    rebuildPending = true;
  });
  rebuildCoreScene(true);
  pluginHost = new PluginHost({
    doc: d,
    getPage: () => corePage,
    getSelection: () => coreSelection,
    setSelection: (ids) => {
      coreSelection = ids;
      dirty = true;
    },
    zoomTo: (ids) => {
      rebuildCoreScene();
      let box: [number, number, number, number] | undefined;
      for (const id of ids) {
        const n = coreNodes.get(id);
        const b = n && doc?.renderer.boundsOf(n);
        if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
      }
      if (box) fit(box, true);
    },
    notify: (message, kind) => toast(message, kind),
    log: (level, args) => console.log('[плагин] ' + level + ':', ...args),
  });
  pluginSelect.hidden = false;
  sideloadLabel.hidden = false;
  const names: string[] = await (await fetch('/api/plugins')).json();
  pluginSelect.innerHTML = '';
  pluginSelect.add(new Option('— запустить плагин —', ''));
  for (const n of names) pluginSelect.add(new Option(n, n));
  setStatus('Песочница плагинов: выберите пример или загрузите свой плагин (manifest.json + code.js + ui.html)');
}

async function runPluginFromServer(name: string) {
  const file = async (f: string) => {
    const res = await fetch('/plugins/' + encodeURIComponent(name) + '/' + encodeURIComponent(f));
    if (!res.ok) throw new Error('нет файла ' + f);
    return res.text();
  };
  const { manifest, warnings } = parseManifest(JSON.parse(await file('manifest.json')));
  for (const w of warnings) toast('Плагин: ' + w);
  const bundle: PluginBundle = {
    manifest,
    code: await file(manifest.main),
    html: typeof manifest.ui === 'string' ? await file(manifest.ui) : undefined,
  };
  if (!coreDoc) await enterPlayground();
  pluginHost!.run(bundle);
}

async function sideload(files: FileList) {
  const byName = new Map([...files].map((f) => [f.name, f] as const));
  const mf = byName.get('manifest.json');
  if (!mf) return toast('Нужен manifest.json среди выбранных файлов', 'error');
  const { manifest, warnings } = parseManifest(JSON.parse(await mf.text()));
  for (const w of warnings) toast('Плагин: ' + w);
  const main = byName.get(manifest.main.split('/').pop()!);
  if (!main) return toast('Не выбран файл ' + manifest.main, 'error');
  const uiName = typeof manifest.ui === 'string' ? manifest.ui.split('/').pop()! : undefined;
  const ui = uiName ? byName.get(uiName) : undefined;
  if (uiName && !ui) return toast('Не выбран файл ' + uiName, 'error');
  if (!coreDoc) await enterPlayground();
  pluginHost!.run({ manifest, code: await main.text(), html: ui ? await ui.text() : undefined });
}

$('playground').addEventListener('click', () => void enterPlayground());
pluginSelect.addEventListener('change', () => {
  const name = pluginSelect.value;
  pluginSelect.value = '';
  if (name) runPluginFromServer(name).catch((e) => toast(String(e.message ?? e), 'error'));
});
$<HTMLInputElement>('sideload').addEventListener('change', (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files?.length) sideload(files).catch((err) => toast(String(err.message ?? err), 'error'));
});

(window as unknown as { mfp: unknown }).mfp = {
  bench,
  benchSync,
  benchWarmup,
  get useTiles() {
    return useTiles;
  },
  set useTiles(v: boolean) {
    useTiles = v;
    firstFrame = true;
    dirty = true;
  },
  camera,
  fit,
  openFixture: async (name: string) => openSource(name, await HttpRangeSource.open(`/fixtures/${encodeURIComponent(name)}`)),
  selectPage: (i: number) => {
    pageSelect.value = String(i);
    selectPage(i);
  },
  get stats() {
    return { frameMs: lastFrameMs, ...lastStats, images: doc?.images.loaded ?? 0 };
  },
  get pages() {
    return doc?.scene.pages.filter((p) => !p.internal).map((p) => p.name) ?? [];
  },
  findNode,
  enterPlayground,
  runPlugin: runPluginFromServer,
  get pluginHost() {
    return pluginHost;
  },
  get coreDoc() {
    return coreDoc;
  },
  get selection() {
    return coreSelection;
  },
  get tiles() {
    return doc?.tiles;
  },
  get renderer() {
    return doc?.renderer;
  },
  redraw: () => {
    dirty = true;
  },
  /** Zoom to a node by name (the n-th match). */
  focus: (name: string, nth = 0) => {
    const node = findNode(name, nth);
    const b = node && doc?.renderer.boundsOf(node);
    if (b) fit(b);
    return !!b;
  },
};

function findNode(name: string, nth = 0): SceneNode | undefined {
  let seen = 0;
  const walk = (nodes: SceneNode[]): SceneNode | undefined => {
    for (const n of nodes) {
      if (n.name === name && seen++ === nth) return n;
      const r = walk(n.children);
      if (r) return r;
    }
  };
  return page ? walk(page.children) : undefined;
}

new ResizeObserver(resize).observe(canvasEl);
resize();
await loadFixtureList();
setStatus('Выберите файл .fig из списка, откройте свой или перетащите его в окно');
loop();
