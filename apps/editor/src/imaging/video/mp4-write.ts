// Streaming MP4 writer for upscaled video: ftyp, mdat (64-bit size, patched at the end),
// samples as they become ready, moov after the data. The file is not held in memory whole when writing
// to disk (File System Access). Each sample is its own chunk (co64), times follow presentation timestamps:
// decode order is restored by sorting, offsets go into ctts and the edit list (elst).

import { Bytes, box, concat, full } from '../../mp4.ts';

/** Where bytes are written: a file on disk or memory. */
export interface Mp4Sink {
  write(data: Uint8Array): Promise<void>;
  /** Rewrite already written bytes (the mdat size). */
  patch(position: number, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class FileSink implements Mp4Sink {
  private stream: FileSystemWritableFileStream;
  constructor(stream: FileSystemWritableFileStream) {
    this.stream = stream;
  }
  async write(data: Uint8Array) {
    await this.stream.write(data as Uint8Array<ArrayBuffer>);
  }
  async patch(position: number, data: Uint8Array) {
    await this.stream.write({ type: 'write', position, data: data as Uint8Array<ArrayBuffer> });
  }
  async close() {
    await this.stream.close();
  }
  /** Cancel: an unfinished file is not saved. */
  async abort() {
    await this.stream.abort();
  }
}

export class MemorySink implements Mp4Sink {
  private parts: Uint8Array[] = [];
  async write(data: Uint8Array) {
    this.parts.push(data);
  }
  async patch(position: number, data: Uint8Array) {
    let start = 0;
    for (const part of this.parts) {
      const end = start + part.length;
      for (let i = 0; i < data.length; i++) {
        const p = position + i;
        if (p >= start && p < end) part[p - start] = data[i]!;
      }
      start = end;
    }
  }
  async close() {}
  blob(type = 'video/mp4') {
    return new Blob(this.parts as Uint8Array<ArrayBuffer>[], { type });
  }
}

export interface TrackSpec {
  kind: 'video' | 'audio';
  timescale: number;
  /** The whole sample description (avc1/hvc1/av01 with codec settings, mp4a…). */
  entry: Uint8Array;
  width?: number;
  height?: number;
  matrix?: Uint8Array;
  language?: number;
}

interface Sample {
  offset: number;
  size: number;
  /** Presentation time, where 0 is the movie start (in track units). */
  time: number;
  duration: number;
  key: boolean;
}

const MOVIE_TIMESCALE = 1000;
// Writes are buffered up to this size: fewer disk accesses
const FLUSH = 8 << 20;
const IDENTITY = new Bytes().u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000).done();

const u64 = (b: Bytes, v: number) => b.u32(Math.floor(v / 2 ** 32)).u32(v >>> 0);

export class Mp4Writer {
  private samples: Sample[][];
  private position = 0;
  private pending: Uint8Array[] = [];
  private pendingSize = 0;
  private mdatStart = 0;
  private sink: Mp4Sink;
  private tracks: TrackSpec[];

  constructor(sink: Mp4Sink, tracks: TrackSpec[]) {
    this.sink = sink;
    this.tracks = tracks;
    this.samples = tracks.map(() => []);
  }

  /** How many bytes have been written so far. */
  get bytes() {
    return this.position;
  }

  async start() {
    const ftyp = box('ftyp', new Bytes().str('isom').u32(0x200).str('isom').str('iso2').str('iso6').str('mp41').done());
    this.mdatStart = ftyp.length;
    // mdat with a 64-bit size: 8K video easily exceeds 4 GB
    const mdat = new Bytes().u32(1).str('mdat').u32(0).u32(0).done();
    await this.push(concat([ftyp, mdat]));
  }

  /** Track sample: time is the presentation time from the movie start; duration if known. */
  async add(track: number, data: Uint8Array, time: number, key: boolean, duration = 0) {
    this.samples[track]!.push({ offset: this.position, size: data.length, time, duration, key });
    await this.push(data);
  }

  private async push(data: Uint8Array) {
    this.pending.push(data);
    this.pendingSize += data.length;
    this.position += data.length;
    if (this.pendingSize >= FLUSH) await this.flush();
  }

  private async flush() {
    if (!this.pendingSize) return;
    const data = this.pending.length === 1 ? this.pending[0]! : concat(this.pending);
    this.pending = [];
    this.pendingSize = 0;
    await this.sink.write(data);
  }

  async finish() {
    await this.flush();
    const mdatSize = this.position - this.mdatStart;
    const traks: Uint8Array[] = [];
    let movieDuration = 0;
    this.tracks.forEach((spec, i) => {
      const built = trak(spec, i + 1, this.samples[i]!);
      if (!built) return;
      traks.push(built.box);
      movieDuration = Math.max(movieDuration, built.movieDuration);
    });
    const mvhd = full('mvhd', 0, 0, new Bytes().u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(movieDuration).u32(0x10000).u16(0x100).zeros(10).done(), IDENTITY, new Bytes().zeros(24).u32(this.tracks.length + 1).done());
    await this.sink.write(box('moov', mvhd, ...traks));
    await this.sink.patch(this.mdatStart + 8, u64(new Bytes(), mdatSize).done());
    await this.sink.close();
  }
}

/** Track tables. Decoding is in write order; its times are the sorted presentation times. */
export function timing(samples: { time: number; duration: number }[]) {
  const n = samples.length;
  const sorted = samples.map((s) => s.time).sort((a, b) => a - b);
  let dts = sorted.slice();
  let offsets = samples.map((s, i) => s.time - dts[i]!);
  const min = offsets.reduce((m, o) => Math.min(m, o), 0);
  if (min < 0) {
    dts = dts.map((d) => d + min);
    offsets = offsets.map((o) => o - min);
  }
  const base = dts[0] ?? 0;
  const deltas: number[] = [];
  for (let i = 0; i < n; i++) {
    const next = dts[i + 1];
    deltas.push(next !== undefined ? next - dts[i]! : samples[i]!.duration || deltas[i - 1] || 1);
  }
  const first = sorted[0] ?? 0;
  const last = samples.reduce((m, s, i) => Math.max(m, s.time + (s.duration || deltas[i]!)), -Infinity);
  const shown = Math.max(0, first);
  return {
    deltas,
    offsets,
    /** Track time at which presentation starts (elst media_time). */
    mediaStart: shown - base,
    /** Pause before the first frame (empty edit) and presentation duration, in track units. */
    empty: shown,
    shown: last - shown,
    mediaDuration: deltas.reduce((a, b) => a + b, 0),
  };
}

const runs = (values: number[]) => {
  const out: [number, number][] = [];
  for (const v of values) {
    const lastRun = out[out.length - 1];
    if (lastRun && lastRun[1] === v) lastRun[0]++;
    else out.push([1, v]);
  }
  return out;
};

function trak(spec: TrackSpec, id: number, samples: Sample[]) {
  if (!samples.length) return null;
  const t = timing(samples);
  const toMovie = (v: number) => Math.round((v * MOVIE_TIMESCALE) / spec.timescale);
  const movieDuration = toMovie(t.empty + t.shown);
  const video = spec.kind === 'video';
  const tkhd = full(
    'tkhd',
    0,
    3,
    new Bytes().u32(0).u32(0).u32(id).u32(0).u32(movieDuration).zeros(8).u16(0).u16(video ? 0 : 1).u16(video ? 0 : 0x100).u16(0).done(),
    spec.matrix && spec.matrix.length === 36 ? spec.matrix : IDENTITY,
    new Bytes().u32((spec.width ?? 0) * 0x10000).u32((spec.height ?? 0) * 0x10000).done(),
  );
  const elstB = new Bytes();
  let edits = 0;
  if (t.empty > 0) {
    elstB.u32(toMovie(t.empty)).u32(0xffffffff).u32(0x10000);
    edits++;
  }
  elstB.u32(toMovie(t.shown)).u32(t.mediaStart).u32(0x10000);
  edits++;
  const edts = box('edts', full('elst', 0, 0, new Bytes().u32(edits).done(), elstB.done()));
  const mdhd = full('mdhd', 0, 0, new Bytes().u32(0).u32(0).u32(spec.timescale).u32(t.mediaDuration).u16(spec.language ?? 0x55c4).u16(0).done());
  const hdlr = full('hdlr', 0, 0, new Bytes().u32(0).str(video ? 'vide' : 'soun').zeros(12).str(video ? 'MFP Video' : 'MFP Sound').u8(0).done());

  const stsd = full('stsd', 0, 0, new Bytes().u32(1).done(), spec.entry);
  const sttsRuns = runs(t.deltas);
  const sttsB = new Bytes().u32(sttsRuns.length);
  for (const [count, delta] of sttsRuns) sttsB.u32(count).u32(delta);
  const tables = [stsd, full('stts', 0, 0, sttsB.done())];
  if (t.offsets.some((o) => o !== 0)) {
    const cttsRuns = runs(t.offsets);
    const b = new Bytes().u32(cttsRuns.length);
    for (const [count, off] of cttsRuns) b.u32(count).u32(off);
    tables.push(full('ctts', 0, 0, b.done()));
  }
  if (samples.some((s) => !s.key)) {
    const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    const b = new Bytes().u32(keys.length);
    for (const k of keys) b.u32(k);
    tables.push(full('stss', 0, 0, b.done()));
  }
  tables.push(full('stsc', 0, 0, new Bytes().u32(1).u32(1).u32(1).u32(1).done()));
  const stszB = new Bytes().u32(0).u32(samples.length);
  for (const s of samples) stszB.u32(s.size);
  tables.push(full('stsz', 0, 0, stszB.done()));
  const co64B = new Bytes().u32(samples.length);
  for (const s of samples) u64(co64B, s.offset);
  tables.push(full('co64', 0, 0, co64B.done()));

  const header = video ? full('vmhd', 0, 1, new Bytes().zeros(8).done()) : full('smhd', 0, 0, new Bytes().zeros(4).done());
  const dinf = box('dinf', full('dref', 0, 0, new Bytes().u32(1).done(), full('url ', 0, 1)));
  const minf = box('minf', header, dinf, box('stbl', ...tables));
  return { box: box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf)), movieDuration };
}

/** Video sample description: avc1 / hvc1 / av01 with the codec configuration box. */
export function visualEntry(format: 'avc1' | 'hvc1' | 'av01', width: number, height: number, config: Uint8Array): Uint8Array {
  const configType = format === 'avc1' ? 'avcC' : format === 'hvc1' ? 'hvcC' : 'av1C';
  return box(
    format,
    new Bytes().zeros(6).u16(1).zeros(16).u16(width).u16(height).u32(0x480000).u32(0x480000).u32(0).u16(1).zeros(32).u16(0x18).u16(0xffff).done(),
    box(configType, config),
  );
}
