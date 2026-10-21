// Live document copy in the plugin Worker: main thread (DocLink) ⇄ Worker session.
// Messages are asynchronous and copied (structuredClone), as between threads.

import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { parseManifest, type PluginBundle } from '../src/index.ts';
import { DocLink } from '../src/browser/doc-link.ts';
import { WorkerSession } from '../src/browser/session.ts';
import type { FromWorker, ToWorker, ViewportState } from '../src/browser/protocol.ts';

/** Waits for a condition (messages between “threads” are timers). */
async function until(cond: () => boolean, what: string, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`Не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function plugin(code: string): PluginBundle {
  const { manifest } = parseManifest({ name: 'Live', id: 'live', api: '1.0.0', main: 'code.js', editorType: ['figma'] });
  // Internal “ping”: the reply arrives after everything the plugin did earlier.
  return { manifest, code: `figma.ui.on('message', (m) => { if (m && m.__ping) figma.notify('__pong' + m.__ping); });\n${code}` };
}

/** Editor (main thread document) and the plugin in a “Worker”. */
function connect(code: string, opts: { setup?: (doc: Document, page: string) => void; viewport?: ViewportState; command?: string; editorType?: 'figma' | 'dev'; codegen?: boolean } = {}) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Page 1' });
  const page2 = doc.create('PAGE', doc.root, { name: 'Page 2' });
  opts.setup?.(doc, page);
  const main = {
    notes: [] as string[],
    selection: [] as string[],
    page,
    viewport: [] as { center?: { x: number; y: number }; zoom?: number }[],
    zoomTo: [] as string[][],
    pongs: 0,
  };
  let link: DocLink;
  const session = new WorkerSession((m: FromWorker) => {
    const copy = structuredClone(m);
    setTimeout(() => {
      switch (copy.type) {
        case 'commitUndo':
          link.commitUndo();
          break;
        case 'ops':
          link.applyPluginOps(copy.ops, copy.seen);
          break;
        case 'resync':
          post(link.reset());
          break;
        case 'notify':
          if (copy.message.startsWith('__pong')) main.pongs = Number(copy.message.slice(6));
          else main.notes.push(copy.message);
          break;
        case 'selection':
          main.selection = copy.ids;
          break;
        case 'page':
          main.page = copy.id;
          break;
        case 'setViewport':
          main.viewport.push({ center: copy.center, zoom: copy.zoom });
          break;
        case 'zoomTo':
          main.zoomTo.push(copy.ids);
          break;
      }
    }, 0);
  });
  const post = (m: ToWorker) => {
    const copy = structuredClone(m);
    setTimeout(() => void session.handle(copy), 0);
  };
  /** Like PluginHost: editor edits go before any other message. */
  const send = (m: ToWorker) => {
    link.flush();
    post(m);
  };
  link = new DocLink(doc, post);
  send({
    type: 'start',
    bundle: plugin(code),
    snapshot: doc.snapshot(),
    page,
    selection: [],
    storage: {},
    viewport: opts.viewport,
    command: opts.command,
    editorType: opts.editorType,
    codegen: opts.codegen,
  });
  const ui = (message: unknown) => send({ type: 'uiMessage', message });
  let pings = 0;
  /** Wait until the plugin processes everything sent earlier (and the events that follow). */
  const sync = async () => {
    for (let i = 0; i < 2; i++) {
      const n = ++pings;
      ui({ __ping: n });
      await until(() => main.pongs >= n, 'ответ плагина');
    }
  };
  /** Plugin report (reply to the report message). */
  const report = async () => {
    const before = main.notes.length;
    ui({ type: 'report' });
    await until(() => main.notes.length > before, 'отчёт плагина');
    return JSON.parse(main.notes.at(-1)!);
  };
  return { doc, page, page2, main, session, send, ui, sync, report, link };
}

describe('live document copy in the plugin', () => {
  it('keeps UI actions grouped across Worker messages, splits commitUndo, and isolates editor edits', async () => {
    const h = connect(`figma.ui.onmessage = m => {
      if (m.type === 'add') { const r = figma.createRectangle(); r.name = 'Plugin'; r.resize(140, 70); }
      if (m.type === 'commit') figma.commitUndo();
    };`);
    await h.sync(); h.doc.clearHistory();
    h.ui({ type: 'add' }); await h.sync();
    h.ui({ type: 'add' }); await h.sync();
    expect(h.doc.undoDepth).toBe(1);
    h.ui({ type: 'commit' }); h.ui({ type: 'add' }); await h.sync();
    expect(h.doc.undoDepth).toBe(2);
    h.doc.undo(); expect(h.doc.children(h.page)).toHaveLength(2); await h.sync();
    h.doc.redo(); expect(h.doc.children(h.page)).toHaveLength(3); await h.sync();
    const user = h.doc.create('TEXT', h.page, { characters: 'User' }); await h.sync();
    h.ui({ type: 'add' }); await h.sync();
    h.doc.undo(); expect(h.doc.has(user)).toBe(true); expect(h.doc.children(h.page)).toHaveLength(4);
    h.doc.undo(); expect(h.doc.has(user)).toBe(false);
    h.session.runtime?.stop(); h.link.dispose();
  });
  it('developer mode worker reads live design and metadata but rejects design changes in inspect and codegen', async () => {
    for (const codegen of [false, true]) {
      const t = connect(`
        const n=figma.currentPage.children[0];
        const errors=[];
        for (const write of [()=>figma.createRectangle(), ()=>n.name='Changed', ()=>n.remove(), ()=>n.clone(), ()=>n.resize(20,20), ()=>figma.createPaintStyle(), ()=>figma.variables.createVariableCollection('No')]) {
          try { write(); errors.push('allowed'); } catch(e) { errors.push(String(e.message)); }
        }
        n.setPluginData('key','value');
        n.setSharedPluginData('shared','key','value');
        n.setRelaunchData({inspect:'Inspect'});
        figma.currentPage.selection=[n];
        figma.ui.onmessage=m=>{ if(m.type==='report') figma.notify(JSON.stringify({errors, name:n.name, plugin:n.getPluginData('key'), shared:n.getSharedPluginData('shared','key'), editor:figma.editorType, mode:figma.mode})); };
      `, { editorType: 'dev', codegen, setup: (doc,page)=>{ doc.create('RECTANGLE',page,{name:'Original'}); } });
      await t.sync();
      const r=await t.report();
      expect(r.errors).toHaveLength(7);
      expect(r.errors.every((e:string)=>e.includes('Developer mode is read-only'))).toBe(true);
      expect(r).toMatchObject({name:'Original',plugin:'value',shared:'value',editor:'dev',mode:codegen?'codegen':'inspect'});
      const id=t.doc.children(t.page)[0]!;
      expect(t.doc.children(t.page)).toHaveLength(1);
      expect(t.main.selection).toEqual([id]);
      expect(t.doc.get(id,'pluginData')).toMatchObject({live:{key:'value'}});
      t.doc.set(id,{name:'Designer edit'}); await t.sync();
      expect((await t.report()).name).toBe('Designer edit');
      await t.session.handle({type:'stop'}); t.link.dispose();
    }
  });

  it('editor edits reach the plugin; documentchange — creation, properties, deletion, edits by others', async () => {
    const { doc, page, main, ui, sync, report, session } = connect(`
      const log = [];
      figma.on('documentchange', (e) => {
        for (const c of e.documentChanges) log.push([c.type, c.origin, c.type === 'DELETE' ? c.node.removed + ':' + c.node.type : c.node.type, (c.properties || []).join(',')]);
      });
      figma.ui.onmessage = (msg) => {
        if (msg.type === 'read') figma.notify(figma.getNodeById(msg.id) ? figma.getNodeById(msg.id).name : 'нет');
        if (msg.type === 'rename') figma.getNodeById(msg.id).name = msg.name;
        if (msg.type === 'report') figma.notify(JSON.stringify(log));
      };
    `);
    await sync();
    const a = doc.create('RECTANGLE', page, { name: 'A', width: 10, height: 10 });
    ui({ type: 'read', id: a });
    await sync();
    expect(main.notes.at(-1)).toBe('A');

    doc.set(a, { name: 'B', transform: [1, 0, 50, 0, 1, 0] });
    await sync();
    // An edit by another participant (origin 'loro', as in collaboration).
    doc.transact(() => doc.set(a, { opacity: 0.5 }), 'loro');
    await sync();
    // The plugin's own edit reaches the editor document and also arrives as an event.
    ui({ type: 'rename', id: a, name: 'P' });
    await sync();
    expect(doc.get(a, 'name')).toBe('P');
    const frame = doc.create('FRAME', page, { name: 'F' });
    doc.create('ELLIPSE', frame, { name: 'E' });
    await sync();
    doc.delete(frame);
    await sync();
    expect(await report()).toEqual([
      ['CREATE', 'LOCAL', 'RECTANGLE', ''],
      ['PROPERTY_CHANGE', 'LOCAL', 'RECTANGLE', 'name,x,y,relativeTransform'],
      ['PROPERTY_CHANGE', 'REMOTE', 'RECTANGLE', 'opacity'],
      ['PROPERTY_CHANGE', 'LOCAL', 'RECTANGLE', 'name'],
      ['CREATE', 'LOCAL', 'FRAME', ''],
      ['CREATE', 'LOCAL', 'ELLIPSE', ''],
      ['DELETE', 'LOCAL', 'true:FRAME', ''],
      ['DELETE', 'LOCAL', 'true:ELLIPSE', ''],
    ]);
    // The copy matches the editor document.
    expect(session.doc!.snapshot()).toEqual(doc.snapshot());
  });

  it('apply order: an edit made by a subscriber inside a handler (layout) is not lost', async () => {
    const { doc, page, session, sync } = connect('', {
      setup: (d) => {
        // Like the editor: after creating text, it fits its size (a nested transaction).
        d.onChange((ops) => {
          for (const o of ops) if (o.op === 'create' && o.type === 'TEXT') d.transact(() => d.set(o.id, { width: 77 }), 'layout');
        });
      },
    });
    await sync();
    const t = doc.create('TEXT', page, { characters: 'Привет', width: 1 });
    await sync();
    expect(doc.get(t, 'width')).toBe(77);
    expect(session.doc!.get(t, 'width')).toBe(77);
  });

  it('race: plugin and user edit the same node — copies converge to the editor\'s document', async () => {
    const { doc, page, ui, sync, session } = connect(`
      figma.ui.onmessage = (msg) => { if (msg.id) { figma.getNodeById(msg.id).name = 'плагин'; figma.getNodeById(msg.id).x = 5; } };
    `);
    await sync();
    const x = doc.create('RECTANGLE', page, { name: 'X' });
    await sync();
    // The plugin edits without knowing about the user's edit yet (messages in flight simultaneously).
    ui({ id: x });
    doc.set(x, { name: 'пользователь', transform: [1, 0, 9, 0, 1, 9] });
    await sync();
    expect(doc.get(x, 'name')).toBe('плагин');
    expect(session.doc!.snapshot()).toEqual(doc.snapshot());
  });

  it('selectionchange and currentpagechange: from the editor and from the plugin itself', async () => {
    const { doc, page, page2, main, ui, send, sync, report } = connect(`
      const log = [];
      figma.on('selectionchange', () => log.push('sel:' + figma.currentPage.selection.map((n) => n.name).join(',')));
      figma.on('currentpagechange', () => log.push('page:' + figma.currentPage.name));
      figma.ui.onmessage = async (msg) => {
        if (msg.type === 'select') figma.currentPage.selection = [figma.getNodeById(msg.id)];
        if (msg.type === 'page') await figma.setCurrentPageAsync(figma.getNodeById(msg.id));
        if (msg.type === 'report') figma.notify(JSON.stringify(log));
      };
    `);
    await sync();
    const a = doc.create('RECTANGLE', page, { name: 'A' });
    const b = doc.create('RECTANGLE', page, { name: 'B' });
    send({ type: 'setSelection', ids: [a], page });
    await sync();
    // The same selection again: no event.
    send({ type: 'setSelection', ids: [a], page });
    await sync();
    ui({ type: 'select', id: b });
    await sync();
    expect(main.selection).toEqual([b]);
    ui({ type: 'page', id: page2 });
    await sync();
    expect(main.page).toBe(page2);
    send({ type: 'setSelection', ids: [], page });
    await sync();
    // Page change: page first, then selection (empty on the new page).
    expect(await report()).toEqual(['sel:A', 'sel:B', 'page:Page 2', 'sel:', 'page:Page 1']);
  });

  it('nodechange on a page and stylechange', async () => {
    const { doc, page, page2, ui, sync, report } = connect(`
      const log = [];
      figma.currentPage.on('nodechange', (e) => { for (const c of e.nodeChanges) log.push('node:' + c.type + ':' + c.id); });
      figma.on('stylechange', (e) => { for (const c of e.styleChanges) log.push('style:' + c.type); });
      figma.ui.onmessage = (msg) => {
        if (msg === 'style') { const s = figma.createPaintStyle(); s.name = 'Основной'; }
        if (msg.type === 'report') figma.notify(JSON.stringify(log));
      };
    `);
    await sync();
    const a = doc.create('RECTANGLE', page, { name: 'A' });
    doc.create('RECTANGLE', page2, { name: 'на другой странице' });
    await sync();
    ui('style');
    await sync();
    expect(await report()).toEqual([`node:CREATE:${a}`, 'style:STYLE_CREATE']);
  });

  it('viewport is the editor camera: read, set, scrollAndZoomIntoView', async () => {
    const { doc, page, main, ui, sync } = connect(
      `
      figma.ui.onmessage = (msg) => {
        if (msg.type === 'read') figma.notify(JSON.stringify({ c: figma.viewport.center, z: figma.viewport.zoom, b: figma.viewport.bounds }));
        if (msg.type === 'set') { figma.viewport.zoom = 2; figma.viewport.center = { x: 10, y: 20 }; figma.notify(JSON.stringify(figma.viewport.bounds)); }
        if (msg.type === 'fit') { figma.viewport.scrollAndZoomIntoView([figma.getNodeById(msg.id)]); figma.notify(JSON.stringify({ c: figma.viewport.center, z: figma.viewport.zoom })); }
      };
    `,
      { viewport: { x: 100, y: 50, zoom: 0.5, width: 800, height: 600 } },
    );
    ui({ type: 'read' });
    await sync();
    expect(JSON.parse(main.notes.at(-1)!)).toEqual({ c: { x: 100, y: 50 }, z: 0.5, b: { x: -700, y: -550, width: 1600, height: 1200 } });
    ui({ type: 'set' });
    await sync();
    expect(JSON.parse(main.notes.at(-1)!)).toEqual({ x: -190, y: -130, width: 400, height: 300 });
    expect(main.viewport).toEqual([{ zoom: 2 }, { center: { x: 10, y: 20 } }]);
    const r = doc.create('RECTANGLE', page, { name: 'R', width: 100, height: 50, transform: [1, 0, 1000, 0, 1, 0] });
    ui({ type: 'fit', id: r });
    await sync();
    expect(main.zoomTo).toEqual([[r]]);
    expect(JSON.parse(main.notes.at(-1)!)).toEqual({ c: { x: 1050, y: 25 }, z: 6.8 });
  });

  it('run event with a command; the copy is replaced by a snapshot if it diverged', async () => {
    const { doc, page, main, ui, send, sync, session } = connect(
      `
      figma.on('run', (e) => figma.notify('run:' + e.command));
      figma.ui.onmessage = (msg) => { if (msg === 'count') figma.notify(String(figma.currentPage.children.length)); };
    `,
      { command: 'make' },
    );
    await sync();
    expect(main.notes).toEqual(['run:make']);
    const id = doc.create('RECTANGLE', page, { name: 'A' });
    await sync();
    // A broken batch (a node with that id already exists): the copy requests a snapshot and matches again.
    send({ type: 'docOps', ops: [{ op: 'create', id, type: 'RECTANGLE', parent: page, index: 'a0', props: {} }], origin: 'LOCAL', seq: 99 });
    await sync();
    ui('count');
    await sync();
    expect(main.notes.at(-1)).toBe('1');
    expect(session.doc!.snapshot()).toEqual(doc.snapshot());
  });
});
