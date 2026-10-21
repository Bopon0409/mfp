import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Document } from '@mfp/core';
import type { Editor } from '../src/editor.ts';
import type { ToEditor, ToPlayer } from '../src/player/protocol.ts';

vi.mock('../src/platform.ts', () => ({ isDesktop: true }));
vi.mock('../src/preview.ts', () => ({ presentInPage: vi.fn() }));
import { playerUrl } from '../src/present.ts';

class Channel {
  static all: Channel[] = [];
  onmessage: ((event: { data: ToEditor }) => Promise<void>) | null = null;
  sent: ToPlayer[] = [];
  closed = false;
  constructor(readonly name: string) { Channel.all.push(this); }
  postMessage(message: ToPlayer) { if (this.closed) throw new Error('Closed channel'); this.sent.push(message); }
  close() { this.closed = true; }
  receive(data: ToEditor) { return this.onmessage!({ data }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  Channel.all = [];
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { setTimeout });
  vi.stubGlobal('location', { pathname: '/' });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('presentation retains its document and images when the editor changes files', async () => {
  const first = new Document({ clientId: 1 });
  const page = first.create('PAGE', first.root, { name: 'First page' });
  const frame = first.create('FRAME', page, { name: 'First frame', width: 100, height: 100 });
  const oldRead = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const editor = { doc: first, pageId: page, selection: [frame], store: { readImage: oldRead } } as unknown as Editor;
  let name = 'First file';
  const url = playerUrl(editor, () => name);
  const channel = Channel.all[0]!;
  await channel.receive({ type: 'hello', from: 'player', page });
  expect(playerUrl(editor, () => name)).toBe(url);
  const second = new Document({ clientId: 2 });
  editor.doc = second;
  editor.pageId = second.create('PAGE', second.root, { name: 'Second page' });
  editor.selection = [];
  editor.store = { readImage: vi.fn(async () => new Uint8Array([9])) } as unknown as Editor['store'];
  name = 'Second file';
  await channel.receive({ type: 'hello', from: 'player', page });
  const reply = channel.sent.at(-1)!;
  expect(reply.type).toBe('doc');
  if (reply.type === 'doc') {
    expect(reply.name).toBe('First file');
    expect(reply.snapshot.nodes.some((n) => n.id === frame)).toBe(true);
  }
  await channel.receive({ type: 'image', from: 'player', hash: 'image', id: 1 });
  expect(oldRead).toHaveBeenCalledWith('image');
  expect(channel.sent.at(-1)).toMatchObject({ type: 'image', bytes: new Uint8Array([1, 2, 3]) });
  expect(playerUrl(editor, () => name)).not.toBe(url);
  await channel.receive({ type: 'bye', from: 'player' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(channel.closed).toBe(true);
  const count = channel.sent.length;
  first.set(frame, { name: 'Changed after closing' });
  await vi.advanceTimersByTimeAsync(500);
  expect(channel.sent).toHaveLength(count);
});
