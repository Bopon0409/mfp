import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { LoroBridge } from '@mfp/sync';
import { startServer, type RunningServer } from '../src/server.ts';
import type { Mail } from '../src/util.ts';
import { testDb } from './db.ts';

let dir: string;
let server: RunningServer;
let mails: Mail[];
let tdb: Awaited<ReturnType<typeof testDb>>;
let base: string;
/** Stub for external services: what arrived, and how to respond. */
let mock: Server;
let mockBase: string;
let hits: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[];
let replies: ((path: string) => { status: number; body?: unknown } | null)[];

beforeEach(async () => {
  tdb = await testDb();
  dir = mkdtempSync(join(tmpdir(), 'mfp-public-'));
  mails = [];
  hits = [];
  replies = [];
  server = await startServer({ port: 0, dir, pingMs: 60_000, db: tdb.db, mailer: { send: async (m) => void mails.push(m) }, hooks: { allowPrivate: true, retryMs: [40, 40, 40], tickMs: 20, updateDelayMs: 30 } });
  base = `http://localhost:${server.port}`;
  mock = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body });
      const r = replies.map((f) => f(req.url ?? '')).find(Boolean) ?? { status: 200, body: { ok: true } };
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((r) => mock.listen(0, r));
  mockBase = `http://localhost:${(mock.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await server.close();
  await tdb.dispose();
  await new Promise((r) => mock.close(r));
  rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: Json; headers: Headers }> {
  const binary = body instanceof Uint8Array;
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : binary ? (body as BodyInit) : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : { text }, headers: res.headers };
}

async function login(email: string): Promise<string> {
  await api('POST', '/api/auth/code', { email });
  const code = /(\d{6})/.exec(mails.filter((m) => m.to === email).at(-1)!.subject)![1]!;
  return (await api('POST', '/api/auth/verify', { email, code })).data.token;
}

/** Team file with a document: a page, frame “Screen”, with rectangle “Button” inside it. */
async function setup() {
  const anna = await login('anna@example.com');
  const pat = (await api('POST', '/api/tokens', { name: 'CI' }, anna)).data.token as string;
  const team = (await api('POST', '/api/teams', { name: 'Studio' }, anna)).data;
  const doc = new Document({ clientId: 5 });
  const page = doc.create('PAGE', doc.root, { name: 'Page 1' });
  const frame = doc.create('FRAME', page, { name: 'Screen', width: 200, height: 100, transform: [1, 0, 10, 0, 1, 20], fills: [{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1 }, opacity: 1, visible: true }] });
  const rect = doc.create('RECTANGLE', frame, { name: 'Button', width: 80, height: 30, transform: [1, 0, 20, 0, 1, 30], fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }] });
  const bridge = new LoroBridge(doc);
  const file = (await api('POST', `/api/files?name=${encodeURIComponent('Mockup')}&projectId=${team.projectId}`, bridge.loro.export({ mode: 'snapshot' }), anna)).data;
  return { anna, pat, team, file, page, frame, rect };
}

describe('REST v1', () => {
  it('JSON document, nodes, image, comment on a layer', async () => {
    const { pat, file, page, frame, rect } = await setup();
    expect((await api('GET', '/v1/me', undefined, pat)).data).toMatchObject({ handle: 'anna', email: 'anna@example.com' });
    const f = (await api('GET', `/v1/files/${file.id}?depth=2`, undefined, pat)).data;
    expect(f.name).toBe('Mockup');
    expect(f.document.children[0]).toMatchObject({ id: page, type: 'PAGE', name: 'Page 1', children: [{ id: frame, type: 'FRAME', name: 'Screen', childCount: 1 }] });
    const nodes = (await api('GET', `/v1/files/${file.id}/nodes?ids=${rect},none`, undefined, pat)).data.nodes;
    expect(nodes[rect].document).toMatchObject({ type: 'RECTANGLE', name: 'Button', width: 80 });
    expect(nodes['none']).toBeNull();
    // Node image — PNG from the server.
    const urls = (await api('GET', `/v1/images/${file.id}?ids=${frame}&scale=1`, undefined, pat)).data.images;
    const png = await fetch(urls[frame], { headers: { authorization: `Bearer ${pat}` } });
    expect(png.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await png.arrayBuffer()).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // Comment on a layer: the position is in layer coordinates.
    const c = (await api('POST', `/v1/files/${file.id}/comments`, { message: 'Button too small', client_meta: { node_id: rect, node_offset: { x: 5, y: 6 } } }, pat)).data;
    await api('POST', `/v1/files/${file.id}/comments`, { message: 'Agreed', comment_id: c.id }, pat);
    const list = (await api('GET', `/v1/files/${file.id}/comments`, undefined, pat)).data.comments as Json[];
    expect(list.map((x) => [x.message, x.parent_id, x.client_meta])).toEqual([
      ['Button too small', '', { node_id: rect, node_offset: { x: 5, y: 6 } }],
      ['Agreed', c.id, null],
    ]);
  }, 30_000);
});

describe('webhooks and integrations', () => {
  it('webhook: HMAC signature, retry after an error, log', async () => {
    const { pat, team, file } = await setup();
    const hook = (await api('POST', '/v1/webhooks', { event_type: 'FILE_COMMENT', team_id: team.id, endpoint: `${mockBase}/hook`, passcode: 'secret' }, pat)).data;
    expect(hook).toMatchObject({ event_type: 'FILE_COMMENT', team_id: team.id, endpoint: `${mockBase}/hook`, status: 'ACTIVE', passcode: 'secret' });
    // The subscriber fails the first time, then accepts.
    let fails = 1;
    replies.push((p) => (p === '/hook' && fails-- > 0 ? { status: 500 } : null));
    await api('POST', `/v1/files/${file.id}/comments`, { message: 'Hello', client_meta: { x: 1, y: 2 } }, pat);
    await new Promise((r) => setTimeout(r, 300));
    const got = hits.filter((h) => h.path === '/hook');
    expect(got.length).toBe(2);
    const body = JSON.parse(got[1]!.body);
    expect(body).toMatchObject({ event_type: 'FILE_COMMENT', file_key: file.id, file_name: 'Mockup', passcode: 'secret', triggered_by: { handle: 'anna' }, comment: [{ text: 'Hello' }] });
    expect(got[1]!.headers['x-mfp-signature']).toBe(`sha256=${createHmac('sha256', 'secret').update(got[1]!.body).digest('hex')}`);
    const reqs = (await api('GET', `/v1/webhooks/${hook.id}/requests`, undefined, pat)).data.requests as Json[];
    expect(reqs[0]).toMatchObject({ event: 'FILE_COMMENT', status: 'ok', attempts: 2, responseStatus: 200 });
  });

  it('Slack, Telegram, Jira: messages, links in issues, an issue from a thread', async () => {
    const { anna, team, file } = await setup();
    await api('POST', '/api/hooks', { kind: 'slack', teamId: team.id, events: ['FILE_COMMENT', 'LIBRARY_PUBLISH'], config: { url: `${mockBase}/slack/T1/B2/xyz` } }, anna);
    await api('POST', '/api/hooks', { kind: 'telegram', teamId: team.id, events: ['FILE_COMMENT'], config: { token: '123:abc', chatId: '-100500', api: mockBase } }, anna);
    const jira = (await api('POST', '/api/hooks', { kind: 'jira', teamId: team.id, config: { baseUrl: `${mockBase}/jira`, email: 'bot@example.com', apiToken: 'jt', projectKey: 'ABC' } }, anna)).data;
    // Secrets are not exposed.
    expect(jira.config).toEqual({ baseUrl: `${mockBase}/jira`, email: 'bot@example.com', projectKey: 'ABC', apiToken: '…jt' });
    replies.push((p) => (p === '/jira/rest/api/3/issue' ? { status: 201, body: { key: 'ABC-13' } } : null));
    const c = (await api('POST', `/api/files/${file.id}/comments`, { text: 'Fix the spacing, see ABC-12', place: { page: 'p', at: [0, 0] } }, anna)).data;
    await new Promise((r) => setTimeout(r, 300));
    const slack = JSON.parse(hits.find((h) => h.path === '/slack/T1/B2/xyz')!.body);
    expect(slack.text).toContain('💬 anna в «Mockup»: Fix the spacing, see ABC-12');
    const tg = JSON.parse(hits.find((h) => h.path === '/bot123:abc/sendMessage')!.body);
    expect(tg).toMatchObject({ chat_id: '-100500', parse_mode: 'HTML' });
    const jc = hits.find((h) => h.path === '/jira/rest/api/3/issue/ABC-12/comment')!;
    expect(jc.headers.authorization).toBe(`Basic ${Buffer.from('bot@example.com:jt').toString('base64')}`);
    expect(JSON.stringify(JSON.parse(jc.body).body)).toContain('Fix the spacing');
    expect(JSON.parse(hits.find((h) => h.path === '/jira/rest/api/3/issue/ABC-12/remotelink')!.body).object.url).toContain(`#file=${file.id}&comment=${c.id}`);
    // Task from a thread — a reply in the thread with a link.
    const issue = (await api('POST', `/api/comments/${c.id}/jira`, undefined, anna)).data;
    expect(issue).toEqual({ key: 'ABC-13', url: `${mockBase}/jira/browse/ABC-13` });
    expect(JSON.parse(hits.find((h) => h.path === '/jira/rest/api/3/issue')!.body).fields).toMatchObject({ project: { key: 'ABC' }, summary: 'Fix the spacing, see ABC-12', issuetype: { name: 'Task' } });
    const thread = (await api('GET', `/api/files/${file.id}/comments`, undefined, anna)).data.comments as Json[];
    expect(thread.at(-1)).toMatchObject({ thread: c.id, text: `Задача ABC-13: ${mockBase}/jira/browse/ABC-13` });
  });

  it('by default — only https and not into the internal network', async () => {
    const sdb = await testDb();
    const strict = await startServer({ port: 0, dir: mkdtempSync(join(tmpdir(), 'mfp-strict-')), pingMs: 60_000, db: sdb.db, mailer: { send: async (m) => void mails.push(m) } });
    try {
      const b = `http://localhost:${strict.port}`;
      const call = async (path: string, body: unknown, token?: string) =>
        (await fetch(b + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json() as Promise<Json>;
      await call('/api/auth/code', { email: 'z@example.com' });
      const code = /(\d{6})/.exec(mails.filter((m) => m.to === 'z@example.com').at(-1)!.subject)![1]!;
      const token = (await call('/api/auth/verify', { email: 'z@example.com', code })).token;
      const team = await call('/api/teams', { name: 'T' }, token);
      expect((await call('/v1/webhooks', { event_type: 'FILE_COMMENT', team_id: team.id, endpoint: 'http://example.com/x' }, token)).error).toBe('Нужен адрес https://');
      expect((await call('/v1/webhooks', { event_type: 'FILE_COMMENT', team_id: team.id, endpoint: 'https://127.0.0.1/x' }, token)).error).toBe('Адреса во внутренней сети запрещены');
      expect((await call('/v1/webhooks', { event_type: 'FILE_COMMENT', team_id: team.id, endpoint: 'https://[::1]/x' }, token)).error).toBe('Адреса во внутренней сети запрещены');
      expect((await call('/v1/webhooks', { event_type: 'FILE_COMMENT', team_id: team.id, endpoint: 'https://[::ffff:127.0.0.1]/x' }, token)).error).toBe('Адреса во внутренней сети запрещены');
      expect((await call('/v1/webhooks', { event_type: 'FILE_COMMENT', team_id: team.id, endpoint: 'https://[::ffff:a9fe:a9fe]/x' }, token)).error).toBe('Адреса во внутренней сети запрещены');
    } finally {
      await strict.close();
      await sdb.dispose();
    }
  });
});

describe('MCP over the network', () => {
  it('session, server files, edits for everyone, view only', async () => {
    const { anna, pat, file, rect } = await setup();
    const rpc = async (body: unknown, sid?: string, token = pat) => {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, sid: res.headers.get('mcp-session-id') ?? '', data: text ? JSON.parse(text) : null };
    };
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    // MCP clients: GET without a stream — 405; OAuth metadata is JSON, not the editor page.
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${pat}` } })).status).toBe(405);
    const wk = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(wk.status).toBe(200);
    expect(wk.headers.get('content-type')).toContain('application/json');
    expect((await fetch(`${base}/.well-known/oauth-unknown`)).status).toBe(404);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(400);
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init.data.result.serverInfo.name).toBe('mfp-server');
    const sid = init.sid;
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid)).status).toBe(202);
    const names = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid)).data.result.tools.map((t: Json) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_files', 'open_file', 'get_comments', 'add_comment', 'get_tree', 'set_properties', 'render_png', 'get_design_context']));
    const call = async (name: string, args: Json = {}, s = sid, token = pat) => (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, s, token)).data.result;
    expect(JSON.parse((await call('list_files')).content[0].text)).toMatchObject([{ id: file.id, name: 'Mockup', where: 'Studio / Проект', role: 'owner' }]);
    expect((await call('get_tree')).isError).toBe(true);
    await call('open_file', { file_id: file.id });
    // The agent's edit lands in the live file (and reaches connected participants).
    expect((await call('set_properties', { id: rect, props: { name: 'Button OK' } })).isError).toBeUndefined();
    const live = new Document({ clientId: 9 });
    const lb = new LoroBridge(live);
    lb.importUpdate(new Uint8Array(await (await fetch(`${base}/api/files/${file.id}/doc`, { headers: { authorization: `Bearer ${anna}` } })).arrayBuffer()));
    expect(live.get(rect, 'name')).toBe('Button OK');
    await call('add_comment', { text: 'Renamed the button', node_id: rect });
    expect(JSON.parse((await call('get_comments')).content[0].text)).toMatchObject([{ author: 'anna', text: 'Renamed the button', node: rect }]);
    // Viewer: may read, may not edit.
    await api('POST', `/api/files/${file.id}/access`, { email: 'boris@example.com', role: 'view' }, anna);
    const boris = await login('boris@example.com');
    const bsid = (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, undefined, boris)).sid;
    await call('open_file', { file_id: file.id }, bsid, boris);
    expect(JSON.parse((await call('get_node', { id: rect }, bsid, boris)).content[0].text).name).toBe('Button OK');
    const denied = await call('set_properties', { id: rect, props: { name: 'hack' } }, bsid, boris);
    expect([denied.isError, denied.content[0].text]).toEqual([true, 'Ошибка: Только просмотр: у вас нет права на правку этого файла']);
    // Someone else's session with someone else's token — as if it does not exist.
    expect((await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, sid, boris)).status).toBe(404);
  }, 30_000);
});

describe('OAuth for MCP clients', () => {
  it('metadata, registration, authorization, token via PKCE, work through /mcp', async () => {
    const { anna, file } = await setup();
    const json = async (r: Response) => ({ status: r.status, data: (await r.json()) as Json });
    // A 401 from /mcp points to the metadata.
    const denied = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(denied.headers.get('www-authenticate')).toContain('resource_metadata="http://localhost:');
    const prm = await json(await fetch(`${base}/.well-known/oauth-protected-resource`));
    expect(prm.data.resource).toBe(`${base}/mcp`);
    const meta = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
    expect(meta.data).toMatchObject({ issuer: base, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, code_challenge_methods_supported: ['S256'] });
    // Registration: only https or local http.
    const bad = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
    expect(bad.status).toBe(400);
    const redirect = 'https://claude.ai/api/mcp/auth_callback';
    const reg = await json(await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }) }));
    expect(reg.status).toBe(201);
    const clientId = reg.data.client_id as string;
    // Confirmation page: who requests access (only when signed in to the editor).
    expect((await api('GET', `/api/oauth/client?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}`, undefined, anna)).data).toEqual({ name: 'Claude', host: 'claude.ai' });
    const verifier = 'v'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = { response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };
    // Denial — an error sent to the redirect address.
    const deny = new URL((await api('POST', '/api/oauth/approve', { ...params, deny: true }, anna)).data.redirect as string);
    expect([deny.searchParams.get('error'), deny.searchParams.get('state')]).toEqual(['access_denied', 'xyz']);
    const ok = new URL((await api('POST', '/api/oauth/approve', params, anna)).data.redirect as string);
    expect(ok.origin + ok.pathname).toBe(redirect);
    const code = ok.searchParams.get('code')!;
    const form = (o: Record<string, string>) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
    // Wrong verifier — rejected, and the code is no longer valid.
    expect((await json(await form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: 'x'.repeat(50) }))).data.error).toBe('invalid_grant');
    expect((await json(await form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }))).data.error).toBe('invalid_grant');
    // New code — token.
    const code2 = new URL((await api('POST', '/api/oauth/approve', params, anna)).data.redirect as string).searchParams.get('code')!;
    const tok = await json(await form({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }));
    expect(tok.data).toMatchObject({ token_type: 'Bearer' });
    const access = tok.data.access_token as string;
    // The token works in MCP and is visible in “API tokens”.
    const init = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id')!;
    const list = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access}`, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_files', arguments: {} } }) });
    expect(JSON.parse(((await list.json()) as Json).result.content[0].text)[0].id).toBe(file.id);
    expect(((await api('GET', '/api/tokens', undefined, anna)).data.tokens as Json[]).map((t) => t.name)).toContain('ИИ: Claude');
    // An API token cannot approve access (only an editor sign-in can).
    expect((await api('POST', '/api/oauth/approve', params, access)).status).toBe(401);
  });
});
