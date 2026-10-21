// Shared server code: ids and tokens, byte storage (documents, images, thumbnails),
// mail, HTTP — request parsing, responses, errors.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Short random id (16 base62 characters). */
export function newId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += alphabet[b % 62];
  return out;
}

/** Secret (session token, links, API) — 32 random bytes. */
export const newSecret = () => randomBytes(32).toString('base64url');
/** The database stores only secret hashes. */
export const hashSecret = (s: string) => createHash('sha256').update(s).digest('hex');
export const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const COLORS = ['#f45a56', '#4d7bfd', '#40c786', '#ba82f5', '#ffb848', '#e0609a', '#2fb3b8'];
export const colorFor = (s: string) => COLORS[([...s].reduce((h, c) => (h * 31 + c.codePointAt(0)!) | 0, 0) >>> 0) % COLORS.length]!;

// ---------- Byte storage ----------

/** Storage: the key is a path like files/<id>/doc.loro or images/<sha1>. */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** On disk (atomic write: a temporary file, then a rename). */
export function fsStore(dir: string): BlobStore {
  const path = (key: string) => {
    if (key.includes('..') || key.startsWith('/')) throw new Error('Плохой ключ');
    return join(dir, key);
  };
  return {
    async get(key) {
      const p = path(key);
      return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
    },
    async put(key, bytes) {
      const p = path(key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(`${p}.tmp`, bytes);
      renameSync(`${p}.tmp`, p);
    },
    async has(key) {
      return existsSync(path(key));
    },
    async delete(key) {
      rmSync(path(key), { force: true, recursive: true });
    },
  };
}

// ---------- Mail ----------

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Development mail: emails go to the server log and to a file (outbox.jsonl, one line per email).
 * For real use — SMTP (smtp.ts).
 */
export function devMailer(outbox?: string): Mailer {
  return {
    async send(mail) {
      console.log(`[почта] ${mail.to}: ${mail.subject}\n${mail.text}`);
      if (outbox) {
        mkdirSync(dirname(outbox), { recursive: true });
        appendFileSync(outbox, JSON.stringify({ ...mail, at: Date.now() }) + '\n');
      }
    },
  };
}

// ---------- HTTP ----------

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

/** Request body (at most limit bytes). */
export function readBody(req: IncomingMessage, limit = 64 * 2 ** 20): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const bytes = await readBody(req, 4 * 2 ** 20);
  if (!bytes.length) return {} as T;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, 'Тело запроса — не JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

export function sendBytes(res: ServerResponse, bytes: Uint8Array, type = 'application/octet-stream', cache = 'no-store') {
  res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': cache });
  res.end(bytes);
}

/** A string from the request: required and trimmed. */
/** decodeURIComponent without throwing: invalid %-encoding in the address → null (otherwise the process crashes). */
export function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function str(v: unknown, field: string, max = 200): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) fail(400, `Нет поля ${field}`);
  if (s.length > max) fail(400, `Поле ${field} длиннее ${max}`);
  return s;
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function email(v: unknown): string {
  const e = str(v, 'email', 254).toLowerCase();
  if (!EMAIL.test(e)) fail(400, 'Неверный адрес почты');
  return e;
}

/** Forward a voice signal to the recipient: from is the sender's presence (cannot be spoofed). */
export function relaySignal(clients: Iterable<[{ readyState: number; OPEN: number; send(d: Uint8Array): void }, string | null]>, from: string | null, bytes: Uint8Array) {
  if (!from) return;
  let msg: { to?: string };
  try {
    msg = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
  } catch {
    return;
  }
  if (!msg.to || typeof msg.to !== 'string' || bytes.length > 64 * 1024) return;
  const body = new TextEncoder().encode(JSON.stringify({ ...msg, from }));
  const out = new Uint8Array(body.length + 1);
  out[0] = bytes[0]!;
  out.set(body, 1);
  for (const [ws, id] of clients) if (id === msg.to && ws.readyState === ws.OPEN) ws.send(out);
}
