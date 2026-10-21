// SCIM 2.0 (Enterprise): the company directory (Okta, Azure AD / Entra ID, Keycloak…) itself creates
// and disables users and manages groups — SCIM groups are MFP teams here. The directory authenticates
// with a token (SCIM_TOKEN). Disabling a user: the account is turned off, its sessions and tokens
// are deleted (data and authorship remain).

import { timingSafeEqual } from 'node:crypto';
import type { ApiDeps } from '../apps/server/src/api.ts';
import type { User } from '../apps/server/src/auth.ts';
import type { Ctx, Router } from '../apps/server/src/router.ts';
import { HttpError, newId, readBody } from '../apps/server/src/util.ts';
import type { AuditLog } from './audit.ts';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';


type ScimUser = {
  userName?: string;
  externalId?: string;
  displayName?: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails?: { value: string; primary?: boolean }[];
  active?: boolean;
};

export function registerScim(r: Router, d: ApiDeps, token: string, audit?: AuditLog) {
  const { db } = d;
  const send = (c: Ctx, status: number, body: unknown) => {
    c.res.writeHead(status, { 'content-type': 'application/scim+json; charset=utf-8' });
    c.res.end(body === null ? undefined : JSON.stringify(body));
  };
  /** SCIM handler: directory token, errors in SCIM format. */
  const route = (method: string, path: string, fn: (c: Ctx, base: string) => Promise<[number, unknown]>) =>
    r.add(method, `/scim/v2${path}`, async (c) => {
      const got = Buffer.from((c.req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const want = Buffer.from(token);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return send(c, 401, { schemas: [ERROR], status: '401', detail: 'Нужен токен SCIM' });
      const base = `${(c.req.headers['x-forwarded-proto'] as string) ?? 'http'}://${c.req.headers.host}/scim/v2`;
      try {
        const [status, body] = await fn(c, base);
        send(c, status, body);
        if (method !== 'GET') audit?.write({ action: `scim.${method.toLowerCase()} ${path}`, target: c.params.id ?? null, ip: c.req.socket.remoteAddress ?? '', status });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error('SCIM:', e);
        send(c, status, { schemas: [ERROR], status: String(status), detail: e instanceof Error ? e.message : String(e) });
      }
    });
  const body = async (c: Ctx) => JSON.parse(new TextDecoder().decode(await readBody(c.req, 1 << 20)) || '{}');
  const notFound = () => {
    throw new HttpError(404, 'Нет такого ресурса');
  };

  // ---------- Users ----------

  const userView = (u: User, base: string) => ({
    schemas: [USER],
    id: u.id,
    externalId: u.external_id?.replace(/^scim:/, '') ?? undefined,
    userName: u.email,
    displayName: u.name,
    name: { formatted: u.name },
    emails: [{ value: u.email, primary: true, type: 'work' }],
    active: !u.disabled,
    meta: { resourceType: 'User', created: new Date(u.created).toISOString(), location: `${base}/Users/${u.id}` },
  });
  const emailOf = (b: ScimUser) => (b.emails?.find((e) => e.primary)?.value ?? b.emails?.[0]?.value ?? b.userName ?? '').trim().toLowerCase();
  const nameOf = (b: ScimUser) => b.displayName ?? b.name?.formatted ?? ([b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ') || undefined);
  const userById = async (id: string) => (await db.get<User>(`SELECT * FROM users WHERE id = ?`, [id])) ?? notFound();
  /** Disable: turn off and revoke all sign-ins. */
  const setActive = async (u: User, active: boolean) => {
    await db.run(`UPDATE users SET disabled = ? WHERE id = ?`, [active ? 0 : 1, u.id]);
    if (!active) await db.run(`DELETE FROM sessions WHERE user_id = ?`, [u.id]);
  };

  route('GET', '/Users', async (c, base) => {
    const filter = c.query.get('filter') ?? '';
    const start = Math.max(1, Number(c.query.get('startIndex') ?? 1));
    const count = Math.min(200, Math.max(0, Number(c.query.get('count') ?? 100)));
    let rows: User[];
    const m = /^\s*(userName|externalId|emails(?:\.value)?)\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
    if (m) rows = m[1]!.toLowerCase() === 'externalid' ? await db.all<User>(`SELECT * FROM users WHERE external_id = ?`, [`scim:${m[2]}`]) : await db.all<User>(`SELECT * FROM users WHERE email = ?`, [m[2]!.toLowerCase()]);
    else if (filter) throw new HttpError(400, 'Поддерживаются фильтры userName, externalId, emails eq "…"');
    else rows = await db.all<User>(`SELECT * FROM users ORDER BY created`);
    return [200, { schemas: [LIST], totalResults: rows.length, startIndex: start, itemsPerPage: Math.min(count, Math.max(0, rows.length - start + 1)), Resources: rows.slice(start - 1, start - 1 + count).map((u) => userView(u, base)) }];
  });

  route('GET', '/Users/:id', async (c, base) => [200, userView(await userById(c.params.id!), base)]);

  route('POST', '/Users', async (c, base) => {
    const b = (await body(c)) as ScimUser;
    const email = emailOf(b);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Нужна почта (userName или emails)');
    if (await d.auth.byEmail(email)) throw new HttpError(409, `Пользователь ${email} уже есть`);
    const u = await d.auth.ensureUser(email, nameOf(b));
    if (b.externalId) await db.run(`UPDATE users SET external_id = ? WHERE id = ?`, [`scim:${b.externalId}`, u.id]);
    if (b.active === false) await setActive(u, false);
    return [201, userView(await userById(u.id), base)];
  });

  route('PUT', '/Users/:id', async (c, base) => {
    const u = await userById(c.params.id!);
    const b = (await body(c)) as ScimUser;
    const name = nameOf(b);
    if (name) await db.run(`UPDATE users SET name = ? WHERE id = ?`, [name.slice(0, 80), u.id]);
    if (b.externalId) await db.run(`UPDATE users SET external_id = ? WHERE id = ?`, [`scim:${b.externalId}`, u.id]);
    if (b.active !== undefined) await setActive(u, b.active);
    return [200, userView(await userById(u.id), base)];
  });

  route('PATCH', '/Users/:id', async (c, base) => {
    const u = await userById(c.params.id!);
    const b = (await body(c)) as { Operations?: { op: string; path?: string; value?: unknown }[] };
    for (const op of b.Operations ?? []) {
      if (!/^(replace|add)$/i.test(op.op)) continue;
      // value — an object of fields or a single value at path.
      const fields = (op.path ? { [op.path]: op.value } : op.value) as Record<string, unknown>;
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (k === 'active') await setActive(u, v === true || v === 'True' || v === 'true');
        else if (k === 'displayName' || k === 'name.formatted') await db.run(`UPDATE users SET name = ? WHERE id = ?`, [String(v).slice(0, 80), u.id]);
        else if (k === 'externalId') await db.run(`UPDATE users SET external_id = ? WHERE id = ?`, [`scim:${String(v)}`, u.id]);
      }
    }
    return [200, userView(await userById(u.id), base)];
  });

  /** Deletion from the directory means disabling (files and authorship remain). */
  route('DELETE', '/Users/:id', async (c) => {
    await setActive(await userById(c.params.id!), false);
    return [204, null];
  });

  // ---------- Groups = teams ----------

  const groupView = async (t: { id: string; name: string; created: number }, base: string) => ({
    schemas: [GROUP],
    id: t.id,
    displayName: t.name,
    members: (await db.all<{ id: string; email: string }>(`SELECT u.id, u.email FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?`, [t.id])).map((m) => ({ value: m.id, display: m.email, $ref: `${base}/Users/${m.id}` })),
    meta: { resourceType: 'Group', created: new Date(t.created).toISOString(), location: `${base}/Groups/${t.id}` },
  });
  const teamById = async (id: string) => (await db.get<{ id: string; name: string; created: number }>(`SELECT * FROM teams WHERE id = ?`, [id])) ?? notFound();
  const addMembers = async (teamId: string, ids: string[]) => {
    for (const id of ids) if (await db.get(`SELECT id FROM users WHERE id = ?`, [id])) await db.run(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'editor') ON CONFLICT (team_id, user_id) DO NOTHING`, [teamId, id]);
  };
  const removeMembers = async (teamId: string, ids: string[]) => {
    // The directory does not remove owners (a team without an owner would be left unmanaged).
    for (const id of ids) await db.run(`DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND role <> 'owner'`, [teamId, id]);
  };

  route('GET', '/Groups', async (c, base) => {
    const filter = c.query.get('filter') ?? '';
    const m = /^\s*displayName\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
    const rows = m ? await db.all<{ id: string; name: string; created: number }>(`SELECT * FROM teams WHERE name = ?`, [m[1]]) : await db.all<{ id: string; name: string; created: number }>(`SELECT * FROM teams ORDER BY created`);
    return [200, { schemas: [LIST], totalResults: rows.length, startIndex: 1, itemsPerPage: rows.length, Resources: await Promise.all(rows.map((t) => groupView(t, base))) }];
  });

  route('GET', '/Groups/:id', async (c, base) => [200, await groupView(await teamById(c.params.id!), base)]);

  route('POST', '/Groups', async (c, base) => {
    const b = (await body(c)) as { displayName?: string; members?: { value: string }[] };
    if (!b.displayName?.trim()) throw new HttpError(400, 'Нужно displayName');
    const id = newId();
    const now = Date.now();
    await db.tx(async () => {
      await db.run(`INSERT INTO teams (id, name, created) VALUES (?, ?, ?)`, [id, b.displayName!.trim().slice(0, 80), now]);
      await db.run(`INSERT INTO projects (id, team_id, name, created) VALUES (?, ?, ?, ?)`, [newId(), id, 'Проект', now]);
      await addMembers(id, (b.members ?? []).map((m) => m.value));
    });
    return [201, await groupView(await teamById(id), base)];
  });

  route('PATCH', '/Groups/:id', async (c, base) => {
    const t = await teamById(c.params.id!);
    const b = (await body(c)) as { Operations?: { op: string; path?: string; value?: unknown }[] };
    for (const op of b.Operations ?? []) {
      const kind = op.op.toLowerCase();
      const values = (Array.isArray(op.value) ? op.value : []) as { value: string }[];
      // remove with a path filter: members[value eq "id"].
      const one = /^members\[value eq "([^"]+)"\]$/.exec(op.path ?? '');
      if (kind === 'add' && (op.path === 'members' || !op.path)) await addMembers(t.id, values.map((v) => v.value));
      else if (kind === 'remove' && one) await removeMembers(t.id, [one[1]!]);
      else if (kind === 'remove' && op.path === 'members') await removeMembers(t.id, values.map((v) => v.value));
      else if (kind === 'replace' && op.path === 'members') {
        const want = new Set(values.map((v) => v.value));
        const now = await db.all<{ user_id: string }>(`SELECT user_id FROM team_members WHERE team_id = ?`, [t.id]);
        await removeMembers(t.id, now.map((m) => m.user_id).filter((id) => !want.has(id)));
        await addMembers(t.id, [...want]);
      } else if (kind === 'replace') {
        const name = op.path === 'displayName' ? op.value : (op.value as { displayName?: string } | undefined)?.displayName;
        if (typeof name === 'string' && name.trim()) await db.run(`UPDATE teams SET name = ? WHERE id = ?`, [name.trim().slice(0, 80), t.id]);
      }
    }
    await d.live.refreshAll();
    return [200, await groupView(await teamById(t.id), base)];
  });

  route('DELETE', '/Groups/:id', async (c) => {
    const t = await teamById(c.params.id!);
    await db.run(`DELETE FROM teams WHERE id = ?`, [t.id]);
    await d.live.refreshAll();
    return [204, null];
  });

  // ---------- Service description ----------

  route('GET', '/ServiceProviderConfig', async () => [
    200,
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer', description: 'Токен SCIM (SCIM_TOKEN)' }],
    },
  ]);
  route('GET', '/ResourceTypes', async (_c, base) => [
    200,
    {
      schemas: [LIST],
      totalResults: 2,
      Resources: [
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER, meta: { location: `${base}/ResourceTypes/User` } },
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP, meta: { location: `${base}/ResourceTypes/Group` } },
      ],
    },
  ]);

}
