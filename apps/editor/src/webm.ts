// WebM video for animation export: the browser compresses frames (WebCodecs, VP9 or VP8), packing into
// the container is our own (EBML: header, a segment with the track description and SimpleBlock clusters; a cluster
// starts at each keyframe). Every element's length is known in advance — everything is assembled in memory.

export interface VideoInput {
  /** Frame RGBA pixels (width × height). */
  rgba: Uint8Array;
}

/** Whether this environment has video compression (WebCodecs). */
export const canEncodeVideo = () => typeof VideoEncoder !== 'undefined';

/**
 * Compress frames (one at a time: next(i) — pixels of frame i of count) into WebM. Width and height are even
 * (more reliable for VP9): odd ones are padded by repeating the edge.
 */
export async function encodeWebm(count: number, width: number, height: number, fps: number, next: (i: number) => Promise<Uint8Array>, onProgress?: (i: number) => void): Promise<Uint8Array> {
  const stream = await WebmStream.open(width, height, fps);
  const W = stream.width;
  const H = stream.height;
  for (let i = 0; i < count; i++) {
    const rgba = pad(await next(i), width, height, W, H);
    const frame = new VideoFrame(rgba, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: 0 });
    await stream.add(frame);
    frame.close();
    onProgress?.(i);
  }
  return stream.finish();
}

/** WebM video frame by frame (presentation recording): like Mp4Stream — constant rate, frames of any size. */
export class WebmStream {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  private encoder: VideoEncoder;
  private codec: string;
  private chunks: { key: boolean; ms: number; data: Uint8Array }[] = [];
  private failure: unknown = null;
  private count = 0;

  private constructor(config: VideoEncoderConfig, fps: number) {
    this.width = config.width;
    this.height = config.height;
    this.fps = fps;
    this.codec = config.codec;
    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.chunks.push({ key: chunk.type === 'key', ms: Math.round(chunk.timestamp / 1000), data });
      },
      error: (e) => (this.failure = e),
    });
    this.encoder.configure(config);
  }

  static async open(width: number, height: number, fps: number): Promise<WebmStream> {
    const W = width + (width & 1);
    const H = height + (height & 1);
    const configs: VideoEncoderConfig[] = [
      { codec: 'vp09.00.10.08', width: W, height: H, framerate: fps, bitrate: Math.round(Math.min(40e6, W * H * fps * 0.2)) },
      { codec: 'vp8', width: W, height: H, framerate: fps, bitrate: Math.round(Math.min(40e6, W * H * fps * 0.25)) },
    ];
    for (const c of configs) {
      const s = await VideoEncoder.isConfigSupported(c).catch(() => null);
      if (s?.supported) return new WebmStream(c, fps);
    }
    throw new Error('Браузер не умеет сжимать видео VP9 и VP8');
  }

  /** A frame (the caller closes it); the compression queue doesn't pile up. */
  async add(frame: VideoFrame) {
    if (this.failure) throw this.failure instanceof Error ? this.failure : new Error(String(this.failure));
    const us = 1e6 / this.fps;
    const timed = new VideoFrame(frame, { timestamp: Math.round(this.count * us), duration: Math.round(us) });
    this.encoder.encode(timed, { keyFrame: this.count % Math.max(1, Math.round(this.fps * 2)) === 0 });
    timed.close();
    this.count++;
    // Don't let the queue pile up: compression keeps up with rendering.
    while (this.encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
  }

  get frames(): number {
    return this.count;
  }

  async finish(): Promise<Uint8Array> {
    await this.encoder.flush();
    this.encoder.close();
    if (this.failure) throw this.failure instanceof Error ? this.failure : new Error(String(this.failure));
    return mux(this.chunks, this.width, this.height, this.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8', (this.count * 1000) / this.fps);
  }
}

/** Frame to an even size: right column and bottom row — by repeating the edge. */
function pad(rgba: Uint8Array, w: number, h: number, W: number, H: number): Uint8Array {
  if (w === W && h === H) return rgba;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(y, h - 1);
    out.set(rgba.subarray(sy * w * 4, (sy + 1) * w * 4), y * W * 4);
    if (W > w) out.set(rgba.subarray((sy * w + w - 1) * 4, (sy * w + w) * 4), (y * W + W - 1) * 4);
  }
  return out;
}

// ---------- EBML ----------

type El = Uint8Array;

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Element length: 8 bytes (0x01 and a 7-byte number). */
function size(n: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  for (let i = 7; i >= 1; i--) {
    out[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return out;
}

function el(id: number, ...body: Uint8Array[]): El {
  const data = concat(body);
  const idBytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v % 256);
  return concat([new Uint8Array(idBytes), size(data.length), data]);
}

function uint(id: number, v: number): El {
  const bytes: number[] = [];
  do {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, new Uint8Array(bytes));
}

function float(id: number, v: number): El {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
}

const text = (id: number, s: string) => el(id, new TextEncoder().encode(s));

function mux(chunks: { key: boolean; ms: number; data: Uint8Array }[], width: number, height: number, codec: string, durationMs: number): Uint8Array {
  const header = el(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2));
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), text(0x4d80, 'MFP'), text(0x5741, 'MFP'), float(0x4489, durationMs));
  const tracks = el(0x1654ae6b, el(0xae, uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), text(0x86, codec), el(0xe0, uint(0xb0, width), uint(0xba, height))));
  // Clusters: a new one starts at a keyframe (or when the offset doesn't fit in 16 bits).
  const clusters: Uint8Array[] = [];
  let start = -1;
  let blocks: Uint8Array[] = [];
  const flush = () => {
    if (start >= 0 && blocks.length) clusters.push(el(0x1f43b675, uint(0xe7, start), ...blocks));
    blocks = [];
  };
  for (const c of chunks) {
    if (start < 0 || c.key || c.ms - start > 30000) {
      flush();
      start = c.ms;
    }
    const rel = c.ms - start;
    const head = new Uint8Array([0x81, (rel >> 8) & 255, rel & 255, c.key ? 0x80 : 0]);
    blocks.push(el(0xa3, head, c.data));
  }
  flush();
  const segment = el(0x18538067, info, tracks, ...clusters);
  return concat([header, segment]);
}
