// Stage 10 Plugin API: images, base64, exportAsync, getCSSAsync, createNodeFromSvg, boolean
// operations, flatten, ungroup, vectorPaths, instances.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { MemorySource, readMfp, writeMfp } from '@mfp/io-figma';
import { parseManifest, PluginRuntime, type PluginEnvironment } from '../src/index.ts';
import { imageSize, sha1Hex } from '../src/bytes.ts';

/** PNG 1×1. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function env(extra: Partial<PluginEnvironment> = {}) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Page 1' });
  const notes: string[] = [];
  const e: PluginEnvironment = {
    doc,
    getCurrentPage: () => page,
    setCurrentPage: () => {},
    getSelection: () => [],
    setSelection: () => {},
    notify: (m) => notes.push(m),
    showUI: () => {},
    postToUI: () => {},
    setUIVisible: () => {},
    resizeUI: () => {},
    closeUI: () => {},
    viewport: { center: () => ({ x: 0, y: 0 }), zoom: () => 1, bounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), setCenter: () => {}, setZoom: () => {}, scrollAndZoomIntoView: () => {} },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: () => {},
    ...extra,
  };
  return { doc, page, notes, env: e };
}

async function run(code: string, e: PluginEnvironment) {
  const { manifest } = parseManifest({ name: 'T', id: 't', api: '1.0.0', main: 'code.js' });
  const rt = await PluginRuntime.start({ manifest, code }, e);
  const start = Date.now();
  while (rt.state === 'running' && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 5));
  expect(rt.error).toBeNull();
  return rt;
}

describe('bytes', () => {
  it('SHA-1, size from the header, base64', () => {
    const abc = new TextEncoder().encode('abc');
    expect(sha1Hex(abc)).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    const long = new Uint8Array(1000).map((_, i) => i * 7);
    expect(sha1Hex(long)).toBe(createHash('sha1').update(long).digest('hex'));
    expect(imageSize(Buffer.from(PNG, 'base64'))).toEqual({ width: 1, height: 1 });
    const gif = Buffer.from('GIF89a\x10\x00\x20\x00', 'latin1');
    expect(imageSize(gif)).toEqual({ width: 16, height: 32 });
    // JPEG: SOI, APP0, SOF0 (height 0x0102, width 0x0304).
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 2, 3, 4, 3, 0, 0, 0]);
    expect(imageSize(jpg)).toEqual({ width: 0x0304, height: 0x0102 });
  });
});

describe('Plugin API: images, export, code', () => {
  it('createImage, getImageByHash, bytes and size, image fill, base64, exportAsync, getCSSAsync', async () => {
    const added: string[] = [];
    const exported: { id: string; settings: Record<string, unknown> }[] = [];
    const { doc, page, notes, env: e } = env({
      addImage: (hash) => added.push(hash),
      exportNode: async (id, settings) => {
        exported.push({ id, settings });
        return settings.format === 'SVG_STRING' ? '<svg/>' : Uint8Array.of(1, 2, 3);
      },
    });
    await run(
      `(async () => {
        const bytes = figma.base64Decode('${PNG}');
        const img = figma.createImage(bytes);
        const r = figma.createRectangle();
        r.resize(120, 40);
        r.cornerRadius = 8;
        r.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
        const back = await img.getBytesAsync();
        const size = await img.getSizeAsync();
        let bad = null;
        try { figma.createImage(new Uint8Array([1, 2, 3])); } catch (e) { bad = e.message; }
        const json = await r.exportAsync({ format: 'JSON_REST_V1' });
        const png = await r.exportAsync();
        const svg = await r.exportAsync({ format: 'SVG_STRING' });
        const css = await r.getCSSAsync();
        figma.notify(JSON.stringify({
          hash: img.hash, len: back.length, u8: back instanceof Uint8Array, size, bad,
          b64: figma.base64Encode(back) === '${PNG}', same: figma.getImageByHash(img.hash).hash === img.hash,
          json: json.document.type, png: Array.from(png), svg, css: { width: css.width, height: css['border-radius'] },
        }));
        figma.closePlugin();
      })();`,
      e,
    );
    const hash = createHash('sha1').update(Buffer.from(PNG, 'base64')).digest('hex');
    expect(JSON.parse(notes[0]!)).toEqual({
      hash,
      len: Buffer.from(PNG, 'base64').length,
      u8: true,
      size: { width: 1, height: 1 },
      bad: 'Image type is unsupported',
      b64: true,
      same: true,
      json: 'RECTANGLE',
      png: [1, 2, 3],
      svg: '<svg/>',
      css: { width: '120px', height: '8px' },
    });
    expect(added).toEqual([hash]);
    expect(exported.map((x) => x.settings.format)).toEqual(['PNG', 'SVG_STRING']);
    const rect = doc.children(page)[0]!;
    expect(doc.get(rect, 'fills')).toEqual([{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }]);
  });
});

describe('Plugin API: SVG, boolean operations, flatten, ungroup, instances', () => {
  it('createNodeFromSvg, union, flatten (immediate, then the exact contour), ungroup, vectorPaths', async () => {
    let request: { ids: string[]; origin: [number, number] } | null = null;
    const { doc, page, notes, env: e } = env({
      // Like the editor: the exact path (here a 5×5 square offset by 2, 3 from origin).
      flattenGeometry: async (ids, origin) => {
        request = { ids, origin };
        return 'M2 3L7 3L7 8L2 8Z';
      },
    });
    await run(
      `
      const svg = figma.createNodeFromSvg('<svg width="20" height="10"><rect width="20" height="10" fill="red"/><circle cx="5" cy="5" r="5"/></svg>');
      const a = figma.createRectangle(); a.resize(100, 100); a.x = 10; a.y = 10;
      const b = figma.createEllipse(); b.resize(50, 50); b.x = 80; b.y = 80;
      const u = figma.union([a, b], figma.currentPage);
      const c = figma.createRectangle(); c.resize(10, 20); c.x = 200;
      const d = figma.createEllipse(); d.resize(10, 10); d.x = 220; d.y = 5;
      const v = figma.flatten([c, d]);
      const g = figma.group([figma.createRectangle(), figma.createEllipse()], figma.currentPage);
      g.x = 300; g.y = 40;
      const kids = figma.ungroup(g);
      const pen = figma.createVector();
      pen.x = 500;
      pen.vectorPaths = [{ windingRule: 'NONZERO', data: 'M10 10 L30 10 L30 40 Z' }];
      figma.notify(JSON.stringify({
        svg: [svg.type, svg.name, svg.width, svg.height, svg.children.map((n) => n.type)],
        u: [u.type, u.booleanOperation, u.name, u.x, u.y, u.width, u.height, u.children.map((n) => n.type), a.x, a.y],
        v: [v.type, v.x, v.y, v.width, v.height, c.removed, d.removed, v.vectorPaths.length],
        kids: [kids.length, g.removed, kids[0].parent.type, kids[0].x, kids[0].y],
        pen: [pen.x, pen.y, pen.width, pen.height, pen.vectorPaths[0].data],
      }));
      figma.closePlugin();
    `,
      e,
    );
    expect(JSON.parse(notes[0]!)).toEqual({
      svg: ['FRAME', 'svg', 20, 10, ['VECTOR', 'VECTOR']],
      u: ['BOOLEAN_OPERATION', 'UNION', 'Union', 10, 10, 120, 120, ['RECTANGLE', 'ELLIPSE'], 0, 0],
      v: ['VECTOR', 200, 0, 30, 20, true, true, 1],
      kids: [2, true, 'PAGE', 300, 40],
      pen: [510, 10, 20, 30, 'M0 0L20 0L20 30Z'],
    });
    // The exact path from the “editor” arrived after flatten: bounds follow it.
    expect(request).toMatchObject({ origin: [200, 0] });
    await new Promise((r) => setTimeout(r, 20));
    const vec = doc.children(page).find((id) => doc.type(id) === 'VECTOR' && doc.get(id, 'name') === 'Vector')!;
    expect([doc.get(vec, 'transform')![2], doc.get(vec, 'transform')![5], doc.get(vec, 'width'), doc.get(vec, 'height')]).toEqual([202, 3, 5, 5]);
    expect(doc.get(vec, 'vectorPaths')).toEqual([{ windingRule: 'NONZERO', data: 'M0 0L5 0L5 5L0 5Z' }]);
  });

  it('instances: createInstance, mainComponent, swapComponent, detachInstance', async () => {
    const { notes, env: e } = env();
    await run(
      `
      const comp = figma.createComponent(); comp.name = 'Кнопка'; comp.resize(80, 30);
      const label = figma.createRectangle(); comp.appendChild(label);
      const other = figma.createComponent(); other.name = 'Ссылка';
      const inst = comp.createInstance();
      inst.x = 200;
      const before = inst.mainComponent.name;
      inst.swapComponent(other);
      const after = inst.mainComponent.name;
      const frame = inst.detachInstance();
      figma.notify(JSON.stringify({ before, after, type: frame.type, x: frame.x, removed: inst.removed }));
      figma.closePlugin();
    `,
      e,
    );
    // A new frame replaces the instance; the instance is gone.
    expect(JSON.parse(notes[0]!)).toEqual({ before: 'Кнопка', after: 'Ссылка', type: 'FRAME', x: 200, removed: true });
  });
});

describe('plugin network (networkAccess)', () => {
  it('addresses: *, none, domain, subdomains, scheme, path, port; window CSP', async () => {
    const { allowedDomains, urlAllowed, uiCsp } = await import('../src/network.ts');
    const m = (allowed: string[], dev?: string[]) => ({ name: 'n', id: 'i', api: '1.0.0', main: 'c.js', networkAccess: { allowedDomains: allowed, ...(dev ? { devAllowedDomains: dev } : {}) } });
    expect(allowedDomains({ name: 'n', id: 'i', api: '1.0.0', main: 'c.js' })).toBeNull();
    expect(allowedDomains(m(['*']))).toBeNull();
    expect(allowedDomains(m(['none']))).toEqual([]);
    const d = allowedDomains(m(['api.example.com', '*.cdn.net', 'https://site.org/api/', 'http://localhost:3000'], ['dev.example.com']))!;
    expect(urlAllowed('https://api.example.com/x', d)).toBe(true);
    expect(urlAllowed('https://evil.com/x', d)).toBe(false);
    expect(urlAllowed('https://a.cdn.net/f.js', d)).toBe(true);
    expect(urlAllowed('https://cdn.net/f.js', d)).toBe(false);
    expect(urlAllowed('https://site.org/api/v1', d)).toBe(true);
    expect(urlAllowed('https://site.org/other', d)).toBe(false);
    expect(urlAllowed('http://site.org/api/v1', d)).toBe(false);
    expect(urlAllowed('http://localhost:3000/a', d)).toBe(true);
    expect(urlAllowed('http://localhost:4000/a', d)).toBe(false);
    expect(urlAllowed('https://dev.example.com/', d)).toBe(true);
    expect(urlAllowed('data:text/plain,hi', [])).toBe(true);
    expect(urlAllowed('file:///etc/passwd', null)).toBe(false);
    expect(uiCsp(null)).toBeNull();
    const csp = uiCsp(['api.example.com'])!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('connect-src https://api.example.com http://api.example.com');
    expect(uiCsp([])).toContain("connect-src 'none'");
  });

  it('fetch from plugin code: an allowed address gives a response (text, json, bytes, headers); a foreign one — an error', async () => {
    const calls: string[] = [];
    const { notes, env: e } = env({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)} ${init?.body ?? ''}`);
        return new Response(JSON.stringify({ hello: 'мир' }), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Test': '1' } });
      }) as typeof fetch,
    });
    const { manifest } = parseManifest({ name: 'Net', id: 'net', api: '1.0.0', main: 'code.js', networkAccess: { allowedDomains: ['api.example.com'] } });
    const rt = await PluginRuntime.start(
      {
        manifest,
        code: `(async () => {
          const r = await fetch('https://api.example.com/items', { method: 'POST', body: 'x=1', headers: { 'Content-Type': 'text/plain' } });
          const json = await r.json();
          const r2 = await fetch('https://api.example.com/raw');
          const buf = new Uint8Array(await r2.arrayBuffer());
          let denied = null;
          try { await fetch('https://evil.com/'); } catch (e) { denied = e.message; }
          figma.notify(JSON.stringify({ status: r.status, ok: r.ok, json, type: r.headers.get('content-type'), x: r.headersObject['x-test'], len: buf.length, denied }));
          figma.closePlugin();
        })();`,
      },
      e,
    );
    const start = Date.now();
    while (rt.state === 'running' && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 5));
    expect(rt.error).toBeNull();
    expect(JSON.parse(notes[0]!)).toEqual({
      status: 201,
      ok: true,
      json: { hello: 'мир' },
      type: 'application/json',
      x: '1',
      len: new TextEncoder().encode(JSON.stringify({ hello: 'мир' })).length,
      denied: 'Адрес https://evil.com/ не разрешён в manifest.networkAccess (allowedDomains)',
    });
    expect(calls).toEqual(['POST https://api.example.com/items x=1', 'GET https://api.example.com/raw ']);
  });
});

describe('quick action parameters', () => {
  it('input suggestions, run after input, menu commands', async () => {
    const { pluginCommands } = await import('../src/manifest.ts');
    const { manifest } = parseManifest({
      name: 'Icons',
      id: 'icons',
      api: '1.0.0',
      main: 'code.js',
      menu: [
        { name: 'Вставить', command: 'insert', parameters: [{ name: 'Иконка', key: 'icon' }, { name: 'Размер', key: 'size', allowFreeform: true, optional: true }] },
        { separator: true },
        { name: 'Ещё', menu: [{ name: 'Настройки', command: 'settings' }] },
      ],
    });
    expect(pluginCommands(manifest)).toEqual([
      { command: 'insert', path: ['Вставить'], parameters: [{ name: 'Иконка', key: 'icon' }, { name: 'Размер', key: 'size', allowFreeform: true, optional: true }], parameterOnly: true },
      { command: 'settings', path: ['Ещё', 'Настройки'], parameters: undefined, parameterOnly: true },
    ]);
    const replies: unknown[] = [];
    const { notes, env: e } = env({ suggestions: (id, r) => replies.push([id, r]) });
    const rt = await PluginRuntime.start(
      {
        manifest,
        code: `
          const icons = ['arrow', 'arrow-down', 'bell', 'book'];
          figma.parameters.on('input', ({ key, query, parameters, result }) => {
            if (key === 'icon') result.setSuggestions(icons.filter((i) => i.startsWith(query)).map((name) => ({ name, data: { id: name } })));
            else if (!/^\d*$/.test(query)) result.setError('Только числа');
            else result.setSuggestions(['16', '24'].concat(query ? [query] : []));
          });
          figma.on('run', ({ command, parameters }) => {
            figma.notify(JSON.stringify({ command, parameters }));
            figma.closePlugin();
          });
        `,
      },
      e,
      { command: 'insert', deferRun: true },
    );
    rt.parameterInput(1, 'icon', 'ar', {});
    rt.parameterInput(2, 'size', 'x', { icon: { id: 'arrow' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(replies).toEqual([
      [1, { suggestions: [{ name: 'arrow', data: { id: 'arrow' } }, { name: 'arrow-down', data: { id: 'arrow-down' } }] }],
      [2, { error: 'Только числа' }],
    ]);
    expect(notes).toEqual([]);
    rt.run('insert', { icon: { id: 'arrow' }, size: '32' });
    expect(JSON.parse(notes[0]!)).toEqual({ command: 'insert', parameters: { icon: { id: 'arrow' }, size: '32' } });
  });
});

describe('Plugin API: common small things', () => {
  it('setRelaunchData, aspect ratio, selection colors, component from a layer, activeUsers, fonts, external links', async () => {
    const opened: string[] = [];
    let selection: string[] = [];
    const { notes, env: e } = env({
      openExternal: (url) => opened.push(url),
      getSelection: () => selection,
      setSelection: (ids) => (selection = ids),
      currentUser: { id: 'u1', name: 'Аня', color: '#f00', sessionId: 5 },
    });
    await run(
      `(async () => {
        const r = figma.createRectangle();
        r.fills = [figma.util.solidPaint('#ff0000')];
        r.strokes = [figma.util.solidPaint('#0000ff')];
        r.setRelaunchData({ edit: 'Изменить фигуру' });
        const relaunch = r.getRelaunchData();
        const before = r.targetAspectRatio;
        r.resize(200, 100);
        r.lockAspectRatio();
        const locked = [r.constrainProportions, r.targetAspectRatio];
        r.unlockAspectRatio();
        const f = figma.createFrame(); f.name = 'Карточка';
        const t = figma.createEllipse(); f.appendChild(t);
        t.fills = [figma.util.solidPaint('#ff0000')];
        figma.currentPage.selection = [r, f];
        const colors = figma.getSelectionColors();
        const comp = figma.createComponentFromNode(f);
        const wrapped = figma.createComponentFromNode(figma.createStar());
        const fonts = await figma.listAvailableFontsAsync();
        figma.openExternal('https://example.com/docs');
        let bad = null; try { figma.openExternal('javascript:alert(1)'); } catch (e) { bad = e.message; }
        figma.notify(JSON.stringify({
          relaunch, before, locked, unlocked: r.constrainProportions,
          colors: colors.paints.length, comp: [comp.type, comp.name, comp.children.length, f.removed],
          wrapped: [wrapped.type, wrapped.children[0].type],
          users: figma.activeUsers.map((u) => u.name), fonts: fonts[0].fontName.family, bad,
        }));
        figma.closePlugin();
      })();`,
      e,
    );
    expect(JSON.parse(notes[0]!)).toEqual({
      relaunch: { edit: 'Изменить фигуру' },
      before: null,
      locked: [true, { x: 200, y: 100 }],
      unlocked: false,
      // Red, blue and the white fill of the new frame (default).
      colors: 3,
      comp: ['COMPONENT', 'Карточка', 1, true],
      wrapped: ['COMPONENT', 'STAR'],
      users: ['Аня'],
      fonts: 'Inter',
      bad: 'openExternal: нужен адрес http(s)://',
    });
    expect(opened).toEqual(['https://example.com/docs']);
  });
});

describe('Plugin API: vector networks', () => {
  it('setVectorNetworkAsync with a fork and a region, reading vectorNetwork and vectorPaths, handleMirroring', async () => {
    const { doc, page, notes, env: e } = env();
    await run(
      `
      (async () => {
      const v = figma.createVector();
      v.x = 100; v.y = 50;
      await v.setVectorNetworkAsync({
        vertices: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }, { x: 50, y: 10, handleMirroring: 'ANGLE' }],
        segments: [
          { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 },
          { start: 1, end: 4, tangentStart: { x: 5, y: -5 }, tangentEnd: { x: -5, y: -5 } },
        ],
        regions: [{ windingRule: 'NONZERO', loops: [[0, 1, 2, 3]] }],
      });
      const net = v.vectorNetwork;
      const mixed = v.handleMirroring === figma.mixed;
      v.handleMirroring = 'ANGLE_AND_LENGTH';
      let bad = '';
      try { await v.setVectorNetworkAsync({ vertices: [{ x: 0, y: 0 }], segments: [{ start: 0, end: 3 }] }); } catch (err) { bad = String(err.message || err); }
      figma.notify(JSON.stringify({
        box: [v.x, v.y, v.width, Math.round(v.height * 100) / 100],
        counts: [net.vertices.length, net.segments.length, net.regions.length],
        first: net.vertices[0],
        curve: net.segments[4].tangentStart,
        straight: net.segments[0].tangentStart,
        paths: v.vectorPaths.map((p) => p.data),
        mixed,
        mirroring: v.handleMirroring,
        bad,
      }));
      figma.closePlugin();
      })();
    `,
      e,
    );
    const out = JSON.parse(notes[0]!);
    // Bounds follow the shape (the curve to vertex 4 bulges upward): the node is moved, vertices are relative to the bounds corner.
    expect(out.box[0]).toBe(110);
    expect(out.box[2]).toBe(40);
    expect(out.box[1]).toBeLessThan(60);
    expect(out.counts).toEqual([5, 5, 1]);
    expect(out.first.x).toBe(0);
    expect(out.curve).toEqual({ x: 5, y: -5 });
    expect(out.straight).toEqual({ x: 0, y: 0 });
    expect(out.paths).toHaveLength(1);
    expect(out.paths[0]).toMatch(/^M0 [\d.]+L20 [\d.]+L20 [\d.]+L0 [\d.]+Z$/);
    expect(out.mixed).toBe(true);
    expect(out.mirroring).toBe('ANGLE_AND_LENGTH');
    expect(out.bad).toMatch(/несуществующую вершину/);
    // The document has the network, fill paths (region) and centerlines (a fork gives three chains).
    const vec = doc.children(page).find((id) => doc.type(id) === 'VECTOR')!;
    expect(doc.get(vec, 'vectorNetwork')?.blob).toBeDefined();
    expect(doc.get(vec, 'centerPaths')).toHaveLength(1);
  });
});


describe('TextPath Plugin API', () => {
  it('converts a shape in place and exposes editable text with immutable base geometry', async () => {
    const { doc, page, notes, env: e } = env();
    await run(`
      const a=figma.createRectangle(); a.name='Path'; a.resize(200,100); a.x=17;
      const id=a.id;
      const p=figma.createTextPath(a,1,0.25);
      p.characters='Text along path'; p.fontSize=24;
      p.setRangeFontSize(0,4,30);
      let blocked=0;
      for (const prop of ['vectorNetwork','vectorPaths','handleMirroring']) {
        try { p[prop]=p[prop]; } catch(e) { blocked++; }
      }
      figma.notify(JSON.stringify({same:p.id===id,type:p.type,start:p.textPathStartData,
        count:figma.currentPage.findAllWithCriteria({types:['TEXT_PATH']}).length,
        paths:p.vectorPaths.length,segments:p.vectorNetwork.segments.length,blocked}));
      figma.closePlugin();
    `, e);
    expect(JSON.parse(notes[0]!)).toEqual({same:true,type:'TEXT_PATH',start:{segment:1,position:0.25},count:1,paths:1,segments:4,blocked:3});
    const id=doc.children(page)[0]!;
    expect(doc.type(id)).toBe('TEXT');
    expect(doc.get(id,'textPath')?.offset).toBeCloseTo(225,6);
    expect(doc.get(id,'characters')).toBe('Text along path');
    expect(doc.get(id,'transform')?.[2]).toBe(17);
    expect(doc.get(id,'textRuns')?.length).toBeGreaterThan(0);
  });

  it('validates before conversion and before changing the starting point; clone retains path', async () => {
    const { doc, page, notes, env: e } = env();
    await run(`
      const a=figma.createEllipse(); a.resize(200,200);
      let rejected=0;
      for (const [seg,pos] of [[-1,0],[99,0],[0,-1],[0,1.01],[0.5,0]]) {
        try {figma.createTextPath(a,seg,pos)} catch(e) {rejected++}
      }
      figma.notify(a.type+':'+rejected);
      const p=figma.createTextPath(a,2,0.5); p.characters='Circle';
      p.textPathStartData={segment:3,position:0.25};
      try {p.textPathStartData={segment:0,position:2}} catch(e) {rejected++}
      const b=p.clone();
      figma.notify(JSON.stringify({type:b.type,start:b.textPathStartData,rejected}));
      figma.closePlugin();
    `, e);
    expect(notes[0]).toBe('ELLIPSE:5');
    expect(JSON.parse(notes[1]!)).toEqual({type:'TEXT_PATH',start:{segment:3,position:0.25},rejected:6});
    const ids=doc.children(page);
    expect(ids).toHaveLength(2);
    expect(doc.get(ids[0]!,'textPath')).toEqual(doc.get(ids[1]!,'textPath'));
    expect(doc.get(ids[0]!,'textPath')?.offset).toBeGreaterThan(500);
  });

  it('supports all documented vector-like inputs and rejects frames/text', async () => {
    const { notes, env: e } = env();
    await run(`
      const shapes=[figma.createRectangle(),figma.createEllipse(),figma.createPolygon(),figma.createStar(),figma.createLine()];
      const v=figma.createVector();v.vectorPaths=[{windingRule:'NONZERO',data:'M0 0L80 0L80 50'}];shapes.push(v);
      const converted=shapes.map(s=>figma.createTextPath(s,0,0).type);
      let rejected=0;
      for(const n of [figma.createFrame(),figma.createText()]) {try {figma.createTextPath(n,0,0)}catch(e){rejected++}}
      figma.notify(JSON.stringify({converted,rejected}));figma.closePlugin();
    `, e);
    expect(JSON.parse(notes[0]!)).toEqual({converted:Array(6).fill('TEXT_PATH'),rejected:2});
  });
});

it('TextPath conversion survives undo/redo and .mfp reload with the same node ID', async () => {
  const { doc, page, env: e }=env();
  const id=doc.create('RECTANGLE',page,{width:200,height:100,name:'Base'});
  const before=doc.snapshot();
  await run(`const p=figma.createTextPath(figma.getNodeById('${id}'),2,0.5);p.characters='Persistent';figma.closePlugin();`, e);
  const after=doc.snapshot();
  while(doc.type(id)!=='RECTANGLE' && doc.canUndo) doc.undo();
  expect(doc.snapshot()).toEqual(before);
  while(doc.canRedo) doc.redo();
  expect(doc.snapshot()).toEqual(after);
  const { blob }=await writeMfp(doc,null);
  const reopened=await readMfp(new MemorySource(new Uint8Array(await blob.arrayBuffer())));
  expect(reopened.doc.get(id,'textPath')).toEqual(doc.get(id,'textPath'));
  expect(reopened.doc.get(id,'characters')).toBe('Persistent');
});

it('exposes old editor-created paths without mutating them on read', async () => {
 const { doc, page, notes, env: e }=env();
 const id=doc.create('TEXT',page,{characters:'Old path',textPath:{data:'M0 0L100 0L100 50',offset:125}});
 const before=doc.snapshot();
 await run(`const p=figma.getNodeById('${id}');figma.notify(JSON.stringify({type:p.type,start:p.textPathStartData,segments:p.vectorNetwork.segments.length,paths:p.vectorPaths.length}));figma.closePlugin();`,e);
 expect(JSON.parse(notes[0]!)).toEqual({type:'TEXT_PATH',start:{segment:1,position:expect.closeTo(0.5,6)},segments:2,paths:1});
 expect(doc.snapshot()).toEqual(before);
});

it('supports autoRename for regular text and paths, including range insert/delete', async () => {
 const {notes,env:e}=env();
 await run(`
  const nodes=[figma.createText(),figma.createTextPath(figma.createEllipse(),0,0)];
  const result=[];
  for(const n of nodes) {
    n.characters='Alpha'; const first=[n.autoRename,n.name];
    n.insertCharacters(5,' Beta'); const inserted=n.name;
    n.deleteCharacters(0,6); const deleted=n.name;
    n.name='Custom'; n.characters='Gamma'; const manual=[n.autoRename,n.name];
    n.autoRename=true; n.characters='Delta';
    result.push({first,inserted,deleted,manual,enabled:[n.autoRename,n.name]});
  }
  figma.notify(JSON.stringify(result));figma.closePlugin();
 `,e);
 expect(JSON.parse(notes[0]!)).toEqual(Array(2).fill({first:[true,'Alpha'],inserted:'Alpha Beta',deleted:'Beta',manual:[false,'Custom'],enabled:[true,'Delta']}));
});
