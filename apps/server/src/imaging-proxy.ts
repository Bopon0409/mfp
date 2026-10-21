// Proxying “Image enhancements” requests to Magnific/Freepik: their API isn't reachable from the browser (CORS).
// The user's key arrives in a header and is passed on as is — the server doesn't store it or write it
// to the log. Only upscaler paths are proxied; finished images from the CDN — only over https and not to
// internal addresses (otherwise the server could be used to read its own network).

import { lookup } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

const HOSTS = { magnific: { base: 'https://api.magnific.com', header: 'x-magnific-api-key' }, freepik: { base: 'https://api.freepik.com', header: 'x-freepik-api-key' } } as const;
const PATH = /^v1\/ai\/image-upscaler(?:-precision(?:-v2)?)?(?:\/[A-Za-z0-9-]{1,64})?$/;
const MAX_BODY = 96 * 2 ** 20;
const MAX_FILE = 128 * 2 ** 20;
const MAX_REDIRECTS = 3;

export const IMAGING_HEADERS = 'x-magnific-api-key, x-freepik-api-key';

/** Where to forward an upscaler request: only known paths and one of the two services. */
export function magnificTarget(path: string, headers: IncomingMessage['headers']): { url: string; header: string; key: string } | null {
  if (!PATH.test(path)) return null;
  for (const host of Object.values(HOSTS)) {
    const key = headers[host.header];
    if (typeof key === 'string' && key.trim()) return { url: `${host.base}/${path}`, header: host.header, key: key.trim() };
  }
  return null;
}

/** Internal, reserved and local addresses — the server must not go there. */
export function isPrivateAddress(ip: string): boolean {
  ip = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4 inside IPv6 (::ffff:127.0.0.1; in a URL the address is written as ::ffff:7f00:1).
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  const v4 = hex ? [parseInt(hex[1]!, 16) >> 8, parseInt(hex[1]!, 16) & 255, parseInt(hex[2]!, 16) >> 8, parseInt(hex[2]!, 16) & 255].join('.') : ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

async function safeUrl(raw: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return null;
  try {
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return null;
  } catch {
    return null;
  }
  return url;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, status: number, error: string) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error }));

async function forward(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, 'Только GET и POST');
  const target = magnificTarget(path, req.headers);
  if (!target) return json(res, PATH.test(path) ? 401 : 404, PATH.test(path) ? 'Нет ключа Magnific или Freepik' : 'Этот адрес не пересылается');
  const body = req.method === 'POST' ? await readBody(req, MAX_BODY) : null;
  if (req.method === 'POST' && !body) return json(res, 413, 'Картинка слишком большая');
  const upstream = await fetch(target.url, {
    method: req.method,
    headers: { [target.header]: target.key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' }).end(bytes);
}

async function download(res: ServerResponse, raw: string | null) {
  let url = raw ? await safeUrl(raw) : null;
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    const upstream = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if (upstream.status >= 300 && upstream.status < 400) {
      const next = upstream.headers.get('location');
      url = next ? await safeUrl(new URL(next, url).href) : null;
      continue;
    }
    const type = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !type.startsWith('image/')) return json(res, 502, `Картинка не скачалась: ${upstream.status}`);
    if (Number(upstream.headers.get('content-length') ?? 0) > MAX_FILE) return json(res, 413, 'Картинка слишком большая');
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_FILE) return json(res, 413, 'Картинка слишком большая');
    res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store' }).end(bytes);
    return;
  }
  json(res, 400, 'Адрес картинки не разрешён');
}

/** /api/imaging/magnific/<upscaler path> and /api/imaging/fetch?url=… ; false — not our route. */
export async function imagingProxy(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname.startsWith('/api/imaging/magnific/')) {
      await forward(req, res, url.pathname.slice('/api/imaging/magnific/'.length));
      return true;
    }
    if (url.pathname === '/api/imaging/fetch') {
      if (req.method !== 'GET') json(res, 405, 'Только GET');
      else await download(res, url.searchParams.get('url'));
      return true;
    }
  } catch (e) {
    if (!res.headersSent) json(res, 502, `Сервис недоступен: ${(e as Error).name === 'TimeoutError' ? 'нет ответа' : 'ошибка сети'}`);
    return true;
  }
  return false;
}
