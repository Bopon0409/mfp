import { describe, expect, it } from 'vitest';
import {
  Document,
  addCommentThread,
  alias,
  commentThreads,
  createCollection,
  createStyle,
  createVariable,
  instancesElsewhere,
  localStyles,
  threadPage,
  transferPage,
  variablesIn,
  localCollections,
  type Reaction,
  type PatternPaint,
} from '@mfp/core';

/** File: “Screens” (a button copy, an image, transitions, a comment) and “Components” (the main button). */
function source() {
  const doc = new Document({ clientId: 1 });
  const screens = doc.create('PAGE', doc.root, { name: 'Screens' });
  const comps = doc.create('PAGE', doc.root, { name: 'Components' });
  const ids = doc.transact(() => {
    const coll = createCollection(doc, 'Theme');
    const brand = createVariable(doc, 'Brand', coll, 'COLOR', { r: 0, g: 0, b: 1, a: 1 });
    const accent = createVariable(doc, 'Accent', coll, 'COLOR', alias(brand));
    createVariable(doc, 'Extra', coll, 'FLOAT', 1);
    const style = createStyle(doc, 'TEXT', 'Text/Regular', { fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14 });
    const fill = createStyle(doc, 'PAINT', 'Background', { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] });
    const master = doc.create('COMPONENT', comps, { name: 'Button', width: 100, height: 40, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 }, boundVariables: { color: alias(accent) } }] });
    const label = doc.create('TEXT', master, { characters: 'OK', textStyleId: style });
    const a = doc.create('FRAME', screens, { name: 'A', width: 300, height: 200, fillStyleId: fill });
    const b = doc.create('FRAME', screens, { name: 'B', width: 300, height: 200, transform: [1, 0, 400, 0, 1, 0] });
    const btn = doc.create('INSTANCE', a, { name: 'Button', componentId: master, width: 100, height: 40 });
    doc.create('TEXT', btn, { characters: 'OK', componentRef: label, textStyleId: style });
    const img = doc.create('RECTANGLE', a, { width: 10, height: 10, fills: [{ type: 'IMAGE', imageHash: 'abc123', scaleMode: 'FILL' }] });
    const reactions: Reaction[] = [
      { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: b, navigation: 'NAVIGATE', transition: null }] },
      { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: master, navigation: 'NAVIGATE', transition: null }] },
    ];
    doc.set(btn, { reactions });
    doc.set(screens, { flowStartingPoints: [{ nodeId: a, name: 'Start' }] });
    return { screens, comps, master, label, a, b, btn, img, brand, accent, style, fill };
  });
  addCommentThread(doc, ids.screens, [10, 10], ids.a, { author: 'Anya', text: 'A bigger button here' });
  return { doc, ...ids };
}

describe('moving a page to another file', () => {
  it.each([false, true])('transfers live or deleted motifs with nested dependencies and blob geometry (deleted=%s)', (deleted) => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const art = doc.create('PAGE', doc.root);
    const shape = doc.putBlob('M0 0L5 0L5 5L0 5Z');
    const leaf = doc.create('VECTOR', art, { width: 5, height: 5, vectorPaths: [{ windingRule: 'NONZERO', blob: shape, fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: 'vector-image' }] }] });
    const pattern = (id: string): PatternPaint => ({ type: 'PATTERN', sourceNodeId: id, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' });
    const motif = doc.create('FRAME', art, { width: 10, height: 10 });
    doc.create('RECTANGLE', motif, { fills: [pattern(leaf)] });
    doc.create('RECTANGLE', page, { fills: [pattern(motif)] });
    doc.create('TEXT', page, { textGlyphs: { runs: [{ fills: [pattern(motif)] }], glyphs: [[shape, 0, 0, 10, 0]] } });
    if (deleted) doc.delete(art);
    const target = new Document({ clientId: 2 });
    const before = target.snapshot();
    const report = target.transact(() => transferPage(doc, page, target, { sourceName: 'Motifs' }));
    const [rect, text] = target.children(report.page);
    const saved = (target.get(rect!, 'fills')![0] as PatternPaint).sourceNodeId;
    expect(target.type(saved)).toBe('FRAME');
    expect(target.get(target.parent(saved)!, 'patternArchive')).toBe(true);
    expect((target.get(text!, 'textGlyphs')!.runs[0]!.fills![0] as PatternPaint).sourceNodeId).toBe(saved);
    expect(target.get(saved, 'preservedPatternSource')).toBeUndefined();
    const nested = (target.get(target.children(saved)[0]!, 'fills')![0] as PatternPaint).sourceNodeId;
    expect(target.type(nested)).toBe('VECTOR');
    expect(target.blob(shape)).toBe(doc.blob(shape));
    expect(report.images).toContain('vector-image');
    const after = target.snapshot();
    target.undo(); expect(target.snapshot()).toEqual(before);
    target.redo(); expect(target.snapshot()).toEqual(after);
  });

  it('keeps motifs on the same page linked to their transferred copy, without extra hidden copies', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const src = doc.create('RECTANGLE', page);
    doc.create('RECTANGLE', page, { fills: [{ type: 'PATTERN', sourceNodeId: src, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' }] });
    const target = new Document({ clientId: 2 });
    const report = target.transact(() => transferPage(doc, page, target, { sourceName: 'Local' }));
    const [copy, user] = target.children(report.page);
    expect((target.get(user!, 'fills')![0] as PatternPaint).sourceNodeId).toBe(copy);
    expect(target.children(target.root).some((id) => target.get(id, 'patternArchive'))).toBe(false);
  });
  it('page, main components from other pages, styles, variables along the chain, images, comments', () => {
    const s = source();
    const target = new Document({ clientId: 2 });
    target.create('PAGE', target.root, { name: 'Home' });
    // The recipient already has a fill style with the same name — it is used.
    const ownFill = target.transact(() => createStyle(target, 'PAINT', 'Background', { fills: [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }] }));
    const r = target.transact(() => transferPage(s.doc, s.screens, target, { sourceName: 'Mockups' }));
    const pages = target.children(target.root).filter((p) => !target.get(p, 'internal'));
    expect(pages.map((p) => target.get(p, 'name'))).toEqual(['Home', 'Screens', 'Components — Mockups']);
    expect(r).toMatchObject({ components: 1, styles: 1, variables: 2, comments: 1 });
    expect([...r.images]).toEqual(['abc123']);
    // The button copy points to the copied main; the text to its label and style.
    const a = target.children(r.page)[0]!;
    expect(target.get(a, 'fillStyleId')).toBe(ownFill);
    const btn = target.children(a)[0]!;
    const master = target.get(btn, 'componentId')!;
    expect(target.get(master, 'name')).toBe('Button');
    expect(target.parent(master)).toBe(pages[2]);
    const text = target.children(btn)[0]!;
    expect(target.get(text, 'componentRef')).toBe(target.children(master)[0]);
    expect(localStyles(target, 'TEXT').map((x) => target.get(x, 'name'))).toEqual(['Text/Regular']);
    expect(target.get(text, 'textStyleId')).toBe(localStyles(target, 'TEXT')[0]);
    // Variables: “Accent” and what it references; “Extra” is not needed.
    const coll = localCollections(target)[0]!;
    const vars = Object.fromEntries(variablesIn(target, coll).map((v) => [target.get(v, 'name'), v]));
    expect(Object.keys(vars).sort()).toEqual(['Accent', 'Brand']);
    expect(Object.values(target.get(vars['Accent']!, 'valuesByMode')!)[0]).toEqual(alias(vars['Brand']!));
    expect(target.get(master, 'fills')![0]!.boundVariables?.color).toEqual(alias(vars['Accent']!));
    // A transition to “B” (same page) goes to the copy; to the main component too (it is copied).
    const reactions = target.get(btn, 'reactions')!;
    expect((reactions[0]!.actions[0] as { destinationId: string }).destinationId).toBe(target.children(r.page)[1]);
    expect(target.get(r.page, 'flowStartingPoints')).toEqual([{ nodeId: a, name: 'Start' }]);
    // The comment goes to the new page, the anchor is the copy of “A”.
    const threads = commentThreads(target);
    expect(threads.length).toBe(1);
    expect(threadPage(target, threads[0]!)).toBe(r.page);
  });

  it('navigation to other pages is removed; copies of main components on other pages block the move', () => {
    const s = source();
    const target = new Document({ clientId: 3 });
    const r = target.transact(() => transferPage(s.doc, s.comps, target, { sourceName: 'Mockups' }));
    expect(r.components).toBe(0);
    expect(instancesElsewhere(s.doc, s.comps)).toBe(1);
    expect(instancesElsewhere(s.doc, s.screens)).toBe(0);
    // Page “Screens” with a transition to the main component of another page — the transition goes to the main's copy.
    const t2 = new Document({ clientId: 4 });
    s.doc.transact(() => s.doc.set(s.btn, { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: s.comps, navigation: 'NAVIGATE', transition: null }] }] }));
    const r2 = t2.transact(() => transferPage(s.doc, s.screens, t2, { sourceName: 'Mockups' }));
    expect(r2.droppedLinks).toBe(1);
  });
});
