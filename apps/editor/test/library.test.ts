import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Document } from '@mfp/core';
import { Autosave } from '../src/autosave.ts';
import { Library } from '../src/library.ts';
import { Versions } from '../src/versions.ts';

// In-memory browser storage (OPFS): only what the library and versions use.
class MemFile {
  readonly kind = 'file';
  name: string;
  data: Blob = new Blob([]);
  constructor(name: string) {
    this.name = name;
  }
  async getFile() {
    return new File([this.data], this.name);
  }
  async createWritable() {
    const parts: BlobPart[] = [];
    return {
      write: async (d: BlobPart) => void parts.push(d),
      close: async () => void (this.data = new Blob(parts)),
    };
  }
}
class MemDir {
  readonly kind = 'directory';
  name: string;
  entries = new Map<string, MemDir | MemFile>();
  constructor(name: string) {
    this.name = name;
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let e = this.entries.get(name);
    if (!e && opts?.create) this.entries.set(name, (e = new MemDir(name)));
    if (!(e instanceof MemDir)) throw new DOMException('нет', 'NotFoundError');
    return e;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let e = this.entries.get(name);
    if (!e && opts?.create) this.entries.set(name, (e = new MemFile(name)));
    if (!(e instanceof MemFile)) throw new DOMException('нет', 'NotFoundError');
    return e;
  }
  async removeEntry(name: string) {
    if (!this.entries.delete(name)) throw new DOMException('нет', 'NotFoundError');
  }
  async *values() {
    yield* this.entries.values();
  }
  async *keys() {
    yield* this.entries.keys();
  }
}

let root: MemDir;
beforeEach(() => {
  root = new MemDir('');
  Object.defineProperty(globalThis.navigator, 'storage', { value: { getDirectory: async () => root }, configurable: true });
});

describe('file library', () => {
  it('files, folders, trash', async () => {
    const lib = (await Library.open())!;
    const t = Date.now();
    await lib.put({ id: 'a', name: 'Альфа', folder: 'Клиенты/Банк', created: t, modified: t, opened: t });
    await lib.put({ id: 'b', name: 'Бета', folder: '', created: t, modified: t, opened: t + 1 });
    let l = await lib.list();
    expect(l.folders).toEqual(['Клиенты', 'Клиенты/Банк']);
    expect(l.files.map((f) => f.name).sort()).toEqual(['Альфа', 'Бета']);
    // Renaming a folder moves its files too.
    await lib.moveFolder('Клиенты', 'Заказчики');
    l = await lib.list();
    expect(l.folders).toEqual(['Заказчики', 'Заказчики/Банк']);
    expect((await lib.get('a'))!.folder).toBe('Заказчики/Банк');
    // Deleting a folder — files go to the trash and can be restored.
    await lib.removeFolder('Заказчики');
    expect((await lib.get('a'))!.trashed).toBeGreaterThan(0);
    expect((await lib.list()).folders).toEqual([]);
    await lib.restore('a');
    expect((await lib.get('a'))!.trashed).toBeUndefined();
    // Permanently — both the record and the working copy.
    await lib.writeDocument('b', 'Бета', '{}');
    await lib.purge('b');
    expect(await lib.get('b')).toBeNull();
    expect((await root.getDirectoryHandle('library')).entries.has('files')).toBe(true);
    expect((await (await root.getDirectoryHandle('library')).getDirectoryHandle('files')).entries.has('b')).toBe(false);
  });
});

describe('version history', () => {
  const pageOf = (d: Document) => d.children(d.root)[0]!;

  it('full snapshot, then changes; a version is assembled along the chain', async () => {
    const lib = (await Library.open())!;
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Страница' });
    const frame = doc.create('FRAME', page, { name: 'Экран', width: 100, height: 100 });
    doc.create('RECTANGLE', frame, { name: 'Кнопка', width: 40, height: 20 });
    const v = new Versions(lib);
    v.attach('f1', doc);
    doc.onChange((ops) => v.track(ops));
    const first = (await v.snapshot('named', 'Первая', 'Исходник'))!;
    expect(first.base).toBeUndefined();
    // Edits: rename, a new node, deleting a subtree with children, a new path.
    const second = doc.create('FRAME', page, { name: 'Второй', width: 50, height: 50 });
    doc.create('ELLIPSE', second, { name: 'Круг' });
    doc.set(frame, { name: 'Экран 2' });
    const key = doc.putBlob('M0 0L10 10Z');
    doc.create('VECTOR', frame, { name: 'Вектор', vectorPaths: [{ windingRule: 'NONZERO', blob: key }] });
    const after2 = JSON.stringify(doc.snapshot());
    const v2 = (await v.snapshot('auto'))!;
    expect(v2.base).toBe(first.id);
    doc.delete(second);
    const v3 = (await v.snapshot('auto'))!;
    expect(v3.base).toBe(v2.id);
    // Without edits no autosave is needed.
    expect(await v.snapshot('auto')).toBeNull();
    // A new session without edits — same (previously the session start took a full snapshot on every close).
    v.attach('f1', doc);
    expect(await v.snapshot('auto')).toBeNull();
    // The document was replaced (version restore) — a version is needed even without edits, a full one.
    v.replaced(doc);
    const v4 = (await v.snapshot('auto'))!;
    expect(v4.base).toBeUndefined();
    expect(await v.snapshot('auto')).toBeNull();
    v.attach('f1', doc);

    const d1 = await v.load('f1', first.id);
    expect(d1.children(pageOf(d1)).map((id) => d1.get(id, 'name'))).toEqual(['Экран']);
    const d2 = await v.load('f1', v2.id);
    expect(JSON.stringify(d2.snapshot())).toBe(after2);
    expect(d2.blob(key)).toBe('M0 0L10 10Z');
    const d3 = await v.load('f1', v3.id);
    expect(JSON.stringify(d3.snapshot())).toBe(JSON.stringify(doc.snapshot()));
    // Version name.
    await v.rename('f1', v2.id, 'Вторая', 'С кругом');
    expect((await v.list('f1')).find((x) => x.id === v2.id)).toMatchObject({ kind: 'named', name: 'Вторая', description: 'С кругом' });
  });

  it('old unnamed sessions are deleted, named ones are kept', async () => {
    const lib = (await Library.open())!;
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Страница' });
    const v = new Versions(lib);
    doc.onChange((ops) => v.track(ops));
    let named = '';
    for (let i = 0; i < 33; i++) {
      v.attach('f2', doc);
      doc.create('RECTANGLE', page, { name: `R${i}` });
      const m = (await v.snapshot(i === 1 ? 'named' : 'auto', i === 1 ? 'Важная' : undefined))!;
      if (i === 1) named = m.id;
    }
    const list = await v.list('f2');
    // The last 30 unnamed sessions + a named session.
    expect(list.length).toBe(31);
    expect(list.some((x) => x.id === named)).toBe(true);
    const d = await v.load('f2', named);
    expect(d.children(pageOf(d)).length).toBe(2);
  });
});

describe('autosave', () => {
  const image = (hash: string) => ({ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', visible: true, opacity: 1 });
  afterEach(() => void vi.unstubAllGlobals());

  function setup(read: (hash: string) => Promise<Uint8Array | null>) {
    vi.stubGlobal('document', { addEventListener() {}, visibilityState: 'visible' });
    vi.stubGlobal('window', globalThis);
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Страница' });
    const ed = { doc, store: { readImage: read, subscribe: () => () => {} }, importing: null, onDocument: [] as ((ops: unknown) => void)[], onDocumentSet: [] };
    doc.onChange((ops) => ed.onDocument.forEach((cb) => cb(ops)));
    const dir = new MemDir('копия');
    const a = new Autosave(ed as never, () => 'Файл', async () => dir as never);
    return { doc, page, dir, a };
  }
  const text = async (dir: MemDir) => (await (dir.entries.get('document.json') as MemFile).getFile()).text();

  it('an image failed to read — the working copy is not considered saved', async () => {
    const { doc, page, dir, a } = setup(async (h) => {
      if (h === 'b'.repeat(40)) throw new Error('диск');
      return new Uint8Array([1, 2, 3]);
    });
    doc.create('RECTANGLE', page, { name: 'A', fills: [image('a'.repeat(40))] });
    doc.create('RECTANGLE', page, { name: 'B', fills: [image('b'.repeat(40))] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await a.flush();
    warn.mockRestore();
    expect(a.saved).toBe(false);
    a.reset();
  });

  it('an edit made during writing goes out with the next save; everything written — saved', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { doc, page, dir, a } = setup(async () => {
      await gate;
      return new Uint8Array([1]);
    });
    doc.create('RECTANGLE', page, { name: 'A', fills: [image('c'.repeat(40))] });
    const first = a.flush();
    await new Promise((r) => setTimeout(r, 0));
    doc.create('RECTANGLE', page, { name: 'Поздняя правка' });
    expect(a.saved).toBe(false);
    release();
    await first;
    await a.flush();
    expect(a.saved).toBe(true);
    expect(await text(dir)).toContain('Поздняя правка');
    expect((dir.entries.get('images') as MemDir).entries.has('c'.repeat(40))).toBe(true);
    a.reset();
  });
});

describe('edit journal', () => {
  afterEach(() => void vi.unstubAllGlobals());

  async function setup() {
    vi.stubGlobal('document', { addEventListener() {}, visibilityState: 'visible' });
    vi.stubGlobal('window', globalThis);
    const lib = (await Library.open())!;
    const doc = new Document({ clientId: 7 });
    const page = doc.create('PAGE', doc.root, { name: 'Страница' });
    const ed = { doc, store: { readImage: async () => undefined, subscribe: () => () => {} }, importing: null, onDocument: [] as ((ops: unknown) => void)[], onDocumentSet: [] };
    doc.onChange((ops) => ed.onDocument.forEach((cb) => cb(ops)));
    const a = new Autosave(ed as never, () => 'Файл', async () => (await lib.dir('f1')) as never);
    a.reset(null);
    return { lib, doc, page, a };
  }
  const same = (want: Document, got: Document) => expect(JSON.stringify(got.snapshot())).toBe(JSON.stringify(want.snapshot()));
  const names = (d: Document) => d.children(d.children(d.root)[0]!).map((id) => d.get(id, 'name'));
  const batches = async (lib: Library) => {
    try {
      return [...((await (await lib.dir('f1')).getDirectoryHandle('journal')) as unknown as MemDir).entries.keys()].sort();
    } catch {
      return [];
    }
  };
  const snapshotText = async (lib: Library) => (await ((await (await lib.dir('f1')).getFileHandle('document.json')) as unknown as MemFile).getFile()).text();

  it('crash after a snapshot: snapshot + journal restore the document; the next snapshot truncates the journal', async () => {
    const { lib, doc, page, a } = await setup();
    doc.create('RECTANGLE', page, { name: 'A', width: 10, height: 10 });
    await a.flush();
    expect(a.canJournal).toBe(true);
    const b = doc.create('RECTANGLE', page, { name: 'B' });
    doc.set(b, { name: 'B2', x: 5 });
    doc.delete(doc.children(page)[0]!);
    // “Crash”: no snapshot after the edits, only the journal.
    await a.journal.flush();
    const back = (await lib.readDocument('f1'))!;
    expect(back.replayed).toBe(3);
    expect(back.lost).toBe(false);
    same(doc, back.doc);
    expect(back.journal).toEqual(a.journal.mark());
    expect((await batches(lib)).length).toBe(1);
    // The snapshot caught up with the journal — batches before it aren't needed.
    await a.flush();
    await a.journal.flush();
    expect(await batches(lib)).toEqual([]);
    const again = (await lib.readDocument('f1'))!;
    expect(again.replayed).toBe(0);
    same(doc, again.doc);
    a.reset(null);
  });

  it('closing when the line\'s snapshot is already in the working copy — only a journal batch', async () => {
    const { lib, doc, page, a } = await setup();
    doc.create('RECTANGLE', page, { name: 'A' });
    await a.flushQuick();
    // The line had no snapshot yet — closing writes the whole snapshot.
    expect(names((await lib.readDocument('f1'))!.doc)).toEqual(['A']);
    const before = await snapshotText(lib);
    doc.create('RECTANGLE', page, { name: 'B' });
    expect(a.saved).toBe(false);
    await a.flushQuick();
    expect(a.saved).toBe(true);
    expect(await snapshotText(lib)).toBe(before);
    same(doc, (await lib.readDocument('f1'))!.doc);
    a.reset(null);
  });

  it('preview and background page loading do not go into the journal', async () => {
    const { doc, page, a } = await setup();
    const r = doc.create('RECTANGLE', page, { name: 'A' });
    const n = a.journal.next;
    const revert = doc.preview(() => doc.set(r, { x: 100 }));
    revert();
    doc.apply([{ op: 'set', id: r, props: { name: 'из файла' } }], 'import');
    expect(a.journal.next).toBe(n);
    a.reset(null);
  });

  it('a batch missing in the middle: recovery up to it, a new journal line', async () => {
    const { lib, doc, page, a } = await setup();
    doc.create('RECTANGLE', page, { name: 'A' });
    await a.flush();
    for (const name of ['B', 'C', 'D']) {
      doc.create('RECTANGLE', page, { name });
      await a.journal.flush();
    }
    const list = await batches(lib);
    expect(list.length).toBe(3);
    await (await (await lib.dir('f1')).getDirectoryHandle('journal')).removeEntry(list[1]!);
    const back = (await lib.readDocument('f1'))!;
    expect(back.lost).toBe(true);
    expect(back.journal).toBeNull();
    expect(names(back.doc)).toEqual(['A', 'B']);
    a.reset(null);
  });

  it('the version chain continues across sessions if the file is opened in the same state', async () => {
    const lib = (await Library.open())!;
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Страница' });
    const v = new Versions(lib);
    let off = doc.onChange((ops) => v.track(ops));
    v.attach('f5', doc);
    doc.create('RECTANGLE', page, { name: 'A' });
    const first = (await v.snapshot('auto'))!;
    expect(first.base).toBeUndefined();
    doc.create('RECTANGLE', page, { name: 'B' });
    const mark = { lineage: 'l1', next: 5 };
    await v.leave(mark);
    const list = await v.list('f5');
    expect(list.map((x) => x.base)).toEqual([undefined, first.id]);
    off();
    // New session: the same journal mark — continue the chain with changes.
    const v2 = new Versions(lib);
    off = doc.onChange((ops) => v2.track(ops));
    v2.attach('f5', doc);
    await v2.resume(mark);
    doc.create('RECTANGLE', page, { name: 'D' });
    const next = (await v2.snapshot('auto'))!;
    expect(next.base).toBe(list[1]!.id);
    expect(names(await v2.load('f5', next.id))).toEqual(['A', 'B', 'D']);
    off();
    // A different mark (there was a crash between sessions) — from a full snapshot.
    const v3 = new Versions(lib);
    off = doc.onChange((ops) => v3.track(ops));
    v3.attach('f5', doc);
    await v3.resume({ lineage: 'l1', next: 9 });
    doc.create('RECTANGLE', page, { name: 'E' });
    expect((await v3.snapshot('auto'))!.base).toBeUndefined();
    off();
  });
});
