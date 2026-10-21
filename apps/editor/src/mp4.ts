// MP4 video (H.264) for animation export: the browser compresses frames (WebCodecs, AVC), the
// container is our own (ISO BMFF: ftyp, moov with a single track — before the data so the video
// starts playing immediately, mdat). All frames are one data block; tables: durations (stts),
// keyframes (stss), sizes (stsz); if the encoder reordered frames (B-frames) — composition offsets
// (ctts) and an edit list (elst).

/** H.264 profiles in descending order: High 4.0, Main 4.0, Baseline 3.1. */
const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'];

/** Whether H.264 encoding at this size is available: codec string or null. */
export async function mp4Codec(width: number, height: number): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of CODECS) {
    const s = await VideoEncoder.isConfigSupported({ codec, width: even(width), height: even(height), avc: { format: 'avc' } }).catch(() => null);
    if (s?.supported) return codec;
  }
  return null;
}

const even = (v: number) => v + (v & 1);

export async function encodeMp4(count: number, width: number, height: number, fps: number, next: (i: number) => Promise<Uint8Array>, onProgress?: (i: number) => void): Promise<Uint8Array> {
  const stream = await Mp4Stream.open(width, height, fps);
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

/**
 * MP4 video frame by frame (presentation recording): add — a frame (timestamp from the frame
 * number, constant frame rate), finish — the file. A frame can be any size: the encoder scales it
 * to the video size itself (width and height are even).
 */
export class Mp4Stream {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  private encoder: VideoEncoder;
  private samples: { key: boolean; data: Uint8Array; us: number }[] = [];
  private avcC: Uint8Array | null = null;
  private failure: unknown = null;
  private count = 0;

  private constructor(width: number, height: number, fps: number, codec: string) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.samples.push({ key: chunk.type === 'key', data, us: chunk.timestamp });
        const d = meta?.decoderConfig?.description;
        if (d && !this.avcC) this.avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
      },
      error: (e) => (this.failure = e),
    });
    this.encoder.configure({ codec, width, height, framerate: fps, bitrate: Math.round(Math.min(40e6, width * height * fps * 0.15)), avc: { format: 'avc' } });
  }

  static async open(width: number, height: number, fps: number): Promise<Mp4Stream> {
    const W = even(width);
    const H = even(height);
    const codec = await mp4Codec(W, H);
    if (!codec) throw new Error('Сжатие H.264 недоступно — сохраните видео в WebM');
    return new Mp4Stream(W, H, fps, codec);
  }

  /** A frame (the caller closes it); the encode queue does not build up. */
  async add(frame: VideoFrame) {
    if (this.failure) throw this.failure instanceof Error ? this.failure : new Error(String(this.failure));
    const us = 1e6 / this.fps;
    const timed = new VideoFrame(frame, { timestamp: Math.round(this.count * us), duration: Math.round(us) });
    this.encoder.encode(timed, { keyFrame: this.count % Math.max(1, Math.round(this.fps * 2)) === 0 });
    timed.close();
    this.count++;
    while (this.encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
  }

  get frames(): number {
    return this.count;
  }

  async finish(): Promise<Uint8Array> {
    await this.encoder.flush();
    this.encoder.close();
    if (this.failure) throw this.failure instanceof Error ? this.failure : new Error(String(this.failure));
    if (!this.avcC) throw new Error('Кодировщик не отдал описание потока H.264');
    return mux(this.samples, this.avcC, this.width, this.height, this.fps);
  }
}

/** Frame to an even size: the right column and bottom row repeat the edge. */
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

// ---------- ISO BMFF ----------

/** Writing big-endian numbers and strings (ISO BMFF boxes: MP4, AVIF). */
export class Bytes {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 255);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  u32(v: number) {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const data = concat(body);
  return concat([new Bytes().u32(data.length + 8).str(type).done(), data]);
}

/** Full box: version and flags before the content. */
export const full = (type: string, version: number, flags: number, ...body: Uint8Array[]) => box(type, new Bytes().u8(version).u8(flags >> 16).u16(flags).done(), ...body);

const MATRIX = new Bytes().u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000).done();

function mux(samples: { key: boolean; data: Uint8Array; us: number }[], avcC: Uint8Array, width: number, height: number, fps: number): Uint8Array {
  const timescale = fps * 1000;
  const delta = 1000;
  const duration = samples.length * delta;
  const durationMs = Math.round((samples.length * 1000) / fps);
  // Composition offset relative to decode order (B-frames); negative ones via a common shift and an edit list.
  const offsets = samples.map((smp, i) => Math.round((smp.us * timescale) / 1e6) - i * delta);
  const shift = Math.min(0, ...offsets);
  const reordered = offsets.some((o) => o !== 0);
  const ftyp = box('ftyp', new Bytes().str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41').done());
  const moov = (offset: number) => {
    const mvhd = full('mvhd', 0, 0, new Bytes().u32(0).u32(0).u32(1000).u32(durationMs).u32(0x10000).u16(0x100).zeros(10).done(), MATRIX, new Bytes().zeros(24).u32(2).done());
    const tkhd = full('tkhd', 0, 3, new Bytes().u32(0).u32(0).u32(1).u32(0).u32(durationMs).zeros(8).u16(0).u16(0).u16(0).u16(0).done(), MATRIX, new Bytes().u32(width << 16).u32(height << 16).done());
    const mdhd = full('mdhd', 0, 0, new Bytes().u32(0).u32(0).u32(timescale).u32(duration).u16(0x55c4).u16(0).done());
    const hdlr = full('hdlr', 0, 0, new Bytes().u32(0).str('vide').zeros(12).str('MFP Video').u8(0).done());
    const avc1 = box(
      'avc1',
      new Bytes().zeros(6).u16(1).zeros(16).u16(width).u16(height).u32(0x480000).u32(0x480000).u32(0).u16(1).zeros(32).u16(0x18).u16(0xffff).done(),
      box('avcC', avcC),
    );
    const stsd = full('stsd', 0, 0, new Bytes().u32(1).done(), avc1);
    const stts = full('stts', 0, 0, new Bytes().u32(1).u32(samples.length).u32(delta).done());
    const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    const stssB = new Bytes().u32(keys.length);
    for (const k of keys) stssB.u32(k);
    const stss = full('stss', 0, 0, stssB.done());
    const stsc = full('stsc', 0, 0, new Bytes().u32(1).u32(1).u32(samples.length).u32(1).done());
    const stszB = new Bytes().u32(0).u32(samples.length);
    for (const s of samples) stszB.u32(s.data.length);
    const stsz = full('stsz', 0, 0, stszB.done());
    const cttsB = new Bytes().u32(samples.length);
    for (const o of offsets) cttsB.u32(1).u32(o - shift);
    const ctts = reordered ? [full('ctts', 0, 0, cttsB.done())] : [];
    const stco = full('stco', 0, 0, new Bytes().u32(1).u32(offset).done());
    const stbl = box('stbl', stsd, stts, ...ctts, stss, stsc, stsz, stco);
    const dinf = box('dinf', full('dref', 0, 0, new Bytes().u32(1).done(), full('url ', 0, 1)));
    const minf = box('minf', full('vmhd', 0, 1, new Bytes().zeros(8).done()), dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const edts = shift < 0 ? [box('edts', full('elst', 0, 0, new Bytes().u32(1).u32(durationMs).u32(-shift).u32(0x10000).done()))] : [];
    const trak = box('trak', tkhd, ...edts, mdia);
    return box('moov', mvhd, trak);
  };
  // moov goes before the data: its length does not depend on the offset, hence twice.
  const size = moov(0).length;
  const data = concat(samples.map((s) => s.data));
  const mdat = concat([new Bytes().u32(data.length + 8).str('mdat').done(), data]);
  return concat([ftyp, moov(ftyp.length + size + 8), mdat]);
}
