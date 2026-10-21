// Webhooks and integrations. File events — FILE_UPDATE, FILE_COMMENT,
// LIBRARY_PUBLISH, BRANCH_MERGED, FILE_DELETE — go to subscribers of the team or file:
// - webhook — POST JSON to a URL, HMAC-SHA256 signature of the body with the secret in X-MFP-Signature;
// - slack — a message to the channel's incoming webhook;
// - telegram — a bot message to a chat;
// - jira — issue keys in comments (ABC-123): a comment and a link in the issue; an issue can be
//   created from a thread (POST /api/comments/:id/jira).
// Delivery — a queue in the database: retries after 30 s, 2 min and 10 min, a request log. Addresses on the
// internal network (localhost, 10.*, 192.168.* …) are forbidden unless the server is configured otherwise.

import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { atLeast, fileRow, fileTeam, needFile, needTeam, type FileRow } from './access.ts';
import type { ApiDeps } from './api.ts';
import type { User } from './auth.ts';
import { isPrivateAddress } from './imaging-proxy.ts';
import type { Router } from './router.ts';
import { fail, HttpError, newId, newSecret, readJson } from './util.ts';

export const HOOK_EVENTS = ['FILE_UPDATE', 'FILE_COMMENT', 'LIBRARY_PUBLISH', 'BRANCH_MERGED', 'FILE_DELETE'] as const;
type Kind = 'webhook' | 'slack' | 'telegram' | 'jira';
const KINDS: Kind[] = ['webhook', 'slack', 'telegram', 'jira'];

export interface HookOptions {
  /** Allow addresses on the internal network (development, testing). */
  allowPrivate?: boolean;
  /** Delays between retries, ms. */
  retryMs?: number[];
  /** How often to process the queue, ms. */
  tickMs?: number;
  /** FILE_UPDATE — this many ms after the last edit. */
  updateDelayMs?: number;
}

interface HookRow {
  id: string;
  team_id: string | null;
  file_id: string | null;
  kind: Kind;
  events: string;
  config: string;
  description: string | null;
  created_by: string;
  created: number;
  active: number;
}

interface DeliveryRow {
  id: string;
  hook_id: string;
  event: string;
  payload: string;
  status: 'pending' | 'ok' | 'failed';
  attempts: number;
  next_at: number;
  response_status: number | null;
  error: string | null;
  created: number;
  finished: number | null;
}

interface EventData {
  fileId: string;
  by?: User | null;
  [k: string]: unknown;
}

/** Subscriber URL: http(s), not on the internal network (unless allowed). */
async function checkUrl(url: string, allowPrivate: boolean) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'Неверный адрес');
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new HttpError(400, 'Нужен адрес https://');
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(400, 'Адрес не находится (DNS)');
  if (host === 'localhost' || host.endsWith('.localhost') || addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, 'Адреса во внутренней сети запрещены');
}

/** Secrets never leave: only the tail is shown. */
function maskConfig(kind: Kind, config: Record<string, string>) {
  const tail = (s?: string) => (s ? `…${s.slice(-4)}` : '');
  if (kind === 'webhook') return { endpoint: config.endpoint, passcode: tail(config.passcode) };
  if (kind === 'slack') return { url: config.url?.replace(/\/[^/]+$/, '/…') };
  if (kind === 'telegram') return { chatId: config.chatId, token: tail(config.token), api: config.api };
  return { baseUrl: config.baseUrl, email: config.email, projectKey: config.projectKey, apiToken: tail(config.apiToken) };
}

export class Hooks {
  private d: ApiDeps;
  private opts: Required<HookOptions>;
  private timer: ReturnType<typeof setInterval>;
  private busy = false;
  private updates = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(d: ApiDeps, opts: HookOptions = {}) {
    this.d = d;
    this.opts = { allowPrivate: false, retryMs: [30_000, 120_000, 600_000], tickMs: 1000, updateDelayMs: 60_000, ...opts };
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    this.timer.unref();
    // File edits — FILE_UPDATE after a pause (not on every save).
    d.live.onChange.push((fileId) => {
      clearTimeout(this.updates.get(fileId));
      const t = setTimeout(() => {
        this.updates.delete(fileId);
        this.emit('FILE_UPDATE', { fileId });
      }, this.opts.updateDelayMs);
      t.unref?.();
      this.updates.set(fileId, t);
    });
  }

  get allowPrivate() {
    return this.opts.allowPrivate;
  }

  checkUrl(url: string) {
    return checkUrl(url, this.opts.allowPrivate);
  }

  close() {
    clearInterval(this.timer);
    for (const t of this.updates.values()) clearTimeout(t);
  }

  /** File event: into the delivery queue for subscribers of the file and its team. */
  emit(type: string, data: EventData) {
    void (async () => {
      const db = this.d.db;
      const file = await fileRow(db, data.fileId);
      if (!file) return;
      // A branch — events of the main file (same team).
      const main = file.parent_id ? ((await fileRow(db, file.parent_id)) ?? file) : file;
      const team = await fileTeam(db, main);
      const hooks = await db.all<HookRow>(`SELECT * FROM hooks WHERE active = 1 AND (file_id = ? OR file_id = ? OR (team_id IS NOT NULL AND team_id = ?))`, [file.id, main.id, team]);
      const now = Date.now();
      for (const h of hooks) {
        if (!(JSON.parse(h.events) as string[]).includes(type)) continue;
        const payload = this.payload(h, type, file, data);
        await db.run(`INSERT INTO hook_deliveries (id, hook_id, event, payload, status, attempts, next_at, created) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`, [newId(), h.id, type, JSON.stringify(payload), now, now]);
      }
      void this.tick();
    })().catch((e) => console.error('Вебхуки: событие не записано', e));
  }

  private payload(h: HookRow, type: string, file: FileRow, data: EventData) {
    const by = data.by ? { id: data.by.id, handle: data.by.name } : null;
    const extra: Record<string, unknown> = {};
    const comment = data.comment as { id: string; thread: string | null; text: string; mentions: { id: string; name: string }[] } | undefined;
    if (comment) Object.assign(extra, { comment_id: comment.id, thread_id: comment.thread ?? comment.id, comment: [{ text: comment.text }], mentions: comment.mentions });
    if (data.library) extra.library = data.library;
    if (data.branch) extra.branch = data.branch;
    return {
      event_type: type,
      webhook_id: h.id,
      timestamp: new Date().toISOString(),
      file_key: file.id,
      file_name: file.name,
      file_url: `${this.d.appUrl}#file=${file.id}${comment ? `&comment=${comment.thread ?? comment.id}` : ''}`,
      triggered_by: by,
      ...extra,
    };
  }

  /** Process the queue: everything that is due. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const due = await this.d.db.all<DeliveryRow & { hook: string }>(`SELECT * FROM hook_deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 20`, [Date.now()]);
        if (!due.length) break;
        for (const row of due) await this.attempt(row);
      }
    } catch (e) {
      console.error('Вебхуки: очередь', e);
    } finally {
      this.busy = false;
    }
  }

  private async attempt(row: DeliveryRow) {
    const db = this.d.db;
    const h = await db.get<HookRow>(`SELECT * FROM hooks WHERE id = ?`, [row.hook_id]);
    if (!h) {
      await db.run(`UPDATE hook_deliveries SET status = 'failed', error = ?, finished = ? WHERE id = ?`, ['подписка удалена', Date.now(), row.id]);
      return;
    }
    let status: number | null = null;
    let error: string | null = null;
    try {
      status = await this.send(h, JSON.parse(row.payload));
    } catch (e) {
      error = (e as Error).message;
      status = e instanceof DeliveryError ? e.status : null;
    }
    const attempts = row.attempts + 1;
    if (!error) await db.run(`UPDATE hook_deliveries SET status = 'ok', attempts = ?, response_status = ?, error = NULL, finished = ? WHERE id = ?`, [attempts, status, Date.now(), row.id]);
    else if (attempts > this.opts.retryMs.length) await db.run(`UPDATE hook_deliveries SET status = 'failed', attempts = ?, response_status = ?, error = ?, finished = ? WHERE id = ?`, [attempts, status, error, Date.now(), row.id]);
    else await db.run(`UPDATE hook_deliveries SET attempts = ?, response_status = ?, error = ?, next_at = ? WHERE id = ?`, [attempts, status, error, Date.now() + this.opts.retryMs[attempts - 1]!, row.id]);
  }

  /** Send according to the subscription kind; response code (error — exception). */
  private async send(h: HookRow, p: Record<string, unknown>): Promise<number> {
    const config = JSON.parse(h.config) as Record<string, string>;
    const post = async (url: string, body: string, headers: Record<string, string> = {}) => {
      await checkUrl(url, this.opts.allowPrivate);
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'MFP-Webhooks/1', ...headers }, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new DeliveryError(res.status, `Ответ ${res.status}`);
      return res.status;
    };
    if (h.kind === 'webhook') {
      const body = JSON.stringify({ ...p, passcode: config.passcode });
      const sig = createHmac('sha256', config.passcode ?? '').update(body).digest('hex');
      return post(config.endpoint!, body, { 'x-mfp-signature': `sha256=${sig}`, 'x-mfp-event': String(p.event_type) });
    }
    const text = describe(p);
    if (h.kind === 'slack') return post(config.url!, JSON.stringify({ text }));
    if (h.kind === 'telegram') {
      const api = (config.api || 'https://api.telegram.org').replace(/\/$/, '');
      return post(`${api}/bot${config.token}/sendMessage`, JSON.stringify({ chat_id: config.chatId, text: escapeHtml(text), parse_mode: 'HTML', disable_web_page_preview: true }));
    }
    // Jira: issue keys in a comment — a comment in the issue and a link to the thread.
    if (p.event_type !== 'FILE_COMMENT') return 204;
    const commentText = ((p.comment as { text: string }[] | undefined)?.[0]?.text ?? '').slice(0, 4000);
    const keys = [...new Set(commentText.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])].slice(0, 5);
    let last = 204;
    for (const key of keys) {
      const base = config.baseUrl!.replace(/\/$/, '');
      const auth = { authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}` };
      const by = (p.triggered_by as { handle: string } | null)?.handle ?? 'MFP';
      await post(`${base}/rest/api/3/issue/${key}/comment`, JSON.stringify({ body: adf(`${by} в «${p.file_name}»: ${commentText}`, String(p.file_url)) }), auth);
      last = await post(`${base}/rest/api/3/issue/${key}/remotelink`, JSON.stringify({ globalId: `mfp:${p.file_key}:${p.thread_id}`, object: { url: p.file_url, title: `MFP: ${p.file_name}` } }), auth);
    }
    return last;
  }

  /** Create a Jira issue from a thread (the integration of the file's team). */
  async createJiraIssue(file: FileRow, user: User, thread: { id: string; text: string }): Promise<{ key: string; url: string }> {
    const db = this.d.db;
    const main = file.parent_id ? ((await fileRow(db, file.parent_id)) ?? file) : file;
    const team = await fileTeam(db, main);
    const h = await db.get<HookRow>(`SELECT * FROM hooks WHERE active = 1 AND kind = 'jira' AND (file_id = ? OR (team_id IS NOT NULL AND team_id = ?)) ORDER BY created LIMIT 1`, [main.id, team]);
    if (!h) fail(400, 'Jira не подключена к команде этого файла');
    const config = JSON.parse(h!.config) as Record<string, string>;
    const base = config.baseUrl!.replace(/\/$/, '');
    await checkUrl(base, this.opts.allowPrivate);
    const link = `${this.d.appUrl}#file=${file.id}&comment=${thread.id}`;
    const summary = (thread.text.split('\n')[0] || `Комментарий в «${file.name}»`).slice(0, 200);
    const res = await fetch(`${base}/rest/api/3/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}` },
      body: JSON.stringify({ fields: { project: { key: config.projectKey }, summary, issuetype: { name: config.issueType || 'Task' }, description: adf(`${user.name} в «${file.name}»: ${thread.text}`, link) } }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) fail(502, `Jira ответила ${res.status}`);
    const issue = (await res.json()) as { key: string };
    return { key: issue.key, url: `${base}/browse/${issue.key}` };
  }
}

class DeliveryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Event in words (Slack, Telegram). */
function describe(p: Record<string, unknown>): string {
  const by = (p.triggered_by as { handle: string } | null)?.handle;
  const file = `«${p.file_name}»`;
  const url = String(p.file_url);
  switch (p.event_type) {
    case 'FILE_COMMENT':
      return `💬 ${by ?? 'Кто-то'} в ${file}: ${((p.comment as { text: string }[] | undefined)?.[0]?.text ?? '').slice(0, 500)}\n${url}`;
    case 'LIBRARY_PUBLISH': {
      const l = p.library as { name: string; version: number; description?: string | null } | undefined;
      return `📚 ${by ?? 'Кто-то'}: библиотека «${l?.name ?? p.file_name}» — версия ${l?.version ?? ''}${l?.description ? `: ${l.description}` : ''}\n${url}`;
    }
    case 'BRANCH_MERGED':
      return `⑂ ${by ?? 'Кто-то'}: ветка «${(p.branch as { name: string } | undefined)?.name ?? ''}» слита в ${file}\n${url}`;
    case 'FILE_DELETE':
      return `🗑 ${by ?? 'Кто-то'}: ${file} в корзине`;
    default:
      return `✏️ ${file} изменён\n${url}`;
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Atlassian document (ADF): a paragraph and a link. */
function adf(text: string, link: string) {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Открыть в MFP', marks: [{ type: 'link', attrs: { href: link } }] }] },
    ],
  };
}

/** Subscriptions: /api/hooks (all kinds) and /v1/webhooks. */
export function registerHooks(r: Router, d: ApiDeps, hooks: Hooks) {
  const { db } = d;
  /** Permission for subscriptions: team — administrator, file — owner. */
  const scope = async (userId: string, teamId: unknown, fileId: unknown): Promise<{ teamId: string | null; fileId: string | null }> => {
    if (typeof teamId === 'string' && teamId) {
      await needTeam(db, teamId, userId, 'admin');
      return { teamId, fileId: null };
    }
    if (typeof fileId === 'string' && fileId) {
      const { role } = await needFile(db, fileId, userId, 'view');
      if (!atLeast(role, 'owner')) fail(403, 'Подписки файла настраивает его владелец');
      return { teamId: null, fileId };
    }
    return fail(400, 'Нужен teamId или fileId');
  };
  const own = async (id: string, userId: string) => {
    const h = await db.get<HookRow>(`SELECT * FROM hooks WHERE id = ?`, [id]);
    if (!h) fail(404, 'Нет такой подписки');
    await scope(userId, h!.team_id, h!.file_id);
    return h!;
  };
  const readConfig = async (kind: Kind, c: Record<string, unknown>, prev?: Record<string, string>): Promise<Record<string, string>> => {
    const get = (k: string) => (typeof c[k] === 'string' && (c[k] as string).trim() ? (c[k] as string).trim() : prev?.[k]);
    const need = (k: string) => get(k) ?? fail(400, `Нужно поле ${k}`);
    if (kind === 'webhook') {
      const endpoint = need('endpoint')!;
      await hooks.checkUrl(endpoint);
      return { endpoint, passcode: get('passcode') ?? newSecret() };
    }
    if (kind === 'slack') {
      const url = need('url')!;
      await hooks.checkUrl(url);
      return { url };
    }
    if (kind === 'telegram') {
      const api = get('api');
      if (api) await hooks.checkUrl(api);
      return { token: need('token')!, chatId: need('chatId')!, ...(api ? { api } : {}) };
    }
    const baseUrl = need('baseUrl')!;
    await hooks.checkUrl(baseUrl);
    return { baseUrl, email: need('email')!, apiToken: need('apiToken')!, projectKey: need('projectKey')!, ...(get('issueType') ? { issueType: get('issueType')! } : {}) };
  };
  const events = (v: unknown, kind: Kind): string[] => {
    const list = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter((e): e is string => (HOOK_EVENTS as readonly string[]).includes(e as string));
    if (list.length) return list;
    if (kind === 'jira') return ['FILE_COMMENT'];
    return fail(400, `Нужны события: ${HOOK_EVENTS.join(', ')}`);
  };
  const view = (h: HookRow) => ({
    id: h.id,
    kind: h.kind,
    teamId: h.team_id,
    fileId: h.file_id,
    events: JSON.parse(h.events) as string[],
    config: maskConfig(h.kind, JSON.parse(h.config)),
    description: h.description,
    active: !!h.active,
    created: h.created,
  });
  const create = async (userId: string, b: Record<string, unknown>) => {
    const kind = (KINDS as string[]).includes(b.kind as string) ? (b.kind as Kind) : fail(400, `Вид: ${KINDS.join(', ')}`);
    const s = await scope(userId, b.teamId, b.fileId);
    const config = await readConfig(kind, (b.config ?? {}) as Record<string, unknown>);
    const id = newId();
    await db.run(`INSERT INTO hooks (id, team_id, file_id, kind, events, config, description, created_by, created, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, [
      id,
      s.teamId,
      s.fileId,
      kind,
      JSON.stringify(events(b.events, kind)),
      JSON.stringify(config),
      typeof b.description === 'string' ? b.description.slice(0, 200) : null,
      userId,
      Date.now(),
    ]);
    return { hook: (await db.get<HookRow>(`SELECT * FROM hooks WHERE id = ?`, [id]))!, config };
  };
  const list = async (userId: string, teamId: string | null, fileId: string | null) => {
    const s = await scope(userId, teamId, fileId);
    return db.all<HookRow>(s.teamId ? `SELECT * FROM hooks WHERE team_id = ? ORDER BY created` : `SELECT * FROM hooks WHERE file_id = ? ORDER BY created`, [s.teamId ?? s.fileId]);
  };
  const requests = async (id: string) =>
    (await db.all<DeliveryRow>(`SELECT * FROM hook_deliveries WHERE hook_id = ? ORDER BY created DESC LIMIT 100`, [id])).map((x) => ({
      id: x.id,
      event: x.event,
      status: x.status,
      attempts: x.attempts,
      responseStatus: x.response_status,
      error: x.error,
      created: x.created,
      finished: x.finished,
      payload: JSON.parse(x.payload),
    }));

  // ---------- /api/hooks ----------

  r.add('GET', '/api/hooks', async (c) => ({ hooks: (await list(c.need().user.id, c.query.get('teamId'), c.query.get('fileId'))).map(view) }));
  r.add('POST', '/api/hooks', async (c) => {
    const { hook, config } = await create(c.need().user.id, await readJson(c.req));
    // Webhook secret — shown once (to verify the signature).
    return { ...view(hook), ...(hook.kind === 'webhook' ? { passcode: config.passcode } : {}) };
  });
  r.add('PATCH', '/api/hooks/:id', async (c) => {
    const p = c.need();
    const h = await own(c.params.id!, p.user.id);
    const b = await readJson(c.req);
    const config = b.config ? await readConfig(h.kind, b.config as Record<string, unknown>, JSON.parse(h.config)) : JSON.parse(h.config);
    await db.run(`UPDATE hooks SET events = ?, config = ?, description = ?, active = ? WHERE id = ?`, [
      JSON.stringify(b.events !== undefined ? events(b.events, h.kind) : JSON.parse(h.events)),
      JSON.stringify(config),
      typeof b.description === 'string' ? b.description.slice(0, 200) : h.description,
      b.active === undefined ? h.active : b.active ? 1 : 0,
      h.id,
    ]);
    return view((await db.get<HookRow>(`SELECT * FROM hooks WHERE id = ?`, [h.id]))!);
  });
  r.add('DELETE', '/api/hooks/:id', async (c) => {
    const h = await own(c.params.id!, c.need().user.id);
    await db.run(`DELETE FROM hooks WHERE id = ?`, [h.id]);
  });
  r.add('GET', '/api/hooks/:id/requests', async (c) => {
    const h = await own(c.params.id!, c.need().user.id);
    return { requests: await requests(h.id) };
  });
  /** Test: a test event (like FILE_UPDATE) right now. */
  r.add('POST', '/api/hooks/:id/test', async (c) => {
    const p = c.need();
    const h = await own(c.params.id!, p.user.id);
    const file = h.file_id
      ? await fileRow(db, h.file_id)
      : await db.get<FileRow>(`SELECT f.* FROM files f JOIN projects pr ON pr.id = f.project_id WHERE pr.team_id = ? AND f.trashed IS NULL ORDER BY f.modified DESC LIMIT 1`, [h.team_id]);
    if (!file) fail(400, 'В команде нет файлов для проверки');
    const payload = { event_type: 'PING', webhook_id: h.id, timestamp: new Date().toISOString(), file_key: file!.id, file_name: file!.name, file_url: `${d.appUrl}#file=${file!.id}`, triggered_by: { id: p.user.id, handle: p.user.name } };
    const now = Date.now();
    await db.run(`INSERT INTO hook_deliveries (id, hook_id, event, payload, status, attempts, next_at, created) VALUES (?, ?, 'PING', ?, 'pending', 0, ?, ?)`, [newId(), h.id, JSON.stringify(payload), now, now]);
    await hooks.tick();
    return { requests: (await requests(h.id)).slice(0, 1) };
  });

  // ---------- Jira issue from a thread ----------

  r.add('POST', '/api/comments/:id/jira', async (c) => {
    const p = c.need();
    const cm = await db.get<{ id: string; file_id: string; thread_id: string | null }>(`SELECT id, file_id, thread_id FROM comments WHERE id = ?`, [c.params.id]);
    if (!cm) fail(404, 'Нет такого комментария');
    const threadId = cm!.thread_id ?? cm!.id;
    const root = await db.get<{ id: string; text: string }>(`SELECT id, text FROM comments WHERE id = ?`, [threadId]);
    const { file } = await needFile(db, cm!.file_id, p.user.id, 'comment');
    const issue = await hooks.createJiraIssue(file, p.user, root!);
    // Link to the issue — as a reply in the thread.
    await d.comments?.create(file, p.user, { text: `Задача ${issue.key}: ${issue.url}`, thread: threadId });
    return issue;
  });

  // ---------- /v1/webhooks ----------

  const v1 = (h: HookRow) => {
    const config = JSON.parse(h.config) as Record<string, string>;
    return { id: h.id, event_type: (JSON.parse(h.events) as string[])[0], events: JSON.parse(h.events), team_id: h.team_id, file_key: h.file_id, endpoint: config.endpoint, status: h.active ? 'ACTIVE' : 'PAUSED', description: h.description };
  };
  r.add('POST', '/v1/webhooks', async (c) => {
    const b = await readJson(c.req);
    const { hook, config } = await create(c.need().user.id, {
      kind: 'webhook',
      teamId: b.team_id,
      fileId: b.file_key ?? b.file_id,
      events: b.events ?? b.event_type,
      config: { endpoint: b.endpoint, passcode: b.passcode },
      description: b.description,
    });
    return { ...v1(hook), passcode: config.passcode };
  });
  r.add('GET', '/v1/webhooks', async (c) => ({ webhooks: (await list(c.need().user.id, c.query.get('team_id'), c.query.get('file_key') ?? c.query.get('file_id'))).filter((h) => h.kind === 'webhook').map(v1) }));
  r.add('GET', '/v1/webhooks/:id', async (c) => v1(await own(c.params.id!, c.need().user.id)));
  r.add('PUT', '/v1/webhooks/:id', async (c) => {
    const p = c.need();
    const h = await own(c.params.id!, p.user.id);
    const b = await readJson(c.req);
    const config = JSON.parse(h.config) as Record<string, string>;
    if (typeof b.endpoint === 'string') {
      await hooks.checkUrl(b.endpoint);
      config.endpoint = b.endpoint;
    }
    if (typeof b.passcode === 'string' && b.passcode) config.passcode = b.passcode;
    await db.run(`UPDATE hooks SET events = ?, config = ?, description = ?, active = ? WHERE id = ?`, [
      JSON.stringify(b.events !== undefined || b.event_type !== undefined ? events(b.events ?? b.event_type, 'webhook') : JSON.parse(h.events)),
      JSON.stringify(config),
      typeof b.description === 'string' ? b.description : h.description,
      b.status === 'PAUSED' ? 0 : b.status === 'ACTIVE' ? 1 : h.active,
      h.id,
    ]);
    return v1((await db.get<HookRow>(`SELECT * FROM hooks WHERE id = ?`, [h.id]))!);
  });
  r.add('DELETE', '/v1/webhooks/:id', async (c) => {
    const h = await own(c.params.id!, c.need().user.id);
    await db.run(`DELETE FROM hooks WHERE id = ?`, [h.id]);
  });
  r.add('GET', '/v1/webhooks/:id/requests', async (c) => {
    const h = await own(c.params.id!, c.need().user.id);
    return { requests: await requests(h.id) };
  });
}
