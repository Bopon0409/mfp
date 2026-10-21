import { describe, expect, it } from 'vitest';
import {
  DesignSync,
  Document,
  acceptsChildren,
  addComponentProperty,
  addMode,
  alias,
  applyStyle,
  bindPaintVariable,
  bindVariable,
  combineAsVariants,
  createCollection,
  createStyle,
  collectionVariables,
  createVariable,
  defaultMode,
  extendCollection,
  setVariableOverride,
  variableValueIn,
  evaluateExpression,
  exposedPropertyKeys,
  instancePropertyValues,
  instantiate,
  rangeValue,
  resetOverrides,
  restyleText,
  setExplicitMode,
  setInstanceProperties,
  setPropertyReference,
  setVariableValue,
  swapComponent,
  userPages,
  type Op,
} from '@mfp/core';

/** Document with links, as in the editor: own edits are overrides; derived values are in the same step. */
function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Page' });
  const sync = new DesignSync(doc);
  let depth = 0;
  doc.onChange((ops: Op[], origin: string) => {
    sync.observe(ops);
    if (depth > 32) return;
    depth++;
    try {
      if (origin === 'local') doc.amend(() => sync.trackOverrides(ops));
      if (origin === 'local' || origin === 'layout') doc.amend(() => sync.propagate(ops));
    } finally {
      depth--;
    }
  });
  return { doc, page, sync };
}

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

/** Button: variant set Size=S/L × State=Default/Hover, with an icon and a label inside. */
function buttonSet() {
  const env = setup();
  const { doc, page } = env;
  const ids: Record<string, string> = {};
  doc.transact(() => {
    const comps: string[] = [];
    for (const [i, name] of ['Size=S, State=Default', 'Size=L, State=Default', 'Size=S, State=Hover', 'Size=L, State=Hover'].entries()) {
      const c = doc.create('COMPONENT', page, { name, width: name.includes('L') ? 200 : 100, height: 40, transform: [1, 0, i * 220, 0, 1, 0], fills: [{ type: 'SOLID', color: name.includes('Hover') ? BLUE : RED }] });
      doc.create('RECTANGLE', c, { name: 'Icon', width: 16, height: 16 });
      doc.create('TEXT', c, { name: 'Label', characters: name.includes('L') ? 'Large' : 'Small' });
      comps.push(c);
    }
    ids.set = combineAsVariants(doc, comps, page);
    [ids.sDefault, ids.lDefault, ids.sHover, ids.lHover] = comps as [string, string, string, string];
  });
  return { ...env, ...ids } as typeof env & Record<'set' | 'sDefault' | 'lDefault' | 'sHover' | 'lHover', string>;
}

describe('variant sets', () => {
  it('variant properties — by names, value order as in the set', () => {
    const { doc, set } = buttonSet();
    expect(doc.get(set, 'componentPropertyDefinitions')).toEqual({
      Size: { type: 'VARIANT', defaultValue: 'S', variantOptions: ['S', 'L'] },
      State: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Hover'] },
    });
  });

  it('switching an instance\'s variant: a new component, own edits of layers with the same name are kept', () => {
    const { doc, page, sDefault, lHover } = buttonSet();
    const inst = doc.transact(() => instantiate(doc, sDefault, page, [1, 0, 0, 0, 1, 300]));
    expect(doc.get(inst, 'name')).toBe('Component Set');
    const label = doc.children(inst)[1]!;
    doc.set(label, { characters: 'Buy' });
    doc.transact(() => setInstanceProperties(doc, inst, { Size: 'L', State: 'Hover' }));
    expect(doc.get(inst, 'componentId')).toBe(lHover);
    expect(doc.get(inst, 'width')).toBe(200);
    expect(doc.get(inst, 'fills')).toEqual([{ type: 'SOLID', color: BLUE }]);
    const label2 = doc.children(inst)[1]!;
    expect(doc.get(label2, 'characters')).toBe('Buy');
    expect(doc.get(label2, 'overrides')).toEqual(['characters']);
    expect(instancePropertyValues(doc, inst)).toEqual({ Size: 'L', State: 'Hover' });
    // Undo restores the previous variant.
    doc.undo();
    expect(doc.get(inst, 'componentId')).toBe(sDefault);
  });

  it('a new variant (rename) — in the set definitions', () => {
    const { doc, set, lHover } = buttonSet();
    doc.set(lHover, { name: 'Size=XL, State=Hover' });
    expect(doc.get(set, 'componentPropertyDefinitions')!.Size!.variantOptions).toEqual(['S', 'L', 'XL']);
  });

  it('a variant property is added to all names', () => {
    const { doc, set, sDefault } = buttonSet();
    doc.transact(() => addComponentProperty(doc, set, 'Theme', 'VARIANT', 'Light'));
    expect(doc.get(sDefault, 'name')).toBe('Size=S, State=Default, Theme=Light');
    expect(doc.get(set, 'componentPropertyDefinitions')!.Theme).toEqual({ type: 'VARIANT', defaultValue: 'Light', variantOptions: ['Light'] });
  });
});

describe('component properties', () => {
  function card() {
    const env = setup();
    const { doc, page } = env;
    const comp = doc.create('COMPONENT', page, { name: 'Card', width: 200, height: 100 });
    const icon = doc.create('RECTANGLE', comp, { name: 'Icon' });
    const title = doc.create('TEXT', comp, { name: 'Title', characters: 'Heading' });
    const showIcon = doc.transact(() => addComponentProperty(doc, comp, 'Show icon', 'BOOLEAN', true));
    const text = doc.transact(() => addComponentProperty(doc, comp, 'Title', 'TEXT', 'Heading'));
    doc.transact(() => {
      setPropertyReference(doc, icon, 'visible', showIcon);
      setPropertyReference(doc, title, 'characters', text);
    });
    const inst = doc.transact(() => instantiate(doc, comp, page, [1, 0, 0, 0, 1, 200]));
    return { ...env, comp, icon, title, showIcon, text, inst };
  }

  it('keys “name#id”, default values', () => {
    const { doc, comp, showIcon, text, inst } = card();
    expect(showIcon).toMatch(/^Show icon#\d+:\d+$/);
    expect(doc.get(comp, 'componentPropertyDefinitions')![text]).toEqual({ type: 'TEXT', defaultValue: 'Heading' });
    expect(instancePropertyValues(doc, inst)).toEqual({ [showIcon]: true, [text]: 'Heading' });
  });

  it('instance values go to bound layers; a layer edit is a property value, not an override', () => {
    const { doc, inst, showIcon, text } = card();
    const [iIcon, iTitle] = doc.children(inst);
    doc.transact(() => setInstanceProperties(doc, inst, { 'Show icon': false, [text]: 'Hello' }));
    expect(doc.get(iIcon!, 'visible')).toBe(false);
    expect(doc.get(iTitle!, 'characters')).toBe('Hello');
    // Editing bound text in an instance sets the property value.
    doc.set(iTitle!, { characters: 'Bye' });
    expect(doc.get(inst, 'componentProperties')![text]).toBe('Bye');
    expect(doc.get(iTitle!, 'overrides')).toBeUndefined();
    doc.set(iIcon!, { visible: true });
    expect(doc.get(inst, 'componentProperties')![showIcon]).toBe(true);
  });

  it('default value: an edit in the component reaches all instances without their own value', () => {
    const { doc, comp, title, inst, text } = card();
    const other = doc.transact(() => instantiate(doc, comp, doc.parent(comp)!, [1, 0, 0, 0, 1, 400]));
    doc.transact(() => setInstanceProperties(doc, other, { [text]: 'Custom' }));
    doc.set(title, { characters: 'New title' });
    expect(doc.get(comp, 'componentPropertyDefinitions')![text]!.defaultValue).toBe('New title');
    expect(doc.get(doc.children(inst)[1]!, 'characters')).toBe('New title');
    expect(doc.get(doc.children(other)[1]!, 'characters')).toBe('Custom');
  });

  it('reset: property values and edits as in the main component', () => {
    const { doc, inst, text, title } = card();
    doc.transact(() => setInstanceProperties(doc, inst, { [text]: 'Hello' }));
    doc.set(doc.children(inst)[0]!, { opacity: 0.5 });
    doc.transact(() => resetOverrides(doc, inst));
    expect(doc.get(doc.children(inst)[1]!, 'characters')).toBe(doc.get(title, 'characters'));
    expect(doc.get(doc.children(inst)[0]!, 'opacity')).toBe(1);
  });

  it('swapping a nested instance via a property; copies follow the swap in the main component', () => {
    const env = setup();
    const { doc, page } = env;
    const star = doc.create('COMPONENT', page, { name: 'Star' });
    doc.create('STAR', star, { name: 'Shape' });
    const heart = doc.create('COMPONENT', page, { name: 'Heart' });
    doc.create('VECTOR', heart, { name: 'Shape' });
    doc.create('ELLIPSE', heart, { name: 'Dot' });
    const button = doc.create('COMPONENT', page, { name: 'Button' });
    const nested = doc.transact(() => instantiate(doc, star, button, [1, 0, 0, 0, 1, 0]));
    const swap = doc.transact(() => addComponentProperty(doc, button, 'Icon', 'INSTANCE_SWAP', star));
    doc.transact(() => setPropertyReference(doc, nested, 'mainComponent', swap));
    const inst = doc.transact(() => instantiate(doc, button, page, [1, 0, 0, 0, 1, 100]));
    const copy = doc.children(inst)[0]!;
    expect(doc.get(copy, 'componentId')).toBe(star);
    doc.transact(() => setInstanceProperties(doc, inst, { Icon: heart }));
    expect(doc.get(copy, 'componentId')).toBe(heart);
    expect(doc.children(copy).map((c) => doc.get(c, 'name'))).toEqual(['Shape', 'Dot']);
    // An edit to the swapped component reaches the copy.
    doc.set(doc.children(heart)[1]!, { opacity: 0.3 });
    expect(doc.get(doc.children(copy)[1]!, 'opacity')).toBe(0.3);
    // Back to the default value — the content is again as in the main.
    doc.transact(() => setInstanceProperties(doc, inst, { Icon: star }));
    expect(doc.children(copy).map((c) => doc.get(c, 'name'))).toEqual(['Shape']);
    expect(doc.get(doc.children(copy)[0]!, 'componentRef')).toBe(doc.children(nested)[0]);
  });

  it('a manual swap of a nested instance inside an instance is an override; reset reverts it', () => {
    const env = setup();
    const { doc, page } = env;
    const a = doc.create('COMPONENT', page, { name: 'A' });
    doc.create('RECTANGLE', a, { name: 'R' });
    const b = doc.create('COMPONENT', page, { name: 'B' });
    doc.create('ELLIPSE', b, { name: 'E' });
    const outer = doc.create('COMPONENT', page, { name: 'Outer' });
    doc.transact(() => instantiate(doc, a, outer, [1, 0, 0, 0, 1, 0]));
    const inst = doc.transact(() => instantiate(doc, outer, page, [1, 0, 0, 0, 1, 100]));
    const nestedCopy = doc.children(inst)[0]!;
    doc.transact(() => swapComponent(doc, nestedCopy, b));
    expect(doc.get(nestedCopy, 'overrides')).toContain('componentId');
    expect(doc.children(nestedCopy).map((c) => doc.get(c, 'name'))).toEqual(['E']);
    doc.transact(() => resetOverrides(doc, inst));
    expect(doc.get(nestedCopy, 'componentId')).toBe(a);
    expect(doc.children(nestedCopy).map((c) => doc.get(c, 'name'))).toEqual(['R']);
  });
});

describe('styles', () => {
  it('color style: apply, a style edit reaches all layers, an own edit detaches', () => {
    const { doc, page } = setup();
    const style = doc.transact(() => createStyle(doc, 'PAINT', 'Brand/Primary', { fills: [{ type: 'SOLID', color: RED }] }));
    expect(userPages(doc)).toEqual([page]);
    const a = doc.create('RECTANGLE', page, {});
    const b = doc.create('ELLIPSE', page, {});
    doc.transact(() => {
      applyStyle(doc, a, 'fillStyleId', style);
      applyStyle(doc, b, 'strokeStyleId', style);
    });
    expect(doc.get(a, 'fills')).toEqual([{ type: 'SOLID', color: RED }]);
    expect(doc.get(b, 'strokes')).toEqual([{ type: 'SOLID', color: RED }]);
    doc.set(style, { fills: [{ type: 'SOLID', color: BLUE }] });
    expect(doc.get(a, 'fills')).toEqual([{ type: 'SOLID', color: BLUE }]);
    expect(doc.get(b, 'strokes')).toEqual([{ type: 'SOLID', color: BLUE }]);
    doc.set(a, { fills: [{ type: 'SOLID', color: RED }] });
    expect(doc.get(a, 'fillStyleId')).toBe('');
    doc.set(style, { fills: [] });
    expect(doc.get(a, 'fills')).toEqual([{ type: 'SOLID', color: RED }]);
  });

  it('text style on part of the text; a size edit detaches only that range', () => {
    const { doc, page } = setup();
    const h1 = doc.transact(() => createStyle(doc, 'TEXT', 'H1', { fontSize: 32, fontName: { family: 'Inter', style: 'Bold' }, paragraphSpacing: 8 }));
    const t = doc.create('TEXT', page, { characters: 'Headlines in text' });
    doc.transact(() => applyStyle(doc, t, 'textStyleId', h1));
    expect(doc.get(t, 'fontSize')).toBe(32);
    expect(doc.get(t, 'textStyleId')).toBe(h1);
    expect(doc.get(t, 'paragraphSpacing')).toBe(8);
    doc.transact(() => restyleText(doc, t, 0, 9, () => ({ fontSize: 40 })));
    const runs = doc.get(t, 'textRuns')!;
    expect(runs[0]).toEqual({ length: 9, style: { fontSize: 40, textStyleId: '' } });
    // A style edit goes only into runs that reference it.
    doc.set(h1, { fontSize: 36 });
    const size = (a: number, b: number) => rangeValue(doc.props(t), doc.get(t, 'textRuns'), 17, a, b, 'fontSize');
    expect(size(9, 17)).toBe(36);
    expect(size(0, 9)).toBe(40);
  });

  it('style in an instance: applying it to a copy is an override together with the value', () => {
    const { doc, page } = setup();
    const style = doc.transact(() => createStyle(doc, 'PAINT', 'Accent', { fills: [{ type: 'SOLID', color: BLUE }] }));
    const comp = doc.create('COMPONENT', page, {});
    const r = doc.create('RECTANGLE', comp, { fills: [{ type: 'SOLID', color: RED }] });
    const inst = doc.transact(() => instantiate(doc, comp, page, [1, 0, 0, 0, 1, 0]));
    const copy = doc.children(inst)[0]!;
    doc.transact(() => applyStyle(doc, copy, 'fillStyleId', style));
    expect(new Set(doc.get(copy, 'overrides'))).toEqual(new Set(['fillStyleId', 'fills']));
    doc.set(r, { fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }] });
    expect(doc.get(copy, 'fills')).toEqual([{ type: 'SOLID', color: BLUE }]);
  });
});

describe('variables', () => {
  /** Collection “Theme” with light and dark modes and a background color. */
  function theme() {
    const env = setup();
    const { doc } = env;
    const ids = doc.transact(() => {
      const coll = createCollection(doc, 'Theme');
      const light = doc.get(coll, 'modes')![0]!.modeId;
      doc.set(coll, { modes: [{ modeId: light, name: 'Light' }] });
      const dark = addMode(doc, coll, 'Dark');
      const white = createVariable(doc, 'Base/White', coll, 'COLOR', { r: 1, g: 1, b: 1, a: 1 });
      const black = createVariable(doc, 'Base/Black', coll, 'COLOR', { r: 0, g: 0, b: 0, a: 1 });
      const bg = createVariable(doc, 'Surface/Bg', coll, 'COLOR', alias(white));
      setVariableValue(doc, bg, dark, alias(black));
      const gap = createVariable(doc, 'Space/Gap', coll, 'FLOAT', 8);
      setVariableValue(doc, gap, dark, 12);
      return { coll, light, dark, white, black, bg, gap };
    });
    return { ...env, ...ids };
  }

  it('paint color from a variable; a mode on a frame changes the value for descendants', () => {
    const { doc, page, coll, dark, bg } = theme();
    const frame = doc.create('FRAME', page, { width: 100, height: 100 });
    const card = doc.create('RECTANGLE', frame, { fills: [{ type: 'SOLID', color: RED }] });
    doc.transact(() => bindPaintVariable(doc, card, 'fills', 0, bg));
    expect(doc.get(card, 'fills')![0]).toEqual({ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: alias(bg) } });
    doc.transact(() => setExplicitMode(doc, frame, coll, dark));
    expect((doc.get(card, 'fills')![0] as { color: unknown }).color).toEqual({ r: 0, g: 0, b: 0 });
    // Moved to a page (default mode) — light again.
    doc.move(card, page);
    expect((doc.get(card, 'fills')![0] as { color: unknown }).color).toEqual({ r: 1, g: 1, b: 1 });
    doc.undo();
    expect((doc.get(card, 'fills')![0] as { color: unknown }).color).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('editing a variable and a reference chain reaches all bound layers', () => {
    const { doc, page, light, white, bg } = theme();
    const r = doc.create('RECTANGLE', page, {});
    doc.transact(() => bindPaintVariable(doc, r, 'fills', 0, bg));
    doc.transact(() => setVariableValue(doc, white, light, { r: 0.9, g: 0.9, b: 0.9, a: 0.5 }));
    expect(doc.get(r, 'fills')![0]).toMatchObject({ color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 0.5 });
  });

  it('numeric field: binding, mode, an own edit detaches', () => {
    const { doc, page, coll, dark, gap } = theme();
    const f = doc.create('FRAME', page, { layoutMode: 'HORIZONTAL' });
    doc.transact(() => bindVariable(doc, f, 'itemSpacing', gap));
    expect(doc.get(f, 'itemSpacing')).toBe(8);
    doc.transact(() => setExplicitMode(doc, page, coll, dark));
    expect(doc.get(f, 'itemSpacing')).toBe(12);
    doc.set(f, { itemSpacing: 20 });
    expect(doc.get(f, 'boundVariables')).toEqual({});
    expect(doc.get(f, 'itemSpacing')).toBe(20);
  });

  it('an instance in a dark frame — dark values; the main component — light', () => {
    const { doc, page, coll, dark, bg } = theme();
    const comp = doc.create('COMPONENT', page, { name: 'Card' });
    doc.transact(() => bindPaintVariable(doc, comp, 'fills', 0, bg));
    const darkFrame = doc.create('FRAME', page, {});
    doc.transact(() => setExplicitMode(doc, darkFrame, coll, dark));
    const inst = doc.transact(() => instantiate(doc, comp, darkFrame, [1, 0, 0, 0, 1, 0]));
    expect((doc.get(inst, 'fills')![0] as { color: unknown }).color).toEqual({ r: 0, g: 0, b: 0 });
    expect((doc.get(comp, 'fills')![0] as { color: unknown }).color).toEqual({ r: 1, g: 1, b: 1 });
    // A main edit (paint opacity) — the copy is still in dark.
    doc.set(comp, { opacity: 0.9 });
    expect((doc.get(inst, 'fills')![0] as { color: unknown }).color).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('expressions: references by name, arithmetic, color with alpha', () => {
    const { doc, page, coll, dark, gap, bg } = theme();
    const double = doc.transact(() => createVariable(doc, 'Space/Double', coll, 'FLOAT', { type: 'EXPRESSION', expression: '{Space/Gap} * 2 + 1' }));
    const veil = doc.transact(() => createVariable(doc, 'Surface/Veil', coll, 'COLOR', { type: 'EXPRESSION', expression: 'alpha({Surface/Bg}, 0.5)' }));
    const f = doc.create('FRAME', page, { layoutMode: 'VERTICAL' });
    doc.transact(() => {
      bindVariable(doc, f, 'itemSpacing', double);
      bindPaintVariable(doc, f, 'fills', 0, veil);
    });
    expect(doc.get(f, 'itemSpacing')).toBe(17);
    expect(doc.get(f, 'fills')![0]).toMatchObject({ color: { r: 1, g: 1, b: 1 }, opacity: 0.5 });
    doc.transact(() => setExplicitMode(doc, f, coll, dark));
    expect(doc.get(f, 'itemSpacing')).toBe(25);
    expect(doc.get(f, 'fills')![0]).toMatchObject({ color: { r: 0, g: 0, b: 0 } });
    void gap;
    void bg;
  });

  it('logic in expressions: English and Russian word operators, comparisons, if() — visibility by negating a variable', () => {
    const { doc, page, coll, gap } = theme();
    const logged = doc.transact(() => createVariable(doc, 'Auth/LoggedIn', coll, 'BOOLEAN', true));
    const guest = doc.transact(() => createVariable(doc, 'Auth/Guest', coll, 'BOOLEAN', { type: 'EXPRESSION', expression: 'не {Auth/LoggedIn}' }));
    const r = doc.create('RECTANGLE', page, {});
    doc.transact(() => bindVariable(doc, r, 'visible', guest));
    expect(doc.get(r, 'visible')).toBe(false);
    doc.transact(() => setVariableValue(doc, logged, defaultMode(doc, coll), false));
    expect(doc.get(r, 'visible')).toBe(true);
    const ev = (e: string) => evaluateExpression(doc, e, null, coll);
    expect(ev('!{Auth/LoggedIn}')).toBe(true);
    expect(ev('not true or false')).toBe(false);
    expect(ev('{Space/Gap} > 4 && {Space/Gap} <= 8')).toBe(true);
    // Word operators work in both languages: and / и, or / или, not / не.
    expect(ev('{Space/Gap} == 8 and not {Auth/LoggedIn}')).toBe(true);
    expect(ev('{Space/Gap} == 8 и не {Auth/LoggedIn}')).toBe(true);
    expect(ev('{Space/Gap} != 8 or 1 < 0')).toBe(false);
    expect(ev('{Space/Gap} != 8 или 1 < 0')).toBe(false);
    expect(ev('not {Auth/LoggedIn}')).toBe(ev('не {Auth/LoggedIn}'));
    expect(ev('if({Auth/LoggedIn}, "Sign out", "Sign in")')).toBe('Sign in');
    expect(ev('if({Space/Gap} >= 8, {Space/Gap} * 2, 0) + 1')).toBe(17);
    expect(ev('unknown')).toBeUndefined();
    expect(ev('неизвестно')).toBeUndefined();
    void gap;
  });

  it('color style on a variable: a layer in dark mode gets the dark color', () => {
    const { doc, page, coll, dark, bg } = theme();
    const style = doc.transact(() => createStyle(doc, 'PAINT', 'Bg', { fills: [{ type: 'SOLID', color: RED, boundVariables: { color: alias(bg) } }] }));
    const frame = doc.create('FRAME', page, {});
    doc.transact(() => setExplicitMode(doc, frame, coll, dark));
    const r = doc.create('RECTANGLE', frame, {});
    doc.transact(() => applyStyle(doc, r, 'fillStyleId', style));
    expect((doc.get(r, 'fills')![0] as { color: unknown }).color).toEqual({ r: 0, g: 0, b: 0 });
    expect((doc.get(style, 'fills')![0] as { color: unknown }).color).toEqual({ r: 1, g: 1, b: 1 });
  });
});

describe('slots', () => {
  it('own slot content in an instance is a “children” edit: the main component leaves it alone, reset reverts it', () => {
    const { doc, page } = setup();
    const card = doc.create('COMPONENT', page, { name: 'Card' });
    const slot = doc.create('FRAME', card, { name: 'Content' });
    doc.create('TEXT', slot, { name: 'Placeholder', characters: 'Empty' });
    const key = doc.transact(() => addComponentProperty(doc, card, 'Content', 'SLOT', ''));
    doc.transact(() => setPropertyReference(doc, slot, 'slot', key));
    const a = doc.transact(() => instantiate(doc, card, page, [1, 0, 0, 0, 1, 100]));
    const b = doc.transact(() => instantiate(doc, card, page, [1, 0, 0, 0, 1, 300]));
    const slotA = doc.children(a)[0]!;
    const slotB = doc.children(b)[0]!;
    expect(acceptsChildren(doc, slotA)).toBe(true);
    expect(acceptsChildren(doc, a)).toBe(false);
    doc.create('RECTANGLE', slotA, { name: 'Custom' });
    expect(doc.get(slotA, 'overrides')).toEqual(['children']);
    // A new default layer in the main goes only into a slot without its own content.
    doc.create('ELLIPSE', slot, { name: 'More' });
    expect(doc.children(slotA).map((c) => doc.get(c, 'name'))).toEqual(['Placeholder', 'Custom']);
    expect(doc.children(slotB).map((c) => doc.get(c, 'name'))).toEqual(['Placeholder', 'More']);
    doc.transact(() => resetOverrides(doc, a));
    expect(doc.children(doc.children(a)[0]!).map((c) => doc.get(c, 'name'))).toEqual(['Placeholder', 'More']);
  });
});

describe('exposing nested instance properties: which ones and in what order', () => {
  it('a choice in the main component reaches copies in outer instances; without a choice — all', () => {
    const { doc, page } = setup();
    // Button with properties “Label” and “Icon”; a card with the button exposed inside.
    const button = doc.create('COMPONENT', page, { name: 'Button', width: 120, height: 40 });
    doc.create('TEXT', button, { name: 'Label', characters: 'OK' });
    const label = doc.transact(() => addComponentProperty(doc, button, 'Label', 'TEXT', 'OK'));
    const icon = doc.transact(() => addComponentProperty(doc, button, 'Icon', 'BOOLEAN', true));
    const card = doc.create('COMPONENT', page, { name: 'Card', width: 300, height: 200 });
    const nested = doc.transact(() => instantiate(doc, button, card, [1, 0, 10, 0, 1, 10]));
    doc.transact(() => doc.set(nested, { isExposedInstance: true }));
    const outer = doc.transact(() => instantiate(doc, card, page, [1, 0, 0, 0, 1, 400]));
    const copy = doc.children(outer).find((c) => doc.get(c, 'componentId') === button)!;
    expect(doc.get(copy, 'isExposedInstance')).toBe(true);
    expect(exposedPropertyKeys(doc, copy, [label, icon])).toEqual([label, icon]);
    // Icon first, label hidden: the copy in the outer instance follows.
    doc.transact(() => doc.set(nested, { exposedProperties: [icon] }));
    expect(doc.get(copy, 'exposedProperties')).toEqual([icon]);
    expect(exposedPropertyKeys(doc, copy, [label, icon])).toEqual([icon]);
    doc.transact(() => doc.set(nested, { exposedProperties: [icon, label] }));
    expect(exposedPropertyKeys(doc, copy, [label, icon])).toEqual([icon, label]);
    // A deleted property drops out of the selection.
    expect(exposedPropertyKeys(doc, copy, [label])).toEqual([label]);
  });
});

describe('units of numeric variables, as in CSS', () => {
  it('rem — from the root font size; unitless and percentages — for line height and letter spacing', () => {
    const { doc, page } = setup();
    const ids = doc.transact(() => {
      const coll = createCollection(doc, 'Tokens');
      const space = createVariable(doc, 'Space/M', coll, 'FLOAT', 1.5);
      const leading = createVariable(doc, 'Text/Leading', coll, 'FLOAT', 1.5);
      const tracking = createVariable(doc, 'Text/Tracking', coll, 'FLOAT', 2);
      doc.set(space, { unit: 'REM' });
      doc.set(leading, { unit: 'MULTIPLIER' });
      doc.set(tracking, { unit: 'PERCENT' });
      return { space, leading, tracking };
    });
    const frame = doc.create('FRAME', page, { width: 100, height: 100, layoutMode: 'VERTICAL' });
    const text = doc.create('TEXT', frame, { characters: 'Line', fontSize: 20 });
    doc.transact(() => {
      bindVariable(doc, frame, 'paddingLeft', ids.space);
      bindVariable(doc, text, 'lineHeight', ids.leading);
      bindVariable(doc, text, 'letterSpacing', ids.tracking);
    });
    expect(doc.get(frame, 'paddingLeft')).toBe(24);
    expect(doc.get(text, 'lineHeight')).toEqual({ unit: 'PERCENT', value: 150 });
    expect(doc.get(text, 'letterSpacing')).toEqual({ unit: 'PERCENT', value: 2 });
    // 1 rem = 20 px — everything in rem is recomputed.
    doc.transact(() => doc.set(doc.root, { rootFontSize: 20 }));
    expect(doc.get(frame, 'paddingLeft')).toBe(30);
    // Unit removed — just a number (pixels).
    doc.transact(() => doc.set(ids.space, { unit: undefined }));
    expect(doc.get(frame, 'paddingLeft')).toBe(1.5);
  });
});

describe('collection extensions (multi-brand)', () => {
  it('brand on a frame: an own value takes precedence, the rest as in the parent; reset and new modes', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Pg' });
    const sync = new DesignSync(doc);
    doc.onChange((ops: Op[]) => {
      sync.observe(ops);
      doc.amend(() => sync.propagate(ops));
    });
    const blue = { r: 0, g: 0, b: 1, a: 1 };
    const sky = { r: 0.5, g: 0.7, b: 1, a: 1 };
    const green = { r: 0, g: 0.6, b: 0.2, a: 1 };
    const ids = doc.transact(() => {
      const base = createCollection(doc, 'Theme');
      const light = doc.get(base, 'modes')![0]!.modeId;
      doc.set(base, { modes: [{ modeId: light, name: 'Light' }] });
      const dark = addMode(doc, base, 'Dark');
      const accent = createVariable(doc, 'Accent', base, 'COLOR', blue);
      setVariableValue(doc, accent, dark, sky);
      const bg = createVariable(doc, 'Background', base, 'COLOR', { r: 1, g: 1, b: 1, a: 1 });
      setVariableValue(doc, bg, dark, { r: 0, g: 0, b: 0, a: 1 });
      const ext = extendCollection(doc, base, 'Brand B');
      const [extLight, extDark] = doc.get(ext, 'modes')!.map((m) => m.modeId);
      setVariableOverride(doc, ext, accent, extLight!, green);
      const frame = doc.create('FRAME', page, { name: 'Brand B screen' });
      setExplicitMode(doc, frame, ext, extLight!);
      const a = doc.create('RECTANGLE', frame, { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }] });
      const b = doc.create('RECTANGLE', frame, { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }] });
      bindPaintVariable(doc, a, 'fills', 0, accent);
      bindPaintVariable(doc, b, 'fills', 0, bg);
      const plain = doc.create('RECTANGLE', page, { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }] });
      bindPaintVariable(doc, plain, 'fills', 0, accent);
      return { base, light, dark, accent, bg, ext, extLight: extLight!, extDark: extDark!, frame, a, b, plain };
    });
    const color = (id: string) => (doc.get(id, 'fills')![0] as { color: { r: number; g: number; b: number } }).color;
    expect(doc.get(ids.ext, 'modes')!.map((m) => [m.name, m.parentModeId])).toEqual([
      ['Light', ids.light],
      ['Dark', ids.dark],
    ]);
    expect(color(ids.a)).toMatchObject({ r: 0, g: 0.6, b: 0.2 });
    expect(color(ids.b)).toMatchObject({ r: 1, g: 1, b: 1 });
    expect(color(ids.plain)).toMatchObject({ r: 0, g: 0, b: 1 });
    // Brand dark mode: no own value — same as the parent in dark.
    doc.transact(() => setExplicitMode(doc, ids.frame, ids.ext, ids.extDark));
    expect(color(ids.a)).toMatchObject({ r: 0.5, g: 0.7, b: 1 });
    expect(color(ids.b)).toMatchObject({ r: 0, g: 0, b: 0 });
    // An own value in dark — and a reset in light.
    doc.transact(() => setVariableOverride(doc, ids.ext, ids.accent, ids.extDark, green));
    expect(color(ids.a)).toMatchObject({ g: 0.6 });
    doc.transact(() => setExplicitMode(doc, ids.frame, ids.ext, ids.extLight));
    doc.transact(() => setVariableOverride(doc, ids.ext, ids.accent, ids.extLight, undefined));
    expect(color(ids.a)).toMatchObject({ r: 0, g: 0, b: 1 });
    expect(variableValueIn(doc, ids.accent, ids.ext, ids.extDark)).toEqual(green);
    // A nested frame with a mode of the collection itself is closer, so it takes precedence.
    const inner = doc.transact(() => {
      const f = doc.create('FRAME', ids.frame, {});
      setExplicitMode(doc, f, ids.base, ids.dark);
      const r = doc.create('RECTANGLE', f, { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }] });
      bindPaintVariable(doc, r, 'fills', 0, ids.accent);
      return r;
    });
    expect(color(inner)).toMatchObject({ r: 0.5, g: 0.7, b: 1 });
    // A new parent mode appears in the extension too.
    const hc = doc.transact(() => addMode(doc, ids.base, 'Contrast'));
    expect(doc.get(ids.ext, 'modes')!.at(-1)).toMatchObject({ name: 'Contrast', parentModeId: hc });
    expect(collectionVariables(doc, ids.ext)).toEqual([ids.accent, ids.bg]);
  });
});
