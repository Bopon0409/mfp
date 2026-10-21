// Recording a prototype walkthrough to video (MP4, WebM) or GIF — what is visible in the
// presentation, with tap marks.
//
// The presentation canvas is WebGL: after a frame is presented its buffer is empty, and the
// presentation redraws only changes. So after each render the frame is copied to our own canvas
// (grab — in the same tick as the render), and video frames are taken from the copy at a constant
// rate: 30 per second (GIF — 12). Video is encoded on the fly (WebCodecs, mp4.ts / webm.ts), GIF —
// after stopping: identical consecutive frames are merged into one long frame (a prototype
// walkthrough is mostly static screens).

import { encodeGif, type GifFrame } from '../gif.ts';
import { Mp4Stream, mp4Codec } from '../mp4.ts';
import { WebmStream } from '../webm.ts';

export type RecordFormat = 'mp4' | 'webm' | 'gif';

export const RECORD_FORMATS: { format: RecordFormat; label: string }[] = [
  { format: 'mp4', label: 'MP4' },
  { format: 'webm', label: 'WebM' },
  { format: 'gif', label: 'GIF' },
];

/** Maximum video side (larger isn't needed for presentation, and the file and encoding cost grow). */
const MAX_VIDEO = 1920;
const MAX_GIF = 720;
/** GIF isn't recorded longer than this: GIF frames accumulate in memory until stop. */
export const GIF_LIMIT_S = 60;
/** Tap mark: radius (in canvas pixels at scale 1) and lifetime. */
const TAP_R = 22;
const TAP_MS = 450;

/** Even size no larger than max on the longer side. */
function fit(w: number, h: number, max: number): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  const even = (v: number) => Math.max(2, Math.round(v * k) & ~1);
  return [even(w), even(h)];
}

/** Best available video format: MP4 (H.264), otherwise WebM. */
export async function defaultVideoFormat(): Promise<RecordFormat> {
  if (typeof VideoEncoder === 'undefined') return 'gif';
  return (await mp4Codec(1280, 720)) ? 'mp4' : 'webm';
}

export class Recorder {
  readonly format: RecordFormat;
  readonly fps: number;
  /** Copy of the last presentation frame. */
  private copy: OffscreenCanvas;
  private copyCtx: OffscreenCanvasRenderingContext2D;
  /** Video frame: the copy scaled down to the video size, with tap marks on top. */
  private frame: OffscreenCanvas;
  private frameCtx: OffscreenCanvasRenderingContext2D;
  private stream: Mp4Stream | WebmStream | null;
  private gif: GifFrame[] = [];
  private lastGif: Uint8Array | null = null;
  private taps: { x: number; y: number; at: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private startedAt = performance.now();
  private ticks = 0;
  private sw: number;
  private sh: number;

  private constructor(format: RecordFormat, sw: number, sh: number, stream: Mp4Stream | WebmStream | null, w: number, h: number) {
    this.format = format;
    this.fps = format === 'gif' ? 12 : 30;
    this.sw = sw;
    this.sh = sh;
    this.stream = stream;
    this.copy = new OffscreenCanvas(sw, sh);
    this.copyCtx = this.copy.getContext('2d')!;
    this.frame = new OffscreenCanvas(w, h);
    this.frameCtx = this.frame.getContext('2d', { willReadFrequently: format === 'gif' })!;
  }

  /** Start recording the source canvas (its size in pixels is the copy size). */
  static async start(source: HTMLCanvasElement, format: RecordFormat): Promise<Recorder> {
    const sw = source.width;
    const sh = source.height;
    const [w, h] = fit(sw, sh, format === 'gif' ? MAX_GIF : MAX_VIDEO);
    const stream = format === 'mp4' ? await Mp4Stream.open(w, h, 30) : format === 'webm' ? await WebmStream.open(w, h, 30) : null;
    const r = new Recorder(format, sw, sh, stream, stream?.width ?? w, stream?.height ?? h);
    r.grab(source);
    r.timer = setInterval(() => r.tick(), 1000 / r.fps);
    return r;
  }

  /** A presentation frame was rendered (same tick as the render: the WebGL buffer is still intact) — copy it. */
  grab(source: HTMLCanvasElement) {
    if (source.width !== this.sw || source.height !== this.sh) {
      // The presentation window was resized: the copy keeps its previous size (the video doesn't change size mid-recording).
      this.copyCtx.clearRect(0, 0, this.sw, this.sh);
      const k = Math.min(this.sw / source.width, this.sh / source.height);
      this.copyCtx.drawImage(source, (this.sw - source.width * k) / 2, (this.sh - source.height * k) / 2, source.width * k, source.height * k);
      return;
    }
    this.copyCtx.drawImage(source, 0, 0);
  }

  /** A tap at a canvas point (canvas pixels) — a circle in the recording. */
  tap(x: number, y: number) {
    this.taps.push({ x, y, at: performance.now() });
  }

  /** How much has been recorded, seconds. */
  get seconds(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  /** Recording failed (encoder) — the error text. */
  get error(): string | null {
    return this.failure ? (this.failure as Error).message ?? String(this.failure) : null;
  }

  private tick() {
    // Missed ticks (the tab is busy) are caught up by repeating a frame: the video length matches real time.
    const due = Math.floor(((performance.now() - this.startedAt) / 1000) * this.fps) + 1;
    const n = Math.max(1, Math.min(10, due - this.ticks));
    this.ticks += n;
    const { width: w, height: h } = this.frame;
    const ctx = this.frameCtx;
    ctx.drawImage(this.copy, 0, 0, w, h);
    const now = performance.now();
    const k = w / this.sw;
    this.taps = this.taps.filter((t) => now - t.at < TAP_MS);
    for (const t of this.taps) {
      const p = (now - t.at) / TAP_MS;
      ctx.beginPath();
      ctx.arc(t.x * k, t.y * k, TAP_R * k * (window.devicePixelRatio || 1) * (0.6 + 0.6 * p), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(77, 123, 253, ${0.35 * (1 - p)})`;
      ctx.fill();
      ctx.lineWidth = 2 * k * (window.devicePixelRatio || 1);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * (1 - p)})`;
      ctx.stroke();
    }
    if (this.format === 'gif') {
      const rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
      const last = this.gif[this.gif.length - 1];
      // Same frame — show the previous one longer.
      if (last && this.lastGif && same(rgba, this.lastGif)) last.delay += Math.round((100 / this.fps) * n);
      else if (this.seconds <= GIF_LIMIT_S) {
        this.gif.push({ rgba, delay: Math.round((100 / this.fps) * n) });
        this.lastGif = rgba;
      }
      return;
    }
    const stream = this.stream!;
    // In turn: a frame goes to encoding after the previous one (add waits if the encoder queue is full).
    this.pending = this.pending.then(async () => {
      if (this.failure) return;
      try {
        for (let i = 0; i < n; i++) {
          const frame = new VideoFrame(this.frame, { timestamp: 0 });
          await stream.add(frame);
          frame.close();
        }
      } catch (e) {
        this.failure = e;
      }
    });
  }

  /** Stop and assemble the file. */
  async stop(): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tick();
    await this.pending;
    if (this.failure) throw this.failure;
    if (this.format === 'gif') return { bytes: encodeGif(this.gif, this.frame.width, this.frame.height, true), mime: 'image/gif', ext: 'gif' };
    const bytes = await this.stream!.finish();
    return this.format === 'mp4' ? { bytes, mime: 'video/mp4', ext: 'mp4' } : { bytes, mime: 'video/webm', ext: 'webm' };
  }

  /** Discard the recording without a file. */
  cancel() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.gif = [];
  }
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Word-wise comparison: a 720×450 frame takes under a millisecond.
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
