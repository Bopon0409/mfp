// Lottie in prototype presentation: each layer with a Lottie fill has its own playback (key — its
// paint in the presentation scene, layer — bound at build time), as with video: autoplay and loop
// are layer settings (videoPlayback); prototype actions (UPDATE_MEDIA_RUNTIME) — play, pause, seek.
// The end of a non-looping animation fires the ON_MEDIA_END trigger.

import type { CanvasKit } from 'canvaskit-wasm';
import type { Document, PrototypeAction } from '@mfp/core';
import type { ImageBytesSource } from '@mfp/io-figma';
import { LottieLibrary, type LottieClip, type LottieSource } from '@mfp/renderer';
import { playbackOf } from './videos.ts';

type MediaAction = Extract<PrototypeAction, { type: 'UPDATE_MEDIA_RUNTIME' }>;

interface Item {
  node: string;
  /** The moment (clock, ms) the animation runs from, and the position (seconds) while paused. */
  start: number;
  paused: number | null;
  loop: boolean;
  speed: number;
  duration: number;
  ended: boolean;
}

export class PlayerLotties implements LottieSource {
  private library: LottieLibrary;
  private items = new Map<object, Item>();
  private nodes = new WeakMap<object, string>();
  private doc: Document;
  private onEnd: (node: string) => void;
  /** Some animation was running in this frame — the next frame is needed. */
  private running = false;

  constructor(ck: CanvasKit, doc: Document, source: ImageBytesSource | null, onLoad: () => void, onEnd: (node: string) => void) {
    this.library = new LottieLibrary(ck, () => source, onLoad);
    this.doc = doc;
    this.onEnd = onEnd;
  }

  /** Paint fp (with speed speed) in the presentation scene belongs to layer node. */
  bind(fp: object, node: string) {
    this.nodes.set(fp, node);
  }

  clip(hash: string): LottieClip | undefined {
    return this.library.clip(hash);
  }

  time(_hash: string, key: object, clip: LottieClip): number {
    let it = this.items.get(key);
    if (!it) {
      const node = this.nodes.get(key);
      const pb = node ? playbackOf(this.doc, node) : { autoplay: true, loop: true };
      const speed = (key as { lottie?: { speed?: number } }).lottie?.speed ?? 1;
      it = { node: node ?? '', start: performance.now(), paused: pb.autoplay ? null : 0, loop: pb.loop, speed, duration: clip.duration, ended: false };
      this.items.set(key, it);
    }
    if (it.paused !== null) return it.paused;
    const t = ((performance.now() - it.start) / 1000) * it.speed;
    if (!it.loop && t >= it.duration) {
      // End without loop — last frame, trigger fires once.
      if (!it.ended) {
        it.ended = true;
        it.paused = Math.max(0, it.duration - 1e-3);
        if (it.node) this.onEnd(it.node);
      }
      return it.paused ?? t;
    }
    this.running = true;
    return t;
  }

  /** Whether an animation was running since the previous call. */
  takeRunning(): boolean {
    const v = this.running;
    this.running = false;
    return v;
  }

  /** Prototype action on a layer's Lottie. */
  apply(a: MediaAction) {
    const now = performance.now();
    for (const it of this.items.values()) {
      if (it.node !== a.destinationId) continue;
      const pos = () => (it.paused !== null ? it.paused : ((now - it.start) / 1000) * it.speed);
      const seek = (t: number) => {
        const v = Math.max(0, it.loop ? t : Math.min(it.duration, t));
        it.ended = false;
        if (it.paused !== null) it.paused = v;
        else it.start = now - (v / it.speed) * 1000;
      };
      const play = () => {
        if (it.paused === null) return;
        const from = it.ended ? 0 : it.paused;
        it.ended = false;
        it.paused = null;
        it.start = now - (from / it.speed) * 1000;
      };
      const pause = () => {
        if (it.paused === null) it.paused = pos();
      };
      switch (a.mediaAction) {
        case 'PLAY':
          play();
          break;
        case 'PAUSE':
          pause();
          break;
        case 'TOGGLE_PLAY_PAUSE':
          if (it.paused === null) pause();
          else play();
          break;
        case 'SKIP_FORWARD':
          seek(pos() + (a.amountToSkip ?? 5));
          break;
        case 'SKIP_BACKWARD':
          seek(pos() - (a.amountToSkip ?? 5));
          break;
        case 'SKIP_TO':
          seek(a.newTimestamp ?? 0);
          break;
        default:
          break;
      }
    }
  }

  dispose() {
    this.items.clear();
    this.library.dispose();
  }
}
