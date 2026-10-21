import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { importSketch, sketchPath, sketchPoint, sketchTransform } from '../src/sketch-import.ts';

const rect = (x: number, y: number, w: number, h: number) => ({ _class: 'rect', x, y, width: w, height: h });
const fill = (r: number, g: number, b: number, a = 1) => ({ _class: 'fill', isEnabled: true, fillType: 0, color: { _class: 'color', red: r, green: g, blue: b, alpha: a } });
const corner = (x: number, y: number, r = 0) => ({ _class: 'curvePoint', point: `{${x}, ${y}}`, curveFrom: `{${x}, ${y}}`, curveTo: `{${x}, ${y}}`, hasCurveFrom: false, hasCurveTo: false, curveMode: 1, cornerRadius: r });

/** A small Sketch file: a page with an artboard and a symbols page. */
function sample(): Uint8Array {
  const master = {
    _class: 'symbolMaster',
    do_objectID: 'M1',
    symbolID: 'SYM-1',
    name: 'Кнопка',
    frame: rect(0, 0, 120, 40),
    hasBackgroundColor: true,
    backgroundColor: { red: 0.05, green: 0.6, blue: 1, alpha: 1 },
    layers: [
      {
        _class: 'text',
        do_objectID: 'T-LABEL',
        name: 'Подпись',
        frame: rect(10, 10, 100, 20),
        textBehaviour: 0,
        attributedString: { string: 'Купить', attributes: [{ location: 0, length: 6, attributes: { MSAttributedStringFontAttribute: { attributes: { name: 'Helvetica-Bold', size: 14 } }, MSAttributedStringColorAttribute: { red: 1, green: 1, blue: 1, alpha: 1 }, paragraphStyle: { alignment: 2 } } }] },
      },
    ],
  };
  const page = {
    _class: 'page',
    name: 'Экраны',
    layers: [
      {
        _class: 'artboard',
        do_objectID: 'A1',
        name: 'Главная',
        frame: rect(0, 0, 375, 667),
        hasBackgroundColor: false,
        layers: [
          { _class: 'rectangle', do_objectID: 'R1', name: 'Карточка', frame: rect(20, 20, 200, 100), fixedRadius: 12, points: [corner(0, 0, 12), corner(1, 0, 12), corner(1, 1, 12), corner(0, 1, 12)], isClosed: true, style: { fills: [fill(1, 0.5, 0)], borders: [{ isEnabled: true, fillType: 0, color: { red: 0, green: 0, blue: 0, alpha: 1 }, position: 1, thickness: 2 }], shadows: [{ isEnabled: true, color: { red: 0, green: 0, blue: 0, alpha: 0.3 }, offsetX: 0, offsetY: 4, blurRadius: 8, spread: 0 }] } },
          { _class: 'oval', do_objectID: 'O1', name: 'Круг', frame: rect(240, 20, 80, 80), rotation: 0, points: [], style: { fills: [fill(0, 0.6, 0.3)] } },
          {
            _class: 'shapePath',
            do_objectID: 'P1',
            name: 'Капля',
            frame: rect(20, 150, 100, 100),
            rotation: 90,
            isClosed: true,
            points: [
              { _class: 'curvePoint', point: '{0.5, 0}', curveFrom: '{0.5, 0}', curveTo: '{0.5, 0}', hasCurveFrom: false, hasCurveTo: false, curveMode: 1 },
              { _class: 'curvePoint', point: '{1, 0.7}', curveFrom: '{0.8, 1}', curveTo: '{1, 0.4}', hasCurveFrom: true, hasCurveTo: true, curveMode: 2 },
              { _class: 'curvePoint', point: '{0, 0.7}', curveFrom: '{0, 0.4}', curveTo: '{0.2, 1}', hasCurveFrom: true, hasCurveTo: true, curveMode: 2 },
            ],
            style: { fills: [{ _class: 'fill', isEnabled: true, fillType: 1, gradient: { gradientType: 0, from: '{0.5, 0}', to: '{0.5, 1}', stops: [{ position: 0, color: { red: 1, green: 0, blue: 0, alpha: 1 } }, { position: 1, color: { red: 0, green: 0, blue: 1, alpha: 1 } }] } }], windingRule: 1 },
          },
          {
            _class: 'text',
            do_objectID: 'T1',
            name: 'Заголовок',
            frame: rect(20, 300, 300, 30),
            textBehaviour: 1,
            attributedString: {
              string: 'Привет, мир',
              attributes: [
                { location: 0, length: 7, attributes: { MSAttributedStringFontAttribute: { attributes: { name: 'Roboto-Regular', size: 24 } }, MSAttributedStringColorAttribute: { red: 0, green: 0, blue: 0, alpha: 1 } } },
                { location: 7, length: 4, attributes: { MSAttributedStringFontAttribute: { attributes: { name: 'Roboto-Bold', size: 24 } }, MSAttributedStringColorAttribute: { red: 1, green: 0, blue: 0, alpha: 1 } } },
              ],
            },
          },
          { _class: 'symbolInstance', do_objectID: 'I1', name: 'Кнопка покупки', symbolID: 'SYM-1', frame: rect(20, 400, 120, 40), overrideValues: [{ _class: 'overrideValue', overrideName: 'T-LABEL_stringValue', value: 'Заказать' }] },
          { _class: 'group', do_objectID: 'G1', name: 'Группа', frame: rect(200, 400, 100, 50), layers: [{ _class: 'bitmap', do_objectID: 'B1', name: 'Фото', frame: rect(0, 0, 100, 50), image: { _class: 'MSJSONFileReference', _ref_class: 'MSImageData', _ref: 'images/photo.png' } }] },
        ],
      },
    ],
  };
  const symbols = { _class: 'page', name: 'Symbols', layers: [master] };
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 154, 89, 192, 165, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  return zipSync({
    'document.json': strToU8(JSON.stringify({ _class: 'document', pages: [{ _class: 'MSJSONFileReference', _ref_class: 'MSImmutablePage', _ref: 'pages/P-1' }, { _class: 'MSJSONFileReference', _ref_class: 'MSImmutablePage', _ref: 'pages/P-2' }] })),
    'meta.json': strToU8(JSON.stringify({ version: 136, app: 'com.bohemiancoding.sketch3' })),
    'pages/P-1.json': strToU8(JSON.stringify(page)),
    'pages/P-2.json': strToU8(JSON.stringify(symbols)),
    'images/photo.png': png,
  });
}

describe('Sketch import', () => {
  it('points, path with handles, rotated frame', () => {
    expect(sketchPoint('{0.25, -1.5}')).toEqual([0.25, -1.5]);
    const d = sketchPath([corner(0, 0), { point: '{1, 1}', curveFrom: '{1, 1}', curveTo: '{1, 0.5}', hasCurveFrom: false, hasCurveTo: true }], false, 100, 50);
    expect(d).toBe('M 0 0 C 0 0 100 25 100 50');
    // 90° rotation around the center: the center stays in place.
    const m = sketchTransform({ frame: rect(10, 20, 100, 50), rotation: 90 });
    expect(m[0] * 50 + m[1] * 25 + m[2]).toBeCloseTo(60, 6);
    expect(m[3] * 50 + m[4] * 25 + m[5]).toBeCloseTo(45, 6);
  });

  it('pages, artboard, shapes, styled text, symbol and instance with an override, image', async () => {
    const r = await importSketch(sample(), 'Тест');
    const doc = r.doc;
    expect(r.pages).toBe(2);
    const [screens, symbols] = doc.children(doc.root);
    expect(doc.get(screens!, 'name')).toBe('Экраны');
    const board = doc.children(screens!)[0]!;
    expect(doc.type(board)).toBe('FRAME');
    expect([doc.get(board, 'width'), doc.get(board, 'height')]).toEqual([375, 667]);
    const kids = doc.children(board);
    const byName = (n: string) => kids.find((k) => doc.get(k, 'name') === n)!;
    const card = byName('Карточка');
    expect(doc.type(card)).toBe('RECTANGLE');
    expect(doc.get(card, 'cornerRadius')).toBe(12);
    expect(doc.get(card, 'strokeAlign')).toBe('INSIDE');
    expect(doc.get(card, 'effects')?.[0]?.type).toBe('DROP_SHADOW');
    expect(doc.type(byName('Круг'))).toBe('ELLIPSE');
    const drop = byName('Капля');
    expect(doc.type(drop)).toBe('VECTOR');
    expect(doc.get(drop, 'vectorPaths')?.[0]?.windingRule).toBe('EVENODD');
    expect(doc.get(drop, 'fills')?.[0]?.type).toBe('GRADIENT_LINEAR');
    const title = byName('Заголовок');
    expect(doc.get(title, 'characters')).toBe('Привет, мир');
    expect(doc.get(title, 'fontName')).toEqual({ family: 'Roboto', style: 'Regular' });
    expect(JSON.stringify(doc.get(title, 'textRuns') ?? doc.get(title, 'characterStyleOverrides') ?? null)).toContain('Bold');
    // A symbol instance is a component instance with its own text.
    const inst = byName('Кнопка покупки');
    expect(doc.type(inst)).toBe('INSTANCE');
    const master = doc.children(symbols!)[0]!;
    expect(doc.type(master)).toBe('COMPONENT');
    expect(doc.get(inst, 'componentId')).toBe(master);
    expect(doc.get(doc.children(inst)[0]!, 'characters')).toBe('Заказать');
    expect(doc.get(doc.children(master)[0]!, 'characters')).toBe('Купить');
    // An image in a group.
    const group = byName('Группа');
    expect(doc.type(group)).toBe('GROUP');
    const photo = doc.children(group)[0]!;
    const hash = (doc.get(photo, 'fills')?.[0] as { imageHash?: string })?.imageHash;
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect((await r.images.readImage(hash!))?.length).toBeGreaterThan(50);
  });
});
