// OAuth 2.1 for MCP clients (MCP authorization 2025-06-18): Claude.ai, ChatGPT and others connect
// to MFP without a manual token.
// - /.well-known/oauth-protected-resource (RFC 9728) — where tokens for /mcp are issued;
// - /.well-known/oauth-authorization-server (RFC 8414) — sign-in, token and registration endpoints;
// - POST /oauth/register (RFC 7591) — the client registers itself;
// - /oauth/authorize — the “Allow access” page in the editor itself (it knows who is signed in);
//   the editor confirms via POST /api/oauth/approve and gets the redirect address with the code;
// - POST /oauth/token — code (single-use, 10 minutes, PKCE S256) → the user's API token
//   (“AI: <client>”, visible and revocable in “API tokens”).

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Auth } from './auth.ts';
import type { Db } from './db.ts';
import { HttpError, newSecret, readBody, sendJson } from './util.ts';

const CODE_TTL = 10 * 60_000;
const MAX_URIS = 10;
// Registrations per minute for the whole server — protects the clients table from flooding.
const REGISTER_PER_MINUTE = 30;

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  userId: string;
  expires: number;
}

export interface OAuthDeps {
  db: Db;
  auth: Auth;
  /** Editor address (the confirmation page); if absent — the same address as the server. */
  appUrl?: string;
}

/** Server address as the client sees it (behind a proxy — from X-Forwarded-*). */
export function publicBase(req: IncomingMessage): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim() || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

/** 401 header for /mcp: where to get the OAuth metadata. */
export const mcpChallenge = (req: IncomingMessage) => `Bearer realm="mfp", resource_metadata="${publicBase(req)}/.well-known/oauth-protected-resource"`;

/** Allowed redirect address: https or local http (Claude Code, MCP Inspector). */
export function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 2000) return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export class OAuth {
  private codes = new Map<string, Code>();
  private regWindow = 0;
  private regCount = 0;
  private d: OAuthDeps;

  constructor(d: OAuthDeps) {
    this.d = d;
  }

  /** Handle an OAuth request (true — handled). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
        const base = publicBase(req);
        sendJson(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: 'MFP' });
        return true;
      }
      if (req.method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp' || path === '/.well-known/openid-configuration')) {
        const base = publicBase(req);
        sendJson(res, 200, {
          issuer: base,
          authorization_endpoint: `${this.appBase(base)}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['mcp'],
        });
        return true;
      }
      if (path.startsWith('/.well-known/oauth-')) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      if (req.method === 'POST' && path === '/oauth/register') {
        await this.register(req, res);
        return true;
      }
      if (req.method === 'POST' && path === '/oauth/token') {
        await this.token(req, res);
        return true;
      }
      if (req.method === 'GET' && path === '/api/oauth/client') {
        await this.client(req, res, url);
        return true;
      }
      if (req.method === 'POST' && path === '/api/oauth/approve') {
        await this.approve(req, res);
        return true;
      }
      // The confirmation page lives in the editor; if the server and editor are on different addresses — go there.
      if (req.method === 'GET' && path === '/oauth/authorize' && this.d.appUrl) {
        const app = this.appBase(publicBase(req));
        if (app !== publicBase(req)) {
          res.writeHead(302, { location: `${app}/oauth/authorize${url.search}` }).end();
          return true;
        }
      }
    } catch (e) {
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.status === 401 ? 'invalid_token' : 'invalid_request', error_description: e.message });
      else sendJson(res, 500, { error: 'server_error' });
      return true;
    }
    return false;
  }

  private appBase(base: string) {
    return (this.d.appUrl ?? base).replace(/\/+$/, '').replace(/#.*$/, '');
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const text = new TextDecoder().decode(await readBody(req, 64 * 1024));
    if (!text) return {};
    if (String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return Object.fromEntries(new URLSearchParams(text));
    }
  }

  private async register(req: IncomingMessage, res: ServerResponse) {
    if (Date.now() - this.regWindow >= 60_000) {
      this.regWindow = Date.now();
      this.regCount = 0;
    }
    if (++this.regCount > REGISTER_PER_MINUTE) {
      sendJson(res, 429, { error: 'temporarily_unavailable', error_description: 'Слишком много регистраций — подождите минуту' });
      return;
    }
    const b = await this.body(req);
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || uris.length > MAX_URIS || !uris.every(validRedirect)) {
      sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'Нужны адреса возврата https (или http://localhost)' });
      return;
    }
    const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 80) : 'Клиент MCP';
    const clientId = `mfpc_${newSecret()}`;
    const created = Date.now();
    await this.d.db.run(`INSERT INTO oauth_clients (client_id, name, redirect_uris, created) VALUES (?, ?, ?, ?)`, [clientId, name, JSON.stringify(uris), created]);
    sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(created / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  private async clientRow(clientId: unknown) {
    if (typeof clientId !== 'string' || !clientId) return null;
    const row = await this.d.db.get<{ client_id: string; name: string; redirect_uris: string }>(`SELECT client_id, name, redirect_uris FROM oauth_clients WHERE client_id = ?`, [clientId]);
    return row ? { id: row.client_id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[] } : null;
  }

  /** The signed-in editor user (session, not an API token). */
  private async user(req: IncomingMessage) {
    const header = req.headers.authorization;
    const p = await this.d.auth.principal(header?.startsWith('Bearer ') ? header.slice(7) : null);
    if (!p || p.kind !== 'session') throw new HttpError(401, 'Войдите в MFP');
    return p;
  }

  /** For the confirmation page: who requests access and where it will redirect. */
  private async client(req: IncomingMessage, res: ServerResponse, url: URL) {
    await this.user(req);
    const c = await this.clientRow(url.searchParams.get('client_id'));
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    if (!c || !c.redirectUris.includes(redirect)) {
      sendJson(res, 400, { error: 'invalid_client', error_description: 'Неизвестное приложение или адрес возврата' });
      return;
    }
    sendJson(res, 200, { name: c.name, host: new URL(redirect).host });
  }

  /** The user approved: single-use code → the client's redirect address. */
  private async approve(req: IncomingMessage, res: ServerResponse) {
    const p = await this.user(req);
    const b = await this.body(req);
    const c = await this.clientRow(b.client_id);
    const redirect = String(b.redirect_uri ?? '');
    if (!c || !c.redirectUris.includes(redirect)) {
      sendJson(res, 400, { error: 'invalid_client', error_description: 'Неизвестное приложение или адрес возврата' });
      return;
    }
    const back = new URL(redirect);
    if (typeof b.state === 'string') back.searchParams.set('state', b.state);
    if (b.response_type !== 'code' || b.code_challenge_method !== 'S256' || typeof b.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(b.code_challenge)) {
      back.searchParams.set('error', 'invalid_request');
      back.searchParams.set('error_description', 'Нужны response_type=code и PKCE (S256)');
      sendJson(res, 200, { redirect: back.toString() });
      return;
    }
    if (b.deny === true) {
      back.searchParams.set('error', 'access_denied');
      sendJson(res, 200, { redirect: back.toString() });
      return;
    }
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expires < now) this.codes.delete(k);
    const code = newSecret();
    this.codes.set(code, { clientId: c.id, redirectUri: redirect, challenge: b.code_challenge, userId: p.user.id, expires: now + CODE_TTL });
    back.searchParams.set('code', code);
    sendJson(res, 200, { redirect: back.toString() });
  }

  private async token(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('cache-control', 'no-store');
    const b = await this.body(req);
    const err = (error: string, description: string) => sendJson(res, 400, { error, error_description: description });
    if (b.grant_type !== 'authorization_code') return err('unsupported_grant_type', 'Поддерживается authorization_code');
    const code = typeof b.code === 'string' ? this.codes.get(b.code) : undefined;
    if (code) this.codes.delete(b.code as string);
    if (!code || code.expires < Date.now()) return err('invalid_grant', 'Код неверный или устарел');
    if (b.client_id !== undefined && b.client_id !== code.clientId) return err('invalid_grant', 'Код выдан другому приложению');
    if (b.redirect_uri !== code.redirectUri) return err('invalid_grant', 'Адрес возврата не совпадает');
    if (typeof b.code_verifier !== 'string' || s256(b.code_verifier) !== code.challenge) return err('invalid_grant', 'Проверка PKCE не прошла');
    const c = await this.clientRow(code.clientId);
    const token = await this.d.auth.newSession(code.userId, 'api', `ИИ: ${c?.name ?? 'клиент MCP'}`);
    sendJson(res, 200, { access_token: token, token_type: 'Bearer', scope: 'mcp' });
  }
}
