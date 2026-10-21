// MFP desktop app updates: /updates/latest.json and installer files from the folder
// <data>/updates. The app takes updates from the server it is connected to (a company server on a
// closed network), and, if internet access is allowed, also from MFP releases on GitHub.
//
// latest.json — Tauri format (version, notes, pub_date, platforms: { "windows-x86_64": { url, signature } }).
// The server rewrites file addresses to its own: a company only needs to copy latest.json and the
// installer into its updates folder. The app verifies the signature, so a file cannot be swapped.

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { publicBase } from './oauth.ts';
import { safeDecode } from './util.ts';

/** File name without folders (protection against escaping the updates folder). */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/** latest.json with file addresses on this server. */
export function rewriteLatest(text: string, base: string): string {
  const manifest = JSON.parse(text) as { platforms?: Record<string, { url?: string; signature?: string }> };
  for (const p of Object.values(manifest.platforms ?? {})) {
    if (typeof p.url !== 'string') continue;
    const name = safeDecode(p.url.replace(/[?#].*$/, '').replace(/^.*\//, '')) ?? '';
    if (SAFE.test(name)) p.url = `${base}/updates/${encodeURIComponent(name)}`;
  }
  return JSON.stringify(manifest);
}

export function updatesHandler(dir: string) {
  const root = join(dir, 'updates');
  // The folder exists from the start — the admin copies files into it (docker compose cp … mfp:/data/updates/).
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    // No permissions on the data folder: there simply will be no updates from this server.
  }
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const name = safeDecode(new URL(req.url ?? '/', 'http://x').pathname.slice('/updates/'.length)) ?? '';
    const file = join(root, name);
    if (!SAFE.test(name) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Нет обновлений на этом сервере' }));
      return true;
    }
    if (name === 'latest.json') {
      let body: string;
      try {
        body = rewriteLatest(readFileSync(file, 'utf8'), publicBase(req));
      } catch {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'latest.json повреждён' }));
        return true;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }).end(req.method === 'GET' ? body : undefined);
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size, 'cache-control': 'public, max-age=3600' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  };
}
