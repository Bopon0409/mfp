// ZIP writer for the native .mfp format: entries stored as is (images are already compressed)
// or deflated (JSON); ZIP64 when the file or an entry exceeds 4 GB or there are more than 65535 entries.
// The result is a Blob of parts: large data is not concatenated into one buffer.

import { deflateSync } from 'fflate';

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const U32_MAX = 0xffffffff;
const UTF8_NAMES = 0x0800;
// Entry date and time: January 1, 2026, 00:00 (DOS format), so the file does not depend on when it was saved.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const setU64 = (v: DataView, o: number, n: number) => {
  v.setUint32(o, n % 2 ** 32, true);
  v.setUint32(o + 4, Math.floor(n / 2 ** 32), true);
};

/** ZIP64 extra field (id 0x0001) with 64-bit values. */
function zip64Extra(values: number[]): Uint8Array {
  const out = new Uint8Array(4 + values.length * 8);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0x0001, true);
  v.setUint16(2, values.length * 8, true);
  values.forEach((n, i) => setU64(v, 4 + i * 8, n));
  return out;
}

interface Entry {
  name: Uint8Array;
  crc: number;
  method: number;
  csize: number;
  usize: number;
  offset: number;
}

export class ZipWriter {
  private parts: Uint8Array[] = [];
  private entries: Entry[] = [];
  private offset = 0;
  private forceZip64: boolean;

  /** forceZip64 — always write ZIP64 fields (for testing readers). */
  constructor(opts: { forceZip64?: boolean } = {}) {
    this.forceZip64 = opts.forceZip64 ?? false;
  }

  /** Add an entry; compress — deflate (useful for text, not for images). */
  add(name: string, data: Uint8Array, compress = false) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    let body = data;
    let method = 0;
    if (compress) {
      const d = deflateSync(data, { level: 6 });
      if (d.length < data.length) {
        body = d;
        method = 8;
      }
    }
    const zip64 = this.forceZip64 || body.length >= U32_MAX || data.length >= U32_MAX || this.offset >= U32_MAX;
    const extra = zip64 ? zip64Extra([data.length, body.length]) : new Uint8Array(0);
    const h = new Uint8Array(30 + nameBytes.length + extra.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, LFH_SIG, true);
    v.setUint16(4, zip64 ? 45 : 20, true);
    v.setUint16(6, UTF8_NAMES, true);
    v.setUint16(8, method, true);
    v.setUint16(10, DOS_TIME, true);
    v.setUint16(12, DOS_DATE, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, zip64 ? U32_MAX : body.length, true);
    v.setUint32(22, zip64 ? U32_MAX : data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, extra.length, true);
    h.set(nameBytes, 30);
    h.set(extra, 30 + nameBytes.length);
    this.entries.push({ name: nameBytes, crc, method, csize: body.length, usize: data.length, offset: this.offset });
    this.parts.push(h, body);
    this.offset += h.length + body.length;
  }

  get size() {
    return this.offset;
  }

  finish(): Blob {
    const cdStart = this.offset;
    const cd: Uint8Array[] = [];
    let cdSize = 0;
    for (const e of this.entries) {
      // In the central directory, ZIP64 stores only the fields that did not fit into 32 bits (in this order).
      const big = this.forceZip64 ? [true, true, true] : [e.usize >= U32_MAX, e.csize >= U32_MAX, e.offset >= U32_MAX];
      const values = [big[0] ? e.usize : -1, big[1] ? e.csize : -1, big[2] ? e.offset : -1].filter((x) => x >= 0);
      const extra = values.length ? zip64Extra(values) : new Uint8Array(0);
      const h = new Uint8Array(46 + e.name.length + extra.length);
      const v = new DataView(h.buffer);
      v.setUint32(0, CDH_SIG, true);
      v.setUint16(4, 45, true);
      v.setUint16(6, values.length ? 45 : 20, true);
      v.setUint16(8, UTF8_NAMES, true);
      v.setUint16(10, e.method, true);
      v.setUint16(12, DOS_TIME, true);
      v.setUint16(14, DOS_DATE, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, big[1] ? U32_MAX : e.csize, true);
      v.setUint32(24, big[0] ? U32_MAX : e.usize, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, extra.length, true);
      v.setUint32(42, big[2] ? U32_MAX : e.offset, true);
      h.set(e.name, 46);
      h.set(extra, 46 + e.name.length);
      cd.push(h);
      cdSize += h.length;
    }
    const n = this.entries.length;
    const tail: Uint8Array[] = [];
    const zip64 = this.forceZip64 || n >= 0xffff || cdStart >= U32_MAX || cdSize >= U32_MAX;
    if (zip64) {
      const z = new Uint8Array(56);
      const zv = new DataView(z.buffer);
      zv.setUint32(0, ZIP64_EOCD_SIG, true);
      setU64(zv, 4, 44);
      zv.setUint16(12, 45, true);
      zv.setUint16(14, 45, true);
      setU64(zv, 24, n);
      setU64(zv, 32, n);
      setU64(zv, 40, cdSize);
      setU64(zv, 48, cdStart);
      const l = new Uint8Array(20);
      const lv = new DataView(l.buffer);
      lv.setUint32(0, ZIP64_LOCATOR_SIG, true);
      setU64(lv, 8, cdStart + cdSize);
      lv.setUint32(16, 1, true);
      tail.push(z, l);
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, EOCD_SIG, true);
    ev.setUint16(8, zip64 ? 0xffff : n, true);
    ev.setUint16(10, zip64 ? 0xffff : n, true);
    ev.setUint32(12, zip64 ? U32_MAX : cdSize, true);
    ev.setUint32(16, zip64 ? U32_MAX : cdStart, true);
    tail.push(end);
    return new Blob([...this.parts, ...cd, ...tail] as BlobPart[], { type: 'application/zip' });
  }
}
