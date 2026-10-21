import { defineConfig } from 'vite';
import { devFiles } from '../../tools/dev-files.ts';
import { stripCommentsPlugin } from '../../tools/strip-comments.ts';

export default defineConfig({
  // Build: no comments, including in code stored as a string (plugin sandbox).
  plugins: [devFiles(), { ...stripCommentsPlugin(), apply: 'build' }],
  worker: { plugins: () => [{ ...stripCommentsPlugin(), apply: 'build' }] },
  // Loro in the browser — the web variant (wasm is loaded asynchronously via import.meta.url).
  resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/web' }] },
  // ONNX Runtime (upscaler) is already ESM; without pre-bundling, Vite reloads the page when the worker is first opened.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: { port: 5174 },
});
