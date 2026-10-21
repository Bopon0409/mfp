// Video in prototype presentation: each layer with a video fill has its own playback (key — its
// paint in the presentation scene, layer — bound at build time). Layer settings (videoPlayback):
// autoplay, loop, muted. Prototype actions (UPDATE_MEDIA_RUNTIME) control the target layer's
// video; the end of the video and passing a time point fire the ON_MEDIA_END and ON_MEDIA_HIT triggers.

import type { CanvasKit, Image } from 'canvaskit-wasm';
import type { Document, PrototypeAction } from '@mfp/core';
import type { ImageBytesSource } from '@mfp/io-figma';
import type { VideoSource } from '@mfp/renderer';

type MediaAction = Extract<PrototypeAction, { type: 'UPDATE_MEDIA_RUNTIME' }>;

interface Item {
  node: string;
  el: HTMLVideoElement;
  url: string | null;
  image: Image | null;
  /** Last playback time (for ON_MEDIA_HIT), seconds. */
  last: number;
}

/** Layer video settings (autoplay and loop — on; sound — on). */
export function playbackOf(doc: Document, id: string): { autoplay: boolean; loop: boolean; muted: boolean } {
  const p = doc.get(id, 'videoPlayback');
  return { autoplay: p?.autoplay ?? true, loop: p?.loop ?? true, muted: p?.muted ?? false };
}

export class PlayerVideos implements VideoSource {
  private items = new Map<object, Item>();
  /** Scene paint → layer (presentation binds it when building the layer). */
  private nodes = new WeakMap<object, string>();
  private ck: CanvasKit;
  private doc: Document;
  private source: ImageBytesSource | null;
  private onFrame: () => void;
  private onMedia: (node: string, kind: 'end' | 'time', from: number, to: number) => void;

  constructor(ck: CanvasKit, doc: Document, source: ImageBytesSource | null, onFrame: () => void, onMedia: (node: string, kind: 'end' | 'time', from: number, to: number) => void) {
    this.ck = ck;
    this.doc = doc;
    this.source = source;
    this.onFrame = onFrame;
    this.onMedia = onMedia;
  }

  /** Paint fp in the presentation scene belongs to layer node. */
  bind(fp: object, node: string) {
    this.nodes.set(fp, node);
  }

  frame(hash: string, key: object): Image | undefined {
    let it = this.items.get(key);
    if (!it) {
      const node = this.nodes.get(key);
      if (!node) return undefined;
      it = this.start(hash, node, key);
    }
    return it.image ?? undefined;
  }

  private start(hash: string, node: string, key: object): Item {
    const el = document.createElement('video');
    const pb = playbackOf(this.doc, node);
    el.loop = pb.loop;
    el.muted = pb.muted;
    el.playsInline = true;
    el.preload = 'auto';
    const it: Item = { node, el, url: null, image: null, last: 0 };
    this.items.set(key, it);
    let waiting = false;
    const tick = () => {
      waiting = false;
      if (this.items.get(key) !== it) return;
      it.image?.delete();
      it.image = this.ck.MakeLazyImageFromTextureSource(el) ?? null;
      // “Reached”: the time point lies between the previous and the current time.
      const now = el.currentTime;
      if (now > it.last) this.onMedia(node, 'time', it.last, now);
      it.last = now;
      this.onFrame();
      if (!el.paused && !el.ended) next();
    };
    const next = () => {
      if (waiting) return;
      waiting = true;
      const rvfc = (el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (rvfc) rvfc.call(el, tick);
      else setTimeout(tick, 33);
    };
    el.addEventListener('play', next);
    el.addEventListener('seeked', () => {
      it.last = el.currentTime;
      next();
    });
    el.addEventListener('ended', () => this.onMedia(node, 'end', 0, 0));
    void (async () => {
      const bytes = await this.source?.readImage(hash);
      if (!bytes || this.items.get(key) !== it) return;
      it.url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      el.src = it.url;
      el.addEventListener('loadeddata', () => tick(), { once: true });
      if (pb.autoplay) {
        // With sound the browser may refuse to start without a user gesture — then muted.
        await el.play().catch(async () => {
          el.muted = true;
          await el.play().catch(() => {});
        });
      }
    })();
    return it;
  }

  /** Prototype action on a layer's video (on all of its video fills). */
  apply(a: MediaAction) {
    for (const it of this.items.values()) {
      if (it.node !== a.destinationId) continue;
      const el = it.el;
      switch (a.mediaAction) {
        case 'PLAY':
          void el.play().catch(() => {});
          break;
        case 'PAUSE':
          el.pause();
          break;
        case 'TOGGLE_PLAY_PAUSE':
          if (el.paused) void el.play().catch(() => {});
          else el.pause();
          break;
        case 'MUTE':
          el.muted = true;
          break;
        case 'UNMUTE':
          el.muted = false;
          break;
        case 'TOGGLE_MUTE_UNMUTE':
          el.muted = !el.muted;
          break;
        case 'SKIP_FORWARD':
          el.currentTime = Math.min(el.duration || Infinity, el.currentTime + (a.amountToSkip ?? 5));
          break;
        case 'SKIP_BACKWARD':
          el.currentTime = Math.max(0, el.currentTime - (a.amountToSkip ?? 5));
          break;
        case 'SKIP_TO':
          el.currentTime = Math.max(0, a.newTimestamp ?? 0);
          break;
      }
    }
  }

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
