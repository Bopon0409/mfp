// Random-access byte source. Allows opening files
// of any size (including over 2 GB) without loading them entirely into memory:
// only the ZIP directory, canvas.fig and the required images are read.

export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class MemorySource implements ByteSource {
  private bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get size() {
    return this.bytes.byteLength;
  }
  async read(offset: number, length: number) {
    return this.bytes.subarray(offset, offset + length);
  }
}

/** Browser: File / Blob from <input type=file> or drag&drop. */
export class BlobSource implements ByteSource {
  private blob: Blob;
  constructor(blob: Blob) {
    this.blob = blob;
  }
  get size() {
    return this.blob.size;
  }
  async read(offset: number, length: number) {
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

/** HTTP with Range request support. */
export class HttpRangeSource implements ByteSource {
  private url: string;
  readonly size: number;
  constructor(url: string, size: number) {
    this.url = url;
    this.size = size;
  }
  static async open(url: string): Promise<HttpRangeSource> {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) throw new Error(`HEAD ${url}: ${res.status}`);
    const size = Number(res.headers.get('Content-Length'));
    if (!Number.isFinite(size) || size <= 0) throw new Error(`Не удалось узнать размер ${url}`);
    return new HttpRangeSource(url, size);
  }
  async read(offset: number, length: number) {
    if (length <= 0) return new Uint8Array(0);
    const res = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (res.status !== 206) throw new Error(`Сервер не поддерживает Range-запросы (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
