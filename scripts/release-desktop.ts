// Desktop app update release: sign the built installer with the update key and
// generate latest.json (Tauri format) in dist/updates-<version>/. Both files are uploaded to the
// v<version> release on GitHub (apps fetch updates from there), and for a closed network — to the
// <server data>/updates folder of the company server — see docs/self-host.md.
//
//   npm run build -w @mfp/desktop -- --bundles nsis
//   node scripts/release-desktop.ts "What's new in this version"
//   MFP_RELEASES_REPO=owner/repository — a different releases repository (default Bopon0409/mfp)
//
// Key — MFP_UPDATER_KEY or ~/.mfp/updater.key (password — MFP_UPDATER_KEY_PASSWORD, empty by default).
// The key and password are never printed and never committed. The public key is in tauri.conf.json.

import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// Public releases repository (owner/name): the installer is in the v<version> release on GitHub. Company
// servers rewrite the link to their own address anyway (apps/server/src/updates.ts).
const RELEASES = process.env.MFP_RELEASES_REPO ?? 'Bopon0409/mfp';
const conf = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')) as { version: string };
const version = conf.version;
const name = `MFP_${version}_x64-setup.exe`;
const exe = join(ROOT, 'apps/desktop/src-tauri/target/release/bundle/nsis', name);
if (!existsSync(exe)) throw new Error(`Нет установщика ${exe} — сначала: npm run build -w @mfp/desktop -- --bundles nsis`);
const key = process.env.MFP_UPDATER_KEY ?? join(homedir(), '.mfp', 'updater.key');
if (!existsSync(key)) throw new Error(`Нет ключа обновлений (${key})`);

const out = join(ROOT, 'dist', `updates-${version}`);
mkdirSync(out, { recursive: true });
const target = join(out, name);
copyFileSync(exe, target);
rmSync(`${target}.sig`, { force: true });
// Signing: tauri signer writes <file>.sig; its output (the public signature) isn't needed — not printed.
// On Windows npx goes through the shell: arguments are quoted (otherwise an empty password gets lost).
const win = process.platform === 'win32';
const arg = (s: string) => (win ? `"${s.replace(/"/g, '\\"')}"` : s);
execFileSync('npx', ['tauri', 'signer', 'sign', '-f', arg(key), '-p', arg(process.env.MFP_UPDATER_KEY_PASSWORD ?? ''), arg(target)], {
  cwd: join(ROOT, 'apps/desktop'),
  stdio: 'ignore',
  shell: win,
});
const signature = readFileSync(`${target}.sig`, 'utf8').trim();
rmSync(`${target}.sig`);
// Verify the signature with the app's public key (minisign: Ed25519 over the file's BLAKE2b-512) — before publishing.
{
  const tauri = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')) as { plugins: { updater: { pubkey: string } } };
  const line = (b64: string) => Buffer.from(Buffer.from(b64, 'base64').toString('utf8').split('\n')[1]!, 'base64');
  const pub = line(tauri.plugins.updater.pubkey);
  const sig = line(signature);
  if (sig.subarray(2, 10).compare(pub.subarray(2, 10)) !== 0) throw new Error('Подпись сделана другим ключом, не тем, что в tauri.conf.json');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.subarray(10, 42)]), format: 'der', type: 'spki' });
  const digest = sig.subarray(0, 2).toString() === 'ED' ? createHash('blake2b512').update(readFileSync(target)).digest() : readFileSync(target);
  if (!verify(null, digest, key, sig.subarray(10, 74))) throw new Error('Подпись установщика не сходится с открытым ключом приложения');
}
const latest = {
  version,
  notes: process.argv[2] ?? '',
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: { 'windows-x86_64': { url: `https://github.com/${RELEASES}/releases/download/v${version}/${name}`, signature } },
};
writeFileSync(join(out, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(`Обновление ${version}: ${out}`);
console.log(`  ${name} (${(statSync(target).size / 2 ** 20).toFixed(1)} МиБ) и latest.json → в папку <данные>/updates сервера.`);
