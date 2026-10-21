import { expect, it } from 'vitest';
import { MemorySource, readMfp, writeMfp } from '@mfp/io-figma';
import { Document, DesignSync, addMode, alias, applyStyle, bindPaintVariable, collectClipboardResources, createCollection, createStyle, createVariable, insertClipboardResources, instantiate, prepareClipboardTree, remapClipboardProps, setInstanceProperties, setVariableValue, type ClipboardResources, type NodeRecord, type PatternPaint } from '../src/index.ts';

const tree = (d: Document, id: string): NodeRecord[] => [id, ...d.descendants(id)].map(k => structuredClone(d.node(k)!));
function sync(d: Document) {
  const s = new DesignSync(d);
  d.onChange((ops, origin) => {
    s.observe(ops);
    if (origin === 'local') d.amend(() => s.trackOverrides(ops));
    if (origin === 'local' || origin === 'clipboard' || origin === 'layout') d.amend(() => s.propagate(ops));
  });
  return d;
}
function fixture() {
  const d = sync(new Document({ clientId: 1 }));
  const page = d.create('PAGE', d.root);
  const coll = createCollection(d, 'Theme');
  const primary = createVariable(d, 'Primary', coll, 'COLOR', { r: 1, g: 0, b: 0, a: 1 });
  const color = createVariable(d, 'Alias', coll, 'COLOR', alias(primary));
  const dark = addMode(d, coll, 'Dark');
  setVariableValue(d, primary, dark, { r: 0, g: 0, b: 1, a: 1 });
  const style = createStyle(d, 'TEXT', 'Body', { fontSize: 14 });
  const icon = d.create('COMPONENT', page, { name: 'Icon', width: 10, height: 10 });
  const master = d.create('COMPONENT', page, { name: 'Button', width: 100, height: 30, componentPropertyDefinitions: { Icon: { type: 'INSTANCE_SWAP', defaultValue: icon, preferredValues: [icon] } } });
  const label = d.create('TEXT', master, { characters: primary });
  applyStyle(d, label, 'textStyleId', style);
  bindPaintVariable(d, master, 'fills', 0, color);
  const nested = d.transact(() => instantiate(d, icon, master, [1, 0, 0, 0, 1, 0]));
  d.set(nested, { componentPropertyReferences: { mainComponent: 'Icon' } });
  const alternate = d.create('COMPONENT', page, { name: 'Alternate', width: 20, height: 20 });
  const frame = d.create('FRAME', page, { explicitVariableModes: { [coll]: dark } });
  const instance = d.transact(() => instantiate(d, master, frame, [1, 0, 0, 0, 1, 0]));
  d.transact(() => setInstanceProperties(d, instance, { Icon: alternate }));
  return { d, page, coll, primary, color, dark, style, icon, alternate, master, label, frame, instance };
}
function paste(d: Document, page: string, trees: NodeRecord[][], bundle: ClipboardResources, same = false) {
  const map = new Map<string, string>();
  d.transact(() => {
    const visible: [string, string][] = [];
    for (const source of trees) for (const [i, n] of prepareClipboardTree(source).entries()) {
      const id = d.create(n.type, i ? map.get(n.parent!)! : page, n.props);
      map.set(n.id, id); visible.push([n.id, id]);
    }
    insertClipboardResources(d, bundle, map, 'source-document', same);
    for (const [from, to] of visible) d.set(to, remapClipboardProps(d.props(to), map, bundle.swapProperties[from]));
  }, 'clipboard');
  return map;
}

it('copies masters, swaps, styles and two-mode alias variables despite colliding IDs; live edits propagate', () => {
  const f = fixture(), trees = [tree(f.d, f.frame)];
  const bundle = collectClipboardResources(f.d, trees);
  const d = sync(new Document({ clientId: 1 })), page = d.create('PAGE', d.root);
  const unrelated = createCollection(d, 'Theme');
  const token = createVariable(d, 'Primary', unrelated, 'FLOAT', 999);
  const otherStyle = createStyle(d, 'TEXT', 'Body', { fontSize: 99 });
  const map = paste(d, page, trees, bundle);
  expect(map.get(f.coll)).not.toBe(unrelated);
  expect(d.get(token, 'valuesByMode')).toEqual({ [d.get(unrelated, 'defaultModeId')!]: 999 });
  expect(d.get(otherStyle, 'fontSize')).toBe(99);
  expect(d.get(map.get(f.instance)!, 'componentId')).toBe(map.get(f.master));
  const child = d.children(map.get(f.instance)!)[0]!;
  expect(d.get(child, 'componentRef')).toBe(map.get(f.label));
  expect(d.get(child, 'textStyleId')).toBe(map.get(f.style));
  expect(d.get(child, 'characters')).toBe(f.primary); // literal ID-like text
  expect(d.get(child, 'overrides')).toBeUndefined();
  expect(d.get(map.get(f.master)!, 'componentPropertyDefinitions')!.Icon!.defaultValue).toBe(map.get(f.icon));
  expect(d.get(map.get(f.instance)!, 'componentProperties')!.Icon).toBe(map.get(f.alternate));
  expect(d.get(d.children(map.get(f.instance)!)[1]!, 'componentId')).toBe(map.get(f.alternate));
  expect(d.get(map.get(f.frame)!, 'explicitVariableModes')).toEqual({ [map.get(f.coll)!]: map.get(f.dark) });
  expect(d.get(map.get(f.color)!, 'valuesByMode')![map.get(f.dark)!]).toEqual(alias(map.get(f.primary)!));
  d.transact(() => d.set(map.get(f.master)!, { width: 180 }));
  expect(d.get(map.get(f.instance)!, 'width')).toBe(180);
  d.transact(() => d.set(map.get(f.label)!, { characters: 'Edited master' }));
  expect(d.get(child, 'characters')).toBe('Edited master');
  d.transact(() => d.set(map.get(f.style)!, { fontSize: 23 }));
  expect(d.get(child, 'fontSize')).toBe(23);
  d.transact(() => setVariableValue(d, map.get(f.primary)!, map.get(f.dark)!, { r: 0, g: 1, b: 0, a: 1 }));
  expect(d.get(map.get(f.instance)!, 'fills')![0]).toMatchObject({ color: { r: 0, g: 1, b: 0 } });
  const fresh = d.transact(() => instantiate(d, map.get(f.master)!, page, [1, 0, 0, 0, 1, 0]));
  expect(d.get(fresh, 'clipboardSource')).toBeUndefined();
  expect(d.get(d.children(fresh)[0]!, 'clipboardSource')).toBeUndefined();
});

it('freezes dependencies, shares repeated pastes after reopening mfp, and groups resources with Undo/Redo', async () => {
  const f = fixture(), trees = [tree(f.d, f.frame)], bundle = collectClipboardResources(f.d, trees);
  f.d.set(f.master, { width: 999 });
  let d = new Document({ clientId: 2 }); const page = d.create('PAGE', d.root);
  const before = d.snapshot(), map = paste(d, page, trees, bundle);
  expect(d.get(map.get(f.master)!, 'width')).toBe(100);
  const after = d.snapshot();
  d.undo(); expect(d.snapshot()).toEqual(before);
  d.redo(); expect(d.snapshot()).toEqual(after);
  const { blob } = await writeMfp(d, null);
  d = (await readMfp(new MemorySource(new Uint8Array(await blob.arrayBuffer())))).doc;
  d.set(map.get(f.coll)!, { modes: d.get(map.get(f.coll)!, 'modes')!.map(m => ({ ...m, name: 'Renamed' })) });
  const count = d.size, again = paste(d, page, trees, bundle);
  expect(again.get(f.master)).toBe(map.get(f.master));
  expect(again.get(f.dark)).toBe(map.get(f.dark));
  expect(d.size - count).toBe(trees[0]!.length);
});

it('reuses same-document resources and recovers a deleted master from the snapshot', () => {
  const f = fixture(), trees = [tree(f.d, f.frame)], bundle = collectClipboardResources(f.d, trees);
  let map = paste(f.d, f.page, trees, bundle, true);
  expect(map.get(f.master)).toBe(f.master); expect(map.get(f.dark)).toBe(f.dark);
  f.d.delete(f.master);
  map = paste(f.d, f.page, trees, bundle, true);
  expect(f.d.type(map.get(f.master)!)).toBe('COMPONENT');
  expect(f.d.children(map.get(f.master)!)).toHaveLength(2);
});

it('follows resource references inside nested cyclic pattern motifs', () => {
  const f = fixture();
  const paint = (sourceNodeId: string): PatternPaint => ({ type: 'PATTERN', sourceNodeId, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' });
  const motif = f.d.create('FRAME', f.page, { fills: [paint(f.master)] });
  f.d.set(f.master, { strokes: [paint(motif)] });
  const user = f.d.create('RECTANGLE', f.page, { fills: [paint(motif)] });
  const trees = [tree(f.d, user)], bundle = collectClipboardResources(f.d, trees);
  expect(bundle.nodes.some(n => n.id === f.style)).toBe(true);
  expect(bundle.nodes.some(n => n.id === f.color)).toBe(true);
  const d = new Document({ clientId: 2 }), page = d.create('PAGE', d.root);
  const map = paste(d, page, trees, bundle);
  expect((d.get(map.get(user)!, 'fills')![0] as PatternPaint).sourceNodeId).toBe(map.get(motif));
  expect((d.get(map.get(motif)!, 'fills')![0] as PatternPaint).sourceNodeId).toBe(map.get(f.master));
  expect((d.get(map.get(f.master)!, 'strokes')![0] as PatternPaint).sourceNodeId).toBe(map.get(motif));
});

it('keeps a selected master child both in its dependency master and as a visible copy', () => {
  const f = fixture(), trees = [tree(f.d, f.label), tree(f.d, f.frame)];
  const d = new Document({ clientId: 2 }), page = d.create('PAGE', d.root);
  const map = paste(d, page, trees, collectClipboardResources(f.d, trees));
  const label = d.children(map.get(f.master)!)[0]!;
  expect(d.get(label, 'characters')).toBe(f.primary);
  expect(d.get(d.children(map.get(f.instance)!)[0]!, 'componentRef')).toBe(label);
  expect(d.children(page).map(id => d.type(id))).toEqual(['TEXT', 'FRAME']);
});

it('preserves nested instance overrides but detaches extracted ordinary fragments', () => {
  const f = fixture(); const child = f.d.children(f.instance)[0]!;
  f.d.set(f.instance, { overrides: ['width'] });
  f.d.set(child, { overrides: ['characters'] });
  const whole = prepareClipboardTree(tree(f.d, f.frame));
  expect(whole.find(n => n.id === child)!.props.componentRef).toBe(f.label);
  expect(whole.find(n => n.id === f.instance)!.props.overrides).toEqual(['width']);
  expect(prepareClipboardTree(tree(f.d, child))[0]!.props.componentRef).toBeUndefined();
  expect(prepareClipboardTree(tree(f.d, child))[0]!.props.overrides).toBeUndefined();
  expect(f.d.get(child, 'componentRef')).toBe(f.label);
});

it('rewrites typed prototype variable references, preserving opaque effects and text', () => {
  const f = fixture();
  f.d.set(f.frame, { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'SET_VARIABLE', variableId: f.primary }, { type: 'SET_VARIABLE_MODE', variableCollectionId: f.coll, variableModeId: f.dark }] }] });
  const bundle = collectClipboardResources(f.d, [tree(f.d, f.frame)]);
  expect(bundle.nodes.some(n => n.id === f.primary)).toBe(true);
  const p = remapClipboardProps({ characters: f.primary, effects: [{ type: 'UNSUPPORTED_FIGMA', visible: true, originalType: 'CUSTOM', raw: { type: 'VARIABLE_ALIAS', id: f.primary } }], reactions: f.d.get(f.frame, 'reactions') }, new Map([[f.primary, 'v'], [f.coll, 'c'], [f.dark, 'm']]));
  expect(p.characters).toBe(f.primary);
  expect(p.effects![0]).toMatchObject({ raw: { id: f.primary } });
  expect(p.reactions![0]!.actions).toEqual([{ type: 'SET_VARIABLE', variableId: 'v' }, { type: 'SET_VARIABLE_MODE', variableCollectionId: 'c', variableModeId: 'm' }]);
});

