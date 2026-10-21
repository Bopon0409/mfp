// Streaming PNG: rows are compressed as they become ready (CompressionStream yields zlib, as IDAT requires),
// so a 16K image is never held in memory whole, only compressed chunks.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export class PngStream {
  private readonly parts: Uint8Array<ArrayBuffer>[] = [];
  private readonly writer: WritableStreamDefaultWriter<BufferSource>;
  private readonly reading: Promise<void>;

  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;

  constructor(width: number, height: number, channels: 3 | 4) {
    this.width = width;
    this.height = height;
    this.channels = channels;
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = channels === 4 ? 6 : 2;
    this.parts.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header));
    const zlib = new CompressionStream('deflate');
    this.writer = zlib.writable.getWriter();
    this.reading = (async () => {
      const reader = zlib.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.parts.push(chunk('IDAT', value));
      }
    })();
  }

  /** Consecutive rows of width × channels bytes; the Sub filter gives a noticeably smaller file at almost no cost. */
  async writeRows(pixels: Uint8Array, rows: number): Promise<void> {
    const c = this.channels;
    const stride = this.width * c;
    const out = new Uint8Array(rows * (stride + 1));
    for (let r = 0; r < rows; r++) {
      const src = r * stride;
      const dst = r * (stride + 1);
      out[dst] = 1;
      for (let i = 0; i < c; i++) out[dst + 1 + i] = pixels[src + i]!;
      for (let i = c; i < stride; i++) out[dst + 1 + i] = pixels[src + i]! - pixels[src + i - c]!;
    }
    await this.writer.write(out);
  }

  async finish(): Promise<Blob> {
    await this.writer.close();
    await this.reading;
    this.parts.push(chunk('IEND', new Uint8Array(0)));
    return new Blob(this.parts, { type: 'image/png' });
  }

  abort(): void {
    void this.writer.abort().catch(() => undefined);
  }
}
