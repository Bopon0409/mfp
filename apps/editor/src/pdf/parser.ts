// PDF parsing: lexer, objects (numbers, names, strings, arrays, dictionaries, streams, references),
// cross-reference table (classic and stream, with /Prev updates), object streams, filters (Flate
// with predictors, LZW, ASCIIHex, ASCII85, RunLength). A broken table — objects are searched for
// across the file. Decompression uses DecompressionStream (browser and Node), so reading objects is async.

export class PdfName {
  v: string;
  constructor(v: string) {
    this.v = v;
  }
}

export class PdfRef {
  num: number;
  gen: number;
  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }
}

export class PdfString {
  bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  /** String text (PDFDocEncoding or UTF-16BE with BOM) — for names, titles. */
  text(): string {
    const b = this.bytes;
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
    return latin1(b);
  }
}

export class PdfDict {
  map = new Map<string, PdfObj>();
  get(k: string): PdfObj | undefined {
    return this.map.get(k);
  }
  has(k: string) {
    return this.map.has(k);
  }
}

export class PdfStream {
  dict: PdfDict;
  raw: Uint8Array;
  constructor(dict: PdfDict, raw: Uint8Array) {
    this.dict = dict;
    this.raw = raw;
  }
}

export type PdfObj = number | boolean | null | PdfName | PdfString | PdfRef | PdfObj[] | PdfDict | PdfStream;

/** Lexer keyword (content operator, obj, R, stream…). */
export class Keyword {
  v: string;
  constructor(v: string) {
    this.v = v;
  }
}

type Token = PdfObj | Keyword | '[' | ']' | '<<' | '>>' | '{' | '}' | null | undefined;

export const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

/** PDF lexer (also for content streams: keywords are operators). */
export class Lexer {
  buf: Uint8Array;
  pos: number;
  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  skipSpace() {
    const b = this.buf;
    for (;;) {
      while (this.pos < b.length && WS[b[this.pos]!]) this.pos++;
      if (b[this.pos] === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
        continue;
      }
      return;
    }
  }

  /** Next token; undefined — end. */
  next(): Token | undefined {
    this.skipSpace();
    const b = this.buf;
    if (this.pos >= b.length) return undefined;
    const c = b[this.pos]!;
    switch (c) {
      case 0x5b: // [
        this.pos++;
        return '[';
      case 0x5d:
        this.pos++;
        return ']';
      case 0x7b:
        this.pos++;
        return '{';
      case 0x7d:
        this.pos++;
        return '}';
      case 0x3c: // <
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return '<<';
        }
        return this.hexString();
      case 0x3e:
        if (b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return '>>';
        }
        this.pos++;
        return this.next();
      case 0x28:
        return this.literalString();
      case 0x2f:
        return this.name();
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const start = this.pos;
      this.pos++;
      while (this.pos < b.length && ((b[this.pos]! >= 0x30 && b[this.pos]! <= 0x39) || b[this.pos] === 0x2e)) this.pos++;
      // “--5” and the like in malformed files: the number by its last sign.
      const s = latin1(b.subarray(start, this.pos)).replace(/^[-+]+(?=[-+])/, '');
      const v = Number(s);
      return Number.isFinite(v) ? v : 0;
    }
    const start = this.pos;
    while (this.pos < b.length && !WS[b[this.pos]!] && !DELIM[b[this.pos]!]) this.pos++;
    if (this.pos === start) {
      this.pos++;
      return this.next();
    }
    const word = latin1(b.subarray(start, this.pos));
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Keyword(word);
  }

  private name(): PdfName {
    const b = this.buf;
    this.pos++;
    let s = '';
    while (this.pos < b.length && !WS[b[this.pos]!] && !DELIM[b[this.pos]!]) {
      const c = b[this.pos]!;
      if (c === 0x23 && this.pos + 2 < b.length) {
        const h = parseInt(String.fromCharCode(b[this.pos + 1]!, b[this.pos + 2]!), 16);
        if (Number.isFinite(h)) {
          s += String.fromCharCode(h);
          this.pos += 3;
          continue;
        }
      }
      s += String.fromCharCode(c);
      this.pos++;
    }
    return new PdfName(s);
  }

  private hexString(): PdfString {
    const b = this.buf;
    this.pos++;
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++]!;
      const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    this.pos++;
    return new PdfString(Uint8Array.from(out));
  }

  private literalString(): PdfString {
    const b = this.buf;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++]!;
      if (c === 0x28) depth++;
      else if (c === 0x29) {
        if (--depth === 0) break;
      } else if (c === 0x5c) {
        c = b[this.pos++]!;
        switch (c) {
          case 0x6e:
            out.push(10);
            continue;
          case 0x72:
            out.push(13);
            continue;
          case 0x74:
            out.push(9);
            continue;
          case 0x62:
            out.push(8);
            continue;
          case 0x66:
            out.push(12);
            continue;
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++;
            continue;
          case 0x0a:
            continue;
        }
        if (c >= 0x30 && c <= 0x37) {
          let v = c - 0x30;
          for (let k = 0; k < 2 && b[this.pos]! >= 0x30 && b[this.pos]! <= 0x37; k++) v = v * 8 + (b[this.pos++]! - 0x30);
          out.push(v & 255);
          continue;
        }
        out.push(c);
        continue;
      }
      out.push(c);
    }
    return new PdfString(Uint8Array.from(out));
  }
}

/** A value from the token stream (arrays, dictionaries, “n g R” references); stream is up to the caller. */
export function parseValue(lx: Lexer, first?: Token): PdfObj | Keyword | undefined {
  const t = first === undefined ? lx.next() : first;
  if (t === undefined) return undefined;
  if (t === '[') {
    const arr: PdfObj[] = [];
    for (;;) {
      const v = lx.next();
      if (v === ']' || v === undefined) break;
      const item = parseValue(lx, v);
      if (item instanceof Keyword) {
        if (item.v === 'R' && arr.length >= 2 && typeof arr[arr.length - 1] === 'number' && typeof arr[arr.length - 2] === 'number') {
          const gen = arr.pop() as number;
          const num = arr.pop() as number;
          arr.push(new PdfRef(num, gen));
        }
        continue;
      }
      if (item !== undefined) arr.push(item);
    }
    return arr;
  }
  if (t === '<<') {
    const d = new PdfDict();
    for (;;) {
      const k = lx.next();
      if (k === '>>' || k === undefined) break;
      if (!(k instanceof PdfName)) continue;
      const save = lx.pos;
      let v = parseValue(lx);
      // Reference “n g R”.
      if (typeof v === 'number') {
        const p2 = lx.pos;
        const g = lx.next();
        if (typeof g === 'number') {
          const r = lx.next();
          if (r instanceof Keyword && r.v === 'R') v = new PdfRef(v, g);
          else lx.pos = p2;
        } else lx.pos = p2;
      }
      if (v instanceof Keyword || v === undefined) {
        if (v === undefined) break;
        // Key without a value: “>>” or garbage — skip.
        if (v.v === '>>') break;
        lx.pos = save;
        lx.next();
        continue;
      }
      d.map.set(k.v, v);
    }
    return d;
  }
  if (t === ']' || t === '>>' || t === '{' || t === '}') return new Keyword(t);
  return t as PdfObj | Keyword;
}

// ---------- Document ----------

interface XrefEntry {
  type: 1 | 2;
  /** Type 1 — offset; type 2 — object stream number and index in it. */
  offset: number;
  index: number;
}

export class PdfFile {
  bytes: Uint8Array;
  private xref = new Map<number, XrefEntry>();
  trailer = new PdfDict();
  private cache = new Map<number, PdfObj>();
  private objStreams = new Map<number, Promise<{ offsets: Map<number, number>; data: Uint8Array; first: number }>>();

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  static async open(bytes: Uint8Array): Promise<PdfFile> {
    const f = new PdfFile(bytes);
    await f.readXref();
    return f;
  }

  private async readXref() {
    const b = this.bytes;
    const tail = latin1(b.subarray(Math.max(0, b.length - 2048)));
    const m = /startxref\s+(\d+)/g;
    let start = -1;
    for (let r = m.exec(tail); r; r = m.exec(tail)) start = Number(r[1]);
    const seen = new Set<number>();
    const sections: { entries: Map<number, XrefEntry>; trailer: PdfDict }[] = [];
    try {
      let off = start;
      while (off >= 0 && off < b.length && !seen.has(off)) {
        seen.add(off);
        const sec = await this.readXrefAt(off);
        if (!sec) break;
        sections.push(sec);
        const stm = sec.trailer.get('XRefStm');
        if (typeof stm === 'number' && !seen.has(stm)) {
          seen.add(stm);
          const s2 = await this.readXrefAt(stm);
          if (s2) sections.push({ entries: s2.entries, trailer: sec.trailer });
        }
        const prev = sec.trailer.get('Prev');
        off = typeof prev === 'number' ? prev : -1;
      }
    } catch {
      sections.length = 0;
    }
    // Old sections first, newer ones override them.
    for (const sec of sections.reverse()) {
      for (const [k, v] of sec.entries) this.xref.set(k, v);
      for (const [k, v] of sec.trailer.map) this.trailer.map.set(k, v);
    }
    if (!this.trailer.get('Root') || !this.xref.size) this.rebuild();
  }

  private async readXrefAt(off: number): Promise<{ entries: Map<number, XrefEntry>; trailer: PdfDict } | null> {
    const lx = new Lexer(this.bytes, off);
    const t = lx.next();
    const entries = new Map<number, XrefEntry>();
    if (t instanceof Keyword && t.v === 'xref') {
      for (;;) {
        const a = lx.next();
        if (a instanceof Keyword && a.v === 'trailer') break;
        const count = lx.next();
        if (typeof a !== 'number' || typeof count !== 'number') return null;
        lx.skipSpace();
        for (let i = 0; i < count; i++) {
          // “0000012345 00000 n” — by tokens (line breaks may also be single characters).
          const o = lx.next();
          const g = lx.next();
          const kind = lx.next();
          if (typeof o !== 'number' || typeof g !== 'number' || !(kind instanceof Keyword)) return null;
          if (kind.v === 'n' && o > 0 && !entries.has(a + i)) entries.set(a + i, { type: 1, offset: o, index: g });
        }
      }
      const trailer = parseValue(lx);
      return trailer instanceof PdfDict ? { entries, trailer } : null;
    }
    // Stream table: “n g obj << /Type /XRef … >> stream”.
    lx.pos = off;
    const obj = this.parseIndirectAt(off);
    if (!(obj instanceof PdfStream) || (obj.dict.get('Type') as PdfName | undefined)?.v !== 'XRef') return null;
    const data = await this.decode(obj);
    const W = (obj.dict.get('W') as number[]) ?? [1, 2, 1];
    const size = (obj.dict.get('Size') as number) ?? 0;
    const index = (obj.dict.get('Index') as number[] | undefined) ?? [0, size];
    const rowLen = W[0]! + W[1]! + W[2]!;
    let p = 0;
    const field = (w: number, def: number) => {
      if (!w) return def;
      let v = 0;
      for (let i = 0; i < w; i++) v = v * 256 + data[p++]!;
      return v;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      const first = index[s]!;
      const n = index[s + 1]!;
      for (let i = 0; i < n && p + rowLen <= data.length; i++) {
        const type = field(W[0]!, 1);
        const f2 = field(W[1]!, 0);
        const f3 = field(W[2]!, 0);
        if ((type === 1 || type === 2) && !entries.has(first + i)) entries.set(first + i, type === 1 ? { type: 1, offset: f2, index: f3 } : { type: 2, offset: f2, index: f3 });
      }
    }
    return { entries, trailer: obj.dict };
  }

  /** The table is broken: find “n g obj” across the whole file; trailer — the last one or by /Root. */
  private rebuild() {
    const s = latin1(this.bytes);
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    for (let m = re.exec(s); m; m = re.exec(s)) this.xref.set(Number(m[1]), { type: 1, offset: m.index, index: Number(m[2]) });
    const tr = /trailer\s*<</g;
    for (let m = tr.exec(s); m; m = tr.exec(s)) {
      const v = parseValue(new Lexer(this.bytes, m.index + 7));
      if (v instanceof PdfDict) for (const [k, val] of v.map) this.trailer.map.set(k, val);
    }
    if (!this.trailer.get('Root')) {
      // The catalog is the object with /Type /Catalog.
      for (const [num, e] of this.xref) {
        const o = this.parseIndirectAt(e.offset);
        if (o instanceof PdfDict && (o.get('Type') as PdfName | undefined)?.v === 'Catalog') {
          this.trailer.map.set('Root', new PdfRef(num, 0));
          break;
        }
      }
    }
  }

  /** Object “n g obj … endobj” at an offset (a stream as raw bytes). */
  private parseIndirectAt(off: number): PdfObj | undefined {
    const lx = new Lexer(this.bytes, off);
    const n = lx.next();
    const g = lx.next();
    const kw = lx.next();
    if (typeof n !== 'number' || typeof g !== 'number' || !(kw instanceof Keyword) || kw.v !== 'obj') return undefined;
    const v = parseValue(lx);
    if (v instanceof Keyword || v === undefined) return undefined;
    if (v instanceof PdfDict) {
      const save = lx.pos;
      const t = lx.next();
      if (t instanceof Keyword && t.v === 'stream') return this.readStream(lx, v);
      lx.pos = save;
    }
    return v;
  }

  private readStream(lx: Lexer, dict: PdfDict): PdfStream {
    const b = this.bytes;
    let p = lx.pos;
    if (b[p] === 0x0d) p++;
    if (b[p] === 0x0a) p++;
    let len = dict.get('Length');
    if (len instanceof PdfRef) {
      const e = this.xref.get(len.num);
      const v = e?.type === 1 ? this.parseIndirectAt(e.offset) : undefined;
      len = typeof v === 'number' ? v : undefined;
    }
    let end = typeof len === 'number' ? p + len : -1;
    // Wrong length — read up to “endstream”.
    if (end < p || end > b.length || latin1(b.subarray(end, Math.min(b.length, end + 20))).trimStart().slice(0, 9) !== 'endstream') {
      const s = latin1(b.subarray(p, Math.min(b.length, p + 64 * 1024 * 1024)));
      const k = s.indexOf('endstream');
      end = k >= 0 ? p + k : b.length;
      while (end > p && (b[end - 1] === 0x0a || b[end - 1] === 0x0d)) end--;
    }
    return new PdfStream(dict, b.subarray(p, end));
  }

  /** Object by number. */
  async get(num: number): Promise<PdfObj | undefined> {
    if (this.cache.has(num)) return this.cache.get(num);
    const e = this.xref.get(num);
    let v: PdfObj | undefined;
    if (e?.type === 1) v = this.parseIndirectAt(e.offset);
    else if (e?.type === 2) v = await this.fromObjStream(e.offset, num);
    if (v !== undefined) this.cache.set(num, v);
    return v;
  }

  private async fromObjStream(stmNum: number, num: number): Promise<PdfObj | undefined> {
    let p = this.objStreams.get(stmNum);
    if (!p) {
      p = (async () => {
        const s = await this.get(stmNum);
        if (!(s instanceof PdfStream)) return { offsets: new Map(), data: new Uint8Array(), first: 0 };
        const data = await this.decode(s);
        const n = (s.dict.get('N') as number) ?? 0;
        const first = (s.dict.get('First') as number) ?? 0;
        const lx = new Lexer(data);
        const offsets = new Map<number, number>();
        for (let i = 0; i < n; i++) {
          const o = lx.next();
          const off = lx.next();
          if (typeof o === 'number' && typeof off === 'number') offsets.set(o, off);
        }
        return { offsets, data, first };
      })();
      this.objStreams.set(stmNum, p);
    }
    const { offsets, data, first } = await p;
    const off = offsets.get(num);
    if (off === undefined) return undefined;
    const v = parseValue(new Lexer(data, first + off));
    return v instanceof Keyword ? undefined : v;
  }

  /** Reference → object (everything else as is). */
  async resolve(o: PdfObj | undefined): Promise<PdfObj | undefined> {
    let v = o;
    for (let i = 0; i < 16 && v instanceof PdfRef; i++) v = await this.get(v.num);
    return v instanceof PdfRef ? undefined : v;
  }

  async dict(o: PdfObj | undefined): Promise<PdfDict | null> {
    const v = await this.resolve(o);
    return v instanceof PdfDict ? v : v instanceof PdfStream ? v.dict : null;
  }

  async array(o: PdfObj | undefined): Promise<PdfObj[] | null> {
    const v = await this.resolve(o);
    return Array.isArray(v) ? v : null;
  }

  async num(o: PdfObj | undefined, def = 0): Promise<number> {
    const v = await this.resolve(o);
    return typeof v === 'number' ? v : def;
  }

  /** Stream data with filters applied (except image ones: DCT, JPX, CCITT, JBIG2 stay compressed). */
  async decode(s: PdfStream, stopAtImage = false): Promise<Uint8Array> {
    let data = s.raw;
    const f = await this.resolve(s.dict.get('Filter') ?? s.dict.get('F'));
    const filters = (Array.isArray(f) ? f : f ? [f] : []) as PdfObj[];
    const parmsAll = await this.resolve(s.dict.get('DecodeParms') ?? s.dict.get('DP'));
    for (let i = 0; i < filters.length; i++) {
      const name = filters[i] instanceof PdfName ? (filters[i] as PdfName).v : '';
      const parms = await this.dict(Array.isArray(parmsAll) ? parmsAll[i] : parmsAll ?? undefined);
      if (IMAGE_FILTERS.has(name)) {
        if (stopAtImage) return data;
        return data;
      }
      data = await applyFilter(name, data, parms);
    }
    return data;
  }

  /** Name of the stream's last (image) filter: DCTDecode, JPXDecode… */
  async imageFilter(s: PdfStream): Promise<string | null> {
    const f = await this.resolve(s.dict.get('Filter') ?? s.dict.get('F'));
    const list = (Array.isArray(f) ? f : f ? [f] : []) as PdfObj[];
    const last = list[list.length - 1];
    const name = last instanceof PdfName ? last.v : '';
    return IMAGE_FILTERS.has(name) ? name : null;
  }
}

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

async function applyFilter(name: string, data: Uint8Array, parms: PdfDict | null): Promise<Uint8Array> {
  switch (name) {
    case 'FlateDecode':
    case 'Fl':
      return predict(await inflate(data), parms);
    case 'LZWDecode':
    case 'LZW':
      return predict(lzw(data, ((parms?.get('EarlyChange') as number | undefined) ?? 1) === 1), parms);
    case 'ASCIIHexDecode':
    case 'AHx':
      return asciiHex(data);
    case 'ASCII85Decode':
    case 'A85':
      return ascii85(data);
    case 'RunLengthDecode':
    case 'RL':
      return runLength(data);
    default:
      return data;
  }
}

/** zlib (Flate): streaming; a broken tail (checksum) — whatever got decompressed. */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const run = async (format: 'deflate' | 'deflate-raw', input: Uint8Array) => {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(input as BufferSource).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
        total += r.value.length;
      }
    } catch {
      // The end of the stream is corrupted — take what we have.
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  const out = await run('deflate', data);
  if (out.length || data.length < 3) return out;
  // The zlib header is corrupted or missing — raw deflate.
  return run('deflate-raw', data.subarray(2));
}

/** PNG (10–15) and TIFF (2) predictors after Flate / LZW. */
function predict(data: Uint8Array, parms: PdfDict | null): Uint8Array {
  const pred = (parms?.get('Predictor') as number | undefined) ?? 1;
  if (pred < 2) return data;
  const colors = (parms?.get('Colors') as number | undefined) ?? 1;
  const bpc = (parms?.get('BitsPerComponent') as number | undefined) ?? 8;
  const columns = (parms?.get('Columns') as number | undefined) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) {
    if (bpc !== 8) return data;
    const out = Uint8Array.from(data);
    for (let r = 0; r * rowLen < out.length; r++) for (let i = r * rowLen + bpp; i < Math.min(out.length, (r + 1) * rowLen); i++) out[i] = (out[i]! + out[i - bpp]!) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]!;
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const up = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const x = row[i] ?? 0;
      let v: number;
      switch (type) {
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + up;
          break;
        case 3:
          v = x + ((a + up) >> 1);
          break;
        case 4: {
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
          break;
        }
        default:
          v = x;
      }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return out;
}

function lzw(data: Uint8Array, early: boolean): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let size = 9;
  let bit = 0;
  let prev: number[] | null = null;
  const total = data.length * 8;
  while (bit + size <= total) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code = (code << 1) | ((data[bit >> 3]! >> (7 - (bit & 7))) & 1);
    if (code === 256) {
      reset();
      size = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    const entry: number[] = code < dict.length ? dict[code]! : prev ? [...prev, prev[0]!] : [];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]!]);
    prev = entry;
    const limit = dict.length + (early ? 1 : 0);
    if (limit >= 1 << size && size < 12) size++;
  }
  return Uint8Array.from(out);
}

function asciiHex(data: Uint8Array): Uint8Array {
  const s = latin1(data).replace(/[^0-9a-fA-F>]/g, '');
  const end = s.indexOf('>');
  const hex = end >= 0 ? s.slice(0, end) : s;
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt((hex[i * 2] ?? '0') + (hex[i * 2 + 1] ?? '0'), 16);
  return out;
}

function ascii85(data: Uint8Array): Uint8Array {
  const s = latin1(data).replace(/\s+/g, '').replace(/^<~/, '');
  const end = s.indexOf('~>');
  const t = end >= 0 ? s.slice(0, end) : s;
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of t) {
    if (ch === 'z' && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function runLength(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++]!;
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]!);
    } else {
      const v = data[i++]!;
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}
