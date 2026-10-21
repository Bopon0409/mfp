import sharp from 'sharp';
import type { BlobStore } from './util.ts';

function animatedPng(bytes: Uint8Array) {
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes.length < 16) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 12 <= bytes.length;) {
    if (view.getUint32(at + 4) === 0x6163544c) return true; // acTL
    const length = view.getUint32(at); at += 12 + length;
  }
  return false;
}

export const IMAGE_SIZES = [128, 256, 512, 1024, 2048, 4096];
/** One conversion at a time on the small beta VPS; concurrent identical requests share work. */
export class ImageVariants {
  private pending = new Map<string, Promise<Uint8Array | null>>();
  private tail: Promise<unknown> = Promise.resolve();
  private store: BlobStore;
  constructor(store: BlobStore) { this.store = store; }
  async get(hash: string, size: number): Promise<Uint8Array | null> {
    if (!IMAGE_SIZES.includes(size)) throw new Error('Invalid image size');
    const key = `image-variants/v1/${hash}/${size}.webp`;
    const cached = await this.store.get(key);
    if (cached) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    // Bound pending CPU work; clients can fall back to the original.
    if (this.pending.size >= 64) return null;
    const job = this.tail.then(async () => {
      const source = await this.store.get(`images/${hash}`);
      if (!source) return null;
      if (animatedPng(source)) return null;
      try {
        const image = sharp(source, { limitInputPixels: 64 * 1024 * 1024, failOn: 'error' });
        const meta = await image.metadata();
        // Keep animated/unsupported content on its original path, never flatten animation.
        if ((meta.pages ?? 1) > 1 || !['jpeg', 'png', 'webp', 'avif'].includes(meta.format ?? '')) return null;
        const bytes = await image.rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, alphaQuality: 100 }).toBuffer();
        await this.store.put(key, bytes);
        return bytes;
      } catch { return null; }
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, job); this.tail = job.catch(() => {});
    return job;
  }
}
