export async function parseJsonAsync(text: string): Promise<unknown> {
  if (text.length < 512 * 1024 || typeof Worker === 'undefined') return JSON.parse(text);
  const worker = new Worker(new URL('./json-worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ value?: unknown; error?: string }>) => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.value);
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage(text);
    });
  } finally { worker.terminate(); }
}
