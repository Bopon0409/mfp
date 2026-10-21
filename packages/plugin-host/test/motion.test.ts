// Plugin Motion API: keyframes (manualKeyframeTracks, applyManualKeyframeTrack), motion styles,
// timeline and figma.motion, using examples from the API documentation.

import { describe, expect, it } from 'vitest';
import { Document, animatedProps, animatedValue, physicalSpringToNormalized } from '@mfp/core';
import { parseManifest, PluginRuntime, type PluginEnvironment } from '../src/index.ts';

function env(extra: Partial<PluginEnvironment> = {}) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Page 1' });
  const frame = doc.create('FRAME', page, { name: 'Screen', width: 400, height: 300 });
  const box = doc.create('RECTANGLE', frame, {
    name: 'Box',
    width: 100,
    height: 50,
    transform: [1, 0, 20, 0, 1, 30],
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
    effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, visible: true, blendMode: 'NORMAL' }],
  });
  const e: PluginEnvironment = {
    doc,
    getCurrentPage: () => page,
    setCurrentPage: () => {},
    getSelection: () => [box],
    setSelection: () => {},
    notify: () => {},
    showUI: () => {},
    postToUI: () => {},
    setUIVisible: () => {},
    resizeUI: () => {},
    closeUI: () => {},
    viewport: { center: () => ({ x: 0, y: 0 }), zoom: () => 1, bounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), setCenter: () => {}, setZoom: () => {}, scrollAndZoomIntoView: () => {} },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: () => {},
    ...extra,
  };
  return { doc, page, frame, box, env: e };
}

/** Run plugin code; return what it put into the document's pluginData “out”, parsed as JSON. */
async function run(code: string, e: PluginEnvironment): Promise<Record<string, unknown>> {
  const { manifest } = parseManifest({ name: 'T', id: 't', api: '1.0.0', main: 'code.js' });
  const rt = await PluginRuntime.start({ manifest, code: `(async () => { try { ${code} } catch (err) { figma.root.setPluginData('err', String(err && err.message || err)); } figma.closePlugin(); })();` }, e);
  const start = Date.now();
  while (rt.state === 'running' && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 5));
  expect(rt.error).toBeNull();
  const err = e.doc.get(e.doc.root, 'pluginData')?.['t']?.err;
  if (err) throw new Error(err);
  const out = e.doc.get(e.doc.root, 'pluginData')?.['t']?.out;
  return out ? JSON.parse(out) : {};
}

describe('plugin Motion API', () => {
  it('TRANSLATION_X is added to the original X; a key\'s curve is the transition into it; the timeline is extended', async () => {
    const { doc, frame, box, env: e } = env();
    const out = await run(
      `const node = figma.currentPage.selection[0];
       node.applyManualKeyframeTrack({ type: 'PROPERTY', name: 'TRANSLATION_X' }, { keyframes: [
         { timelinePosition: 0, value: { type: 'FLOAT', value: 0 } },
         { timelinePosition: 1, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 120 } },
       ] });
       const [tl] = node.timelines;
       if (tl.duration < 2) node.setTimelineDuration(tl.id, 2);
       figma.root.setPluginData('out', JSON.stringify({ tracks: node.manualKeyframeTracks, timelines: node.timelines }));`,
      e,
    );
    // Document: x = 20 + offset; the LINEAR curve is on the first key (the transition from it).
    const tr = doc.get(box, 'animation')!.find((t) => t.property === 'x')!;
    expect(tr.keys.map((k) => k.value)).toEqual([20, 140]);
    expect(tr.keys[0]!.easing).toEqual({ type: 'LINEAR' });
    expect(animatedValue(doc, box, 'x', 0.5)).toBeCloseTo(80);
    // Reading returns what was written: the delta, the curve on the second key, the base value.
    const t = (out.tracks as Record<string, { keyframeOperation: string; baseValue: unknown; keyframes: { timelinePosition: number; value: unknown; easing?: unknown }[] }>).TRANSLATION_X!;
    expect(t.keyframeOperation).toBe('OFFSET');
    expect(t.baseValue).toEqual({ type: 'FLOAT', value: 20 });
    expect(t.keyframes.map((k) => (k.value as { value: number }).value)).toEqual([0, 120]);
    expect(t.keyframes[0]!.easing).toBeUndefined();
    expect(t.keyframes[1]!.easing).toEqual({ type: 'LINEAR' });
    expect(out.timelines).toEqual([{ id: frame, duration: 2 }]);
    expect(doc.get(frame, 'timeline')?.duration).toBe(2);
  });

  it('XY vector, fill color by index, effect field, HOLD and bounce spring', async () => {
    const { doc, box, env: e } = env();
    const out = await run(
      `const node = figma.currentPage.selection[0];
       node.manualKeyframeTracks = {
         TRANSLATION_XY: { keyframes: [
           { timelinePosition: 0, value: { type: 'VECTOR', value: { x: 0, y: 0 } } },
           { timelinePosition: 1, value: { type: 'VECTOR', value: { x: 10, y: -5 } }, easing: { type: 'HOLD' } },
         ] },
         SCALE_X: { keyframes: [
           { timelinePosition: 0, value: { type: 'FLOAT', value: 1 } },
           { timelinePosition: 0.5, value: { type: 'FLOAT', value: 2 }, easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.3 } } },
         ] },
         fills: { 0: { keyframes: [
           { timelinePosition: 0, value: { type: 'COLOR', value: { r: 1, g: 0, b: 0, a: 1 } } },
           { timelinePosition: 1, value: { type: 'COLOR', value: { r: 0, g: 0, b: 1, a: 1 } }, easing: { type: 'LINEAR' } },
         ] } },
         effects: { 0: { RADIUS: { keyframes: [
           { timelinePosition: 0, value: { type: 'FLOAT', value: 0 } },
           { timelinePosition: 0.4, value: { type: 'FLOAT', value: 24 }, easing: { type: 'EASE_OUT' } },
         ] } } },
       };
       figma.root.setPluginData('out', JSON.stringify(node.manualKeyframeTracks));`,
      e,
    );
    // HOLD: the previous value until the end of the segment, the new one at the end.
    expect(animatedValue(doc, box, 'x', 0.99)).toBe(20);
    expect(animatedValue(doc, box, 'x', 1)).toBe(30);
    expect(animatedValue(doc, box, 'y', 1)).toBe(25);
    // Color at the midpoint, shadow radius at the end.
    const mid = animatedProps(doc, box, 0.5)!;
    expect((mid.fills![0] as { color: { r: number; b: number } }).color.r).toBeCloseTo(0.5);
    expect((animatedProps(doc, box, 0.4)!.effects![0] as { radius: number }).radius).toBeCloseTo(24);
    // X scale: the transform is stretched along the X axis around the center.
    const scaled = animatedProps(doc, box, 0.5)!.transform!;
    expect(scaled[0]).toBeCloseTo(2);
    expect(scaled[4]).toBeCloseTo(1);
    // Reading: the same shape (a vector as one track, a spring as bounce, paint and effect indices).
    const xy = out.TRANSLATION_XY as { keyframes: { value: { value: { x: number; y: number } }; easing?: { type: string } }[] };
    expect(xy.keyframes[1]!.value.value).toEqual({ x: 10, y: -5 });
    expect(xy.keyframes[1]!.easing).toEqual({ type: 'HOLD' });
    expect((out.SCALE_X as { keyframes: { easing?: unknown }[] }).keyframes[1]!.easing).toEqual({ type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.3 } });
    expect(Object.keys(out.fills as object)).toEqual(['0']);
    expect(Object.keys((out.effects as Record<string, object>)['0']!)).toEqual(['RADIUS']);
  });

  it('errors: unknown field, EASE_IN_OUT, group width, non-solid paint', async () => {
    for (const [code, msg] of [
      [`node.applyManualKeyframeTrack({ type: 'PROPERTY', name: 'SHEAR' }, { keyframes: [] })`, /SHEAR/],
      [`node.applyManualKeyframeTrack({ type: 'PROPERTY', name: 'OPACITY' }, { keyframes: [{ timelinePosition: 0, value: { type: 'FLOAT', value: 1 }, easing: { type: 'EASE_IN_OUT' } }] })`, /EASE_IN_OUT/],
      [`node.applyManualKeyframeTrack({ type: 'INDEXED_ITEM', collection: 'fills', index: 3 }, { keyframes: [] })`, /fills\[3\]/],
    ] as const) {
      const { env: e } = env();
      await expect(run(`const node = figma.currentPage.selection[0]; ${code};`, e)).rejects.toThrow(msg);
    }
  });

  it('Fade style: opacity keys within the style\'s interval; removing it removes them', async () => {
    const { doc, box, env: e } = env();
    const out = await run(
      `const node = figma.currentPage.selection[0];
       const fade = figma.motion.figmaAnimationStyles().find((s) => s.styleId === 'Opacity');
       const id = node.applyAnimationStyle(fade.styleId, { duration: 0.5, timelineOffset: 0.25, props: { timing: 'in', easing: { type: 'EASE_OUT' } } });
       const styles = node.animationStyles;
       const keysAfterApply = node.manualKeyframeTracks.OPACITY.keyframes.length;
       node.removeAnimationStyle(id);
       figma.root.setPluginData('out', JSON.stringify({ name: fade.name, styles, keysAfterApply, after: node.animationStyles, tracks: node.manualKeyframeTracks,
         bounce: figma.motion.physicalSpringToNormalized({ mass: 1, stiffness: 100, damping: 10 }), playhead: figma.motion.playheadPosition === undefined }));`,
      e,
    );
    expect(out.name).toBe('Fade');
    expect(out.styles).toMatchObject([{ type: 'FIGMA', styleId: 'Opacity', duration: 0.5, timelineOffset: 0.25 }]);
    expect(out.keysAfterApply).toBe(2);
    expect(out.after).toEqual([]);
    expect(out.tracks).toEqual({});
    expect(doc.get(box, 'animation')).toBeUndefined();
    expect(out.bounce).toBeCloseTo(physicalSpringToNormalized({ mass: 1, stiffness: 100, damping: 10 }));
    expect(out.playhead).toBe(true);
  });

  it('custom animation styles — “not supported”', async () => {
    const { env: e } = env();
    await expect(run(`figma.createCustomAnimationStyle();`, e)).rejects.toThrow(/not a supported API/);
  });
});
