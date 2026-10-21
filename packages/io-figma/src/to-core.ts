// Import of .fig into the editable MFP document model.
//
// The source is the scene tree (instances already expanded, overrides applied).
// Properties are converted to the model form (compatible with the Plugin API), and Figma's prebuilt
// geometry (fill/stroke paths, text outlines) is kept as
// derived data, so the imported design looks exact
// while simple properties (position, size, colors, name) are editable right away.

import { type ExportSetting, DEFAULTS, Document, Interner, PRESET_CATEGORIES, ROOT_OWN, alias, encodeNetwork, htmlToMarkdown, normalizeRuns, parseVariantName, styleRange } from '@mfp/core';
import { resolveFigmaShader } from './figma-shaders.ts';
import type { Annotation, AnnotationCategory, DecorationThickness, FontVariation, AnnotationPropertyType, DevStatus, Measurement, MeasurementSide } from '@mfp/core';
import type { VideoPaint, HandleMirroring, VectorNetwork, VectorVertex, BlendMode, ComponentPropertyDefinition, Easing, Effect, GradientPaint, ImagePaint, Navigation, NodeType, Paint, PrototypeAction, PrototypeValue, Props, Reaction, SolidPaint, TextGlyphs, Transition, TransitionDirection, Trigger, VectorPath, ConstraintType, GridTrackSize, LayoutGrid, StrokeCap, TextRun, TextStyle, VariableValue } from '@mfp/core';
import { assetRef as assetRefOf, decodePathCommands, type Scene, type SceneDesign, type SceneGeometry, type SceneNode } from './scene.ts';
import { centerChains, decodeVectorNetwork, type FigVectorNetwork } from './vector-network.ts';
import type { FigEffect, FigPaint, FigNodeChange } from './types.ts';

export interface ImportReport {
  pages: number;
  nodes: number;
  /** Hashes of images the document references. */
  images: Set<string>;
  warnings: string[];
  ms: number;
}

const TYPE_MAP: Record<string, NodeType> = {
  FRAME: 'FRAME',
  GROUP: 'GROUP',
  SECTION: 'SECTION',
  SYMBOL: 'COMPONENT',
  INSTANCE: 'INSTANCE',
  RECTANGLE: 'RECTANGLE',
  ROUNDED_RECTANGLE: 'RECTANGLE',
  ELLIPSE: 'ELLIPSE',
  VECTOR: 'VECTOR',
  BOOLEAN_OPERATION: 'VECTOR',
  STAR: 'STAR',
  REGULAR_POLYGON: 'POLYGON',
  LINE: 'LINE',
  TEXT: 'TEXT',
  SLICE: 'SLICE',
  VARIABLE_SET: 'VARIABLE_COLLECTION',
  VARIABLE: 'VARIABLE',
};

/** Export setting from .fig → as in the Plugin API. */
function exportSettingOf(s: Record<string, unknown>): ExportSetting | null {
  const formats: Record<string, ExportSetting['format']> = { PNG: 'PNG', JPEG: 'JPG', SVG: 'SVG', PDF: 'PDF' };
  const format = formats[String(s.imageType)];
  if (!format) return null;
  const c = s.constraint as { type?: string; value?: number } | undefined;
  const types: Record<string, 'SCALE' | 'WIDTH' | 'HEIGHT'> = { CONTENT_SCALE: 'SCALE', CONTENT_WIDTH: 'WIDTH', CONTENT_HEIGHT: 'HEIGHT' };
  const type = types[String(c?.type)];
  return {
    format,
    suffix: typeof s.suffix === 'string' ? s.suffix : '',
    ...(format === 'PNG' || format === 'JPG' ? { constraint: { type: type ?? 'SCALE', value: typeof c?.value === 'number' ? c.value : 1 } } : {}),
    ...(s.contentsOnly === false ? { contentsOnly: false } : {}),
    ...(s.useAbsoluteBounds === true ? { useAbsoluteBounds: true } : {}),
    ...(format === 'SVG' ? { svgOutlineText: s.svgOutlineText !== false, svgIdAttribute: s.svgIDMode === 'ALWAYS' } : {}),
  };
}

// ---------- Developer mode: annotations, statuses, measurements ----------

const ANNOTATION_PROPS: Record<string, AnnotationPropertyType> = {
  FILL: 'fills',
  STROKE: 'strokes',
  WIDTH: 'width',
  HEIGHT: 'height',
  MIN_WIDTH: 'minWidth',
  MIN_HEIGHT: 'minHeight',
  MAX_WIDTH: 'maxWidth',
  MAX_HEIGHT: 'maxHeight',
  STROKE_WIDTH: 'strokeWeight',
  CORNER_RADIUS: 'cornerRadius',
  EFFECT: 'effects',
  TEXT_STYLE: 'textStyleId',
  TEXT_ALIGN_HORIZONTAL: 'textAlignHorizontal',
  FONT_FAMILY: 'fontFamily',
  FONT_SIZE: 'fontSize',
  FONT_WEIGHT: 'fontWeight',
  LINE_HEIGHT: 'lineHeight',
  LETTER_SPACING: 'letterSpacing',
  STACK_SPACING: 'itemSpacing',
  STACK_PADDING: 'padding',
  STACK_MODE: 'layoutMode',
  STACK_ALIGNMENT: 'alignItems',
  OPACITY: 'opacity',
  COMPONENT: 'mainComponent',
  FONT_STYLE: 'fontStyle',
  GRID_ROW_GAP: 'gridRowGap',
  GRID_COLUMN_GAP: 'gridColumnGap',
  GRID_ROW_COUNT: 'gridRowCount',
  GRID_COLUMN_COUNT: 'gridColumnCount',
  GRID_ROW_ANCHOR_INDEX: 'gridRowAnchorIndex',
  GRID_COLUMN_ANCHOR_INDEX: 'gridColumnAnchorIndex',
  GRID_ROW_SPAN: 'gridRowSpan',
  GRID_COLUMN_SPAN: 'gridColumnSpan',
};

/** Annotation from .fig: label (HTML) → Markdown, properties and category. */
function annotationOf(a: Record<string, unknown>): Annotation | null {
  const label = typeof a.label === 'string' ? htmlToMarkdown(a.label) : '';
  const properties = ((a.properties as { type?: string }[] | undefined) ?? []).map((p) => ANNOTATION_PROPS[String(p.type)]).filter((t): t is AnnotationPropertyType => !!t).map((type) => ({ type }));
  if (!label && !properties.length) return null;
  return { ...(label ? { labelMarkdown: label } : {}), ...(properties.length ? { properties } : {}), ...(a.categoryId ? { categoryId: guidKey(a.categoryId) } : {}) };
}

/** Status from .fig: BUILD — “Ready for development”, COMPLETED — “Completed”. */
function devStatusOf(info: Record<string, unknown>): DevStatus | null {
  const type = info.status === 'BUILD' ? 'READY_FOR_DEV' : info.status === 'COMPLETED' ? 'COMPLETED' : null;
  if (!type) return null;
  const t = Number(info.lastUpdateUnixTimestamp);
  return { type, ...(typeof info.description === 'string' && info.description ? { description: info.description } : {}), ...(t > 0 ? { updated: t * 1000 } : {}) };
}

/** Document annotation categories: built-in ones get our names, custom ones stay as in the file. */
function categoriesOf(items: Record<string, unknown>[]): AnnotationCategory[] {
  const PRESETS: Record<string, string> = { DEVELOPMENT: 'development', INTERACTION: 'interaction', ACCESSIBILITY: 'accessibility', CONTENT: 'content', BEHAVIOR: 'behavior' };
  const COLORS = new Set(['yellow', 'orange', 'red', 'pink', 'violet', 'blue', 'teal', 'green']);
  const out: AnnotationCategory[] = [];
  for (const it of items) {
    const id = guidKey(it.id);
    const preset = PRESETS[String(it.preset)];
    if (preset) {
      const p = PRESET_CATEGORIES.find((c) => c.id === preset)!;
      out.push({ ...p, id });
      continue;
    }
    const custom = it.custom as { color?: string; label?: string } | undefined;
    const color = String(custom?.color ?? 'blue').toLowerCase();
    out.push({ id, label: custom?.label || 'Категория', color: (COLORS.has(color) ? color : 'blue') as AnnotationCategory['color'], isPreset: false });
  }
  return out;
}

const SIDES: Record<string, MeasurementSide> = { TOP: 'TOP', BOTTOM: 'BOTTOM', LEFT: 'LEFT', RIGHT: 'RIGHT' };
const OPPOSITE: Record<MeasurementSide, MeasurementSide> = { TOP: 'BOTTOM', BOTTOM: 'TOP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

const CONTAINERS = new Set<NodeType>(['FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
/** Paints that are translated into the model (others are skipped; binding indices shift the same way). */
const convertible = (p: FigPaint) => p.type === 'SOLID' || p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND' || p.type === 'IMAGE' || p.type === 'VIDEO';
/** All effects retain their positions, including opaque unsupported effects. */
const convertibleEffect = (_e: FigEffect) => true;
/** Paragraph text style properties (from textExtraProps). */
const TEXT_STYLE_EXTRA = ['paragraphSpacing', 'paragraphIndent', 'listSpacing', 'leadingTrim', 'openTypeFeatures'];
/** Variable type from .fig → model type. */
const VARIABLE_TYPES: Record<string, 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR'> = { BOOLEAN: 'BOOLEAN', FLOAT: 'FLOAT', STRING: 'STRING', COLOR: 'COLOR' };

// ---------- Prototype: .fig interactions → reactions (as in the Plugin API) ----------

/** .fig easing curves → Plugin API (easingFunction values as is: more precise than presets). */
const EASING_TYPES: Record<string, Easing['type']> = {
  IN_CUBIC: 'EASE_IN',
  EASE_IN: 'EASE_IN',
  OUT_CUBIC: 'EASE_OUT',
  INOUT_CUBIC: 'EASE_IN_AND_OUT',
  LINEAR: 'LINEAR',
  IN_BACK_CUBIC: 'EASE_IN_BACK',
  OUT_BACK_CUBIC: 'EASE_OUT_BACK',
  INOUT_BACK_CUBIC: 'EASE_IN_AND_OUT_BACK',
  CUSTOM_CUBIC: 'CUSTOM_CUBIC_BEZIER',
  GENTLE_SPRING: 'GENTLE',
  SPRING_PRESET_ONE: 'QUICK',
  SPRING_PRESET_TWO: 'BOUNCY',
  SPRING_PRESET_THREE: 'SLOW',
  SPRING: 'CUSTOM_SPRING',
  CUSTOM_SPRING: 'CUSTOM_SPRING',
};
const SPRINGS = new Set(['GENTLE', 'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING']);

function easingOf(type: unknown, fn: unknown): Easing {
  const t = EASING_TYPES[String(type ?? 'OUT_CUBIC')] ?? 'EASE_OUT';
  const f = Array.isArray(fn) && fn.length >= 4 ? (fn as number[]) : null;
  if (SPRINGS.has(t) && f) return { type: t, easingFunctionSpring: { mass: f[0]!, stiffness: f[1]!, damping: f[2]!, initialVelocity: f[3] ?? 0 } };
  if (f && !SPRINGS.has(t)) return { type: t, easingFunctionCubicBezier: { x1: f[0]!, y1: f[1]!, x2: f[2]!, y2: f[3]! } };
  return { type: t };
}

/** .fig transition (“from” and “to” kinds) → Transition (direction is where the layer moves). */
function transitionOf(a: Record<string, unknown>): Transition | null {
  const kind = String(a.transitionType ?? 'INSTANT_TRANSITION');
  if (kind === 'INSTANT_TRANSITION') return null;
  const easing = easingOf(a.easingType, a.easingFunction);
  const duration = typeof a.transitionDuration === 'number' ? a.transitionDuration : 0.3;
  if (kind === 'DISSOLVE' || kind === 'FADE') return { type: 'DISSOLVE', easing, duration };
  if (kind === 'SMART_ANIMATE' || kind === 'MAGIC_MOVE') return { type: 'SMART_ANIMATE', easing, duration };
  if (kind === 'SCROLL_ANIMATE') return { type: 'SCROLL_ANIMATE', easing, duration };
  const m = /^(SLIDE|PUSH|MOVE)_(FROM|OUT_TO)_(LEFT|RIGHT|TOP|BOTTOM)$/.exec(kind);
  if (!m) return { type: 'DISSOLVE', easing, duration };
  const opposite: Record<string, TransitionDirection> = { LEFT: 'RIGHT', RIGHT: 'LEFT', TOP: 'BOTTOM', BOTTOM: 'TOP' };
  const out = m[2] === 'OUT_TO';
  const direction = out ? (m[3] as TransitionDirection) : opposite[m[3]!]!;
  const type = m[1] === 'PUSH' ? 'PUSH' : m[1] === 'SLIDE' ? (out ? 'SLIDE_OUT' : 'SLIDE_IN') : out ? 'MOVE_OUT' : 'MOVE_IN';
  return { type, direction, matchLayers: a.transitionShouldSmartAnimate === true, easing, duration };
}

const TRIGGERS: Record<string, Trigger['type']> = {
  ON_CLICK: 'ON_CLICK',
  ON_HOVER: 'ON_HOVER',
  ON_PRESS: 'ON_PRESS',
  DRAG: 'ON_DRAG',
  AFTER_TIMEOUT: 'AFTER_TIMEOUT',
  MOUSE_ENTER: 'MOUSE_ENTER',
  MOUSE_IN: 'MOUSE_ENTER',
  MOUSE_LEAVE: 'MOUSE_LEAVE',
  MOUSE_OUT: 'MOUSE_LEAVE',
  MOUSE_DOWN: 'MOUSE_DOWN',
  MOUSE_UP: 'MOUSE_UP',
  ON_KEY_DOWN: 'ON_KEY_DOWN',
  ON_MEDIA_HIT: 'ON_MEDIA_HIT',
  ON_MEDIA_END: 'ON_MEDIA_END',
};

function triggerOf(e: Record<string, unknown> | undefined): Trigger | null {
  const t = TRIGGERS[String(e?.interactionType ?? '')];
  if (!t) return null;
  if (t === 'AFTER_TIMEOUT') return { type: t, timeout: typeof e!.transitionTimeout === 'number' ? e!.transitionTimeout : 0.8 };
  if (t === 'MOUSE_ENTER' || t === 'MOUSE_LEAVE' || t === 'MOUSE_DOWN' || t === 'MOUSE_UP') return { type: t, delay: typeof e!.interactionDuration === 'number' ? e!.interactionDuration : 0 };
  if (t === 'ON_KEY_DOWN') {
    const k = e!.keyTrigger as { keyCodes?: number[]; triggerDevice?: string } | undefined;
    return { type: t, device: (k?.triggerDevice as Extract<Trigger, { type: 'ON_KEY_DOWN' }>['device']) ?? 'KEYBOARD', keyCodes: k?.keyCodes ?? [] };
  }
  if (t === 'ON_MEDIA_HIT') return { type: t, mediaHitTime: typeof e!.mediaHitTime === 'number' ? e!.mediaHitTime : 0 };
  // .fig has no scroll or input field triggers.
  if (t === 'ON_SCROLL' || t === 'ON_TEXT_INPUT') return null;
  return { type: t };
}

const NAVIGATIONS: Record<string, Navigation> = { NAVIGATE: 'NAVIGATE', OVERLAY: 'OVERLAY', SWAP: 'SWAP', SWAP_STATE: 'CHANGE_TO', SCROLL_TO: 'SCROLL_TO' };

interface Resolvers {
  node(guid: unknown): string | null;
  variable(ref: unknown): string | null;
  collection(ref: unknown): string | null;
}

/** .fig VariableData → action value (expressions recursively). */
function prototypeValue(vd: Record<string, unknown> | undefined, r: Resolvers): PrototypeValue | undefined {
  if (!vd) return undefined;
  const v = (vd.value ?? {}) as Record<string, unknown>;
  const resolvedType = VARIABLE_TYPES[String(vd.resolvedDataType ?? '')];
  const base = resolvedType ? { resolvedType } : {};
  if (v.alias) {
    const id = r.variable(v.alias);
    return id ? { type: 'VARIABLE_ALIAS', ...base, value: { type: 'VARIABLE_ALIAS', id } } : undefined;
  }
  const ex = v.expressionValue as { expressionFunction?: string; expressionArguments?: Record<string, unknown>[] } | undefined;
  if (ex?.expressionFunction) {
    const args = (ex.expressionArguments ?? []).map((a) => prototypeValue(a, r)).filter((x): x is PrototypeValue => !!x);
    return { type: 'EXPRESSION', ...base, value: { expressionFunction: ex.expressionFunction, expressionArguments: args } };
  }
  if (typeof v.boolValue === 'boolean') return { type: 'BOOLEAN', resolvedType: 'BOOLEAN', value: v.boolValue };
  if (typeof v.floatValue === 'number') return { type: 'FLOAT', resolvedType: 'FLOAT', value: v.floatValue };
  if (typeof v.textValue === 'string') return { type: 'STRING', resolvedType: 'STRING', value: v.textValue };
  const c = v.colorValue as { r: number; g: number; b: number; a?: number } | undefined;
  if (c) return { type: 'COLOR', resolvedType: 'COLOR', value: { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 } };
  return undefined;
}

function actionOf(a: Record<string, unknown>, r: Resolvers): PrototypeAction | null {
  switch (String(a.connectionType ?? 'NONE')) {
    case 'INTERNAL_NODE': {
      const navigation = NAVIGATIONS[String(a.navigationType ?? 'NAVIGATE')] ?? 'NAVIGATE';
      const out: Extract<PrototypeAction, { type: 'NODE' }> = { type: 'NODE', destinationId: r.node(a.transitionNodeID), navigation, transition: transitionOf(a) };
      if (a.transitionPreserveScroll === true) out.preserveScrollPosition = true;
      if (a.overlayRelativePosition) out.overlayRelativePosition = a.overlayRelativePosition as { x: number; y: number };
      if (a.transitionResetScrollPosition === true) out.resetScrollPosition = true;
      if (a.transitionResetInteractiveComponents === true) out.resetInteractiveComponents = true;
      return out;
    }
    case 'URL':
      return { type: 'URL', url: String(a.connectionURL ?? ''), openInNewTab: a.openUrlInNewTab !== false };
    case 'BACK':
      return { type: 'BACK' };
    case 'CLOSE':
      return { type: 'CLOSE' };
    case 'SET_VARIABLE': {
      const target = (a.targetVariable as { id?: unknown } | undefined)?.id ?? a.targetVariableID;
      return { type: 'SET_VARIABLE', variableId: r.variable(target), variableValue: prototypeValue(a.targetVariableData as Record<string, unknown> | undefined, r) };
    }
    case 'SET_VARIABLE_MODE':
      return { type: 'SET_VARIABLE_MODE', variableCollectionId: r.collection(a.targetVariableSetID), variableModeId: a.targetVariableModeID ? guidKey(a.targetVariableModeID) : null };
    case 'CONDITIONAL': {
      const blocks = ((a.conditionalActions as { actions?: Record<string, unknown>[]; condition?: Record<string, unknown> }[] | undefined) ?? []).map((b) => ({
        ...(b.condition ? { condition: prototypeValue(b.condition, r) } : {}),
        actions: (b.actions ?? []).map((x) => actionOf(x, r)).filter((x): x is PrototypeAction => !!x),
      }));
      return { type: 'CONDITIONAL', conditionalBlocks: blocks };
    }
    case 'UPDATE_MEDIA_RUNTIME':
      return {
        type: 'UPDATE_MEDIA_RUNTIME',
        destinationId: r.node(a.transitionNodeID),
        mediaAction: (String(a.mediaAction ?? 'PLAY') as Extract<PrototypeAction, { type: 'UPDATE_MEDIA_RUNTIME' }>['mediaAction']),
        ...(typeof a.mediaSkipByAmount === 'number' ? { amountToSkip: a.mediaSkipByAmount } : {}),
        ...(typeof a.mediaSkipToTime === 'number' ? { newTimestamp: a.mediaSkipToTime } : {}),
      };
    default:
      return null;
  }
}

/** .fig interactions → reactions. */
export function reactionsOfFig(list: Record<string, unknown>[], r: Resolvers): Reaction[] {
  const out: Reaction[] = [];
  for (const i of list) {
    const trigger = triggerOf(i.event as Record<string, unknown> | undefined);
    const actions = ((i.actions as Record<string, unknown>[] | undefined) ?? []).map((a) => actionOf(a, r)).filter((a): a is PrototypeAction => !!a);
    if (!trigger && !actions.length) continue;
    out.push({ trigger, actions });
  }
  return out;
}

const CAPS = new Set<string>(['NONE', 'ROUND', 'SQUARE', 'ARROW_LINES', 'ARROW_EQUILATERAL', 'TRIANGLE_FILLED', 'CIRCLE_FILLED', 'DIAMOND_FILLED']);
const toCap = (v: string | undefined): StrokeCap => (v && CAPS.has(v) ? (v as StrokeCap) : 'NONE');

/** Most frequent value (network chain caps → one node cap). */
function mostCommon<T>(list: T[]): T | undefined {
  const count = new Map<T, number>();
  let best: T | undefined;
  let n = 0;
  for (const v of list) {
    const c = (count.get(v) ?? 0) + 1;
    count.set(v, c);
    if (c > n) [best, n] = [v, c];
  }
  return best;
}
const num = (v: number) => String(Math.round(v * 1000) / 1000);

export function hashToHex(hash: Uint8Array | undefined): string {
  if (!hash) return '';
  let s = '';
  for (const b of hash) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Path commands from a blob → SVG path string; transform maps the points. */
export function blobToSvgPath(bytes: Uint8Array, transform?: (x: number, y: number) => [number, number]): string {
  const out: string[] = [];
  const t = transform ?? ((x: number, y: number) => [x, y] as [number, number]);
  const pt = (x: number, y: number) => {
    const [a, b] = t(x, y);
    return `${num(a)} ${num(b)}`;
  };
  decodePathCommands(bytes, {
    moveTo: (x, y) => out.push(`M ${pt(x, y)}`),
    lineTo: (x, y) => out.push(`L ${pt(x, y)}`),
    quadTo: (x1, y1, x, y) => out.push(`Q ${pt(x1, y1)} ${pt(x, y)}`),
    cubicTo: (x1, y1, x2, y2, x, y) => out.push(`C ${pt(x1, y1)} ${pt(x2, y2)} ${pt(x, y)}`),
    close: () => out.push('Z'),
  });
  return out.join(' ');
}

function blendMode(mode: string | undefined): BlendMode | undefined {
  return mode && mode !== 'NORMAL' && mode !== 'PASS_THROUGH' ? (mode as BlendMode) : undefined;
}

function convertPaint(p: FigPaint, images: Set<string>, shaders?: Scene['customShaders']): Paint | null {
  // Optional fields are written only if they differ from the defaults.
  const extra = (o: Record<string, unknown>) => {
    if (p.visible === false) o.visible = false;
    const bm = blendMode(p.blendMode);
    if (bm) o.blendMode = bm;
    return o;
  };
  const matrix = (t: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number }): [[number, number, number], [number, number, number]] => [
    [t.m00, t.m01, t.m02],
    [t.m10, t.m11, t.m12],
  ];
  switch (p.type) {
    case 'CUSTOM': {
      const ref = p.customEffectId;
      const definition = shaders?.find((n) => ref?.assetRef?.key ? n.key === ref.assetRef.key && (!ref.assetRef.version || n.version === ref.assetRef.version) : ref?.guid && guidKey(n.guid) === guidKey(ref.guid));
      return resolveFigmaShader({
        ...extra({}), type: 'SHADER', code: '', opacity: p.opacity ?? 1,
        figma: { reference: ref ?? null, assignments: p.componentPropAssignments ?? [], ...(definition ? { definition } : {}) },
      });
    }
    case 'SOLID': {
      const c = p.color ?? { r: 0, g: 0, b: 0, a: 1 };
      const opacity = (c.a ?? 1) * (p.opacity ?? 1);
      const paint: SolidPaint = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } };
      if (opacity < 1) paint.opacity = opacity;
      return extra(paint as unknown as Record<string, unknown>) as unknown as SolidPaint;
    }
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND': {
      const paint: GradientPaint = {
        type: p.type,
        gradientTransform: matrix(p.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }),
        gradientStops: (p.stops ?? []).map((s) => ({ position: s.position, color: s.color })),
      };
      if ((p.opacity ?? 1) < 1) paint.opacity = p.opacity;
      return extra(paint as unknown as Record<string, unknown>) as unknown as GradientPaint;
    }
    case 'IMAGE': {
      const hash = hashToHex(p.image?.hash);
      if (hash) images.add(hash);
      const mode = p.imageScaleMode === 'FIT' ? 'FIT' : p.imageScaleMode === 'TILE' ? 'TILE' : p.imageScaleMode === 'STRETCH' ? 'CROP' : 'FILL';
      const paint: ImagePaint = { type: 'IMAGE', scaleMode: mode, imageHash: hash || null };
      if ((p.opacity ?? 1) < 1) paint.opacity = p.opacity;
      if (p.scale !== undefined) paint.scalingFactor = p.scale;
      if (p.transform) paint.imageTransform = matrix(p.transform);
      if (p.originalImageWidth) paint.originalWidth = p.originalImageWidth;
      // Rotation (in the file it is in degrees, as in the Plugin API; not seen in fixtures).
      if (p.rotation && mode !== 'CROP') paint.rotation = ((Math.round(p.rotation / 90) * 90) % 360 + 360) % 360;
      // Adjustment: the file has “vibrance”, the Plugin API has “saturation”.
      const pf = p.paintFilter as Record<string, number> | undefined;
      if (pf) {
        const filters: Record<string, number> = {};
        for (const [from, to] of FILTER_KEYS) if (pf[from]) filters[to] = pf[from];
        if (Object.keys(filters).length) paint.filters = filters;
      }
      return extra(paint as unknown as Record<string, unknown>) as unknown as ImagePaint;
    }
    case 'VIDEO': {
      // Video bytes are in the archive next to images (by the same hash).
      const hash = hashToHex(p.video?.hash);
      if (hash) images.add(hash);
      const mode = p.imageScaleMode === 'FIT' ? 'FIT' : p.imageScaleMode === 'TILE' ? 'TILE' : p.imageScaleMode === 'STRETCH' ? 'CROP' : 'FILL';
      const paint: VideoPaint = { type: 'VIDEO', scaleMode: mode, videoHash: hash || null };
      if ((p.opacity ?? 1) < 1) paint.opacity = p.opacity;
      if (p.scale !== undefined) paint.scalingFactor = p.scale;
      if (p.transform) paint.videoTransform = matrix(p.transform);
      if (p.rotation && mode !== 'CROP') paint.rotation = ((Math.round(p.rotation / 90) * 90) % 360 + 360) % 360;
      return extra(paint as unknown as Record<string, unknown>) as unknown as VideoPaint;
    }
    default:
      return null;
  }
}

/** Image adjustment fields: Figma file → model (as in the Plugin API). */
const FILTER_KEYS: [string, string][] = [
  ['exposure', 'exposure'],
  ['contrast', 'contrast'],
  ['vibrance', 'saturation'],
  ['temperature', 'temperature'],
  ['tint', 'tint'],
  ['highlights', 'highlights'],
  ['shadows', 'shadows'],
];

function convertEffect(e: FigEffect, shaders?: FigNodeChange[]): Effect {
  const visible = e.visible !== false;
  switch (e.type) {
    case 'DROP_SHADOW':
    case 'INNER_SHADOW':
      return {
        type: e.type,
        color: e.color ?? { r: 0, g: 0, b: 0, a: 0.25 },
        offset: e.offset ?? { x: 0, y: 0 },
        radius: e.radius ?? 0,
        spread: e.spread,
        visible,
        blendMode: blendMode(e.blendMode) ?? 'NORMAL',
        ...(e.type === 'DROP_SHADOW' && e.showShadowBehindNode ? { showShadowBehindNode: true } : {}),
      };
    case 'FOREGROUND_BLUR':
    case 'BACKGROUND_BLUR': {
      const out: Effect = { type: e.type === 'FOREGROUND_BLUR' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', radius: e.radius ?? 0, visible };
      // Progressive blur: points are fractions of the layer bounds, as in the Plugin API.
      if (e.blurOpType === 'PROGRESSIVE') {
        out.blurType = 'PROGRESSIVE';
        out.startRadius = e.startRadius ?? 0;
        out.startOffset = { x: e.startOffset?.x ?? 0.5, y: e.startOffset?.y ?? 0 };
        out.endOffset = { x: e.endOffset?.x ?? 0.5, y: e.endOffset?.y ?? 1 };
      }
      return out;
    }
    case 'NOISE': {
      const type = e.noiseType === 'DUOTONE' || e.noiseType === 'MULTITONE' ? e.noiseType : 'MONOTONE';
      return {
        type: 'NOISE',
        noiseType: type,
        color: e.color ?? { r: 0, g: 0, b: 0, a: 0.25 },
        ...(type === 'DUOTONE' ? { secondaryColor: e.secondaryColor ?? { r: 1, g: 1, b: 1, a: 0.25 } } : {}),
        ...(type === 'MULTITONE' ? { opacity: e.opacity ?? 1 } : {}),
        noiseSize: e.noiseSize?.x ?? 1,
        density: e.density ?? 0.5,
        blendMode: blendMode(e.blendMode) ?? 'NORMAL',
        visible,
      };
    }
    case 'GRAIN':
      return { type: 'TEXTURE', noiseSize: e.noiseSize?.x ?? 1, radius: e.radius ?? 0, clipToShape: e.clipToShape !== false, visible };
    case 'GLASS':
      // .fig to Plugin API field mapping is by meaning (no glass samples in the example files).
      return {
        type: 'GLASS',
        lightIntensity: e.specularIntensity ?? 0.5,
        lightAngle: e.specularAngle ?? -45,
        refraction: e.refractionIntensity ?? 0.5,
        depth: e.refractionRadius ?? 20,
        dispersion: e.chromaticAberration ?? 0,
        radius: e.radius ?? 0,
        visible,
      };
    default: {
      const ref = (e as FigPaint).customEffectId;
      const definition = shaders?.find((n) => ref?.assetRef?.key ? n.key === ref.assetRef.key && (!ref.assetRef.version || n.version === ref.assetRef.version) : ref?.guid && guidKey(n.guid) === guidKey(ref.guid));
      return { type: 'UNSUPPORTED_FIGMA', originalType: e.type ?? 'UNKNOWN', visible,
        raw: structuredClone(e) as unknown as Record<string, unknown>,
        ...(definition ? { definition: structuredClone(definition) } : {}) };
    }
  }
}

/**
 * Scene → document model. into — insert the contents of the scene pages into this node
 * of an existing document (paste from the Figma clipboard; a user edit, an undo step);
 * otherwise scene pages become document pages (file import, outside history).
 * ids — scene node (key; for nodes outside instances, the Figma id “1:925”) → document node.
 */
export function sceneToCore(
  scene: Scene,
  doc = new Document({ clientId: 1 }),
  opts: { into?: string; lazy?: boolean } = {},
): { doc: Document; report: ImportReport; roots: string[]; ids: ReadonlyMap<string, string>; more?: Generator<void, void, void> } {
  const t0 = performance.now();
  const report: ImportReport = { pages: 0, nodes: 0, images: new Set(), warnings: [], ms: 0 };
  // Identical property values (instance copies) become shared frozen objects.
  const interner = new Interner();
  // Geometry table: scene blob → key in the document. Component copies use the same
  // scene blobs, so they are converted and stored once.
  const blobKeys = new Map<number, string>();
  const blobKey = (index: number): string | null => {
    let key = blobKeys.get(index);
    if (key === undefined) {
      const bytes = scene.blobs[index];
      if (!bytes) return null;
      key = doc.putBlob(blobToSvgPath(bytes));
      blobKeys.set(index, key);
    }
    return key;
  };
  const paths = (geometry: SceneGeometry[]): VectorPath[] => {
    const out: VectorPath[] = [];
    for (const g of geometry) {
      const key = blobKey(g.blob);
      if (key) out.push({ windingRule: g.windingRule, blob: key, ...(g.fills ? { fills: paints(g.fills) } : {}) });
    }
    return out;
  };
  // Instance copies reference the same source arrays (fills, effects, glyphs):
  // translate and intern them once per source object.
  const paintMemo = new WeakMap<FigPaint[], Paint[]>();
  const paints = (list: FigPaint[]): Paint[] => {
    let out = paintMemo.get(list);
    if (!out) {
      out = interner.value(list.map((p) => convertPaint(p, report.images, scene.customShaders)).filter((p): p is Paint => !!p));
      if (out.some((p) => p.type === 'SHADER' && p.figma && !p.code && !p.wgsl) && !report.warnings.includes('Шейдер Figma: ссылка и параметры сохранены, но исполняемый исходник не включён в .fig.')) report.warnings.push('Шейдер Figma: ссылка и параметры сохранены, но исполняемый исходник не включён в .fig.');
      paintMemo.set(list, out);
    }
    return out;
  };
  const effectMemo = new WeakMap<FigEffect[], Effect[]>();
  const effects = (list: FigEffect[]): Effect[] => {
    let out = effectMemo.get(list);
    if (!out) {
      out = interner.value(list.map((e) => convertEffect(e, scene.customShaders)));
      for (const e of out) if (e.type === 'UNSUPPORTED_FIGMA') {
        const warning = `Эффект Figma «${e.originalType}» сохранён, но пока не отображается.`;
        if (!report.warnings.includes(warning)) report.warnings.push(warning);
      }
      effectMemo.set(list, out);
    }
    return out;
  };
  const pathMemo = new Map<string, VectorPath[]>();
  /** Indices of region fill arrays (for the shared path key). */
  const fillIds = new WeakMap<FigPaint[], number>();
  const fillId = (list: FigPaint[]) => {
    let id = fillIds.get(list);
    if (id === undefined) fillIds.set(list, (id = fillIdNext++));
    return id;
  };
  let fillIdNext = 0;
  const sharedPaths = (geometry: SceneGeometry[]): VectorPath[] => {
    const key = geometry.map((g) => `${g.blob}${g.windingRule === 'EVENODD' ? 'e' : 'n'}${g.fills ? `f${fillId(g.fills)}` : ''}`).join(',');
    let out = pathMemo.get(key);
    if (!out) pathMemo.set(key, (out = interner.value(paths(geometry))));
    return out;
  };
  // Vector networks: one decode per blob, centerlines per blob and scale.
  const networks = new Map<number, FigVectorNetwork | null>();
  const network = (blob: number) => {
    let net = networks.get(blob);
    if (net === undefined) {
      const bytes = scene.blobs[blob];
      networks.set(blob, (net = bytes ? decodeVectorNetwork(bytes) : null));
    }
    return net;
  };
  const centerMemo = new Map<string, { paths: VectorPath[]; starts: number[]; ends: number[] }>();
  const centers = (blob: number, sx: number, sy: number) => {
    const key = `${blob}|${sx}|${sy}`;
    let out = centerMemo.get(key);
    if (!out) {
      const net = network(blob);
      const chains = net ? centerChains(net, sx, sy) : [];
      const open = chains.filter((c) => !c.closed);
      out = {
        paths: chains.length ? interner.value([{ windingRule: 'NONZERO', blob: doc.putBlob(chains.map((c) => c.data).join(' ')) }] as VectorPath[]) : [],
        starts: open.map((c) => net!.vertices[c.startVertex]!.style),
        ends: open.map((c) => net!.vertices[c.endVertex]!.style),
      };
      centerMemo.set(key, out);
    }
    return out;
  };
  /**
   * Vector network in the model (for editing and plugins): scale from normalizedSize to the node size,
   * vertex styles from the table, regions get the rule and own fills from the prebuilt fill paths
   * (in the same order as the regions). Identical ones share one geometry table entry.
   */
  const networkMemo = new Map<string, { blob: string } | null>();
  const vectorNetworkRef = (vn: NonNullable<NonNullable<SceneNode['source']>['vectorNetwork']>, n: SceneNode, fillPaths: VectorPath[]) => {
    const ns = vn.normalizedSize;
    const sx = ns?.x ? n.size.x / ns.x : 1;
    const sy = ns?.y ? n.size.y / ns.y : 1;
    const key = `${vn.blob}|${sx}|${sy}|${n.fillGeometry.map((g) => `${g.windingRule[0]}${g.fills ? `f${fillId(g.fills)}` : ''}`).join(',')}`;
    let ref = networkMemo.get(key);
    if (ref !== undefined) return ref;
    const net = network(vn.blob);
    if (!net) {
      networkMemo.set(key, null);
      return null;
    }
    const vertices: VectorVertex[] = net.vertices.map((v) => {
      const out: VectorVertex = { x: v.x * sx, y: v.y * sy };
      const st = v.style ? vn.vertexStyles?.[v.style] : undefined;
      if (st?.handleMirroring === 'ANGLE' || st?.handleMirroring === 'ANGLE_AND_LENGTH' || st?.handleMirroring === 'NONE') out.handleMirroring = st.handleMirroring as HandleMirroring;
      if (st?.cornerRadius) out.cornerRadius = st.cornerRadius;
      if (st?.strokeCap) out.strokeCap = toCap(st.strokeCap);
      if (st?.strokeJoin === 'MITER' || st?.strokeJoin === 'BEVEL' || st?.strokeJoin === 'ROUND') out.strokeJoin = st.strokeJoin;
      return out;
    });
    const result: VectorNetwork = {
      vertices,
      segments: net.segments.map((g) =>
        !g.ts[0] && !g.ts[1] && !g.te[0] && !g.te[1]
          ? { start: g.start, end: g.end }
          : { start: g.start, end: g.end, tangentStart: { x: g.ts[0] * sx, y: g.ts[1] * sy }, tangentEnd: { x: g.te[0] * sx, y: g.te[1] * sy } },
      ),
    };
    if (net.regions.length) {
      result.regions = net.regions.map((r, i) => {
        const path = fillPaths.length === net.regions.length ? fillPaths[i] : undefined;
        // Without a path match, the rule comes from the low bit of the region style (as in files).
        const windingRule = path?.windingRule ?? (r.style & 1 ? 'NONZERO' : 'EVENODD');
        return { windingRule, loops: r.loops.map((l) => [...l]), ...(path?.fills ? { fills: path.fills } : {}) };
      });
    }
    ref = interner.value({ blob: doc.putBlob(encodeNetwork(result)) });
    networkMemo.set(key, ref);
    return ref;
  };
  const glyphMemo = new WeakMap<object, TextGlyphs | null>();
  /** JSON of default values (by node type and property) for comparison without re-serializing. */
  const defaultKeys = new Map<NodeType, Map<string, string>>();
  const defaultKey = (type: NodeType, k: string) => {
    let byKey = defaultKeys.get(type);
    if (!byKey) defaultKeys.set(type, (byKey = new Map()));
    let s = byKey.get(k);
    if (s === undefined) byKey.set(k, (s = JSON.stringify((DEFAULTS[type] as Record<string, unknown>)[k])));
    return s;
  };

  /** Glyphs are references to outlines (em, Y axis up) + position and font size; styles follow the fills. */
  const textGlyphs = (n: SceneNode): TextGlyphs | null => {
    if (n.glyphs && glyphMemo.has(n.glyphs)) return glyphMemo.get(n.glyphs)!;
    const out = buildTextGlyphs(n);
    if (n.glyphs) glyphMemo.set(n.glyphs, out && interner.value(out));
    return out && interner.value(out);
  };
  const buildTextGlyphs = (n: SceneNode): TextGlyphs | null => {
    const runs: TextGlyphs['runs'] = [];
    const runIndex = new Map<FigPaint[] | undefined, number>();
    const glyphs: TextGlyphs['glyphs'] = [];
    for (const g of n.glyphs ?? []) {
      const key = blobKey(g.blob);
      if (!key) continue;
      let run = runIndex.get(g.fills);
      if (run === undefined) {
        run = runs.length;
        runIndex.set(g.fills, run);
        runs.push(g.fills ? { fills: paints(g.fills) } : {});
      }
      glyphs.push([key, Math.round(g.x * 100) / 100, Math.round(g.y * 100) / 100, g.fontSize, run]);
    }
    return glyphs.length ? { runs, glyphs } : null;
  };

  // Instance links to main components are made after all nodes are translated (a main may come later in the file).
  // Expanded instance children in the scene have the key “outer instance key/path in main”,
  // and main component nodes have just that path.
  const idByKey = new Map<string, string>();
  const links: { id: string; symbolKey?: string; refKey?: string }[] = [];
  // Font: one shared object per family and style.
  const fonts = new Map<string, Props['fontName']>();
  const fontRef = (family: string, style: string) => {
    const key = `${family}
${style}`;
    let v = fonts.get(key);
    if (!v) fonts.set(key, (v = interner.value({ family, style })));
    return v;
  };
  // Design system: references to styles, variables and components are resolved after all nodes are
  // translated (assets live on the internal page, which is translated last).
  const dsLinks: { id: string; ds: SceneDesign; fillVars?: (string | null)[]; strokeVars?: (string | null)[]; effectVars?: (Record<string, string> | null)[] }[] = [];
  /** Asset key (style, component, set, collection, variable) → document node. */
  const assetIds = new Map<string, string>();
  /** Scene reference (“g:session:number” / “k:key”) → document node. */
  const resolveRef = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    const id = ref.startsWith('g:') ? idByKey.get(ref.slice(2)) : ref.startsWith('k:') ? assetIds.get(ref.slice(2)) : undefined;
    return id && doc.has(id) ? id : undefined;
  };
  /** Paint bindings, per translated paint (unsupported ones are skipped). */
  const alignVars = <T>(list: { type?: string }[], vars: (T | null)[] | undefined, keep: (x: never) => boolean): (T | null)[] | undefined => {
    if (!vars) return undefined;
    const out: (T | null)[] = [];
    list.forEach((p, i) => {
      if (keep(p as never)) out.push(vars[i] ?? null);
    });
    return out.some((v) => v) ? out : undefined;
  };
  /** Style, collection or variable (internal page): no geometry, own properties. */
  const convertResource = (n: SceneNode, parent: string, type: 'STYLE' | 'VARIABLE_COLLECTION' | 'VARIABLE'): string => {
    const ds = n.ds ?? {};
    const props: Record<string, unknown> = { name: n.name };
    if (ds.key) props.key = ds.key;
    if (ds.description) props.description = ds.description;
    const src = n.source ?? {};
    if (type === 'STYLE') {
      props.styleType = ds.styleType ?? 'PAINT';
      if (ds.styleType === 'PAINT') props.fills = paints(n.fills);
      else if (ds.styleType === 'EFFECT') props.effects = effects(n.effects);
      else if (ds.styleType === 'GRID') props.layoutGrids = gridsOf(src.layoutGrids);
      else if (ds.styleType === 'TEXT') {
        if (src.fontFamily) props.fontName = fontRef(src.fontFamily, src.fontStyle ?? 'Regular');
        if (src.fontSize) props.fontSize = src.fontSize;
        const t = textStyleProps(src) as Record<string, unknown>;
        for (const k of ['lineHeight', 'letterSpacing', 'textCase', 'textDecoration']) if (t[k] !== undefined) props[k] = t[k];
        const x = textExtraProps(src.textExtra) as Record<string, unknown>;
        for (const k of TEXT_STYLE_EXTRA) if (x[k] !== undefined) props[k] = x[k];
      }
    } else if (type === 'VARIABLE_COLLECTION') {
      const modes = ds.collectionModes ?? [];
      props.modes = modes;
      if (modes[0]) props.defaultModeId = modes[0].modeId;
    } else {
      const v = ds.variable;
      props.resolvedType = VARIABLE_TYPES[v?.type ?? ''] ?? 'FLOAT';
      if (v?.scopes) props.scopes = v.scopes;
      if (v?.codeSyntax) props.codeSyntax = v.codeSyntax;
    }
    const id = doc.create(type, parent, props as Props);
    report.nodes++;
    idByKey.set(n.key, id);
    if (ds.key) assetIds.set(ds.key, id);
    if (type === 'VARIABLE' || ds.fillVars || ds.effectVars) {
      dsLinks.push({ id, ds, fillVars: alignVars(n.fills, ds.fillVars, convertible), effectVars: alignVars(n.effects, ds.effectVars, convertibleEffect) });
    }
    return id;
  };
  /** A single node without children; returns its id and the instance key for the children. */
  /** Grid track order (per scene node) for their children's cells. */
  const gridTracksOf = new Map<SceneNode, { rows: string[]; columns: string[] }>();
  /** Parent of a scene node (for grid cells). */
  const sceneParent = new Map<SceneNode, SceneNode>();
  const convertNode = (n: SceneNode, parent: string, instanceKey?: string): [string, string | undefined] => {
    const parentScene = sceneParent.get(n);
    for (const c of n.children) sceneParent.set(c, n);
    let type = TYPE_MAP[n.type] ?? (n.fillGeometry.length ? 'VECTOR' : 'FRAME');
    if (n.ds?.styleType) return [convertResource(n, parent, 'STYLE'), undefined];
    if (type === 'VARIABLE' || type === 'VARIABLE_COLLECTION') return [convertResource(n, parent, type), undefined];
    if (n.ds?.isStateGroup) type = 'COMPONENT_SET';
    if (n.children.length && !CONTAINERS.has(type)) type = 'FRAME';
    const src = n.source ?? {};
    const props: Props = {
      name: n.name,
      visible: n.visible,
      opacity: n.opacity,
      blendMode: n.blendMode as BlendMode,
      width: n.size.x,
      height: n.size.y,
      fills: paints(n.fills),
      strokes: paints(n.strokes),
      effects: effects(n.effects),
      isMask: n.isMask,
    };
    if (CONTAINERS.has(type)) props.clipsContent = n.clipsContent;
    // Mask type: in the file OUTLINE means “vector” (by shape).
    if (n.isMask && (n.maskType === 'OUTLINE' || n.maskType === 'VECTOR')) props.maskType = 'VECTOR';
    else if (n.isMask && n.maskType === 'LUMINANCE') props.maskType = 'LUMINANCE';
    if (src.cornerRadius !== undefined) props.cornerRadius = src.cornerRadius;
    if (src.layoutGrids) {
      const grids = gridsOf(src.layoutGrids);
      if (grids.length) props.layoutGrids = grids;
    }
    if (src.horizontalConstraint || src.verticalConstraint) {
      const c = (v: string | undefined): ConstraintType => (v === 'CENTER' || v === 'MAX' || v === 'STRETCH' || v === 'SCALE' ? v : v === 'FIXED_MAX' ? 'MAX' : 'MIN');
      const constraints = { horizontal: c(src.horizontalConstraint), vertical: c(src.verticalConstraint) };
      if (constraints.horizontal !== 'MIN' || constraints.vertical !== 'MIN') props.constraints = constraints;
    }
    if (src.cornerRadii) [props.topLeftRadius, props.topRightRadius, props.bottomRightRadius, props.bottomLeftRadius] = src.cornerRadii;
    if (src.strokeWeight !== undefined) props.strokeWeight = src.strokeWeight;
    if (src.videoPlayback) {
      const v = src.videoPlayback;
      props.videoPlayback = { autoplay: v.autoplay !== false, loop: v.mediaLoop !== false, muted: v.muted === true };
    }
    // Variable weight: weights in .fig are fractions of half the stroke (the profile scales with the weight),
    // position is a length fraction. Field meanings follow the Draw description: no samples in the example files.
    if (src.variableWidthPoints?.length) {
      const half = (src.strokeWeight ?? 1) / 2;
      const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
      props.variableWidthPoints = src.variableWidthPoints
        .map((w) => ({ position: Math.max(0, Math.min(1, num(w.position, 0))), ascent: round(num(w.ascent, 1) * half), descent: round(num(w.descent, 1) * half) }))
        .sort((a, b) => a.position - b.position);
    }
    if (src.strokeAlign) props.strokeAlign = src.strokeAlign as Props['strokeAlign'];
    if (src.strokeJoin === 'BEVEL' || src.strokeJoin === 'ROUND') props.strokeJoin = src.strokeJoin;
    if (src.dashPattern) props.dashPattern = src.dashPattern;
    if (src.strokeWeights) [props.strokeTopWeight, props.strokeRightWeight, props.strokeBottomWeight, props.strokeLeftWeight] = src.strokeWeights;
    if (src.miterLimit !== undefined) props.strokeMiterLimit = src.miterLimit;
    if (src.cornerSmoothing) props.cornerSmoothing = src.cornerSmoothing;
    // Caps: the node has a shared one; vector network vertices have their own (vertex style → style table row).
    const nodeCap = toCap(src.strokeCap);
    if (nodeCap !== 'NONE') props.strokeStartCap = props.strokeEndCap = nodeCap;
    const vn = src.vectorNetwork;
    if (vn && (type === 'VECTOR' || type === 'LINE') && n.strokes.length) {
      const ns = vn.normalizedSize;
      const c = centers(vn.blob, ns?.x ? n.size.x / ns.x : 1, ns?.y ? n.size.y / ns.y : 1);
      // The renderer builds vector strokes along centerlines (for a line, from its parameters).
      if (type === 'VECTOR' && c.paths.length) props.centerPaths = c.paths;
      const capOf = (style: number) => (style && vn.vertexCaps?.[style] !== undefined ? toCap(vn.vertexCaps[style]) : nodeCap);
      const start = mostCommon(c.starts.map(capOf));
      const end = mostCommon(c.ends.map(capOf));
      if (start !== undefined) props.strokeStartCap = start;
      if (end !== undefined) props.strokeEndCap = end;
    }
    if (src.pointCount !== undefined) props.pointCount = src.pointCount;
    // Ellipse arc, unless it is a full ellipse without a hole (2π in .fig is float32).
    if (type === 'ELLIPSE' && src.arcData) {
      const a = src.arcData;
      if (Math.abs(a.startingAngle) > 1e-6 || Math.abs(a.endingAngle - Math.PI * 2) > 1e-5 || a.innerRadius > 0) props.arcData = { ...a };
    }
    if (type === 'STAR' && src.starInnerScale !== undefined) props.innerRadius = src.starInnerScale;
    if (src.exportSettings) props.exportSettings = src.exportSettings.map(exportSettingOf).filter((x): x is ExportSetting => !!x);
    if (src.annotations) {
      const list = src.annotations.map(annotationOf).filter((a): a is Annotation => !!a);
      if (list.length) props.annotations = list;
    }
    if (src.sectionStatus) {
      const st = devStatusOf(src.sectionStatus);
      if (st) props.devStatus = st;
    }
    if (type === 'TEXT') {
      props.characters = src.characters ?? '';
      if (src.fontSize) props.fontSize = src.fontSize;
      if (src.fontFamily) props.fontName = fontRef(src.fontFamily, src.fontStyle ?? 'Regular');
      props.textAutoResize = src.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'WIDTH_AND_HEIGHT' : src.textAutoResize === 'HEIGHT' ? 'HEIGHT' : 'NONE';
      Object.assign(props, textStyleProps(src));
      Object.assign(props, textExtraProps(src.textExtra));
      // Range styles (characterStyleIDs + styleOverrideTable) and list paragraphs.
      const runs = textRunsOf(src, (list) => paints(list as FigPaint[]), fontRef);
      if (runs.length) props.textRuns = runs;
      const tg = textGlyphs(n);
      if (tg) props.textGlyphs = tg;
    } else {
      const fillPaths = sharedPaths(n.fillGeometry);
      if (fillPaths.length) props.vectorPaths = fillPaths;
      // The vector network is the source of truth for editing (prebuilt paths remain for drawing).
      const vn = src.vectorNetwork;
      if (vn && type === 'VECTOR') {
        const ref = vectorNetworkRef(vn, n, fillPaths);
        if (ref) props.vectorNetwork = ref;
      }
    }
    if (src.stack) {
      Object.assign(props, stackProps(src.stack, CONTAINERS_AL.has(type)));
      // Grid: track order for children's cells; a child's cell follows the parent's tracks.
      if (props.layoutMode === 'GRID') gridTracksOf.set(n, gridTrackOrder(src.stack));
      const parentTracks = parentScene ? gridTracksOf.get(parentScene) : undefined;
      if (parentTracks) Object.assign(props, gridChildProps(src.stack, parentTracks));
    }
    const strokePaths = sharedPaths(n.strokeGeometry);
    if (strokePaths.length) props.strokePaths = strokePaths;
    // Default values are not stored (the model returns them itself). geometrySize is not needed:
    // paths are computed at the current size; the model records it on the first resize.
    // Object values are shared (one serialization per unique value).
    const defaults = DEFAULTS[type] as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // The matrix is unique for almost every node, so it is not shared (serialization costs more than it saves).
    const t = n.transform;
    if (t[0] !== 1 || t[1] !== 0 || t[2] !== 0 || t[3] !== 0 || t[4] !== 1 || t[5] !== 0) out.transform = Object.freeze([t[0], t[1], t[2], t[3], t[4], t[5]]);
    for (const k in props) {
      const v = (props as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (v !== null && typeof v === 'object') {
        const shared = interner.value(v);
        if (k in defaults && interner.key(shared) === defaultKey(type, k)) continue;
        out[k] = shared;
      } else if (!(k in defaults) || v !== defaults[k]) out[k] = v;
    }
    const ds = n.ds;
    // Scrolling and overlay (without references, right away).
    if (ds?.overflow) out.overflowDirection = ds.overflow;
    if (ds?.scrollBehavior) out.scrollBehavior = ds.scrollBehavior === 'FIXED_WHEN_CHILD_OF_SCROLLING_FRAME' ? 'FIXED' : 'STICKY_SCROLLS';
    if (ds?.overlay) {
      const o = ds.overlay;
      if (o.position && o.position !== 'CENTER') out.overlayPositionType = o.position;
      if (o.background?.type === 'SOLID_COLOR' && o.background.color) out.overlayBackground = { type: 'SOLID_COLOR', color: o.background.color };
      if (o.interaction === 'CLOSE_ON_CLICK_OUTSIDE') out.overlayBackgroundInteraction = 'CLOSE_ON_CLICK_OUTSIDE';
    }
    if (ds?.key && (type === 'COMPONENT' || type === 'COMPONENT_SET')) out.key = ds.key;
    if (ds?.description && (type === 'COMPONENT' || type === 'COMPONENT_SET')) out.description = ds.description;
    const id = doc.create(type, parent, out as Props);
    report.nodes++;
    idByKey.set(n.key, id);
    if (ds?.key && (type === 'COMPONENT' || type === 'COMPONENT_SET')) assetIds.set(ds.key, id);
    if (ds && (ds.props || ds.propRefs || ds.propValues || ds.styles || ds.vars || ds.fillVars || ds.strokeVars || ds.effectVars || ds.modes || ds.interactions || ds.flow)) {
      dsLinks.push({ id, ds, fillVars: alignVars(n.fills, ds.fillVars, convertible), strokeVars: alignVars(n.strokes, ds.strokeVars, convertible), effectVars: alignVars(n.effects, ds.effectVars, convertibleEffect) });
    }
    const refKey = instanceKey ? n.key.slice(instanceKey.length + 1) : undefined;
    if (type === 'INSTANCE' || refKey) links.push({ id, symbolKey: type === 'INSTANCE' ? src.symbolKey : undefined, refKey });
    return [id, instanceKey ?? (type === 'INSTANCE' ? n.key : undefined)];
  };
  const convert = (n: SceneNode, parent: string, instanceKey?: string): string => {
    const [id, childKey] = convertNode(n, parent, instanceKey);
    if (doc.type(id) === 'STYLE' || doc.type(id) === 'VARIABLE' || doc.type(id) === 'VARIABLE_COLLECTION') return id;
    for (const c of n.children) convert(c, id, childKey);
    return id;
  };
  /** Paste: the asset already exists in the document, so scene nodes reference it (children in order, if the structure matches). */
  const mapExisting = (n: SceneNode, id: string) => {
    idByKey.set(n.key, id);
    if (n.ds?.key) assetIds.set(n.ds.key, id);
    const kids = doc.children(id);
    if (kids.length !== n.children.length) return;
    n.children.forEach((c, i) => mapExisting(c, kids[i]!));
  };
  /**
   * The same subtree in portions (background loading): depth-first traversal with an explicit stack, ~500
   * nodes per transaction step. Child order is preserved: a sibling is created after the older sibling's subtree.
   */
  function* convertSteps(root: SceneNode, parent: string): Generator<void, void, void> {
    const stack: [SceneNode, string, string | undefined][] = [[root, parent, undefined]];
    while (stack.length) {
      doc.transact(() => {
        for (let budget = 500; budget > 0 && stack.length; budget--) {
          const [n, p, key] = stack.pop()!;
          if (!doc.has(p)) continue;
          const [id, childKey] = convertNode(n, p, key);
          const t = doc.type(id);
          if (t === 'STYLE' || t === 'VARIABLE' || t === 'VARIABLE_COLLECTION') continue;
          for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i]!, id, childKey]);
        }
      }, 'import');
      yield;
    }
  }

  /**
   * Design system: references to styles and variables, component property definitions and values,
   * collection modes. Variables first (into their collections), then the other nodes.
   */
  /** Flow starts (on screens), later moved to pages, in order. */
  const flows: { id: string; name: string; description?: string; position: string }[] = [];
  const linkFlows = () => {
    const byPage = new Map<string, typeof flows>();
    for (const f of flows) {
      if (!doc.has(f.id)) continue;
      // A flow start belongs only to a screen (a frame on a page or in a section).
      const p = doc.parent(f.id);
      const pt = p ? doc.type(p) : undefined;
      if (pt !== 'PAGE' && pt !== 'SECTION') continue;
      let page: string | null = f.id;
      while (page && doc.type(page) !== 'PAGE') page = doc.parent(page);
      // The internal page (library mains) is not for presentation.
      if (!page || doc.get(page, 'internal')) continue;
      const list = byPage.get(page) ?? [];
      list.push(f);
      byPage.set(page, list);
    }
    for (const [page, list] of byPage) {
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
      const prev = doc.get(page, 'flowStartingPoints') ?? [];
      const next = [...prev.filter((p) => !list.some((f) => f.id === p.nodeId)), ...list.map((f) => ({ nodeId: f.id, name: f.name, ...(f.description ? { description: f.description } : {}) }))];
      doc.set(page, { flowStartingPoints: next });
    }
    flows.length = 0;
  };
  const linkDesign = (list: typeof dsLinks) => {
    for (const l of list) {
      const v = l.ds.variable;
      if (!v || !doc.has(l.id)) continue;
      const coll = resolveRef(v.collection);
      if (coll && doc.type(coll) === 'VARIABLE_COLLECTION' && doc.parent(l.id) !== coll) doc.move(l.id, coll);
      const valuesByMode: Record<string, VariableValue> = {};
      for (const [m, raw] of Object.entries(v.values)) {
        if (raw && typeof raw === 'object' && 'alias' in raw) {
          const target = resolveRef((raw as { alias: string }).alias);
          if (target) valuesByMode[m] = alias(target);
        } else valuesByMode[m] = raw as VariableValue;
      }
      doc.set(l.id, { valuesByMode });
    }
    for (const l of list) {
      if (!doc.has(l.id)) continue;
      const ds = l.ds;
      const props: Record<string, unknown> = {};
      for (const [f, ref] of Object.entries(ds.styles ?? {})) {
        const s = resolveRef(ref);
        if (s && doc.type(s) === 'STYLE') props[f] = s;
      }
      const varId = (ref: string | null | undefined) => {
        const v = ref ? resolveRef(ref) : undefined;
        return v && doc.type(v) === 'VARIABLE' ? v : undefined;
      };
      if (ds.vars) {
        const bv: Record<string, { type: 'VARIABLE_ALIAS'; id: string }> = {};
        for (const [field, ref] of Object.entries(ds.vars)) {
          const v = varId(ref);
          if (v) bv[field] = alias(v);
        }
        if (Object.keys(bv).length) props.boundVariables = bv;
      }
      const bindPaints = (key: 'fills' | 'strokes', vars: (string | null)[] | undefined) => {
        if (!vars) return;
        const list = doc.get(l.id, key) ?? [];
        let changed = false;
        const next = list.map((p, i) => {
          const v = varId(vars[i]);
          if (!v || p.type !== 'SOLID') return p;
          changed = true;
          return { ...p, boundVariables: { color: alias(v) } };
        });
        if (changed) props[key] = next;
      };
      bindPaints('fills', l.fillVars);
      bindPaints('strokes', l.strokeVars);
      if (l.effectVars) {
        const list = doc.get(l.id, 'effects') ?? [];
        let changed = false;
        const next = list.map((e, i) => {
          if (e.type === 'UNSUPPORTED_FIGMA') return e;
          const m = l.effectVars![i];
          if (!m) return e;
          const bv: Record<string, { type: 'VARIABLE_ALIAS'; id: string }> = {};
          for (const [f, ref] of Object.entries(m)) {
            const v = varId(ref);
            if (v && (f === 'radius' || e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')) bv[f] = alias(v);
          }
          if (!Object.keys(bv).length) return e;
          changed = true;
          return { ...e, boundVariables: bv } as Effect;
        });
        if (changed) props.effects = next;
      }
      if (ds.propRefs) props.componentPropertyReferences = ds.propRefs;
      if (ds.propValues) {
        const vals: Record<string, string | boolean> = {};
        for (const [k, v] of Object.entries(ds.propValues)) {
          if (v.bool !== undefined) vals[k] = v.bool;
          else if (v.text !== undefined) vals[k] = v.text;
          else if (v.symbol) {
            const c = idByKey.get(v.symbol);
            if (c && doc.has(c)) vals[k] = c;
          }
        }
        if (Object.keys(vals).length) props.componentProperties = vals;
      }
      if (ds.props) {
        // The default variant is the top-left one in the set.
        let defaults: Record<string, string> = {};
        if (doc.type(l.id) === 'COMPONENT_SET') {
          const variants = doc.children(l.id).filter((c) => doc.type(c) === 'COMPONENT');
          const pos = (c: string) => doc.get(c, 'transform') ?? [1, 0, 0, 0, 1, 0];
          const first = [...variants].sort((a, b) => pos(a)[5] - pos(b)[5] || pos(a)[2] - pos(b)[2])[0];
          if (first) defaults = parseVariantName(doc.get(first, 'name') ?? '');
        }
        const defs: Record<string, ComponentPropertyDefinition> = {};
        for (const p of ds.props) {
          const preferred = p.preferred?.map((k) => assetIds.get(k)).filter((x): x is string => !!x);
          const extra = { ...(preferred?.length ? { preferredValues: preferred } : {}), ...(p.description ? { description: p.description } : {}) };
          if (p.type === 'VARIANT') defs[p.key] = { type: 'VARIANT', defaultValue: defaults[p.key] ?? p.options?.[0] ?? '', variantOptions: p.options ?? [], ...extra };
          else if (p.type === 'BOOLEAN') defs[p.key] = { type: 'BOOLEAN', defaultValue: p.bool !== false, ...extra };
          else if (p.type === 'TEXT') defs[p.key] = { type: 'TEXT', defaultValue: p.text ?? '', ...extra };
          else if (p.type === 'INSTANCE_SWAP') defs[p.key] = { type: 'INSTANCE_SWAP', defaultValue: (p.symbol && idByKey.get(p.symbol)) || '', ...extra };
          else defs[p.key] = { type: 'SLOT', defaultValue: '', ...(p.min ? { minChildren: p.min } : {}), ...(p.max ? { maxChildren: p.max } : {}), ...extra };
        }
        props.componentPropertyDefinitions = defs;
      }
      if (ds.interactions) {
        const reactions = reactionsOfFig(ds.interactions, {
          node: (g) => {
            const k = guidKey(g);
            if (k === '4294967295:4294967295' || k === '0:0') return null;
            const id = idByKey.get(k);
            return id && doc.has(id) ? id : null;
          },
          variable: (ref) => varId(assetRefOf(ref as never)) ?? null,
          collection: (ref) => {
            const c = resolveRef(assetRefOf(ref as never));
            return c && doc.type(c) === 'VARIABLE_COLLECTION' ? c : null;
          },
        });
        if (reactions.length) props.reactions = reactions;
      }
      if (ds.flow) flows.push({ id: l.id, ...ds.flow });
      if (ds.modes) {
        const modes: Record<string, string> = {};
        for (const [ref, mode] of Object.entries(ds.modes)) {
          const c = resolveRef(ref);
          if (c && doc.type(c) === 'VARIABLE_COLLECTION') modes[c] = mode;
        }
        if (Object.keys(modes).length) props.explicitVariableModes = modes;
      }
      if (Object.keys(props).length) doc.set(l.id, props as Props);
    }
  };

  /**
   * Main component links and overrides: whatever differs from the main on import is changed
   * in the instance (otherwise editing the main would wipe out, for example, labels on all buttons).
   * Values are shared (Interner), so equal ones compare by reference. Fields bound
   * to component properties are not overrides (property values define them).
   */
  /** final: false — the main may be on a page not translated yet; such links are deferred. */
  /**
   * Main component node by path in the instance. A swapped nested instance has no path in the main:
   * its children copy nodes of the new component, so we look for the longest known path suffix.
   */
  const masterOf = (refKey: string): string | undefined => {
    const direct = idByKey.get(refKey);
    if (direct) return direct;
    const parts = refKey.split('/');
    for (let i = 1; i < parts.length; i++) {
      const id = idByKey.get(parts.slice(i).join('/'));
      if (id) return id;
    }
    return undefined;
  };
  /** Nested instance copies: component swap is marked after all links (the main may come later). */
  const nestedCopies: string[] = [];
  const markSwaps = () => {
    for (const id of nestedCopies) {
      if (!doc.has(id)) continue;
      const ref = doc.get(id, 'componentRef');
      if (!ref || !doc.has(ref) || doc.get(id, 'componentId') === doc.get(ref, 'componentId')) continue;
      if (doc.get(id, 'componentPropertyReferences')?.mainComponent) continue;
      const ov = doc.get(id, 'overrides') ?? [];
      if (!ov.includes('componentId')) doc.set(id, { overrides: [...ov, 'componentId'] });
    }
    nestedCopies.length = 0;
  };
  const linkList = (list: typeof links, final: boolean): typeof links => {
    const later: typeof links = [];
    for (const l of list) {
      if (!doc.has(l.id)) continue;
      if (!final && ((l.symbolKey && !idByKey.has(l.symbolKey)) || (l.refKey && !idByKey.has(l.refKey)))) {
        later.push(l);
        continue;
      }
      const props: Props = {};
      if (l.symbolKey) {
        const c = idByKey.get(l.symbolKey);
        if (c && doc.type(c) === 'COMPONENT') props.componentId = c;
      }
      if (l.refKey) {
        const m = masterOf(l.refKey);
        if (m) props.componentRef = m;
        if (m && l.symbolKey) nestedCopies.push(l.id);
      }
      const master = props.componentRef ?? props.componentId;
      if (!master) continue;
      const isRoot = !props.componentRef;
      const own = doc.node(l.id)!.props as Record<string, unknown>;
      const theirs = doc.node(master)!.props as Record<string, unknown>;
      const refs = (own.componentPropertyReferences ?? {}) as Record<string, string>;
      const bound = new Set([refs.visible ? 'visible' : '', refs.characters ? 'characters' : '', refs.characters ? 'textRuns' : '', refs.characters ? 'textGlyphs' : ''].filter(Boolean));
      const overrides: string[] = [];
      for (const k of new Set([...Object.keys(own), ...Object.keys(theirs)])) {
        if (k === 'componentRef' || k === 'componentId' || k === 'overrides' || bound.has(k) || (isRoot && ROOT_OWN.has(k))) continue;
        // Component: its definitions, key and description never belong to an instance.
        if (isRoot && (k === 'componentPropertyDefinitions' || k === 'key' || k === 'description')) continue;
        const a = own[k];
        const b = theirs[k];
        if (a === b || (a && b && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b))) continue;
        overrides.push(k);
      }
      if (overrides.length) props.overrides = overrides;
      doc.set(l.id, props);
    }
    return later;
  };
  // Page frame statuses and measurements reference nodes, so they go after all nodes are translated.
  const devLinks: { page: string; handoff?: { key: string; info: Record<string, unknown> }[]; measurements?: Record<string, unknown>[] }[] = [];
  const linkDev = () => {
    for (const l of devLinks.splice(0)) {
      if (!doc.has(l.page)) continue;
      for (const h of l.handoff ?? []) {
        const id = idByKey.get(h.key);
        const st = devStatusOf(h.info);
        if (id && st && doc.has(id) && !doc.get(id, 'devStatus')) doc.set(id, { devStatus: st });
      }
      const list: Measurement[] = [];
      for (const m of l.measurements ?? []) {
        const a = idByKey.get(guidKey(m.fromNode));
        const b = idByKey.get(guidKey(m.toNode));
        const side = SIDES[String(m.fromNodeSide)];
        if (!a || !b || !side) continue;
        const inner = typeof m.innerOffsetRelative === 'number';
        list.push({
          id: guidKey(m.id),
          start: { node: a, side },
          end: { node: b, side: m.toSameSide ? side : OPPOSITE[side] },
          offset: inner ? { type: 'INNER', relative: m.innerOffsetRelative as number } : { type: 'OUTER', fixed: typeof m.outerOffsetFixed === 'number' ? m.outerOffsetFixed : 16 },
          freeText: typeof m.freeText === 'string' ? m.freeText : '',
        });
      }
      if (list.length) doc.set(l.page, { measurements: list });
    }
  };

  const linkInstances = (final = true) => {
    // Design system references come before comparing with mains (otherwise reference differences would be overrides).
    if (final) {
      linkDesign(dsLinks);
      dsLinks.length = 0;
      linkFlows();
      linkDev();
    }
    const later = linkList(links, final);
    links.length = 0;
    links.push(...later);
    if (final) markSwaps();
  };

  const roots: string[] = [];
  const pageIds: string[] = [];
  // File import is not a user edit and does not enter the undo history; paste does.
  doc.transact(() => {
    if (opts.into) {
      for (const page of scene.pages) if (!page.internal) for (const n of page.children) roots.push(convert(n, opts.into));
      // Pasted assets (mains, styles, variables) go to the internal page; already known ones (by key) are reused.
      const internal = scene.pages.filter((p) => p.internal);
      if (internal.length) {
        const existing = new Map<string, string>();
        let resources: string | null = null;
        for (const p of doc.children(doc.root)) {
          if (!doc.get(p, 'internal') || doc.get(p, 'commentsPage')) continue;
          resources = p;
          for (const id of doc.descendants(p)) {
            const k = doc.get(id, 'key');
            if (k) existing.set(k, id);
          }
        }
        for (const page of internal) {
          for (const n of page.children) {
            const known = n.ds?.key ? existing.get(n.ds.key) : undefined;
            if (known) {
              mapExisting(n, known);
              continue;
            }
            resources ??= doc.create('PAGE', doc.root, { name: 'Ресурсы', internal: true });
            convert(n, resources);
          }
        }
      }
      linkInstances();
      return;
    }
    for (const page of scene.pages) {
      const bg = page.backgroundColor;
      // Prototype presentation device and background.
      const device = page.prototypeDevice;
      const proto: Props = {};
      if (device?.type && device.type !== 'NONE') {
        proto.prototypeDevice = { type: device.type as 'PRESET' | 'CUSTOM' | 'PRESENTATION', ...(device.size ? { size: { width: device.size.x, height: device.size.y } } : {}), ...(device.presetIdentifier ? { presetIdentifier: device.presetIdentifier } : {}), ...(device.rotation === 'CCW_90' ? { rotation: 'CCW_90' as const } : {}) };
      } else if (device?.type === 'NONE') proto.prototypeDevice = { type: 'NONE' };
      if (page.prototypeBackground) proto.prototypeBackgrounds = [{ type: 'SOLID', color: { r: page.prototypeBackground.r, g: page.prototypeBackground.g, b: page.prototypeBackground.b } }];
      const pageId = doc.create('PAGE', doc.root, {
        ...proto,
        name: page.internal ? 'Ресурсы' : page.name,
        backgrounds: bg ? [{ type: 'SOLID', color: { r: bg.r, g: bg.g, b: bg.b } }] : [],
        ...(page.internal ? { internal: true } : {}),
      });
      pageIds.push(pageId);
      if (page.modes) dsLinks.push({ id: pageId, ds: { modes: page.modes } });
      if (page.handoff || page.measurements) devLinks.push({ page: pageId, handoff: page.handoff, measurements: page.measurements });
      if (!page.internal) report.pages++;
    }
    // Annotation categories belong to the document (on paste, only if it has none of its own).
    if (scene.annotationCategories && !doc.get(doc.root, 'annotationCategories')?.length) doc.set(doc.root, { annotationCategories: categoriesOf(scene.annotationCategories) });
    scene.pages.forEach((page, i) => {
      if (opts.lazy && i > 0) return;
      for (const n of page.children) convert(n, pageIds[i]!);
    });
    linkInstances(!opts.lazy);
  }, opts.into ? 'paste' : 'import');
  report.ms = performance.now() - t0;
  // Remaining pages: one top-level node per step (the caller decides when to step).
  const more = opts.lazy
    ? (function* () {
        for (let i = 1; i < scene.pages.length; i++) {
          const page = scene.pages[i]!;
          const size = page.size ?? page.children.length;
          for (let j = 0; j < size; j++) {
            if (!doc.has(pageIds[i]!)) break;
            const n = page.buildChild ? page.buildChild(j) : page.children[j]!;
            // Building the scene of a large frame is a separate step; translation takes its own steps.
            yield;
            if (n && doc.has(pageIds[i]!)) yield* convertSteps(n, pageIds[i]!);
          }
        }
        // Design system references (before main component links) and the links themselves, in portions: there are tens of thousands of them.
        const design = dsLinks.splice(0);
        // Variables go into their collections before the other references (modes and bindings look up collections).
        design.sort((a, b) => (a.ds.variable ? 0 : 1) - (b.ds.variable ? 0 : 1));
        for (let k = 0; k < design.length; k += 500) {
          doc.transact(() => linkDesign(design.slice(k, k + 500)), 'import');
          yield;
        }
        doc.transact(linkFlows, 'import');
        doc.transact(linkDev, 'import');
        const pending = links.splice(0);
        for (let k = 0; k < pending.length; k += 500) {
          doc.transact(() => linkList(pending.slice(k, k + 500), true), 'import');
          yield;
        }
        doc.transact(markSwaps, 'import');
      })()
    : undefined;
  return { doc, report, roots, ids: idByKey, more };
}

/** Layout grids from .fig (type, axis, pattern STRIPES / GRID, numSections, …) → model. */
function gridsOf(list: Record<string, unknown>[] | undefined): LayoutGrid[] {
  const grids: LayoutGrid[] = [];
  for (const g of list ?? []) {
    const color = g.color as { r: number; g: number; b: number; a: number } | undefined;
    const common = { visible: g.visible !== false, ...(color ? { color: { r: color.r, g: color.g, b: color.b, a: color.a } } : {}) };
    const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    if (g.pattern === 'GRID') grids.push({ pattern: 'GRID', sectionSize: num(g.sectionSize, 10), ...common });
    else {
      const t = g.type;
      grids.push({
        pattern: g.axis === 'Y' ? 'ROWS' : 'COLUMNS',
        alignment: t === 'MIN' || t === 'MAX' || t === 'CENTER' ? t : 'STRETCH',
        count: num(g.numSections, 1),
        gutterSize: num(g.gutterSize),
        sectionSize: num(g.sectionSize),
        offset: num(g.offset),
        ...common,
      });
    }
  }
  return grids;
}

/**
 * Text formatting from .fig → model (units as in the plugin API).
 * In the file, “Auto” line height is stored as PERCENT 100 (percent of font metrics),
 * and an explicit percent of font size as a RAW multiplier.
 */
/** Piece style differences from the .fig table (same fields as the node's) → model TextStyle. */
function textOverrideStyle(o: Record<string, unknown>, paintsOf: (list: unknown[]) => Paint[], fontRef: (family: string, style: string) => Props['fontName']): TextStyle {
  const s: TextStyle = {};
  const fn = o.fontName as { family?: string; style?: string } | undefined;
  if (fn?.family) s.fontName = fontRef(fn.family, fn.style ?? 'Regular');
  if (typeof o.fontSize === 'number' && o.fontSize > 0) s.fontSize = o.fontSize;
  if (Array.isArray(o.fillPaints)) s.fills = paintsOf(o.fillPaints);
  // Line height and letter spacing, case, decorations — same as for the node (textStyleProps).
  const base = textStyleProps({ lineHeight: o.lineHeight, letterSpacing: o.letterSpacing, textCase: o.textCase, textDecoration: o.textDecoration } as NonNullable<SceneNode['source']>);
  if (o.lineHeight) s.lineHeight = base.lineHeight ?? { unit: 'AUTO' };
  if (o.letterSpacing) s.letterSpacing = base.letterSpacing ?? { unit: 'PERCENT', value: 0 };
  if (typeof o.textCase === 'string') s.textCase = base.textCase ?? 'ORIGINAL';
  if (typeof o.textDecoration === 'string') s.textDecoration = base.textDecoration ?? 'NONE';
  const link = o.hyperlink as { url?: string; guid?: unknown } | undefined;
  if (link?.url) s.hyperlink = { type: 'URL', value: link.url };
  const ot = openTypeOf(o);
  if (ot) s.openTypeFeatures = ot;
  Object.assign(s, decorationAndAxes(o));
  return s;
}

/** Text pieces: style of each character (0 — node style) → TextRun; lists per paragraph. */
function textRunsOf(src: NonNullable<SceneNode['source']>, paintsOf: (list: unknown[]) => Paint[], fontRef: (family: string, style: string) => Props['fontName']): TextRun[] {
  const characters = src.characters ?? '';
  const length = characters.length;
  let runs: TextRun[] = [];
  const ids = src.textStyleIds;
  const table = src.textStyleTable;
  if (ids?.length && table) {
    const styles = new Map<number, TextStyle>();
    const styleOf = (id: number) => {
      let s = styles.get(id);
      if (!s) styles.set(id, (s = id && table[id] ? textOverrideStyle(table[id]!, paintsOf, fontRef) : {}));
      return s;
    };
    // characterStyleIDs per character in code points? In samples it is per UTF-16 unit; extras are dropped.
    for (let i = 0; i < Math.min(ids.length, length); ) {
      let j = i + 1;
      while (j < Math.min(ids.length, length) && ids[j] === ids[i]) j++;
      runs.push({ length: j - i, style: styleOf(ids[i] ?? 0) });
      i = j;
    }
    runs = normalizeRuns(runs, length);
  }
  // Paragraphs: list type and level apply to the whole paragraph.
  const lines = src.textLines;
  if (lines?.length) {
    let pos = 0;
    const paras = characters.split('\n');
    paras.forEach((p, i) => {
      const l = lines[i];
      const type = l?.lineType === 'ORDERED_LIST' ? 'ORDERED' : l?.lineType === 'UNORDERED_LIST' ? 'UNORDERED' : 'NONE';
      const level = Math.max(0, (l?.indentationLevel ?? 0) - (type === 'NONE' ? 0 : 1));
      if (type !== 'NONE' || level > 0) runs = styleRange(runs, length, pos, pos + p.length + (i < paras.length - 1 ? 1 : 0), { listType: type, indentation: level });
      pos += p.length + 1;
    });
  }
  return runs;
}

/** .fig number (value, units) → model underline thickness or offset; RAW is a fraction of font size. */
function decorationLength(v: unknown): DecorationThickness | undefined {
  const n = v as { value?: number; units?: string } | undefined;
  if (!n || typeof n.value !== 'number' || !Number.isFinite(n.value)) return undefined;
  if (n.units === 'PIXELS') return { unit: 'PIXELS', value: round(n.value) };
  return { unit: 'PERCENT', value: round(n.units === 'PERCENT' ? n.value : n.value * 100) };
}

/** .fig variable font axes: the tag is four bytes as a number (wght = 0x77676874). */
function fontVariationsOf(v: unknown): FontVariation[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FontVariation[] = [];
  for (const x of v as { axisTag?: number; value?: number }[]) {
    if (typeof x.axisTag !== 'number' || typeof x.value !== 'number' || !Number.isFinite(x.value)) continue;
    const t = x.axisTag >>> 0;
    out.push({ axis: String.fromCharCode(t >>> 24, (t >>> 16) & 255, (t >>> 8) & 255, t & 255), value: round(x.value) });
  }
  return out.length ? out : undefined;
}

/** Underline formatting and font axes (node and piece share the same .fig fields). */
function decorationAndAxes(o: Record<string, unknown>): TextStyle {
  const s: TextStyle = {};
  if (o.textDecorationStyle === 'WAVY' || o.textDecorationStyle === 'DOTTED' || o.textDecorationStyle === 'SOLID') s.textDecorationStyle = o.textDecorationStyle;
  const thick = decorationLength(o.textDecorationThickness);
  if (thick) s.textDecorationThickness = thick;
  const offset = decorationLength(o.textUnderlineOffset);
  if (offset) s.textDecorationOffset = offset;
  if (typeof o.textDecorationSkipInk === 'boolean') s.textDecorationSkipInk = o.textDecorationSkipInk;
  if (Array.isArray(o.textDecorationFillPaints)) {
    const p = (o.textDecorationFillPaints as { type?: string; visible?: boolean; opacity?: number; color?: { r: number; g: number; b: number; a?: number } }[]).find((x) => x.type === 'SOLID' && x.visible !== false && x.color);
    s.textDecorationColor = p?.color ? { r: p.color.r, g: p.color.g, b: p.color.b, a: (p.color.a ?? 1) * (p.opacity ?? 1) } : 'AUTO';
  }
  const axes = fontVariationsOf(o.fontVariations);
  if (axes) s.fontVariations = axes;
  return s;
}

/** OpenType features from fontVariant* fields and the .fig lists of enabled / disabled features. */
function openTypeOf(o: Record<string, unknown>): Record<string, boolean> | null {
  const f: Record<string, boolean> = {};
  if (o.fontVariantCommonLigatures === false) f.liga = false;
  if (o.fontVariantContextualLigatures === false) f.calt = false;
  if (o.fontVariantDiscretionaryLigatures === true) f.dlig = true;
  if (o.fontVariantHistoricalLigatures === true) f.hlig = true;
  if (o.fontVariantOrdinal === true) f.ordn = true;
  if (o.fontVariantSlashedZero === true) f.zero = true;
  if (o.fontVariantNumericFigure === 'OLDSTYLE') f.onum = true;
  if (o.fontVariantNumericFigure === 'LINING') f.lnum = true;
  if (o.fontVariantNumericSpacing === 'TABULAR') f.tnum = true;
  if (o.fontVariantNumericSpacing === 'PROPORTIONAL') f.pnum = true;
  if (o.fontVariantNumericFraction === 'DIAGONAL') f.frac = true;
  if (o.fontVariantPosition === 'SUPER') f.sups = true;
  if (o.fontVariantPosition === 'SUB') f.subs = true;
  for (const t of (o.toggledOnOTFeatures as string[] | undefined) ?? []) if (typeof t === 'string') f[t.toLowerCase()] = true;
  for (const t of (o.toggledOffOTFeatures as string[] | undefined) ?? []) if (typeof t === 'string') f[t.toLowerCase()] = false;
  return Object.keys(f).length ? f : null;
}

/** Node text properties outside styles: truncation, paragraphs, OpenType, link. */
function textExtraProps(x: Record<string, unknown> | undefined): Props {
  const props: Props = {};
  if (!x) return props;
  if (x.leadingTrim === 'CAP_HEIGHT') props.leadingTrim = 'CAP_HEIGHT';
  if (x.textTruncation === 'ENDING') props.textTruncation = 'ENDING';
  if (typeof x.maxLines === 'number' && x.maxLines > 0) props.maxLines = x.maxLines;
  if (typeof x.paragraphSpacing === 'number' && x.paragraphSpacing > 0) props.paragraphSpacing = x.paragraphSpacing;
  if (typeof x.paragraphIndent === 'number' && x.paragraphIndent > 0) props.paragraphIndent = x.paragraphIndent;
  if (typeof x.listSpacing === 'number' && x.listSpacing > 0) props.listSpacing = x.listSpacing;
  if (x.hangingPunctuation === true) props.hangingPunctuation = true;
  if (x.hangingList === true) props.hangingList = true;
  const ot = openTypeOf(x);
  if (ot) props.openTypeFeatures = ot;
  if (x.fontVariantCaps === 'SMALL') props.textCase = 'SMALL_CAPS';
  if (x.fontVariantCaps === 'ALL_SMALL') props.textCase = 'SMALL_CAPS_FORCED';
  const link = x.hyperlink as { url?: string } | undefined;
  if (link?.url) props.hyperlink = { type: 'URL', value: link.url };
  Object.assign(props, decorationAndAxes(x));
  if (props.textDecorationStyle === 'SOLID') delete props.textDecorationStyle;
  return props;
}

function textStyleProps(src: NonNullable<SceneNode['source']>): Props {
  const props: Props = {};
  const ah = src.textAlignHorizontal;
  if (ah === 'CENTER' || ah === 'RIGHT' || ah === 'JUSTIFIED') props.textAlignHorizontal = ah;
  const av = src.textAlignVertical;
  if (av === 'CENTER' || av === 'BOTTOM') props.textAlignVertical = av;
  const lh = src.lineHeight;
  if (lh && Number.isFinite(lh.value)) {
    if (lh.units === 'PIXELS') props.lineHeight = { unit: 'PIXELS', value: round(lh.value) };
    else if (lh.units === 'RAW') props.lineHeight = { unit: 'PERCENT', value: round(lh.value * 100) };
    else if (lh.units === 'PERCENT' && Math.abs(lh.value - 100) > 0.01) props.lineHeight = { unit: 'PERCENT', value: round(lh.value * 1.2) };
  }
  const ls = src.letterSpacing;
  if (ls && Number.isFinite(ls.value) && ls.value !== 0) {
    if (ls.units === 'PIXELS') props.letterSpacing = { unit: 'PIXELS', value: round(ls.value) };
    else props.letterSpacing = { unit: 'PERCENT', value: round(ls.units === 'RAW' ? ls.value * 100 : ls.value) };
  }
  const tcase = src.textCase;
  if (tcase === 'UPPER' || tcase === 'LOWER' || tcase === 'TITLE') props.textCase = tcase;
  const td = src.textDecoration;
  if (td === 'UNDERLINE' || td === 'STRIKETHROUGH') props.textDecoration = td;
  return props;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Types that can have auto layout. */
const CONTAINERS_AL = new Set(['FRAME', 'COMPONENT', 'INSTANCE']);

/**
 * Auto layout from .fig stack* fields → model properties (as in the plugin API).
 * Missing stackPrimarySizing in .fig = “hug”; RESIZE_TO_FIT* = “hug”.
 */
function stackProps(s: Record<string, unknown>, container: boolean): Props {
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const props: Props = {};
  // Auto layout child properties.
  if (num(s.stackChildPrimaryGrow) > 0) props.layoutGrow = 1;
  if (s.stackChildAlignSelf === 'STRETCH') props.layoutAlign = 'STRETCH';
  if (s.stackPositioning === 'ABSOLUTE') props.layoutPositioning = 'ABSOLUTE';
  // min/max limits: the sample files have none; we assume 0 (or a non-number) means “no limit”.
  const limit = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const min = (s.minSize as { value?: { x?: number; y?: number } } | undefined)?.value;
  const max = (s.maxSize as { value?: { x?: number; y?: number } } | undefined)?.value;
  if (limit(min?.x) !== undefined) props.minWidth = limit(min?.x)!;
  if (limit(min?.y) !== undefined) props.minHeight = limit(min?.y)!;
  if (limit(max?.x) !== undefined && max!.x! < 1e6) props.maxWidth = limit(max?.x)!;
  if (limit(max?.y) !== undefined && max!.y! < 1e6) props.maxHeight = limit(max?.y)!;
  if (!container || (s.stackMode !== 'HORIZONTAL' && s.stackMode !== 'VERTICAL' && s.stackMode !== 'GRID')) return props;
  props.layoutMode = s.stackMode;
  props.itemSpacing = num(s.stackSpacing);
  if (typeof s.stackCounterSpacing === 'number' && Number.isFinite(s.stackCounterSpacing)) props.counterAxisSpacing = s.stackCounterSpacing;
  props.paddingLeft = num(s.stackHorizontalPadding, num(s.stackPadding));
  props.paddingTop = num(s.stackVerticalPadding, num(s.stackPadding));
  props.paddingRight = num(s.stackPaddingRight);
  props.paddingBottom = num(s.stackPaddingBottom);
  const pa = s.stackPrimaryAlignItems;
  // In .fig, “distribute” is SPACE_EVENLY (the old name); the new modes (2026) are
  // SPACE_BETWEEN, SPACE_AROUND and SPACE_EVENLY_CSS.
  props.primaryAxisAlignItems =
    pa === 'CENTER' || pa === 'MAX' ? pa : pa === 'SPACE_BETWEEN' || pa === 'SPACE_EVENLY' ? 'SPACE_BETWEEN' : pa === 'SPACE_AROUND' ? 'SPACE_AROUND' : pa === 'SPACE_EVENLY_CSS' ? 'SPACE_EVENLY' : 'MIN';
  if (s.bordersTakeSpace === true) props.strokesIncludedInLayout = true;
  if (s.stackMode === 'GRID') {
    props.layoutMode = 'GRID';
    const order = gridTrackOrder(s);
    const sizes = (map: unknown, ids: string[]): GridTrackSize[] => {
      const byId = new Map<string, GridTrackSize>();
      for (const e of ((map as { entries?: { key?: unknown; value?: { maxSizing?: { type?: string; value?: number } } }[] })?.entries ?? [])) {
        const m = e.value?.maxSizing;
        const type = m?.type === 'FIXED' || m?.type === 'HUG' ? m.type : 'FLEX';
        byId.set(guidKey(e.key), { type, ...(typeof m?.value === 'number' ? { value: m.value } : {}) });
      }
      return ids.map((id) => byId.get(id) ?? { type: 'FLEX', value: 1 });
    };
    props.gridRowSizes = sizes(s.gridRowsSizing, order.rows);
    props.gridColumnSizes = sizes(s.gridColumnsSizing, order.columns);
    props.gridRowGap = num(s.gridRowGap);
    props.gridColumnGap = num(s.gridColumnGap);
  }
  if (s.stackReverseZIndex === true) props.itemReverseZIndex = true;
  const ca = s.stackCounterAlignItems;
  props.counterAxisAlignItems = ca === 'CENTER' || ca === 'MAX' || ca === 'BASELINE' ? ca : 'MIN';
  props.primaryAxisSizingMode = s.stackPrimarySizing === undefined || String(s.stackPrimarySizing).startsWith('RESIZE_TO_FIT') ? 'AUTO' : 'FIXED';
  props.counterAxisSizingMode = String(s.stackCounterSizing ?? '').startsWith('RESIZE_TO_FIT') ? 'AUTO' : 'FIXED';
  if (s.stackWrap === 'WRAP') props.layoutWrap = 'WRAP';
  if (s.stackCounterAlignContent === 'SPACE_BETWEEN') props.counterAxisAlignContent = 'SPACE_BETWEEN';
  return props;
}

/** GUID key from .fig (“session:number”). */
function guidKey(g: unknown): string {
  const x = g as { sessionID?: number; localID?: number } | undefined;
  return `${x?.sessionID ?? 0}:${x?.localID ?? 0}`;
}

/** Grid track order: GUIDPositionMap entries by position (fractional index), otherwise by entry order. */
function gridTrackOrder(s: Record<string, unknown>): { rows: string[]; columns: string[] } {
  const order = (map: unknown): string[] => {
    const entries = ((map as { entries?: { key?: unknown; value?: unknown; position?: unknown }[] })?.entries ?? []).map((e, i) => ({ id: guidKey(e.key), pos: String((e.value as { position?: unknown })?.position ?? e.position ?? e.value ?? ''), i }));
    return entries.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.i - b.i)).map((e) => e.id);
  };
  return { rows: order(s.gridRows), columns: order(s.gridColumns) };
}

/** Cell, span and alignment of a grid child along the parent's tracks. */
function gridChildProps(s: Record<string, unknown>, tracks: { rows: string[]; columns: string[] }): Props {
  const props: Props = {};
  if (s.gridRowAnchor) props.gridRowAnchorIndex = tracks.rows.indexOf(guidKey(s.gridRowAnchor));
  if (s.gridColumnAnchor) props.gridColumnAnchorIndex = tracks.columns.indexOf(guidKey(s.gridColumnAnchor));
  if (typeof s.gridRowSpan === 'number' && s.gridRowSpan > 1) props.gridRowSpan = s.gridRowSpan;
  if (typeof s.gridColumnSpan === 'number' && s.gridColumnSpan > 1) props.gridColumnSpan = s.gridColumnSpan;
  const al = (v: unknown) => (v === 'MIN' || v === 'CENTER' || v === 'MAX' ? v : undefined);
  if (al(s.gridChildHorizontalAlign)) props.gridChildHorizontalAlign = al(s.gridChildHorizontalAlign);
  if (al(s.gridChildVerticalAlign)) props.gridChildVerticalAlign = al(s.gridChildVerticalAlign);
  return props;
}
