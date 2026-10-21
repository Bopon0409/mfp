// Office server in the app (“Share on the network”): the apps/desktop/src-tauri/office folder, which
// the installer places next to the program (bundle.resources in tauri.conf.json):
//   node.exe            — Node.js (MIT) of this machine: process.execPath, no download;
//   server/*.mjs        — the server as a single minified module (scripts/build-server.ts);
//   node_modules/…      — only third-party packages the server loads externally, with their dependencies;
//   editor/             — the built editor for colleagues in the browser (without upscaler models).
//
//   npm run build -w @mfp/editor && node scripts/build-office.ts   (the app build does this itself)

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'apps/desktop/src-tauri/office');
const EDITOR = join(ROOT, 'apps/editor/dist');
if (!existsSync(join(EDITOR, 'index.html'))) throw new Error('Нет сборки редактора — сначала npm run build -w @mfp/editor');

execFileSync(process.execPath, [join(ROOT, 'scripts/build-server.ts')], { stdio: 'inherit' });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Node.js — the same one we build with (version in office/node-version.txt).
cpSync(process.execPath, join(OUT, process.platform === 'win32' ? 'node.exe' : 'node'));
writeFileSync(join(OUT, 'node-version.txt'), `${process.version}\n`);
cpSync(join(ROOT, 'apps/server/dist'), join(OUT, 'server'), { recursive: true });

// Third-party server packages: bare imports of the build (except pg — only for DATABASE_URL) and their dependencies.
const roots = new Set<string>();
for (const f of readdirSync(join(OUT, 'server'))) {
  const text = readFileSync(join(OUT, 'server', f), 'utf8');
  for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*)["'`]((?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*)(?:\/[^"'`]*)?["'`]/g)) if (m[1] !== 'pg') roots.add(m[1]!);
}
roots.add('canvaskit-wasm'); // createRequire().resolve('canvaskit-wasm/full') — not visible as a string
const copied = new Set<string>();
const copy = (name: string) => {
  if (copied.has(name)) return;
  const dir = join(ROOT, 'node_modules', name);
  if (!existsSync(join(dir, 'package.json'))) return; // optional dependency for another OS
  copied.add(name);
  cpSync(dir, join(OUT, 'node_modules', name), { recursive: true, dereference: true });
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) copy(dep);
};
for (const name of roots) copy(name);

// Editor for colleagues' browsers — without upscaler models (those run in the app).
cpSync(EDITOR, join(OUT, 'editor'), { recursive: true, filter: (src) => !/[\\/]upscaler([\\/]|$)/.test(src.slice(EDITOR.length)) });

const size = (p: string): number => (statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + size(join(p, f)), 0) : statSync(p).size);
console.log(`office: ${(size(OUT) / 2 ** 20).toFixed(0)} МБ — Node ${process.version}, пакеты: ${[...copied].sort().join(', ')}`);
