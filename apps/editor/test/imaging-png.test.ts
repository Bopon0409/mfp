import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PngStream } from '../src/imaging/png.ts';

function readChunks(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  for (let p = 8; p < bytes.length; ) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + length);
    const crcOk = view.getUint32(p + 8 + length) === crc32(bytes.subarray(p + 4, p + 8 + length));
    chunks.push({ type, data, crcOk });
    p += 12 + length;
  }
  return chunks;
}

function unfilter(raw: Uint8Array, width: number, height: number, channels: number) {
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let r = 0; r < height; r++) {
    expect(raw[r * (stride + 1)]).toBe(1);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[r * stride + i - channels]! : 0;
      out[r * stride + i] = (raw[r * (stride + 1) + 1 + i]! + left) & 255;
    }
  }
  return out;
}

describe('image enhancements: streaming PNG', () => {
  it('rows written in parts assemble into a valid PNG with the original pixels', async () => {
    const width = 5;
    const height = 4;
    const pixels = Uint8Array.from({ length: width * height * 3 }, (_, i) => (i * 37 + 11) & 255);
    const png = new PngStream(width, height, 3);
    await png.writeRows(pixels.subarray(0, width * 3), 1);
    await png.writeRows(pixels.subarray(width * 3), height - 1);
    const bytes = new Uint8Array(await (await png.finish()).arrayBuffer());

    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks = readChunks(bytes);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    expect(chunks[0]!.type).toBe('IHDR');
    expect(chunks.at(-1)!.type).toBe('IEND');
    const header = new DataView(chunks[0]!.data.buffer, chunks[0]!.data.byteOffset);
    expect([header.getUint32(0), header.getUint32(4), chunks[0]!.data[8], chunks[0]!.data[9]]).toEqual([width, height, 8, 2]);

    const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
    const raw = inflateSync(Buffer.concat(idat));
    expect(unfilter(raw, width, height, 3)).toEqual(pixels);
  });

  it('with transparency writes RGBA (color type 6)', async () => {
    const png = new PngStream(2, 1, 4);
    const pixels = new Uint8Array([10, 20, 30, 0, 40, 50, 60, 255]);
    await png.writeRows(pixels, 1);
    const chunks = readChunks(new Uint8Array(await (await png.finish()).arrayBuffer()));
    expect(chunks[0]!.data[9]).toBe(6);
    const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
    expect(unfilter(raw, 2, 1, 4)).toEqual(pixels);
  });
});
