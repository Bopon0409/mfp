// THIRD-PARTY.md: third-party components that end up in the program — their licenses and sources.
// JS — dependencies of the editor, viewer, server and CLI (no dev dependencies), Rust — the desktop app
// for Windows, macOS and Linux (no build dependencies or procedural macros: see rust-licenses.ts).
// Also — apps/editor/public/licenses.txt: full license texts (goes to the website, installer and image).
// Run: node scripts/third-party.ts (requires cargo in PATH). GPL, AGPL — error; LGPL — only
// libvips from sharp (server, a separate dynamic library, sources available).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface Item {
  name: string;
  version: string;
  license: string;
  source: string;
  /** Package folder — LICENSE / NOTICE / COPYING files are taken from there. */
  dir: string;
}

const OK = /^(MIT|MIT-0|Apache-2\.0|Apache-2\.0 WITH LLVM-exception|BSD-2-Clause|BSD-3-Clause|ISC|Zlib|Unicode-3\.0|Unicode-DFS-2016|0BSD|CC0-1\.0|BSL-1\.0|Unlicense|Python-2\.0)$/;
const free = (lic: string) => lic.split(/\s+OR\s+|\//).some((alt) => alt.replace(/[()]/g, '').trim().split(/\s+AND\s+/).every((p) => OK.test(p.trim())));
const mplOnly = (lic: string) => /MPL-2\.0/.test(lic) && !/GPL/.test(lic) && !free(lic);
// libvips in sharp builds: LGPL-3.0-or-later, linked as a separate library (.dll / .so)
const lgplVips = (i: Item) => /^@img\/sharp-/.test(i.name) && /LGPL-3\.0-or-later/.test(i.license) && !/(^|[^L])GPL/.test(i.license.replace(/LGPL/g, ''));

// ---------- JS ----------

const ROOT = resolve('.');
const APPS = ['apps/editor', 'apps/viewer', 'apps/server', 'apps/cli'];

/** package.json of package name as seen from folder from (the way Node resolves: up through node_modules). */
function findPackage(name: string, from: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    const p = join(d, 'node_modules', name, 'package.json');
    if (existsSync(p)) return p;
    if (dirname(d) === d) return null;
  }
}

const repoUrl = (r: unknown): string => {
  const raw = typeof r === 'string' ? r : ((r as { url?: string } | undefined)?.url ?? '');
  return raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^([\w-]+\/[\w.-]+)$/, 'https://github.com/$1');
};

const js = new Map<string, Item>();
const seen = new Set<string>();
function walkJs(pkgJson: string) {
  if (seen.has(pkgJson)) return;
  seen.add(pkgJson);
  const p = JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, unknown>;
  const name = String(p.name);
  const dir = dirname(pkgJson);
  // Our own packages (@mfp/*) are not third-party, but their dependencies are.
  if (!name.startsWith('@mfp/')) {
    const lic = typeof p.license === 'string' ? p.license : ((p.license as { type?: string } | undefined)?.type ?? '(not specified)');
    js.set(`${name}@${p.version}`, { name, version: String(p.version), license: lic, source: repoUrl(p.repository) || String(p.homepage ?? '') || `https://www.npmjs.com/package/${name}`, dir });
  }
  const deps = { ...(p.dependencies as Record<string, string> | undefined), ...(p.optionalDependencies as Record<string, string> | undefined) };
  for (const d of Object.keys(deps)) {
    const found = findPackage(d, dir);
    if (found) walkJs(found);
  }
}
for (const app of APPS) walkJs(join(ROOT, app, 'package.json'));

// ---------- Rust ----------

const MANIFEST = 'apps/desktop/src-tauri/Cargo.toml';
const TARGETS = ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'];
const rustSet = new Set<string>();
for (const target of TARGETS) {
  const out = execFileSync('cargo', ['tree', '-e', 'normal,no-proc-macro', '--target', target, '--prefix', 'none', '--format', '{p}', '--manifest-path', MANIFEST], { maxBuffer: 1 << 28 }).toString();
  for (const line of out.split('\n')) {
    const m = /^(\S+) v(\S+)/.exec(line.trim());
    if (m && !line.includes('(D:') && m[1] !== 'mfp-desktop') rustSet.add(`${m[1]}@${m[2]}`);
  }
}
const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', MANIFEST], { maxBuffer: 1 << 28 }).toString()) as {
  packages: { name: string; version: string; license?: string | null; repository?: string | null; homepage?: string | null; manifest_path: string }[];
};
const rust = new Map<string, Item>();
for (const p of meta.packages) {
  const key = `${p.name}@${p.version}`;
  if (rustSet.has(key)) rust.set(key, { name: p.name, version: p.version, license: p.license ?? '(not specified)', source: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`, dir: dirname(p.manifest_path) });
}

// ---------- Summary ----------

// ---------- Bundled fonts ----------

const FONTS = 'apps/editor/public/fonts';
const fontCatalog = JSON.parse(readFileSync(join(FONTS, 'catalog.json'), 'utf8')) as { families: Record<string, { id: string; normal: number[]; italic: number[] }> };
const fonts = Object.entries(fontCatalog.families)
  .map(([family, f]) => {
    const license = readFileSync(join(FONTS, `${f.id}@latest`, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim();
    if (!/SIL Open Font License/.test(license)) throw new Error(`${family}: not SIL OFL`);
    return { family, id: f.id, weights: [...new Set([...f.normal, ...f.italic])].sort((a, b) => a - b), italic: f.italic.length > 0, license };
  })
  .sort((a, b) => a.family.localeCompare(b.family));

const sorted = (m: Map<string, Item>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const bad = [...js.values(), ...rust.values()].filter((i) => !free(i.license) && !mplOnly(i.license) && !lgplVips(i));
const lgpl = [...js.values()].filter(lgplVips);
const mpl = [...js.values(), ...rust.values()].filter((i) => mplOnly(i.license));
const row = (i: Item) => `| ${i.name} | ${i.version} | ${i.license} | ${i.source} |`;
const table = (items: Item[]) => ['| Component | Version | License | Source |', '|---|---|---|---|', ...items.map(row)].join('\n');
const md = `# Third-party components

MFP uses the open-source libraries listed below. The full texts of their licenses ship with the
program in the \`licenses.txt\` file. The list is generated by
\`node scripts/third-party.ts\`; it contains no GPL or AGPL licenses, and LGPL only for libvips on the server (below).

Figma is a trademark of Figma, Inc. MFP is an independent product, not affiliated with or endorsed
by Figma, Inc.; references to Figma indicate file and plugin compatibility only.

## Bundled fonts — ${fonts.length}

Shipped unmodified (TTF files from Fontsource, latin, latin-ext and cyrillic subsets), located in
apps/editor/public/fonts, work without internet; Inter is also the interface font. All are under the
SIL Open Font License 1.1; the license texts with copyright notices are in licenses.txt and next to the files.
With internet access allowed, the other catalog fonts are loaded at run time from Fontsource
(jsDelivr) — they have their own licenses (mostly SIL OFL 1.1).

| Font | Styles | License | Source |
|---|---|---|---|
${fonts.map((f) => `| ${f.family} | ${f.weights.join(', ')}${f.italic ? ' and italic' : ''} | OFL-1.1 | https://fontsource.org/fonts/${f.id} |`).join('\n')}

## Under MPL-2.0

Used unmodified, as separate libraries; sources at the links:

${mpl.length ? mpl.map((i) => `- ${i.name} ${i.version} — ${i.source}`).join('\n') : '- none'}

## Under LGPL-3.0-or-later (server only)

The libvips image processing library is part of the prebuilt sharp binaries and is loaded by the server
as a separate, unmodified dynamic library; it can be replaced with your own build. The libvips sources
and build scripts: https://github.com/lovell/sharp-libvips, https://github.com/libvips/libvips.
In the Linux Docker image these are the @img/sharp-linux-x64 and @img/sharp-libvips-linux-x64 packages.

${lgpl.length ? lgpl.map((i) => `- ${i.name} ${i.version} — ${i.license} — ${i.source}`).join('\n') : '- none'}

## Neural network models

| Model | Where | License | Source |
|---|---|---|---|
| Real-ESRGAN (realesr-general-x4v3, RealESRGAN_x4plus, x4plus_anime) | bundled, apps/editor/public/upscaler | BSD-3-Clause | https://github.com/xinntao/Real-ESRGAN |
| BiRefNet lite (background removal) | not bundled: downloaded from Hugging Face (jiabins0303/birefnet-lite-1024-webgpu, revision 1ad01ce) on the first background removal, verified by SHA-256 | MIT (the weights were trained on DIS5K among others — the dataset has its own non-commercial terms) | https://github.com/ZhengPeng7/BiRefNet |
| SD-Turbo (text to image) | downloaded to the user's computer when the user starts it, not bundled | Stability AI Community License | https://huggingface.co/stabilityai/sd-turbo |

## Editor, viewer, server, CLI (JavaScript and WebAssembly) — ${js.size}

${table(sorted(js))}

## App for Windows, macOS and Linux (Rust) — ${rust.size}

${table(sorted(rust))}
`;
writeFileSync('THIRD-PARTY.md', md);

// ---------- Full license texts ----------

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
const texts = new Map<string, string[]>();
const missing: string[] = [];
for (const i of [...sorted(js), ...sorted(rust)]) {
  const files = existsSync(i.dir) ? readdirSync(i.dir).filter((f) => LICENSE_FILE.test(f)).sort() : [];
  if (!files.length) {
    missing.push(`${i.name} ${i.version}`);
    continue;
  }
  const body = files.map((f) => readFileSync(join(i.dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n');
  const list = texts.get(body) ?? [];
  list.push(`${i.name} ${i.version} (${i.license})`);
  texts.set(body, list);
}
const MODELS = `Real-ESRGAN — BSD 3-Clause License, Copyright (c) 2021, Xintao Wang. https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE
BiRefNet — MIT License, Copyright (c) 2024 ZhengPeng. https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE`;
const txt = [
  'MFP — third-party components and their licenses. The list with versions and links is THIRD-PARTY.md.',
  'Figma is a trademark of Figma, Inc. MFP is not affiliated with or endorsed by Figma, Inc.',
  '',
  ...[...texts].flatMap(([body, who]) => ['='.repeat(78), ...who, '-'.repeat(78), body, '']),
  ...fonts.flatMap((f) => ['='.repeat(78), `Font ${f.family} (OFL-1.1) — apps/editor/public/fonts/${f.id}@latest`, '-'.repeat(78), f.license, '']),
  '='.repeat(78),
  'Neural network models',
  '-'.repeat(78),
  MODELS,
  ...(missing.length ? ['', '='.repeat(78), 'Packages without a license file in the distribution — the license is in the metadata, the texts are at the links in THIRD-PARTY.md:', ...missing] : []),
  '',
].join('\n');
writeFileSync('apps/editor/public/licenses.txt', txt);
console.log(`licenses.txt: ${texts.size} distinct texts, without a file: ${missing.length}`);
console.log(`JS: ${js.size}, Rust: ${rust.size}, MPL: ${mpl.length}`);
if (bad.length) {
  console.log(`NOT ALLOWED (${bad.length}):\n  ${bad.map((i) => `${i.name} ${i.version}: ${i.license}`).join('\n  ')}`);
  process.exitCode = 1;
}
