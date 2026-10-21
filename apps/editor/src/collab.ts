// Collaboration: a room on the server (apps/server), the document syncs via the Loro
// CRDT (the @mfp/sync bridge), participants' cursors and selection — via presence messages.
//
// Joining a room: an empty room receives our document, a non-empty one replaces ours with its own.
// Other participants' edits arrive with origin 'loro': they don't enter our undo
// history and are not recomputed (their text sizes and layout are already computed).
//
// Connection dropped — we reconnect ourselves (1, 2, 4… 10 s). Edits made offline
// accumulate in Loro; on return the room snapshot merges with our state, and ours
// is sent to the others — the document is not replaced and nothing is lost.
//
// Images are not put into the CRDT (megabytes): the document references them by SHA-1, and the bytes
// themselves live on the room server. A participant uploads their own images there and downloads others'.
//
// A file on the server (connectFile) — the same protocol with permissions: the server first reports the role
// (frame 5), the document is always taken from the server (an empty one gets a first page), edits
// are sent only with edit permission. Access denied (close code 4403) — no reconnect.
//
// Presence also carries the visible area and page (follow a participant: click their avatar),
// “spotlight me” (the others start following on their own) and cursor chat (“/”).

import type { Canvas } from 'canvaskit-wasm';
import { Document, mediaHashes, type Op, type Props } from '@mfp/core';
import { imageHashes, type ImageBytesSource } from '@mfp/io-figma';
import { hasNodes, LoroBridge, loroReady } from '@mfp/sync';
import type { FileRole } from './account.ts';
import type { Editor } from './editor.ts';
import { FollowCamera } from './follow-camera.ts';
import { canFollow } from './follow-chain.ts';
import { t } from './i18n/index.ts';

const SNAPSHOT = 1;
const UPDATE = 2;
const PRESENCE = 3;
const INFO = 5;
const EVENT = 6;
/** Voice signals (WebRTC): the server sends them only to the addressee, setting the sender. */
const SIGNAL = 7;
const FORBIDDEN = 4403;
const COLORS = ['#f45a56', '#4d7bfd', '#40c786', '#ba82f5', '#ffb848', '#e0609a', '#2fb3b8'];
/** Presence — no more often than once per 50 ms (the last position is sent afterwards). */
const PRESENCE_MS = 50;

/** Room images on the server. */
class RoomImages implements ImageBytesSource {
  private base: string;
  private token: () => string | null;

  constructor(base: string, token: () => string | null = () => null) {
    this.base = base;
    this.token = token;
  }

  async readImage(hash: string): Promise<Uint8Array | undefined> {
    return this.read(hash);
  }
  async readImagePreview(hash: string, maxSide: number): Promise<Uint8Array | undefined> {
    const size = Math.max(128, Math.min(4096, 2 ** Math.ceil(Math.log2(maxSide))));
    return this.read(hash, size);
  }
  private async read(hash: string, size?: number): Promise<Uint8Array | undefined> {
    // A participant may have referenced an image before uploading it — wait.
    for (const wait of [0, 500, 1000, 2000, 4000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const res = await fetch(`${this.base}/image/${hash}${size ? `?size=${size}` : ''}`, { headers: this.token() ? { authorization: `Bearer ${this.token()}` } : {} }).catch(() => null);
      if (res?.ok) return new Uint8Array(await res.arrayBuffer());
      if (res && res.status !== 404) return undefined;
    }
    return undefined;
  }
}

/**
 * Media referenced by operations: images, videos, Lottie, 3D models, action sounds (in
 * fills, strokes, backgrounds, text styles and vector regions) — their bytes go to the server right away.
 */
export function opImages(ops: readonly Op[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.op !== 'create' && op.op !== 'set') continue;
    for (const h of mediaHashes(op.props as Props)) out.push(h);
  }
  return out;
}

interface Peer {
  following?: string | null;
  name: string;
  color: string;
  x: number;
  y: number;
  sel: string[];
  /** Visible area (world): x, y, width, height — and the page. */
  view?: [number, number, number, number];
  page?: string;
  /** Cursor chat: what the participant is typing. */
  chat?: string | null;
  /** Spotlighting everyone. */
  spotlight?: boolean;
  /** Voice: in the call (muted — with the microphone off) and whether speaking right now. */
  voice?: 'on' | 'muted';
  speaking?: boolean;
}

/** Participant for avatars. */
export interface Person {
  id: string;
  name: string;
  color: string;
  spotlight: boolean;
  voice?: 'on' | 'muted';
  speaking?: boolean;
}

/** Open server file. */
export interface LiveFile {
  id: string;
  name: string;
  role: FileRole;
  /** Branch: id of the main file. */
  parentId?: string | null;
  /** Token of the link it was opened by (without sign-in). */
  link: string | null;
}

export class Collab {
  private ed: Editor;
  private ws: WebSocket | null = null;
  private bridge: LoroBridge | null = null;
  /** Document bound to the room: if the editor opened another one, leave the room. */
  private doc: Document | null = null;
  private unsubscribe: (() => void)[] = [];
  /** Images already sent (or being sent) to the server, and the send queue. */
  private uploaded = new Set<string>();
  private uploadQueue: string[] = [];
  private uploading = 0;
  private peers = new Map<string, Peer>();
  private attempt = 0;
  private url = '';
  private retry: ReturnType<typeof setTimeout> | null = null;
  private lastSent = 0;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private cursor: [number, number] = [0, 0];
  private cursors = new Map<string, HTMLElement>();
  readonly me: { id: string; name: string; color: string };
  room = '';
  /** room — a room without accounts, file — a server file with permissions. */
  mode: 'room' | 'file' | null = null;
  /** Server file: what is open and with which role (the role comes from the server). */
  file: LiveFile | null = null;
  private token: string | null = null;
  private lastError = '';
  private warnedReadOnly = false;
  /** Voice: own state (in presence) and signals from participants. */
  voice: 'on' | 'muted' | null = null;
  speaking = false;
  onSignal: ((from: string, msg: Record<string, unknown>) => void) | null = null;
  /** Presence changed (a participant joined, left, turned on voice). */
  onPresence: (() => void)[] = [];
  /** The room document replaced ours (wired up by main.ts: plugins, file name, fit). */
  onDocument: ((doc: Document, room: string, images: ImageBytesSource) => void) | null = null;
  /** The server file's document has been received. */
  onFile: ((doc: Document, file: LiveFile, images: ImageBytesSource) => void) | null = null;
  /** The role in the open file changed (access was changed while it was open). */
  onRole: ((role: FileRole) => void) | null = null;
  /** Server file error; fatal — there will be no more connection (no access, file deleted). */
  onError: ((message: string, fatal: boolean) => void) | null = null;
  /** Own edit was sent to the server (file thumbnail). */
  onLocalUpdate: (() => void) | null = null;
  /** Following started or ended (a frame in the participant's color around the canvas). */
  onFollow: ((p: Person | null, reason: 'spotlight' | 'click' | 'stop' | 'left') => void) | null = null;
  /** Who we follow (participant id). */
  following: string | null = null;
  private bySpotlight = false;
  /** A spotlight that was declined (Esc): don't pick it up again. */
  private declined: string | null = null;
  /** We move the camera ourselves (following) — this is not “the user moved it”. */
  private steering = false;
  private followCamera: FollowCamera;
  /** Own cursor chat and own spotlight. */
  chat: string | null = null;
  spotlight = false;
  /** Left because another document was opened in the editor. */
  onLeave: (() => void) | null = null;
  /** Server file event (comments). */
  onEvent: ((event: unknown) => void) | null = null;
  /** Connection to the server file is back: events during the gap may have been lost. */
  onRejoin: (() => void) | null = null;
  onStatus: ((text: string, peers: number) => void) | null = null;

  constructor(ed: Editor, name: string) {
    this.ed = ed;
    this.followCamera = new FollowCamera(() => ed.camera, () => [ed.viewW, ed.viewH], camera => {
      this.steering = true;
      try { ed.setCamera(camera); } finally { this.steering = false; }
    });
    this.me = { id: Math.random().toString(36).slice(2, 10), name, color: COLORS[Math.floor(Math.random() * COLORS.length)]! };
    ed.overlays.push((canvas) => this.draw(canvas));
    ed.canvasEl.addEventListener('pointermove', (e) => {
      // Without a connection nobody needs the cursor, and getBoundingClientRect after panel edits is an extra
      // layout on every mouse move.
      if (!this.connected) return;
      const r = ed.canvasEl.getBoundingClientRect();
      this.sendPresence(ed.screenToWorld(e.clientX - r.left, e.clientY - r.top));
    });
    ed.onSelection.push(() => this.sendPresence());
    // Camera and page go into presence (others may follow us); own scrolling ends following.
    ed.onCamera.push(() => {
      if (!this.steering && this.following) this.unfollow('stop');
      this.sendPresence();
    });
    ed.onPage.push(() => this.sendPresence());
    ed.onPage.push(() => {
      if (!this.doc || ed.doc === this.doc) return;
      const mode = this.mode;
      this.disconnect();
      this.onStatus?.(mode === 'file' ? 'Открыт другой файл' : 'Открыт другой документ — вышли из комнаты', 0);
      this.onLeave?.();
    });
    // The server knows who is in the room: it reports departures (and dropped connections) itself.
  }

  /** Room participants (excluding us): name and color — for avatars. */
  get people(): Person[] {
    return [...this.peers].map(([id, p]) => ({ id, name: p.name, color: p.color, spotlight: !!p.spotlight, voice: p.voice, speaking: !!p.speaking }));
  }

  /** Follow a participant (null — stop). */
  follow(id: string | null) {
    if (!id) {
      this.unfollow('stop');
      return true;
    }
    const p = this.peers.get(id);
    if (!p || !canFollow(this.me.id, id, key => this.peers.get(key)?.following)) return false;
    this.followCamera.stop();
    this.following = id;
    this.bySpotlight = false;
    this.sendPresence(undefined, true);
    this.steer(p);
    this.onFollow?.({ id, name: p.name, color: p.color, spotlight: !!p.spotlight }, 'click');
    return true;
  }

  private unfollow(reason: 'stop' | 'left') {
    this.followCamera.stop();
    if (!this.following) return;
    // Declined someone's spotlight — don't pick it up again until it starts anew.
    if (this.bySpotlight && reason === 'stop') this.declined = this.following;
    this.following = null;
    this.bySpotlight = false;
    this.sendPresence(undefined, true);
    this.onFollow?.(null, reason);
  }

  /** Camera and page — as the participant's (their area fitted into our window). */
  private steer(p: Peer) {
    if (!p.view) return;
    const ed = this.ed;
    this.steering = true;
    try {
      const changedPage = !!(p.page && p.page !== ed.pageId && ed.doc.has(p.page) && ed.doc.type(p.page) === 'PAGE');
      if (changedPage) ed.setPage(p.page!);
      const [x, y, w, h] = p.view;
      // Keep the animation goal inside Editor's camera limits so it can settle.
      const zoom = Math.max(0.01, Math.min(256, ed.viewW / Math.max(1e-6, w), ed.viewH / Math.max(1e-6, h)));
      this.followCamera.move({ zoom, x: x + w / 2 - ed.viewW / 2 / zoom, y: y + h / 2 - ed.viewH / 2 / zoom },
        changedPage || matchMedia('(prefers-reduced-motion: reduce)').matches);
    } finally {
      this.steering = false;
    }
  }

  /** Spotlight everyone (or stop). */
  setSpotlight(on: boolean) {
    this.spotlight = on;
    this.sendPresence(undefined, true);
  }

  /** Voice: own state for the others. */
  setVoice(voice: 'on' | 'muted' | null, speaking = false) {
    if (this.voice === voice && this.speaking === speaking) return;
    this.voice = voice;
    this.speaking = speaking;
    this.sendPresence(undefined, true);
  }

  /** Voice signal to a participant (offer, answer, ICE candidates). */
  sendSignal(to: string, msg: Record<string, unknown>) {
    this.send(SIGNAL, new TextEncoder().encode(JSON.stringify({ ...msg, to })));
  }

  /** Server HTTP address (voice: /ice). */
  get httpBase(): string {
    return this.url.replace(/^ws/, 'http');
  }

  /** Cursor chat (null — remove). */
  setChat(text: string | null) {
    this.chat = text;
    this.sendPresence(undefined, true);
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && this.bridge !== null;
  }

  /** Own edits are saved (a room or a file with edit permission). */
  get canEdit() {
    return this.mode !== 'file' || this.file?.role === 'edit' || this.file?.role === 'owner';
  }

  /** In the room (possibly offline right now — then reconnecting). */
  get inRoom() {
    return this.bridge !== null;
  }

  async connect(url: string, room: string) {
    this.disconnect();
    const attempt = ++this.attempt;
    this.url = url.replace(/\/$/, '');
    this.mode = 'room';
    this.room = room;
    this.onStatus?.('Подключение…', 0);
    await loroReady();
    if (attempt === this.attempt) this.open(attempt, 0);
  }

  /** Open a server file (token — session, link — link token). */
  async connectFile(url: string, id: string, token: string | null, link: string | null) {
    this.disconnect();
    const attempt = ++this.attempt;
    this.url = url.replace(/\/$/, '');
    this.mode = 'file';
    this.file = { id, name: '', role: 'view', link };
    this.token = token;
    this.lastError = '';
    this.warnedReadOnly = false;
    this.onStatus?.('Подключение…', 0);
    await loroReady();
    if (attempt === this.attempt) this.open(attempt, 0);
  }

  private address() {
    if (this.mode === 'room') return `${this.url}/room/${encodeURIComponent(this.room)}`;
    const q = new URLSearchParams();
    if (this.token) q.set('token', this.token);
    if (this.file?.link) q.set('link', this.file.link);
    return `${this.url}/file/${encodeURIComponent(this.file!.id)}?${q}`;
  }

  private open(attempt: number, retries: number) {
    const ws = new WebSocket(this.address());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { retries = 0; if (!this.bridge) this.onStatus?.('Получаем документ с сервера…', 0); };
    ws.onmessage = (e) => this.ws === ws && this.receive(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.unfollow('left');
      this.peers.clear();
      this.ed.dirty = true;
      if (e.code === FORBIDDEN) {
        // No access (or revoked): the document stays on screen, but without connection or edits.
        const msg = this.lastError || 'Нет доступа к файлу';
        if (this.file) this.file.role = 'view';
        this.attempt++;
        this.onStatus?.(msg, 0);
        this.onError?.(msg, true);
        return;
      }
      const delay = Math.min(10_000, 1000 * 2 ** retries);
      this.onStatus?.(`Нет связи с сервером — повтор через ${Math.round(delay / 1000)} с`, 0);
      this.retry = setTimeout(() => attempt === this.attempt && this.open(attempt, retries + 1), delay);
    };
  }

  /** Signed in or out while a server file is open: reconnect under the new identity (the server recomputes the role). */
  setToken(token: string | null) {
    if (token === this.token) return;
    this.token = token;
    if (this.mode !== 'file' || !this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onclose = null;
    ws.close();
    this.open(this.attempt, 0);
  }

  disconnect() {
    this.attempt++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState === WebSocket.OPEN) ws.send(this.frame(PRESENCE, new TextEncoder().encode(JSON.stringify({ id: this.me.id, leave: true }))));
    ws?.close();
    this.cleanup();
  }

  private get http() {
    return this.url.replace(/^ws/, 'http');
  }

  private cleanup() {
    this.unfollow('left');
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    this.uploadQueue = [];
    this.bridge?.dispose();
    this.bridge = null;
    this.doc = null;
    this.mode = null;
    this.file = null;
    this.peers.clear();
    this.ed.dirty = true;
  }

  private frame(type: number, data: Uint8Array) {
    const out = new Uint8Array(data.length + 1);
    out[0] = type;
    out.set(data, 1);
    return out;
  }

  private send(type: number, data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.frame(type, data));
  }

  private receive(bytes: Uint8Array) {
    const body = bytes.subarray(1);
    if (bytes[0] === SNAPSHOT) {
      try { this.join(body); }
      catch (error) {
        this.disconnect();
        this.onError?.(`Не удалось прочитать документ: ${(error as Error).message}`, true);
      }
    }
    else if (bytes[0] === UPDATE) this.bridge?.importUpdate(body);
    else if (bytes[0] === INFO) this.info(JSON.parse(new TextDecoder().decode(body)));
    else if (bytes[0] === EVENT) this.onEvent?.(JSON.parse(new TextDecoder().decode(body)));
    else if (bytes[0] === SIGNAL) {
      const msg = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      if (typeof msg.from === 'string') this.onSignal?.(msg.from, msg);
    }
    else if (bytes[0] === PRESENCE) {
      const p = JSON.parse(new TextDecoder().decode(body)) as { id: string; leave?: boolean } & Partial<Peer>;
      if (p.id === this.me.id) return;
      if (p.leave) {
        this.peers.delete(p.id);
        if (this.following === p.id) this.unfollow('left');
      } else {
        const peer: Peer = { name: p.name ?? '?', color: p.color ?? '#888', x: p.x ?? 0, y: p.y ?? 0, sel: p.sel ?? [], view: p.view, page: p.page, chat: p.chat ?? null, spotlight: !!p.spotlight, voice: p.voice, speaking: !!p.speaking, following: typeof p.following === 'string' ? p.following : null };
        this.peers.set(p.id, peer);
        if (this.following && !canFollow(this.me.id, this.following, key => this.peers.get(key)?.following)) this.unfollow('stop');
        if (this.following === p.id) {
          // The spotlight ended — and so does following it.
          if (this.bySpotlight && !peer.spotlight) this.unfollow('stop');
          else this.steer(peer);
        } else if (peer.spotlight && !this.following && this.declined !== p.id && canFollow(this.me.id, p.id, key => this.peers.get(key)?.following)) {
          this.following = p.id;
          this.bySpotlight = true;
          this.sendPresence(undefined, true);
          this.steer(peer);
          this.onFollow?.({ id: p.id, name: peer.name, color: peer.color, spotlight: true }, 'spotlight');
        }
        if (!peer.spotlight && this.declined === p.id) this.declined = null;
      }
      this.ed.dirty = true;
      this.onStatus?.(this.mode === 'file' ? `Файл «${this.file?.name ?? ''}»` : `Комната «${this.room}»`, this.peers.size);
      for (const cb of this.onPresence) cb();
    }
  }

  /** Server info about the file: role, name, denial. */
  private info(m: { role?: FileRole; file?: { id: string; name: string; parentId?: string | null }; error?: string }) {
    if (!this.file) return;
    if (m.file) {
      this.file.name = m.file.name;
      this.file.parentId = m.file.parentId ?? null;
    }
    if (m.error) {
      this.lastError = m.error;
      // Access denial comes with close code 4403 — onclose reports it.
      if (this.bridge && !m.role) this.onError?.(m.error, false);
    }
    if (m.role && m.role !== this.file.role) {
      const had = this.bridge !== null;
      this.file.role = m.role;
      if (had) {
        this.warnedReadOnly = false;
        this.onRole?.(m.role);
      }
    }
  }

  /** Own edit: to the server if editing is allowed; otherwise — a single warning. */
  private local(u: Uint8Array) {
    if (this.canEdit) {
      this.send(UPDATE, u);
      this.onLocalUpdate?.();
    } else if (!this.warnedReadOnly) {
      this.warnedReadOnly = true;
      this.onError?.('Только просмотр: правки в этом файле не сохраняются', false);
    }
  }

  /** Joining a room: empty snapshot — share our document, otherwise take the room's document. */
  private join(snapshot: Uint8Array) {
    if (this.mode === 'file') {
      this.joinFile(snapshot);
      return;
    }
    if (this.bridge) {
      // Reconnect: merge the room snapshot with our state and send ours.
      this.bridge.importUpdate(snapshot);
      this.send(UPDATE, this.bridge.exportUpdate());
      this.upload(imageHashes(this.bridge.document));
      this.onStatus?.(`Комната «${this.room}»`, this.peers.size);
      this.sendPresence(undefined, true);
      return;
    }
    if (hasNodes(snapshot)) {
      const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
      this.bridge = new LoroBridge(doc);
      this.bridge.importUpdate(snapshot);
      doc.clearHistory();
      this.doc = doc;
      this.onDocument?.(doc, this.room, new RoomImages(this.http, () => this.token));
    } else {
      this.doc = this.ed.doc;
      this.bridge = new LoroBridge(this.ed.doc);
      this.send(UPDATE, this.bridge.exportUpdate());
      this.upload(imageHashes(this.ed.doc));
    }
    // Own edits (and derived recomputations) go to everyone else; new images go to the server.
    this.unsubscribe.push(
      this.bridge.loro.subscribeLocalUpdates((u: Uint8Array) => this.send(UPDATE, u)),
      this.doc.onChange((ops, origin) => origin !== 'loro' && this.upload(opImages(ops))),
    );
    this.onStatus?.(`Комната «${this.room}»`, this.peers.size);
    this.sendPresence(undefined, true);
  }

  /** Server file: the document always comes from the server; an empty one (created via the API) gets a first page. */
  private joinFile(snapshot: Uint8Array) {
    const file = this.file!;
    if (this.bridge) {
      // Reconnect: merge the snapshot with our state and send ours (if editing is allowed).
      this.bridge.importUpdate(snapshot);
      if (this.canEdit) {
        this.send(UPDATE, this.bridge.exportUpdate());
        this.upload(imageHashes(this.bridge.document));
      }
      this.onRejoin?.();
      this.onStatus?.(`Файл «${file.name}»`, this.peers.size);
      this.sendPresence(undefined, true);
      return;
    }
    const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
    this.bridge = new LoroBridge(doc);
    this.onStatus?.('Подготавливаем слои документа…', 0);
    // Import once: hasNodes used to decode the whole snapshot into a second LoroDoc.
    const started = performance.now();
    this.bridge.importUpdate(snapshot);
    performance.measure('mfp:snapshot-import', { start: started, end: performance.now() });
    if (!doc.children(doc.root).length) {
      doc.create('PAGE', doc.root, { name: t('Страница {0}', 1) }, undefined);
      if (this.canEdit) this.send(UPDATE, this.bridge.exportUpdate());
    }
    doc.clearHistory();
    this.doc = doc;
    this.unsubscribe.push(
      this.bridge.loro.subscribeLocalUpdates((u: Uint8Array) => this.local(u)),
      doc.onChange((ops, origin) => origin !== 'loro' && this.canEdit && this.upload(opImages(ops))),
    );
    this.onFile?.(doc, file, new RoomImages(this.http, () => this.token));
    this.onStatus?.(`Файл «${file.name}»`, this.peers.size);
    this.sendPresence(undefined, true);
  }

  /** Send images to the server (4 at a time; skip what is already there). */
  private upload(hashes: Iterable<string>) {
    for (const h of hashes) {
      if (this.uploaded.has(h)) continue;
      this.uploaded.add(h);
      this.uploadQueue.push(h);
    }
    while (this.uploading < 4 && this.uploadQueue.length) {
      const hash = this.uploadQueue.shift()!;
      this.uploading++;
      void this.uploadOne(hash).finally(() => {
        this.uploading--;
        this.upload([]);
      });
    }
  }

  private async uploadOne(hash: string) {
    const url = `${this.http}/image/${hash}`;
    const headers: HeadersInit = this.token ? { authorization: `Bearer ${this.token}` } : {};
    try {
      if ((await fetch(url, { method: 'HEAD', headers })).ok) return;
      const bytes = await this.ed.store.readImage(hash);
      if (!bytes) return;
      const res = await fetch(url, { method: 'PUT', headers, body: bytes as BufferSource });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch {
      // Server unavailable — try again on the next room join.
      this.uploaded.delete(hash);
    }
  }

  private sendPresence(at?: [number, number], force = false) {
    if (at) this.cursor = at;
    if (!this.connected) return;
    const wait = PRESENCE_MS - (performance.now() - this.lastSent);
    if (!force && wait > 0) {
      this.trailing ??= setTimeout(() => {
        this.trailing = null;
        this.sendPresence(undefined, true);
      }, wait);
      return;
    }
    this.lastSent = performance.now();
    const ed = this.ed;
    const z = ed.camera.zoom;
    // Forward the source's world rectangle, not our fitted viewport: otherwise a
    // chain of differently shaped windows progressively zooms farther out.
    const source = this.following ? this.peers.get(this.following) : undefined;
    const view = source?.view ?? [ed.camera.x, ed.camera.y, ed.viewW / z, ed.viewH / z].map((v) => Math.round(v * 100) / 100);
    const p = {
      id: this.me.id,
      name: this.me.name,
      color: this.me.color,
      x: this.cursor[0],
      y: this.cursor[1],
      sel: ed.selection.slice(0, 50),
      view,
      page: source?.page ?? ed.pageId,
      following: this.following,
      ...(this.chat !== null ? { chat: this.chat } : {}),
      ...(this.spotlight ? { spotlight: true } : {}),
      ...(this.voice ? { voice: this.voice, ...(this.speaking ? { speaking: true } : {}) } : {}),
    };
    this.send(PRESENCE, new TextEncoder().encode(JSON.stringify(p)));
  }

  /** Participants' selection — boxes in their color over the canvas. */
  private draw(canvas: Canvas) {
    const ck = this.ed.ck;
    for (const p of this.peers.values()) {
      if (!p.sel.length) continue;
      const paint = new ck.Paint();
      paint.setAntiAlias(true);
      paint.setColor(ck.parseColorString(p.color));
      paint.setStyle(ck.PaintStyle.Stroke);
      paint.setStrokeWidth(1.5);
      for (const id of p.sel) {
        if (!this.ed.doc.has(id) || !this.ed.isOnPage(id)) continue;
        const pts = this.ed.corners(id).map(([x, y]) => this.ed.worldToScreen(x, y));
        for (let i = 0; i < 4; i++) {
          const a = pts[i]!;
          const b = pts[(i + 1) % 4]!;
          canvas.drawLine(a[0], a[1], b[0], b[1], paint);
        }
      }
      paint.delete();
    }
    this.placeCursors();
  }

  /** Participants' cursors — elements over the canvas (label in the interface font). */
  private placeCursors() {
    const stage = this.ed.canvasEl.parentElement!;
    for (const [id, el] of this.cursors) {
      if (this.peers.has(id)) continue;
      el.remove();
      this.cursors.delete(id);
    }
    for (const [id, p] of this.peers) {
      let el = this.cursors.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'peer-cursor';
        el.innerHTML = `<svg width="16" height="18" viewBox="0 0 16 18"><path d="M1 1 L1 15 L5 11 L11 11 Z" fill="currentColor" stroke="#fff" stroke-width="1.2"/></svg><span></span>`;
        stage.append(el);
        this.cursors.set(id, el);
      }
      const [x, y] = this.ed.worldToScreen(p.x, p.y);
      // The participant is on another page — their cursor is not here.
      el.hidden = !!p.page && p.page !== this.ed.pageId;
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.color = p.color;
      const label = el.querySelector('span')!;
      const chat = p.chat?.trim();
      label.textContent = chat || p.name;
      label.title = p.name;
      label.classList.toggle('chat', !!chat);
      label.style.background = p.color;
    }
  }
}
