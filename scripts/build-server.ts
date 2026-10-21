// Server build for distribution (Docker image, company installers): one minified module per
// entry point, without sources, tests or comments. Our packages (@mfp/*, ee/) go into the build,
// third-party ones from node_modules (wasm, native modules: sharp, pg, loro-crdt, canvaskit) stay outside, as is.
//
//   node scripts/build-server.ts        → apps/server/dist/{main,bootstrap-beta,reset-beta-password}.mjs

import { rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'rolldown';
import { stripCommentsPlugin } from '../tools/strip-comments.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'apps/server/dist');

/** Third-party package: a bare import that is not ours (@mfp/*) and not a Node built-in module. */
const external = (id: string) => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(id) && !id.startsWith('@mfp/') && !id.startsWith('\0');

rmSync(OUT, { recursive: true, force: true });
await build({
  input: {
    main: join(ROOT, 'apps/server/src/main.ts'),
    'bootstrap-beta': join(ROOT, 'apps/server/src/bootstrap-beta.ts'),
    'reset-beta-password': join(ROOT, 'apps/server/src/reset-beta-password.ts'),
  },
  platform: 'node',
  plugins: [stripCommentsPlugin()],
  external,
  logLevel: 'warn',
  output: {
    dir: OUT,
    format: 'esm',
    entryFileNames: '[name].mjs',
    chunkFileNames: 'chunk-[hash].mjs',
    minify: true,
    comments: { legal: false },
    sourcemap: false,
  },
});

// Check: no comments and no source paths in the build.
let size = 0;
const leaks: string[] = [];
for (const f of readdirSync(OUT)) {
  const p = join(OUT, f);
  size += statSync(p).size;
  const text = readFileSync(p, 'utf8');
  // The minifier removed comments; there must be none in strings (shaders, code templates).
  for (const m of text.matchAll(/\n[ \t]*\/\/[^\n]*[А-Яа-яЁё][^\n]*/g)) leaks.push(`${f}: ${m[0].trim().slice(0, 80)}`);
  if (/apps\/server\/src|packages\/[a-z-]+\/src/.test(text)) leaks.push(`${f}: путь к исходникам`);
}
console.log(`apps/server/dist: ${readdirSync(OUT).length} файлов, ${(size / 1024 / 1024).toFixed(1)} МБ`);
if (leaks.length) {
  console.log(`Комментарии или пути в сборке (${leaks.length}):\n  ${leaks.slice(0, 20).join('\n  ')}`);
  process.exitCode = 1;
}
