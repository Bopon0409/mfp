import { describe, expect, it } from 'vitest';
import { deflateSync, zipSync } from 'fflate';
import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { Document, networkOf } from '@mfp/core';
import { buildScene, decodeFigKiwi, decodePathCommands, imageHashes, MemorySource, openFig, sceneToCore } from '../src/index.ts';
import type { FigMessage } from '../src/types.ts';

it('preserves external shader references and the exact version instead of dropping CUSTOM paints', () => {
  const guid=(localID:number)=>({sessionID:1,localID});
  const message: FigMessage = { nodeChanges: [
    {guid:guid(0),type:'DOCUMENT'},
    {guid:guid(1),type:'CANVAS',parentIndex:{guid:guid(0),position:'a'}},
    {guid:guid(2),type:'CODE_COMPONENT',key:'shader',version:'old',codeObjectType:'CUSTOM_FILL',parentIndex:{guid:guid(1),position:'a'}},
    {guid:guid(3),type:'CODE_COMPONENT',key:'shader',version:'new',codeObjectType:'CUSTOM_FILL',customToolArtifactRef:{customToolId:'resource'},parentIndex:{guid:guid(1),position:'b'}},
    {guid:guid(4),type:'RECTANGLE',name:'Shader layer',parentIndex:{guid:guid(1),position:'c'},fillPaints:[{type:'CUSTOM',opacity:0.7,customEffectId:{assetRef:{key:'shader',version:'new'}},componentPropAssignments:[{defID:guid(8),varValue:{value:{floatValue:42}}}]}]},
  ] };
  const {doc,report}=sceneToCore(buildScene(message));
  const node=doc.snapshot().nodes.find(n=>n.props.name==='Shader layer')!;
  expect(node.props.fills?.[0]).toMatchObject({type:'SHADER',code:'',opacity:0.7,figma:{reference:{assetRef:{version:'new'}},definition:{version:'new',customToolArtifactRef:{customToolId:'resource'}}}});
  expect(report.warnings.some(w=>w.includes('исходник'))).toBe(true);
  expect(Document.fromSnapshot(doc.snapshot()).snapshot()).toEqual(doc.snapshot());
});

// Simplified schema in Kiwi format: a subset of what real .fig files contain.
const SCHEMA = `
enum NodeType { DOCUMENT = 0; CANVAS = 1; FRAME = 2; SYMBOL = 3; INSTANCE = 4; RECTANGLE = 5; }
struct GUID { uint sessionID; uint localID; }
struct Vector { float x; float y; }
message GUIDPath { GUID[] guids = 1; }
message ParentIndex { GUID guid = 1; string position = 2; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; }
message NodeChange {
  GUID guid = 1;
  ParentIndex parentIndex = 2;
  NodeType type = 3;
  string name = 4;
  Vector size = 5;
  bool visible = 6;
  SymbolData symbolData = 7;
  GUIDPath guidPath = 8;
  float opacity = 9;
}
struct Blob { byte[] bytes; }
message Message { NodeChange[] nodeChanges = 1; Blob[] blobs = 2; }
`;

const g = (localID: number) => ({ sessionID: 1, localID });

function makeFigKiwi(message: FigMessage): Uint8Array {
  const schema = parseSchema(SCHEMA);
  const compiled = compileSchema(schema) as { encodeMessage(m: unknown): Uint8Array };
  const chunks = [deflateSync(encodeBinarySchema(schema)), deflateSync(compiled.encodeMessage(message))];
  const out = new Uint8Array(12 + chunks.reduce((s, c) => s + 4 + c.length, 0));
  out.set(new TextEncoder().encode('fig-kiwi'), 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 106, true);
  let offset = 12;
  for (const c of chunks) {
    view.setUint32(offset, c.length, true);
    out.set(c, offset + 4);
    offset += 4 + c.length;
  }
  return out;
}

const MESSAGE: FigMessage = {
  nodeChanges: [
    { guid: g(0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
    // Component with a single rectangle
    { guid: g(10), parentIndex: { guid: g(1), position: 'a' }, type: 'SYMBOL', name: 'Button', size: { x: 100, y: 40 } },
    { guid: g(11), parentIndex: { guid: g(10), position: 'a' }, type: 'RECTANGLE', name: 'Bg', size: { x: 100, y: 40 } },
    // Component instance with an override: the rectangle is hidden
    {
      guid: g(20),
      parentIndex: { guid: g(1), position: 'b' },
      type: 'INSTANCE',
      name: 'Button instance',
      size: { x: 100, y: 40 },
      symbolData: { symbolID: g(10), symbolOverrides: [{ guidPath: { guids: [g(11)] }, visible: false }] },
    },
    // Child order is defined by the fractional index, not by array order
    { guid: g(31), parentIndex: { guid: g(30), position: 'b' }, type: 'RECTANGLE', name: 'Top' },
    { guid: g(30), parentIndex: { guid: g(1), position: 'c' }, type: 'FRAME', name: 'Frame' },
    { guid: g(32), parentIndex: { guid: g(30), position: 'a' }, type: 'RECTANGLE', name: 'Bottom' },
  ],
  blobs: [],
};

describe('io-figma', () => {
  it('reads a .fig in a ZIP container and serves images lazily', async () => {
    const zip = zipSync({
      'canvas.fig': makeFigKiwi(MESSAGE),
      'meta.json': new TextEncoder().encode('{"file_name":"Test"}'),
      'images/abc123': new Uint8Array([1, 2, 3]),
    });
    const archive = await openFig(new MemorySource(zip));
    expect(archive.kiwi.magic).toBe('fig-kiwi');
    expect(archive.kiwi.version).toBe(106);
    expect(archive.meta).toEqual({ file_name: 'Test' });
    expect([...archive.images.keys()]).toEqual(['abc123']);
    expect(await archive.readImage('abc123')).toEqual(new Uint8Array([1, 2, 3]));
    const { message } = decodeFigKiwi(archive.kiwi);
    expect(message.nodeChanges).toHaveLength(MESSAGE.nodeChanges!.length);
  });

  it('reads fig-kiwi without the ZIP wrapper', async () => {
    const archive = await openFig(new MemorySource(makeFigKiwi(MESSAGE)));
    expect(decodeFigKiwi(archive.kiwi).message.nodeChanges?.[0]?.type).toBe('DOCUMENT');
  });

  it('builds the scene: order by fractional index and expanding instances with overrides', async () => {
    const archive = await openFig(new MemorySource(makeFigKiwi(MESSAGE)));
    const scene = buildScene(decodeFigKiwi(archive.kiwi).message);
    const page = scene.pages[0]!;
    expect(page.children.map((n) => n.name)).toEqual(['Button', 'Button instance', 'Frame']);

    const instance = page.children[1]!;
    expect(instance.children).toHaveLength(1);
    expect(instance.children[0]!.name).toBe('Bg');
    expect(instance.children[0]!.visible).toBe(false); // the override was applied
    expect(page.children[0]!.children[0]!.visible).toBe(true); // the component itself is unchanged

    expect(page.children[2]!.children.map((n) => n.name)).toEqual(['Bottom', 'Top']);
    expect(scene.stats.instancesExpanded).toBe(1);
  });

  it('decodes path commands', () => {
    const buf = new Uint8Array(1 + 8 + 1 + 8 + 1 + 24 + 1);
    const v = new DataView(buf.buffer);
    let i = 0;
    const cmd = (c: number, ...xs: number[]) => {
      buf[i++] = c;
      for (const x of xs) (v.setFloat32(i, x, true), (i += 4));
    };
    cmd(1, 0, 0);
    cmd(2, 10, 0);
    cmd(4, 10, 5, 5, 10, 0, 10);
    cmd(0);
    const ops: string[] = [];
    const ok = decodePathCommands(buf, {
      moveTo: (x, y) => ops.push(`M${x},${y}`),
      lineTo: (x, y) => ops.push(`L${x},${y}`),
      quadTo: () => ops.push('Q'),
      cubicTo: (_a, _b, _c, _d, x, y) => ops.push(`C${x},${y}`),
      close: () => ops.push('Z'),
    });
    expect(ok).toBe(true);
    expect(ops).toEqual(['M0,0', 'L10,0', 'C0,10', 'Z']);
  });
});

describe('styles and component properties', () => {
  const doc = { guid: g(0), type: 'DOCUMENT', name: 'Document' };
  const page = { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' };
  const white = { type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true };
  const stale = { type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, opacity: 1, visible: true };

  it('the fill is taken from the style, not from a stale copy in the node (also in an override)', () => {
    const scene = buildScene({
      nodeChanges: [
        doc,
        page,
        // Copy of a library style on the internal canvas.
        { guid: g(5), parentIndex: { guid: g(1), position: 'z' }, type: 'RECTANGLE', name: 'Primary/White', styleType: 'FILL', key: 'abc', fillPaints: [white] },
        { guid: g(10), parentIndex: { guid: g(1), position: 'a' }, type: 'SYMBOL', name: 'Icon', size: { x: 16, y: 16 } },
        { guid: g(11), parentIndex: { guid: g(10), position: 'a' }, type: 'VECTOR', name: 'Glyph', fillPaints: [stale] },
        {
          guid: g(20),
          parentIndex: { guid: g(1), position: 'b' },
          type: 'INSTANCE',
          name: 'Icon',
          symbolData: { symbolID: g(10), symbolOverrides: [{ guidPath: { guids: [g(11)] }, fillPaints: [stale], styleIdForFill: { assetRef: { key: 'abc', version: '1:1' } } }] },
        },
      ],
    } as FigMessage);
    const icon = scene.pages[0]!.children.find((n) => n.name === 'Icon' && n.type === 'INSTANCE')!;
    expect(icon.children[0]!.fills[0]!.color).toEqual(white.color);
  });

  it('a boolean instance property hides the bound layer', () => {
    const prop = { sessionID: 7, localID: 0 };
    const scene = buildScene({
      nodeChanges: [
        doc,
        page,
        {
          guid: g(10),
          parentIndex: { guid: g(1), position: 'a' },
          type: 'SYMBOL',
          name: 'HUD',
          componentPropDefs: [{ id: prop, name: 'notification', type: 'BOOL', initialValue: { boolValue: true } }],
        },
        { guid: g(11), parentIndex: { guid: g(10), position: 'a' }, type: 'FRAME', name: 'Toast', componentPropRefs: [{ defID: prop, componentPropNodeField: 'VISIBLE' }] },
        { guid: g(12), parentIndex: { guid: g(10), position: 'b' }, type: 'FRAME', name: 'Map' },
        { guid: g(20), parentIndex: { guid: g(1), position: 'b' }, type: 'INSTANCE', name: 'HUD', symbolData: { symbolID: g(10) }, componentPropAssignments: [{ defID: prop, value: { boolValue: false } }] },
        { guid: g(21), parentIndex: { guid: g(1), position: 'c' }, type: 'INSTANCE', name: 'HUD default', symbolData: { symbolID: g(10) } },
      ],
    } as FigMessage);
    const [, hidden, shown] = scene.pages[0]!.children;
    expect(hidden!.children.map((n) => [n.name, n.visible])).toEqual([['Toast', false], ['Map', true]]);
    expect(shown!.children[0]!.visible).toBe(true);
  });
});

describe('lazy page-by-page import', () => {
  it('first page first, the rest via a generator; links to main components at the end', () => {
    const scene = buildScene({
      nodeChanges: [
        { guid: g(0), type: 'DOCUMENT', name: 'Document' },
        { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Screens' },
        { guid: g(2), parentIndex: { guid: g(0), position: '"' }, type: 'CANVAS', name: 'Components' },
        { guid: g(20), parentIndex: { guid: g(1), position: 'a' }, type: 'INSTANCE', name: 'Button', symbolData: { symbolID: g(10) }, size: { x: 100, y: 40 } },
        { guid: g(10), parentIndex: { guid: g(2), position: 'a' }, type: 'SYMBOL', name: 'Button', size: { x: 100, y: 40 } },
        { guid: g(11), parentIndex: { guid: g(10), position: 'a' }, type: 'RECTANGLE', name: 'Background', size: { x: 100, y: 40 } },
        { guid: g(12), parentIndex: { guid: g(2), position: 'b' }, type: 'FRAME', name: 'More' },
      ],
    } as FigMessage);
    const { doc, ids, more } = sceneToCore(scene, new Document({ clientId: 1 }), { lazy: true });
    const [screens, components] = doc.children(doc.root);
    expect(doc.children(screens!)).toHaveLength(1);
    expect(doc.children(components!)).toHaveLength(0);
    const instance = ids.get('1:20')!;
    expect(doc.get(instance, 'componentId')).toBeUndefined();
    let steps = 0;
    for (const _ of more!) steps++;
    expect(steps).toBeGreaterThanOrEqual(2);
    expect(doc.children(components!).map((id) => doc.get(id, 'name'))).toEqual(['Button', 'More']);
    expect(doc.get(instance, 'componentId')).toBe(ids.get('1:10'));
    expect(doc.get(doc.children(instance)[0]!, 'componentRef')).toBe(ids.get('1:11'));
  });
});

describe('design system import', () => {
  const s = (sessionID: number, localID: number) => ({ sessionID, localID });
  const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };
  const aliasTo = (guid: { sessionID: number; localID: number }) => ({ value: { alias: { guid } }, dataType: 'ALIAS', resolvedDataType: 'COLOR' });
  const message = {
    nodeChanges: [
      { guid: g(0), type: 'DOCUMENT', name: 'Document' },
      { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
      { guid: g(2), parentIndex: { guid: g(0), position: '"' }, type: 'CANVAS', name: 'Internal Only Canvas', visible: false, internalOnly: true },
      // Style, collection “Theme” (light / dark) and a color variable on the internal canvas.
      { guid: g(3), parentIndex: { guid: g(2), position: 'a' }, type: 'ROUNDED_RECTANGLE', name: 'Brand/Red', styleType: 'FILL', key: 'st1', fillPaints: [red] },
      { guid: g(4), parentIndex: { guid: g(2), position: 'b' }, type: 'VARIABLE_SET', name: 'Theme', variableSetModes: [{ id: s(9, 1), name: 'Dark', sortPosition: 'b' }, { id: s(9, 0), name: 'Light', sortPosition: 'a' }] },
      {
        guid: g(5),
        parentIndex: { guid: g(2), position: 'c' },
        type: 'VARIABLE',
        name: 'Bg',
        variableSetID: { guid: g(4) },
        variableResolvedType: 'COLOR',
        variableDataValues: {
          entries: [
            { modeID: s(9, 0), variableData: { value: { colorValue: { r: 1, g: 1, b: 1, a: 1 } }, dataType: 'COLOR' } },
            { modeID: s(9, 1), variableData: { value: { colorValue: { r: 0, g: 0, b: 0, a: 1 } }, dataType: 'COLOR' } },
          ],
        },
      },
      // Variant set: State = Default / Hover, boolean property “Icon”.
      {
        guid: g(10),
        parentIndex: { guid: g(1), position: 'a' },
        type: 'FRAME',
        name: 'Button',
        isStateGroup: true,
        componentPropDefs: [
          { id: s(7, 0), name: 'State', type: 'VARIANT', sortPosition: 'a' },
          { id: s(8, 0), name: 'Icon', type: 'BOOL', initialValue: { boolValue: true }, sortPosition: 'b' },
        ],
        stateGroupPropertyValueOrders: [{ property: 'State', values: ['Default', 'Hover'] }],
      },
      { guid: g(11), parentIndex: { guid: g(10), position: 'a' }, type: 'SYMBOL', name: 'State=Default', componentKey: 'k-def', componentPropDefs: [{ id: s(8, 1), parentPropDefId: s(8, 0) }], transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } },
      { guid: g(12), parentIndex: { guid: g(11), position: 'a' }, type: 'RECTANGLE', name: 'Icon', componentPropRefs: [{ defID: s(8, 1), componentPropNodeField: 'VISIBLE' }], fillPaints: [red], styleIdForFill: { guid: g(3) } },
      { guid: g(13), parentIndex: { guid: g(10), position: 'b' }, type: 'SYMBOL', name: 'State=Hover', componentPropDefs: [{ id: s(8, 2), parentPropDefId: s(8, 0) }], transform: { m00: 1, m01: 0, m02: 120, m10: 0, m11: 1, m12: 0 } },
      { guid: g(14), parentIndex: { guid: g(13), position: 'a' }, type: 'RECTANGLE', name: 'Icon', componentPropRefs: [{ defID: s(8, 2), componentPropNodeField: 'VISIBLE' }] },
      // Dark frame with a “Hover” instance without the icon; background from a variable.
      {
        guid: g(20),
        parentIndex: { guid: g(1), position: 'b' },
        type: 'FRAME',
        name: 'Dark',
        variableModeBySetMap: { entries: [{ variableSetID: { guid: g(4) }, variableModeID: s(9, 1) }] },
        fillPaints: [{ ...red, colorVar: aliasTo(g(5)) }],
      },
      { guid: g(21), parentIndex: { guid: g(20), position: 'a' }, type: 'INSTANCE', name: 'Button', symbolData: { symbolID: g(13) }, componentPropAssignments: [{ defID: s(8, 2), value: { boolValue: false } }] },
    ],
  } as unknown as FigMessage;

  it('styles, variables with modes, variant sets and properties end up in the model', () => {
    const scene = buildScene(message);
    expect(scene.pages.map((p) => [p.name, !!p.internal])).toEqual([
      ['Page 1', false],
      ['Internal Only Canvas', true],
    ]);
    const { doc, ids } = sceneToCore(scene, new Document({ clientId: 1 }));
    const [userPage, resources] = doc.children(doc.root);
    expect(doc.get(resources!, 'internal')).toBe(true);
    const style = ids.get('1:3')!;
    expect(doc.type(style)).toBe('STYLE');
    expect(doc.get(style, 'styleType')).toBe('PAINT');
    expect(doc.get(style, 'key')).toBe('st1');
    // Collection: modes in order, the variable is inside the collection.
    const coll = ids.get('1:4')!;
    expect(doc.get(coll, 'modes')).toEqual([{ modeId: '9:0', name: 'Light' }, { modeId: '9:1', name: 'Dark' }]);
    expect(doc.get(coll, 'defaultModeId')).toBe('9:0');
    const bg = ids.get('1:5')!;
    expect(doc.parent(bg)).toBe(coll);
    expect(doc.get(bg, 'valuesByMode')).toEqual({ '9:0': { r: 1, g: 1, b: 1, a: 1 }, '9:1': { r: 0, g: 0, b: 0, a: 1 } });
    // Set: variants and a boolean property keyed by the set id.
    const set = ids.get('1:10')!;
    expect(doc.type(set)).toBe('COMPONENT_SET');
    expect(doc.get(set, 'componentPropertyDefinitions')).toEqual({
      State: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Hover'] },
      'Icon#8:0': { type: 'BOOLEAN', defaultValue: true },
    });
    expect(doc.get(ids.get('1:11')!, 'key')).toBe('k-def');
    expect(doc.get(ids.get('1:12')!, 'componentPropertyReferences')).toEqual({ visible: 'Icon#8:0' });
    expect(doc.get(ids.get('1:12')!, 'fillStyleId')).toBe(style);
    // Instance: property value; layer visibility is not an override.
    const inst = ids.get('1:21')!;
    expect(doc.get(inst, 'componentProperties')).toEqual({ 'Icon#8:0': false });
    const icon = doc.children(inst)[0]!;
    expect(doc.get(icon, 'visible')).toBe(false);
    expect(doc.get(icon, 'overrides')).toBeUndefined();
    // Frame mode and paint binding.
    const dark = ids.get('1:20')!;
    expect(doc.get(dark, 'explicitVariableModes')).toEqual({ [coll]: '9:1' });
    expect(doc.get(dark, 'fills')![0]!.boundVariables).toEqual({ color: { type: 'VARIABLE_ALIAS', id: bg } });
    expect(doc.parent(dark)).toBe(userPage);
  });

  it('insertion: internal assets go to an internal page, assets known by key reuse local ones', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Page' });
    const first = sceneToCore(buildScene(message), doc, { into: page });
    expect(first.roots.map((id) => doc.get(id, 'name'))).toEqual(['Button', 'Dark']);
    const resources = doc.children(doc.root).find((p) => doc.get(p, 'internal'))!;
    expect([...doc.descendants(resources)].length).toBeGreaterThan(0);
    sceneToCore(buildScene(message), doc, { into: page });
    expect([...doc.descendants(resources)].filter((id) => doc.type(id) === 'STYLE')).toHaveLength(1);
  });
});

describe('light and dark from .fig', () => {
  it('the frame mode from the file gives dark values; switching mode and variant works as in .figma', async () => {
    const { DesignSync, setExplicitMode, setInstanceProperties } = await import('@mfp/core');
    const s = (sessionID: number, localID: number) => ({ sessionID, localID });
    const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };
    const message = {
      nodeChanges: [
        { guid: g(0), type: 'DOCUMENT', name: 'Document' },
        { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
        { guid: g(2), parentIndex: { guid: g(0), position: '"' }, type: 'CANVAS', name: 'Internal Only Canvas', visible: false, internalOnly: true },
        { guid: g(4), parentIndex: { guid: g(2), position: 'b' }, type: 'VARIABLE_SET', name: 'Theme', variableSetModes: [{ id: s(9, 0), name: 'Light', sortPosition: 'a' }, { id: s(9, 1), name: 'Dark', sortPosition: 'b' }] },
        {
          guid: g(5),
          parentIndex: { guid: g(2), position: 'c' },
          type: 'VARIABLE',
          name: 'Bg',
          variableSetID: { guid: g(4) },
          variableResolvedType: 'COLOR',
          variableDataValues: {
            entries: [
              { modeID: s(9, 0), variableData: { value: { colorValue: { r: 1, g: 1, b: 1, a: 1 } }, dataType: 'COLOR' } },
              { modeID: s(9, 1), variableData: { value: { colorValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }, dataType: 'COLOR' } },
            ],
          },
        },
        { guid: g(10), parentIndex: { guid: g(1), position: 'a' }, type: 'FRAME', name: 'Button', isStateGroup: true, componentPropDefs: [{ id: s(7, 0), name: 'State', type: 'VARIANT' }], stateGroupPropertyValueOrders: [{ property: 'State', values: ['Default', 'Hover'] }] },
        // In the file, paint copies are “stale” (red); the variable provides the value.
        { guid: g(11), parentIndex: { guid: g(10), position: 'a' }, type: 'SYMBOL', name: 'State=Default', size: { x: 80, y: 30 }, fillPaints: [{ ...red, colorVar: { value: { alias: { guid: g(5) } }, dataType: 'ALIAS' } }] },
        { guid: g(13), parentIndex: { guid: g(10), position: 'b' }, type: 'SYMBOL', name: 'State=Hover', size: { x: 90, y: 30 }, fillPaints: [red] },
        { guid: g(20), parentIndex: { guid: g(1), position: 'b' }, type: 'FRAME', name: 'Dark', variableModeBySetMap: { entries: [{ variableSetID: { guid: g(4) }, variableModeID: s(9, 1) }] } },
        { guid: g(21), parentIndex: { guid: g(20), position: 'a' }, type: 'INSTANCE', name: 'Button', size: { x: 80, y: 30 }, symbolData: { symbolID: g(11) }, fillPaints: [{ ...red, colorVar: { value: { alias: { guid: g(5) } }, dataType: 'ALIAS' } }] },
      ],
    } as unknown as FigMessage;
    const { doc, ids } = sceneToCore(buildScene(message), new Document({ clientId: 1 }));
    const sync = new DesignSync(doc);
    doc.onChange((ops, origin) => {
      sync.observe(ops);
      if (origin === 'local') doc.amend(() => sync.trackOverrides(ops));
      if (origin === 'local' || origin === 'layout') doc.amend(() => sync.propagate(ops));
    });
    // After import, values in layer modes (as the editor does).
    doc.transact(() => sync.resolveAll(), 'import');
    const main = ids.get('1:11')!;
    const inst = ids.get('1:21')!;
    const color = (id: string) => (doc.get(id, 'fills')![0] as { color: unknown }).color;
    expect(color(main)).toEqual({ r: 1, g: 1, b: 1 });
    expect(color(inst)).toEqual({ r: 0.1, g: 0.1, b: 0.1 });
    // Light mode on the frame gives a light instance; the Hover variant has its own background (no variable).
    const coll = ids.get('1:4')!;
    doc.transact(() => setExplicitMode(doc, ids.get('1:20')!, coll, '9:0'));
    expect(color(inst)).toEqual({ r: 1, g: 1, b: 1 });
    doc.transact(() => setInstanceProperties(doc, inst, { State: 'Hover' }));
    expect(doc.get(inst, 'width')).toBe(90);
    expect(color(inst)).toEqual({ r: 1, g: 0, b: 0 });
    doc.transact(() => setInstanceProperties(doc, inst, { State: 'Default' }));
    doc.transact(() => setExplicitMode(doc, ids.get('1:20')!, coll, '9:1'));
    expect(color(inst)).toEqual({ r: 0.1, g: 0.1, b: 0.1 });
  });
});

describe('shape parameters from .fig', () => {
  it('ellipse arc (end before start) and star ray ratio; a full ellipse has no arcData', () => {
    const scene = buildScene({
      nodeChanges: [
        { guid: g(0), type: 'DOCUMENT', name: 'Document' },
        { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
        { guid: g(2), parentIndex: { guid: g(1), position: 'a' }, type: 'ELLIPSE', name: 'Ring', size: { x: 40, y: 40 }, arcData: { startingAngle: 1.5707963705062866, endingAngle: -1.5707961320877075, innerRadius: 0.84 } },
        { guid: g(3), parentIndex: { guid: g(1), position: 'b' }, type: 'ELLIPSE', name: 'Full', size: { x: 40, y: 40 }, arcData: { startingAngle: 0, endingAngle: 6.2831854820251465, innerRadius: 0 } },
        { guid: g(4), parentIndex: { guid: g(1), position: 'c' }, type: 'STAR', name: 'Star', size: { x: 40, y: 40 }, count: 6, starInnerScale: 0.5 },
      ],
    } as unknown as FigMessage);
    const { doc, ids } = sceneToCore(scene, new Document({ clientId: 1 }));
    const by = (name: string) => [...ids.values()].find((id) => doc.get(id, 'name') === name)!;
    expect(doc.get(by('Ring'), 'arcData')).toEqual({ startingAngle: 1.5707963705062866, endingAngle: -1.5707961320877075, innerRadius: 0.84 });
    expect(doc.node(by('Full'))!.props.arcData).toBeUndefined();
    expect(doc.get(by('Star'), 'pointCount')).toBe(6);
    expect(doc.get(by('Star'), 'innerRadius')).toBe(0.5);
  });
});

describe('vector networks from .fig', () => {
  /** Network blob: vertices [x, y, style], segments [start, end], regions [style, loops]. */
  function netBlob(vertices: [number, number, number][], segments: [number, number][], regions: [number, number[][]][]): Uint8Array {
    const words: [string, number][] = [];
    const u = (v: number) => words.push(['u', v]);
    const fl = (v: number) => words.push(['f', v]);
    u(vertices.length);
    u(segments.length);
    u(regions.length);
    for (const [x, y, st] of vertices) (u(st), fl(x), fl(y));
    for (const [a, b] of segments) (u(0), u(a), fl(0), fl(0), u(b), fl(0), fl(0));
    for (const [st, loops] of regions) {
      u(st);
      u(loops.length);
      for (const loop of loops) (u(loop.length), loop.forEach(u));
    }
    const dv = new DataView(new ArrayBuffer(words.length * 4));
    words.forEach(([t, v], i) => (t === 'u' ? dv.setUint32(i * 4, v, true) : dv.setFloat32(i * 4, v, true)));
    return new Uint8Array(dv.buffer);
  }
  /** Path in .fig format: commands (1 — M, 2 — L, 0 — Z) and float32. */
  function pathBlob(points: [number, number][]): Uint8Array {
    const bytes: number[] = [];
    const push = (cmd: number, x?: number, y?: number) => {
      bytes.push(cmd);
      if (x === undefined) return;
      const b = new Uint8Array(new Float32Array([x, y!]).buffer);
      bytes.push(...b);
    };
    points.forEach(([x, y], i) => push(i ? 2 : 1, x, y));
    push(0);
    return new Uint8Array(bytes);
  }

  it('video: video fill (like VideoPaint) and layer video settings; the hash is among the document files', () => {
    const scene = buildScene({
      nodeChanges: [
        { guid: g(0), type: 'DOCUMENT', name: 'Document' },
        { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
        {
          guid: g(2),
          parentIndex: { guid: g(1), position: 'a' },
          type: 'RECTANGLE',
          name: 'Clip',
          size: { x: 320, y: 180 },
          fillPaints: [{ type: 'VIDEO', video: { hash: new Uint8Array([0xab, 0xcd]) }, imageScaleMode: 'FIT', opacity: 0.5, visible: true }],
          videoPlayback: { autoplay: false, mediaLoop: true, muted: true },
        },
      ],
    } as unknown as FigMessage);
    const { doc, ids } = sceneToCore(scene, new Document({ clientId: 1 }));
    const id = [...ids.values()].find((x) => doc.get(x, 'name') === 'Clip')!;
    expect(doc.get(id, 'fills')).toEqual([{ type: 'VIDEO', scaleMode: 'FIT', videoHash: 'abcd', opacity: 0.5 }]);
    expect(doc.get(id, 'videoPlayback')).toEqual({ autoplay: false, loop: true, muted: true });
    expect([...imageHashes(doc)]).toContain('abcd');
  });

  it('text: variable font axes, thickness, offset, line color and skip-ink on the node and on runs; hanging punctuation', () => {
    const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5, visible: true };
    const tag = (t: string) => ((t.charCodeAt(0) << 24) | (t.charCodeAt(1) << 16) | (t.charCodeAt(2) << 8) | t.charCodeAt(3)) >>> 0;
    const scene = buildScene({
      nodeChanges: [
        { guid: g(0), type: 'DOCUMENT', name: 'Document' },
        { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
        {
          guid: g(2),
          parentIndex: { guid: g(1), position: 'a' },
          type: 'TEXT',
          name: 'Axes',
          size: { x: 200, y: 20 },
          fontSize: 16,
          fontName: { family: 'Inter', style: 'Regular', postscript: '' },
          fontVariations: [{ axisTag: tag('wdth'), axisName: 'Width', value: 80 }],
          textDecoration: 'UNDERLINE',
          textDecorationThickness: { value: 2, units: 'PIXELS' },
          textUnderlineOffset: { value: 10, units: 'PERCENT' },
          textDecorationFillPaints: [red],
          hangingPunctuation: true,
          textData: {
            characters: 'Hello world',
            characterStyleIDs: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1],
            styleOverrideTable: [{ styleID: 1, fontVariations: [{ axisTag: tag('wght'), axisName: 'Weight', value: 700 }], textDecorationSkipInk: false, textUnderlineOffset: { value: 3, units: 'PIXELS' } }],
          },
        },
      ],
    } as unknown as FigMessage);
    const { doc, ids } = sceneToCore(scene, new Document({ clientId: 1 }));
    const id = [...ids.values()].find((x) => doc.get(x, 'name') === 'Axes')!;
    expect(doc.get(id, 'fontVariations')).toEqual([{ axis: 'wdth', value: 80 }]);
    expect(doc.get(id, 'textDecorationThickness')).toEqual({ unit: 'PIXELS', value: 2 });
    expect(doc.get(id, 'textDecorationOffset')).toEqual({ unit: 'PERCENT', value: 10 });
    expect(doc.get(id, 'textDecorationColor')).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(doc.get(id, 'hangingPunctuation')).toBe(true);
    const run = doc.get(id, 'textRuns')!.find((r) => r.style.fontVariations)!;
    expect(run.length).toBe(3);
    expect(run.style).toMatchObject({ fontVariations: [{ axis: 'wght', value: 700 }], textDecorationSkipInk: false, textDecorationOffset: { unit: 'PIXELS', value: 3 } });
  });

  it('effects: progressive blur, noise, grain (texture) and glass go into the model as in the Plugin API', () => {
    const scene = buildScene({
      nodeChanges: [
        { guid: g(0), type: 'DOCUMENT', name: 'Document' },
        { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
        {
          guid: g(2),
          parentIndex: { guid: g(1), position: 'a' },
          type: 'RECTANGLE',
          name: 'Fx',
          size: { x: 100, y: 50 },
          effects: [
            { type: 'FOREGROUND_BLUR', radius: 12, visible: true, blurOpType: 'PROGRESSIVE', startRadius: 2, startOffset: { x: 0, y: 0.5 }, endOffset: { x: 1, y: 0.5 } },
            { type: 'NOISE', noiseType: 'DUOTONE', color: { r: 1, g: 0, b: 0, a: 1 }, secondaryColor: { r: 0, g: 0, b: 1, a: 0.5 }, noiseSize: { x: 3, y: 3 }, density: 0.4, blendMode: 'MULTIPLY', visible: true },
            { type: 'GRAIN', noiseSize: { x: 2, y: 2 }, radius: 5, clipToShape: false, visible: true },
            { type: 'GLASS', radius: 4, specularAngle: -30, specularIntensity: 0.7, refractionIntensity: 0.6, refractionRadius: 18, chromaticAberration: 0.25, visible: true },
          ],
        },
      ],
    } as unknown as FigMessage);
    const { doc, ids } = sceneToCore(scene, new Document({ clientId: 1 }));
    const id = [...ids.values()].find((x) => doc.get(x, 'name') === 'Fx')!;
    expect(doc.get(id, 'effects')).toEqual([
      { type: 'LAYER_BLUR', radius: 12, visible: true, blurType: 'PROGRESSIVE', startRadius: 2, startOffset: { x: 0, y: 0.5 }, endOffset: { x: 1, y: 0.5 } },
      { type: 'NOISE', noiseType: 'DUOTONE', color: { r: 1, g: 0, b: 0, a: 1 }, secondaryColor: { r: 0, g: 0, b: 1, a: 0.5 }, noiseSize: 3, density: 0.4, blendMode: 'MULTIPLY', visible: true },
      { type: 'TEXTURE', noiseSize: 2, radius: 5, clipToShape: false, visible: true },
      { type: 'GLASS', lightIntensity: 0.7, lightAngle: -30, refraction: 0.6, depth: 18, dispersion: 0.25, radius: 4, visible: true },
    ]);
  });

  it('a network with a fork and two regions: vertex styles, winding rule and region fill per contour', () => {
    // A 20×10 rectangle split in half: the left half has its own red fill, the right one the node fill.
    const verts: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
      [20, 10, 0],
      [10, 10, 2],
      [0, 10, 0],
    ];
    const segs: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 0],
      [1, 4],
    ];
    const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };
    const scene = buildScene({
      nodeChanges: [
        { guid: g(0), type: 'DOCUMENT', name: 'Document' },
        { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
        {
          guid: g(2),
          parentIndex: { guid: g(1), position: 'a' },
          type: 'VECTOR',
          name: 'Halves',
          // The node is twice the normalizedSize: the network is scaled.
          size: { x: 40, y: 20 },
          fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }],
          fillGeometry: [
            { windingRule: 'NONZERO', commandsBlob: 1, styleID: 5 },
            { windingRule: 'ODD', commandsBlob: 2 },
          ],
          vectorData: {
            vectorNetworkBlob: 0,
            normalizedSize: { x: 20, y: 10 },
            styleOverrideTable: [
              { styleID: 2, handleMirroring: 'ANGLE_AND_LENGTH', cornerRadius: 3 },
              { styleID: 5, fillPaints: [red] },
            ],
          },
        },
      ],
      blobs: [
        { bytes: netBlob(verts, segs, [[1, [[0, 6, 4, 5]]], [0, [[1, 2, 3, 6]]]]) },
        { bytes: pathBlob([[0, 0], [20, 0], [20, 20], [0, 20]]) },
        { bytes: pathBlob([[20, 0], [40, 0], [40, 20], [20, 20]]) },
      ],
    } as unknown as FigMessage);
    const { doc, ids } = sceneToCore(scene, new Document({ clientId: 1 }));
    const id = [...ids.values()].find((x) => doc.get(x, 'name') === 'Halves')!;
    const net = networkOf(doc, id)!;
    expect(net.vertices).toHaveLength(6);
    expect(net.vertices[2]).toEqual({ x: 40, y: 0 });
    expect(net.vertices[4]).toEqual({ x: 20, y: 20, handleMirroring: 'ANGLE_AND_LENGTH', cornerRadius: 3 });
    expect(net.segments[6]).toEqual({ start: 1, end: 4 });
    expect(net.regions).toHaveLength(2);
    expect(net.regions![0]).toMatchObject({ windingRule: 'NONZERO', loops: [[0, 6, 4, 5]] });
    expect(net.regions![0]!.fills![0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } });
    expect(net.regions![1]).toEqual({ windingRule: 'EVENODD', loops: [[1, 2, 3, 6]] });
    // Prebuilt fill paths remain for drawing; the first one has its own fill.
    const vp = doc.get(id, 'vectorPaths')!;
    expect(vp).toHaveLength(2);
    expect(vp[0]!.fills![0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } });
    expect(vp[1]!.fills).toBeUndefined();
    // The network is in the geometry table and in the document snapshot.
    expect(doc.snapshot().blobs?.[doc.get(id, 'vectorNetwork')!.blob!]).toBeDefined();
  });
});
