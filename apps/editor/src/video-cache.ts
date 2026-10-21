// Fill videos on the canvas: one video element per video (bytes from the document's image
// storage), muted, looped. Each new frame becomes an image for the renderer
// (MakeLazyImageFromTextureSource) and triggers a redraw of tiles with this video (onFrame). A video that
// hasn't been drawn for a while (off screen, another page) is paused until it is shown again.

import type { CanvasKit, Image } from 'canvaskit-wasm';
import type { ImageBytesSource } from '@mfp/io-figma';
import type { VideoSource } from '@mfp/renderer';

interface Item {
  el: HTMLVideoElement;
  url: string | null;
  image: Image | null;
  /** When the frame was last requested (drawn). */
  used: number;
  failed: boolean;
}

/** File type from the first bytes (MP4 / MOV — ftyp, WebM — EBML). */
function videoMime(b: Uint8Array): string {
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  const tag = String.fromCharCode(b[4] ?? 0, b[5] ?? 0, b[6] ?? 0, b[7] ?? 0, b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0);
  if (tag.startsWith('ftypqt')) return 'video/quicktime';
  return 'video/mp4';
}

/** Whether it looks like a video (for pasting files without a type). */
export function isVideoBytes(b: Uint8Array): boolean {
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;
  return String.fromCharCode(b[4] ?? 0, b[5] ?? 0, b[6] ?? 0, b[7] ?? 0) === 'ftyp';
}

/** Video frame size (for the layer when inserting); null — unreadable. */
export async function videoSize(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: videoMime(bytes) }));
  try {
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'metadata';
    el.src = url;
    await new Promise<void>((resolve, reject) => {
      el.addEventListener('loadedmetadata', () => resolve(), { once: true });
      el.addEventListener('error', () => reject(new Error('video')), { once: true });
    });
    return el.videoWidth && el.videoHeight ? { width: el.videoWidth, height: el.videoHeight } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class VideoCache implements VideoSource {
  private items = new Map<string, Item>();
  private ck: CanvasKit;
  private source: () => ImageBytesSource | null;
  private onFrame: (hash: string) => void;

  constructor(ck: CanvasKit, source: () => ImageBytesSource | null, onFrame: (hash: string) => void) {
    this.ck = ck;
    this.source = source;
    this.onFrame = onFrame;
  }

  frame(hash: string): Image | undefined {
    let it = this.items.get(hash);
    if (!it) it = this.start(hash);
    it.used = performance.now();
    // Back on screen — resume.
    if (it.el.paused && it.url && !it.failed) void it.el.play().catch(() => {});
    return it.image ?? undefined;
  }

  private start(hash: string): Item {
    const el = document.createElement('video');
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.preload = 'auto';
    const it: Item = { el, url: null, image: null, used: performance.now(), failed: false };
    this.items.set(hash, it);
    const tick = () => {
      if (this.items.get(hash) !== it) return;
      // Not drawn for a while — pause (frames aren't decoded for nothing).
      if (performance.now() - it.used > 1500) {
        el.pause();
        return;
      }
      it.image?.delete();
      it.image = this.ck.MakeLazyImageFromTextureSource(el) ?? null;
      this.onFrame(hash);
      next();
    };
    // One pending frame at a time (play and loadeddata both start the loop).
    let waiting = false;
    const next = () => {
      if (waiting) return;
      waiting = true;
      const go = () => {
        waiting = false;
        tick();
      };
      const rvfc = (el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (rvfc) rvfc.call(el, go);
      else setTimeout(go, 33);
    };
    el.addEventListener('play', () => next());
    void (async () => {
      const bytes = await this.source()?.readImage(hash);
      if (!bytes || this.items.get(hash) !== it) {
        it.failed = true;
        return;
      }
      it.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: videoMime(bytes) }));
      el.src = it.url;
      el.addEventListener('loadeddata', () => tick(), { once: true });
      el.addEventListener('error', () => (it.failed = true), { once: true });
      void el.play().catch(() => {});
    })();
    return it;
  }

  /** Forget everything (another document). */
  dispose() {
    for (const it of this.items.values()) {
      it.el.pause();
      it.el.removeAttribute('src');
      it.el.load();
      if (it.url) URL.revokeObjectURL(it.url);
      it.image?.delete();
    }
    this.items.clear();
  }
}
