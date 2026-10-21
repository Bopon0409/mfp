import { describe, expect, it } from 'vitest';
import { Document, addComponentProperty, codeConnectPlaceholders, combineAsVariants, instancePropertyValues, instantiate, playgroundDoc, renderCodeConnect, setInstanceProperties, setPropertyReference } from '@mfp/core';

/** Button: variants Size=S/L, properties “Label” (text) and “Disabled” (boolean), an instance. */
function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const ids = doc.transact(() => {
    const comps = ['Size=S', 'Size=L'].map((name, i) => {
      const c = doc.create('COMPONENT', page, { name, width: i ? 200 : 100, height: 40, transform: [1, 0, i * 220, 0, 1, 0] });
      doc.create('TEXT', c, { name: 'Label', characters: 'Кнопка' });
      return c;
    });
    const set = combineAsVariants(doc, comps, page);
    doc.set(set, { name: 'Button' });
    const label = addComponentProperty(doc, set, 'Label', 'TEXT', 'Кнопка');
    addComponentProperty(doc, set, 'Disabled', 'BOOLEAN', false);
    for (const c of comps) setPropertyReference(doc, doc.children(c)[0]!, 'characters', label);
    const inst = instantiate(doc, comps[0]!, page, [1, 0, 0, 0, 1, 300]);
    return { set, s: comps[0]!, l: comps[1]!, inst, label };
  });
  return { doc, page, ...ids };
}

describe('code connection and playground', () => {
  it('instance code from a template: variants, text, booleans, name', () => {
    const { doc, set, inst, label } = setup();
    doc.set(set, { codeConnect: [{ language: 'react', template: '<Button size="{{size}}" disabled={{{Disabled}}}>{{Label}}</Button> // {{name}} {{Нет}}', source: 'src/ui/Button.tsx' }] });
    doc.transact(() => setInstanceProperties(doc, inst, { Size: 'L', [label]: 'Купить', Disabled: true }));
    const cc = doc.get(set, 'codeConnect')![0]!;
    expect(renderCodeConnect(doc, inst, cc)).toBe('<Button size="L" disabled={true}>Купить</Button> // Button {{Нет}}');
    // The component has the default values.
    expect(renderCodeConnect(doc, set, cc)).toBe('<Button size="S" disabled={false}>Кнопка</Button> // Button {{Нет}}');
    expect(codeConnectPlaceholders(doc, inst)).toEqual(['name', 'Size', 'Label', 'Disabled']);
  });

  it('playground: properties change in a copy, the file does not', () => {
    const { doc, s, l, inst } = setup();
    const before = JSON.stringify(doc.snapshot());
    const pg = playgroundDoc(doc, s)!;
    expect(pg.doc.get(pg.instance, 'componentId')).toBe(s);
    pg.doc.transact(() => setInstanceProperties(pg.doc, pg.instance, { Size: 'L', Disabled: true }));
    expect(pg.doc.get(pg.instance, 'componentId')).toBe(l);
    expect(pg.doc.get(pg.instance, 'width')).toBe(200);
    const values = instancePropertyValues(pg.doc, pg.instance);
    expect(values.Size).toBe('L');
    expect(Object.entries(values).find(([k]) => k.startsWith('Disabled#'))?.[1]).toBe(true);
    expect(JSON.stringify(doc.snapshot())).toBe(before);
    expect(doc.get(inst, 'componentId')).toBe(s);
  });
});
