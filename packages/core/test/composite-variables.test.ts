import { describe, expect, it } from 'vitest';
import {
  DesignSync,
  Document,
  addMode,
  alias,
  angleOfGradient,
  bindPaintGradient,
  bindVariable,
  createCollection,
  createVariable,
  cssVariables,
  exportDtcg,
  gradientTransformFor,
  importDtcg,
  localCollections,
  setExplicitMode,
  setVariableValue,
  variablesIn,
  type GradientPaint,
  type Op,
  type ShadowEffect,
} from '@mfp/core';

/** Document with links, as in the editor. */
function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Страница' });
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
  return { doc, page };
}

const BLUE = { r: 0, g: 0, b: 1, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 1 };

/** Theme (light / dark): brand color, a gradient referencing it, shadows, typography with a referenced font size. */
function theme(doc: Document) {
  return doc.transact(() => {
    const c = createCollection(doc, 'Тема');
    const light = doc.get(c, 'modes')![0]!.modeId;
    doc.set(c, { modes: [{ modeId: light, name: 'Светлая' }] });
    const dark = addMode(doc, c, 'Тёмная');
    const brand = createVariable(doc, 'Бренд', c, 'COLOR', BLUE);
    setVariableValue(doc, brand, dark, RED);
    const size = createVariable(doc, 'Кегль/L', c, 'FLOAT', 20);
    const grad = createVariable(doc, 'Градиент/Главный', c, 'GRADIENT', { type: 'GRADIENT', gradientType: 'GRADIENT_LINEAR', angle: 180, stops: [{ position: 0, color: alias(brand) }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] });
    const shadow = createVariable(doc, 'Тень/Карточка', c, 'SHADOW', { type: 'SHADOWS', shadows: [{ color: { r: 0, g: 0, b: 0, a: 0.2 }, x: 0, y: 4, blur: 12, spread: 0 }, { inner: true, color: alias(brand), x: 0, y: 1, blur: 0, spread: 0 }] });
    const typo = createVariable(doc, 'Текст/Заголовок', c, 'TYPOGRAPHY', { type: 'TYPOGRAPHY', fontFamily: 'Inter', fontStyle: 'Bold', fontSize: alias(size), lineHeight: { unit: 'PERCENT', value: 120 }, letterSpacing: { unit: 'PERCENT', value: -1 } });
    return { c, light, dark, brand, size, grad, shadow, typo };
  });
}

describe('composite variables', () => {
  it('gradient angle ⇄ matrix, as in CSS', () => {
    expect(gradientTransformFor(90)).toEqual([[1, 0, 0], [0, 1, 0]]);
    for (const a of [0, 45, 135, 180, 270, 300]) expect(angleOfGradient(gradientTransformFor(a))).toBeCloseTo(a, 6);
  });

  it('gradient on a paint: stops with references, mode on a frame, editing a brand color reaches the layer', () => {
    const { doc, page } = setup();
    const t = theme(doc);
    const frame = doc.transact(() => doc.create('FRAME', page, { width: 100, height: 100 }));
    const r = doc.transact(() => doc.create('RECTANGLE', frame, { width: 10, height: 10, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }));
    doc.transact(() => bindPaintGradient(doc, r, 'fills', 0, t.grad));
    const g = () => doc.get(r, 'fills')![0] as GradientPaint;
    expect(g().type).toBe('GRADIENT_LINEAR');
    expect(g().gradientStops[0]!.color).toEqual(BLUE);
    expect(angleOfGradient(g().gradientTransform)).toBeCloseTo(180, 6);
    // Dark theme on the frame — the stop comes from the brand's dark value.
    doc.transact(() => setExplicitMode(doc, frame, t.c, t.dark));
    expect(g().gradientStops[0]!.color).toEqual(RED);
    // Editing the color variable itself reaches the layer through the gradient.
    doc.transact(() => setVariableValue(doc, t.brand, t.dark, { r: 0, g: 1, b: 0, a: 1 }));
    expect(g().gradientStops[0]!.color).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(g().boundVariables?.gradient?.id).toBe(t.grad);
  });

  it('shadows: replace the layer\'s shadows, blur stays; an own effect edit detaches', () => {
    const { doc, page } = setup();
    const t = theme(doc);
    const r = doc.transact(() =>
      doc.create('RECTANGLE', page, { width: 10, height: 10, effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 9, y: 9 }, radius: 0, visible: true, blendMode: 'NORMAL' }, { type: 'LAYER_BLUR', radius: 3, visible: true }] }),
    );
    doc.transact(() => bindVariable(doc, r, 'shadows', t.shadow));
    const fx = doc.get(r, 'effects')!;
    expect(fx.map((e) => e.type)).toEqual(['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR']);
    expect((fx[0] as ShadowEffect).offset).toEqual({ x: 0, y: 4 });
    expect((fx[1] as ShadowEffect).color).toEqual(BLUE);
    doc.transact(() => doc.set(r, { effects: [fx[2]!] }));
    expect(doc.get(r, 'boundVariables')?.shadows).toBeUndefined();
  });

  it('typography: font, style, size by reference and spacing; editing the size variable reaches the text', () => {
    const { doc, page } = setup();
    const t = theme(doc);
    const txt = doc.transact(() => doc.create('TEXT', page, { characters: 'Привет', fontName: { family: 'Roboto', style: 'Regular' }, fontSize: 12 }));
    doc.transact(() => bindVariable(doc, txt, 'typography', t.typo));
    expect(doc.get(txt, 'fontName')).toEqual({ family: 'Inter', style: 'Bold' });
    expect(doc.get(txt, 'fontSize')).toBe(20);
    expect(doc.get(txt, 'lineHeight')).toEqual({ unit: 'PERCENT', value: 120 });
    expect(doc.get(txt, 'letterSpacing')).toEqual({ unit: 'PERCENT', value: -1 });
    doc.transact(() => setVariableValue(doc, t.size, t.light, 28));
    expect(doc.get(txt, 'fontSize')).toBe(28);
    // A custom font size no longer comes from the variable.
    doc.transact(() => doc.set(txt, { fontSize: 14 }));
    expect(doc.get(txt, 'boundVariables')?.typography).toBeUndefined();
  });

  it('DTCG: composite tokens in the collection file, references inside — “{path}”; import returns the variables', () => {
    const a = setup();
    theme(a.doc);
    const files = exportDtcg(a.doc);
    const light = JSON.parse(files.find((f) => f.name === 'Тема.Светлая.tokens.json')!.json);
    expect(light['Градиент']['Главный']).toMatchObject({ $type: 'gradient', $value: [{ color: '{Бренд}', position: 0 }, { position: 1 }] });
    expect(light['Тень']['Карточка'].$value[1]).toMatchObject({ color: '{Бренд}', inset: true, offsetY: { value: 1, unit: 'px' } });
    expect(light['Текст']['Заголовок']).toMatchObject({ $type: 'typography', $value: { fontFamily: 'Inter', fontWeight: 700, fontSize: '{Кегль.L}', lineHeight: 1.2 } });
    const b = setup();
    const report = b.doc.transact(() => importDtcg(b.doc, files));
    expect(report.warnings).toEqual([]);
    const coll = localCollections(b.doc)[0]!;
    const byName = Object.fromEntries(variablesIn(b.doc, coll).map((v) => [b.doc.get(v, 'name'), v]));
    const def = b.doc.get(coll, 'modes')![0]!.modeId;
    const grad = b.doc.get(byName['Градиент/Главный']!, 'valuesByMode')![def];
    expect(b.doc.get(byName['Градиент/Главный']!, 'resolvedType')).toBe('GRADIENT');
    expect(grad).toMatchObject({ type: 'GRADIENT', angle: 180, stops: [{ color: alias(byName['Бренд']!) }, { position: 1 }] });
    const typo = b.doc.get(byName['Текст/Заголовок']!, 'valuesByMode')![def];
    expect(typo).toMatchObject({ type: 'TYPOGRAPHY', fontStyle: 'Bold', fontSize: alias(byName['Кегль/L']!), lineHeight: { unit: 'PERCENT', value: 120 } });
  });

  it('CSS: gradient, box-shadow and font; references inside — var()', () => {
    const { doc } = setup();
    theme(doc);
    const css = cssVariables(doc);
    expect(css).toContain('--градиент-главный: linear-gradient(180deg, var(--бренд) 0%, #ffffff 100%);');
    expect(css).toContain('--тень-карточка: 0px 4px 12px 0px #00000033, inset 0px 1px 0px 0px var(--бренд);');
    expect(css).toContain('--текст-заголовок: 700 var(--кегль-l)/1.2 "Inter";');
    expect(css).toContain('--текст-заголовок-letter-spacing: -0.01em;');
  });
});
