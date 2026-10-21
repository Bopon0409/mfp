import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageCache, decodeImage } from '../src/images.ts';

// PNG by signature (the content doesn't matter to the stub decoder).
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(32).fill(0)]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array(32).fill(0)]);

/** Browser decoder stubs: calls — which paths were tried; broken — fail. */
function stubDecoders(state: { broken: boolean; decoderBroken?: boolean; calls: string[] }) {
  vi.stubGlobal(
    'ImageDecoder',
    class {
      async decode() {
        state.calls.push('decoder');
        if (state.decoderBroken) throw new Error('EncodingError');
        return { image: { close() {} } };
      }
      close() {}
    },
  );
  vi.stubGlobal('createImageBitmap', async (src: unknown, opts?: { resizeWidth?: number }) => {
    if (src instanceof Blob) state.calls.push('blob');
    if (state.broken) throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
    return { width: opts?.resizeWidth ?? 100, height: 50, close() {} };
  });
}

const ck = { MakeLazyImageFromTextureSource: (b: { width: number; height: number }) => ({ width: () => b.width, height: () => b.height, delete() {} }) };

describe('image cache: decoding', () => {
  it('requests a small preview first and upgrades only images requested at the new zoom', async () => {
    vi.useFakeTimers();
    stubDecoders({ broken: false, calls: [] });
    const preview = vi.fn(async () => png), original = vi.fn(async () => png);
    const cache = new ImageCache(ck as never, { readImage: original, readImagePreview: preview }, () => {});
    cache.get('visible', 1800, 5000); cache.get('distant', 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.mock.calls).toEqual([['visible', 256], ['distant', 128]]);
    // Original dimensions must not upscale an already reduced server response.
    expect(cache.get('visible', 256, 5000)?.width()).toBe(100);
    cache.get('visible', 1800);
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.mock.calls.at(-1)).toEqual(['visible', 2048]);
    expect(original).not.toHaveBeenCalled();
    cache.dispose();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('PNG — ImageDecoder straight from bytes, falling back to Blob; JPEG — Blob first', async () => {
    const state = { broken: false, decoderBroken: true, calls: [] as string[] };
    stubDecoders(state);
    const bm = await decodeImage(png, 64);
    expect(state.calls).toEqual(['decoder', 'blob']);
    expect(bm.width).toBe(64);
    state.calls = [];
    state.decoderBroken = false;
    await decodeImage(png);
    expect(state.calls).toEqual(['decoder']);
    state.calls = [];
    await decodeImage(jpeg, 32);
    expect(state.calls).toEqual(['blob']);
  });

  it('a temporary failure is retried later; after the third failure the image is marked failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const state = { broken: true, calls: [] as string[] };
    stubDecoders(state);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const redraws: string[] = [];
    const cache = new ImageCache(ck as never, { readImage: async () => png }, (h) => redraws.push(h));

    // First attempt fails; not requested again immediately, after 1.5 s — redraw and retry.
    expect(cache.get('a', 64, 1000)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.get('a', 64, 1000)).toBeUndefined();
    expect(cache.idle).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(redraws).toEqual(['a']);
    state.broken = false;
    cache.get('a', 64, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.get('a', 64, 1000)?.width()).toBe(64);
    expect(warn).not.toHaveBeenCalled();

    // Failed three times in a row — failed, no longer requested.
    state.broken = true;
    cache.get('b', 64, 1000);
    await vi.advanceTimersByTimeAsync(1500);
    cache.get('b', 64, 1000);
    await vi.advanceTimersByTimeAsync(6000);
    cache.get('b', 64, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledTimes(1);
    state.calls = [];
    cache.get('b', 64, 1000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.calls).toEqual([]);
    warn.mockRestore();
  });

  it('over budget, large levels of long-unused images are freed; small and needed ones stay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    stubDecoders({ broken: false, calls: [] });
    const evicted: string[][] = [];
    const cache = new ImageCache(ck as never, { readImage: async () => png }, () => {}, 250_000);
    cache.onEvict((h) => evicted.push([...h]));
    for (const h of ['a', 'b']) {
      cache.get(h, 512, 1000);
      cache.get(h, 64, 1000);
    }
    await vi.advanceTimersByTimeAsync(0);
    // Decoder stub: height 50, width — the level.
    expect(cache.bytes).toBe(2 * (512 + 64) * 50 * 4);
    await vi.advanceTimersByTimeAsync(5000);
    cache.get('c', 512, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(evicted).toEqual([['a', 'b']]);
    expect(cache.bytes).toBe((64 + 64 + 512) * 50 * 4);
    expect(cache.get('a', 64, 1000)?.width()).toBe(64);
    expect(cache.get('c', 512, 1000)?.width()).toBe(512);
  });
});
