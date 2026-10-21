// Minimal random-access ZIP reader (including ZIP64).
// Reads the central directory from the end of the file and decompresses only the needed entries.

import { inflateSync } from 'fflate';
import type { ByteSource } from './source.ts';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const U32_MAX = 0xffffffff;

const u64 = (v: DataView, o: number) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 2 ** 32;

export async function readZipDirectory(src: ByteSource): Promise<ZipEntry[]> {
  // EOCD: 22 bytes + a comment of up to 64 KB at the very end of the file.
  const tailLen = Math.min(src.size, 22 + 0xffff + 20);
  const tailStart = src.size - tailLen;
  const tail = await src.read(tailStart, tailLen);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Не найден конец центрального каталога ZIP');

  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);

  if (cdOffset === U32_MAX || cdSize === U32_MAX || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== ZIP64_LOCATOR_SIG) throw new Error('Повреждённый ZIP64');
    const z64Offset = u64(tv, loc + 8);
    const z64 = await src.read(z64Offset, 56);
    const zv = new DataView(z64.buffer, z64.byteOffset, z64.byteLength);
    if (zv.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new Error('Повреждённый ZIP64 EOCD');
    count = u64(zv, 32);
    cdSize = u64(zv, 40);
    cdOffset = u64(zv, 48);
  }

  const cd = await src.read(cdOffset, cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const utf8 = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (v.getUint32(p, true) !== CDH_SIG) throw new Error('Повреждённый центральный каталог ZIP');
    const method = v.getUint16(p + 10, true);
    let compressedSize = v.getUint32(p + 20, true);
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    let localHeaderOffset = v.getUint32(p + 42, true);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra: fields are present only for values equal to 0xFFFFFFFF.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === U32_MAX) (size = u64(v, q)), (q += 8);
        if (compressedSize === U32_MAX) (compressedSize = u64(v, q)), (q += 8);
        if (localHeaderOffset === U32_MAX) localHeaderOffset = u64(v, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, localHeaderOffset });
    p = extraEnd + commentLen;
  }
  return entries;
}

export async function readZipEntry(src: ByteSource, entry: ZipEntry): Promise<Uint8Array> {
  const header = await src.read(entry.localHeaderOffset, 30);
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (hv.getUint32(0, true) !== LFH_SIG) throw new Error(`Повреждённый заголовок записи ${entry.name}`);
  const dataStart = entry.localHeaderOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const data = await src.read(dataStart, entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(entry.size) });
  throw new Error(`Неподдерживаемый метод сжатия ZIP ${entry.method} (${entry.name})`);
}
