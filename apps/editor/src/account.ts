// Account on an MFP server (apps/server): sign-in with an email code, teams and projects, files
// on the server. The session token is in localStorage (mfp-session), the server address in mfp-server (by
// default: in development and on desktop — port 5175, otherwise the server serves the editor itself).
// Requests are JSON with the header Authorization: Bearer <token>.

import { isDesktop } from './platform.ts';

export type TeamRole = 'viewer' | 'editor' | 'admin' | 'owner';
export type FileRole = 'view' | 'comment' | 'edit' | 'owner';

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  color: string;
  admin: boolean;
}

export interface TeamRef {
  id: string;
  name: string;
  role: TeamRole;
}

export interface ProjectRef {
  id: string;
  teamId: string;
  name: string;
}

/** A file on the server (as returned by /api/files). */
export interface ServerFile {
  id: string;
  name: string;
  projectId: string | null;
  ownerId: string;
  created: number;
  modified: number;
  role: FileRole;
  linkRole: FileRole | 'none';
  thumb: boolean;
  trashed: number | null;
  teamId?: string | null;
  teamName?: string | null;
  projectName?: string | null;
}

export const TEAM_ROLES: [TeamRole, string][] = [
  ['viewer', 'смотрит и комментирует'],
  ['editor', 'редактирует'],
  ['admin', 'администратор'],
  ['owner', 'владелец'],
];

export const FILE_ROLES: [FileRole, string][] = [
  ['view', 'может смотреть'],
  ['comment', 'может комментировать'],
  ['edit', 'может редактировать'],
];

const RANK: Record<FileRole, number> = { view: 1, comment: 2, edit: 3, owner: 4 };
export const canEdit = (r: FileRole | null | undefined) => !!r && RANK[r] >= RANK.edit;
export const canComment = (r: FileRole | null | undefined) => !!r && RANK[r] >= RANK.comment;
/** How to show a person: email, or the login for login sign-in (service email …@*.invalid). */
export const whoIs = (email: string) => (/@[^@]+\.invalid$/.test(email) ? email.slice(0, email.lastIndexOf('@')) : email);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function defaultServer(): string {
  if (isDesktop) return 'http://localhost:5175';
  if (import.meta.env.DEV || location.protocol === 'file:') return `${location.protocol === 'https:' ? 'https' : 'http'}://${location.hostname || 'localhost'}:5175`;
  return location.origin;
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Without storage — signed in until reload.
  }
};

export class Account {
  base: string;
  token: string | null;
  user: AccountUser | null = null;
  teams: TeamRef[] = [];
  projects: ProjectRef[] = [];
  /** The server responds (false — unavailable; the token is kept). */
  online = false;
  /** Editor address known to the server (file links). */
  appUrl: string | null = null;
  onChange: (() => void)[] = [];
  private ready: Promise<void> | null = null;

  constructor() {
    this.base = (read('mfp-server') || defaultServer()).replace(/\/+$/, '');
    this.token = read('mfp-session');
  }

  get signedIn() {
    return !!this.user;
  }

  /** WebSocket address (rooms and files). */
  get ws() {
    return this.base.replace(/^http/, 'ws');
  }

  get isDefaultServer() {
    return this.base === defaultServer();
  }

  /** Change the server (the sign-in on the previous one is forgotten). */
  setServer(url: string) {
    const clean = url.trim().replace(/\/+$/, '') || defaultServer();
    if (clean === this.base) return;
    this.base = clean;
    write('mfp-server', clean === defaultServer() ? null : clean);
    const had = !!this.user || !!this.token;
    this.drop();
    // New server — subscribers (server policy, “own” addresses) learn about it even without the previous sign-in.
    if (!had) this.changed();
  }

  private changed() {
    for (const cb of this.onChange) {
      try {
        cb();
      } catch (e) {
        console.error('Учётная запись: обработчик', e);
      }
    }
  }

  private drop() {
    const had = !!this.user || !!this.token;
    this.token = null;
    this.user = null;
    this.teams = [];
    this.projects = [];
    write('mfp-session', null);
    if (had) this.changed();
  }

  /** API request: JSON or bytes (Uint8Array, Blob) in both directions. */
  async api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array || body instanceof Blob) {
      payload = body as BodyInit;
      headers['content-type'] = 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers, body: payload });
    } catch {
      this.online = false;
      throw new ApiError(0, `Сервер ${this.base} недоступен`);
    }
    this.online = true;
    if (res.status === 401 && this.token && !path.startsWith('/api/auth/')) this.drop();
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      const msg = type.includes('json') ? ((await res.json().catch(() => ({}))) as { error?: string }).error : '';
      throw new ApiError(res.status, msg || `Ошибка сервера (${res.status})`);
    }
    if (type.includes('json')) return (await res.json()) as T;
    return new Uint8Array(await res.arrayBuffer()) as T;
  }

  /** Who is signed in, their teams and projects (at startup and after changes). */
  refresh(): Promise<void> {
    this.ready = (async () => {
      if (!this.token) {
        this.online = false;
        return;
      }
      try {
        const me = await this.api<{ user: AccountUser; teams: TeamRef[]; projects: ProjectRef[]; appUrl?: string }>('GET', '/api/me');
        this.user = me.user;
        this.teams = me.teams;
        this.projects = me.projects ?? [];
        this.appUrl = me.appUrl ?? null;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 0) console.warn('Учётная запись:', e);
      }
      this.changed();
    })();
    return this.ready;
  }

  /** Wait for the first sign-in check. */
  async whenReady() {
    await (this.ready ?? this.refresh());
  }

  async requestCode(email: string) {
    await this.api('POST', '/api/auth/code', { email });
  }

  async passwordLogin(login: string, password: string, newPassword?: string): Promise<boolean> {
    const r = await this.api<{ token?: string; user?: AccountUser; mustChangePassword?: boolean }>('POST', '/api/auth/password', { login, password, newPassword });
    if (r.mustChangePassword) return false;
    if (!r.token || !r.user) throw new Error('Сервер не подтвердил вход');
    this.token = r.token;
    write('mfp-session', r.token);
    this.user = r.user;
    await this.refresh();
    return true;
  }

  /** First server setup (password sign-in, no accounts yet): code from the server log → administrator. */
  async setupServer(code: string, login: string, name: string, password: string) {
    const r = await this.api<{ token: string; user: AccountUser }>('POST', '/api/setup', { code, login, name, password });
    this.token = r.token;
    write('mfp-session', r.token);
    this.user = r.user;
    await this.refresh();
  }

  async verify(email: string, code: string) {
    const r = await this.api<{ token: string; user: AccountUser }>('POST', '/api/auth/verify', { email, code });
    this.token = r.token;
    write('mfp-session', r.token);
    this.user = r.user;
    await this.refresh();
  }

  /** SSO sign-in came back with a session token (#sso=…). */
  async adopt(token: string) {
    this.token = token;
    write('mfp-session', token);
    await this.refresh();
  }

  /** Company SSO on this server (the “Sign in with …” button); none — null. */
  async sso(): Promise<{ name: string; domains: string[] } | null> {
    try {
      const res = await fetch(`${this.base}/api/sso/config`);
      if (!res.ok) return null;
      const j = (await res.json()) as { enabled?: boolean; name: string; domains: string[] };
      return j.enabled ? j : null;
    } catch {
      return null;
    }
  }

  /** URL to start SSO sign-in: return to the same place. */
  ssoUrl(email?: string) {
    const back = `${location.origin}${location.pathname}${location.search}`;
    return `${this.base}/api/sso/start?redirect=${encodeURIComponent(back)}${email ? `&email=${encodeURIComponent(email)}` : ''}`;
  }

  async signOut() {
    if (this.token) await this.api('POST', '/api/auth/logout').catch(() => {});
    this.drop();
  }

  async rename(name: string) {
    const r = await this.api<{ user: AccountUser }>('PATCH', '/api/me', { name });
    this.user = r.user;
    this.changed();
  }

  /** Project name with its team: “Studio / Mockups”. */
  projectLabel(projectId: string | null): string {
    if (!projectId) return 'Черновики';
    const p = this.projects.find((x) => x.id === projectId);
    const t = p && this.teams.find((x) => x.id === p.teamId);
    return p ? `${t?.name ?? 'Команда'} / ${p.name}` : 'Проект';
  }

  // ---------- Files ----------

  files(scope: 'recent' | 'drafts' | 'shared' | 'trash') {
    return this.api<{ files: ServerFile[] }>('GET', `/api/files?scope=${scope}`).then((r) => r.files);
  }

  /** New file on the server with a snapshot of the Loro document. */
  createFile(name: string, projectId: string | null, snapshot: Uint8Array) {
    const q = new URLSearchParams({ name });
    if (projectId) q.set('projectId', projectId);
    return this.api<ServerFile>('POST', `/api/files?${q}`, snapshot);
  }

  /** File thumbnail (none — null). */
  async thumbnail(id: string): Promise<Blob | null> {
    try {
      return new Blob([(await this.api<Uint8Array>('GET', `/api/files/${id}/thumb`)) as BlobPart], { type: 'image/png' });
    } catch {
      return null;
    }
  }

  /** Document images go to the server (skipping what is already there), 4 at a time. */
  async uploadImages(hashes: Iterable<string>, readImage: (hash: string) => Promise<Uint8Array | undefined>, progress?: (done: number, total: number) => void): Promise<number> {
    const list = [...new Set(hashes)];
    let next = 0;
    let missing = 0;
    let done = 0;
    let failed = false;
    progress?.(0, list.length);
    const worker = async () => {
      while (!failed && next < list.length) {
        try {
          const hash = list[next++]!;
          const url = `${this.base}/image/${hash}`;
          const headers: HeadersInit = this.token ? { authorization: `Bearer ${this.token}` } : {};
          if ((await fetch(url, { method: 'HEAD', headers })).ok) { progress?.(++done, list.length); continue; }
          const bytes = await readImage(hash);
          if (!bytes) {
            missing++;
            progress?.(++done, list.length);
            continue;
          }
          const res = await fetch(url, { method: 'PUT', headers, body: bytes as BufferSource });
          if (!res.ok) throw new ApiError(res.status, `Картинка не загрузилась (${res.status})`);
          progress?.(++done, list.length);
        } catch (error) { failed = true; throw error; }
      }
    };
    const results = await Promise.allSettled([worker(), worker(), worker(), worker()]);
    const error = results.find(r => r.status === 'rejected');
    if (error?.status === 'rejected') throw error.reason;
    return missing;
  }

  /** File link (for the clipboard): in a browser — this same editor, on desktop — the server's address. */
  fileUrl(id: string, link?: string | null): string {
    const app = isDesktop ? (this.appUrl ?? `${this.base}/`) : `${location.origin}${location.pathname}${location.search}`;
    return `${app.replace(/#.*$/, '')}#file=${id}${link ? `&link=${link}` : ''}`;
  }
}
