import { expect, it } from 'vitest';
import { Document, collectClipboardPatterns, insertClipboardPatterns, remapPatternPaints, type NodeRecord, type PatternPaint } from '../src/index.ts';

const paint = (sourceNodeId: string): PatternPaint => ({ type: 'PATTERN', sourceNodeId, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' });
const tree = (d: Document, id: string): NodeRecord[] => [id, ...d.descendants(id)].map((k) => structuredClone(d.node(k)!));
function setup() {
  const doc = new Document({clientId:1});
  const page = doc.create('PAGE',doc.root);
  const inner=doc.create('ELLIPSE',page,{width:10,height:10});
  const motif=doc.create('FRAME',page,{width:20,height:20,fills:[paint(inner)]});
  const child=doc.create('RECTANGLE',motif,{width:5,height:5});
  const user=doc.create('RECTANGLE',page,{fills:[paint(motif)]});
  return {doc,page,inner,motif,child,user};
}

it('copies nested motifs into a foreign file despite colliding IDs, with one Undo', () => {
  const {doc,page,motif,inner,user}=setup();
  const bundle=collectClipboardPatterns(doc,[tree(doc,user)]);
  const target=new Document({clientId:1}); const tp=target.create('PAGE',target.root);
  target.create('RECTANGLE',tp,{name:'Unrelated collision'});
  const before=target.snapshot();
  let id='';
  target.transact(()=>{
    id=target.create('RECTANGLE',tp,doc.props(user));
    const map=new Map([[user,id]]);
    insertClipboardPatterns(target,bundle,map,false);
    target.set(id,remapPatternPaints(target.props(id),map));
  });
  const source=(target.get(id,'fills')![0] as PatternPaint).sourceNodeId;
  expect(source).not.toBe(motif);
  expect(target.type(source)).toBe('FRAME');
  expect(target.get(target.parent(source)!,'patternArchive')).toBe(true);
  const nested=(target.get(source,'fills')![0] as PatternPaint).sourceNodeId;
  expect(nested).not.toBe(inner); expect(target.type(nested)).toBe('ELLIPSE');
  expect(target.children(source)).toHaveLength(1);
  target.undo(); expect(target.snapshot()).toEqual(before);
  target.redo(); expect(target.type(source)).toBe('FRAME');
  expect(doc.children(page)).toHaveLength(3);
});

it('snapshots deleted sources and preserves original references when pasting in the same file', () => {
  const {doc,page,motif,user}=setup(); doc.delete(motif);
  const trees=[tree(doc,user)]; const bundle=collectClipboardPatterns(doc,trees);
  expect(bundle.aliases[motif]).toBe(doc.patternSourceNode(motif));
  const size=doc.size;
  const map=new Map<string,string>(); insertClipboardPatterns(doc,bundle,map,true);
  expect(doc.size).toBe(size);
  expect((remapPatternPaints(doc.props(user),map).fills![0] as PatternPaint).sourceNodeId).toBe(motif);
  const target=new Document({clientId:2}); const tp=target.create('PAGE',target.root);
  const id=target.create('RECTANGLE',tp,doc.props(user)); const foreign=new Map([[user,id]]);
  insertClipboardPatterns(target,bundle,foreign,false);
  target.set(id,remapPatternPaints(target.props(id),foreign));
  const source=(target.get(id,'fills')![0] as PatternPaint).sourceNodeId;
  expect(target.type(source)).toBe('FRAME');
  expect(target.get(source,'preservedPatternSource')).toBeUndefined();
});

it('uses copied motifs shared across selected roots and leaves unrelated text intact', () => {
  const {doc,motif,user}=setup();
  const bundle=collectClipboardPatterns(doc,[tree(doc,motif),tree(doc,user)]);
  expect(bundle.nodes.some(n=>n.id===motif)).toBe(false);
  const map=new Map([[motif,'new-motif']]);
  const p=remapPatternPaints({characters:motif,fills:[paint(motif)],textRuns:[{length:1,style:{fills:[paint(motif)]}}]},map);
  expect(p.characters).toBe(motif);
  expect((p.fills![0] as PatternPaint).sourceNodeId).toBe('new-motif');
  expect((p.textRuns![0]!.style.fills![0] as PatternPaint).sourceNodeId).toBe('new-motif');
});

it('freezes external sources at copy time and terminates cyclic pattern references', () => {
  const {doc,motif,inner,user}=setup();
  doc.set(inner,{fills:[paint(motif)]});
  const bundle=collectClipboardPatterns(doc,[tree(doc,user)]);
  expect(bundle.nodes).toHaveLength(3);
  doc.set(motif,{width:999});
  expect(bundle.nodes.find(n=>n.id===motif)!.props.width).toBe(20);
});
