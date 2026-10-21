import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LoroDoc, type TreeID } from 'loro-crdt';
import { startServer, type RunningServer } from '../src/server.ts';
import type { Mail } from '../src/util.ts';
import { testDb } from './db.ts';

let dir: string;
let server: RunningServer;
let mails: Mail[];
let tdb: Awaited<ReturnType<typeof testDb>>;

beforeEach(async () => {
  tdb = await testDb();
  dir = mkdtempSync(join(tmpdir(), 'mfp-pages-'));
  mails = [];
  server = await startServer({ port: 0, dir, pingMs: 60_000, db: tdb.db, mailer: { send: async (m) => void mails.push(m) } });
});

afterEach(async () => {
  await server.close();
  await tdb.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${server.port}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

async function login(email: string): Promise<string> {
  await api('POST', '/api/auth/code', { email });
  const code = /код для входа (\d{6})/.exec(mails.filter((m) => m.to === email).at(-1)!.subject)![1]!;
  return (await api('POST', '/api/auth/verify', { email, code })).data.token as string;
}

interface Peer {
  ws: WebSocket;
  doc: LoroDoc;
  errors: string[];
}

function connect(fileId: string, token: string): Promise<Peer> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/file/${fileId}?token=${token}`);
    const doc = new LoroDoc();
    const errors: string[] = [];
    ws.on('message', (data: Buffer) => {
      const b = new Uint8Array(data);
      if (b[0] === 5) {
        const m = JSON.parse(new TextDecoder().decode(b.subarray(1)));
        if (m.error) errors.push(m.error);
      } else if (b[0] === 1) {
        doc.import(b.subarray(1));
        resolve({ ws, doc, errors });
      } else if (b[0] === 2) doc.import(b.subarray(1));
    });
  });
}

/** Edit one's own copy and send it as an update (like the editor's Loro bridge). */
function edit(p: Peer, fn: (doc: LoroDoc) => void) {
  const before = p.doc.oplogVersion();
  fn(p.doc);
  p.doc.commit();
  const u = p.doc.export({ mode: 'update', from: before });
  const out = new Uint8Array(u.length + 1);
  out[0] = 2;
  out.set(u, 1);
  p.ws.send(out);
}

const settle = () => new Promise((r) => setTimeout(r, 250));

describe('page-level permissions', () => {
  it('a protected page is edited by the owner and listed users; others cannot, nor can they remove the protection', async () => {
    const anna = await login('anna@example.com');
    const file = (await api('POST', '/api/files', { name: 'Mockup' }, anna)).data;
    await api('POST', `/api/files/${file.id}/access`, { email: 'boris@example.com', role: 'edit' }, anna);
    await api('POST', `/api/files/${file.id}/access`, { email: 'viktor@example.com', role: 'edit' }, anna);
    const boris = await login('boris@example.com');
    const viktor = await login('viktor@example.com');
    const viktorId = ((await api('GET', '/api/me', undefined, viktor)).data.user as { id: string }).id;
    const a = await connect(file.id as string, anna);
    // Owner: page “Brand” (protected, Viktor can edit) and “Drafts”.
    let rectA: TreeID = '0@0';
    let rectB: TreeID = '0@0';
    let brand: TreeID = '0@0';
    edit(a, (d) => {
      const t = d.getTree('nodes');
      t.enableFractionalIndex(0);
      const p1 = t.createNode();
      p1.data.set('type', 'PAGE');
      p1.data.set('name', 'Brand');
      p1.data.set('pageProtection', { editors: [viktorId] });
      const r1 = t.createNode(p1.id);
      r1.data.set('type', 'RECTANGLE');
      r1.data.set('width', 10);
      const p2 = t.createNode();
      p2.data.set('type', 'PAGE');
      p2.data.set('name', 'Drafts');
      const r2 = t.createNode(p2.id);
      r2.data.set('type', 'RECTANGLE');
      r2.data.set('width', 10);
      [brand, rectA, rectB] = [p1.id, r1.id, r2.id];
    });
    await settle();
    const b = await connect(file.id as string, boris);
    const v = await connect(file.id as string, viktor);
    // Boris: “Brand” — not allowed, “Drafts” — allowed; removing protection — not allowed.
    edit(b, (d) => d.getTree('nodes').getNodeByID(rectA)!.data.set('width', 99));
    await settle();
    expect(b.errors.at(-1)).toMatch(/«Brand» защищена/);
    const b2 = await connect(file.id as string, boris);
    edit(b2, (d) => d.getTree('nodes').getNodeByID(rectB)!.data.set('width', 20));
    edit(b2, (d) => d.getTree('nodes').getNodeByID(brand)!.data.set('pageProtection', null));
    await settle();
    expect(b2.errors.at(-1)).toMatch(/защита страниц/);
    // Viktor is in the list: editing is allowed.
    edit(v, (d) => d.getTree('nodes').getNodeByID(rectA)!.data.set('width', 30));
    await settle();
    expect(v.errors).toEqual([]);
    const snap = new LoroDoc();
    snap.import(new Uint8Array(await (await fetch(`http://localhost:${server.port}/api/files/${file.id}/doc`, { headers: { authorization: `Bearer ${anna}` } })).arrayBuffer()));
    const t = snap.getTree('nodes');
    expect(t.getNodeByID(rectA)!.data.get('width')).toBe(30);
    expect(t.getNodeByID(rectB)!.data.get('width')).toBe(20);
    expect(t.getNodeByID(brand)!.data.get('pageProtection')).toEqual({ editors: [viktorId] });
    for (const p of [a, b, b2, v]) p.ws.close();
  });
});
