import { describe, expect, it } from 'vitest';
import { Document, addMeasurement, annotationCategories, devStatusNodes, diffSubtree, htmlToMarkdown, measurementGeometry, pageBounds } from '@mfp/core';

function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Страница' });
  const section = doc.create('SECTION', page, { name: 'Секция', width: 2000, height: 1000 });
  const a = doc.create('FRAME', section, { name: 'A', width: 100, height: 50, transform: [1, 0, 10, 0, 1, 20] });
  const b = doc.create('FRAME', page, { name: 'B', width: 100, height: 50, transform: [1, 0, 300, 0, 1, 20] });
  const t = doc.create('TEXT', a, { name: 'T', characters: 'Привет', width: 40, height: 16 });
  return { doc, page, section, a, b, t };
}

describe('developer mode in the document', () => {
  it('annotation label from .fig: HTML → Markdown', () => {
    expect(htmlToMarkdown('<p>Пример: <a href="https://x.dev/a" target="_blank">https://x.dev/a</a></p><p><br></p><p><strong>Важно</strong> &amp; <em>тихо</em></p>')).toBe('Пример: https://x.dev/a\n\n**Важно** & _тихо_');
    expect(htmlToMarkdown('<ul><li>раз</li><li>два <a href="https://y">ссылка</a></li></ul>')).toBe('- раз\n- два [ссылка](https://y)');
  });

  it('default categories, statuses on the page and in sections', () => {
    const { doc, page, a, b } = setup();
    expect(annotationCategories(doc).map((c) => c.id)).toContain('development');
    doc.set(b, { devStatus: { type: 'READY_FOR_DEV' } });
    doc.set(a, { devStatus: { type: 'COMPLETED' } });
    expect(devStatusNodes(doc, page)).toEqual([a, b]);
  });

  it('measuring between layer edges', () => {
    const { doc, page, a, b } = setup();
    expect(pageBounds(doc, a)).toEqual([10, 20, 110, 70]);
    const m = addMeasurement(doc, page, { node: a, side: 'RIGHT' }, { node: b, side: 'LEFT' });
    expect(measurementGeometry(doc, m)).toEqual({ value: 190, a: [110, 45], b: [300, 45] });
    const vertical = addMeasurement(doc, page, { node: a, side: 'TOP' }, { node: b, side: 'BOTTOM' }, { offset: { type: 'OUTER', fixed: 8 } });
    expect(measurementGeometry(doc, vertical)).toEqual({ value: 50, a: [2, 20], b: [2, 70] });
    // Sides on different axes are not a measurement.
    expect(measurementGeometry(doc, { ...m, end: { node: b, side: 'TOP' } })).toBeNull();
  });

  it('comparing a subtree between versions', () => {
    const { doc, a, t } = setup();
    const before = Document.fromSnapshot(doc.snapshot());
    doc.set(t, { characters: 'Пока' });
    doc.set(a, { devStatus: { type: 'READY_FOR_DEV' } });
    const added = doc.create('RECTANGLE', a, { name: 'R' });
    const diff = diffSubtree(before, doc, a);
    expect(diff.added).toEqual([added]);
    expect(diff.removed).toEqual([]);
    // Status is an internal mark, not counted as a change.
    expect(diff.changed).toEqual([{ id: t, keys: ['characters'] }]);
  });
});
