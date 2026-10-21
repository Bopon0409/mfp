import { describe, expect, it } from 'vitest';
import { addMode, bindPaintVariable, bindVariable, createCollection, createVariable, Document, setVariableValue } from '@mfp/core';
import { formatColor, generateCode, inspectNode, styleTokens, type CodeLanguage } from '../src/index.ts';

const BLUE = { r: 0.05, g: 0.6, b: 1 };

/** Button: an auto layout row with padding, corner radius, shadow, text and a color from a variable. */
function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const ids = doc.transact(() => {
    const coll = createCollection(doc, 'Тема');
    const light = doc.get(coll, 'modes')![0]!.modeId;
    const dark = addMode(doc, coll, 'Dark');
    const brand = createVariable(doc, 'color/brand', coll, 'COLOR', { r: 0.05, g: 0.6, b: 1, a: 1 });
    setVariableValue(doc, brand, dark, { r: 0, g: 0.3, b: 0.6, a: 1 });
    const gap = createVariable(doc, 'space/gap', coll, 'FLOAT', 8);
    doc.set(gap, { codeSyntax: { WEB: 'var(--gap)', iOS: 'Spacing.gap', ANDROID: 'Spacing.gap' } });
    const button = doc.create('FRAME', page, {
      name: 'Button',
      layoutMode: 'HORIZONTAL',
      primaryAxisSizingMode: 'AUTO',
      counterAxisSizingMode: 'AUTO',
      primaryAxisAlignItems: 'CENTER',
      counterAxisAlignItems: 'CENTER',
      itemSpacing: 8,
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 8,
      paddingBottom: 8,
      width: 120,
      height: 40,
      cornerRadius: 8,
      fills: [{ type: 'SOLID', color: BLUE }],
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL' }],
      transform: [1, 0, 10, 0, 1, 20],
    });
    const label = doc.create('TEXT', button, {
      name: 'Label',
      characters: 'Купить',
      fontName: { family: 'Inter', style: 'Semi Bold' },
      fontSize: 16,
      lineHeight: { unit: 'PIXELS', value: 24 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
      width: 52,
      height: 24,
    });
    bindPaintVariable(doc, button, 'fills', 0, brand);
    bindVariable(doc, button, 'itemSpacing', gap);
    return { coll, light, dark, brand, gap, button, label };
  });
  return { doc, page, ...ids };
}

describe('Inspect', () => {
  it('model: sizes, auto layout, variables, modes', () => {
    const { doc, button, coll, dark } = setup();
    const s = inspectNode(doc, button);
    expect(s.sizing).toEqual({ width: 'HUG', height: 'HUG' });
    expect(s.layout).toMatchObject({ direction: 'row', justify: 'center', align: 'center' });
    expect(s.layout!.gap).toMatchObject({ value: 8, token: { name: 'space/gap', web: 'var(--gap)' } });
    expect(s.fills[0]).toMatchObject({ kind: 'solid', color: { token: { name: 'color/brand', web: 'var(--color-brand)', ios: 'colorBrand', resource: 'color_brand' } } });
    expect(styleTokens(s).map((t) => t.name).sort()).toEqual(['color/brand', 'space/gap']);
    // The same layer in dark mode, without editing the file.
    const d = inspectNode(doc, button, { modes: { [coll]: dark } });
    expect(formatColor((d.fills[0] as { color: { r: number; g: number; b: number; a: number } }).color)).toBe('#004D99');
    expect(formatColor({ r: 1, g: 0, b: 0, a: 0.5 }, 'rgb')).toBe('rgba(255, 0, 0, 0.5)');
    expect(formatColor({ r: 1, g: 0, b: 0, a: 1 }, 'hsl')).toBe('hsl(0, 100%, 50%)');
  });

  it('CSS: layer styling, variables, rem', () => {
    const { doc, button, label } = setup();
    const css = generateCode(doc, button, { language: 'css' });
    expect(css).toContain('display: flex;');
    expect(css).toContain('justify-content: center;');
    expect(css).toContain('gap: var(--gap);');
    expect(css).toContain('padding: 8px 16px;');
    expect(css).toContain('background: var(--color-brand);');
    expect(css).toContain('border-radius: 8px;');
    expect(css).toContain('box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.25);');
    expect(css).not.toContain('width:');
    const text = generateCode(doc, label, { language: 'css', unit: 'rem' });
    expect(text).toContain('font-family: "Inter";');
    expect(text).toContain('font-weight: 600;');
    expect(text).toContain('font-size: 1rem;');
    expect(text).toContain('line-height: 1.5rem;');
    expect(text).toContain('color: #FFFFFF;');
  });

  it('Tailwind, SwiftUI, UIKit, Compose, Android XML', () => {
    const { doc, button } = setup();
    const code = (language: CodeLanguage) => generateCode(doc, button, { language });
    const tw = code('tailwind');
    expect(tw).toContain('<div class="flex justify-center items-center gap-[var(--gap)] px-4 py-2 bg-[var(--color-brand)] rounded-lg shadow-[0_4px_8px_0_rgba(0,_0,_0,_0.25)] overflow-hidden">');
    expect(tw).toContain('<p class="font-[\'Inter\'] text-[16px] font-semibold leading-[24px] text-[#FFFFFF]">Купить</p>');
    const swift = code('swiftui');
    expect(swift).toContain('struct ButtonView: View');
    expect(swift).toContain('HStack(alignment: .center, spacing: Spacing.gap)');
    expect(swift).toContain('Text("Купить")');
    expect(swift).toContain('.font(.custom("Inter", size: 16).weight(.semibold))');
    expect(swift).toContain('.background(Color.colorBrand)');
    expect(swift).toContain('.clipShape(RoundedRectangle(cornerRadius: 8))');
    const ui = code('uikit');
    expect(ui).toContain('let button = UIStackView()');
    expect(ui).toContain('button.addArrangedSubview(label)');
    expect(ui).toContain('label.font = UIFont(name: "Inter-SemiBold", size: 16)');
    const kt = code('compose');
    expect(kt).toContain('Row(');
    expect(kt).toContain('horizontalArrangement = Arrangement.spacedBy(Spacing.gap, Alignment.CenterHorizontally)');
    expect(kt).toContain('.background(color = colorBrand, shape = RoundedCornerShape(8.dp))');
    expect(kt).toContain('fontWeight = FontWeight(600)');
    const xml = code('android-xml');
    expect(xml).toContain('<LinearLayout');
    expect(xml).toContain('android:orientation="horizontal"');
    expect(xml).toContain('android:gravity="center_horizontal|center_vertical"');
    expect(xml).toContain('android:text="Купить"');
    expect(xml).toContain('android:textSize="16sp"');
  });
});

describe('size in percent of the parent and unitless line height', () => {
  it('CSS — 50%, Tailwind — w-1/2, Compose — fillMaxWidth(0.5f), SwiftUI — containerRelativeFrame; line-height 150% → 1.5', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const row = doc.create('FRAME', page, { name: 'Row', layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED', width: 400, height: 100 });
    const side = doc.create('FRAME', row, { name: 'Side', width: 200, height: 100, widthPercent: 50 });
    const css = generateCode(doc, side, { language: 'css' });
    expect(css).toContain('width: 50%;');
    expect(generateCode(doc, side, { language: 'tailwind' })).toContain('w-1/2');
    expect(generateCode(doc, side, { language: 'compose' })).toContain('fillMaxWidth(0.5f)');
    expect(generateCode(doc, side, { language: 'swiftui' })).toContain('.containerRelativeFrame(.horizontal) { length, _ in length * 0.5 }');
    doc.set(side, { widthPercent: 37.5 });
    expect(generateCode(doc, side, { language: 'tailwind' })).toContain('w-[37.5%]');
    const text = doc.create('TEXT', row, { name: 'T', characters: 'Привет', fontSize: 16, lineHeight: { unit: 'PERCENT', value: 150 } });
    expect(generateCode(doc, text, { language: 'css' })).toContain('line-height: 1.5;');
  });
});
