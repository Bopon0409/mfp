// MP4 / MOV reading for video upscaling: tracks, codec descriptions and sample tables.
// The file is never read whole, only box headers, moov and the needed samples (videos can be
// gigabytes). Fragmented MP4 (moof) is not supported, and we report that.

/** Byte source: a file from disk (Blob) or an array in tests. */
export interface Mp4Source {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export const blobSource = (blob: Blob): Mp4Source => ({
  size: blob.size,
  read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
});

export const bytesSource = (bytes: Uint8Array): Mp4Source => ({
  size: bytes.length,
  read: async (offset, length) => bytes.slice(offset, offset + length),
});

export interface Mp4Sample {
  offset: number;
  size: number;
  /** Decode and presentation time, in track units (timescale). */
  dts: number;
  cts: number;
  duration: number;
  key: boolean;
}

export interface Mp4Track {
  id: number;
  kind: 'video' | 'audio' | 'other';
  timescale: number;
  /** The four-letter sample description code: avc1, hvc1, av01, mp4a… */
  format: string;
  /** The whole sample description (box with header), for copying the track as is. */
  entry: Uint8Array;
  /** Contents of the codec configuration box (avcC, hvcC, av1C, vpcC), for the decoder. */
  config: Uint8Array | null;
  width: number;
  height: number;
  /** Rotation matrix from tkhd (36 bytes), carried over to the output. */
  matrix: Uint8Array;
  /** Presentation start from the edit list (elst), in track units: B-frame offset, AAC priming. */
  editStart: number;
  language: number;
  samples: Mp4Sample[];
}

export interface Mp4File {
  movieTimescale: number;
  tracks: Mp4Track[];
}

interface Box {
  type: string;
  /** Content start and box end, within the buffer where the box was parsed. */
  start: number;
  end: number;
  headerStart: number;
}

const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

function* children(buf: Uint8Array, start: number, end: number): Generator<Box> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = start;
  while (o + 8 <= end) {
    let size = view.getUint32(o);
    const type = fourcc(buf, o + 4);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    yield { type, start: o + header, end: o + size, headerStart: o };
    o += size;
  }
}

const child = (buf: Uint8Array, box: Box, type: string) => {
  for (const c of children(buf, box.start, box.end)) if (c.type === type) return c;
  return null;
};

/** Parse an MP4: find moov (usually at the start or the end), read it and describe the tracks. */
export async function readMp4(src: Mp4Source): Promise<Mp4File> {
  let offset = 0;
  let moov: Uint8Array | null = null;
  while (offset + 8 <= src.size) {
    const head = await src.read(offset, 16);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = fourcc(head, 4);
    if (size === 1) size = Number(view.getBigUint64(8));
    else if (size === 0) size = src.size - offset;
    if (size < 8) throw new Error('Файл повреждён: неверный размер бокса MP4');
    if (type === 'moof') throw new Error('Фрагментированный MP4 пока не поддерживается — пересохраните видео обычным MP4');
    if (type === 'moov') moov = await src.read(offset, size);
    offset += size;
  }
  if (!moov) throw new Error('Это не MP4/MOV или в файле нет описания дорожек (moov)');
  const root: Box = { type: 'moov', start: 8, end: moov.length, headerStart: 0 };
  // The moov header may be 16 bytes long.
  if (new DataView(moov.buffer, moov.byteOffset).getUint32(0) === 1) root.start = 16;
  let movieTimescale = 1000;
  const mvhd = child(moov, root, 'mvhd');
  if (mvhd) {
    const v = moov[mvhd.start]!;
    const dv = new DataView(moov.buffer, moov.byteOffset);
    movieTimescale = dv.getUint32(mvhd.start + (v === 1 ? 20 : 12));
  }
  const tracks: Mp4Track[] = [];
  for (const trak of children(moov, root.start, root.end)) if (trak.type === 'trak') tracks.push(parseTrak(moov, trak));
  return { movieTimescale, tracks };
}

function parseTrak(buf: Uint8Array, trak: Box): Mp4Track {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tkhd = child(buf, trak, 'tkhd');
  let id = 0;
  let matrix = new Uint8Array(36);
  if (tkhd) {
    const v = buf[tkhd.start]!;
    id = dv.getUint32(tkhd.start + (v === 1 ? 20 : 12));
    const m = tkhd.start + (v === 1 ? 52 : 40);
    matrix = buf.slice(m, m + 36);
  }
  let editStart = 0;
  const elst = (() => {
    const edts = child(buf, trak, 'edts');
    return edts ? child(buf, edts, 'elst') : null;
  })();
  if (elst) {
    const v = buf[elst.start]!;
    const count = dv.getUint32(elst.start + 4);
    let o = elst.start + 8;
    for (let i = 0; i < count; i++) {
      const mediaTime = v === 1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
      o += v === 1 ? 20 : 12;
      if (mediaTime >= 0) {
        editStart = mediaTime;
        break;
      }
    }
  }
  const mdia = child(buf, trak, 'mdia');
  if (!mdia) throw new Error('Дорожка без mdia');
  const mdhd = child(buf, mdia, 'mdhd');
  let timescale = 1000;
  let language = 0x55c4;
  if (mdhd) {
    const v = buf[mdhd.start]!;
    timescale = dv.getUint32(mdhd.start + (v === 1 ? 20 : 12));
    language = dv.getUint16(mdhd.start + (v === 1 ? 32 : 20));
  }
  const hdlr = child(buf, mdia, 'hdlr');
  const handler = hdlr ? fourcc(buf, hdlr.start + 8) : '';
  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other';
  const minf = child(buf, mdia, 'minf');
  const stbl = minf ? child(buf, minf, 'stbl') : null;
  if (!stbl) throw new Error('Дорожка без таблицы сэмплов');

  // Sample description: the first entry.
  const stsd = child(buf, stbl, 'stsd');
  let format = '';
  let entry = new Uint8Array(0);
  let config: Uint8Array | null = null;
  let width = 0;
  let height = 0;
  if (stsd) {
    const first = children(buf, stsd.start + 8, stsd.end).next().value as Box | undefined;
    if (first) {
      format = first.type;
      entry = buf.slice(first.headerStart, first.end);
      if (kind === 'video') {
        width = dv.getUint16(first.start + 24);
        height = dv.getUint16(first.start + 26);
        for (const c of children(buf, first.start + 78, first.end)) {
          if (c.type === 'avcC' || c.type === 'hvcC' || c.type === 'av1C' || c.type === 'vpcC') {
            config = buf.slice(c.start, c.end);
            break;
          }
        }
      }
    }
  }

  // Time tables.
  const deltas: number[] = [];
  const stts = child(buf, stbl, 'stts');
  if (stts) {
    const n = dv.getUint32(stts.start + 4);
    for (let i = 0, o = stts.start + 8; i < n; i++, o += 8) {
      const count = dv.getUint32(o);
      const delta = dv.getUint32(o + 4);
      for (let k = 0; k < count; k++) deltas.push(delta);
    }
  }
  const offsets: number[] = [];
  const ctts = child(buf, stbl, 'ctts');
  if (ctts) {
    const v = buf[ctts.start]!;
    const n = dv.getUint32(ctts.start + 4);
    for (let i = 0, o = ctts.start + 8; i < n; i++, o += 8) {
      const count = dv.getUint32(o);
      const off = v === 1 ? dv.getInt32(o + 4) : dv.getUint32(o + 4);
      for (let k = 0; k < count; k++) offsets.push(off);
    }
  }
  const stss = child(buf, stbl, 'stss');
  const keys = stss ? new Set<number>() : null;
  if (stss && keys) {
    const n = dv.getUint32(stss.start + 4);
    for (let i = 0; i < n; i++) keys.add(dv.getUint32(stss.start + 8 + i * 4));
  }
  const sizes: number[] = [];
  const stsz = child(buf, stbl, 'stsz');
  if (stsz) {
    const fixed = dv.getUint32(stsz.start + 4);
    const n = dv.getUint32(stsz.start + 8);
    for (let i = 0; i < n; i++) sizes.push(fixed || dv.getUint32(stsz.start + 12 + i * 4));
  } else if (child(buf, stbl, 'stz2')) throw new Error('Сжатая таблица размеров (stz2) пока не поддерживается');
  const chunks: number[] = [];
  const stco = child(buf, stbl, 'stco');
  const co64 = child(buf, stbl, 'co64');
  if (stco) {
    const n = dv.getUint32(stco.start + 4);
    for (let i = 0; i < n; i++) chunks.push(dv.getUint32(stco.start + 8 + i * 4));
  } else if (co64) {
    const n = dv.getUint32(co64.start + 4);
    for (let i = 0; i < n; i++) chunks.push(Number(dv.getBigUint64(co64.start + 8 + i * 8)));
  }
  const runs: { first: number; perChunk: number }[] = [];
  const stsc = child(buf, stbl, 'stsc');
  if (stsc) {
    const n = dv.getUint32(stsc.start + 4);
    for (let i = 0, o = stsc.start + 8; i < n; i++, o += 12) runs.push({ first: dv.getUint32(o), perChunk: dv.getUint32(o + 4) });
  }

  // Samples: offsets by chunk (stsc + stco), times (stts + ctts), keyframes (stss).
  const samples: Mp4Sample[] = [];
  let s = 0;
  let dts = 0;
  for (let c = 0; c < chunks.length && s < sizes.length; c++) {
    let run = runs[0];
    for (const r of runs) if (r.first <= c + 1) run = r;
    let o = chunks[c]!;
    for (let k = 0; k < (run?.perChunk ?? 0) && s < sizes.length; k++, s++) {
      const duration = deltas[s] ?? deltas[deltas.length - 1] ?? 0;
      samples.push({ offset: o, size: sizes[s]!, dts, cts: dts + (offsets[s] ?? 0), duration, key: keys ? keys.has(s + 1) : true });
      o += sizes[s]!;
      dts += duration;
    }
  }
  return { id, kind, timescale, format, entry, config, width, height, matrix, editStart, language, samples };
}
