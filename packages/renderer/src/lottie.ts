// Lottie in fills: file parsing (.json — bodymovin, .lottie — dotLottie zip with a manifest,
// animations and images) and Skottie animations by hash. Skottie exists only in the full CanvasKit
// build (canvaskit-wasm/full); in the regular one Lottie is drawn as a placeholder. The renderer
// draws the frame: the frame is recorded into an SkPicture with a paint over it — vector at any scale.

import { unzipSync, strFromU8 } from 'fflate';
import type { CanvasKit, ManagedSkottieAnimation } from 'canvaskit-wasm';
import type { ImageBytesSource } from '@mfp/io-figma';

/** Parsed file: animation JSON and images (file name → bytes), as Skottie expects. */
export interface LottieFile {
  json: string;
  assets: Record<string, ArrayBuffer>;
  width: number;
  height: number;
  /** Duration, seconds. */
  duration: number;
  fps: number;
  name?: string;
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Whether it looks like Lottie: dotLottie zip (with a manifest) or bodymovin JSON (v, fr, ip, op, layers). */
export function isLottieBytes(b: Uint8Array): boolean {
  if (isZip(b)) {
    try {
      const names = Object.keys(unzipSync(b, { filter: (f) => f.name === 'manifest.json' }));
      return names.length > 0;
    } catch {
      return false;
    }
  }
  let i = 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09 || b[i] === 0xef || b[i] === 0xbb || b[i] === 0xbf)) i++;
  if (b[i] !== 0x7b) return false;
  try {
    return lottieMeta(JSON.parse(strFromU8(b))) !== null;
  } catch {
    return false;
  }
}

interface LottieJson {
  v?: string;
  fr?: number;
  ip?: number;
  op?: number;
  w?: number;
  h?: number;
  nm?: string;
  layers?: unknown[];
  assets?: { id?: string; p?: string; u?: string; e?: number }[];
}

function lottieMeta(j: LottieJson): { width: number; height: number; duration: number; fps: number; name?: string } | null {
  if (!j || typeof j !== 'object' || !Array.isArray(j.layers)) return null;
  const fps = Number(j.fr);
  const w = Number(j.w);
  const h = Number(j.h);
  if (!(fps > 0) || !(w > 0) || !(h > 0)) return null;
  const frames = Math.max(1, Number(j.op ?? 0) - Number(j.ip ?? 0));
  return { width: w, height: h, duration: frames / fps, fps, name: typeof j.nm === 'string' && j.nm ? j.nm : undefined };
}

const buffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Parse a Lottie file; null — not Lottie. From dotLottie the manifest's first animation is taken. */
export function parseLottie(bytes: Uint8Array): LottieFile | null {
  try {
    if (isZip(bytes)) {
      const files = unzipSync(bytes);
      const manifest = files['manifest.json'] ? (JSON.parse(strFromU8(files['manifest.json'])) as { animations?: { id?: string }[] }) : null;
      const id = manifest?.animations?.[0]?.id;
      // dotLottie 1.0: animations/<id>.json, images/; 2.0: a/<id>.json, i/.
      const path =
        (id && (files[`animations/${id}.json`] ? `animations/${id}.json` : files[`a/${id}.json`] ? `a/${id}.json` : null)) ??
        Object.keys(files).find((n) => /^(animations|a)\/[^/]+\.json$/.test(n));
      if (!path || !files[path]) return null;
      const json = strFromU8(files[path]);
      const meta = lottieMeta(JSON.parse(json));
      if (!meta) return null;
      const assets: Record<string, ArrayBuffer> = {};
      for (const [name, data] of Object.entries(files)) {
        const m = /^(?:images|i|fonts|f)\/(.+)$/.exec(name);
        if (m && data.length) assets[m[1]!] = buffer(data);
      }
      return { json, assets, ...meta };
    }
    const json = strFromU8(bytes);
    const meta = lottieMeta(JSON.parse(json));
    return meta ? { json, assets: {}, ...meta } : null;
  } catch {
    return null;
  }
}

/** Ready animation by file hash. */
export interface LottieClip {
  anim: ManagedSkottieAnimation;
  width: number;
  height: number;
  duration: number;
  fps: number;
  /** Frame count (the last one is frames − 1). */
  frames: number;
}

/** Lottie animation source for the renderer; time — the moment (seconds) for paint key, otherwise the clock. */
export interface LottieSource {
  clip(hash: string): LottieClip | undefined;
  time?(hash: string, key: object, clip: LottieClip): number;
}

/** Whether this CanvasKit build has Skottie. */
export const hasSkottie = (ck: CanvasKit) => typeof (ck as { MakeManagedAnimation?: unknown }).MakeManagedAnimation === 'function';

/** Document Lottie animations: bytes — from the image store, loaded on first display. */
export class LottieLibrary implements LottieSource {
  private items = new Map<string, LottieClip | null | Promise<void>>();
  private ck: CanvasKit;
  private source: () => ImageBytesSource | null;
  private onLoad: (hash: string) => void;

  constructor(ck: CanvasKit, source: () => ImageBytesSource | null, onLoad: (hash: string) => void = () => {}) {
    this.ck = ck;
    this.source = source;
    this.onLoad = onLoad;
  }

  /** No loads (export waits until animations finish loading). */
  get idle(): boolean {
    for (const it of this.items.values()) if (it instanceof Promise) return false;
    return true;
  }

  clip(hash: string): LottieClip | undefined {
    const it = this.items.get(hash);
    if (it === undefined) {
      this.items.set(hash, this.load(hash));
      return undefined;
    }
    return it instanceof Promise || it === null ? undefined : it;
  }

  /** Load immediately (export in Node and before a snapshot). */
  async preload(hashes: Iterable<string>) {
    const waits: Promise<void>[] = [];
    for (const h of hashes) {
      if (!this.items.has(h)) this.items.set(h, this.load(h));
      const it = this.items.get(h);
      if (it instanceof Promise) waits.push(it);
    }
    await Promise.all(waits);
  }

  /** Animation from bytes (file insertion: size and duration before writing to the store). */
  make(bytes: Uint8Array): LottieClip | null {
    const file = parseLottie(bytes);
    if (!file || !hasSkottie(this.ck)) return null;
    const anim = this.ck.MakeManagedAnimation(file.json, file.assets);
    if (!anim) return null;
    const [w, h] = anim.size();
    const duration = anim.duration() || file.duration;
    const fps = anim.fps() || file.fps;
    return { anim, width: w || file.width, height: h || file.height, duration, fps, frames: Math.max(1, Math.round(duration * fps)) };
  }

  private async load(hash: string): Promise<void> {
    let clip: LottieClip | null = null;
    try {
      const bytes = await this.source()?.readImage(hash);
      clip = bytes ? this.make(bytes) : null;
    } catch (e) {
      console.warn('Lottie', hash, e);
    }
    this.items.set(hash, clip);
    if (clip) this.onLoad(hash);
  }

  /** The bytes under the hash changed — forget the animation. */
  invalidate(hash: string) {
    const it = this.items.get(hash);
    if (it && !(it instanceof Promise)) it.anim.delete();
    this.items.delete(hash);
  }

  dispose() {
    for (const it of this.items.values()) if (it && !(it instanceof Promise)) it.anim.delete();
    this.items.clear();
  }
}
