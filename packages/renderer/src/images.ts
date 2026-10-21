// Image cache with levels of detail.
// An image is decoded at a size close to its on-screen size (powers of two, up to
// 4096 px). If it is smaller than 8 px on screen, it is not loaded at all.
// Loads go through a bounded queue: most recently requested first.
// Animated ones (GIF, WebP, APNG) loop: ImageDecoder decodes the frames, the current frame is the
// image's only level; a new frame triggers onLoad (as with video: tiles with it are redrawn).
// An image that hasn't been drawn for a while pauses until it is shown again.
// Decoding: PNG — ImageDecoder straight from bytes, the rest — via Blob (JPEG gets EXIF rotation);
// if that fails — the other way. With bulk loading of large images Blob hits the browser's Blob
// storage limit and the decoder fails (Untitled: 160 of 239 large images in a row; one at a time
// all are fine). The failure is temporary: retries after 1.5 and 6 s, the image is marked failed
// after the third.
// Memory: decoded data is within a budget. Above it, large levels of images not requested for
// more than 3 s are released (the small one — up to KEEP_PX — stays, so it returns to screen without
// a gap), and renderers drop paints holding them (a paint holds the image, otherwise the memory
// is not reclaimed).

import type { CanvasKit, Image } from 'canvaskit-wasm';
import type { ImageBytesSource } from '@mfp/io-figma';
import type { ImageSource } from './renderer.ts';

const MIN_PX = 8;
const MAX_PX = 4096;
const CONCURRENCY = 4;
/** Decode attempts before an image is considered failed. */
const ATTEMPTS = 3;
const RETRY_MS = 1500;
/** Default budget for decoded images, bytes. */
const BUDGET = 768 * 2 ** 20;
/** Levels up to this side are not evicted. */
const KEEP_PX = 128;
/** Image not requested for longer than this (ms) — its large levels may be released. */
const IDLE_MS = 3000;

interface Entry {
  levels: Map<number, Image>;
  /** Level bitmaps: live as long as the level (the image is restored from them on WebGL loss). */
  bitmaps: Map<number, ImageBitmap>;
  /** When the image was last requested (performance.now()). */
  used: number;
  pending: Set<number>;
  failed: boolean;
  /** Consecutive failed attempts and when to retry (performance.now()). */
  attempts?: number;
  retryAt?: number;
  anim?: Animation;
}

/** Bytes → ImageBitmap; resizeWidth — downscale while decoding (proportionally). */
async function viaDecoder(bytes: Uint8Array, type: string, resizeWidth?: number): Promise<ImageBitmap> {
  const decoder = new ImageDecoder({ data: bytes, type });
  try {
    const { image } = await decoder.decode();
    try {
      return await (resizeWidth ? createImageBitmap(image, { resizeWidth, resizeQuality: 'medium' }) : createImageBitmap(image));
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}

function viaBlob(bytes: Uint8Array, _type: string, resizeWidth?: number): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart]);
  return resizeWidth ? createImageBitmap(blob, { resizeWidth, resizeQuality: 'medium' }) : createImageBitmap(blob);
}

/** Decode: first with the method reliable for the format; if that fails — another. */
export async function decodeImage(bytes: Uint8Array, resizeWidth?: number): Promise<ImageBitmap> {
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const decoder = typeof ImageDecoder === 'function';
  const ways = png && decoder ? [viaDecoder, viaBlob] : decoder ? [viaBlob, viaDecoder] : [viaBlob];
  const type = png ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes[0] === 0x52 && bytes[1] === 0x49 ? 'image/webp' : 'image/png';
  let error: unknown;
  for (const way of ways) {
    try {
      return await way(bytes, type, resizeWidth);
    } catch (e) {
      error = e;
    }
  }
  throw error;
}

interface Animation {
  decoder: ImageDecoder;
  count: number;
  /** Next frame. */
  index: number;
  /** Level (side) at which frames are decoded. */
  level: number;
  width: number;
  height: number;
  used: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Animated image type from the leading bytes: GIF, WebP with ANIM, PNG with acTL; null — static. */
export function animatedImageType(b: Uint8Array): string | null {
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  const tag = (o: number) => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
  if (tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    for (let o = 12; o + 8 <= Math.min(b.length, 4096); ) {
      if (tag(o) === 'ANIM') return 'image/webp';
      o += 8 + (((b[o + 4]! | (b[o + 5]! << 8) | (b[o + 6]! << 16) | (b[o + 7]! << 24)) + 1) & ~1);
    }
    return null;
  }
  if (b[0] === 0x89 && tag(1).startsWith('PNG')) {
    // acTL comes before the first IDAT.
    for (let o = 8; o + 8 <= b.length; ) {
      const len = ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
      const t = tag(o + 4);
      if (t === 'acTL') return 'image/png';
      if (t === 'IDAT') return null;
      o += 12 + len;
    }
  }
  return null;
}

export function levelFor(screenPx: number): number {
  if (screenPx < MIN_PX) return 0;
  return Math.min(MAX_PX, 2 ** Math.ceil(Math.log2(screenPx)));
}

export class ImageCache implements ImageSource {
  private entries = new Map<string, Entry>();
  private queue: { hash: string; level: number; width?: number }[] = [];
  private active = 0;
  loaded = 0;
  /** Currently decoded, bytes. */
  bytes = 0;
  private budget: number;
  private ck: CanvasKit;
  private archive: ImageBytesSource | null;
  private onLoad: (hash: string) => void;
  private evictListeners = new Set<(hashes: ReadonlySet<string>) => void>();

  constructor(ck: CanvasKit, archive: ImageBytesSource | null, onLoad: (hash: string) => void, budget = BUDGET) {
    this.ck = ck;
    this.archive = archive;
    this.onLoad = onLoad;
    this.budget = budget;
  }

  /** Subscribe to image releases (the renderer drops paints holding them); returns an unsubscribe. */
  onEvict(listener: (hashes: ReadonlySet<string>) => void): () => void {
    this.evictListeners.add(listener);
    return () => this.evictListeners.delete(listener);
  }

  private setLevel(e: Entry, level: number, img: Image, bitmap: ImageBitmap) {
    this.dropLevel(e, level);
    e.levels.set(level, img);
    e.bitmaps.set(level, bitmap);
    this.bytes += bitmap.width * bitmap.height * 4;
  }

  private dropLevel(e: Entry, level: number) {
    const img = e.levels.get(level);
    if (!img) return;
    img.delete();
    e.levels.delete(level);
    const bm = e.bitmaps.get(level);
    if (bm) {
      this.bytes -= bm.width * bm.height * 4;
      bm.close();
      e.bitmaps.delete(level);
    }
  }

  /** Over budget — large levels of long-unneeded images, oldest first. */
  private evict() {
    if (this.bytes <= this.budget) return;
    const now = performance.now();
    const old = [...this.entries].filter(([, e]) => !e.anim && now - e.used > IDLE_MS).sort((a, b) => a[1].used - b[1].used);
    const dropped = new Set<string>();
    for (const [hash, e] of old) {
      for (const l of [...e.levels.keys()]) {
        if (l <= KEEP_PX) continue;
        this.dropLevel(e, l);
        dropped.add(hash);
      }
      if (this.bytes <= this.budget * 0.75) break;
    }
    if (dropped.size) for (const l of this.evictListeners) l(dropped);
  }

  /**
   * Best available version of the image for size screenPx (by the longer side).
   * If the needed version is missing, queues it and returns the closest available one.
   */
  get(hash: string, screenPx: number, originalWidth?: number): Image | undefined {
    let level = levelFor(screenPx);
    let e = this.entries.get(hash);
    if (!e) this.entries.set(hash, (e = { levels: new Map(), bitmaps: new Map(), used: 0, pending: new Set(), failed: false }));
    e.used = performance.now();
    // A quick small preview first; subsequent visible draws ask for the zoom-appropriate level.
    if (this.archive?.readImagePreview && !e.levels.size) level = Math.min(level, 256);
    const a = e.anim;
    if (a) {
      // Animation: one level — the largest requested; back on screen — continue through the frames.
      a.used = performance.now();
      if (level > a.level) a.level = level;
      if (!a.running) {
        a.running = true;
        void this.step(hash, e);
      }
      return this.best(e, level);
    }
    if (level > 0 && !e.failed && !e.levels.has(level) && !e.pending.has(level) && this.archive && !(e.retryAt && performance.now() < e.retryAt)) {
      e.pending.add(level);
      this.queue.push({ hash, level, width: originalWidth });
      this.pump();
    }
    // Repeated requests are from the current viewport: promote them above old off-screen work.
    const queued = this.queue.findIndex(job => job.hash === hash && job.level === level);
    if (queued >= 0) this.queue.push(this.queue.splice(queued, 1)[0]!);
    return this.best(e, level);
  }

  private best(e: Entry, level: number): Image | undefined {
    let above: [number, Image] | undefined;
    let below: [number, Image] | undefined;
    for (const [l, img] of e.levels) {
      if (l >= level && (!above || l < above[0])) above = [l, img];
      if (l < level && (!below || l > below[0])) below = [l, img];
    }
    return (above ?? below)?.[1];
  }

  private pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.pop()!; // LIFO: what is visible now matters more than something requested long ago
      this.active++;
      void this.load(job.hash, job.level, job.width).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async load(hash: string, level: number, originalWidth?: number) {
    const e = this.entries.get(hash)!;
    try {
      const bytes = await (this.archive!.readImagePreview?.(hash, level) ?? this.archive!.readImage(hash));
      if (!bytes) throw new Error('нет в архиве');
      if (await this.animate(hash, e, bytes, level)) return;
      let bitmap: ImageBitmap;
      if (!this.archive!.readImagePreview && originalWidth && originalWidth > level) {
        bitmap = await decodeImage(bytes, level);
      } else {
        bitmap = await decodeImage(bytes);
        if (Math.max(bitmap.width, bitmap.height) > level) {
          const s = level / Math.max(bitmap.width, bitmap.height);
          const resized = await createImageBitmap(bitmap, {
            resizeWidth: Math.max(1, Math.round(bitmap.width * s)),
            resizeHeight: Math.max(1, Math.round(bitmap.height * s)),
            resizeQuality: 'medium',
          });
          bitmap.close();
          bitmap = resized;
        }
      }
      // The texture lives on the GPU. The ImageBitmap is not closed — it is needed
      // for restoring after WebGL context loss.
      const img = this.ck.MakeLazyImageFromTextureSource(bitmap);
      if (!img) throw new Error('CanvasKit не принял картинку');
      if (this.entries.get(hash) !== e) {
        img.delete();
        bitmap.close();
        return;
      }
      this.setLevel(e, level, img, bitmap);
      this.evict();
      e.attempts = 0;
      e.retryAt = undefined;
      this.loaded++;
      this.onLoad(hash);
    } catch (err) {
      e.attempts = (e.attempts ?? 0) + 1;
      if (e.attempts >= ATTEMPTS) {
        e.failed = true;
        console.warn('Картинка', hash, err);
      } else {
        // Retry: redrawing tiles with the image will request it again (get).
        const wait = RETRY_MS * 4 ** (e.attempts - 1);
        e.retryAt = performance.now() + wait;
        setTimeout(() => {
          if (this.entries.get(hash) === e) this.onLoad(hash);
        }, wait);
      }
    } finally {
      e.pending.delete(level);
    }
  }

  /** Whether the image is animated (the renderer holds a paint per frame, as with video). */
  animated(hash: string): boolean {
    return !!this.entries.get(hash)?.anim;
  }

  /** Animated image: frame decoder and first frame; false — static. */
  private async animate(hash: string, e: Entry, bytes: Uint8Array, level: number): Promise<boolean> {
    const type = animatedImageType(bytes);
    if (!type || typeof ImageDecoder === 'undefined') return false;
    let decoder: ImageDecoder;
    try {
      decoder = new ImageDecoder({ data: bytes, type });
      // Tracks — after ready (completed only means “data received”).
      await decoder.tracks.ready;
      await decoder.completed;
      const t = decoder.tracks.selectedTrack;
      if (!t?.animated || t.frameCount < 2) {
        decoder.close();
        return false;
      }
      const first = await decoder.decode({ frameIndex: 0 });
      const width = first.image.displayWidth;
      const height = first.image.displayHeight;
      first.image.close();
      e.anim = { decoder, count: t.frameCount, index: 0, level, width, height, used: performance.now(), running: true, timer: null };
    } catch {
      return false;
    }
    if (this.entries.get(hash) !== e) {
      decoder.close();
      return true;
    }
    await this.step(hash, e);
    return true;
  }

  /** Next animation frame — into the image level; after its duration — the next one. */
  private async step(hash: string, e: Entry) {
    const a = e.anim;
    if (!a || this.entries.get(hash) !== e) return;
    a.timer = null;
    // Not drawn for a while — stop until next shown (get will restart it).
    if (performance.now() - a.used > 1500) {
      a.running = false;
      return;
    }
    a.running = true;
    try {
      const r = await a.decoder.decode({ frameIndex: a.index });
      const frame = r.image;
      const duration = Math.max(20, (frame.duration ?? 100_000) / 1000);
      const k = Math.min(1, a.level / Math.max(a.width, a.height));
      const bitmap = await createImageBitmap(frame, { resizeWidth: Math.max(1, Math.round(a.width * k)), resizeHeight: Math.max(1, Math.round(a.height * k)), resizeQuality: 'medium' });
      frame.close();
      if (this.entries.get(hash) !== e || e.anim !== a) {
        bitmap.close();
        return;
      }
      const img = this.ck.MakeLazyImageFromTextureSource(bitmap);
      if (img) {
        // Release the previous frame right away (and its bitmap, otherwise it would wait for GC).
        for (const l of [...e.levels.keys()]) this.dropLevel(e, l);
        this.setLevel(e, a.level, img, bitmap);
      } else bitmap.close();
      a.index = (a.index + 1) % a.count;
      this.loaded++;
      this.onLoad(hash);
      a.timer = setTimeout(() => void this.step(hash, e), duration);
    } catch (err) {
      a.running = false;
      console.warn('Анимация картинки', hash, err);
    }
  }

  private stop(e: Entry) {
    if (!e.anim) return;
    if (e.anim.timer) clearTimeout(e.anim.timer);
    e.anim.decoder.close();
    e.anim = undefined;
  }

  /** The image appeared (or changed) in the source — forget previous attempts. */
  invalidate(hash: string) {
    const e = this.entries.get(hash);
    if (!e) return;
    this.stop(e);
    for (const l of [...e.levels.keys()]) this.dropLevel(e, l);
    this.entries.delete(hash);
  }

  /** Forget the queue (loads not yet started): left the page — its images are no longer needed. */
  cancelPending() {
    for (const job of this.queue) this.entries.get(job.hash)?.pending.delete(job.level);
    this.queue = [];
  }

  /** No loads in progress and no queue. */
  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  dispose() {
    for (const e of this.entries.values()) {
      this.stop(e);
      for (const l of [...e.levels.keys()]) this.dropLevel(e, l);
    }
    this.entries.clear();
    this.queue = [];
    this.evictListeners.clear();
  }
}
