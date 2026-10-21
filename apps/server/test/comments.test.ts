import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../src/server.ts';
import type { Mail } from '../src/util.ts';
import { testDb } from './db.ts';

let dir: string;
let server: RunningServer;
let mails: Mail[];
let tdb: Awaited<ReturnType<typeof testDb>>;

beforeEach(async () => {
  tdb = await testDb();
  dir = mkdtempSync(join(tmpdir(), 'mfp-comments-'));
  mails = [];
  server = await startServer({ port: 0, dir, pingMs: 60_000, db: tdb.db, mailer: { send: async (m) => void mails.push(m) } });
});

afterEach(async () => {
  await server.close();
  await tdb.dispose();
  rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: Json }> {
  const res = await fetch(`http://localhost:${server.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text.startsWith('{') ? JSON.parse(text) : { text } };
}

async function login(email: string): Promise<{ token: string; id: string }> {
  await api('POST', '/api/auth/code', { email });
  const code = /(\d{6})/.exec(mails.filter((m) => m.to === email).at(-1)!.subject)![1]!;
  const r = await api('POST', '/api/auth/verify', { email, code });
  return { token: r.data.token, id: r.data.user.id };
}

const place = { page: '0:1', anchor: '0:5', at: [10, 20], pageAt: [110, 220] };

describe('comments on the server', () => {
  it('thread, mention, reply, reactions, resolved, permissions', async () => {
    const anna = await login('anna@example.com');
    const boris = await login('boris@example.com');
    const viktor = await login('viktor@example.com');
    const stranger = await login('stranger@example.com');
    const file = (await api('POST', '/api/files', { name: 'Макет' }, anna.token)).data;
    await api('POST', `/api/files/${file.id}/access`, { email: 'boris@example.com', role: 'comment' }, anna.token);
    await api('POST', `/api/files/${file.id}/access`, { email: 'viktor@example.com', role: 'view' }, anna.token);
    mails.length = 0;

    // Who can be mentioned: everyone who can see the file.
    const people = (await api('GET', `/api/files/${file.id}/people`, undefined, boris.token)).data.people as { id: string }[];
    expect(people.map((u) => u.id).sort()).toEqual([anna.id, boris.id, viktor.id].sort());

    // Anna's thread mentioning Boris (and an outsider — dropped).
    const root = (await api('POST', `/api/files/${file.id}/comments`, { text: '@boris глянь отступы', place, mentions: [boris.id, stranger.id] }, anna.token)).data;
    expect(root).toMatchObject({ thread: null, text: '@boris глянь отступы', place, author: { id: anna.id, name: 'anna' } });
    expect(root.mentions).toEqual([{ id: boris.id, name: 'boris' }]);
    expect(mails.map((m) => [m.to, m.subject])).toEqual([['boris@example.com', 'anna: упоминание в «Макет»']]);
    expect((await api('GET', '/api/notifications', undefined, boris.token)).data).toMatchObject({
      unread: 2,
      notifications: [
        { kind: 'mention', file: { id: file.id, name: 'Макет' }, thread: root.id, actor: { name: 'anna' } },
        { kind: 'share', file: { id: file.id }, text: 'comment' },
      ],
    });

    // Boris's reply goes to Anna (a thread participant); a viewer cannot write.
    const reply = (await api('POST', `/api/files/${file.id}/comments`, { text: 'Поправил', thread: root.id }, boris.token)).data;
    expect(reply.thread).toBe(root.id);
    expect(mails.at(-1)).toMatchObject({ to: 'anna@example.com', subject: 'boris: ответ в «Макет»' });
    expect((await api('POST', `/api/files/${file.id}/comments`, { text: 'А я?', thread: root.id }, viktor.token)).status).toBe(403);
    expect((await api('POST', `/api/files/${file.id}/comments`, { text: 'тред без места' }, boris.token)).status).toBe(400);

    // Reactions: add one, a second one, remove.
    await api('PUT', `/api/comments/${root.id}/reactions`, { emoji: '👍', on: true }, boris.token);
    const liked = (await api('PUT', `/api/comments/${root.id}/reactions`, { emoji: '👍', on: true }, anna.token)).data;
    expect(liked.reactions).toEqual([{ emoji: '👍', users: [{ id: boris.id, name: 'boris' }, { id: anna.id, name: 'anna' }] }]);
    expect((await api('PUT', `/api/comments/${root.id}/reactions`, { emoji: '👍', on: false }, boris.token)).data.reactions).toEqual([{ emoji: '👍', users: [{ id: anna.id, name: 'anna' }] }]);

    // Others' comments cannot be edited; a commenter can resolve; the author or an editor can move.
    expect((await api('PATCH', `/api/comments/${root.id}`, { text: 'взлом' }, boris.token)).status).toBe(403);
    expect((await api('PATCH', `/api/comments/${root.id}`, { resolved: true }, boris.token)).data.resolved).toBeGreaterThan(0);
    expect((await api('PATCH', `/api/comments/${root.id}`, { place: { ...place, at: [0, 0] } }, boris.token)).status).toBe(403);
    expect((await api('PATCH', `/api/comments/${root.id}`, { place: { ...place, at: [5, 5] } }, anna.token)).data.place.at).toEqual([5, 5]);
    const edited = (await api('PATCH', `/api/comments/${reply.id}`, { text: 'Поправил, проверь' }, boris.token)).data;
    expect(edited.edited).toBeGreaterThan(0);

    // List for a viewer; deletion: others' — not allowed, the file owner — allowed.
    const list = (await api('GET', `/api/files/${file.id}/comments`, undefined, viktor.token)).data.comments as Json[];
    expect(list.map((c) => c.text)).toEqual(['@boris глянь отступы', 'Поправил, проверь']);
    expect((await api('DELETE', `/api/comments/${root.id}`, undefined, boris.token)).status).toBe(403);
    expect((await api('DELETE', `/api/comments/${reply.id}`, undefined, anna.token)).status).toBe(200);
    expect(((await api('GET', `/api/files/${file.id}/comments`, undefined, anna.token)).data.comments as Json[]).length).toBe(1);

    // Read notifications.
    await api('POST', '/api/notifications/read', {}, boris.token);
    expect((await api('GET', '/api/notifications', undefined, boris.token)).data.unread).toBe(0);
  });

  it('attachments: upload, linking, serving, deletion together with the thread', async () => {
    const anna = await login('anna@example.com');
    const file = (await api('POST', '/api/files', { name: 'Макет' }, anna.token)).data;
    const base = `http://localhost:${server.port}`;
    const auth = { authorization: `Bearer ${anna.token}` };
    const up = async (name: string, type: string, bytes: Uint8Array) =>
      (await (await fetch(`${base}/api/files/${file.id}/attachments?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: bytes as BodyInit })).json()) as Json;
    const png = await up('экран.png', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const html = await up('page.html', 'text/html', new TextEncoder().encode('<script>alert(1)</script>'));
    const root = (await api('POST', `/api/files/${file.id}/comments`, { text: '', place, attachments: [png.id, html.id] }, anna.token)).data;
    expect(root.attachments.map((a: Json) => a.name)).toEqual(['экран.png', 'page.html']);
    const img = await fetch(`${base}/api/attachments/${png.id}`, { headers: auth });
    expect([img.status, img.headers.get('content-type'), img.headers.get('content-disposition')?.startsWith('inline')]).toEqual([200, 'image/png', true]);
    const page = await fetch(`${base}/api/attachments/${html.id}`, { headers: auth });
    // HTML is not served as a page: download only, sandboxed.
    expect([page.headers.get('content-type'), page.headers.get('content-disposition')?.startsWith('attachment'), page.headers.get('content-security-policy')]).toEqual(['application/octet-stream', true, "default-src 'none'; sandbox"]);
    expect((await fetch(`${base}/api/attachments/${png.id}`)).status).toBe(404);
    await api('DELETE', `/api/comments/${root.id}`, undefined, anna.token);
    expect((await fetch(`${base}/api/attachments/${png.id}`, { headers: auth })).status).toBe(404);
  });

  it('live: participants of an open file receive comments as events', async () => {
    const anna = await login('anna@example.com');
    const boris = await login('boris@example.com');
    const file = (await api('POST', '/api/files', { name: 'Макет' }, anna.token)).data;
    await api('POST', `/api/files/${file.id}/access`, { email: 'boris@example.com', role: 'comment' }, anna.token);
    const ws = new WebSocket(`ws://localhost:${server.port}/file/${file.id}?token=${anna.token}`);
    const events: Json[] = [];
    await new Promise<void>((resolve) =>
      ws.on('message', (data: Buffer) => {
        const b = new Uint8Array(data);
        if (b[0] === 1) resolve();
        if (b[0] === 6) events.push(JSON.parse(new TextDecoder().decode(b.subarray(1))));
      }),
    );
    const root = (await api('POST', `/api/files/${file.id}/comments`, { text: 'Привет', place }, boris.token)).data;
    await api('DELETE', `/api/comments/${root.id}`, undefined, boris.token);
    await new Promise((r) => setTimeout(r, 100));
    expect(events.map((e) => e.type)).toEqual(['comment', 'comment-deleted']);
    expect(events[0]!.comment).toMatchObject({ id: root.id, text: 'Привет', author: { name: 'boris' } });
    ws.close();
  });
});
