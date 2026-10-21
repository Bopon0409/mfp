// 3D models in prototype presentation: each layer has its own clip playback (key — its paint in
// the presentation scene), as with video: autoplay and loop are layer settings (videoPlayback),
// prototype actions (UPDATE_MEDIA_RUNTIME) — play, pause, seek; the end of a non-looping clip fires
// ON_MEDIA_END. Rotation: drag with the mouse or a finger (if the fill has orbit), autoRotate — on its own.

import type { CanvasKit } from 'canvaskit-wasm';
import type { Document, PrototypeAction } from '@mfp/core';
import type { ImageBytesSource } from '@mfp/io-figma';
import type { ModelView } from '@mfp/renderer';
import { ModelLibrary, type ModelInfo } from '../model3d.ts';
import { playbackOf } from './videos.ts';

type MediaAction = Extract<PrototypeAction, { type: 'UPDATE_MEDIA_RUNTIME' }>;

interface Item {
  node: string;
  start: number;
  paused: number | null;
  loop: boolean;
  duration: number;
  ended: boolean;
  /** User rotation and tilt (degrees, relative to the fill's angle), auto-rotation — since its start. */
  yaw: number;
  pitch: number;
  auto: boolean;
}

/** Auto-rotation speed, degrees per second. */
const AUTO_DEG_PER_S = 24;

export class PlayerModels {
  readonly library: ModelLibrary;
  private items = new Map<object, Item>();
  private nodes = new WeakMap<object, string>();
  private doc: Document;
  private onEnd: (node: string) => void;
  private running = false;

  constructor(ck: CanvasKit, doc: Document, source: ImageBytesSource | null, onLoad: () => void, onEnd: (node: string) => void) {
    this.doc = doc;
    this.onEnd = onEnd;
    this.library = new ModelLibrary(ck, () => source, () => onLoad(), {
      time: (key, _hash, view, info) => this.time(key, view, info),
      camera: (key, view) => this.camera(key, view),
      live: (key) => this.isLive(key),
    });
  }

  /** Paint fp in the presentation scene belongs to layer node. */
  bind(fp: object, node: string) {
    this.nodes.set(fp, node);
  }

  private item(key: object, view: ModelView, info: ModelInfo | null): Item {
    let it = this.items.get(key);
    if (!it) {
      const node = this.nodes.get(key) ?? '';
      const pb = node ? playbackOf(this.doc, node) : { autoplay: true, loop: true };
      const clip = view.clip === '' ? null : (view.clip ?? info?.clips[0]?.name ?? null);
      const duration = info?.clips.find((c) => c.name === clip)?.duration ?? 0;
      const fill = node ? (this.doc.get(node, 'fills') ?? []).find((p) => p.type === 'MODEL3D') : undefined;
      it = { node, start: performance.now(), paused: pb.autoplay ? null : (view.pose ?? 0), loop: pb.loop, duration, ended: false, yaw: 0, pitch: 0, auto: fill?.type === 'MODEL3D' && fill.autoRotate === true };
      this.items.set(key, it);
    }
    // The state may appear before the model info (the angle is requested before the clip time).
    if (info && !it.duration) {
      const clip = view.clip === '' ? null : (view.clip ?? info.clips[0]?.name ?? null);
      it.duration = info.clips.find((c) => c.name === clip)?.duration ?? 0;
    }
    return it;
  }

  private time(key: object, view: ModelView, info: ModelInfo): number {
    const it = this.item(key, view, info);
    if (!it.duration) return view.pose;
    if (it.paused !== null) return it.paused;
    const t = (performance.now() - it.start) / 1000;
    if (!it.loop && t >= it.duration) {
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

  private camera(key: object, view: ModelView): ModelView['camera'] {
    const it = this.item(key, view, null);
    const spin = it.auto ? ((performance.now() - it.start) / 1000) * AUTO_DEG_PER_S : 0;
    if (it.auto) this.running = true;
    return { ...view.camera, yaw: view.camera.yaw + it.yaw + spin, pitch: Math.max(-85, Math.min(85, view.camera.pitch + it.pitch)) };
  }

  private isLive(key: object): boolean {
    const it = this.items.get(key);
    return !!it && (it.auto || (it.duration > 0 && it.paused === null && !it.ended));
  }

  /** Whether animation (clip or rotation) was running since the previous call. */
  takeRunning(): boolean {
    const v = this.running;
    this.running = false;
    return v;
  }

  /** Whether the model of layer node can be rotated (fill with orbit). */
  canOrbit(node: string): boolean {
    return (this.doc.get(node, 'fills') ?? []).some((p) => p.type === 'MODEL3D' && p.orbit !== false);
  }

  /** Rotate the model of layer node by dragging dx, dy px. */
  orbit(node: string, dx: number, dy: number) {
    for (const it of this.items.values()) {
      if (it.node !== node) continue;
      it.yaw -= dx * 0.5;
      it.pitch = Math.max(-85, Math.min(85, it.pitch + dy * 0.4));
    }
  }

  /** Prototype action on a layer's model. */
  apply(a: MediaAction) {
    const now = performance.now();
    for (const it of this.items.values()) {
      if (it.node !== a.destinationId || !it.duration) continue;
      const pos = () => (it.paused !== null ? it.paused : (now - it.start) / 1000);
      const seek = (t: number) => {
        const v = Math.max(0, it.loop ? t : Math.min(it.duration, t));
        it.ended = false;
        if (it.paused !== null) it.paused = v;
        else it.start = now - v * 1000;
      };
      const play = () => {
        if (it.paused === null) return;
        const from = it.ended ? 0 : it.paused;
        it.ended = false;
        it.paused = null;
        it.start = now - from * 1000;
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
