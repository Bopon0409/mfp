// Background document snapshot: serialization in chunks during idle time (requestIdleCallback), so a huge
// document does not freeze for a second on every autosave. urgent() finishes right away (leaving the
// file, closing the window): 200 ms chunks back to back, with events in between (signs of life on close).

import { SnapshotWriter, type Document } from '@mfp/core';

/** Wait for idle; how many milliseconds may be used. */
function idleSlice(): Promise<number> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback((d) => resolve(Math.max(3, Math.min(10, d.timeRemaining()))), { timeout: 1000 });
    else setTimeout(() => resolve(8), 16);
  });
}

/**
 * Document snapshot as JSON chunks. null: the document changed during serialization (cancelled()).
 * cpu: how many milliseconds the serialization itself took.
 */
export async function idleSnapshot(
  doc: Document,
  opts: { urgent?: () => boolean; cancelled?: () => boolean; onCut?: () => void } = {},
): Promise<{ writer: SnapshotWriter; cpu: number } | null> {
  const writer = new SnapshotWriter(doc);
  let cpu = 0;
  let cut = false;
  try {
    for (;;) {
      const urgent = opts.urgent?.() ?? false;
      const slice = urgent ? 200 : await idleSlice();
      if (opts.cancelled?.()) return null;
      const t0 = performance.now();
      const done = writer.step(t0 + slice);
      cpu += performance.now() - t0;
      // The snapshot state is pinned immediately, before any edits (the journal remembers up to which operation).
      if (writer.cut && !cut) {
        cut = true;
        opts.onCut?.();
      }
      if (done) return { writer, cpu };
      if (urgent) await nextTask();
    }
  } finally {
    writer.dispose();
  }
}

/** String chunks of ~1 MB (writing and compression in parts, no long tasks). */
export function* pieces(parts: readonly string[], size = 1 << 20): Generator<string> {
  let batch: string[] = [];
  let n = 0;
  for (const p of parts) {
    if (p.length > size) {
      if (batch.length) yield batch.join('');
      batch = [];
      n = 0;
      for (let i = 0; i < p.length; i += size) yield p.slice(i, i + size);
      continue;
    }
    batch.push(p);
    n += p.length;
    if (n >= size) {
      yield batch.join('');
      batch = [];
      n = 0;
    }
  }
  if (batch.length) yield batch.join('');
}

/** Write a file from chunks (atomically: createWritable writes to a temp file and swaps it in on close). */
export async function writeParts(dir: FileSystemDirectoryHandle, name: string, parts: readonly string[]) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  try {
    for (const p of pieces(parts)) await w.write(p);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => {});
    throw e;
  }
}

/** Yield until the next task (not a microtask: stream reads run as back-to-back microtasks). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

/** Gzip the string chunks (streaming: one chunk at a time, each in its own task). */
export function gzipParts(parts: readonly string[]): Promise<Blob> {
  const enc = new TextEncoder();
  const it = pieces(parts, 256 << 10);
  const src = new ReadableStream<BufferSource>({
    async pull(c) {
      await nextTask();
      const next = it.next();
      if (next.done) c.close();
      else c.enqueue(enc.encode(next.value));
    },
  });
  return new Response(src.pipeThrough(new CompressionStream('gzip'))).blob();
}
