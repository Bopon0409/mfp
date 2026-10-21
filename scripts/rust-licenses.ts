// Licenses of the desktop app's Rust dependencies that end up in the program (excluding build and dev
// dependencies and procedural macros — they only run at compile time).
// Run: node scripts/rust-licenses.ts [target, default x86_64-pc-windows-msvc]
//
// Permissive (MIT, Apache, BSD, ISC, Zlib and similar) — allowed. MPL-2.0 — allowed only as an
// unmodified library, stating where to get the sources (THIRD-PARTY.md); copying MPL code
// into our own is not allowed. GPL, AGPL, LGPL — not allowed.

import { execFileSync } from 'node:child_process';

const target = process.argv[2] ?? 'x86_64-pc-windows-msvc';
const out = execFileSync('cargo', ['tree', '-e', 'normal,no-proc-macro', '--target', target, '--prefix', 'none', '--format', '{p}\t{l}', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml'], {
  maxBuffer: 1 << 28,
}).toString();
const pkgs = new Map<string, string>();
for (const line of out.split('\n')) {
  const [p, l] = line.replace(' (*)', '').split('\t');
  if (p && !p.includes('(D:') && !p.startsWith('mfp-desktop')) pkgs.set(p.trim(), (l ?? '').trim() || '(not specified)');
}
const OK = /^(MIT|MIT-0|Apache-2\.0|Apache-2\.0 WITH LLVM-exception|BSD-2-Clause|BSD-3-Clause|ISC|Zlib|Unicode-3\.0|Unicode-DFS-2016|0BSD|CC0-1\.0|BSL-1\.0|Unlicense)$/;
const free = (lic: string) => lic.split(/\s+OR\s+|\//).some((alt) => alt.replace(/[()]/g, '').trim().split(/\s+AND\s+/).every((p) => OK.test(p.trim())));
const count = new Map<string, number>();
const mpl: string[] = [];
const bad: string[] = [];
for (const [p, lic] of pkgs) {
  count.set(lic, (count.get(lic) ?? 0) + 1);
  if (free(lic)) continue;
  if (/MPL-2\.0/.test(lic) && !/GPL/.test(lic)) mpl.push(`${p}: ${lic}`);
  else bad.push(`${p}: ${lic}`);
}
console.log(`In the program: ${pkgs.size} packages (${target})`);
for (const [l, n] of [...count].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${l}`);
if (mpl.length) console.log(`\nMPL-2.0 — unmodified only, link to the sources in THIRD-PARTY.md (${mpl.length}):\n  ${mpl.join('\n  ')}`);
console.log(bad.length ? `\nNOT ALLOWED (${bad.length}):\n  ${bad.join('\n  ')}` : '\nNo forbidden licenses.');
process.exitCode = bad.length ? 1 : 0;
