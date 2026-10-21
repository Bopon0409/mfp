// Animation: a top-level frame has a timeline (duration, repeat,
// autoplay), layers inside it have property tracks with keyframes. The value between keyframes follows
// the left keyframe's curve (the same curves and springs as prototype transitions, plus HOLD); before the first
// and after the last keyframe it equals theirs. Position (x, y) is the top-left corner of the unrotated box;
// rotation and scale are around the center. Regular layer properties are the pose at time zero.
//
// Properties: position, rotation, scale (uniform and per axis), size,
// opacity, corner radii (uniform and per corner), stroke weights (uniform and per side), layout padding and
// gaps, path trimming; fill and stroke colors (fill / stroke — the first solid one,
// fill.N / stroke.N — the paint with index N) and effect fields (effect.N.FIELD). Our own: the 3D model's view
// angle and clip frame (model* — the layer's first MODEL3D fill; clip frame by keyframes — the clip follows the timeline).

import type { Document } from './document.ts';
import { rotationOf } from './geometry.ts';
import { easingFunction } from './prototype.ts';
import type { Effect, Easing, Matrix, Paint, Props, RGBA } from './types.ts';

/** Effect fields that can be animated. */
export type EffectField =
  | 'OFFSET_X'
  | 'OFFSET_Y'
  | 'RADIUS'
  | 'SPREAD'
  | 'COLOR'
  | 'START_RADIUS'
  | 'NOISE_SIZE'
  | 'DENSITY'
  | 'EFFECT_OPACITY'
  | 'SECONDARY_COLOR'
  | 'REFRACTION_RADIUS'
  | 'REFRACTION_INTENSITY'
  | 'SPECULAR_ANGLE'
  | 'SPECULAR_INTENSITY'
  | 'CHROMATIC_ABERRATION';

export const EFFECT_FIELDS: readonly EffectField[] = ['OFFSET_X', 'OFFSET_Y', 'RADIUS', 'SPREAD', 'COLOR', 'START_RADIUS', 'NOISE_SIZE', 'DENSITY', 'EFFECT_OPACITY', 'SECONDARY_COLOR', 'REFRACTION_RADIUS', 'REFRACTION_INTENSITY', 'SPECULAR_ANGLE', 'SPECULAR_INTENSITY', 'CHROMATIC_ABERRATION'];

/** Properties without an index (order as in the timeline's property list). */
export type BaseAnimProperty =
  | 'x'
  | 'y'
  | 'rotation'
  | 'scale'
  | 'scaleX'
  | 'scaleY'
  | 'opacity'
  | 'width'
  | 'height'
  | 'fill'
  | 'stroke'
  | 'strokeWeight'
  | 'cornerRadius'
  | 'topLeftRadius'
  | 'topRightRadius'
  | 'bottomRightRadius'
  | 'bottomLeftRadius'
  | 'trimStart'
  | 'trimEnd'
  | 'itemSpacing'
  | 'counterAxisSpacing'
  | 'paddingLeft'
  | 'paddingTop'
  | 'paddingRight'
  | 'paddingBottom'
  | 'gridRowGap'
  | 'gridColumnGap'
  | 'strokeTopWeight'
  | 'strokeRightWeight'
  | 'strokeBottomWeight'
  | 'strokeLeftWeight'
  | 'rotateX'
  | 'rotateY'
  | 'modelYaw'
  | 'modelPitch'
  | 'modelZoom'
  | 'modelTime';

export type AnimProperty = BaseAnimProperty | `fill.${number}` | `stroke.${number}` | `effect.${number}.${EffectField}`;

export const ANIM_PROPERTIES: readonly BaseAnimProperty[] = [
  'x',
  'y',
  'rotation',
  'scale',
  'scaleX',
  'scaleY',
  'opacity',
  'width',
  'height',
  'fill',
  'stroke',
  'strokeWeight',
  'cornerRadius',
  'topLeftRadius',
  'topRightRadius',
  'bottomRightRadius',
  'bottomLeftRadius',
  'trimStart',
  'trimEnd',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'gridRowGap',
  'gridColumnGap',
  'strokeTopWeight',
  'strokeRightWeight',
  'strokeBottomWeight',
  'strokeLeftWeight',
  'rotateX',
  'rotateY',
  'modelYaw',
  'modelPitch',
  'modelZoom',
  'modelTime',
];

/** 3D model properties: a view-angle field of the MODEL3D fill or the clip frame (pose). */
const MODEL_PROPS: Partial<Record<BaseAnimProperty, 'yaw' | 'pitch' | 'zoom' | 'pose'>> = { modelYaw: 'yaw', modelPitch: 'pitch', modelZoom: 'zoom', modelTime: 'pose' };
const DEFAULT_CAMERA = { yaw: 30, pitch: 15, zoom: 1 };

/** Indexed property: a paint (fill.N, stroke.N) or an effect field (effect.N.FIELD); otherwise null. */
export function indexedProperty(p: AnimProperty): { kind: 'fill' | 'stroke'; index: number } | { kind: 'effect'; index: number; field: EffectField } | null {
  const m = /^(fill|stroke)\.(\d+)$/.exec(p);
  if (m) return { kind: m[1] as 'fill' | 'stroke', index: Number(m[2]) };
  const e = /^effect\.(\d+)\.([A-Z_]+)$/.exec(p);
  if (e && (EFFECT_FIELDS as readonly string[]).includes(e[2]!)) return { kind: 'effect', index: Number(e[1]), field: e[2] as EffectField };
  return null;
}

/** The string is a known animation property. */
export function isAnimProperty(p: string): p is AnimProperty {
  return (ANIM_PROPERTIES as readonly string[]).includes(p) || indexedProperty(p as AnimProperty) !== null;
}

/** Keyframe: time (seconds), value (number or color) and the curve up to the next keyframe. */
export interface Keyframe {
  t: number;
  value: number | RGBA;
  easing?: Easing;
  /** Keyframe id (plugin API: manualKeyframeTracks preserves keyframe ids). */
  id?: string;
}

export interface AnimTrack {
  property: AnimProperty;
  keys: Keyframe[];
  /** Track id and the base value (baseValue) — for the plugin API (TRANSLATION_X… are relative to it). */
  id?: string;
  base?: number;
}

/**
 * A motion style applied to a layer: the keyframes are already in the layer's
 * tracks (properties — which ones); this records what was applied, from when and for how long.
 */
export interface AppliedMotionStyle {
  id: string;
  styleId: string;
  name: string;
  duration: number;
  timelineOffset: number;
  props?: Record<string, unknown>;
  properties: AnimProperty[];
}

/** Timeline repeat (Motion): once, loop, ping-pong. */
export type TimelinePlayback = 'ONCE' | 'LOOP' | 'PING_PONG';

/** Frame timeline: duration (seconds), repeat, start when the screen is shown. */
export interface Timeline {
  duration: number;
  /** Repeat; if absent — by loop (old files): looping or once. */
  playback?: TimelinePlayback;
  loop?: boolean;
  autoplay?: boolean;
}

/** Timeline repeat. */
export function timelinePlayback(tl: Timeline | undefined): TimelinePlayback {
  return tl?.playback ?? (tl?.loop ? 'LOOP' : 'ONCE');
}

/** Timeline with playback repeat (loop — for old versions: loop and ping-pong both repeat). */
export function withPlayback(tl: Timeline, playback: TimelinePlayback): Timeline {
  return { ...tl, playback, loop: playback !== 'ONCE' };
}

/**
 * Timeline time for duration, t seconds after the start: loop — from the beginning again,
 * ping-pong — backward and forward again, once — stop at the end (the end itself is the last pose).
 */
export function timelineTime(playback: TimelinePlayback, duration: number, t: number): number {
  if (!(duration > 0)) return 0;
  if (t <= duration || playback === 'ONCE') return Math.max(0, Math.min(duration, t));
  if (playback === 'LOOP') return t % duration;
  const phase = t % (2 * duration);
  return phase <= duration ? phase : 2 * duration - phase;
}

/** Default curve between keyframes (Motion — ease in and out). */
export const DEFAULT_KEY_EASING: Easing = { type: 'EASE_IN_AND_OUT' };

/** The time coincides with a keyframe (precision: one frame at 240 fps). */
const SAME_TIME = 1 / 240;

const isColor = (v: number | RGBA): v is RGBA => typeof v === 'object';

/** Track value at time t. */
export function valueAt(track: AnimTrack, t: number): number | RGBA | undefined {
  const keys = track.keys;
  if (!keys.length) return undefined;
  if (t <= keys[0]!.t) return keys[0]!.value;
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return last.value;
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1]!.t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  // Hold: the keyframe value until the next one, then jump straight to the next.
  if (a.easing?.type === 'HOLD') return a.value;
  const span = Math.max(1e-9, b.t - a.t);
  const k = easingFunction(a.easing ?? DEFAULT_KEY_EASING, span)((t - a.t) / span);
  if (isColor(a.value) && isColor(b.value)) {
    const c0 = a.value;
    const c1 = b.value;
    const mix = (x: number, y: number) => Math.max(0, Math.min(1, x + (y - x) * k));
    return { r: mix(c0.r, c1.r), g: mix(c0.g, c1.g), b: mix(c0.b, c1.b), a: mix(c0.a, c1.a) };
  }
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value - a.value) * k;
  return a.value;
}

/** The top-level frame (on the page) containing the layer owns the timeline; null — none. */
export function animationRoot(doc: Document, id: string): string | null {
  let cur: string | null = id;
  while (cur) {
    const parent = doc.parent(cur);
    if (!parent) return null;
    if (doc.type(parent) === 'PAGE') return doc.type(cur) === 'FRAME' || doc.type(cur) === 'COMPONENT' || doc.type(cur) === 'INSTANCE' ? cur : null;
    cur = parent;
  }
  return null;
}

/** Layers of the frame (and the frame itself) with tracks or text animation. */
export function animatedNodes(doc: Document, root: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    if (doc.get(id, 'animation')?.length || doc.get(id, 'textAnimation')) out.push(id);
    for (const c of doc.children(id)) walk(c);
  };
  walk(root);
  return out;
}

/** Timeline duration: the set one or up to the last keyframe (at least one second). */
export function timelineDuration(doc: Document, root: string): number {
  const own = doc.get(root, 'timeline')?.duration;
  if (own && own > 0) return own;
  let end = 0;
  for (const id of animatedNodes(doc, root)) {
    for (const tr of doc.get(id, 'animation') ?? []) end = Math.max(end, tr.keys[tr.keys.length - 1]?.t ?? 0);
    const ta = doc.get(id, 'textAnimation');
    if (ta) end = Math.max(end, textAnimationEnd(ta, doc.get(id, 'characters') ?? ''));
  }
  return Math.max(1, end);
}

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };
const paintColor = (f: Paint | undefined): RGBA | null => (f?.type === 'SOLID' ? { r: f.color.r, g: f.color.g, b: f.color.b, a: f.opacity ?? 1 } : null);

/** Numeric properties written directly into a layer property: name, default, limits. */
const PLAIN: Partial<Record<BaseAnimProperty, { key: keyof Props; base: (p: Props) => number; min?: number; max?: number }>> = {
  strokeWeight: { key: 'strokeWeight', base: (p) => p.strokeWeight ?? 1, min: 0 },
  topLeftRadius: { key: 'topLeftRadius', base: (p) => p.topLeftRadius ?? p.cornerRadius ?? 0, min: 0 },
  topRightRadius: { key: 'topRightRadius', base: (p) => p.topRightRadius ?? p.cornerRadius ?? 0, min: 0 },
  bottomRightRadius: { key: 'bottomRightRadius', base: (p) => p.bottomRightRadius ?? p.cornerRadius ?? 0, min: 0 },
  bottomLeftRadius: { key: 'bottomLeftRadius', base: (p) => p.bottomLeftRadius ?? p.cornerRadius ?? 0, min: 0 },
  trimStart: { key: 'pathTrimStart', base: (p) => p.pathTrimStart ?? 0, min: 0, max: 1 },
  trimEnd: { key: 'pathTrimEnd', base: (p) => p.pathTrimEnd ?? 1, min: 0, max: 1 },
  itemSpacing: { key: 'itemSpacing', base: (p) => p.itemSpacing ?? 0 },
  counterAxisSpacing: { key: 'counterAxisSpacing', base: (p) => p.counterAxisSpacing ?? p.itemSpacing ?? 0 },
  paddingLeft: { key: 'paddingLeft', base: (p) => p.paddingLeft ?? 0 },
  paddingTop: { key: 'paddingTop', base: (p) => p.paddingTop ?? 0 },
  paddingRight: { key: 'paddingRight', base: (p) => p.paddingRight ?? 0 },
  paddingBottom: { key: 'paddingBottom', base: (p) => p.paddingBottom ?? 0 },
  gridRowGap: { key: 'gridRowGap', base: (p) => p.gridRowGap ?? 0, min: 0 },
  gridColumnGap: { key: 'gridColumnGap', base: (p) => p.gridColumnGap ?? 0, min: 0 },
  strokeTopWeight: { key: 'strokeTopWeight', base: (p) => p.strokeTopWeight ?? p.strokeWeight ?? 1, min: 0 },
  strokeRightWeight: { key: 'strokeRightWeight', base: (p) => p.strokeRightWeight ?? p.strokeWeight ?? 1, min: 0 },
  strokeBottomWeight: { key: 'strokeBottomWeight', base: (p) => p.strokeBottomWeight ?? p.strokeWeight ?? 1, min: 0 },
  strokeLeftWeight: { key: 'strokeLeftWeight', base: (p) => p.strokeLeftWeight ?? p.strokeWeight ?? 1, min: 0 },
  rotateX: { key: 'rotateX', base: (p) => p.rotateX ?? 0 },
  rotateY: { key: 'rotateY', base: (p) => p.rotateY ?? 0 },
};

/** Effect field value (null — this effect has no such field). */
export function effectField(e: Effect | undefined, field: EffectField): number | RGBA | null {
  if (!e) return null;
  const x = e as unknown as Record<string, unknown>;
  const n = (k: string, d?: number) => (typeof x[k] === 'number' ? (x[k] as number) : d ?? null);
  const c = (k: string) => (x[k] && typeof x[k] === 'object' ? { ...(x[k] as RGBA), a: (x[k] as RGBA).a ?? 1 } : null);
  switch (field) {
    case 'OFFSET_X':
      return (x.offset as { x: number } | undefined)?.x ?? null;
    case 'OFFSET_Y':
      return (x.offset as { y: number } | undefined)?.y ?? null;
    case 'RADIUS':
      return n('radius');
    case 'SPREAD':
      return e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ? n('spread', 0) : null;
    case 'COLOR':
      return c('color');
    case 'SECONDARY_COLOR':
      return c('secondaryColor');
    case 'START_RADIUS':
      return e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR' ? n('startRadius', 0) : null;
    case 'NOISE_SIZE':
      return n('noiseSize');
    case 'DENSITY':
      return n('density');
    case 'EFFECT_OPACITY':
      return e.type === 'NOISE' ? n('opacity', 1) : null;
    case 'REFRACTION_RADIUS':
      return n('depth');
    case 'REFRACTION_INTENSITY':
      return n('refraction');
    case 'SPECULAR_ANGLE':
      return n('lightAngle');
    case 'SPECULAR_INTENSITY':
      return n('lightIntensity');
    case 'CHROMATIC_ABERRATION':
      return n('dispersion');
  }
}

/** The effect with a new field value. */
function withEffectField(e: Effect, field: EffectField, v: number | RGBA): Effect {
  const x = { ...(e as unknown as Record<string, unknown>) };
  const num = typeof v === 'number' ? v : 0;
  const nonNeg = Math.max(0, num);
  switch (field) {
    case 'OFFSET_X':
      x.offset = { ...(x.offset as object), x: num };
      break;
    case 'OFFSET_Y':
      x.offset = { ...(x.offset as object), y: num };
      break;
    case 'RADIUS':
      x.radius = nonNeg;
      break;
    case 'SPREAD':
      x.spread = num;
      break;
    case 'COLOR':
      if (typeof v === 'object') x.color = v;
      break;
    case 'SECONDARY_COLOR':
      if (typeof v === 'object') x.secondaryColor = v;
      break;
    case 'START_RADIUS':
      x.startRadius = nonNeg;
      break;
    case 'NOISE_SIZE':
      x.noiseSize = Math.max(0.01, num);
      break;
    case 'DENSITY':
      x.density = Math.min(1, nonNeg);
      break;
    case 'EFFECT_OPACITY':
      x.opacity = Math.min(1, nonNeg);
      break;
    case 'REFRACTION_RADIUS':
      x.depth = nonNeg;
      break;
    case 'REFRACTION_INTENSITY':
      x.refraction = Math.min(1, nonNeg);
      break;
    case 'SPECULAR_ANGLE':
      x.lightAngle = num;
      break;
    case 'SPECULAR_INTENSITY':
      x.lightIntensity = Math.min(1, nonNeg);
      break;
    case 'CHROMATIC_ABERRATION':
      x.dispersion = Math.min(1, nonNeg);
      break;
  }
  return x as unknown as Effect;
}

/** The regular layer property value (the pose without animation). */
export function baseValue(doc: Document, id: string, property: AnimProperty): number | RGBA {
  const p = doc.props(id);
  const w = p.width ?? 0;
  const h = p.height ?? 0;
  const m = (p.transform ?? [1, 0, 0, 0, 1, 0]) as Matrix;
  const ix = indexedProperty(property);
  if (ix) {
    if (ix.kind === 'effect') {
      const v = effectField((p.effects ?? [])[ix.index], ix.field);
      return v ?? (ix.field === 'COLOR' || ix.field === 'SECONDARY_COLOR' ? BLACK : 0);
    }
    return paintColor((ix.kind === 'fill' ? p.fills : p.strokes)?.[ix.index]) ?? BLACK;
  }
  const plain = PLAIN[property as BaseAnimProperty];
  if (plain) return plain.base(p);
  const mf = MODEL_PROPS[property as BaseAnimProperty];
  if (mf) {
    const m = (p.fills ?? []).find((x) => x.type === 'MODEL3D');
    if (m?.type !== 'MODEL3D') return mf === 'zoom' ? 1 : 0;
    return mf === 'pose' ? (m.pose ?? 0) : (m.camera ?? DEFAULT_CAMERA)[mf];
  }
  switch (property as BaseAnimProperty) {
    case 'x':
      return m[0] * (w / 2) + m[1] * (h / 2) + m[2] - w / 2;
    case 'y':
      return m[3] * (w / 2) + m[4] * (h / 2) + m[5] - h / 2;
    case 'rotation':
      return rotationOf(m);
    case 'scale':
    case 'scaleX':
    case 'scaleY':
      return 1;
    case 'opacity':
      return p.opacity ?? 1;
    case 'width':
      return w;
    case 'height':
      return h;
    case 'cornerRadius':
      return p.cornerRadius ?? 0;
    case 'fill':
      return paintColor((p.fills ?? []).find((x) => x.type === 'SOLID')) ?? BLACK;
    case 'stroke':
      return paintColor((p.strokes ?? []).find((x) => x.type === 'SOLID')) ?? BLACK;
    default:
      return 0;
  }
}

/** Property value at time t: from the track or the regular one. */
export function animatedValue(doc: Document, id: string, property: AnimProperty, t: number): number | RGBA {
  const tr = (doc.get(id, 'animation') ?? []).find((x) => x.property === property);
  return (tr && valueAt(tr, t)) ?? baseValue(doc, id, property);
}

/** Paints with color c on the paint at index (null — the first solid one; no solid one — a new first one). */
function recolor(list: readonly Paint[], index: number | null, c: RGBA): Paint[] {
  const out = [...list];
  const paint: Paint = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  const i = index ?? out.findIndex((f) => f.type === 'SOLID');
  if (i >= 0 && i < out.length) {
    // Only solid paints change color.
    if (out[i]!.type === 'SOLID') out[i] = { ...out[i]!, ...paint } as Paint;
  } else if (index === null) out.unshift(paint);
  return out;
}

/** Layer pose (document properties) at time t; null — the layer has no tracks and no text animation. */
export function animatedProps(doc: Document, id: string, t: number): Props | null {
  const tracks = doc.get(id, 'animation') ?? [];
  const text = doc.get(id, 'textAnimation');
  if (!tracks.length && !text) return null;
  const has = new Set<string>(tracks.map((tr) => tr.property));
  const v = (p: AnimProperty) => animatedValue(doc, id, p, t);
  const out: Props = {};
  if (text) out.textAnimationTime = t;
  if (['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'width', 'height'].some((k) => has.has(k))) {
    const w = v('width') as number;
    const h = v('height') as number;
    const cx = (v('x') as number) + w / 2;
    const cy = (v('y') as number) + h / 2;
    const rad = (-(v('rotation') as number) * Math.PI) / 180;
    const s = v('scale') as number;
    const sx = s * (v('scaleX') as number);
    const sy = s * (v('scaleY') as number);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Keep the center in place: T = translate(center) · rotate · scale(sx, sy) · translate(−w/2, −h/2).
    const a = cos * sx;
    const b = -sin * sy;
    const c = sin * sx;
    const d = cos * sy;
    out.transform = [a, b, cx - (a * w) / 2 - (b * h) / 2, c, d, cy - (c * w) / 2 - (d * h) / 2];
    if (has.has('width')) out.width = Math.max(0.01, w);
    if (has.has('height')) out.height = Math.max(0.01, h);
  }
  if (has.has('opacity')) out.opacity = Math.max(0, Math.min(1, v('opacity') as number));
  if (has.has('cornerRadius')) out.cornerRadius = Math.max(0, v('cornerRadius') as number);
  for (const [prop, plain] of Object.entries(PLAIN) as [BaseAnimProperty, NonNullable<(typeof PLAIN)[BaseAnimProperty]>][]) {
    if (!has.has(prop)) continue;
    const x = v(prop) as number;
    (out as Record<string, unknown>)[plain.key] = Math.min(plain.max ?? Infinity, Math.max(plain.min ?? -Infinity, x));
  }
  // Fill and stroke colors; effect fields; the 3D model's view angle and clip frame.
  let fills: Paint[] | null = null;
  if (tracks.some((tr) => MODEL_PROPS[tr.property as BaseAnimProperty])) {
    const list = [...(doc.get(id, 'fills') ?? [])];
    const i = list.findIndex((x) => x.type === 'MODEL3D');
    const m = list[i];
    if (m?.type === 'MODEL3D') {
      const cam = { ...(m.camera ?? DEFAULT_CAMERA) };
      const num = (p: AnimProperty) => v(p) as number;
      if (has.has('modelYaw')) cam.yaw = num('modelYaw');
      if (has.has('modelPitch')) cam.pitch = Math.max(-89, Math.min(89, num('modelPitch')));
      if (has.has('modelZoom')) cam.zoom = Math.max(0.05, num('modelZoom'));
      list[i] = { ...m, camera: cam, ...(has.has('modelTime') ? { pose: Math.max(0, num('modelTime')) } : {}) };
      fills = list;
    }
  }
  let strokes: Paint[] | null = null;
  let effects: Effect[] | null = null;
  for (const tr of tracks) {
    const val = v(tr.property);
    if (tr.property === 'fill' || tr.property === 'stroke') {
      if (typeof val !== 'object') continue;
      if (tr.property === 'fill') fills = recolor(fills ?? doc.get(id, 'fills') ?? [], null, val);
      else strokes = recolor(strokes ?? doc.get(id, 'strokes') ?? [], null, val);
      continue;
    }
    const ix = indexedProperty(tr.property);
    if (!ix) continue;
    if (ix.kind === 'effect') {
      const list = (effects ??= [...(doc.get(id, 'effects') ?? [])]);
      if (list[ix.index] && effectField(list[ix.index], ix.field) !== null) list[ix.index] = withEffectField(list[ix.index]!, ix.field, val);
    } else if (typeof val === 'object') {
      if (ix.kind === 'fill') fills = recolor(fills ?? doc.get(id, 'fills') ?? [], ix.index, val);
      else strokes = recolor(strokes ?? doc.get(id, 'strokes') ?? [], ix.index, val);
    }
  }
  if (fills) out.fills = fills;
  if (strokes) out.strokes = strokes;
  if (effects) out.effects = effects;
  return out;
}

/** Pose of all animated layers of the frame t seconds after the start (accounting for repeat). */
export function framePose(doc: Document, root: string, t: number): Map<string, Props> {
  const time = timelineTime(timelinePlayback(doc.get(root, 'timeline')), timelineDuration(doc, root), t);
  const out = new Map<string, Props>();
  for (const id of animatedNodes(doc, root)) {
    const p = animatedProps(doc, id, time);
    if (p) out.set(id, p);
  }
  return out;
}

/** Layer tracks with a property keyframe at time t (set or replace; sorted by time). */
export function withKey(tracks: readonly AnimTrack[], property: AnimProperty, t: number, value: number | RGBA, easing?: Easing): AnimTrack[] {
  const out: AnimTrack[] = tracks.map((tr) => ({ ...tr, keys: [...tr.keys] }));
  let tr = out.find((x) => x.property === property);
  if (!tr) out.push((tr = { property, keys: [] }));
  const i = tr.keys.findIndex((k) => Math.abs(k.t - t) < SAME_TIME);
  const prev = i >= 0 ? tr.keys[i]! : undefined;
  const key: Keyframe = { t: Math.round(t * 1000) / 1000, value, ...(easing ? { easing } : prev?.easing ? { easing: prev.easing } : {}), ...(prev?.id ? { id: prev.id } : {}) };
  if (i >= 0) tr.keys[i] = key;
  else tr.keys.push(key);
  tr.keys.sort((a, b) => a.t - b.t);
  return out;
}

/** Tracks without the property track. */
export function withoutTrack(tracks: readonly AnimTrack[], property: AnimProperty): AnimTrack[] {
  return tracks.filter((tr) => tr.property !== property);
}

/** Tracks without the property keyframe at time t (an empty track is removed). */
export function withoutKey(tracks: readonly AnimTrack[], property: AnimProperty, t: number): AnimTrack[] {
  return tracks
    .map((tr) => (tr.property === property ? { ...tr, keys: tr.keys.filter((k) => Math.abs(k.t - t) >= SAME_TIME) } : tr))
    .filter((tr) => tr.keys.length > 0);
}

// ---------- Motion styles ----------

/**
 * Motion style (like Motion styles): tracks with times from the start of the motion. Values are
 * relative to the layer's final pose: x, y, rotation, size, corner radius are added to it,
 * opacity and scale are a fraction of it, color is used as is. Built-in ones — MOTION_PRESETS, custom ones —
 * the document's motionStyles.
 */
export interface MotionStyle {
  name: string;
  tracks: AnimTrack[];
}

const ADDITIVE = new Set<AnimProperty>(['x', 'y', 'rotation', 'width', 'height', 'cornerRadius', 'rotateX', 'rotateY']);
const OUT: Easing = { type: 'EASE_OUT' };
const IN_OUT: Easing = { type: 'EASE_IN_AND_OUT' };

const fade = (from: number, to: number, d = 0.4): AnimTrack => ({ property: 'opacity', keys: [{ t: 0, value: from, easing: OUT }, { t: d, value: to }] });
const slide = (property: 'x' | 'y', from: number): AnimTrack => ({ property, keys: [{ t: 0, value: from, easing: OUT }, { t: 0.5, value: 0 }] });

export const MOTION_PRESETS: (MotionStyle & { id: string })[] = [
  { id: 'fade-in', name: 'Появление', tracks: [fade(0, 1)] },
  { id: 'slide-up', name: 'Появление снизу', tracks: [slide('y', 24), fade(0, 1)] },
  { id: 'slide-down', name: 'Появление сверху', tracks: [slide('y', -24), fade(0, 1)] },
  { id: 'slide-left', name: 'Появление справа', tracks: [slide('x', 32), fade(0, 1)] },
  { id: 'slide-right', name: 'Появление слева', tracks: [slide('x', -32), fade(0, 1)] },
  { id: 'zoom-in', name: 'Приближение', tracks: [{ property: 'scale', keys: [{ t: 0, value: 0.85, easing: OUT }, { t: 0.45, value: 1 }] }, fade(0, 1)] },
  { id: 'pop', name: 'Пружина', tracks: [{ property: 'scale', keys: [{ t: 0, value: 0.5, easing: { type: 'BOUNCY' } }, { t: 0.6, value: 1 }] }, fade(0, 1, 0.2)] },
  { id: 'flip-in', name: 'Переворот (3D)', tracks: [{ property: 'rotateY', keys: [{ t: 0, value: -90, easing: OUT }, { t: 0.6, value: 0 }] }, fade(0, 1, 0.25)] },
  { id: 'tilt-in', name: 'Наклон (3D)', tracks: [{ property: 'rotateX', keys: [{ t: 0, value: 50, easing: OUT }, { t: 0.5, value: 0 }] }, slide('y', 16), fade(0, 1)] },
  { id: 'fade-out', name: 'Исчезновение', tracks: [{ property: 'opacity', keys: [{ t: 0, value: 1, easing: IN_OUT }, { t: 0.4, value: 0 }] }] },
  { id: 'pulse', name: 'Пульс', tracks: [{ property: 'scale', keys: [{ t: 0, value: 1, easing: IN_OUT }, { t: 0.2, value: 1.08, easing: IN_OUT }, { t: 0.4, value: 1 }] }] },
  {
    id: 'shake',
    name: 'Покачивание',
    tracks: [{ property: 'rotation', keys: [{ t: 0, value: 0, easing: IN_OUT }, { t: 0.1, value: -6, easing: IN_OUT }, { t: 0.2, value: 6, easing: IN_OUT }, { t: 0.3, value: -3, easing: IN_OUT }, { t: 0.4, value: 0 }] }],
  },
];

/** Style keyframe value for a layer with final pose base. */
function styled(property: AnimProperty, base: number | RGBA, value: number | RGBA): number | RGBA {
  if (typeof value === 'object' || typeof base === 'object') return value;
  if (ADDITIVE.has(property)) return base + value;
  return base * value;
}

/**
 * Apply a style to layers from time t: the i-th layer starts stagger · i later (cascade). The final
 * pose is the layer's pose at its own start time. Returns the end time of the last motion.
 */
export function applyMotion(doc: Document, ids: readonly string[], style: MotionStyle, t: number, stagger = 0): number {
  let end = t;
  ids.forEach((id, i) => {
    const start = t + i * stagger;
    let tracks = doc.get(id, 'animation') ?? [];
    for (const tr of style.tracks) {
      const base = animatedValue(doc, id, tr.property, start);
      for (const k of tr.keys) {
        tracks = withKey(tracks, tr.property, start + k.t, styled(tr.property, base, k.value), k.easing);
        end = Math.max(end, start + k.t);
      }
    }
    doc.set(id, { animation: tracks });
  });
  return end;
}

/** A style from the layer's tracks: times from the first keyframe, values relative to each track's last keyframe. */
export function motionFromTracks(name: string, tracks: readonly AnimTrack[]): MotionStyle | null {
  const keys = tracks.flatMap((tr) => tr.keys);
  if (!keys.length) return null;
  const t0 = Math.min(...keys.map((k) => k.t));
  return {
    name,
    tracks: tracks
      .filter((tr) => tr.keys.length)
      .map((tr) => {
        const last = tr.keys[tr.keys.length - 1]!.value;
        return {
          property: tr.property,
          keys: tr.keys.map((k) => {
            let value: number | RGBA = k.value;
            if (typeof k.value === 'number' && typeof last === 'number') value = ADDITIVE.has(tr.property) ? k.value - last : last ? k.value / last : k.value;
            return { t: Math.round((k.t - t0) * 1000) / 1000, value, ...(k.easing ? { easing: k.easing } : {}) };
          }),
        };
      }),
  };
}

// ---------- Text animation ----------

/**
 * Text animation: each piece (letter, word, line) goes through the effect in duration seconds,
 * the next one starts stagger later; the first one — at start. Before its start a piece is invisible (with the
 * typewriter it appears whole at once).
 */
export interface TextAnimation {
  by: 'LETTER' | 'WORD' | 'LINE';
  effect: 'FADE' | 'RISE' | 'DROP' | 'SCALE' | 'TYPEWRITER';
  start: number;
  duration: number;
  stagger: number;
  easing?: Easing;
}

/** Number of pieces in the text (lines split at line breaks: width-based wrapping is unknown here). */
export function textAnimationUnits(by: TextAnimation['by'], characters: string): number {
  if (by === 'LINE') return Math.max(1, characters.split('\n').length);
  if (by === 'WORD') return Math.max(1, (characters.match(/\S+/g) ?? []).length);
  return Math.max(1, [...characters.replace(/\s+/g, '')].length);
}

/** End time of the text animation. */
export function textAnimationEnd(a: TextAnimation, characters: string): number {
  return a.start + (textAnimationUnits(a.by, characters) - 1) * a.stagger + a.duration;
}

/** Appearance fraction of piece i at time t (0 — not yet, 1 — in place), along the animation curve. */
export function textUnitProgress(a: TextAnimation, i: number, t: number): number {
  const local = (t - a.start - i * a.stagger) / Math.max(1e-6, a.duration);
  if (local <= 0) return 0;
  if (local >= 1) return 1;
  if (a.effect === 'TYPEWRITER') return 1;
  return easingFunction(a.easing ?? { type: 'EASE_OUT' }, a.duration)(local);
}
