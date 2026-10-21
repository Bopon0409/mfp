// Sign-in via the company's SSO (Enterprise): OpenID Connect — Okta, Keycloak, Azure AD (Entra ID),
// Google Workspace, Yandex 360, etc. Authorization code + PKCE flow; the id_token is verified
// right here: signature against the provider's keys (JWKS, RS256 / PS256 / ES256 — node:crypto), issuer,
// audience, expiry, nonce. The email from the token maps to an MFP account (created if missing). Company
// domains (OIDC_DOMAINS) sign in only via SSO: email codes are disabled for them.

import { constants, createHash, createPublicKey, randomBytes, verify, type JsonWebKeyInput, type KeyObject } from 'node:crypto';
import type { ApiDeps } from '../apps/server/src/api.ts';
import type { Ctx, Router } from '../apps/server/src/router.ts';
import { fail } from '../apps/server/src/util.ts';
import type { AuditLog } from './audit.ts';

export interface OidcOptions {
  /** Issuer: https://company.okta.com, https://keycloak/realms/x … */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Sign-in button label: “Sign in with Okta”. */
  name?: string;
  /** Company email domains: SSO only for them. */
  domains?: string[];
  /** Public server address (for redirect_uri); if absent — from the Host header. */
  publicUrl?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function registerOidc(r: Router, d: ApiDeps, o: OidcOptions, audit?: AuditLog) {
  const issuer = o.issuer.replace(/\/+$/, '');
  const domains = (o.domains ?? []).map((x) => x.toLowerCase().replace(/^@/, ''));
  let discovery: Promise<Discovery> | null = null;
  let keys = new Map<string, KeyObject>();
  let keysAt = 0;
  /** Sign-ins in progress: state → data (10 minutes). */
  const pending = new Map<string, { verifier: string; nonce: string; redirect: string; at: number }>();

  const discover = () =>
    (discovery ??= fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
      .then(async (res) => {
        if (!res.ok) throw new Error(`OIDC: discovery ${res.status}`);
        const j = (await res.json()) as Discovery;
        if (j.issuer.replace(/\/+$/, '') !== issuer) throw new Error('OIDC: издатель в discovery не совпадает');
        return j;
      })
      .catch((e) => {
        discovery = null;
        throw e;
      }));

  /** Signing key by kid (a new kid — re-fetch JWKS, but at most once a minute). */
  const keyFor = async (kid: string | undefined): Promise<KeyObject> => {
    const pick = () => (kid ? keys.get(kid) : keys.size === 1 ? [...keys.values()][0] : undefined);
    let k = pick();
    if (!k && Date.now() - keysAt > 60_000) {
      const disc = await discover();
      const res = await fetch(disc.jwks_uri, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`OIDC: JWKS ${res.status}`);
      const jwks = (await res.json()) as { keys: (JsonWebKeyInput['key'] & { kid?: string; use?: string })[] };
      keys = new Map(jwks.keys.filter((x) => !x.use || x.use === 'sig').map((x, i) => [x.kid ?? `#${i}`, createPublicKey({ key: x, format: 'jwk' })]));
      keysAt = Date.now();
      k = pick();
    }
    if (!k) throw new Error('OIDC: нет ключа подписи токена');
    return k;
  };

  /** Verify the id_token: signature, issuer, audience, expiry, nonce. Return the claims. */
  const verifyIdToken = async (token: string, nonce: string): Promise<Record<string, unknown>> => {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) throw new Error('OIDC: id_token не JWT');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    const key = await keyFor(header.kid);
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, 'base64url');
    const ok =
      header.alg === 'RS256'
        ? verify('sha256', data, key, sig)
        : header.alg === 'PS256'
          ? verify('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig)
          : header.alg === 'ES256'
            ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
            : false;
    if (!ok) throw new Error(`OIDC: подпись id_token не сходится (${header.alg})`);
    const now = Date.now() / 1000;
    if (String(claims.iss).replace(/\/+$/, '') !== issuer) throw new Error('OIDC: чужой издатель');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(o.clientId)) throw new Error('OIDC: токен не для MFP (aud)');
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('OIDC: токен просрочен');
    if (typeof claims.iat === 'number' && claims.iat > now + 300) throw new Error('OIDC: токен из будущего');
    if (claims.nonce !== nonce) throw new Error('OIDC: nonce не совпадает');
    return claims;
  };

  const base = (c: Ctx) => (o.publicUrl ?? `${(c.req.headers['x-forwarded-proto'] as string) ?? 'http'}://${c.req.headers.host}`).replace(/\/+$/, '');
  /** Redirect only to this server's editor (no open redirect). */
  const safeRedirect = (c: Ctx, v: string | null): string => {
    const fallback = d.appUrl;
    if (!v) return fallback;
    try {
      const u = new URL(v);
      const allowed = [new URL(d.appUrl).origin, new URL(base(c)).origin];
      return allowed.includes(u.origin) ? `${u.origin}${u.pathname}${u.search}` : fallback;
    } catch {
      return fallback;
    }
  };

  // Company domains — no email codes.
  if (domains.length) d.auth.codePolicy = (email) => (domains.includes(email.split('@')[1] ?? '') ? `Почта домена ${email.split('@')[1]} входит через SSO компании` : null);

  r.add('GET', '/api/sso/config', async () => ({ enabled: true, name: o.name ?? 'Войти через SSO', domains }));

  r.add('GET', '/api/sso/start', async (c) => {
    const disc = await discover().catch((e: Error) => fail(502, e.message));
    for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    pending.set(state, { verifier, nonce, redirect: safeRedirect(c, c.query.get('redirect')), at: Date.now() });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: o.clientId,
      redirect_uri: `${base(c)}/api/sso/callback`,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    const hint = c.query.get('email');
    if (hint) q.set('login_hint', hint);
    c.res.writeHead(302, { location: `${disc.authorization_endpoint}?${q}`, 'cache-control': 'no-store' }).end();
  });

  r.add('GET', '/api/sso/callback', async (c) => {
    const state = c.query.get('state') ?? '';
    const p = pending.get(state);
    pending.delete(state);
    const back = (hash: string) => c.res.writeHead(302, { location: `${p?.redirect ?? d.appUrl}#${hash}`, 'cache-control': 'no-store' }).end();
    if (!p || Date.now() - p.at > 600_000) return back(`sso_error=${encodeURIComponent('Вход устарел — начните заново')}`);
    if (c.query.get('error')) return back(`sso_error=${encodeURIComponent(c.query.get('error_description') ?? c.query.get('error')!)}`);
    try {
      const disc = await discover();
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: c.query.get('code') ?? '', redirect_uri: `${base(c)}/api/sso/callback`, code_verifier: p.verifier, client_id: o.clientId });
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      if (o.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString('base64')}`;
      const res = await fetch(disc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`OIDC: обмен кода ${res.status}`);
      const tokens = (await res.json()) as { id_token?: string };
      if (!tokens.id_token) throw new Error('OIDC: нет id_token');
      const claims = await verifyIdToken(tokens.id_token, p.nonce);
      const email = String(claims.email ?? '').toLowerCase();
      if (!email || claims.email_verified === false) throw new Error('OIDC: у учётной записи нет подтверждённой почты');
      if (domains.length && !domains.includes(email.split('@')[1] ?? '')) throw new Error(`OIDC: почта ${email} — не из доменов компании`);
      const name = typeof claims.name === 'string' ? claims.name : typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined;
      const user = await d.auth.ensureUser(email, name);
      if (user.disabled) throw new Error('Учётная запись отключена');
      if (typeof claims.sub === 'string' && !user.external_id) await d.db.run(`UPDATE users SET external_id = ? WHERE id = ?`, [`oidc:${claims.sub}`, user.id]);
      const token = await d.auth.newSession(user.id);
      audit?.write({ action: 'login.sso', userId: user.id, email, ip: c.req.socket.remoteAddress ?? '', userAgent: String(c.req.headers['user-agent'] ?? ''), details: { issuer } });
      back(`sso=${token}`);
    } catch (e) {
      audit?.write({ action: 'login.sso.failed', details: { error: (e as Error).message }, ip: c.req.socket.remoteAddress ?? '', status: 401 });
      back(`sso_error=${encodeURIComponent((e as Error).message)}`);
    }
  });
}
