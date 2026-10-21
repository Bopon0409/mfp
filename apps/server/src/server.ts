// MFP server: accounts, teams, projects, files with permissions (REST — api.ts, live —
// live.ts) and collaboration rooms without accounts (below).
//
// The client connects to ws://host:port/room/<name>. The server is itself a Loro participant: it holds
// the room document, receives updates, broadcasts them to the others and saves the room to disk
// (<folder>/<name>.loro). Presence (cursors, names) is only relayed.
//
// Messages are binary, the first byte is the type: 1 — snapshot (server → client on join),
// 2 — Loro update, 3 — presence (JSON).
//
// Images go over HTTP: GET/HEAD/PUT /image/<sha1>. The key is the SHA-1 of the content (as in the document),
// and the server verifies it; each image is stored once for everyone (storage, key images/<sha1>).
//
// Self-host: staticDir — the built editor (apps/editor/dist) is served from the same address;
// /health — liveness check (Docker).

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { LoroDoc } from 'loro-crdt';
import { registerApi } from './api.ts';
import { registerUsersAdmin, setupCode } from './users-admin.ts';
import { updatesHandler } from './updates.ts';
import { registerBranches } from './branches.ts';
import { registerComments } from './comments.ts';
import { registerLibraries } from './libraries.ts';
import { Hooks, registerHooks, type HookOptions } from './hooks.ts';
import { registerPublicApi } from './public-api.ts';
import type { ApiDeps } from './api.ts';
import { Auth } from './auth.ts';
import type { BetaOptions } from './beta.ts';
import { migrate, openSqlite, type Db } from './db.ts';
import { LiveFiles } from './live.ts';
import { relaySignal } from './util.ts';
import { Router } from './router.ts';
import { OAuth, mcpChallenge } from './oauth.ts';
import { IMAGING_HEADERS, imagingProxy } from './imaging-proxy.ts';
import { devMailer, fsStore, safeDecode, type BlobStore, type Mailer } from './util.ts';
import { ImageVariants, IMAGE_SIZES } from './image-variants.ts';

export const SNAPSHOT = 1;
export const UPDATE = 2;
export const PRESENCE = 3;
/** Voice signaling (WebRTC): JSON { to, … } — the server sets from and sends only to the recipient. */
export const SIGNAL = 7;
/** The largest image we accept. */
const MAX_IMAGE = 64 * 2 ** 20;

interface Client {
  /** Participant id from their presence messages. */
  id: string | null;
  /** Answered the last ping: the connection is alive. */
  alive: boolean;
  /** Latest presence — a newcomer immediately sees the others' cursors. */
  presence: Uint8Array | null;
}

interface Room {
  id: string;
  doc: LoroDoc;
  clients: Map<WebSocket, Client>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ServerOptions {
  beta?: BetaOptions;
  /** 0 — any free port. */
  port?: number;
  /** Data folder: rooms, images, database (mfp.db), file documents. */
  dir?: string;
  /** How often to check whether connections are alive. */
  pingMs?: number;
  /** Database (by default — SQLite in the data folder). */
  db?: Db;
  /** Byte storage (by default — the data folder). */
  store?: BlobStore;
  /** Mail (by default — to the log and <folder>/outbox.jsonl). */
  mailer?: Mailer;
  /** Editor address for links in emails. */
  appUrl?: string;
  /** Webhooks and integrations: internal network, retry delays. */
  hooks?: HookOptions;
  /** Built editor (self-host): served from the same address. */
  staticDir?: string;
  /** Enable Enterprise modules (ee/): SSO, SCIM, audit. */
  enterprise?: (router: Router, deps: ApiDeps) => void | Promise<void>;
  /** Voice: STUN / TURN servers for participants (without them — local network only). */
  iceServers?: unknown[];
  /** off — closed network: this server's editors do not go online (MFP_NETWORK=off). */
  network?: 'on' | 'off';
  /** Address to listen on (HOST): all by default; 127.0.0.1 — this computer only. */
  host?: string;
  /** password — login-and-password sign-in (MFP_AUTH=password): a company server without mail or SSO. */
  auth?: 'email' | 'password';
}


export interface RunningServer {
  port: number;
  /** How many rooms to keep in memory (a room without participants is saved and unloaded). */
  readonly rooms: number;
  /** How many files are open live. */
  readonly files: number;
  db: Db;
  auth: Auth;
  live: LiveFiles;
  /** First-setup code (password sign-in, no accounts yet); null — not needed. */
  readonly setupCode: string | null;
  close(): Promise<void>;
}

const frame = (type: number, data: Uint8Array) => {
  const out = new Uint8Array(data.length + 1);
  out[0] = type;
  out.set(data, 1);
  return out;
};

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const dir = opts.dir ?? 'rooms';
  mkdirSync(`${dir}/images`, { recursive: true });
  const rooms = new Map<string, Room>();
  let closing = false;
  // Accounts, teams and files.
  const db = opts.db ?? openSqlite(join(dir, 'mfp.db'));
  await migrate(db);
  const store = opts.store ?? fsStore(dir);
  const variants = new ImageVariants(store);
  const mailer = opts.mailer ?? (opts.beta?.auth === 'password' ? { send: async () => {} } : devMailer(join(dir, 'outbox.jsonl')));
  const auth = new Auth(db, mailer, opts.beta, { password: !opts.beta && opts.auth === 'password' });
  const live = new LiveFiles(db, store, auth);
  const router = new Router(auth);
  const deps: ApiDeps = { db, auth, store, live, mailer, appUrl: opts.appUrl ?? 'http://localhost:5174/', policy: { network: opts.network ?? 'on' } };
  // Password sign-in with no accounts yet: first-setup code (printed by main.ts).
  deps.setup = { code: !opts.beta && auth.passwordMode && !(await db.get('SELECT id FROM users LIMIT 1')) ? setupCode() : null };
  const hooks = new Hooks(deps, opts.hooks);
  deps.events = hooks;
  registerApi(router, deps);
  registerComments(router, deps);
  registerUsersAdmin(router, deps);
  registerBranches(router, deps);
  registerLibraries(router, deps);
  registerHooks(router, deps, hooks);
  const mcp = registerPublicApi(router, deps);
  // OAuth for MCP clients (Claude.ai, ChatGPT): metadata, registration, code, token.
  // The confirmation page is in the editor: our own address, otherwise (editor served separately, as in development) — appUrl by default.
  const oauth = new OAuth({ db, auth, appUrl: opts.appUrl ?? (opts.staticDir ? undefined : deps.appUrl) });
  await opts.enterprise?.(router, deps);

  const room = (id: string): Room => {
    let r = rooms.get(id);
    if (!r) {
      const doc = new LoroDoc();
      const file = `${dir}/${id}.loro`;
      if (existsSync(file)) doc.import(new Uint8Array(readFileSync(file)));
      r = { id, doc, clients: new Map(), timer: null };
      rooms.set(id, r);
    }
    return r;
  };

  const save = (r: Room) => {
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    try {
      writeFileSync(`${dir}/${r.id}.loro.tmp`, r.doc.export({ mode: 'snapshot' }));
      renameSync(`${dir}/${r.id}.loro.tmp`, `${dir}/${r.id}.loro`);
    } catch (e) {
      // Disk unavailable: the room stays in memory; we will retry on the next edit.
      console.error(`Комната ${r.id}: не удалось сохранить`, e);
    }
  };

  /** Save a room at most once every 2 s. */
  const scheduleSave = (r: Room) => {
    r.timer ??= setTimeout(() => save(r), 2000);
  };

  const broadcast = (r: Room, from: WebSocket, bytes: Uint8Array) => {
    for (const c of r.clients.keys()) if (c !== from && c.readyState === c.OPEN) c.send(bytes);
  };

  /** Images: the editor is opened from another address (port), hence the CORS headers. */
  const images = async (req: IncomingMessage, res: ServerResponse, hash: string) => {
    const key = `images/${hash}`;
    if (req.method === 'HEAD') {
      res.writeHead((await store.has(key)) ? 200 : 404).end();
      return;
    }
    if (req.method === 'GET') {
      const sizeArg = new URL(req.url ?? '/', 'http://x').searchParams.get('size');
      if (sizeArg !== null) {
        const size = Number(sizeArg);
        if (!IMAGE_SIZES.includes(size)) { res.writeHead(400).end('Invalid image size'); return; }
        const preview = await variants.get(hash, size);
        if (preview) {
          res.writeHead(200, { 'content-type': 'image/webp', 'content-length': preview.length, 'vary': 'Authorization', 'cache-control': opts.beta ? 'private, max-age=86400' : 'public, max-age=31536000, immutable' });
          res.end(preview); return;
        }
      }
      const bytes = await store.get(key);
      if (!bytes) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'cache-control': opts.beta ? 'private, no-store' : 'public, max-age=31536000, immutable' });
      res.end(bytes);
      return;
    }
    if (req.method !== 'PUT') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_IMAGE) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.headersSent) return;
      const body = Buffer.concat(chunks);
      // The key must match the content: someone else's image cannot be swapped in under a known key.
      if (createHash('sha1').update(body).digest('hex') !== hash) {
        res.writeHead(400).end('hash mismatch');
        return;
      }
      try {
        if (!(await store.has(key))) await store.put(key, new Uint8Array(body));
        res.writeHead(201).end();
      } catch (e) {
        console.error('Картинка не сохранилась', e);
        res.writeHead(500).end();
      }
    });
  };

  /** Built editor: files as is, all other paths — index.html (addresses like /#file=…). */
  const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
  const serveStatic = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!opts.staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const root = resolve(opts.staticDir);
    const path = safeDecode(new URL(req.url ?? '/', 'http://x').pathname);
    if (path === null) return false;
    let file = resolve(root, normalize(`.${path}`));
    if (!file.startsWith(root + sep) && file !== root) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) return false;
    const immutable = path.startsWith('/assets/');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'x-content-type-options': 'nosniff', ...(extname(file) === '.html' ? { 'x-frame-options': 'SAMEORIGIN' } : {}) });
    res.end(req.method === 'GET' ? readFileSync(file) : undefined);
    return true;
  };

  const updates = updatesHandler(dir);
  let loginWindow = 0;
  let loginRequests = 0;
  const closed = !!opts.beta || auth.passwordMode;
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    // The editor is on another address (port); sign-in uses a token in a header, no cookie.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', `authorization, content-type, mcp-session-id, mcp-protocol-version, ${IMAGING_HEADERS}`);
    res.setHeader('access-control-expose-headers', 'mcp-session-id, x-library-version');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    // Closed server (beta or password sign-in — a company server, the office server in the app):
    // API, images, image proxy and TURN — only when signed in.
    if (closed) {
      const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/\/+$/, '');
      const login = path === '/api/auth/code' || path === '/api/auth/verify' || path === '/api/auth/password' || path === '/api/setup';
      // Global bound: independent of spoofable forwarded IP headers or email count.
      if (login) {
        if (Date.now() - loginWindow >= 60_000) { loginWindow = Date.now(); loginRequests = 0; }
        if (++loginRequests > 60) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }).end(JSON.stringify({ error: 'Слишком много попыток входа. Подождите минуту.' }));
          return;
        }
      } else if (path !== '/api/auth/config' && (/^\/(api|v1|mcp|scim|image)(\/|$)/.test(path) || path === '/ice')) {
        try {
          const header = req.headers.authorization;
          const p = await auth.principal(header?.startsWith('Bearer ') ? header.slice(7) : null);
          if (!p) {
            res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': mcpChallenge(req) }).end(JSON.stringify({ error: opts.beta ? 'Закрытая бета: войдите по приглашённой почте или передайте токен API (Authorization: Bearer mfp_…)' : 'Нужен вход: войдите или передайте токен API (Authorization: Bearer mfp_…)' }));
            return;
          }
        } catch {
          res.writeHead(503).end();
          return;
        }
      }
    }
    if ((req.url?.startsWith('/.well-known/') || req.url?.startsWith('/oauth/') || req.url?.startsWith('/api/oauth/')) && (await oauth.handle(req, res))) return;
    if (req.url?.startsWith('/api/imaging/') && (await imagingProxy(req, res))) return;
    // App updates need no sign-in: the app requests them itself (updates.ts).
    if (req.url?.startsWith('/updates/') && updates(req, res)) return;
    if ((req.url?.startsWith('/api/') || req.url?.startsWith('/v1/') || req.url?.startsWith('/mcp') || req.url?.startsWith('/scim/')) && (await router.handle(req, res))) return;
    if (req.url === '/ice') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(opts.iceServers ?? []));
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, db: db.dialect, rooms: rooms.size, files: live.open }));
      return;
    }
    const image = /^\/image\/([0-9a-f]{40})$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
    if (image) {
      void images(req, res, image[1]!).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
      return;
    }
    if (serveStatic(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`MFP: комнат ${rooms.size}, участников ${[...rooms.values()].reduce((n, r) => n + r.clients.size, 0)}, файлов открыто ${live.open}`);
  };
  // A handler error does not crash the server: respond 500 and write to the log.
  const http = createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      console.error('Запрос ' + req.method + ' ' + (req.url ?? '') + ': ошибка', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'Ошибка сервера' }));
      else res.destroy();
    });
  });

  const wss = new WebSocketServer({ server: http });
  wss.on('connection', async (ws, req) => {
    // Closed server: only team files with a token (no anonymous rooms).
    if (closed) {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        if (!url.pathname.startsWith('/file/') || !await auth.principal(url.searchParams.get('token'))) {
          ws.close(4403, 'Closed beta: sign in to open a file');
          return;
        }
        if (ws.readyState !== ws.OPEN) return;
      } catch {
        ws.close(1011, 'error');
        return;
      }
    }
    // Team files — with permissions.
    if (req.url?.startsWith('/file/')) {
      void live.connect(ws, req).catch((e) => {
        console.error('Файл: ошибка подключения', e);
        ws.close(1011, 'error');
      });
      return;
    }
    const name = safeDecode((req.url ?? '/').replace(/^\/room\//, '')) ?? '';
    const id = name.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 64) || 'default';
    const r = room(id);
    const me: Client = { id: null, alive: true, presence: null };
    ws.on('pong', () => (me.alive = true));
    r.clients.set(ws, me);
    ws.send(frame(SNAPSHOT, r.doc.export({ mode: 'snapshot' })));
    for (const c of r.clients.values()) if (c.presence) ws.send(c.presence);
    ws.on('message', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      if (bytes[0] === UPDATE) {
        try {
          r.doc.import(bytes.subarray(1));
        } catch (e) {
          console.error(`Комната ${id}: плохое обновление`, e);
          return;
        }
        broadcast(r, ws, bytes);
        scheduleSave(r);
      } else if (bytes[0] === PRESENCE) {
        // Remember who this is, so we can notify the others when they leave.
        try {
          const p = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { id?: string; leave?: boolean };
          if (p.id) me.id = p.id;
          me.presence = p.leave ? null : bytes;
        } catch {
          return;
        }
        broadcast(r, ws, bytes);
      } else if (bytes[0] === SIGNAL) {
        relaySignal([...r.clients].map(([w, c]) => [w, c.id] as [typeof w, string | null]), me.id, bytes);
      }
    });
    ws.on('close', () => {
      if (closing) return;
      r.clients.delete(ws);
      if (me.id) broadcast(r, ws, frame(PRESENCE, new TextEncoder().encode(JSON.stringify({ id: me.id, leave: true }))));
      // The last one left: save the room and unload it from memory.
      if (r.clients.size === 0 && rooms.get(id) === r) {
        save(r);
        rooms.delete(id);
      }
    });
  });

  // Broken connections (laptop sleep, lost network) do not close on their own right away: we ping,
  // and whoever has not answered since the last time is disconnected (the others get a participant-left event).
  const ping = setInterval(() => {
    for (const r of rooms.values()) {
      for (const [ws, c] of r.clients) {
        if (!c.alive) {
          ws.terminate();
          continue;
        }
        c.alive = false;
        ws.ping();
      }
    }
    live.ping();
  }, opts.pingMs ?? 20_000);
  ping.unref();

  return new Promise((resolve) => {
    http.listen(opts.port ?? 5175, opts.host, () => {
      resolve({
        port: (http.address() as AddressInfo).port,
        get rooms() {
          return rooms.size;
        },
        get files() {
          return live.open;
        },
        get setupCode() {
          return deps.setup?.code ?? null;
        },
        db,
        auth,
        live,
        close: () =>
          new Promise<void>((done, reject) => {
            closing = true;
            clearInterval(ping);
            for (const r of rooms.values()) if (r.timer) save(r);
            hooks.close();
            mcp.close();
            void live.close().then(async () => {
              for (const c of wss.clients) c.terminate();
              wss.close();
              await db.close();
              http.close(() => done());
            }).catch(reject);
          }),
      });
    });
  });
}
