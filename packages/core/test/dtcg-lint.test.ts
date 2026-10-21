import { describe, expect, it } from 'vitest';
import {
  DesignSync,
  Document,
  addMode,
  alias,
  createCollection,
  createStyle,
  createVariable,
  detachInstance,
  exportDtcg,
  importDtcg,
  instantiate,
  lintDesign,
  localCollections,
  localStyles,
  parseDtcgColor,
  setVariableValue,
  variablesIn,
  type Op,
} from '@mfp/core';

function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Page' });
  const sync = new DesignSync(doc);
  doc.onChange((ops: Op[], origin: string) => {
    sync.observe(ops);
    if (origin === 'local') doc.amend(() => sync.trackOverrides(ops));
    if (origin === 'local' || origin === 'layout') doc.amend(() => sync.propagate(ops));
  });
  return { doc, page };
}

/** Theme: light / dark, base colors, a referenced background, spacing and an expression; text styles and shadows. */
function theme(doc: Document) {
  return doc.transact(() => {
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
    doc.set(gap, { scopes: ['GAP'], description: 'Gap' });
    createVariable(doc, 'Space/Double', coll, 'FLOAT', { type: 'EXPRESSION', expression: '{Space/Gap} * 2' });
    createStyle(doc, 'TEXT', 'Text/H1', { fontName: { family: 'Inter', style: 'Bold' }, fontSize: 32, lineHeight: { unit: 'PIXELS', value: 40 } });
    createStyle(doc, 'EFFECT', 'Shadow/Card', { effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true, blendMode: 'NORMAL' }] });
    return { coll, light, dark, white, black, bg, gap };
  });
}

describe('DTCG', () => {
  it('export: a file per collection and mode, references “{a.b}”, color 2025.10, composite tokens', () => {
    const { doc } = setup();
    theme(doc);
    const files = exportDtcg(doc);
    expect(files.map((f) => f.name)).toEqual(['Theme.Light.tokens.json', 'Theme.Dark.tokens.json', 'Styles.tokens.json']);
    const dark = JSON.parse(files[1]!.json);
    expect(dark.Surface.Bg).toEqual({ $type: 'color', $value: '{Base.Black}' });
    expect(dark.Base.Black.$value).toEqual({ colorSpace: 'srgb', components: [0, 0, 0], hex: '#000000' });
    expect(dark.Space.Gap).toMatchObject({ $type: 'number', $value: 12, $description: 'Gap', $extensions: { 'com.mfp': { scopes: ['GAP'] } } });
    expect(dark.Space.Double).toMatchObject({ $value: 24, $extensions: { 'com.mfp': { expression: '{Space/Gap} * 2' } } });
    const styles = JSON.parse(files[2]!.json);
    expect(styles.Text.H1).toMatchObject({ $type: 'typography', $value: { fontFamily: 'Inter', fontWeight: 700, fontSize: { value: 32, unit: 'px' }, lineHeight: 1.25 } });
    expect(styles.Shadow.Card.$value).toMatchObject({ offsetY: { value: 4, unit: 'px' }, blur: { value: 12, unit: 'px' } });
  });

  it('importing the export into a new document — the same collections, modes, values and references', () => {
    const a = setup();
    theme(a.doc);
    const files = exportDtcg(a.doc);
    const b = setup();
    const report = b.doc.transact(() => importDtcg(b.doc, files));
    expect(report.warnings).toEqual([]);
    expect(report.collections).toBe(1);
    expect(report.styles).toBe(2);
    const coll = localCollections(b.doc)[0]!;
    expect(b.doc.get(coll, 'modes')!.map((m) => m.name)).toEqual(['Light', 'Dark']);
    const byName = Object.fromEntries(variablesIn(b.doc, coll).map((v) => [b.doc.get(v, 'name'), v]));
    const [light, dark] = b.doc.get(coll, 'modes')!.map((m) => m.modeId);
    const bg = b.doc.get(byName['Surface/Bg']!, 'valuesByMode')!;
    expect(bg[light!]).toEqual(alias(byName['Base/White']!));
    expect(bg[dark!]).toEqual(alias(byName['Base/Black']!));
    expect(b.doc.get(byName['Space/Gap']!, 'valuesByMode')).toEqual({ [light!]: 8, [dark!]: 12 });
    expect(b.doc.get(byName['Space/Gap']!, 'scopes')).toEqual(['GAP']);
    expect(b.doc.get(byName['Space/Double']!, 'valuesByMode')![dark!]).toEqual({ type: 'EXPRESSION', expression: '{Space/Gap} * 2' });
    const h1 = localStyles(b.doc, 'TEXT')[0]!;
    expect(b.doc.get(h1, 'fontName')).toEqual({ family: 'Inter', style: 'Bold' });
    expect(b.doc.get(h1, 'lineHeight')).toEqual({ unit: 'PIXELS', value: 40 });
  });

  it('colors in old notations: hex, short hex, rgba()', () => {
    expect(parseDtcgColor('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseDtcgColor('#00000080')!.a).toBeCloseTo(0.5, 2);
    expect(parseDtcgColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
  });
});

describe('DTCG: number units', () => {
  it('rem — dimension { value, unit: rem } round trip; percentages and “unitless” — as a number with the unit in an extension', () => {
    const doc = new Document({ clientId: 1 });
    doc.create('PAGE', doc.root, { name: 'Pg' });
    doc.transact(() => {
      const coll = createCollection(doc, 'Tokens');
      const space = createVariable(doc, 'space/m', coll, 'FLOAT', 1.5);
      const leading = createVariable(doc, 'text/leading', coll, 'FLOAT', 1.4);
      doc.set(space, { unit: 'REM' });
      doc.set(leading, { unit: 'MULTIPLIER' });
    });
    const files = exportDtcg(doc);
    const json = JSON.parse(files.find((x) => x.name.startsWith('Tokens'))!.json);
    expect(json.space.m).toMatchObject({ $type: 'dimension', $value: { value: 1.5, unit: 'rem' } });
    expect(json.text.leading).toMatchObject({ $type: 'number', $value: 1.4 });
    const b = new Document({ clientId: 2 });
    b.create('PAGE', b.root, { name: 'Pg' });
    b.transact(() => importDtcg(b, files));
    const byName = (n: string) => [...b.descendants(b.root)].find((id) => b.type(id) === 'VARIABLE' && b.get(id, 'name') === n)!;
    expect(b.get(byName('space/m'), 'unit')).toBe('REM');
    expect(Object.values(b.get(byName('space/m'), 'valuesByMode') ?? {})).toEqual([1.5]);
    expect(b.get(byName('text/leading'), 'unit')).toBe('MULTIPLIER');
    // A third-party file: “1rem” as a string is rem too.
    const c = new Document({ clientId: 3 });
    c.create('PAGE', c.root, { name: 'Pg' });
    c.transact(() => importDtcg(c, [{ name: 'x.tokens.json', json: JSON.stringify({ gap: { $type: 'dimension', $value: '0.75rem' } }) }]));
    const gap = [...c.descendants(c.root)].find((id) => c.type(id) === 'VARIABLE')!;
    expect([c.get(gap, 'unit'), Object.values(c.get(gap, 'valuesByMode') ?? {})[0]]).toEqual(['REM', 0.75]);
  });
});

describe('design lint', () => {
  it('color and number matching variables — with a fix; contrast; detached component', () => {
    const { doc, page } = setup();
    const t = theme(doc);
    const frame = doc.create('FRAME', page, { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], layoutMode: 'HORIZONTAL', itemSpacing: 8 });
    doc.create('TEXT', frame, { name: 'Faint', characters: 'Barely visible', fills: [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }] });
    const comp = doc.create('COMPONENT', page, { name: 'Button' });
    const inst = doc.transact(() => instantiate(doc, comp, page, [1, 0, 0, 0, 1, 300]));
    const detached = doc.transact(() => detachInstance(doc, inst));
    const issues = lintDesign(doc, page);
    const kinds = issues.map((i) => `${i.kind}:${doc.get(i.id, 'name') ?? ''}`);
    expect(kinds).toContain('color:Frame');
    expect(kinds).toContain('number:Frame');
    expect(kinds).toContain('contrast:Faint');
    expect(kinds).toContain(`detached:${doc.get(detached, 'name')}`);
    // Fix everything that can be fixed.
    doc.transact(() => issues.forEach((i) => i.fix && doc.has(i.id) && i.fix.apply(doc)));
    expect(doc.get(frame, 'fills')![0]!.boundVariables?.color?.id).toBeTruthy();
    expect(doc.get(frame, 'boundVariables')!.itemSpacing!.id).toBe(t.gap);
    expect(doc.has(detached)).toBe(false);
    const left = lintDesign(doc, page).map((i) => i.kind);
    expect(left).toEqual(['contrast']);
  });
});
