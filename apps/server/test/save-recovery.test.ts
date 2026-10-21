import { afterEach, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { LiveFiles } from '../src/live.ts';
import type { Db } from '../src/db.ts';
import type { Auth } from '../src/auth.ts';
import type { BlobStore } from '../src/util.ts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('failed idle save retains document and retries without another edit', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let fail = true;
  let saved: Uint8Array | null = null;
  const store: BlobStore = {
    get: async () => null, has: async () => false, delete: async () => {},
    put: async (_key, bytes) => { if (fail) throw new Error('disk full'); saved = bytes; },
  };
  const live = new LiveFiles({ run: async () => 1 } as unknown as Db, store, {} as Auth);
  const local = await live.participant('test', () => {});
  const doc = new LoroDoc();
  doc.getMap('m').set('value', 'recover me'); doc.commit();
  local.submit(doc.export({ mode: 'update' }));
  local.leave();
  await vi.advanceTimersByTimeAsync(0);
  expect(live.open).toBe(1);
  fail = false;
  await vi.advanceTimersByTimeAsync(2100);
  expect(live.open).toBe(0);
  const restored = new LoroDoc(); restored.import(saved!);
  expect(restored.getMap('m').get('value')).toBe('recover me');
  await live.close();
});

it('shutdown waits for in-flight write and persists newer edits afterwards', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  let saved: Uint8Array | null = null;
  const store: BlobStore = {
    get: async () => null, has: async () => false, delete: async () => {},
    put: async (_key, bytes) => { if (++writes === 1) await blocked; saved = bytes; },
  };
  const live = new LiveFiles({ run: async () => 1 } as unknown as Db, store, {} as Auth);
  const local = await live.participant('test', () => {});
  const doc = new LoroDoc();
  doc.getMap('m').set('value', 1); doc.commit(); local.submit(doc.export({ mode: 'update' }));
  await vi.advanceTimersByTimeAsync(2100);
  expect(writes).toBe(1);
  doc.getMap('m').set('value', 2); doc.commit(); local.submit(doc.export({ mode: 'update' }));
  const closing = live.close();
  release(); await closing;
  const restored = new LoroDoc(); restored.import(saved!);
  expect(restored.getMap('m').get('value')).toBe(2);
  expect(writes).toBe(2);
});
