// REST routes: method and path template (/api/files/:id); the handler returns a JSON response
// (or writes the response itself — then undefined). HttpError errors use their code, others — 500.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Auth, Principal } from './auth.ts';
import { fail, HttpError, safeDecode, sendJson } from './util.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  principal: Principal | null;
  /** The signed-in user (otherwise 401). */
  need(): Principal;
}

type Handler = (ctx: Ctx) => Promise<unknown>;

/** Handled request (audit log, ee/audit.ts). */
export interface RequestInfo {
  method: string;
  pattern: string;
  params: Record<string, string>;
  principal: Principal | null;
  status: number;
  /** Handler response (if JSON). */
  result: unknown;
  ip: string;
  userAgent: string;
}

export class Router {
  private routes: { method: string; pattern: string; re: RegExp; keys: string[]; fn: Handler }[] = [];
  private auth: Auth;
  /** After each handled request. */
  onDone: ((info: RequestInfo) => void)[] = [];

  constructor(auth: Auth) {
    this.auth = auth;
  }

  add(method: string, pattern: string, fn: Handler) {
    const keys: string[] = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ method, pattern, re, keys, fn });
  }

  /** Handle a request (false — no route). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params: Record<string, string> = {};
      let bad = false;
      r.keys.forEach((k, i) => {
        const v = safeDecode(m[i + 1]!);
        if (v === null) bad = true;
        else params[k] = v;
      });
      if (bad) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'Неверный адрес' }));
        return true;
      }
      let principal: Principal | null = null;
      let result: unknown = undefined;
      try {
        const header = req.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
        principal = await this.auth.principal(token);
        const p = principal;
        const ctx: Ctx = {
          req,
          res,
          params,
          query: url.searchParams,
          principal,
          need: () => p ?? fail(401, 'Нужно войти'),
        };
        result = await r.fn(ctx);
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      } catch (e) {
        if (!res.headersSent) {
          if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
          else {
            console.error(`${req.method} ${path}:`, e);
            sendJson(res, 500, { error: 'Ошибка сервера' });
          }
        }
      }
      if (this.onDone.length) {
        const info: RequestInfo = {
          method: r.method,
          pattern: r.pattern,
          params,
          principal,
          status: res.statusCode,
          result,
          ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || '',
          userAgent: String(req.headers['user-agent'] ?? ''),
        };
        for (const cb of this.onDone) {
          try {
            cb(info);
          } catch (err) {
            console.error('Журнал запросов:', err);
          }
        }
      }
      return true;
    }
    if (pathMatched) {
      sendJson(res, 405, { error: 'Метод не поддерживается' });
      return true;
    }
    return false;
  }
}
