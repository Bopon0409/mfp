import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesignSync, Document } from '@mfp/core';
import { parseManifest, PluginRuntime, type PluginBundle, type PluginEnvironment } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

function loadPlugin(name: string): PluginBundle {
  const dir = join(FIXTURES, name);
  const { manifest } = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
  const ui = typeof manifest.ui === 'string' ? readFileSync(join(dir, manifest.ui), 'utf8') : undefined;
  return { manifest, code: readFileSync(join(dir, manifest.main), 'utf8'), html: ui };
}

function createEnv() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Page 1' });
  let selection: string[] = [];
  const storage = new Map<string, unknown>();
  const log = {
    notifications: [] as string[],
    ui: [] as { html: string; options: unknown }[],
    toUI: [] as unknown[],
    uiClosed: 0,
    zoomedTo: [] as string[][],
    console: [] as string[],
  };
  const env: PluginEnvironment = {
    doc,
    getCurrentPage: () => page,
    setCurrentPage: () => {},
    getSelection: () => selection,
    setSelection: (ids) => (selection = ids),
    notify: (m) => log.notifications.push(m),
    showUI: (html, options) => log.ui.push({ html, options }),
    postToUI: (m) => log.toUI.push(m),
    setUIVisible: () => {},
    resizeUI: () => {},
    closeUI: () => log.uiClosed++,
    viewport: {
      center: () => ({ x: 0, y: 0 }),
      zoom: () => 1,
      bounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setCenter: () => {},
      setZoom: () => {},
      scrollAndZoomIntoView: (ids) => log.zoomedTo.push(ids),
    },
    storage: {
      get: async (k) => storage.get(k),
      set: async (k, v) => void storage.set(k, v),
      delete: async (k) => void storage.delete(k),
      keys: async () => [...storage.keys()],
    },
    log: (level, args) => log.console.push(`${level}: ${args.join(' ')}`),
  };
  return { doc, page, env, log, getSelection: () => selection };
}

it.each(['figma', 'dev'] as const)('skips invisible instance branches with live references in %s', async (editorType) => {
  const { doc, page, env, log } = createEnv();
  env.editorType = editorType;
  const instance = doc.create('INSTANCE', page);
  const hidden = doc.create('FRAME', instance, { visible: false });
  const child = doc.create('TEXT', hidden);
  const visible = doc.create('RECTANGLE', instance);
  const outside = doc.create('FRAME', page, { visible: false });
  const outsideChild = doc.create('TEXT', outside);
  const nested = doc.create('INSTANCE', instance, { visible: false });
  const nestedChild = doc.create('TEXT', nested);
  const before = doc.snapshot();
  const { manifest } = parseManifest({ name: 'Visibility', id: 'visibility', api: '1.0.0', main: 'code.js' });
  const rt = await PluginRuntime.start({ manifest, code: `
    const assert = (v) => { if (!v) throw new Error('visibility assertion'); };
    assert(figma.skipInvisibleInstanceChildren === ${editorType === 'dev'});
    figma.skipInvisibleInstanceChildren = false;
    const hidden = figma.getNodeById('${hidden}');
    const child = figma.getNodeById('${child}');
    const savedMethod = child.getPluginData;
    const instance = figma.getNodeById('${instance}');
    assert(instance.findAll().length === 5);
    figma.skipInvisibleInstanceChildren = true;
    assert(instance.children.length === 1 && instance.children[0].id === '${visible}');
    assert(instance.findAll().length === 1);
    assert(instance.findOne(n => n.type === 'TEXT') === null);
    assert(instance.findAllWithCriteria({types:['TEXT']}).length === 0);
    for (const id of ['${hidden}', '${child}', '${nested}', '${nestedChild}']) assert(figma.getNodeById(id) === null);
    assert(figma.getNodeById('${outside}').children[0].id === '${outsideChild}');
    let errors = 0;
    for (const f of [() => hidden.id, () => child.name, () => { child.name = 'bad'; }, () => savedMethod('x')]) {
      try { f(); } catch { errors++; }
    }
    assert(errors === 4);
    figma.getNodeByIdAsync('${child}').then(n => {
      assert(n === null);
      figma.skipInvisibleInstanceChildren = false;
      assert(child.id === '${child}' && instance.findAll().length === 5);
      figma.closePlugin();
    });
  ` }, env);
  expect(rt.state, log.console.join('\n')).toBe('closed');
  expect(doc.snapshot()).toEqual(before);
});

it.each([false, true])('groups plugin actions and honors commitUndo=%s', async (split) => {
  const { doc, page, env } = createEnv(); doc.clearHistory();
  const { manifest } = parseManifest({ name: 'Undo', id: 'undo-test', api: '1.0.0', main: 'code.js' });
  const rt = await PluginRuntime.start({ manifest, code: `
    const r = figma.createRectangle(); r.name = 'First'; r.resize(160, 80);
    ${split ? 'figma.commitUndo(); figma.commitUndo();' : ''}
    const e = figma.createEllipse(); e.name = 'Second'; figma.closePlugin();
  ` }, env);
  expect(rt.state).toBe('closed');
  expect(doc.undoDepth).toBe(split ? 2 : 1);
  const after = doc.snapshot();
  doc.undo(); expect(doc.children(page).map(id => doc.get(id, 'name'))).toEqual(split ? ['First'] : []);
  doc.redo(); expect(doc.snapshot()).toEqual(after);
});

it('finalizes changes on plugin error and keeps later editor edits separate', async () => {
  const { doc, page, env } = createEnv(); doc.clearHistory();
  const { manifest } = parseManifest({ name: 'Undo', id: 'undo-error', api: '1.0.0', main: 'code.js' });
  const rt = await PluginRuntime.start({ manifest, code: `figma.createRectangle(); figma.createEllipse(); throw new Error('test');` }, env);
  expect(rt.state).toBe('error'); expect(doc.undoDepth).toBe(1);
  const user = doc.create('TEXT', page, { characters: 'User' });
  doc.undo(); expect(doc.has(user)).toBe(false); expect(doc.children(page)).toHaveLength(2);
  doc.undo(); expect(doc.children(page)).toHaveLength(0);
});

it('includes deferred exact flatten geometry in the uninterrupted plugin undo group', async () => {
  const { doc, page, env } = createEnv(); doc.clearHistory();
  let resolve!: (svg: string) => void;
  env.flattenGeometry = () => new Promise<string>(r => { resolve = r; });
  const { manifest } = parseManifest({ name: 'Undo', id: 'undo-flatten', api: '1.0.0', main: 'code.js' });
  const rt = await PluginRuntime.start({ manifest, code: `const r = figma.createRectangle(); figma.flatten([r]); figma.closePlugin();` }, env);
  expect(rt.state).toBe('closed');
  resolve('M 0 0 L 200 0 L 200 80 L 0 80 Z'); await Promise.resolve();
  expect(doc.get(doc.children(page)[0]!, 'width')).toBe(200);
  expect(doc.undoDepth).toBe(1);
  doc.undo(); expect(doc.children(page)).toEqual([]);
});

/** Waits until the plugin exits (async steps: promises, timers, clientStorage). */
async function waitForExit(rt: PluginRuntime, ms = 2000) {
  const start = Date.now();
  while (rt.state === 'running' && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
}

describe('PluginRuntime', () => {
  it('runs a plugin in Figma format: UI → message → shapes in the document', async () => {
    const { doc, page, env, log, getSelection } = createEnv();
    const rt = await PluginRuntime.start(loadPlugin('shape-creator'), env);
    expect(rt.state).toBe('running');
    expect(log.ui).toHaveLength(1);
    expect(log.ui[0]!.html).toContain('create-shapes'); // __html__ = ui.html
    expect(log.ui[0]!.options).toMatchObject({ width: 260, height: 170 });

    // The user clicked “Create” in the plugin UI.
    rt.postFromUI({ type: 'create-shapes', count: 4, shape: 'rect' });

    const shapes = doc.children(page);
    expect(shapes).toHaveLength(4);
    expect(shapes.map((id) => doc.get(id, 'name'))).toEqual(['Square 1', 'Square 2', 'Square 3', 'Square 4']);
    expect(shapes.map((id) => doc.get(id, 'transform')![2])).toEqual([0, 150, 300, 450]);
    expect(doc.get(shapes[0]!, 'width')).toBe(120);
    expect(doc.get(shapes[0]!, 'cornerRadius')).toBe(16);
    expect(doc.get(shapes[0]!, 'fills')).toEqual([{ type: 'SOLID', color: { r: 1, g: 0.45, b: 0.1 } }]);
    expect(getSelection()).toEqual([...shapes]);
    expect(log.zoomedTo).toEqual([[...shapes]]);
    expect(log.notifications).toEqual(['Shapes created: 4']);
    expect(rt.state).toBe('closed');
    expect(log.uiClosed).toBe(1);
  });

  it('walks through the API: frames, text, clone, group, plugin data, clientStorage, timers', async () => {
    const { doc, env, log } = createEnv();
    const rt = await PluginRuntime.start(loadPlugin('api-tour'), env);
    await waitForExit(rt);
    expect(rt.error).toBeNull();
    expect(rt.closeMessage).toBe('done');
    const report = JSON.parse(log.notifications[0]!);
    expect(report).toMatchObject({
      frameChildren: ['TEXT', 'ELLIPSE'],
      copyChildren: 2,
      groupChildren: ['Card', 'Card'],
      groupBox: [100, 50, 320, 440],
      frameInGroup: [0, 0],
      absFrameX: 100,
      badgeRotation: 45,
      pluginData: 'card',
      sharedData: '1',
      keys: ['role'],
      textFound: 2,
      sameNodeIdentity: true,
      parentIsFrame: true,
      runs: 1,
      readonlyError: true,
      badFillError: true,
      mixedIsSymbol: true,
    });
    expect(report.colorFromHex.r).toBeCloseTo(1);
    expect(report.colorFromHex.g).toBeCloseTo(128 / 255);
    // The document has actually changed: a group with two cards on the page.
    const texts = [...doc.descendants(doc.root)].filter((id) => doc.type(id) === 'TEXT');
    expect(texts.map((id) => doc.get(id, 'characters'))).toEqual(['Hello from the plugin', 'Hello from the plugin']);
  });

  it('auto layout: layoutMode, layoutSizing and min/max limits', async () => {
    const { env, log } = createEnv();
    const { manifest } = parseManifest({ name: 'Sizing', id: 'sizing', api: '1.0.0', main: 'code.js', editorType: ['figma'] });
    const code = `
      const row = figma.createFrame();
      row.layoutMode = 'HORIZONTAL';
      row.primaryAxisSizingMode = 'AUTO';
      const box = figma.createRectangle();
      row.appendChild(box);
      box.layoutSizingHorizontal = 'FILL';
      let hugError = false;
      try { box.layoutSizingVertical = 'HUG'; } catch (e) { hugError = true; }
      row.minWidth = 300;
      figma.notify(JSON.stringify({ mode: row.layoutMode, rowW: row.layoutSizingHorizontal, boxW: box.layoutSizingHorizontal, grow: box.layoutGrow, hugError, min: row.minWidth, rectMode: box.layoutMode }));
      figma.closePlugin();`;
    const rt = await PluginRuntime.start({ manifest, code }, env);
    await waitForExit(rt);
    expect(rt.error).toBeNull();
    // A rectangle has no layoutMode (undefined is dropped from JSON); a frame has a real value.
    expect(JSON.parse(log.notifications[0]!)).toEqual({ mode: 'HORIZONTAL', rowW: 'FIXED', boxW: 'FILL', grow: 1, hugError: true, min: 300 });
  });

  it('stroke: strokeCap and per-side weight (figma.mixed)', async () => {
    const { env, log } = createEnv();
    const { manifest } = parseManifest({ name: 'Strokes', id: 'strokes', api: '1.0.0', main: 'code.js', editorType: ['figma'] });
    const code = `
      const line = figma.createLine();
      line.strokeCap = 'ROUND';
      const capBoth = line.strokeCap;
      const r = figma.createRectangle();
      r.strokeWeight = 2;
      r.strokeTopWeight = 5;
      const mixed = r.strokeWeight === figma.mixed;
      const sides = [r.strokeTopWeight, r.strokeRightWeight, r.strokeBottomWeight, r.strokeLeftWeight];
      r.strokeWeight = 3;
      figma.notify(JSON.stringify({ capBoth, mixed, sides, after: r.strokeWeight, right: r.strokeRightWeight }));
      figma.closePlugin();`;
    const rt = await PluginRuntime.start({ manifest, code }, env);
    await waitForExit(rt);
    expect(rt.error).toBeNull();
    expect(JSON.parse(log.notifications[0]!)).toEqual({ capBoth: 'ROUND', mixed: true, sides: [5, 2, 2, 2], after: 3, right: 3 });
  });

  it('text by ranges: setRange*, segments, insertion and deletion, figma.mixed', async () => {
    const { env, log } = createEnv();
    const { manifest } = parseManifest({ name: 'Text', id: 'text', api: '1.0.0', main: 'code.js', editorType: ['figma'] });
    const code = `
      (async () => {
        const t = figma.createText();
        await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
        t.characters = 'Hello world';
        t.setRangeFontSize(6, 11, 24);
        t.setRangeFontName(0, 5, { family: 'Inter', style: 'Bold' });
        const mixed = t.fontSize === figma.mixed;
        const seg = t.getStyledTextSegments(['fontSize', 'fontName']).map((s) => [s.characters, s.fontSize, s.fontName.style]);
        t.insertCharacters(5, ',');
        t.deleteCharacters(0, 1);
        const r = t.getRangeFontSize(0, 3);
        t.setRangeListOptions(0, t.characters.length, { type: 'UNORDERED' });
        const list = t.getRangeListOptions(0, 2);
        const weight = t.getRangeFontWeight(0, 3);
        let bad = false;
        try { t.getRangeFontSize(3, 3); } catch (e) { bad = true; }
        t.fontSize = 16;
        figma.notify(JSON.stringify({ mixed, seg, chars: t.characters, r, list, weight, bad, size: t.fontSize, names: t.getRangeAllFontNames(0, t.characters.length).map((f) => f.style) }));
        figma.closePlugin();
      })();`;
    const rt = await PluginRuntime.start({ manifest, code }, env);
    await waitForExit(rt);
    expect(rt.error).toBeNull();
    expect(JSON.parse(log.notifications[0]!)).toEqual({
      mixed: true,
      seg: [
        ['Hello', 12, 'Bold'],
        [' ', 12, 'Regular'],
        ['world', 24, 'Regular'],
      ],
      chars: 'ello, world',
      r: 12,
      list: { type: 'UNORDERED' },
      weight: 700,
      bad: true,
      size: 16,
      names: ['Bold', 'Regular'],
    });
  });

  it('text decoration: color is { value: SolidPaint | AUTO }, offset and skip-ink on the node and the range', async () => {
    const { env, log } = createEnv();
    const { manifest } = parseManifest({ name: 'Deco', id: 'deco', api: '1.0.0', main: 'code.js', editorType: ['figma'] });
    const code = `
      (async () => {
        const t = figma.createText();
        await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
        t.characters = 'Hello world';
        t.textDecoration = 'UNDERLINE';
        const auto = t.textDecorationColor;
        t.textDecorationColor = { value: { type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5 } };
        t.setRangeTextDecorationOffset(6, 11, { unit: 'PIXELS', value: 4 });
        t.textDecorationSkipInk = false;
        const color = t.textDecorationColor;
        const offset = t.textDecorationOffset;
        const range = t.getRangeTextDecorationOffset(6, 11);
        figma.notify(JSON.stringify({ auto, color, offset: offset === figma.mixed ? 'mixed' : offset, range, skip: t.textDecorationSkipInk }));
        figma.closePlugin();
      })();`;
    const rt = await PluginRuntime.start({ manifest, code }, env);
    await waitForExit(rt);
    expect(rt.error).toBeNull();
    expect(JSON.parse(log.notifications[0]!)).toEqual({
      auto: { value: 'AUTO' },
      color: { value: { type: 'SOLID', visible: true, opacity: 0.5, blendMode: 'NORMAL', color: { r: 1, g: 0, b: 0 } } },
      offset: 'mixed',
      range: { unit: 'PIXELS', value: 4 },
      skip: false,
    });
  });

  it('video: createVideoAsync and video fill', async () => {
    const { env, log } = createEnv();
    const { manifest } = parseManifest({ name: 'Video', id: 'video', api: '1.0.0', main: 'code.js', editorType: ['figma'] });
    const code = `
      (async () => {
        const bytes = new Uint8Array(32);
        bytes.set([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
        const video = await figma.createVideoAsync(bytes);
        const r = figma.createRectangle();
        r.fills = [{ type: 'VIDEO', scaleMode: 'FILL', videoHash: video.hash }];
        let bad = false;
        try { await figma.createVideoAsync(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); } catch (e) { bad = true; }
        figma.notify(JSON.stringify({ hash: video.hash.length, fill: r.fills[0].type, same: r.fills[0].videoHash === video.hash, bad }));
        figma.closePlugin();
      })();`;
    const rt = await PluginRuntime.start({ manifest, code }, env);
    await waitForExit(rt);
    expect(rt.error).toBeNull();
    expect(JSON.parse(log.notifications[0]!)).toEqual({ hash: 40, fill: 'VIDEO', same: true, bad: true });
  });

  it('stops a hung plugin without crashing the host', async () => {
    const { env } = createEnv();
    const bundle: PluginBundle = {
      manifest: { name: 'Loop', id: 'loop', api: '1.0.0', main: 'code.js' },
      code: 'while (true) {}',
    };
    const rt = await PluginRuntime.start(bundle, env, { timeLimitMs: 200 });
    expect(rt.state).toBe('error');
    expect(rt.error).toMatch(/interrupted/i);
  });

  it('reports a plugin error with a clear message', async () => {
    const { env } = createEnv();
    const bundle: PluginBundle = {
      manifest: { name: 'Bad', id: 'bad', api: '1.0.0', main: 'code.js' },
      code: 'figma.getNodeById("nope").name = "x";',
    };
    const rt = await PluginRuntime.start(bundle, env);
    expect(rt.state).toBe('error');
    expect(rt.error).toMatch(/TypeError|null/);
  });

  it('parses manifest.json and warns about unsupported fields', () => {
    const { manifest, warnings } = parseManifest({
      name: 'X',
      id: '1',
      api: '1.0.0',
      main: 'code.js',
      editorType: ['figjam'],
      permissions: ['payments'],
    });
    expect(manifest.name).toBe('X');
    expect(warnings.length).toBe(2);
    expect(() => parseManifest({ name: 'X' })).toThrow(/id/);
  });
});

describe('Plugin API: design system', () => {
  it('variables with modes, styles, variant sets and properties', async () => {
    const { doc, env, log } = createEnv();
    // As in the editor: derived edits (styles, variables, properties) are part of the plugin's edit step.
    const sync = new DesignSync(doc);
    doc.onChange((ops, origin) => {
      sync.observe(ops);
      if (origin === 'local' || origin === 'plugin') doc.amend(() => sync.trackOverrides(ops));
      if (origin === 'local' || origin === 'plugin' || origin === 'layout') doc.amend(() => sync.propagate(ops));
    });
    const { manifest } = parseManifest({ name: 'DS', id: 'ds', api: '1.0.0', main: 'code.js', editorType: ['figma'] });
    const code = `
      (async () => {
        const coll = figma.variables.createVariableCollection('Тема');
        const light = coll.modes[0].modeId;
        coll.renameMode(light, 'Light');
        const dark = coll.addMode('Dark');
        const bg = figma.variables.createVariable('Bg', coll, 'COLOR');
        bg.setValueForMode(light, { r: 1, g: 1, b: 1, a: 1 });
        bg.setValueForMode(dark, { r: 0, g: 0, b: 0, a: 1 });
        const frame = figma.createFrame();
        frame.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }, 'color', bg)];
        const before = frame.fills[0].color;
        frame.setExplicitVariableModeForCollection(coll, dark);
        const after = frame.fills[0].color;
        const resolved = bg.resolveForConsumer(frame).value;
        const gap = figma.variables.createVariable('Gap', coll, 'FLOAT');
        gap.setValueForMode(light, 8);
        gap.setValueForMode(dark, 16);
        frame.layoutMode = 'HORIZONTAL';
        frame.setBoundVariable('itemSpacing', gap);
        const spacing = frame.itemSpacing;
        const bound = Object.keys(frame.boundVariables).sort();
        const style = figma.createPaintStyle();
        style.name = 'Brand/Red';
        style.paints = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
        const rect = figma.createRectangle();
        rect.fillStyleId = style.id;
        const rectColor = rect.fills[0].color;
        style.paints = [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }];
        const rectColor2 = rect.fills[0].color;
        const styles = (await figma.getLocalPaintStylesAsync()).map((s) => [s.name, s.type]);
        const a = figma.createComponent();
        a.name = 'State=Default';
        const b = figma.createComponent();
        b.name = 'State=Hover';
        b.x = 200;
        const set = figma.combineAsVariants([a, b], figma.currentPage);
        const key = set.addComponentProperty('Label', 'TEXT', 'Купить');
        const inst = a.createInstance();
        inst.setProperties({ State: 'Hover' });
        const props = inst.componentProperties;
        const main = (await inst.getMainComponentAsync()).name;
        const defs = Object.keys(set.componentPropertyDefinitions);
        const variant = inst.variantProperties;
        figma.notify(JSON.stringify({ before, after, resolved, spacing, bound, rectColor, rectColor2, styles, main, props, key, defs, variant, modes: coll.modes.map((m) => m.name), vars: (await figma.variables.getLocalVariablesAsync('COLOR')).length, setType: set.type }));
        figma.closePlugin();
      })();`;
    const rt = await PluginRuntime.start({ manifest, code }, env);
    await waitForExit(rt);
    expect(rt.error).toBeNull();
    const r = JSON.parse(log.notifications[0]!);
    expect(r).toMatchObject({
      before: { r: 1, g: 1, b: 1 },
      after: { r: 0, g: 0, b: 0 },
      resolved: { r: 0, g: 0, b: 0, a: 1 },
      spacing: 16,
      bound: ['fills', 'itemSpacing'],
      rectColor: { r: 1, g: 0, b: 0 },
      rectColor2: { r: 0, g: 1, b: 0 },
      styles: [['Brand/Red', 'PAINT']],
      main: 'State=Hover',
      variant: { State: 'Hover' },
      modes: ['Light', 'Dark'],
      vars: 1,
      setType: 'COMPONENT_SET',
    });
    expect(r.defs).toEqual(['State', r.key]);
    expect(r.props).toEqual({ State: { type: 'VARIANT', value: 'Hover' }, [r.key]: { type: 'TEXT', value: 'Купить' } });
    // The internal page is not a document page.
    expect(doc.children(doc.root)).toHaveLength(2);
  });
});

describe('Plugin API: prototype', () => {
  it('reactions (and the deprecated action), setReactionsAsync, scrolling, flows and presentation background', async () => {
    const { env, log } = createEnv();
    const { manifest } = parseManifest({ name: 'Proto', id: 'proto', api: '1.0.0', main: 'code.js', editorType: ['figma'] });
    const code = `
      (async () => {
        const a = figma.createFrame();
        const b = figma.createFrame();
        const btn = figma.createRectangle();
        a.appendChild(btn);
        btn.reactions = [{ trigger: { type: 'ON_CLICK' }, action: { type: 'NODE', destinationId: b.id, navigation: 'NAVIGATE', transition: { type: 'DISSOLVE', easing: { type: 'EASE_OUT' }, duration: 0.3 }, preserveScrollPosition: false } }];
        const r1 = btn.reactions[0];
        await btn.setReactionsAsync([...btn.reactions, { trigger: { type: 'AFTER_TIMEOUT', timeout: 1 }, actions: [{ type: 'BACK' }] }]);
        a.overflowDirection = 'VERTICAL';
        const header = figma.createRectangle();
        a.appendChild(header);
        a.numberOfFixedChildren = 1;
        let bad = false;
        try { a.overflowDirection = 'DIAGONAL'; } catch (e) { bad = true; }
        let ro = false;
        try { a.overlayPositionType = 'TOP_LEFT'; } catch (e) { ro = true; }
        figma.currentPage.flowStartingPoints = [{ nodeId: a.id, name: 'Начало' }];
        figma.currentPage.prototypeBackgrounds = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        figma.notify(JSON.stringify({
          dest: r1.action.destinationId === b.id && r1.actions[0].destinationId === b.id,
          count: btn.reactions.length,
          second: btn.reactions[1].actions[0].type,
          overflow: a.overflowDirection,
          fixed: a.numberOfFixedChildren,
          headerBehavior: header.scrollBehavior,
          btnBehavior: btn.scrollBehavior,
          bad, ro,
          overlay: a.overlayPositionType,
          flows: figma.currentPage.flowStartingPoints.map((f) => f.name),
          start: figma.currentPage.prototypeStartNode.id === a.id,
          bg: figma.currentPage.prototypeBackgrounds[0].color.r,
        }));
        figma.closePlugin();
      })();`;
    const rt = await PluginRuntime.start({ manifest, code }, env);
    await waitForExit(rt);
    expect(rt.error).toBeNull();
    expect(JSON.parse(log.notifications[0]!)).toEqual({
      dest: true,
      count: 2,
      second: 'BACK',
      overflow: 'VERTICAL',
      fixed: 1,
      headerBehavior: 'FIXED',
      btnBehavior: 'SCROLLS',
      bad: true,
      ro: true,
      overlay: 'CENTER',
      flows: ['Начало'],
      start: true,
      bg: 1,
    });
  });
});

describe('developer mode in the Plugin API', () => {
  it('codegen: generate responds with code blocks; figma.mode and editorType', async () => {
    const { doc, page, env } = createEnv();
    const frame = doc.create('FRAME', page, { name: 'Card', width: 120, height: 40 });
    doc.create('TEXT', frame, { name: 'T', characters: 'Привет' });
    const results: { id: number; results: unknown; error: string | null }[] = [];
    const rt = await PluginRuntime.start(loadPlugin('codegen-sample'), {
      ...env,
      editorType: 'dev',
      mode: 'codegen',
      codegenResult: (id, r, error) => results.push({ id, results: r, error }),
    });
    rt.generate(1, frame, 'react');
    rt.generate(2, frame, 'json');
    await new Promise((r) => setTimeout(r, 20));
    expect(results.map((r) => r.id)).toEqual([1, 2]);
    const blocks = results.map((r) => (r.results as { title: string; code: string; language: string }[])[0]!);
    const react = blocks[0]!;
    const json = blocks[1]!;
    expect(react.language).toBe('TYPESCRIPT');
    expect(react.code).toContain('export function Card()');
    expect(react.code).toContain('<p>Привет</p>');
    expect(JSON.parse(json.code)).toMatchObject({ name: 'Card', type: 'FRAME', width: 120, children: [{ type: 'TEXT', text: 'Привет' }] });
    // figma.editorType and figma.mode.
    const probe = createEnv();
    await PluginRuntime.start({ manifest: { name: 'p', id: 'p', api: '1.0.0', main: 'c.js' }, code: 'figma.notify(figma.editorType + "/" + figma.mode)' }, { ...probe.env, editorType: 'dev', mode: 'codegen' });
    expect(probe.log.notifications).toEqual(['dev/codegen']);
  });

  it('status, annotations, categories and measurements', async () => {
    const { doc, page, env, log } = createEnv();
    const a = doc.create('FRAME', page, { name: 'A', width: 100, height: 50 });
    const b = doc.create('FRAME', page, { name: 'B', width: 100, height: 50, transform: [1, 0, 300, 0, 1, 0] });
    const code = `
      const [a, b] = figma.currentPage.children;
      a.devStatus = { type: 'READY_FOR_DEV', description: 'Шапка' };
      a.annotations = [{ labelMarkdown: '**Важно**: отступы', properties: [{ type: 'width' }] }];
      (async () => {
        const cats = await figma.annotations.getAnnotationCategoriesAsync();
        const mine = await figma.annotations.addAnnotationCategoryAsync({ label: 'Бэкенд', color: 'red' });
        const m = figma.currentPage.addMeasurement({ node: a, side: 'RIGHT' }, { node: b, side: 'LEFT' }, { freeText: 'зазор' });
        figma.notify([a.devStatus.type, a.annotations[0].label, cats.length, mine.label, m.start.node.name, m.end.side, figma.currentPage.getMeasurements().length].join('|'));
        figma.closePlugin();
      })();
    `;
    const rt = await PluginRuntime.start({ manifest: { name: 'd', id: 'd', api: '1.0.0', main: 'c.js' }, code }, env);
    for (let i = 0; i < 50 && rt.state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(rt.error).toBeNull();
    expect(log.notifications[0]).toBe('READY_FOR_DEV|Важно: отступы|5|Бэкенд|A|LEFT|1');
    expect(doc.get(a, 'devStatus')).toMatchObject({ type: 'READY_FOR_DEV', description: 'Шапка' });
    expect(doc.get(page, 'measurements')?.[0]).toMatchObject({ start: { node: a, side: 'RIGHT' }, end: { node: b, side: 'LEFT' }, freeText: 'зазор' });
  });
});
