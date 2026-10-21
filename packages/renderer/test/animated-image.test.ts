import { describe, expect, it } from 'vitest';
import { animatedImageType } from '../src/images.ts';

const bytes = (...parts: (string | number[])[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

describe('animated images by their first bytes', () => {
  it('GIF, WebP with ANIM, PNG with acTL — yes; regular ones — no', () => {
    expect(animatedImageType(bytes('GIF89a', [0, 0]))).toBe('image/gif');
    const webpAnim = bytes('RIFF', u32le(30), 'WEBP', 'VP8X', u32le(10), [0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'ANIM', u32le(6), [0, 0, 0, 0, 0, 0]);
    expect(animatedImageType(webpAnim)).toBe('image/webp');
    const webp = bytes('RIFF', u32le(20), 'WEBP', 'VP8 ', u32le(4), [1, 2, 3, 4]);
    expect(animatedImageType(webp)).toBe(null);
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = [...u32be(13), ...'IHDR'.split('').map((c) => c.charCodeAt(0)), ...Array(13).fill(0), 0, 0, 0, 0];
    const actl = [...u32be(8), ...'acTL'.split('').map((c) => c.charCodeAt(0)), ...Array(8).fill(0), 0, 0, 0, 0];
    const idat = [...u32be(0), ...'IDAT'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0];
    expect(animatedImageType(Uint8Array.from([...sig, ...ihdr, ...actl, ...idat]))).toBe('image/png');
    expect(animatedImageType(Uint8Array.from([...sig, ...ihdr, ...idat]))).toBe(null);
    expect(animatedImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(null);
  });
});
