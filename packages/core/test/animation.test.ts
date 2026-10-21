import { describe, expect, it } from 'vitest';
import { Document, MOTION_PRESETS, animatedProps, applyMotion, motionFromTracks, textAnimationEnd, textAnimationUnits, textUnitProgress, animationRoot, baseValue, framePose, timelineDuration, valueAt, withKey, withoutKey, type AnimTrack } from '@mfp/core';

const linear = { type: 'LINEAR' as const };

function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { width: 400, height: 300 });
  const box = doc.create('RECTANGLE', frame, { width: 100, height: 50, transform: [1, 0, 20, 0, 1, 40] });
  return { doc, page, frame, box };
}

describe('animation: values over time', () => {
  it('between keys — along the left key\'s curve; before the first and after the last — as at them', () => {
    const tr: AnimTrack = { property: 'x', keys: [{ t: 1, value: 0, easing: linear }, { t: 3, value: 100 }] };
    expect(valueAt(tr, 0)).toBe(0);
    expect(valueAt(tr, 2)).toBeCloseTo(50, 6);
    expect(valueAt(tr, 5)).toBe(100);
    // Default smooth curve: exactly half in the middle, slower than linear near the ends.
    const smooth: AnimTrack = { property: 'x', keys: [{ t: 0, value: 0 }, { t: 1, value: 100 }] };
    expect(valueAt(smooth, 0.5) as number).toBeCloseTo(50, 0);
    expect(valueAt(smooth, 0.1) as number).toBeLessThan(10);
  });

  it('color — per channel', () => {
    const tr: AnimTrack = { property: 'fill', keys: [{ t: 0, value: { r: 0, g: 0, b: 0, a: 1 }, easing: linear }, { t: 2, value: { r: 1, g: 0.5, b: 0, a: 0 } }] };
    expect(valueAt(tr, 1)).toEqual({ r: 0.5, g: 0.25, b: 0, a: 0.5 });
  });

  it('pose: rotation and scale around the center, without a track — regular values', () => {
    const { doc, box } = setup();
    expect(baseValue(doc, box, 'x')).toBe(20);
    expect(baseValue(doc, box, 'y')).toBe(40);
    doc.set(box, { animation: [{ property: 'rotation', keys: [{ t: 0, value: 0, easing: linear }, { t: 1, value: 90 }] }] });
    const p = animatedProps(doc, box, 1)!;
    const m = p.transform!;
    // The center (70, 65) stays in place.
    expect(m[0] * 50 + m[1] * 25 + m[2]).toBeCloseTo(70, 6);
    expect(m[3] * 50 + m[4] * 25 + m[5]).toBeCloseTo(65, 6);
    // Rotation by 90° (counterclockwise in the model — as in the panel).
    expect(m[0]).toBeCloseTo(0, 6);
    expect(Math.abs(m[1])).toBeCloseTo(1, 6);
    animatedProps(doc, box, 0)!.transform!.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 20, 0, 1, 40][i]!, 9));
  });

  it('loop: time wraps around; without a loop — to the end and stop', () => {
    const { doc, frame, box } = setup();
    doc.set(box, { animation: [{ property: 'opacity', keys: [{ t: 0, value: 1, easing: linear }, { t: 2, value: 0 }] }] });
    expect(timelineDuration(doc, frame)).toBe(2);
    expect(framePose(doc, frame, 3).get(box)!.opacity).toBe(0);
    doc.set(frame, { timeline: { duration: 2, loop: true } });
    expect(framePose(doc, frame, 3).get(box)!.opacity).toBeCloseTo(0.5, 6);
    expect(animationRoot(doc, box)).toBe(frame);
  });

  it('key: set, replace at the same moment, remove', () => {
    let tracks = withKey([], 'x', 1, 10);
    tracks = withKey(tracks, 'x', 0, 0);
    tracks = withKey(tracks, 'x', 1.0001, 20);
    expect(tracks).toEqual([{ property: 'x', keys: [{ t: 0, value: 0 }, { t: 1, value: 20 }] }]);
    tracks = withoutKey(tracks, 'x', 0);
    tracks = withoutKey(tracks, 'x', 1);
    expect(tracks).toEqual([]);
  });
});

describe('motion styles', () => {
  it('“Slide up” as a cascade: each layer gets an offset from its own pose and its own delay', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const frame = doc.create('FRAME', page, { width: 400, height: 300, timeline: { duration: 2 } });
    const a = doc.create('RECTANGLE', frame, { width: 50, height: 50, transform: [1, 0, 10, 0, 1, 100] });
    const b = doc.create('RECTANGLE', frame, { width: 50, height: 50, transform: [1, 0, 80, 0, 1, 200], opacity: 0.5 });
    const style = MOTION_PRESETS.find((p) => p.id === 'slide-up')!;
    const end = applyMotion(doc, [a, b], style, 0.2, 0.1);
    expect(end).toBeCloseTo(0.8);
    const y = (id: string) => doc.get(id, 'animation')!.find((t) => t.property === 'y')!.keys.map((k) => [k.t, k.value]);
    expect(y(a)).toEqual([[0.2, 124], [0.7, 100]]);
    expect(y(b)).toEqual([[0.3, 224], [0.8, 200]]);
    // Opacity is a fraction of its own: for b down to 0.5.
    expect(doc.get(b, 'animation')!.find((t) => t.property === 'opacity')!.keys.map((k) => k.value)).toEqual([0, 0.5]);
  });

  it('custom style from tracks: moments from the first key, offsets from the end pose', () => {
    const style = motionFromTracks('Мой', [{ property: 'x', keys: [{ t: 1, value: 40 }, { t: 1.5, value: 10 }] }, { property: 'opacity', keys: [{ t: 1, value: 0 }, { t: 1.3, value: 0.8 }] }])!;
    expect(style.tracks).toEqual([
      { property: 'x', keys: [{ t: 0, value: 30 }, { t: 0.5, value: 0 }] },
      { property: 'opacity', keys: [{ t: 0, value: 0 }, { t: 0.3, value: 1 }] },
    ]);
  });
});

describe('text animation', () => {
  it('pieces, end, reveal fraction; pose — the timeline moment at the text', () => {
    const a = { by: 'WORD' as const, effect: 'RISE' as const, start: 0.5, duration: 0.4, stagger: 0.1, easing: { type: 'LINEAR' as const } };
    expect(textAnimationUnits('WORD', 'Привет, большой мир')).toBe(3);
    expect(textAnimationUnits('LETTER', 'да нет')).toBe(5);
    expect(textAnimationEnd(a, 'Привет, большой мир')).toBeCloseTo(1.1);
    expect(textUnitProgress(a, 0, 0.5)).toBe(0);
    expect(textUnitProgress(a, 0, 0.7)).toBeCloseTo(0.5);
    expect(textUnitProgress(a, 2, 0.7)).toBe(0);
    expect(textUnitProgress(a, 2, 2)).toBe(1);
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const frame = doc.create('FRAME', page, { width: 400, height: 300 });
    const text = doc.create('TEXT', frame, { characters: 'Привет, большой мир', textAnimation: a });
    expect(animatedProps(doc, text, 0.8)).toEqual({ textAnimationTime: 0.8 });
    expect(timelineDuration(doc, frame)).toBe(1.1);
  });
});

describe('animation: repeat, hold, new properties', () => {
  it('repeat: once — stop at the end, loop — from the start, ping-pong — backward', async () => {
    const { timelineTime } = await import('@mfp/core');
    expect(timelineTime('ONCE', 2, 3)).toBe(2);
    expect(timelineTime('LOOP', 2, 3)).toBeCloseTo(1);
    expect(timelineTime('PING_PONG', 2, 3)).toBeCloseTo(1);
    expect(timelineTime('PING_PONG', 2, 3.5)).toBeCloseTo(0.5);
    expect(timelineTime('PING_PONG', 2, 4.5)).toBeCloseTo(0.5);
  });

  it('old files: loop — wraps around; playback takes precedence over loop', async () => {
    const { timelinePlayback, withPlayback } = await import('@mfp/core');
    expect(timelinePlayback({ duration: 1, loop: true })).toBe('LOOP');
    expect(timelinePlayback({ duration: 1 })).toBe('ONCE');
    expect(timelinePlayback(withPlayback({ duration: 1 }, 'PING_PONG'))).toBe('PING_PONG');
    expect(withPlayback({ duration: 1 }, 'PING_PONG').loop).toBe(true);
  });

  it('HOLD: the key value until the next one, then a jump', () => {
    const tr: AnimTrack = { property: 'opacity', keys: [{ t: 0, value: 0, easing: { type: 'HOLD' } }, { t: 1, value: 1 }] };
    expect(valueAt(tr, 0.999)).toBe(0);
    expect(valueAt(tr, 1)).toBe(1);
  });

  it('path trimming, stroke weight, padding, corner radius, stroke color and shadow — into layer properties', () => {
    const { doc, box } = setup();
    doc.set(box, {
      strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4, visible: true, blendMode: 'NORMAL' }],
      animation: [
        { property: 'trimEnd', keys: [{ t: 0, value: 0, easing: linear }, { t: 1, value: 1 }] },
        { property: 'strokeWeight', keys: [{ t: 0, value: 1, easing: linear }, { t: 1, value: 5 }] },
        { property: 'topLeftRadius', keys: [{ t: 0, value: 0, easing: linear }, { t: 1, value: 20 }] },
        { property: 'paddingLeft', keys: [{ t: 0, value: 0, easing: linear }, { t: 1, value: 10 }] },
        { property: 'stroke', keys: [{ t: 0, value: { r: 1, g: 0, b: 0, a: 1 }, easing: linear }, { t: 1, value: { r: 0, g: 0, b: 1, a: 1 } }] },
        { property: 'effect.0.OFFSET_Y', keys: [{ t: 0, value: 0, easing: linear }, { t: 1, value: 10 }] },
      ],
    });
    const p = animatedProps(doc, box, 0.5)!;
    expect(p.pathTrimEnd).toBeCloseTo(0.5);
    expect(p.strokeWeight).toBeCloseTo(3);
    expect(p.topLeftRadius).toBeCloseTo(10);
    expect(p.paddingLeft).toBeCloseTo(5);
    expect((p.strokes![0] as { color: { r: number } }).color.r).toBeCloseTo(0.5);
    expect((p.effects![0] as { offset: { y: number } }).offset.y).toBeCloseTo(5);
    // Trim does not go outside 0…1.
    doc.set(box, { animation: [{ property: 'trimStart', keys: [{ t: 0, value: -1 }, { t: 1, value: 2 }] }] });
    expect(animatedProps(doc, box, 0)!.pathTrimStart).toBe(0);
    expect(animatedProps(doc, box, 1)!.pathTrimStart).toBe(1);
  });

  it('per-axis scale — around the center (the center stays in place)', () => {
    const { doc, box } = setup();
    doc.set(box, { animation: [{ property: 'scaleX', keys: [{ t: 0, value: 2 }] }, { property: 'scaleY', keys: [{ t: 0, value: 0.5 }] }] });
    const m = animatedProps(doc, box, 0)!.transform!;
    // Center (70, 65): x0 = 70 − 2·50, y0 = 65 − 0.5·25.
    expect(m[0]).toBeCloseTo(2);
    expect(m[4]).toBeCloseTo(0.5);
    expect(m[2]).toBeCloseTo(-30);
    expect(m[5]).toBeCloseTo(52.5);
  });

  it('ping-pong in a frame pose', () => {
    const { doc, frame, box } = setup();
    doc.set(frame, { timeline: { duration: 2, playback: 'PING_PONG' } });
    doc.set(box, { animation: [{ property: 'opacity', keys: [{ t: 0, value: 0, easing: linear }, { t: 2, value: 1 }] }] });
    expect(framePose(doc, frame, 3).get(box)!.opacity).toBeCloseTo(0.5);
  });
});

describe('3D model on the timeline', () => {
  it('view angle and clip frame — in the MODEL3D fill (other fill fields unchanged)', () => {
    const { doc, box } = setup();
    doc.set(box, {
      fills: [{ type: 'MODEL3D', scaleMode: 'FIT', modelHash: 'ab', camera: { yaw: 30, pitch: 15, zoom: 1 }, clip: 'Run', orbit: true }],
      animation: [
        { property: 'modelYaw', keys: [{ t: 0, value: 0, easing: linear }, { t: 2, value: 180 }] },
        { property: 'modelZoom', keys: [{ t: 0, value: 1, easing: linear }, { t: 2, value: 2 }] },
        { property: 'modelTime', keys: [{ t: 0, value: 0, easing: linear }, { t: 2, value: 1 }] },
      ],
    });
    expect(baseValue(doc, box, 'modelPitch')).toBe(15);
    const f = animatedProps(doc, box, 1)!.fills![0] as { camera: { yaw: number; pitch: number; zoom: number }; pose: number; clip: string; orbit: boolean };
    expect(f.camera.yaw).toBeCloseTo(90);
    expect(f.camera.pitch).toBe(15);
    expect(f.camera.zoom).toBeCloseTo(1.5);
    expect(f.pose).toBeCloseTo(0.5);
    expect(f.clip).toBe('Run');
    expect(f.orbit).toBe(true);
  });
});
