import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Document } from '@mfp/core';
import { hasNodes, LoroBridge } from '@mfp/sync';
import { PRESENCE, SIGNAL, SNAPSHOT, startServer, UPDATE, type RunningServer } from '../src/server.ts';

const frame = (type: number, data: Uint8Array) => {
  const out = new Uint8Array(data.length + 1);
  out[0] = type;
  out.set(data, 1);
  return out;
};
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** Room participant: own document, Loro bridge and a connection to the server. */
interface Peer {
  ws: WebSocket;
  doc: Document;
  presence: Record<string, unknown>[];
  close(): Promise<void>;
}

let dir: string;
let server: RunningServer;
let clientId = 10;

async function enter(room: string, doc = new Document({ clientId: clientId++ })): Promise<Peer & { snapshotHadNodes: boolean }> {
  const ws = new WebSocket(`ws://localhost:${server.port}/room/${room}`);
  const presence: Record<string, unknown>[] = [];
  let bridge: LoroBridge | null = null;
  const early: Uint8Array[] = [];
  const snapshot = new Promise<Uint8Array>((resolve) => {
    ws.on('message', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      if (bytes[0] === SNAPSHOT) resolve(bytes.subarray(1));
      else if (bytes[0] === UPDATE) bridge ? bridge.importUpdate(bytes.subarray(1)) : early.push(bytes.subarray(1));
      else if (bytes[0] === PRESENCE) presence.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
    });
  });
  const snap = await snapshot;
  const b = new LoroBridge(doc);
  b.importUpdate(snap);
  for (const u of early) b.importUpdate(u);
  bridge = b;
  ws.send(frame(UPDATE, b.exportUpdate()));
  b.loro.subscribeLocalUpdates((u: Uint8Array) => ws.send(frame(UPDATE, u)));
  return {
    ws,
    doc,
    presence,
    snapshotHadNodes: hasNodes(snap),
    close: () =>
      new Promise((done) => {
        b.dispose();
        ws.once('close', () => done());
        ws.close();
      }),
  };
}

const names = (doc: Document) => [...doc.descendants(doc.root)].map((id) => doc.get(id, 'name'));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mfp-rooms-'));
  server = await startServer({ port: 0, dir });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('collaboration server', () => {
  it('the second participant receives the first one\'s document, edits flow both ways', async () => {
    const docA = new Document({ clientId: 1 });
    const page = docA.create('PAGE', docA.root, { name: 'Страница' });
    const card = docA.create('RECTANGLE', page, { name: 'Карточка', width: 100, height: 60 });
    docA.clearHistory();
    const a = await enter('team', docA);
    const b = await enter('team');
    await vi.waitFor(() => expect(names(b.doc)).toEqual(['Страница', 'Карточка']));

    // Concurrent edits to different properties of the same node converge for both.
    a.doc.transact(() => a.doc.set(card, { width: 240 }));
    b.doc.transact(() => b.doc.set(card, { name: 'Карточка товара' }));
    for (const p of [a, b]) {
      await vi.waitFor(() => {
        expect(p.doc.get(card, 'width')).toBe(240);
        expect(p.doc.get(card, 'name')).toBe('Карточка товара');
      });
    }
    // Others' edits do not get into one's own undo history.
    expect(a.doc.undoDepth).toBe(1);
    a.doc.undo();
    await vi.waitFor(() => expect(b.doc.get(card, 'width')).toBe(100));
    expect(b.doc.get(card, 'name')).toBe('Карточка товара');
    await a.close();
    await b.close();
  });

  it('presence: forwarded, a newcomer sees those already in, leaving is announced', async () => {
    const a = await enter('cursors');
    a.ws.send(frame(PRESENCE, json({ id: 'anna', name: 'Анна', x: 10, y: 20 })));
    const b = await enter('cursors');
    await vi.waitFor(() => expect(b.presence.map((p) => p.name)).toContain('Анна'));
    b.ws.send(frame(PRESENCE, json({ id: 'boris', name: 'Борис', x: 1, y: 2 })));
    await vi.waitFor(() => expect(a.presence.map((p) => p.name)).toContain('Борис'));
    await b.close();
    await vi.waitFor(() => expect(a.presence.at(-1)).toEqual({ id: 'boris', leave: true }));
    await a.close();
  });

  it('a room is saved to disk and survives a server restart', async () => {
    const doc = new Document({ clientId: 3 });
    const page = doc.create('PAGE', doc.root, { name: 'Макет' });
    doc.create('ELLIPSE', page, { name: 'Круг' });
    const a = await enter('saved', doc);
    await a.close();
    // The last participant left: the room is written and unloaded from memory.
    await vi.waitFor(() => expect(server.rooms).toBe(0));
    expect(existsSync(join(dir, 'saved.loro'))).toBe(true);

    await server.close();
    server = await startServer({ port: 0, dir });
    const b = await enter('saved');
    expect(b.snapshotHadNodes).toBe(true);
    expect(names(b.doc)).toEqual(['Макет', 'Круг']);
    await b.close();
  });

  it('images: the key is checked against the content, stored once', async () => {
    const base = `http://localhost:${server.port}/image`;
    const bytes = new TextEncoder().encode('не совсем PNG, но байты есть байты');
    const hash = createHash('sha1').update(bytes).digest('hex');
    expect((await fetch(`${base}/${hash}`)).status).toBe(404);
    // Wrong key — rejected.
    const wrong = 'a'.repeat(40);
    expect((await fetch(`${base}/${wrong}`, { method: 'PUT', body: bytes })).status).toBe(400);
    expect((await fetch(`${base}/${hash}`, { method: 'PUT', body: bytes })).status).toBe(201);
    expect((await fetch(`${base}/${hash}`, { method: 'HEAD' })).status).toBe(200);
    const got = new Uint8Array(await (await fetch(`${base}/${hash}`)).arrayBuffer());
    expect(got).toEqual(bytes);
    // Uploading the same image again — no errors.
    expect((await fetch(`${base}/${hash}`, { method: 'PUT', body: bytes })).status).toBe(201);
  });
  it('serves cached resized previews while preserving original bytes and transparency', async () => {
    const original = await sharp({ create: { width: 1000, height: 500, channels: 4, background: { r: 80, g: 140, b: 200, alpha: 0.5 } } }).png().toBuffer();
    const hash = createHash('sha1').update(original).digest('hex');
    const url = `http://localhost:${server.port}/image/${hash}`;
    expect((await fetch(url, { method: 'PUT', body: original })).status).toBe(201);
    const response = await fetch(`${url}?size=256`);
    expect(response.headers.get('content-type')).toBe('image/webp');
    const preview = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(preview).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([256, 128, true]);
    expect(Buffer.from(await (await fetch(`${url}?size=256`)).arrayBuffer())).toEqual(preview);
    expect(Buffer.from(await (await fetch(url)).arrayBuffer())).toEqual(original);
    expect((await fetch(`${url}?size=999999`)).status).toBe(400);
    expect((await fetch(`http://localhost:${server.port}/image/${'e'.repeat(40)}?size=256`)).status).toBe(404);
  });
});

describe('voice: WebRTC signals', () => {
  it('a signal goes only to the recipient, the sender is taken from their presence (cannot be spoofed)', async () => {
    const a = await enter('voice');
    const b = await enter('voice');
    const c = await enter('voice');
    const got = (p: Peer) => {
      const list: Record<string, unknown>[] = [];
      p.ws.on('message', (data: Buffer) => {
        const bytes = new Uint8Array(data);
        if (bytes[0] === SIGNAL) list.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
      });
      return list;
    };
    const atB = got(b);
    const atC = got(c);
    for (const [p, id] of [[a, 'aaa'], [b, 'bbb'], [c, 'ccc']] as const) p.ws.send(frame(PRESENCE, json({ id, name: id })));
    await vi.waitFor(() => expect(c.presence.length).toBeGreaterThanOrEqual(2));
    // Signing as someone else is impossible: the server sets from.
    a.ws.send(frame(SIGNAL, json({ to: 'bbb', from: 'ccc', kind: 'offer', sdp: 'x' })));
    await vi.waitFor(() => expect(atB.length).toBe(1));
    expect(atB[0]).toEqual({ to: 'bbb', from: 'aaa', kind: 'offer', sdp: 'x' });
    await new Promise((r) => setTimeout(r, 100));
    expect(atC).toEqual([]);
    // Without presence the signal is not forwarded.
    const d = await enter('voice');
    d.ws.send(frame(SIGNAL, json({ to: 'bbb', kind: 'ice' })));
    await new Promise((r) => setTimeout(r, 100));
    expect(atB.length).toBe(1);
    for (const p of [a, b, c, d]) await p.close();
  });

  it('/ice — STUN / TURN servers from settings', async () => {
    const s2 = await startServer({ port: 0, dir: mkdtempSync(join(tmpdir(), 'mfp-ice-')), iceServers: [{ urls: 'stun:stun.example.org:3478' }] });
    try {
      const res = await fetch(`http://localhost:${s2.port}/ice`);
      expect(await res.json()).toEqual([{ urls: 'stun:stun.example.org:3478' }]);
      expect(await (await fetch(`http://localhost:${server.port}/ice`)).json()).toEqual([]);
    } finally {
      await s2.close();
    }
  });
});
