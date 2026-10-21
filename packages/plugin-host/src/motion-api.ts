// Plugin Motion API: layer keyframes (manualKeyframeTracks, applyManualKeyframeTrack,
// removeManualKeyframeTrack, animations), timeline (timelines, setTimelineDuration), motion styles
// (animationStyles, applyAnimationStyle, removeAnimationStyle) and figma.motion. Figma fields map to
// document tracks (core/animation): TRANSLATION_X/Y and ROTATION are added to the base value
// (the track's baseValue), SCALE_* is a multiplier, the rest are values as is; colors are fills/strokes
// by paint index, effects are effects[index][field]. In Figma a key's curve is the transition TO it, in the
// document it is FROM the key: it is shifted by one key on write and read. 3D rotation is hidden from plugins.

import {
  animatedValue,
  animationRoot,
  baseValue,
  indexedProperty,
  normalizedSpring,
  physicalSpringToNormalized,
  timelineDuration,
  withKey,
  type AnimProperty,
  type AnimTrack,
  type AppliedMotionStyle,
  type Document,
  type Easing,
  type EffectField,
  type Keyframe,
  type RGBA,
} from '@mfp/core';

type Json = Record<string, unknown>;

/** PROPERTY fields → track property and how the value relates to the base one. */
const FIELDS: Record<string, { prop: AnimProperty; op: 'SET' | 'OFFSET' | 'SCALE' }> = {
  TRANSLATION_X: { prop: 'x', op: 'OFFSET' },
  TRANSLATION_Y: { prop: 'y', op: 'OFFSET' },
  ROTATION: { prop: 'rotation', op: 'OFFSET' },
  SCALE_X: { prop: 'scaleX', op: 'SCALE' },
  SCALE_Y: { prop: 'scaleY', op: 'SCALE' },
  OPACITY: { prop: 'opacity', op: 'SET' },
  CORNER_RADIUS: { prop: 'cornerRadius', op: 'SET' },
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: { prop: 'topLeftRadius', op: 'SET' },
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: { prop: 'topRightRadius', op: 'SET' },
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: { prop: 'bottomLeftRadius', op: 'SET' },
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: { prop: 'bottomRightRadius', op: 'SET' },
  STROKE_WEIGHT: { prop: 'strokeWeight', op: 'SET' },
  BORDER_TOP_WEIGHT: { prop: 'strokeTopWeight', op: 'SET' },
  BORDER_BOTTOM_WEIGHT: { prop: 'strokeBottomWeight', op: 'SET' },
  BORDER_LEFT_WEIGHT: { prop: 'strokeLeftWeight', op: 'SET' },
  BORDER_RIGHT_WEIGHT: { prop: 'strokeRightWeight', op: 'SET' },
  STACK_SPACING: { prop: 'itemSpacing', op: 'SET' },
  STACK_COUNTER_SPACING: { prop: 'counterAxisSpacing', op: 'SET' },
  STACK_PADDING_LEFT: { prop: 'paddingLeft', op: 'SET' },
  STACK_PADDING_TOP: { prop: 'paddingTop', op: 'SET' },
  STACK_PADDING_RIGHT: { prop: 'paddingRight', op: 'SET' },
  STACK_PADDING_BOTTOM: { prop: 'paddingBottom', op: 'SET' },
  GRID_ROW_GAP: { prop: 'gridRowGap', op: 'SET' },
  GRID_COLUMN_GAP: { prop: 'gridColumnGap', op: 'SET' },
  PATH_TRIM_START: { prop: 'trimStart', op: 'SET' },
  PATH_TRIM_END: { prop: 'trimEnd', op: 'SET' },
  WIDTH: { prop: 'width', op: 'SET' },
  HEIGHT: { prop: 'height', op: 'SET' },
};
const FIELD_OF = new Map<AnimProperty, string>(Object.entries(FIELDS).map(([k, v]) => [v.prop, k]));

/** Figma effect fields → ours (we have one grain size for both axes). */
const EFFECT_IN: Record<string, EffectField> = {
  OFFSET_X: 'OFFSET_X',
  OFFSET_Y: 'OFFSET_Y',
  RADIUS: 'RADIUS',
  SPREAD: 'SPREAD',
  COLOR: 'COLOR',
  START_RADIUS: 'START_RADIUS',
  NOISE_SIZE_X: 'NOISE_SIZE',
  NOISE_SIZE_Y: 'NOISE_SIZE',
  DENSITY: 'DENSITY',
  EFFECT_OPACITY: 'EFFECT_OPACITY',
  SECONDARY_COLOR: 'SECONDARY_COLOR',
  REFRACTION_RADIUS: 'REFRACTION_RADIUS',
  REFRACTION_INTENSITY: 'REFRACTION_INTENSITY',
  SPECULAR_ANGLE: 'SPECULAR_ANGLE',
  SPECULAR_INTENSITY: 'SPECULAR_INTENSITY',
  CHROMATIC_ABERRATION: 'CHROMATIC_ABERRATION',
};
const EFFECT_OUT: Record<EffectField, string> = {
  OFFSET_X: 'OFFSET_X',
  OFFSET_Y: 'OFFSET_Y',
  RADIUS: 'RADIUS',
  SPREAD: 'SPREAD',
  COLOR: 'COLOR',
  START_RADIUS: 'START_RADIUS',
  NOISE_SIZE: 'NOISE_SIZE_X',
  DENSITY: 'DENSITY',
  EFFECT_OPACITY: 'EFFECT_OPACITY',
  SECONDARY_COLOR: 'SECONDARY_COLOR',
  REFRACTION_RADIUS: 'REFRACTION_RADIUS',
  REFRACTION_INTENSITY: 'REFRACTION_INTENSITY',
  SPECULAR_ANGLE: 'SPECULAR_ANGLE',
  SPECULAR_INTENSITY: 'SPECULAR_INTENSITY',
  CHROMATIC_ABERRATION: 'CHROMATIC_ABERRATION',
};

const EASING_TYPES = new Set(['EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK', 'EASE_OUT_BACK', 'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING', 'HOLD']);

let seq = 0;
const newId = (prefix: string) => `${prefix}:${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Figma curve → document (validation: exact names, required parameters). */
export function easingIn(e: unknown): Easing | undefined {
  if (e === undefined || e === null) return undefined;
  const x = e as Json;
  const type = String(x.type);
  if (!EASING_TYPES.has(type)) throw new Error(`Easing type "${type}" is not supported (use EASE_IN, EASE_OUT, EASE_IN_AND_OUT, LINEAR, *_BACK, CUSTOM_CUBIC_BEZIER, GENTLE, QUICK, BOUNCY, SLOW, CUSTOM_SPRING or HOLD)`);
  if (type === 'CUSTOM_CUBIC_BEZIER') {
    const b = x.easingFunctionCubicBezier as Json | undefined;
    if (!b || !['x1', 'y1', 'x2', 'y2'].every((k) => typeof b[k] === 'number')) throw new Error('CUSTOM_CUBIC_BEZIER requires easingFunctionCubicBezier { x1, y1, x2, y2 }');
    return { type, easingFunctionCubicBezier: { x1: b.x1 as number, y1: b.y1 as number, x2: b.x2 as number, y2: b.y2 as number } };
  }
  if (type === 'CUSTOM_SPRING') {
    const sp = x.easingFunctionSpring as Json | undefined;
    const bounce = sp && typeof sp.bounce === 'number' ? sp.bounce : sp && typeof sp.stiffness === 'number' ? physicalSpringToNormalized(sp as { mass: number; stiffness: number; damping: number }) : NaN;
    if (!(bounce >= 0 && bounce <= 1)) throw new Error('CUSTOM_SPRING requires easingFunctionSpring { bounce } with 0 <= bounce <= 1');
    return { type, easingFunctionSpring: { ...normalizedSpring(bounce, 1), initialVelocity: 0, bounce } };
  }
  return { type: type as Easing['type'] };
}

/** Document curve → Figma (a spring via bounce elasticity). */
export function easingOut(e: Easing | undefined): Json | undefined {
  if (!e) return undefined;
  if (e.type === 'CUSTOM_CUBIC_BEZIER' && e.easingFunctionCubicBezier) return { type: e.type, easingFunctionCubicBezier: { ...e.easingFunctionCubicBezier } };
  if (e.type === 'CUSTOM_SPRING' && e.easingFunctionSpring) return { type: e.type, easingFunctionSpring: { bounce: e.easingFunctionSpring.bounce ?? physicalSpringToNormalized(e.easingFunctionSpring) } };
  return { type: e.type };
}

const isColor = (v: unknown): v is RGBA => !!v && typeof v === 'object' && ['r', 'g', 'b'].every((k) => typeof (v as Json)[k] === 'number');

function valueIn(v: unknown, kind: 'FLOAT' | 'COLOR' | 'VECTOR'): number | RGBA | { x: number; y: number } {
  const x = v as Json | undefined;
  if (!x || typeof x !== 'object') throw new Error('Keyframe value must be { type, value }');
  if (x.type !== kind) throw new Error(`Keyframe value must be of type ${kind}`);
  if (kind === 'FLOAT') {
    if (typeof x.value !== 'number' || !Number.isFinite(x.value)) throw new Error('FLOAT keyframe value must be a finite number');
    return x.value;
  }
  if (kind === 'COLOR') {
    if (!isColor(x.value)) throw new Error('COLOR keyframe value must be { r, g, b, a }');
    const c = x.value as RGBA;
    return { r: c.r, g: c.g, b: c.b, a: typeof c.a === 'number' ? c.a : 1 };
  }
  const p = x.value as Json;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') throw new Error('VECTOR keyframe value must be { x, y }');
  return { x: p.x, y: p.y };
}

interface InKey {
  id?: string;
  t: number;
  value: unknown;
  easing?: Easing;
}

/** Figma keys (curve leads to the key) → by time, with the curve parsed. */
function keysIn(track: unknown): { id?: string; keys: InKey[] } {
  const tr = track as Json | undefined;
  if (!tr || typeof tr !== 'object' || !Array.isArray(tr.keyframes)) throw new Error('Track must be { keyframes: [...] }');
  const keys = (tr.keyframes as Json[]).map((k) => {
    if (typeof k.timelinePosition !== 'number' || !(k.timelinePosition >= 0)) throw new Error('timelinePosition must be a number of seconds >= 0');
    return { id: typeof k.id === 'string' ? k.id : undefined, t: k.timelinePosition, value: k.value, easing: easingIn(k.easing) };
  });
  keys.sort((a, b) => a.t - b.t);
  return { id: typeof tr.id === 'string' ? tr.id : undefined, keys };
}

/** Document keys: the curve of key i (the transition TO it in Figma) goes on key i − 1 (the transition FROM it). */
function toDocKeys(keys: InKey[], value: (v: unknown) => number | RGBA): Keyframe[] {
  return keys.map((k, i) => {
    const next = keys[i + 1];
    return { t: Math.round(k.t * 1000) / 1000, value: value(k.value), id: k.id ?? newId('kf'), ...(next?.easing ? { easing: next.easing } : {}) };
  });
}

/** Document keys → Figma: value out(v), curve from the previous key. */
function toFigmaKeys(keys: Keyframe[], out: (v: number | RGBA) => Json): Json[] {
  return keys.map((k, i) => {
    const e = easingOut(keys[i - 1]?.easing);
    return { id: k.id ?? `kf:${i}`, timelinePosition: k.t, value: out(k.value), ...(e ? { easing: e } : {}) };
  });
}

const float = (v: number | RGBA): Json => ({ type: 'FLOAT', value: typeof v === 'number' ? v : 0 });
const color = (v: number | RGBA): Json => ({ type: 'COLOR', value: typeof v === 'object' ? { ...v } : { r: 0, g: 0, b: 0, a: 1 } });

/** The layer can be animated: it is inside a top-level frame (which has the timeline). */
function assertAnimatable(doc: Document, id: string) {
  if (!animationRoot(doc, id)) throw new Error('Node is not inside a top-level frame: it has no timeline');
}

/** Document tracks after writing: props properties replaced with new tracks. */
function replaceTracks(doc: Document, id: string, props: AnimProperty[], add: AnimTrack[]) {
  const rest = (doc.get(id, 'animation') ?? []).filter((tr) => !props.includes(tr.property));
  const next = [...rest, ...add.filter((tr) => tr.keys.length)];
  doc.set(id, { animation: next.length ? next : undefined });
}

/** Track of PROPERTY field (name) from Figma keys. */
function propertyTracks(doc: Document, id: string, name: string, track: unknown): { props: AnimProperty[]; tracks: AnimTrack[] } {
  const { id: tid, keys } = keysIn(track);
  const trackId = tid ?? newId('track');
  if (name === 'TRANSLATION_XY' || name === 'SCALE_XY') {
    const vectors = keys.some((k) => (k.value as Json | undefined)?.type === 'VECTOR');
    if (name === 'SCALE_XY' && !vectors) {
      return { props: ['scale', 'scaleX', 'scaleY'], tracks: [{ property: 'scale', id: trackId, base: 1, keys: toDocKeys(keys, (v) => valueIn(v, 'FLOAT') as number) }] };
    }
    const [px, py] = name === 'TRANSLATION_XY' ? (['x', 'y'] as const) : (['scaleX', 'scaleY'] as const);
    const bx = name === 'TRANSLATION_XY' ? (baseValue(doc, id, 'x') as number) : 1;
    const by = name === 'TRANSLATION_XY' ? (baseValue(doc, id, 'y') as number) : 1;
    const vec = (v: unknown) => valueIn(v, 'VECTOR') as { x: number; y: number };
    const off = name === 'TRANSLATION_XY';
    return {
      props: name === 'SCALE_XY' ? ['scale', 'scaleX', 'scaleY'] : [px, py],
      tracks: [
        { property: px, id: trackId, base: bx, keys: toDocKeys(keys, (v) => (off ? bx + vec(v).x : vec(v).x)) },
        { property: py, id: trackId, base: by, keys: toDocKeys(keys, (v) => (off ? by + vec(v).y : vec(v).y)) },
      ],
    };
  }
  const f = FIELDS[name];
  if (!f) throw new Error(`Animatable field "${name}" is not supported`);
  if ((name === 'WIDTH' || name === 'HEIGHT') && ['GROUP', 'VECTOR', 'BOOLEAN_OPERATION'].includes(doc.type(id) ?? '')) throw new Error(`${name} cannot be animated on groups and vector shapes`);
  const existing = (doc.get(id, 'animation') ?? []).find((tr) => tr.property === f.prop);
  const base = f.op === 'OFFSET' ? (existing?.base ?? (baseValue(doc, id, f.prop) as number)) : f.op === 'SCALE' ? 1 : undefined;
  const keysDoc = toDocKeys(keys, (v) => {
    const n = valueIn(v, 'FLOAT') as number;
    if ((name === 'WIDTH' || name === 'HEIGHT') && !(n > 0)) throw new Error(`${name} must be positive`);
    return f.op === 'OFFSET' ? base! + n : n;
  });
  return { props: f.prop === 'scaleX' || f.prop === 'scaleY' ? [f.prop] : [f.prop], tracks: [{ property: f.prop, id: trackId, ...(base !== undefined ? { base } : {}), keys: keysDoc }] };
}

/** Color property of paint index: fill.N / stroke.N (the first solid one without a number is it too). */
function paintProps(doc: Document, id: string, kind: 'fill' | 'stroke', index: number): AnimProperty[] {
  const list = doc.get(id, kind === 'fill' ? 'fills' : 'strokes') ?? [];
  const first = list.findIndex((p) => p.type === 'SOLID');
  return first === index ? [`${kind}.${index}`, kind] : [`${kind}.${index}`];
}

function paintTrack(doc: Document, id: string, kind: 'fill' | 'stroke', index: number, track: unknown): { props: AnimProperty[]; tracks: AnimTrack[] } {
  const list = doc.get(id, kind === 'fill' ? 'fills' : 'strokes') ?? [];
  if (!list[index]) throw new Error(`${kind === 'fill' ? 'fills' : 'strokes'}[${index}] does not exist`);
  if (list[index]!.type !== 'SOLID') throw new Error(`Only SOLID paints can be animated (${kind === 'fill' ? 'fills' : 'strokes'}[${index}] is ${list[index]!.type})`);
  const { id: tid, keys } = keysIn(track);
  return { props: paintProps(doc, id, kind, index), tracks: [{ property: `${kind}.${index}`, id: tid ?? newId('track'), keys: toDocKeys(keys, (v) => valueIn(v, 'COLOR') as RGBA) }] };
}

function effectTrack(doc: Document, id: string, index: number, field: string, track: unknown): { props: AnimProperty[]; tracks: AnimTrack[] } {
  const own = EFFECT_IN[field];
  if (!own) throw new Error(`Effect field "${field}" is not supported`);
  if (!(doc.get(id, 'effects') ?? [])[index]) throw new Error(`effects[${index}] does not exist`);
  const kind = own === 'COLOR' || own === 'SECONDARY_COLOR' ? 'COLOR' : 'FLOAT';
  const { id: tid, keys } = keysIn(track);
  const prop: AnimProperty = `effect.${index}.${own}`;
  return { props: [prop], tracks: [{ property: prop, id: tid ?? newId('track'), keys: toDocKeys(keys, (v) => valueIn(v, kind) as number | RGBA) }] };
}

/** Apply/remove field: { type: 'PROPERTY', name } or { type: 'INDEXED_ITEM', collection, index, field? }. */
function fieldTracks(doc: Document, id: string, field: unknown, track: unknown) {
  const f = field as Json;
  if (f?.type === 'PROPERTY') return propertyTracks(doc, id, String(f.name), track);
  if (f?.type === 'INDEXED_ITEM') {
    const index = Number(f.index);
    if (!Number.isInteger(index) || index < 0) throw new Error('INDEXED_ITEM index must be a non-negative integer');
    if (f.collection === 'fills' || f.collection === 'strokes') return paintTrack(doc, id, f.collection === 'fills' ? 'fill' : 'stroke', index, track);
    if (f.collection === 'effects') return effectTrack(doc, id, index, String(f.field), track);
  }
  throw new Error('Keyframe field must be { type: "PROPERTY", name } or { type: "INDEXED_ITEM", collection, index, field? }');
}

/** Properties of the track the field removes. */
function fieldProps(doc: Document, id: string, field: unknown): AnimProperty[] {
  const f = field as Json;
  if (f?.type === 'PROPERTY') {
    const name = String(f.name);
    if (name === 'TRANSLATION_XY') return ['x', 'y'];
    if (name === 'SCALE_XY') return ['scale', 'scaleX', 'scaleY'];
    const p = FIELDS[name]?.prop;
    if (!p) throw new Error(`Animatable field "${name}" is not supported`);
    return [p];
  }
  if (f?.type === 'INDEXED_ITEM') {
    const index = Number(f.index);
    if (f.collection === 'fills' || f.collection === 'strokes') return paintProps(doc, id, f.collection === 'fills' ? 'fill' : 'stroke', index);
    const own = f.collection === 'effects' ? EFFECT_IN[String(f.field)] : undefined;
    if (own) return [`effect.${index}.${own}`];
  }
  throw new Error('Keyframe field must be { type: "PROPERTY", name } or { type: "INDEXED_ITEM", collection, index, field? }');
}

/** The layer's manualKeyframeTracks in Figma form. */
export function readTracks(doc: Document, id: string): Json {
  const tracks = doc.get(id, 'animation') ?? [];
  const out: Json = {};
  const fills: Json = {};
  const strokes: Json = {};
  const effects: Record<string, Json> = {};
  const used = new Set<AnimTrack>();
  // X/Y pairs with the same id and the same moments become a vector track (as recorded).
  for (const [px, py, name] of [['x', 'y', 'TRANSLATION_XY'], ['scaleX', 'scaleY', 'SCALE_XY']] as const) {
    const a = tracks.find((tr) => tr.property === px);
    const b = tracks.find((tr) => tr.property === py);
    if (!a?.id || a.id !== b?.id || a.keys.length !== b.keys.length || a.keys.some((k, i) => Math.abs(k.t - b.keys[i]!.t) > 1e-6)) continue;
    const off = name === 'TRANSLATION_XY';
    const bx = a.base ?? (off ? (baseValue(doc, id, px) as number) : 1);
    const by = b.base ?? (off ? (baseValue(doc, id, py) as number) : 1);
    out[name] = {
      id: a.id,
      keyframeOperation: off ? 'OFFSET' : 'SCALE',
      baseValue: { type: 'VECTOR', value: { x: off ? bx : 1, y: off ? by : 1 } },
      keyframes: toFigmaKeys(a.keys, () => ({})).map((k, i) => ({ ...k, value: { type: 'VECTOR', value: { x: off ? (a.keys[i]!.value as number) - bx : (a.keys[i]!.value as number), y: off ? (b.keys[i]!.value as number) - by : (b.keys[i]!.value as number) } } })),
    };
    used.add(a).add(b);
  }
  for (const tr of tracks) {
    if (used.has(tr) || !tr.keys.length) continue;
    const ix = indexedProperty(tr.property);
    if (tr.property === 'fill' || tr.property === 'stroke' || (ix && ix.kind !== 'effect')) {
      const kind = ix && ix.kind !== 'effect' ? ix.kind : (tr.property as 'fill' | 'stroke');
      const list = doc.get(id, kind === 'fill' ? 'fills' : 'strokes') ?? [];
      const index = ix && ix.kind !== 'effect' ? ix.index : list.findIndex((p) => p.type === 'SOLID');
      if (index < 0) continue;
      (kind === 'fill' ? fills : strokes)[index] = { id: tr.id ?? `track:${tr.property}`, keyframeOperation: 'SET', keyframes: toFigmaKeys(tr.keys, color) };
      continue;
    }
    if (ix?.kind === 'effect') {
      const v = typeof tr.keys[0]!.value === 'object' ? color : float;
      (effects[ix.index] ??= {})[EFFECT_OUT[ix.field]] = { id: tr.id ?? `track:${tr.property}`, keyframeOperation: 'SET', keyframes: toFigmaKeys(tr.keys, v) };
      continue;
    }
    if (tr.property === 'scale') {
      out.SCALE_XY = { id: tr.id ?? 'track:scale', keyframeOperation: 'SCALE', baseValue: float(1), keyframes: toFigmaKeys(tr.keys, float) };
      continue;
    }
    const name = FIELD_OF.get(tr.property);
    // 3D rotation is hidden from plugins (these fields are closed).
    if (!name) continue;
    const op = FIELDS[name]!.op;
    const base = op === 'OFFSET' ? (tr.base ?? (baseValue(doc, id, tr.property) as number)) : op === 'SCALE' ? 1 : undefined;
    out[name] = {
      id: tr.id ?? `track:${tr.property}`,
      keyframeOperation: op,
      ...(base !== undefined ? { baseValue: float(base) } : {}),
      keyframes: toFigmaKeys(tr.keys, (v) => float(op === 'OFFSET' ? (v as number) - base! : (v as number))),
    };
  }
  if (Object.keys(fills).length) out.fills = fills;
  if (Object.keys(strokes).length) out.strokes = strokes;
  if (Object.keys(effects).length) out.effects = effects;
  return out;
}

/** Writing manualKeyframeTracks as a whole (3D tracks remain). */
export function writeTracks(doc: Document, id: string, value: unknown) {
  assertAnimatable(doc, id);
  const v = (value ?? {}) as Json;
  if (typeof v !== 'object') throw new Error('manualKeyframeTracks must be an object');
  const add: AnimTrack[] = [];
  for (const [name, track] of Object.entries(v)) {
    if (track === undefined) continue;
    if (name === 'fills' || name === 'strokes') {
      for (const [i, tr] of Object.entries(track as Json)) add.push(...paintTrack(doc, id, name === 'fills' ? 'fill' : 'stroke', Number(i), tr).tracks);
    } else if (name === 'effects') {
      for (const [i, fields] of Object.entries(track as Json)) for (const [field, tr] of Object.entries(fields as Json)) add.push(...effectTrack(doc, id, Number(i), field, tr).tracks);
    } else add.push(...propertyTracks(doc, id, name, track).tracks);
  }
  const keep = (doc.get(id, 'animation') ?? []).filter((tr) => tr.property === 'rotateX' || tr.property === 'rotateY');
  const next = [...keep, ...add.filter((tr) => tr.keys.length)];
  doc.set(id, { animation: next.length ? next : undefined });
}

// ---------- Motion styles ----------

interface StyleDef {
  styleId: string;
  name: string;
  description: string;
  props: Record<string, string>;
  duration: number;
  /** Style keys: property, value at the start and at the end (relative to the layer pose at the style start). */
  tracks(doc: Document, id: string, t: number, props: Json): { property: AnimProperty; from: number; to: number }[];
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const timing = (props: Json) => (props.timing === 'out' ? 'out' : 'in');

/** “Appear” and “disappear” values: in — from offset to pose, out — from pose to offset. */
const io = (props: Json, rest: number, shifted: number) => (timing(props) === 'in' ? { from: shifted, to: rest } : { from: rest, to: shifted });

const FADE = (doc: Document, id: string, t: number, props: Json) =>
  props.fade === false ? [] : [{ property: 'opacity' as const, ...io(props, animatedValue(doc, id, 'opacity', t) as number, 0) }];

export const STYLE_DEFS: StyleDef[] = [
  {
    styleId: 'Opacity',
    name: 'Fade',
    description: 'Появление или исчезновение (непрозрачность)',
    props: { timing: '"in" | "out" // default: "in"', easing: 'easing // default: { type: "EASE_OUT" }', duration: 'number // seconds' },
    duration: 0.4,
    tracks: (doc, id, t, props) => [{ property: 'opacity', ...io(props, animatedValue(doc, id, 'opacity', t) as number, 0) }],
  },
  {
    styleId: 'Move',
    name: 'Move',
    description: 'Въезд или уход со сдвигом (и появлением)',
    props: { timing: '"in" | "out" // default: "in"', moveX: 'number // px, default: 0', moveY: 'number // px, default: 24', fade: 'boolean // default: true', easing: 'easing // default: { type: "EASE_OUT" }' },
    duration: 0.5,
    tracks: (doc, id, t, props) => {
      const x = animatedValue(doc, id, 'x', t) as number;
      const y = animatedValue(doc, id, 'y', t) as number;
      const dx = num(props.moveX, 0);
      const dy = num(props.moveY, props.moveX === undefined ? 24 : 0);
      return [...(dx ? [{ property: 'x' as const, ...io(props, x, x + dx) }] : []), ...(dy ? [{ property: 'y' as const, ...io(props, y, y + dy) }] : []), ...FADE(doc, id, t, props)];
    },
  },
  {
    styleId: 'Scale',
    name: 'Scale',
    description: 'Рост или уменьшение вокруг центра (и появление)',
    props: { timing: '"in" | "out" // default: "in"', scale: 'number // multiplier, default: 0.8', fade: 'boolean // default: true', easing: 'easing // default: { type: "EASE_OUT" }' },
    duration: 0.45,
    tracks: (doc, id, t, props) => [{ property: 'scale', ...io(props, animatedValue(doc, id, 'scale', t) as number, num(props.scale, 0.8)) }, ...FADE(doc, id, t, props)],
  },
  {
    styleId: 'Rotate',
    name: 'Rotate',
    description: 'Поворот вокруг центра (и появление)',
    props: { timing: '"in" | "out" // default: "in"', rotation: 'number // degrees, default: -90', fade: 'boolean // default: true', easing: 'easing // default: { type: "EASE_OUT" }' },
    duration: 0.5,
    tracks: (doc, id, t, props) => {
      const r = animatedValue(doc, id, 'rotation', t) as number;
      return [{ property: 'rotation', ...io(props, r, r + num(props.rotation, -90)) }, ...FADE(doc, id, t, props)];
    },
  },
  {
    styleId: 'Path',
    name: 'Path',
    description: 'Обводка рисуется по контуру (in) или стирается (out) — обрезка контура',
    props: { timing: '"in" | "out" // default: "in"', easing: 'easing // default: { type: "EASE_IN_AND_OUT" }' },
    duration: 0.8,
    tracks: (_doc, _id, _t, props) => (timing(props) === 'in' ? [{ property: 'trimEnd', from: 0, to: 1 }] : [{ property: 'trimStart', from: 0, to: 1 }]),
  },
];

const defOf = (styleId: string) => STYLE_DEFS.find((d) => d.styleId === styleId);

/** figma.motion.figmaAnimationStyles(). */
export function figmaAnimationStyles(): Json[] {
  return STYLE_DEFS.map((d) => ({ styleId: d.styleId, name: d.name, description: d.description, props: { ...d.props } }));
}

/** Style keys go into layer tracks; the application record goes into animationStyles. Returns the application id. */
export function applyStyle(doc: Document, id: string, styleId: string, data: unknown, bindingId?: string): string {
  assertAnimatable(doc, id);
  const d = (data ?? {}) as Json;
  if (d.type === 'CUSTOM') throw new Error('Custom animation styles are not available');
  const def = defOf(styleId);
  if (!def) throw new Error(`Animation style "${styleId}" not found (see figma.motion.figmaAnimationStyles())`);
  const props = { ...((d.props as Json) ?? {}) };
  const duration = num(props.duration, num(d.duration, def.duration));
  if (!(duration > 0)) throw new Error('duration must be > 0 seconds');
  const offset = Math.max(0, num(d.timelineOffset, 0));
  const easing = easingIn(props.easing) ?? (def.styleId === 'Path' ? { type: 'EASE_IN_AND_OUT' as const } : { type: 'EASE_OUT' as const });
  let tracks = doc.get(id, 'animation') ?? [];
  const list = def.tracks(doc, id, offset, props);
  for (const k of list) {
    tracks = withKey(tracks, k.property, offset, k.from, easing);
    tracks = withKey(tracks, k.property, offset + duration, k.to);
  }
  const binding: AppliedMotionStyle = { id: bindingId ?? newId('anim'), styleId, name: typeof d.name === 'string' && d.name ? d.name : def.name, duration, timelineOffset: offset, ...(Object.keys(props).length ? { props } : {}), properties: list.map((k) => k.property) };
  doc.set(id, { animation: tracks, animationStyles: [...(doc.get(id, 'animationStyles') ?? []).filter((b) => b.id !== binding.id), binding] });
  return binding.id;
}

/** Remove an application: its keys (within its time range) and the record. */
export function removeStyle(doc: Document, id: string, bindingId: string) {
  const list = doc.get(id, 'animationStyles') ?? [];
  const b = list.find((x) => x.id === bindingId);
  if (!b) throw new Error(`Animation style application "${bindingId}" not found on this node`);
  const t0 = b.timelineOffset - 1e-3;
  const t1 = b.timelineOffset + b.duration + 1e-3;
  const tracks = (doc.get(id, 'animation') ?? [])
    .map((tr) => (b.properties.includes(tr.property) ? { ...tr, keys: tr.keys.filter((k) => k.t < t0 || k.t > t1) } : tr))
    .filter((tr) => tr.keys.length);
  const rest = list.filter((x) => x.id !== bindingId);
  doc.set(id, { animation: tracks.length ? tracks : undefined, animationStyles: rest.length ? rest : undefined });
}

/** animationStyles in Figma form. */
export function readStyles(doc: Document, id: string): Json[] {
  return (doc.get(id, 'animationStyles') ?? []).map((b) => ({ type: 'FIGMA', id: b.id, styleId: b.styleId, name: b.name, duration: b.duration, timelineOffset: b.timelineOffset, props: { ...(b.props ?? {}) } }));
}

/** Writing animationStyles as a whole: not in the list — remove, no id — apply, changed — reapply. */
export function writeStyles(doc: Document, id: string, value: unknown) {
  if (!Array.isArray(value)) throw new Error('animationStyles must be an array');
  const cur = doc.get(id, 'animationStyles') ?? [];
  const want = value as Json[];
  const keepIds = new Set(want.map((w) => w.id).filter((x): x is string => typeof x === 'string'));
  for (const b of cur) if (!keepIds.has(b.id)) removeStyle(doc, id, b.id);
  for (const w of want) {
    const old = typeof w.id === 'string' ? (doc.get(id, 'animationStyles') ?? []).find((b) => b.id === w.id) : undefined;
    const same = old && old.styleId === w.styleId && old.duration === num(w.duration, old.duration) && old.timelineOffset === num(w.timelineOffset, old.timelineOffset) && JSON.stringify(old.props ?? {}) === JSON.stringify(w.props ?? old.props ?? {});
    if (same) continue;
    if (old) removeStyle(doc, id, old.id);
    applyStyle(doc, id, String(w.styleId), w, old?.id);
  }
}

// ---------- Node: properties and methods ----------

export const MOTION_NOT = Symbol('not motion');

export function motionGet(doc: Document, id: string, prop: string): unknown {
  switch (prop) {
    case 'manualKeyframeTracks':
    case 'animations':
      return readTracks(doc, id);
    case 'animationStyles':
      return readStyles(doc, id);
    case 'timelines': {
      const root = animationRoot(doc, id);
      return root ? [{ id: root, duration: timelineDuration(doc, root) }] : [];
    }
    default:
      return MOTION_NOT;
  }
}

export function motionSet(doc: Document, id: string, prop: string, value: unknown): boolean {
  switch (prop) {
    case 'manualKeyframeTracks':
      writeTracks(doc, id, value);
      return true;
    case 'animationStyles':
      writeStyles(doc, id, value);
      return true;
    case 'animations':
    case 'timelines':
      throw new Error(`${prop} is read-only`);
    default:
      return false;
  }
}

export function motionMethod(doc: Document, id: string, name: string, args: unknown[]): unknown {
  switch (name) {
    case 'applyManualKeyframeTrack': {
      assertAnimatable(doc, id);
      const { props, tracks } = fieldTracks(doc, id, args[0], args[1]);
      replaceTracks(doc, id, props, tracks);
      return undefined;
    }
    case 'removeManualKeyframeTrack':
      replaceTracks(doc, id, fieldProps(doc, id, args[0]), []);
      return undefined;
    case 'applyAnimationStyle':
      return applyStyle(doc, id, String(args[0]), args[1]);
    case 'removeAnimationStyle':
      removeStyle(doc, id, String(args[0]));
      return undefined;
    case 'setTimelineDuration': {
      const root = animationRoot(doc, id);
      if (!root || String(args[0]) !== root) throw new Error('Timeline id does not match this node\'s timeline (see node.timelines)');
      const d = Number(args[1]);
      if (!(d > 0) || !Number.isFinite(d)) throw new Error('Timeline duration must be a positive number of seconds');
      doc.set(root, { timeline: { ...(doc.get(root, 'timeline') ?? {}), duration: d } });
      return undefined;
    }
    default:
      return MOTION_NOT;
  }
}
