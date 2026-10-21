import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { ComponentSync, detachInstance, instantiate, resetOverrides } from '../src/components.ts';

/** Document with a “button” component (icon + label) and connections, as in the editor. */
function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const comp = doc.create('COMPONENT', page, { name: 'Кнопка', width: 160, height: 48 });
  const icon = doc.create('RECTANGLE', comp, { name: 'Иконка', width: 24, height: 24 });
  const label = doc.create('TEXT', comp, { name: 'Подпись', characters: 'Купить' });
  const sync = new ComponentSync(doc);
  // As in Editor.handleOps: own edits become overrides, main component edits go into the copy.
  doc.onChange((ops, origin) => {
    sync.observe(ops);
    if (origin === 'local') doc.amend(() => sync.trackOverrides(ops));
    if (origin === 'local' || origin === 'layout') doc.amend(() => sync.propagate(ops));
  });
  const inst = doc.transact(() => instantiate(doc, comp, page, [1, 0, 200, 0, 1, 0]));
  return { doc, page, comp, icon, label, inst, sync };
}

describe('components and instances', () => {
  it('an instance is a copy of the subtree with links to the main component', () => {
    const { doc, inst, icon, label } = setup();
    expect(doc.type(inst)).toBe('INSTANCE');
    expect(doc.children(inst).map((k) => doc.get(k, 'componentRef'))).toEqual([icon, label]);
  });

  it('main component edits propagate to copies, the instance\'s own edits do not', () => {
    const { doc, inst, icon, label } = setup();
    const [iIcon, iLabel] = doc.children(inst);
    doc.set(icon, { cornerRadius: 6 });
    expect(doc.get(iIcon!, 'cornerRadius')).toBe(6);
    doc.set(iLabel!, { characters: 'В корзину' });
    expect(doc.get(iLabel!, 'overrides')).toEqual(['characters']);
    doc.set(label, { characters: 'Заказать', fontSize: 20 });
    expect(doc.get(iLabel!, 'characters')).toBe('В корзину');
    expect(doc.get(iLabel!, 'fontSize')).toBe(20);
  });

  it('new and deleted main component nodes appear in copies; undo goes together with the main component', () => {
    const { doc, comp, inst, icon } = setup();
    const badge = doc.create('ELLIPSE', comp, { name: 'Бейдж' });
    expect(doc.children(inst).map((k) => doc.get(k, 'name'))).toEqual(['Иконка', 'Подпись', 'Бейдж']);
    doc.undo();
    expect(doc.has(badge)).toBe(false);
    expect(doc.children(inst)).toHaveLength(2);
    doc.delete(icon);
    expect(doc.children(inst).map((k) => doc.get(k, 'name'))).toEqual(['Подпись']);
  });

  it('instance position and name are its own; size comes from the main component', () => {
    const { doc, comp, inst } = setup();
    doc.set(comp, { width: 200, name: 'Кнопка большая', transform: [1, 0, 5, 0, 1, 5] });
    expect(doc.get(inst, 'width')).toBe(200);
    expect(doc.get(inst, 'name')).toBe('Кнопка');
    expect(doc.get(inst, 'transform')![2]).toBe(200);
  });

  it('resetting overrides and detaching', () => {
    const { doc, inst } = setup();
    const iLabel = doc.children(inst)[1]!;
    doc.set(iLabel, { characters: 'Своё' });
    doc.transact(() => resetOverrides(doc, inst));
    expect(doc.get(iLabel, 'characters')).toBe('Купить');
    const frame = doc.transact(() => detachInstance(doc, inst));
    expect(doc.type(frame)).toBe('FRAME');
    expect(doc.children(frame).every((k) => !doc.get(k, 'componentRef'))).toBe(true);
  });
});
