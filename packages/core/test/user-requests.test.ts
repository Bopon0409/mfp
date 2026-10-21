import { describe, expect, it } from 'vitest';
import { Document, applyStyle, bindVariable, createCollection, createStyle, createVariable, lintDesign, setVariableValue, styleValues, textLength, variableText } from '@mfp/core';

describe('text length limit (request “max and min character”)', () => {
  it('longer than the maximum and shorter than the minimum — “Text length” warnings; graphemes, no line breaks', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const long = doc.create('TEXT', page, { characters: 'Очень длинная кнопка', textMaxLength: 10 });
    const short = doc.create('TEXT', page, { characters: 'Ок', textMinLength: 3 });
    doc.create('TEXT', page, { characters: 'Норм', textMaxLength: 10, textMinLength: 2 });
    const issues = lintDesign(doc, page).filter((i) => i.kind === 'length');
    expect(issues.map((i) => i.id)).toEqual([long, short]);
    expect(issues[0]!.message).toContain('лишних 10');
    expect(textLength('👍🏽а\nб')).toBe(3);
  });
});

describe('color in a text style (request “include color in text styles”)', () => {
  it('a style with a color colors the text; without a color it leaves the text color alone', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const red = { type: 'SOLID' as const, color: { r: 1, g: 0, b: 0 } };
    const withColor = createStyle(doc, 'TEXT', 'Ошибка', { fontSize: 14, fills: [red] });
    const plain = createStyle(doc, 'TEXT', 'Тело', { fontSize: 16 });
    expect(styleValues(doc, withColor, 'textStyleId').fills).toEqual([red]);
    expect(styleValues(doc, plain, 'textStyleId').fills).toBeUndefined();
    const t = doc.create('TEXT', page, { characters: 'Текст', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] });
    doc.transact(() => applyStyle(doc, t, 'textStyleId', plain));
    expect(doc.props(t).fills).toEqual([{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }]);
    doc.transact(() => applyStyle(doc, t, 'textStyleId', withColor));
    const runs = doc.get(t, 'textRuns') ?? [];
    const fills = runs.length ? runs[0]!.style.fills : doc.get(t, 'fills');
    expect(fills).toEqual([red]);
  });
});

describe('variable value in text (request “output a color variable value”)', () => {
  it('color — HEX, number, string; changes along with the variable', () => {
    expect(variableText({ r: 1, g: 0.5, b: 0, a: 1 })).toBe('#FF8000');
    expect(variableText({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
    expect(variableText(12.345678)).toBe('12.3457');
    expect(variableText(true)).toBe('true');
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const col = createCollection(doc, 'Цвета');
    const v = createVariable(doc, 'brand', col, 'COLOR', { r: 0, g: 0.4, b: 1, a: 1 });
    const t = doc.create('TEXT', page, { characters: '' });
    bindVariable(doc, t, 'characters', v);
    expect(doc.get(t, 'characters')).toBe('#0066FF');
    setVariableValue(doc, v, doc.get(col, 'defaultModeId')!, { r: 1, g: 1, b: 1, a: 1 });
    bindVariable(doc, t, 'characters', v);
    expect(doc.get(t, 'characters')).toBe('#FFFFFF');
  });
});
