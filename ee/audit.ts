// Audit log (Enterprise): who did what and when — sign-in and sign-out, tokens, teams and roles,
// file access and links, deletion, branches, library publishing, webhooks, SSO and SCIM. Written
// for every mutating API request (Router.onDone); the server admin reads the log
// (/api/admin/audit, filters, CSV export).

import type { ApiDeps } from '../apps/server/src/api.ts';
import type { RequestInfo, Router } from '../apps/server/src/router.ts';
import { fail, newId } from '../apps/server/src/util.ts';

/** Actions by route (everything else — “METHOD template”). */
const ACTIONS: Record<string, string> = {
  'POST /api/auth/verify': 'login',
  'POST /api/auth/logout': 'logout',
  'PATCH /api/me': 'profile.update',
  'POST /api/tokens': 'token.create',
  'DELETE /api/tokens/:id': 'token.delete',
  'POST /api/teams': 'team.create',
  'PATCH /api/teams/:id': 'team.update',
  'DELETE /api/teams/:id': 'team.delete',
  'POST /api/teams/:id/members': 'team.member.add',
  'PATCH /api/teams/:id/members/:userId': 'team.member.role',
  'DELETE /api/teams/:id/members/:userId': 'team.member.remove',
  'DELETE /api/teams/:id/invites/:inviteId': 'team.invite.cancel',
  'POST /api/teams/:id/projects': 'project.create',
  'PATCH /api/projects/:id': 'project.update',
  'DELETE /api/projects/:id': 'project.delete',
  'POST /api/files': 'file.create',
  'PATCH /api/files/:id': 'file.update',
  'DELETE /api/files/:id': 'file.delete',
  'POST /api/files/:id/restore': 'file.restore',
  'POST /api/files/:id/access': 'file.share',
  'DELETE /api/files/:id/access/:userId': 'file.unshare',
  'PUT /api/files/:id/link': 'file.link',
  'POST /api/files/:id/doc': 'file.import',
  'POST /api/files/:id/branches': 'branch.create',
  'POST /api/files/:id/merge': 'branch.merge',
  'POST /api/files/:id/publish': 'library.publish',
  'DELETE /api/files/:id/publish': 'library.unpublish',
  'POST /api/hooks': 'hook.create',
  'PATCH /api/hooks/:id': 'hook.update',
  'DELETE /api/hooks/:id': 'hook.delete',
  'POST /v1/webhooks': 'hook.create',
  'PUT /v1/webhooks/:id': 'hook.update',
  'DELETE /v1/webhooks/:id': 'hook.delete',
};

/** What not to record: frequent actions that do not change permissions (comments, reactions, attachments, MCP — they have their own logs). */
const SKIP = /^(POST \/api\/files\/:id\/comments|PATCH \/api\/comments|DELETE \/api\/comments|PUT \/api\/comments|POST \/api\/files\/:id\/attachments|POST \/api\/notifications|POST \/mcp|DELETE \/mcp|POST \/api\/auth\/code|PUT \/api\/files\/:id\/thumb|POST \/api\/libraries\/:id\/usage|POST \/api\/hooks\/:id\/test)/;

export interface AuditEntry {
  action: string;
  userId?: string | null;
  email?: string | null;
  target?: string | null;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  status?: number;
}

export class AuditLog {
  private d: ApiDeps;

  constructor(d: ApiDeps) {
    this.d = d;
  }

  async init() {
    await this.d.db.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at BIGINT NOT NULL,
      user_id TEXT,
      email TEXT,
      action TEXT NOT NULL,
      target TEXT,
      status INTEGER,
      ip TEXT,
      user_agent TEXT,
      details TEXT
    )`);
    await this.d.db.run(`CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at)`);
  }

  write(e: AuditEntry) {
    void this.d.db
      .run(`INSERT INTO audit_log (id, at, user_id, email, action, target, status, ip, user_agent, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        newId(),
        Date.now(),
        e.userId ?? null,
        e.email ?? null,
        e.action,
        e.target ?? null,
        e.status ?? 200,
        e.ip ?? null,
        (e.userAgent ?? '').slice(0, 300) || null,
        e.details ? JSON.stringify(e.details) : null,
      ])
      .catch((err) => console.error('Аудит: запись не удалась', err));
  }

  /** API request → record (changes and sign-in; reads are not recorded). */
  request(r: RequestInfo) {
    if (r.method === 'GET' || r.method === 'HEAD') return;
    const key = `${r.method} ${r.pattern}`;
    if (SKIP.test(key)) return;
    // Sign-in: who signed in comes from the response (the token is not recorded).
    const user = r.principal?.user ?? (key === 'POST /api/auth/verify' ? ((r.result as { user?: { id: string; email: string } } | undefined)?.user ?? null) : null);
    const target = r.params.id ?? null;
    const details: Record<string, unknown> = { ...r.params };
    delete details.id;
    if (r.principal?.kind === 'api') details.via = 'api-token';
    this.write({ action: ACTIONS[key] ?? key, userId: user?.id ?? null, email: user?.email ?? null, target, details: Object.keys(details).length ? details : undefined, ip: r.ip, userAgent: r.userAgent, status: r.status });
  }
}

export function registerAudit(r: Router, d: ApiDeps, log: AuditLog) {
  r.onDone.push((info) => log.request(info));

  /** Log: server admin; ?from&to (ms), user (email), action (prefix), limit; format=csv. */
  r.add('GET', '/api/admin/audit', async (c) => {
    const p = c.need();
    if (!p.user.admin) fail(403, 'Журнал аудита — для администраторов сервера');
    const where: string[] = [];
    const params: unknown[] = [];
    const q = c.query;
    if (q.get('from')) where.push('at >= ?') && params.push(Number(q.get('from')));
    if (q.get('to')) where.push('at <= ?') && params.push(Number(q.get('to')));
    if (q.get('user')) where.push('email = ?') && params.push(q.get('user')!.toLowerCase());
    if (q.get('action')) where.push('action LIKE ?') && params.push(`${q.get('action')}%`);
    const limit = Math.min(10_000, Math.max(1, Number(q.get('limit') ?? 500)));
    const rows = await d.db.all<{ id: string; at: number; user_id: string | null; email: string | null; action: string; target: string | null; status: number; ip: string | null; user_agent: string | null; details: string | null }>(
      `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ${limit}`,
      params,
    );
    const entries = rows.map((x) => ({ id: x.id, at: x.at, time: new Date(x.at).toISOString(), userId: x.user_id, email: x.email, action: x.action, target: x.target, status: x.status, ip: x.ip, userAgent: x.user_agent, details: x.details ? JSON.parse(x.details) : null }));
    if (q.get('format') !== 'csv') return { entries };
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['time', 'email', 'action', 'target', 'status', 'ip', 'userAgent', 'details'] as const;
    const csv = [head.join(','), ...entries.map((e) => head.map((k) => cell(e[k])).join(','))].join('\r\n');
    c.res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit.csv"' });
    c.res.end(`﻿${csv}`);
  });
}
