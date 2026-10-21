// Release build of the desktop app (npm run build -w @mfp/desktop [-- tauri build options]).
// Same as `tauri build`, plus rustc --remap-path-prefix: Rust embeds source paths of crates into
// the binary (panic and error messages), and without remapping they reveal the builder's home folder
// (C:\Users\<name>\.cargo\registry\…). Prefixes are computed on the build machine, nothing personal
// is stored in the repository. Cargo's own `trim-paths` profile option does the same, but it is still
// unstable (Cargo 1.99).

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const home = homedir();
// When several prefixes match, rustc applies the last one — the general ones go first.
const remap: [string, string][] = [
  [home, '~'],
  [process.env.RUSTUP_HOME ?? join(home, '.rustup'), '/rustup'],
  [process.env.CARGO_HOME ?? join(home, '.cargo'), '/cargo'],
  [ROOT, '/mfp'],
];
// CARGO_ENCODED_RUSTFLAGS (separator 0x1f) keeps paths with spaces intact and takes priority over RUSTFLAGS,
// so flags the developer already set are carried over.
const own = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? process.env.RUSTFLAGS?.split(' ') ?? [];
const flags = [...own.filter(Boolean), ...remap.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)];

const cli = createRequire(join(ROOT, 'apps/desktop/package.json')).resolve('@tauri-apps/cli/tauri.js');
const r = spawnSync(process.execPath, [cli, 'build', ...process.argv.slice(2)], {
  cwd: join(ROOT, 'apps/desktop'),
  stdio: 'inherit',
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') },
});
process.exit(r.status ?? 1);
