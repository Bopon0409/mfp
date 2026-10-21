import { describe, expect, it } from 'vitest';
import {
  DesignSync,
  Document,
  alias,
  applyStyle,
  bindPaintVariable,
  combineAsVariants,
  createCollection,
  createStyle,
  createVariable,
  importLibrary,
  instantiate,
  libraryAssets,
  libraryUsage,
  linkedLibraries,
  localStyles,
  localVariables,
  setInstanceProperties,
  type Op,
} from '@mfp/core';

function withSync(doc: Document) {
  const sync = new DesignSync(doc);
  doc.onChange((ops: Op[], origin: string) => {
    sync.observe(ops);
    if (origin === 'local') doc.amend(() => sync.trackOverrides(ops));
    if (origin === 'local' || origin === 'layout') doc.amend(() => sync.propagate(ops));
  });
  return doc;
}

/** Library: a color (variable), a style, a button with variants; the button's background comes from the variable. */
function library(color = { r: 0, g: 0.4, b: 1, a: 1 }) {
  const lib = withSync(new Document({ clientId: 7 }));
  const page = lib.create('PAGE', lib.root, { name: 'Компоненты' });
  lib.transact(() => {
    const coll = createCollection(lib, 'Бренд');
    const brand = createVariable(lib, 'Brand/Primary', coll, 'COLOR', color);
    createVariable(lib, 'Brand/Alias', coll, 'COLOR', alias(brand));
    createStyle(lib, 'TEXT', 'Body', { fontSize: 14 });
    const a = lib.create('COMPONENT', page, { name: 'Size=S', width: 80, height: 32 });
    const label = lib.create('TEXT', a, { name: 'Label', characters: 'Кнопка' });
    applyStyle(lib, label, 'textStyleId', localStyles(lib, 'TEXT')[0]!);
    const b = lib.create('COMPONENT', page, { name: 'Size=L', width: 120, height: 48, transform: [1, 0, 200, 0, 1, 0] });
    lib.create('TEXT', b, { name: 'Label', characters: 'Кнопка' });
    bindPaintVariable(lib, a, 'fills', 0, brand);
    combineAsVariants(lib, [a, b], page);
  });
  return lib;
}

describe('libraries', () => {
  it('linking: assets on a service page, references to own copies', () => {
    const doc = withSync(new Document({ clientId: 1 }));
    doc.create('PAGE', doc.root, { name: 'Экран' });
    const r = doc.transact(() => importLibrary(doc, library(), 'UI Kit'));
    expect(r).toMatchObject({ components: 1, styles: 1, variables: 2, updated: 0 });
    expect(linkedLibraries(doc)).toEqual(new Map([['UI Kit', 3]]));
    const [primary, aliasVar] = localVariables(doc);
    expect(doc.get(aliasVar!, 'valuesByMode')).toEqual({ [Object.keys(doc.get(aliasVar!, 'valuesByMode')!)[0]!]: alias(primary!) });
    const set = [...doc.descendants(doc.root)].find((id) => doc.type(id) === 'COMPONENT_SET')!;
    const small = doc.children(set)[0]!;
    expect(doc.get(small, 'fills')![0]!.boundVariables!.color!.id).toBe(primary);
    expect(doc.get(doc.children(small)[0]!, 'textStyleId')).toBe(localStyles(doc, 'TEXT')[0]);
  });

  it('update: the same nodes (instances stay linked), new values reach the instances', () => {
    const doc = withSync(new Document({ clientId: 1 }));
    const page = doc.create('PAGE', doc.root, { name: 'Экран' });
    doc.transact(() => importLibrary(doc, library(), 'UI Kit'));
    const set = [...doc.descendants(doc.root)].find((id) => doc.type(id) === 'COMPONENT_SET')!;
    const small = doc.children(set)[0]!;
    const inst = doc.transact(() => instantiate(doc, small, page, [1, 0, 0, 0, 1, 0]));
    doc.transact(() => setInstanceProperties(doc, inst, { Size: 'L' }));
    const large = doc.get(inst, 'componentId')!;
    // New version: a different color, a different size of the large button.
    const next = library({ r: 1, g: 0, b: 0, a: 1 });
    const bigInLib = [...next.descendants(next.root)].find((id) => next.get(id, 'name') === 'Size=L')!;
    next.transact(() => next.set(bigInLib, { width: 140 }));
    const r = doc.transact(() => importLibrary(doc, next, 'UI Kit'));
    expect(r.components).toBe(0);
    expect(r.updated).toBeGreaterThan(0);
    expect(doc.has(large)).toBe(true);
    expect(doc.get(inst, 'componentId')).toBe(large);
    expect(doc.get(inst, 'width')).toBe(140);
    expect((doc.get(small, 'fills')![0] as { color: unknown }).color).toEqual({ r: 1, g: 0, b: 0 });
    expect(localVariables(doc)).toHaveLength(2);
  });

  it('team library: keys by file id, asset list for publishing, instances by sets', () => {
    const lib = library();
    const assets = libraryAssets(lib, 'lib:F1');
    expect(assets.map((a) => [a.type, a.name])).toEqual([
      ['COMPONENT_SET', 'Component Set'],
      ['STYLE', 'Body'],
      ['VARIABLE_COLLECTION', 'Бренд'],
      ['VARIABLE', 'Brand/Primary'],
      ['VARIABLE', 'Brand/Alias'],
    ]);
    expect(assets.every((a) => a.key.startsWith('lib:F1:'))).toBe(true);
    const doc = withSync(new Document({ clientId: 1 }));
    const page = doc.create('PAGE', doc.root, { name: 'Экран' });
    doc.transact(() => importLibrary(doc, lib, 'UI Kit', 'lib:F1'));
    const set = [...doc.descendants(doc.root)].find((id) => doc.type(id) === 'COMPONENT_SET')!;
    expect(doc.get(set, 'key')).toBe(assets[0]!.key);
    // Two instances of different variants — both count toward the set.
    doc.transact(() => {
      instantiate(doc, doc.children(set)[0]!, page, [1, 0, 0, 0, 1, 0]);
      instantiate(doc, doc.children(set)[1]!, page, [1, 0, 300, 0, 1, 0]);
    });
    expect(libraryUsage(doc, 'UI Kit')).toEqual({ [assets[0]!.key]: 2 });
    // Assets of other libraries in the file do not become its own when published.
    expect(libraryAssets(doc, 'lib:F2')).toEqual([]);
  });
});

describe('selective library update', () => {
  it('what changed — by signatures; take only the selected items, the rest waits', async () => {
    const { libraryChanges } = await import('@mfp/core');
    const doc = withSync(new Document({ clientId: 1 }));
    doc.create('PAGE', doc.root, { name: 'Экран' });
    doc.transact(() => importLibrary(doc, library(), 'UI Kit'));
    expect(libraryChanges(doc, library(), 'UI Kit')).toEqual([]);
    // New version: a different brand color, a different style font size, a new component.
    const next = library({ r: 1, g: 0, b: 0, a: 1 });
    next.transact(() => {
      next.set(localStyles(next, 'TEXT')[0]!, { fontSize: 16 });
      next.create('COMPONENT', next.children(next.root).find((p) => next.get(p, 'name') === 'Компоненты')!, { name: 'Иконка', width: 24, height: 24, transform: [1, 0, 500, 0, 1, 0] });
    });
    const changes = libraryChanges(doc, next, 'UI Kit');
    expect(changes.map((c) => [c.name, c.status]).sort()).toEqual([
      ['Body', 'changed'],
      ['Brand/Primary', 'changed'],
      ['Иконка', 'new'],
    ]);
    // Only the brand color.
    const brandKey = changes.find((c) => c.name === 'Brand/Primary')!.key;
    doc.transact(() => importLibrary(doc, next, 'UI Kit', 'UI Kit', { only: new Set([brandKey]) }));
    const primary = localVariables(doc).find((v) => doc.get(v, 'name') === 'Brand/Primary')!;
    expect(Object.values(doc.get(primary, 'valuesByMode')!)[0]).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(doc.get(localStyles(doc, 'TEXT')[0]!, 'fontSize')).toBe(14);
    expect([...doc.descendants(doc.root)].some((id) => doc.get(id, 'name') === 'Иконка')).toBe(false);
    expect(libraryChanges(doc, next, 'UI Kit').map((c) => c.name).sort()).toEqual(['Body', 'Иконка']);
    // The rest — later.
    doc.transact(() => importLibrary(doc, next, 'UI Kit'));
    expect(libraryChanges(doc, next, 'UI Kit')).toEqual([]);
    expect(doc.get(localStyles(doc, 'TEXT')[0]!, 'fontSize')).toBe(16);
  });
});
