import { join } from 'node:path';
import CanvasKitModule, { type CanvasKit } from 'canvaskit-wasm';
import { describe, expect, it, vi } from 'vitest';
import { Document, type Props } from '@mfp/core';
import { CoreScene } from '../src/core-scene.ts';
import { SceneRenderer } from '../src/renderer.ts';
import { widthAt } from '../src/stroke.ts';
import { shaderParams, shaderUsesTime, shaderContractError, SHADER_PRESETS, SHADER_EFFECT_PRESETS } from '../src/shader-paint.ts';

const CanvasKitInit = CanvasKitModule as unknown as (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin', f) });

const RED = [{ type: 'SOLID' as const, color: { r: 1, g: 0, b: 0 } }];

it('renders a gradient stroke on a zero-height line without losing the canvas', () => {
  const at = render((doc, page) => {
    doc.create('LINE', page, { width: 30, height: 0, transform: [1, 0, 5, 0, 1, 20], strokeWeight: 4,
      strokes: [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ] }],
    });
  });
  expect(at(7, 20)[0]).toBeGreaterThan(at(7, 20)[2]!);
  expect(at(32, 20)[2]).toBeGreaterThan(at(32, 20)[0]!);
});

it.each(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'] as const)(
  'renders %s strokes on zero-width vectors', type => {
    const at = render((doc, page) => {
      doc.create('VECTOR', page, { width: 0, height: 30, transform: [1, 0, 20, 0, 1, 5],
        vectorPaths: [{ windingRule: 'NONZERO', data: 'M 0 0 L 0 30' }], strokeWeight: 4,
        strokes: [{ type, gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ] }],
      });
    });
    expect(at(20, 15)).not.toEqual([255, 255, 255]);
  },
);

it('a refused gradient shader does not hide other layers or draw a black fallback', () => {
  const factory = vi.spyOn(ck.Shader, 'MakeLinearGradient').mockReturnValue(null as never);
  try {
    const at = render((doc, page) => {
      doc.create('RECTANGLE', page, { width: 40, height: 40, fills: RED });
      doc.create('RECTANGLE', page, { width: 40, height: 40, fills: [{ type: 'GRADIENT_LINEAR',
        gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [],
      }] });
    });
    expect(at(20, 20)).toEqual([255, 0, 0]);
  } finally { factory.mockRestore(); }
});

/** Draw a 40×40 page on white and return a “pixel (x, y) → [r, g, b]” function. */
function render(build: (doc: Document, page: string) => void) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  build(doc, page);
  return renderDocument(doc, page);
}

function renderDocument(doc: Document, page: string) {
  const scene = new CoreScene(doc, page);
  const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
  scene.attach(renderer);
  const surface = ck.MakeSurface(40, 40)!;
  const canvas = surface.getCanvas();
  canvas.clear(ck.WHITE);
  renderer.render(canvas, scene.page.children, [0, 0, 40, 40], 1);
  surface.flush();
  const info = { width: 40, height: 40, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB };
  const px = canvas.readPixels(0, 0, info) as Uint8Array;
  surface.delete();
  renderer.dispose();
  return (x: number, y: number) => [...px.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 3)];
}

it('keeps the contents of small containers visible at an eight-pixel screen size', () => {
  const at = render((doc, page) => {
    const group = doc.create('GROUP', page, { width: 8, height: 8, transform: [1, 0, 10, 0, 1, 10] });
    const frame = doc.create('FRAME', group, { width: 8, height: 8, fills: [] });
    doc.create('RECTANGLE', frame, { width: 8, height: 8, fills: RED });
  });
  expect(at(14, 14)).toEqual([255, 0, 0]);
});

/** Group: mask 0…20 × 0…40 with fill mask, above it a red square covering the whole canvas. */
function masked(mask: Props) {
  return render((doc, page) => {
    const g = doc.create('GROUP', page, { width: 40, height: 40 });
    doc.create('RECTANGLE', g, { width: 20, height: 40, isMask: true, ...mask });
    doc.create('RECTANGLE', g, { width: 40, height: 40, fills: RED });
  });
}

describe('masks', () => {
  it('alpha: a semi-transparent mask gives semi-transparent content, outside the mask is empty', () => {
    const at = masked({ fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }] });
    const [r, g] = at(10, 20);
    expect(r).toBeGreaterThan(250);
    expect(g).toBeGreaterThan(120);
    expect(g).toBeLessThan(135);
    expect(at(30, 20)).toEqual([255, 255, 255]);
  });

  it('vector: the mask fill opacity does not matter', () => {
    const at = masked({ maskType: 'VECTOR', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.2 }] });
    expect(at(10, 20)).toEqual([255, 0, 0]);
    expect(at(30, 20)).toEqual([255, 255, 255]);
  });

  it('luminance: a black mask hides, a white one shows', () => {
    const black = masked({ maskType: 'LUMINANCE', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] });
    expect(black(10, 20)).toEqual([255, 255, 255]);
    const white = masked({ maskType: 'LUMINANCE', fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] });
    expect(white(10, 20)).toEqual([255, 0, 0]);
  });
});

describe('shadows', () => {
  /** Semi-transparent square 10…30 with an unblurred shadow offset by (0; 0) — the shadow is exactly under it. */
  const shadowed = (behind: boolean) =>
    render((doc, page) => {
      doc.create('FRAME', page, {
        transform: [1, 0, 10, 0, 1, 10],
        width: 20,
        height: 20,
        clipsContent: false,
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 0.5 }],
        effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 1, a: 1 }, offset: { x: 4, y: 0 }, radius: 0, visible: true, blendMode: 'NORMAL', ...(behind ? { showShadowBehindNode: true } : {}) }],
      });
    });

  it('by default the shadow is only outside the layer', () => {
    const at = shadowed(false);
    // No shadow under the semi-transparent layer: white on white.
    expect(at(20, 20)).toEqual([255, 255, 255]);
    // To the right, where there is no layer, the shadow is visible.
    expect(at(32, 20)).toEqual([0, 0, 255]);
  });

  it('“show behind transparent areas” — the shadow shows through the layer', () => {
    // A shape's shadow follows the shape at full strength, with a 50% white fill on top.
    const [r, , b] = shadowed(true)(20, 20);
    expect(b).toBeGreaterThan(250);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(135);
  });

  it('image and group shadows follow the content alpha', () => {
    const at = render((doc, page) => {
      const g = doc.create('GROUP', page, {
        width: 20,
        height: 20,
        transform: [1, 0, 10, 0, 1, 10],
        effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 1, a: 1 }, offset: { x: 4, y: 0 }, radius: 0, visible: true, blendMode: 'NORMAL' }],
      });
      doc.create('RECTANGLE', g, { width: 20, height: 20, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 0.5 }] });
    });
    // To the right of the group — the shadow by alpha (50%).
    const [r, , b] = at(32, 20);
    expect(b).toBeGreaterThan(250);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(135);
    // Under a group (by default) the shadow is cut out by the content's alpha — weaker than outside.
    const under = at(20, 20);
    expect(under[0]).toBeGreaterThan(r! + 40);
  });
});

describe('effects: progressive blur, noise, texture, glass', () => {
  /** 2 px stripes (red, blue) across the whole canvas and a layer on top with the effect. */
  const striped = (layer: Props) =>
    render((doc, page) => {
      for (let x = 0; x < 40; x += 4) doc.create('RECTANGLE', page, { transform: [1, 0, x, 0, 1, 0], width: 2, height: 40, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] });
      doc.create('RECTANGLE', page, { width: 40, height: 40, fills: [], ...layer });
    });
  const spread = (at: (x: number, y: number) => number[], y: number) => {
    // Spread of red along a row (blue stripes on white): sharp — 0 and 255, blurred — in between.
    const row = Array.from({ length: 20 }, (_, x) => at(x + 10, y)[0]!);
    return Math.max(...row.map((b) => 255 - b)) - Math.min(...row.map((b) => 255 - b));
  };

  it('progressive background blur: sharp at the top, blurred at the bottom', () => {
    const at = striped({ effects: [{ type: 'BACKGROUND_BLUR', radius: 12, blurType: 'PROGRESSIVE', startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 }, visible: true }] });
    expect(spread(at, 1)).toBeGreaterThan(200);
    expect(spread(at, 38)).toBeLessThan(60);
  });

  it('progressive layer blur: start and end can be swapped', () => {
    const at = render((doc, page) => {
      const g = doc.create('FRAME', page, { width: 40, height: 40, fills: [], clipsContent: false, effects: [{ type: 'LAYER_BLUR', radius: 12, blurType: 'PROGRESSIVE', startRadius: 0, startOffset: { x: 0.5, y: 1 }, endOffset: { x: 0.5, y: 0 }, visible: true }] });
      for (let x = 0; x < 40; x += 4) doc.create('RECTANGLE', g, { transform: [1, 0, x, 0, 1, 0], width: 2, height: 40, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] });
    });
    expect(spread(at, 38)).toBeGreaterThan(200);
    expect(spread(at, 1)).toBeLessThan(80);
  });

  it('noise: grains of the noise color only on the layer, outside the layer is empty', () => {
    const at = render((doc, page) => {
      doc.create('RECTANGLE', page, {
        width: 20,
        height: 40,
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
        effects: [{ type: 'NOISE', noiseType: 'MONOTONE', color: { r: 0, g: 0, b: 0, a: 1 }, noiseSize: 1, density: 0.5, blendMode: 'NORMAL', visible: true }],
      });
    });
    let dark = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 20; x++) if (at(x, y)[0]! < 128) dark++;
    // About half of the grains are filled.
    expect(dark).toBeGreaterThan(300);
    expect(dark).toBeLessThan(500);
    for (let y = 0; y < 40; y += 5) expect(at(30, y)).toEqual([255, 255, 255]);
  });

  it('texture: the layer edge becomes grainy (dots beyond the edge and holes near it)', () => {
    const plain = render((doc, page) => doc.create('RECTANGLE', page, { transform: [1, 0, 10, 0, 1, 10], width: 20, height: 20, fills: RED }));
    const grainy = render((doc, page) =>
      doc.create('RECTANGLE', page, { transform: [1, 0, 10, 0, 1, 10], width: 20, height: 20, fills: RED, effects: [{ type: 'TEXTURE', noiseSize: 1, radius: 3, clipToShape: false, visible: true }] }),
    );
    let diff = 0;
    for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) if (plain(x, y).join() !== grainy(x, y).join()) diff++;
    expect(diff).toBeGreaterThan(40);
    // The middle of the fill is the same.
    expect(grainy(20, 20)).toEqual([255, 0, 0]);
  });

  it('glass: the background near the edge is displaced (refraction), in the middle — as is', () => {
    const glass = striped({ cornerRadius: 0, effects: [{ type: 'GLASS', lightIntensity: 0, lightAngle: -45, refraction: 1, depth: 10, dispersion: 0, radius: 0, visible: true }] });
    const plain = striped({});
    // A band at the left and right edges (refraction depth — 10 px) and the middle.
    let edge = 0;
    for (let y = 12; y < 28; y++) for (const x of [0, 1, 2, 3, 4, 5, 34, 35, 36, 37, 38, 39]) if (glass(x, y).join() !== plain(x, y).join()) edge++;
    expect(edge).toBeGreaterThan(40);
    for (let x = 14; x < 26; x++) expect(glass(x, 20)).toEqual(plain(x, 20));
  });
});

describe('variable stroke width', () => {
  it('width between points is smooth, beyond the outer points it matches them', () => {
    const pts = [
      { position: 0.2, ascent: 2, descent: 2 },
      { position: 0.8, ascent: 10, descent: 4 },
    ];
    expect(widthAt(pts, 0)).toEqual([2, 2]);
    expect(widthAt(pts, 1)).toEqual([10, 4]);
    const [m1, m2] = widthAt(pts, 0.5);
    expect(m1).toBeCloseTo(6, 6);
    expect(m2).toBeCloseTo(3, 6);
    const [a] = widthAt(pts, 0.3);
    expect(a).toBeGreaterThan(2);
    expect(a).toBeLessThan(3);
  });

  it('a line from thin to thick: narrow at the start, wide at the end', () => {
    const at = render((doc, page) =>
      doc.create('LINE', page, {
        transform: [1, 0, 2, 0, 1, 20],
        width: 36,
        strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
        strokeWeight: 2,
        variableWidthPoints: [
          { position: 0, ascent: 1, descent: 1 },
          { position: 1, ascent: 8, descent: 8 },
        ],
      }),
    );
    // Near the start (x ≈ 4) — thin: 4 px from the line it is already white.
    expect(at(4, 20)).toEqual([255, 0, 0]);
    expect(at(4, 16)).toEqual([255, 255, 255]);
    // Near the end (x ≈ 36) — thick: even 6 px from the line it is red.
    expect(at(36, 14)).toEqual([255, 0, 0]);
    expect(at(36, 26)).toEqual([255, 0, 0]);
  });
});

describe('patterns', () => {
  it('invalidates nested deleted sources and switches live/archive caches through Undo and Redo', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const group = doc.create('GROUP', page);
    const src = doc.create('RECTANGLE', group, { width: 10, height: 10, transform: [1, 0, 100, 0, 1, 0], fills: RED });
    doc.create('RECTANGLE', page, { width: 40, height: 40, fills: [{ type: 'PATTERN', sourceNodeId: src, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' }] });
    const scene = new CoreScene(doc, page);
    const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
    scene.attach(renderer);
    let dirty: number[][] = [];
    doc.onChange((ops) => { dirty = scene.apply(ops); });
    const surface = ck.MakeSurface(40, 40)!;
    const draw = () => {
      const canvas = surface.getCanvas(); canvas.clear(ck.WHITE);
      renderer.render(canvas, scene.page.children, [0, 0, 40, 40], 1);
      const px = canvas.readPixels(2, 2, { width: 1, height: 1, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
      return [...px.slice(0, 3)];
    };
    expect(draw()).toEqual([255, 0, 0]);
    doc.delete(group);
    expect(dirty.some((r) => r[0]! <= 0 && r[2]! >= 40)).toBe(true);
    expect(draw()).toEqual([255, 0, 0]);
    doc.undo(); expect(draw()).toEqual([255, 0, 0]);
    doc.redo(); expect(draw()).toEqual([255, 0, 0]);
    doc.undo(); doc.set(src, { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] });
    expect(draw()).toEqual([0, 0, 255]);
    surface.delete(); scene.dispose(); renderer.dispose();
  });
  it('deleted motifs remain visible after reload, including their vector geometry', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const src = doc.create('FRAME', page, { width: 10, height: 10, transform: [1, 0, 100, 0, 1, 0], fills: [] });
    doc.create('VECTOR', src, { width: 5, height: 5, fills: RED, vectorPaths: [{ windingRule: 'NONZERO', blob: doc.putBlob('M0 0L5 0L5 5L0 5Z') }] });
    doc.create('RECTANGLE', page, { width: 40, height: 40, fills: [{ type: 'PATTERN', sourceNodeId: src, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' }] });
    const original = renderDocument(doc, page);
    doc.delete(src);
    const loaded = Document.fromSnapshot(doc.snapshot());
    const after = renderDocument(loaded, page);
    for (const [x, y] of [[2, 2], [12, 22], [7, 7]] as [number, number][]) expect(after(x, y)).toEqual(original(x, y));
    expect(after(2, 2)).toEqual([255, 0, 0]);
  });
  /** A 10×10 motif (a 5×5 red square in the corner) somewhere to the right; a 40×40 layer filled with a pattern of it. */
  const pattern = (patch: Record<string, unknown> = {}, elsewhere = false) =>
    render((doc, page) => {
      const host = elsewhere ? doc.create('PAGE', doc.root) : page;
      const src = doc.create('FRAME', host, { width: 10, height: 10, transform: [1, 0, 100, 0, 1, 0], fills: [] });
      doc.create('RECTANGLE', src, { width: 5, height: 5, fills: RED });
      doc.create('RECTANGLE', page, {
        width: 40,
        height: 40,
        fills: [{ type: 'PATTERN', sourceNodeId: src, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START', ...patch } as never],
      });
    });

  it('grid: the motif repeats every source size', () => {
    const at = pattern();
    expect(at(2, 2)).toEqual([255, 0, 0]);
    expect(at(12, 22)).toEqual([255, 0, 0]);
    expect(at(7, 7)).toEqual([255, 255, 255]);
  });

  it('offset rows: every second row is shifted by half a tile', () => {
    const at = pattern({ tileType: 'HORIZONTAL_HEXAGONAL' });
    expect(at(2, 12)).toEqual([255, 255, 255]);
    expect(at(7, 12)).toEqual([255, 0, 0]);
    expect(at(2, 22)).toEqual([255, 0, 0]);
  });

  it('scale and spacing (in tile fractions)', () => {
    const at = pattern({ scalingFactor: 2, spacing: { x: 1, y: 0 } });
    expect(at(5, 5)).toEqual([255, 0, 0]);
    expect(at(25, 5)).toEqual([255, 255, 255]);
    expect(at(5, 25)).toEqual([255, 0, 0]);
  });

  it('source on another page', () => {
    expect(pattern({}, true)(2, 2)).toEqual([255, 0, 0]);
  });

  it('editing the source puts the pattern layer into the redraw area; a pattern inside its own source does not loop', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const src = doc.create('FRAME', page, { width: 10, height: 10, transform: [1, 0, 100, 0, 1, 0], fills: [] });
    const dot = doc.create('RECTANGLE', src, { width: 5, height: 5, fills: RED });
    const fill = { type: 'PATTERN', sourceNodeId: src, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' } as never;
    doc.create('RECTANGLE', page, { width: 40, height: 40, transform: [1, 0, 0, 0, 1, 300], fills: [fill] });
    const scene = new CoreScene(doc, page);
    const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
    scene.attach(renderer);
    let dirty: number[][] = [];
    doc.onChange((ops) => (dirty = scene.apply(ops)));
    doc.set(dot, { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] });
    expect(dirty.some((r) => r[1]! <= 300 && r[3]! >= 340)).toBe(true);
    // A pattern inside its own source: drawn without infinite tile recording.
    doc.create('RECTANGLE', src, { width: 10, height: 10, fills: [fill] });
    const surface = ck.MakeSurface(40, 40)!;
    expect(() => renderer.render(surface.getCanvas(), scene.page.children, [0, 0, 400, 400], 1)).not.toThrow();
    surface.delete();
    renderer.dispose();
  });
});

describe('shader fill', () => {
  it('commented-out uniforms do not create parameters or animation', () => {
    const source = `// uniform float ghost;\n/* uniform float time;\n uniform half4 color; */\nuniform float gain; // Яркость: 0.5 (0..1)`;
    expect(shaderParams(source).map((p) => p.name)).toEqual(['gain']);
    expect(shaderUsesTime(source)).toBe(false);
    expect(shaderUsesTime(source + '\nuniform float time;')).toBe(true);
  });

  it.each(SHADER_PRESETS)('$name: compiles and draws without external resources', ({ code }) => {
    const effect = ck.RuntimeEffect.Make(code);
    expect(effect).not.toBeNull();
    effect?.delete();
    const at = render((doc, page) => {
      doc.create('RECTANGLE', page, { width: 40, height: 40, fills: [{ type: 'SHADER', code }] });
    });
    expect([at(5, 5), at(20, 20), at(35, 35)].flat().every(Number.isFinite)).toBe(true);
  });

  it.each(['fill', 'effect'] as const)('%s: the animation receives time, stopping returns a static frame', (kind) => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const code = kind === 'fill'
      ? 'uniform float time; half4 main(float2 p) { return half4(time, 0, 0, 1); }'
      : 'uniform shader content; uniform float time; half4 main(float2 p) { return content.eval(p) * half4(time, 0, 0, 1); }';
    const paints = (animate: boolean) => kind === 'fill'
      ? { fills: [{ type: 'SHADER' as const, code, animate }] }
      : { fills: RED, effects: [{ type: 'SHADER' as const, code, animate, visible: true }] };
    const id = doc.create('RECTANGLE', page, { width: 40, height: 40, ...paints(true) });
    const scene = new CoreScene(doc, page);
    const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
    scene.attach(renderer);
    const off = doc.onChange((ops) => scene.apply(ops));
    const surface = ck.MakeSurface(40, 40)!;
    const sample = () => {
      renderer.render(surface.getCanvas(), scene.page.children, [0, 0, 40, 40], 1);
      const px = surface.getCanvas().readPixels(20, 20, { width: 1, height: 1, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB })!;
      return px[0];
    };
    renderer.time = 0;
    expect(sample()).toBe(0);
    renderer.time = 1;
    expect(sample()).toBe(255);
    expect(renderer.takeShaderAnimated()).toBe(true);
    doc.set(id, paints(false));
    expect(sample()).toBe(0);
    expect(renderer.takeShaderAnimated()).toBe(false);
    expect(renderer.shaderError('not valid SkSL')).toBeTruthy();
    off();
    surface.delete();
    renderer.dispose();
  });

  const code = `uniform float2 size;
uniform half4 tint; // Цвет: #00FF00
uniform float k; // Доля: 0.5 (0..1)
half4 main(float2 p) { return p.x < size.x * k ? tint : half4(0, 0, 1, 1); }`;

  it('parameters from comments: label, value, limits, color', () => {
    expect(shaderParams(code)).toEqual([
      { name: 'tint', kind: 'color', size: 4, label: 'Цвет', value: [0, 1, 0, 1] },
      { name: 'k', kind: 'float', size: 1, label: 'Доля', value: [0.5], min: 0, max: 1 },
    ]);
  });

  it('size is the layer size, parameters come from the paint or defaults', () => {
    const at = render((doc, page) => {
      doc.create('RECTANGLE', page, { width: 40, height: 40, fills: [{ type: 'SHADER', code } as never] });
    });
    expect(at(10, 20)).toEqual([0, 255, 0]);
    expect(at(30, 20)).toEqual([0, 0, 255]);
    const at2 = render((doc, page) => {
      doc.create('RECTANGLE', page, { width: 40, height: 40, fills: [{ type: 'SHADER', code, params: { k: [0.1], tint: [1, 0, 0, 1] } } as never] });
    });
    expect(at2(2, 20)).toEqual([255, 0, 0]);
    expect(at2(10, 20)).toEqual([0, 0, 255]);
  });
});

describe('shader effect over content', () => {
  const invert = SHADER_EFFECT_PRESETS.find((p) => p.id === 'effect-invert')!.code;
  it.each(SHADER_EFFECT_PRESETS)('$name builds with a single input', ({ code }) => {
    expect(shaderContractError(code, 'effect')).toBeNull();
    const effect = ck.RuntimeEffect.Make(code);
    expect(effect).not.toBeNull();
    effect?.delete();
  });

  it('processes child layers, preserves transparency and applies opacity once', () => {
    const at = render((doc, page) => {
      const group = doc.create('GROUP', page, { width: 40, height: 40, opacity: 0.5, effects: [{ type: 'SHADER', code: invert, visible: true }] });
      doc.create('RECTANGLE', group, { width: 20, height: 40, fills: RED });
    });
    // Red → light blue; 50% over white.
    expect(at(10, 20)[0]).toBeGreaterThanOrEqual(127);
    expect(at(10, 20)[0]).toBeLessThanOrEqual(128);
    expect(at(10, 20).slice(1)).toEqual([255, 255]);
    expect(at(30, 20)).toEqual([255, 255, 255]);
  });

  it('effects run in sequence; hidden and failing ones leave the source unchanged', () => {
    for (const effects of [
      [{ type: 'SHADER' as const, code: invert, visible: true }, { type: 'SHADER' as const, code: invert, visible: true }],
      [{ type: 'SHADER' as const, code: invert, visible: false }],
      [{ type: 'SHADER' as const, code: 'broken', visible: true }],
    ]) {
      const at = render((doc, page) => doc.create('RECTANGLE', page, { width: 40, height: 40, fills: RED, effects }));
      expect(at(20, 20)).toEqual([255, 0, 0]);
    }
  });

  it('the contract does not allow a wrong number of inputs into WASM', () => {
    expect(shaderContractError('uniform shader content;', 'fill')).toBeTruthy();
    expect(shaderContractError('// uniform shader content;', 'effect')).toBeTruthy();
    expect(shaderContractError('uniform shader content, other;', 'effect')).toBeTruthy();
    expect(shaderContractError('uniform shader content; uniform shader other;', 'effect')).toBeTruthy();
  });

  it('a child change invalidates the whole effect; parameters are saved and undone', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const group = doc.create('GROUP', page, { width: 400, height: 400, effects: [{ type: 'SHADER', code: invert, params: { amount: [0.5] }, animate: false, visible: true }] });
    const child = doc.create('RECTANGLE', group, { width: 10, height: 10, fills: RED });
    const scene = new CoreScene(doc, page);
    const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
    scene.attach(renderer);
    let dirty: number[][] = [];
    const off = doc.onChange((ops) => { dirty = scene.apply(ops); });
    doc.set(child, { fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }] });
    expect(dirty.some((r) => r[0]! <= 0 && r[2]! >= 400 && r[3]! >= 400)).toBe(true);
    const restored = Document.fromSnapshot(JSON.parse(JSON.stringify(doc.snapshot())));
    expect(restored.get(group, 'effects')).toEqual(doc.get(group, 'effects'));
    doc.transact(() => doc.set(group, { effects: [] }));
    doc.undo();
    expect(doc.get(group, 'effects')![0]!.type).toBe('SHADER');
    off();
    renderer.dispose();
  });

  it('the parent transform is applied once, a nested layer\'s effect also works', () => {
    const at = render((doc, page) => {
      const group = doc.create('GROUP', page, { width: 10, height: 10, transform: [1, 0, 10, 0, 1, 10], effects: [{ type: 'SHADER', code: invert, visible: true }] });
      doc.create('RECTANGLE', group, { width: 10, height: 10, fills: RED, effects: [{ type: 'SHADER', code: invert, visible: true }] });
    });
    expect(at(15, 15)).toEqual([255, 0, 0]);
    expect(at(25, 25)).toEqual([255, 255, 255]);
  });
});

describe('layer 3D rotation', () => {
  it('rotation around Y with perspective: the near edge is taller than the far one, the middle stays in place', () => {
    // A 40×40 square covering the whole canvas, the right edge recedes from the viewer (strong perspective).
    const at = render((doc, page) => {
      doc.create('RECTANGLE', page, { width: 40, height: 40, fills: RED, rotateY: 50, perspective: 60 });
    });
    expect(at(20, 20)).toEqual([255, 0, 0]);
    // The left (near) edge extends beyond the canvas height — red at the top left; the right (far) one is below the top.
    expect(at(4, 1)).toEqual([255, 0, 0]);
    expect(at(30, 1)).toEqual([255, 255, 255]);
    // The layer is compressed horizontally: empty near the canvas edges.
    expect(at(1, 20)).toEqual([255, 255, 255]);
    expect(at(38, 20)).toEqual([255, 255, 255]);
  });

  it('pointer hit testing and bounds follow the projection', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const r = doc.create('RECTANGLE', page, { width: 100, height: 100, fills: RED, rotateY: 60, perspective: 400 });
    const scene = new CoreScene(doc, page);
    const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
    scene.attach(renderer);
    const b = renderer.boundsOf(scene.node(r)!)!;
    // Projection width is less than 100 (cos 60° = 0.5 plus perspective), height at the near edge is more than 100.
    expect(b[2] - b[0] - 4).toBeLessThan(60);
    expect(b[3] - b[1] - 4).toBeGreaterThan(100);
    expect(scene.hitPath(50, 50).length).toBe(1);
    // A point inside the flat bounds but outside the projection — a miss.
    expect(scene.hitPath(95, 50).length).toBe(0);
    renderer.dispose();
  });
});

describe('path trim', () => {
  it('a 0…40 line trimmed to 25–75 % — only the middle is visible', () => {
    const at = render((doc, page) => {
      doc.create('LINE', page, { width: 40, height: 0, transform: [1, 0, 0, 0, 1, 20], strokeWeight: 4, strokes: RED, pathTrimStart: 0.25, pathTrimEnd: 0.75 });
    });
    expect(at(5, 20)).toEqual([255, 255, 255]);
    expect(at(20, 20)).toEqual([255, 0, 0]);
    expect(at(35, 20)).toEqual([255, 255, 255]);
  });

  it('a rectangle trimmed to 0–50 %: the stroke covers only part of the contour; without trimming — all of it', () => {
    const build = (trim: boolean) => render((doc, page) => {
      doc.create('RECTANGLE', page, { width: 30, height: 30, transform: [1, 0, 5, 0, 1, 5], strokeWeight: 2, strokeAlign: 'CENTER', fills: [], strokes: RED, ...(trim ? { pathTrimEnd: 0.5 } : {}) });
    });
    const full = build(false);
    const half = build(true);
    // The top side (path start) — in both; the bottom-left (path end) — only without trim.
    expect(full(20, 5)).toEqual([255, 0, 0]);
    expect(half(20, 5)).toEqual([255, 0, 0]);
    expect(full(5, 20)).toEqual([255, 0, 0]);
    expect(half(5, 20)).toEqual([255, 255, 255]);
  });
});
