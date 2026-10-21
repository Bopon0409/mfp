import { expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { CoreScene } from '@mfp/renderer';
import { buildScene, sceneToCore, writeMfp, readMfp, MemorySource, type FigMessage } from '../src/index.ts';

const g = (localID: number) => ({ sessionID: 17, localID });
const raw = { type: 'CUSTOM_EFFECT', visible: false, customEffectId: { assetRef: { key: 'fx', version: 'v2' } }, componentPropAssignments: [{ defID: g(50), varValue: { value: { floatValue: 42 } } }], futureField: { nested: [1, 'keep', { opaque: true }] } };
function fixture() {
  return { nodeChanges: [
    { guid: g(0), type: 'DOCUMENT' },
    { guid: g(1), type: 'CANVAS', parentIndex: { guid: g(0), position: 'a' } },
    { guid: g(2), type: 'CODE_COMPONENT', key: 'fx', version: 'v1', codeObjectType: 'CUSTOM_EFFECT', parentIndex: { guid: g(1), position: 'a' } },
    { guid: g(3), type: 'CODE_COMPONENT', key: 'fx', version: 'v2', codeObjectType: 'CUSTOM_EFFECT', customToolArtifactRef: { customToolId: 'actual-resource', customToolVersion: 'exact-version' }, parentIndex: { guid: g(1), position: 'b' } },
    { guid: g(4), type: 'RECTANGLE', name: 'Mixed effects', parentIndex: { guid: g(1), position: 'c' }, size: { x: 120, y: 80 }, effects: [
      { type: 'FOREGROUND_BLUR', radius: 3 }, raw,
      { type: 'DROP_SHADOW', radius: 8, offset: { x: 2, y: 4 }, radiusVar: { dataType: 'ALIAS', value: { alias: { guid: g(6) } } } },
      { ...raw, visible: true },
    ] },
    { guid: g(5), type: 'VARIABLE_SET', name: 'Sizes', variableSetModes: [{ id: g(9), name: 'Default', sortPosition: 'a' }], parentIndex: { guid: g(1), position: 'd' } },
    { guid: g(6), type: 'VARIABLE', name: 'Shadow radius', variableResolvedType: 'FLOAT', variableSetID: { guid: g(5) }, variableDataValues: { entries: [{ modeID: g(9), variableData: { dataType: 'FLOAT', value: { floatValue: 8 } } }] }, parentIndex: { guid: g(1), position: 'e' } },
  ] } as unknown as FigMessage;
}

it('preserves unknown effects in order, exact resource version and following variable bindings', () => {
  const { doc, report } = sceneToCore(buildScene(fixture()));
  const node = doc.snapshot().nodes.find(n => n.props.name === 'Mixed effects')!;
  const variable = doc.snapshot().nodes.find(n => n.props.name === 'Shadow radius')!;
  expect(node.props.effects?.map(e => e.type)).toEqual(['LAYER_BLUR', 'UNSUPPORTED_FIGMA', 'DROP_SHADOW', 'UNSUPPORTED_FIGMA']);
  expect(node.props.effects?.[1]).toMatchObject({ raw, visible: false, definition: { version: 'v2', customToolArtifactRef: { customToolId: 'actual-resource' } } });
  expect(node.props.effects?.[2]?.boundVariables).toEqual({ radius: { type: 'VARIABLE_ALIAS', id: variable.id } });
  expect(report.warnings.filter(w => w.includes('CUSTOM_EFFECT'))).toHaveLength(1);
  const scene = new CoreScene(doc, node.parent!);
  expect(scene.node(node.id)?.effects.map(e => [e.type, e.visible])).toEqual([
    ['FOREGROUND_BLUR', true], ['UNSUPPORTED_FIGMA', false], ['DROP_SHADOW', true], ['UNSUPPORTED_FIGMA', false],
  ]);
});

it('keeps opaque metadata through edit, undo and two mfp round trips', async () => {
  let { doc } = sceneToCore(buildScene(fixture()));
  const id = doc.snapshot().nodes.find(n => n.props.name === 'Mixed effects')!.id;
  const initial = structuredClone(doc.get(id, 'effects'));
  doc.set(id, { effects: doc.get(id, 'effects')!.map((e, i) => i === 1 ? { ...e, visible: true } : e) });
  doc.undo();
  expect(doc.get(id, 'effects')).toEqual(initial);
  for (let i = 0; i < 2; i++) {
    const { blob } = await writeMfp(doc, null);
    doc = (await readMfp(new MemorySource(new Uint8Array(await blob.arrayBuffer())))).doc;
    expect(doc.get(id, 'effects')).toEqual(initial);
  }
});

it('does not fabricate a definition when only a different resource version exists', () => {
  const message = fixture();
  message.nodeChanges = message.nodeChanges!.filter(n => n.version !== 'v2');
  const { doc } = sceneToCore(buildScene(message), new Document({ clientId: 3 }));
  const e = doc.snapshot().nodes.find(n => n.props.name === 'Mixed effects')!.props.effects![1];
  expect(e).toMatchObject({ type: 'UNSUPPORTED_FIGMA', raw });
  expect(e).not.toHaveProperty('definition');
});
