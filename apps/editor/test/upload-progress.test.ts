import { afterEach, expect, it, vi } from 'vitest';
import { Account } from '../src/account.ts';

vi.mock('../src/platform.ts', () => ({ isDesktop: true }));
afterEach(() => vi.unstubAllGlobals());

it('counts existing, uploaded and missing images once, including an empty document', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) =>
    new Response(null, { status: init.method === 'PUT' || url.endsWith('/exists') ? 200 : 404 })));
  const progress = vi.fn();
  const account = new Account();
  expect(await account.uploadImages(['exists', 'new', 'missing', 'new'], async h => h === 'missing' ? undefined : new Uint8Array([1]), progress)).toBe(1);
  expect(progress.mock.calls[0]).toEqual([0, 3]);
  expect(progress.mock.calls.map(c => c[0])).toEqual([0, 1, 2, 3]);
  expect(progress.mock.calls.at(-1)).toEqual([3, 3]);
  progress.mockClear();
  await account.uploadImages([], async () => undefined, progress);
  expect(progress.mock.calls).toEqual([[0, 0]]);
});

it('waits for in-flight work after failure and does not report failed uploads as complete', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    if (url.endsWith('/slow')) await held;
    return new Response(null, { status: url.endsWith('/bad') ? 500 : 200 });
  }));
  const progress = vi.fn();
  let settled = false;
  const outcome = new Account().uploadImages(['bad', 'slow'], async () => new Uint8Array([1]), progress)
    .catch(e => e).then(e => { settled = true; return e; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  release();
  expect((await outcome).status).toBe(500);
  expect(progress.mock.calls.at(-1)).toEqual([1, 2]);
});
