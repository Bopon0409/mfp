// Building the render tree from a decoded .fig.
//
// What we do:
// - build the tree by parentIndex and sort children by fractional index;
// - expand instances: in the file an INSTANCE has no children; they must be cloned
//   from the SYMBOL with overrides (symbolOverrides) and derived data applied
//   (derivedSymbolData: sizes, transforms, geometry, glyphs after resize);
// - use the geometry and glyphs Figma precomputed, which gives an
//   exact picture without our own layout engine and without fonts.
//
// This is an intermediate tree for viewing. The MFP document model will be separate.

import type {
  FigAssetRef,
  FigEffect,
  FigGlyph,
  FigGuid,
  FigMatrix,
  FigMessage,
  FigNodeChange,
  FigPaint,
  FigPath,
  FigVariableData,
  FigVector,
} from './types.ts';

/** Affine matrix [m00, m01, m02, m10, m11, m12]: x' = m00·x + m01·y + m02. */
export type Matrix2D = [number, number, number, number, number, number];

export interface SceneGeometry {
  windingRule: 'NONZERO' | 'EVENODD';
  blob: number;
  /** Per-path fills (a vector network region with its own fill); absent — the node fills. */
  fills?: FigPaint[];
}

export interface SceneGlyph {
  blob: number;
  x: number;
  y: number;
  fontSize: number;
  /** Fills for a glyph if the character has its own style; otherwise the node fills. */
  fills: FigPaint[] | undefined;
}

export interface SceneNode {
  key: string;
  type: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  transform: Matrix2D;
  /** 3D rotation: layer projection in its own coordinates (3×3 row-major), applied after transform. */
  persp?: number[];
  size: FigVector;
  fills: FigPaint[];
  strokes: FigPaint[];
  fillGeometry: SceneGeometry[];
  strokeGeometry: SceneGeometry[];
  /** Centerlines for a custom stroke (vectors from import); absent — stroke along fillGeometry. */
  strokeSource?: SceneGeometry[];
  /** How far the stroke extends beyond the node size (for bounds without parsing paths). */
  strokeOutset?: number;
  effects: FigEffect[];
  clipsContent: boolean;
  isMask: boolean;
  /** Children stacking order is reversed: the first is on top. */
  reverseZ?: boolean;
  /** Content scroll (prototype presentation): children are offset by -scroll. */
  scroll?: { x: number; y: number };
  maskType: string;
  glyphs: SceneGlyph[] | undefined;
  children: SceneNode[];
  /** Text laid out by the renderer itself (created or edited in the editor) rather than prebuilt glyphs. */
  textLayout?: SceneTextLayout;
  /** Text animation at moment time (timeline pose): per-piece effect. */
  textAnim?: { by: string; effect: string; start: number; duration: number; stagger: number; easing?: unknown; time: number };
  /** Text on a path: SVG path (node coordinates), line start offset, path stretch. */
  textPath?: { data: string; offset: number; sx?: number; sy?: number };
  /**
   * Stroke that the renderer builds from the node shape (for shapes created in the editor);
   * imported nodes use the prebuilt strokeGeometry path instead.
   */
  strokeStyle?: SceneStrokeStyle;
  /**
   * Stroke alignment. The prebuilt .fig stroke (strokeGeometry) for “inside” and “outside” is a
   * center stroke of double weight: the renderer clips it with the node shape (that is how the file defines it).
   */
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  /** Design system: style, component and its properties, bindings to styles and variables (for import). */
  ds?: SceneDesign;
  /** Source parameters needed when importing into the document model (not for rendering). */
  source?: {
    characters?: string;
    fontSize?: number;
    fontFamily?: string;
    fontStyle?: string;
    cornerRadius?: number;
    /** Layout grids as in .fig (type, axis, pattern STRIPES / GRID, numSections, …). */
    layoutGrids?: Record<string, unknown>[];
    /** Constraints (MIN / CENTER / MAX / STRETCH / SCALE; FIXED_* are legacy variants of MIN / MAX). */
    horizontalConstraint?: string;
    verticalConstraint?: string;
    /** Per-corner radii [tl, tr, br, bl] if set individually. */
    cornerRadii?: [number, number, number, number];
    strokeWeight?: number;
    /** Layer video in presentation: autoplay, looped, muted. */
    videoPlayback?: { autoplay?: boolean; mediaLoop?: boolean; muted?: boolean };
    /** Variable stroke weight: width points (.fig: position, left and right weight, segment). */
    variableWidthPoints?: { position?: number; ascent?: number; descent?: number; segmentId?: number }[];
    strokeAlign?: string;
    strokeJoin?: string;
    dashPattern?: number[];
    /** Per-side weights [top, right, bottom, left] if set individually. */
    strokeWeights?: [number, number, number, number];
    strokeCap?: string;
    miterLimit?: number;
    cornerSmoothing?: number;
    /** Vector network: blob, the size its coordinates are defined in, and vertex styles (caps). */
    vectorNetwork?: {
      blob: number;
      normalizedSize?: { x: number; y: number };
      vertexCaps?: Record<number, string>;
      /** Vertex styles from the table: handle mirroring, corner radius, caps, join. */
      vertexStyles?: Record<number, { handleMirroring?: string; cornerRadius?: number; strokeCap?: string; strokeJoin?: string }>;
    };
    pointCount?: number;
    /** Ellipse: arc (angles in radians, inner radius ratio). */
    arcData?: { startingAngle: number; endingAngle: number; innerRadius: number };
    /** Star: inner radius ratio. */
    starInnerScale?: number;
    /** Layer export settings (as in the file). */
    exportSettings?: Record<string, unknown>[];
    /** Developer mode: annotations and status (section or frame), as in the file. */
    annotations?: Record<string, unknown>[];
    sectionStatus?: Record<string, unknown>;
    textAutoResize?: string;
    textAlignHorizontal?: string;
    textAlignVertical?: string;
    lineHeight?: { value: number; units: string };
    letterSpacing?: { value: number; units: string };
    textCase?: string;
    textDecoration?: string;
    /** Range styles: the style of each character (0 — the node's) and the table of style differences (.fig fields as is). */
    textStyleIds?: number[];
    textStyleTable?: Record<number, Record<string, unknown>>;
    /** Paragraphs (textData.lines): list type and nesting level. */
    textLines?: { lineType?: string; indentationLevel?: number }[];
    /** Other .fig text fields as is (truncation, paragraphs, OpenType). */
    textExtra?: Record<string, unknown>;
    /** Auto layout (.fig stack* fields as is; translated by to-core). */
    stack?: Record<string, unknown>;
    /** Instance: scene key of its main component (symbol). */
    symbolKey?: string;
  };
}

/**
 * File asset references: “g:session:number” (local, by guid) or “k:key” (from a library,
 * by asset key). Component property keys follow the Plugin API: “name#id” (id is the definition's
 * on the variant set); for variants, just the name.
 */
export interface SceneDesign {
  /** Style node on the internal canvas. */
  styleType?: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  /** Asset key (style, component, set, collection, variable). */
  key?: string;
  description?: string;
  /** Variant set (FRAME with isStateGroup). */
  isStateGroup?: boolean;
  /** Variant set or component: property definitions. */
  props?: SceneProp[];
  /** Layer inside a component: field → property key. */
  propRefs?: { visible?: string; characters?: string; mainComponent?: string; slot?: string };
  /** Instance: property values (instance swap — the scene symbol key). */
  propValues?: Record<string, { bool?: boolean; text?: string; symbol?: string }>;
  /** Layer styles: model field (fillStyleId…) → reference. */
  styles?: Partial<Record<'fillStyleId' | 'strokeStyleId' | 'textStyleId' | 'effectStyleId' | 'gridStyleId', string>>;
  /** Layer fields bound to variables: model field → variable reference. */
  vars?: Record<string, string>;
  /** Paint colors from variables, per paint as in the file (null — no variable). */
  fillVars?: (string | null)[];
  strokeVars?: (string | null)[];
  /** Effect fields from variables, per effect as in the file. */
  effectVars?: (Record<string, string> | null)[];
  /** Layer collection modes: collection reference → mode. */
  modes?: Record<string, string>;
  /** Variable collection: modes in order. */
  collectionModes?: { modeId: string; name: string }[];
  /** Variable: collection, type, per-mode values (a reference is { alias: reference }), scopes, syntax. */
  variable?: { collection: string; type: string; values: Record<string, unknown>; scopes?: string[]; codeSyntax?: Record<string, string> };
  /** Prototype: interactions (.fig fields as is, without deleted ones), flow start, scrolling, overlay. */
  interactions?: Record<string, unknown>[];
  flow?: { name: string; description?: string; position: string };
  overflow?: string;
  scrollBehavior?: string;
  overlay?: { position?: string; background?: { type?: string; color?: { r: number; g: number; b: number; a: number } }; interaction?: string };
}

export interface SceneProp {
  key: string;
  type: 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP' | 'VARIANT' | 'SLOT';
  bool?: boolean;
  text?: string;
  /** Default instance swap: scene symbol key. */
  symbol?: string;
  /** Variant: values in order. */
  options?: string[];
  /** Preferred components and sets (component keys). */
  preferred?: string[];
  min?: number;
  max?: number;
  description?: string;
}

/** .fig fields (VariableField) → model fields that can be bound to a variable. */
const VARIABLE_FIELDS: Record<string, string> = {
  CORNER_RADIUS: 'cornerRadius',
  PARAGRAPH_SPACING: 'paragraphSpacing',
  PARAGRAPH_INDENT: 'paragraphIndent',
  STROKE_WEIGHT: 'strokeWeight',
  STACK_SPACING: 'itemSpacing',
  STACK_PADDING_LEFT: 'paddingLeft',
  STACK_PADDING_TOP: 'paddingTop',
  STACK_PADDING_RIGHT: 'paddingRight',
  STACK_PADDING_BOTTOM: 'paddingBottom',
  VISIBLE: 'visible',
  TEXT_DATA: 'characters',
  WIDTH: 'width',
  HEIGHT: 'height',
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: 'topLeftRadius',
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: 'topRightRadius',
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: 'bottomLeftRadius',
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: 'bottomRightRadius',
  BORDER_TOP_WEIGHT: 'strokeTopWeight',
  BORDER_BOTTOM_WEIGHT: 'strokeBottomWeight',
  BORDER_LEFT_WEIGHT: 'strokeLeftWeight',
  BORDER_RIGHT_WEIGHT: 'strokeRightWeight',
  STACK_COUNTER_SPACING: 'counterAxisSpacing',
  MIN_WIDTH: 'minWidth',
  MAX_WIDTH: 'maxWidth',
  MIN_HEIGHT: 'minHeight',
  MAX_HEIGHT: 'maxHeight',
  FONT_FAMILY: 'fontFamily',
  FONT_STYLE: 'fontStyle',
  OPACITY: 'opacity',
  FONT_SIZE: 'fontSize',
  LETTER_SPACING: 'letterSpacing',
  LINE_HEIGHT: 'lineHeight',
  GRID_ROW_GAP: 'gridRowGap',
  GRID_COLUMN_GAP: 'gridColumnGap',
};

/** Asset reference: “g:…” is local, “k:…” is from a library. */
export function assetRef(r: FigAssetRef | undefined): string | undefined {
  if (!r) return undefined;
  if (r.guid) return `g:${r.guid.sessionID}:${r.guid.localID}`;
  return r.assetRef?.key ? `k:${r.assetRef.key}` : undefined;
}

/** Variable the field is bound to (VariableData with alias). */
const varOf = (vd: FigVariableData | undefined): string | undefined => (vd?.dataType === 'ALIAS' || vd?.value?.alias ? assetRef(vd?.value?.alias) : undefined);

/** Variable value from .fig: boolean, number, string, color or reference. */
function variableValue(vd: FigVariableData | undefined): unknown {
  const v = vd?.value;
  if (!v) return undefined;
  if (v.alias) {
    const ref = assetRef(v.alias);
    return ref ? { alias: ref } : undefined;
  }
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (typeof v.floatValue === 'number') return v.floatValue;
  if (typeof v.textValue === 'string') return v.textValue;
  if (v.colorValue) return { r: v.colorValue.r, g: v.colorValue.g, b: v.colorValue.b, a: v.colorValue.a ?? 1 };
  return undefined;
}

const STYLE_TYPES: Record<string, SceneDesign['styleType']> = { FILL: 'PAINT', STROKE: 'PAINT', TEXT: 'TEXT', EFFECT: 'EFFECT', GRID: 'GRID' };
const PROP_TYPES: Record<string, SceneProp['type']> = { BOOL: 'BOOLEAN', TEXT: 'TEXT', INSTANCE_SWAP: 'INSTANCE_SWAP', VARIANT: 'VARIANT', SLOT: 'SLOT' };

interface FigPropDef {
  id?: FigGuid;
  name?: string;
  type?: string;
  isDeleted?: boolean;
  parentPropDefId?: FigGuid;
  initialValue?: FigPropValue;
  sortPosition?: string;
  description?: string;
  preferredValues?: { instanceSwapValues?: { type?: string; key?: string }[] };
  slotPropConfig?: { minChildren?: number; maxChildren?: number };
}

export interface SceneStrokeStyle {
  weight: number;
  align: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  join: 'MITER' | 'BEVEL' | 'ROUND';
  /** Dash pattern: dash and gap lengths, px; empty — solid. */
  dashes: number[];
  /** Per-side weights [top, right, bottom, left] (rectangles and frames). */
  sides?: [number, number, number, number];
  /** Open path caps (StrokeCap); absent — NONE. */
  startCap?: string;
  endCap?: string;
  miterLimit?: number;
  /** Corner radii [tl, tr, br, bl] for per-side strokes. */
  radii?: [number, number, number, number];
  /** Path trim: visible part of the stroke as length fractions [start, end]. */
  trim?: [number, number];
  /** Variable weight: width points (length fraction; left and right weight, px). */
  widths?: { position: number; ascent: number; descent: number }[];
  /** Brush (rendered along the centerline): type, preset name, scatter and dynamics settings. */
  brush?: {
    type: 'STRETCH' | 'SCATTER' | 'DYNAMIC';
    name: string;
    spacing?: number;
    scatter?: number;
    sizeJitter?: number;
    rotationJitter?: number;
    frequency?: number;
    wiggle?: number;
    seed?: number;
  };
}

const STACK_KEYS = [
  'stackMode',
  'stackSpacing',
  'stackCounterSpacing',
  'stackPadding',
  'stackHorizontalPadding',
  'stackVerticalPadding',
  'stackPaddingRight',
  'stackPaddingBottom',
  'stackPrimaryAlignItems',
  'stackCounterAlignItems',
  'stackPrimarySizing',
  'stackCounterSizing',
  'stackWrap',
  'stackCounterAlignContent',
  'stackChildPrimaryGrow',
  'stackChildAlignSelf',
  'stackPositioning',
  'bordersTakeSpace',
  'stackReverseZIndex',
  'gridRows',
  'gridColumns',
  'gridRowsSizing',
  'gridColumnsSizing',
  'gridRowGap',
  'gridColumnGap',
  'gridRowAnchor',
  'gridColumnAnchor',
  'gridRowSpan',
  'gridColumnSpan',
  'gridChildHorizontalAlign',
  'gridChildVerticalAlign',
  // Size limits (OptionalVector { value: { x, y } }).
  'minSize',
  'maxSize',
];

/** Auto layout fields of the node (both as a container and as an auto layout child), if any. */
function stackFields(nc: Record<string, unknown>): Record<string, unknown> | undefined {
  // Fast check: without these fields the node is neither an auto layout container nor its child.
  if (nc.stackMode === undefined && nc.stackChildPrimaryGrow === undefined && nc.stackChildAlignSelf === undefined && nc.stackPositioning === undefined && nc.minSize === undefined && nc.maxSize === undefined && nc.gridRowAnchor === undefined && nc.gridColumnAnchor === undefined) return undefined;
  let out: Record<string, unknown> | undefined;
  for (const k of STACK_KEYS) {
    if (nc[k] === undefined) continue;
    (out ??= {})[k] = nc[k];
  }
  return out;
}

/**
 * How far the stroke extends beyond the node size: outside — by the weight, center — by half;
 * with a 2× margin for sharp corners with a miter join.
 */
export function strokeOutsetOf(strokes: { visible?: boolean }[] | undefined, weight: unknown, align: unknown): number {
  if (!strokes?.some((s) => s.visible !== false) || typeof weight !== 'number' || weight <= 0) return 0;
  return align === 'INSIDE' ? 0 : align === 'OUTSIDE' ? weight * 2 : weight;
}

/** Layout parameters for text laid out by the renderer itself. */
export type SceneTextCase = 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';

/** Text piece with its resolved formatting [start, end) (UTF-16 code units). */
export interface SceneTextRun {
  start: number;
  end: number;
  family: string;
  style: string;
  fontSize: number;
  /** Letter spacing, px. */
  letterSpacing: number;
  /** Line height as a multiple of the font size; absent — from font metrics. */
  lineHeight?: number;
  textCase: SceneTextCase;
  decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  decorationStyle?: 'SOLID' | 'WAVY' | 'DOTTED';
  /** Underline thickness, px (absent — from the font). */
  decorationThickness?: number;
  decorationColor?: { r: number; g: number; b: number; a: number };
  /** Underline: offset of the line top from the baseline, px (absent — from the font); false — no skipping of descenders. */
  decorationOffset?: number;
  skipInk?: false;
  /** Variable font axes. */
  variations?: { axis: string; value: number }[];
  /** Own color of the piece; absent — the node fill color. */
  color?: { r: number; g: number; b: number; a: number };
  /** OpenType features: tag → on/off. */
  features?: Record<string, boolean>;
  /** The piece is a link. */
  link?: boolean;
}

export interface SceneTextLayout {
  characters: string;
  /** Node formatting (of the first piece) for simple consumers (SVG export). */
  fontSize: number;
  family: string;
  style: string;
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  alignV: 'TOP' | 'CENTER' | 'BOTTOM';
  /** Hug width; otherwise the node width. */
  autoWidth: boolean;
  /** Line height as a multiple of the font size; absent — from font metrics. */
  lineHeight?: number;
  /** Letter spacing, px. */
  letterSpacing: number;
  textCase: SceneTextCase;
  decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  /** Pieces with resolved formatting (the whole text in sequence); absent — the whole text uses the formatting above. */
  runs?: SceneTextRun[];
  /** Paragraphs: list type and level (by the first character of the paragraph); absent — no lists. */
  paragraphs?: { listType: 'NONE' | 'ORDERED' | 'UNORDERED'; indentation: number }[];
  paragraphSpacing?: number;
  paragraphIndent?: number;
  listSpacing?: number;
  /** At most this many lines (with “…” at the end if ellipsis). */
  maxLines?: number;
  ellipsis?: boolean;
  /** Block sized by the cap height of the first line and the baseline of the last. */
  leadingTrim?: boolean;
  /** Line wrapping: balance line lengths (BALANCE) or avoid a lone word at the end (PRETTY). */
  wrap?: 'BALANCE' | 'PRETTY';
  /** Hanging punctuation (quotes and brackets past the block edge) and hanging list markers. */
  hangingPunctuation?: boolean;
  hangingList?: boolean;
  /**
   * Shrink text until it fits the block (our own feature): the smallest font size ratio (0–1). Only for
   * fixed-size blocks; font sizes, spacing and indents shrink together.
   */
  fit?: number;
}

export interface ScenePage {
  key: string;
  name: string;
  /** Internal canvas of the file (styles, variables, library component mains). */
  internal?: boolean;
  /** Page prototype settings: presentation device and background. */
  prototypeDevice?: { type?: string; size?: { x: number; y: number }; presetIdentifier?: string; rotation?: string };
  prototypeBackground?: { r: number; g: number; b: number; a: number };
  /** Page variable collection modes: collection reference → mode. */
  modes?: Record<string, string>;
  /** Developer mode: page frame statuses (node key → status) and measurements, as in the file. */
  handoff?: { key: string; info: Record<string, unknown> }[];
  measurements?: Record<string, unknown>[];
  backgroundColor: { r: number; g: number; b: number; a: number } | undefined;
  /** Built on first access (large files: one page is needed first). */
  children: SceneNode[];
  /** Number of top-level nodes (without building). */
  readonly size?: number;
  /** Build one top-level node (loading a page in portions); null — skipped. */
  buildChild?(i: number): SceneNode | null;
}

export interface SceneStats {
  nodes: number;
  instancesExpanded: number;
  missingSymbols: number;
  overridesApplied: number;
}

export interface Scene {
  customShaders?: FigNodeChange[];
  pages: ScenePage[];
  /** Document annotation categories (as in the file). */
  annotationCategories?: Record<string, unknown>[];
  blobs: Uint8Array[];
  stats: SceneStats;
}

const IDENTITY: Matrix2D = [1, 0, 0, 0, 1, 0];
const CONTAINER_TYPES = new Set(['FRAME', 'SYMBOL', 'INSTANCE']);
/** Types not drawn on the canvas. */
const SKIPPED_TYPES = new Set(['SLICE', 'WIDGET', 'STICKY', 'CONNECTOR', 'BRUSH', 'CODE_COMPONENT']);
/** Guard against infinite recursion with cyclic instance references. */
const MAX_INSTANCE_DEPTH = 32;

export const guidKey = (g: FigGuid | undefined): string => (g ? `${g.sessionID}:${g.localID}` : '');
const pathKey = (guids: FigGuid[] | undefined): string => (guids ?? []).map(guidKey).join('/');

/**
 * Node key in instance override paths and derived data: nodes of library components
 * are addressed by their overrideKey (guid in the library), all others by guid.
 */
const refOf = (nc: FigNodeChange): FigGuid => (nc.overrideKey as FigGuid | undefined) ?? nc.guid!;

function toMatrix(m: FigMatrix | undefined): Matrix2D {
  return m ? [m.m00, m.m01, m.m02, m.m10, m.m11, m.m12] : IDENTITY;
}

function geometry(paths: FigPath[] | undefined, styles?: Map<number, FigPaint[]>): SceneGeometry[] {
  const out: SceneGeometry[] = [];
  for (const p of paths ?? []) {
    if (p.commandsBlob === undefined) continue;
    const g: SceneGeometry = { windingRule: p.windingRule === 'ODD' ? 'EVENODD' : 'NONZERO', blob: p.commandsBlob };
    const own = p.styleID ? styles?.get(p.styleID) : undefined;
    if (own) g.fills = own;
    out.push(g);
  }
  return out;
}

/** Vector network region fills: styleID → own fills (vectorData.styleOverrideTable). */
function regionFills(nc: FigNodeChange): Map<number, FigPaint[]> | undefined {
  const table = (nc.vectorData as { styleOverrideTable?: { styleID?: number; fillPaints?: FigPaint[] }[] } | undefined)?.styleOverrideTable;
  let out: Map<number, FigPaint[]> | undefined;
  for (const st of table ?? []) if (st.styleID && Array.isArray(st.fillPaints)) (out ??= new Map()).set(st.styleID, st.fillPaints);
  return out;
}

/** Override merge: override fields replace node fields (guidPath is not copied). */
function applyOverride(target: FigNodeChange, override: FigNodeChange | undefined): FigNodeChange {
  if (!override) return target;
  const merged: FigNodeChange = { ...target };
  for (const k in override) {
    if (k === 'guidPath' || k === 'guid' || k === 'parentIndex') continue;
    merged[k] = k === 'componentPropAssignments' ? mergeAssignments(target[k], override[k]) : override[k];
  }
  return merged;
}

/** Component property assignments: an override replaces only its own properties. */
function mergeAssignments(base: unknown, over: unknown): unknown {
  type A = { defID?: FigGuid };
  if (!Array.isArray(base) || !base.length || !Array.isArray(over)) return over;
  const out = new Map<string, A>();
  for (const a of base as A[]) out.set(guidKey(a.defID), a);
  for (const a of over as A[]) out.set(guidKey(a.defID), a);
  return [...out.values()];
}

/** Merge override entries with the same path (a flat object whose fields are iterated later). */
function mergeEntries(a: FigNodeChange, b: FigNodeChange): FigNodeChange {
  const m: FigNodeChange = { ...a };
  for (const k in b) if (k !== 'guidPath') m[k] = b[k];
  return m;
}

/** Instance context: its overrides and derived data, addressed by guid path. */
interface InstanceContext {
  overrides: Map<string, FigNodeChange>;
  derived: Map<string, FigNodeChange>;
  /** Path (guids) from this instance to the current nested symbol. */
  prefix: FigGuid[];
  /** Component property values of this instance (key — property definition id). */
  props?: Map<string, FigPropValue>;
}

interface FigPropValue {
  boolValue?: boolean;
  textValue?: { characters?: string; [field: string]: unknown };
  guidValue?: FigGuid;
}

interface FigPropRef {
  defID?: FigGuid;
  componentPropNodeField?: string;
}

/**
 * Component properties bound to a main component layer (visibility, nested instance swap)
 * take this instance's values. Text property values are already in the instance's derived glyphs.
 */
function applyPropRefs(nc: FigNodeChange, props: Map<string, FigPropValue> | undefined): FigNodeChange {
  const refs = nc.componentPropRefs as FigPropRef[] | undefined;
  if (!props?.size || !refs?.length) return nc;
  let out = nc;
  for (const ref of refs) {
    const v = ref.defID ? props.get(guidKey(ref.defID)) : undefined;
    if (!v) continue;
    if (ref.componentPropNodeField === 'VISIBLE' && typeof v.boolValue === 'boolean') out = { ...out, visible: v.boolValue };
    else if (ref.componentPropNodeField === 'OVERRIDDEN_SYMBOL_ID' && v.guidValue) out = { ...out, overriddenSymbolID: v.guidValue };
    else if (ref.componentPropNodeField === 'TEXT_DATA' && typeof v.textValue?.characters === 'string' && v.textValue.characters !== out.textData?.characters) {
      // Text property: glyphs are already computed in the instance's derived data; the characters are set here.
      const td = out.textData ?? {};
      const own = Array.isArray(v.textValue.characterStyleIDs);
      out = { ...out, textData: { ...td, ...v.textValue, characterStyleIDs: own ? v.textValue.characterStyleIDs as number[] : undefined } };
    }
  }
  return out;
}

function indexByPath(list: FigNodeChange[] | undefined): Map<string, FigNodeChange> {
  const map = new Map<string, FigNodeChange>();
  for (const nc of list ?? []) {
    const key = pathKey(nc.guidPath?.guids);
    // Several entries with the same path are merged: later ones override earlier ones.
    const prev = map.get(key);
    map.set(key, prev ? mergeEntries(prev, nc) : nc);
  }
  return map;
}

/** Ellipse arc from .fig (only if all three numbers are present). */
function arcDataOf(v: unknown): { startingAngle: number; endingAngle: number; innerRadius: number } | undefined {
  const a = v as { startingAngle?: unknown; endingAngle?: unknown; innerRadius?: unknown } | undefined;
  if (!a || typeof a.startingAngle !== 'number' || typeof a.endingAngle !== 'number' || typeof a.innerRadius !== 'number') return undefined;
  return { startingAngle: a.startingAngle, endingAngle: a.endingAngle, innerRadius: a.innerRadius };
}

export function buildScene(message: FigMessage): Scene {
  const nodes = message.nodeChanges ?? [];
  const blobs = (message.blobs ?? []).map((b) => b.bytes);
  const byId = new Map<string, FigNodeChange>();
  const childrenOf = new Map<string, FigNodeChange[]>();
  for (const nc of nodes) {
    if (nc.phase === 'REMOVED') continue;
    byId.set(guidKey(nc.guid), nc);
  }
  for (const nc of byId.values()) {
    if (!nc.parentIndex) continue;
    const parent = guidKey(nc.parentIndex.guid);
    let list = childrenOf.get(parent);
    if (!list) childrenOf.set(parent, (list = []));
    list.push(nc);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const pa = a.parentIndex?.position ?? '';
      const pb = b.parentIndex?.position ?? '';
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }

  const stats: SceneStats = { nodes: 0, instancesExpanded: 0, missingSymbols: 0, overridesApplied: 0 };

  // Styles. A node with a style also stores a copy of its value, but it may be stale (the library style
  // was updated), so the style's own value is drawn. Local styles are addressed by guid, library
  // styles by asset key (their copies live on the file's internal canvas).
  const stylesByGuid = new Map<string, FigNodeChange>();
  const stylesByKey = new Map<string, FigNodeChange>();
  for (const nc of byId.values()) {
    if (!nc.styleType) continue;
    stylesByGuid.set(guidKey(nc.guid), nc);
    if (typeof nc.key === 'string') stylesByKey.set(nc.key, nc);
  }
  // Component properties: variants in a set have their own definition ids referencing the set's
  // definition (parentPropDefId); property keys are built from the set id, as in the Plugin API.
  const parentDef = new Map<string, string>();
  const defInfo = new Map<string, { name: string; type: string }>();
  for (const nc of byId.values()) {
    for (const d of (nc.componentPropDefs as FigPropDef[] | undefined) ?? []) {
      if (!d.id || d.isDeleted) continue;
      if (d.parentPropDefId) parentDef.set(guidKey(d.id), guidKey(d.parentPropDefId));
      if (d.name && d.type) defInfo.set(guidKey(d.id), { name: d.name, type: d.type });
    }
  }
  const canonicalDef = (id: FigGuid): string => {
    let k = guidKey(id);
    for (let i = 0; i < 8 && parentDef.has(k); i++) k = parentDef.get(k)!;
    return k;
  };
  const propKey = (id: FigGuid | undefined): string | undefined => {
    if (!id) return undefined;
    const c = canonicalDef(id);
    const info = defInfo.get(c);
    if (!info) return undefined;
    return info.type === 'VARIANT' ? info.name : `${info.name}#${c}`;
  };
  const propDefs = (nc: FigNodeChange): SceneProp[] | undefined => {
    const defs = (nc.componentPropDefs as FigPropDef[] | undefined)?.filter((d) => d.id && !d.isDeleted && d.name && d.type && PROP_TYPES[d.type]);
    if (!defs?.length) return undefined;
    const orders = new Map(((nc.stateGroupPropertyValueOrders as { property?: string; values?: string[] }[] | undefined) ?? []).map((o) => [o.property ?? '', o.values ?? []]));
    return defs
      .sort((a, b) => ((a.sortPosition ?? '') < (b.sortPosition ?? '') ? -1 : (a.sortPosition ?? '') > (b.sortPosition ?? '') ? 1 : 0))
      .map((d) => {
        const type = PROP_TYPES[d.type!]!;
        const p: SceneProp = { key: type === 'VARIANT' ? d.name! : `${d.name}#${guidKey(d.id)}`, type };
        const iv = d.initialValue;
        if (type === 'BOOLEAN') p.bool = iv?.boolValue !== false;
        if (type === 'TEXT') p.text = iv?.textValue?.characters ?? '';
        if (type === 'INSTANCE_SWAP' && iv?.guidValue) p.symbol = guidKey(iv.guidValue);
        if (type === 'VARIANT') p.options = orders.get(d.name!) ?? [];
        const pref = d.preferredValues?.instanceSwapValues?.map((v) => v.key).filter((k): k is string => !!k);
        if (pref?.length) p.preferred = pref;
        if (type === 'SLOT') {
          if (d.slotPropConfig?.minChildren) p.min = d.slotPropConfig.minChildren;
          if (d.slotPropConfig?.maxChildren) p.max = d.slotPropConfig.maxChildren;
        }
        if (d.description) p.description = d.description;
        return p;
      });
  };
  /** Node styles, variables and component properties (from values with overrides). */
  const designOf = (nc: FigNodeChange, type: string): SceneDesign | undefined => {
    const ds: SceneDesign = {};
    if (nc.styleType && STYLE_TYPES[nc.styleType as string]) {
      ds.styleType = STYLE_TYPES[nc.styleType as string];
      if (typeof nc.key === 'string') ds.key = nc.key;
      const desc = (nc.styleDescription as string | undefined) ?? (nc.description as string | undefined);
      if (desc) ds.description = desc;
    }
    if (type === 'SYMBOL' || nc.isStateGroup) {
      if (typeof nc.componentKey === 'string') ds.key = nc.componentKey;
      const desc = (nc.symbolDescription as string | undefined) ?? (nc.description as string | undefined);
      if (desc) ds.description = desc;
      const props = propDefs(nc);
      if (props) ds.props = props;
      if (nc.isStateGroup) ds.isStateGroup = true;
    }
    const refs = nc.componentPropRefs as (FigPropRef & { isDeleted?: boolean })[] | undefined;
    if (refs?.length) {
      const out: NonNullable<SceneDesign['propRefs']> = {};
      for (const r of refs) {
        if (r.isDeleted) continue;
        const k = propKey(r.defID);
        if (!k) continue;
        if (r.componentPropNodeField === 'VISIBLE') out.visible = k;
        else if (r.componentPropNodeField === 'TEXT_DATA') out.characters = k;
        else if (r.componentPropNodeField === 'OVERRIDDEN_SYMBOL_ID') out.mainComponent = k;
        else if (r.componentPropNodeField === 'SLOT_CONTENT_ID') out.slot = k;
      }
      if (Object.keys(out).length) ds.propRefs = out;
    }
    if (type === 'INSTANCE') {
      const assigned = nc.componentPropAssignments as { defID?: FigGuid; value?: FigPropValue }[] | undefined;
      const vals: NonNullable<SceneDesign['propValues']> = {};
      for (const a of assigned ?? []) {
        const k = propKey(a.defID);
        if (!k || !a.value) continue;
        const v = a.value;
        if (typeof v.boolValue === 'boolean') vals[k] = { bool: v.boolValue };
        else if (v.textValue) vals[k] = { text: v.textValue.characters ?? '' };
        else if (v.guidValue) vals[k] = { symbol: guidKey(v.guidValue) };
      }
      if (Object.keys(vals).length) ds.propValues = vals;
    }
    if (!nc.styleType) {
      const styles: NonNullable<SceneDesign['styles']> = {};
      const set = (f: keyof typeof styles, r: unknown) => {
        const ref = assetRef(r as FigAssetRef | undefined);
        if (ref) styles[f] = ref;
      };
      set('fillStyleId', nc.styleIdForFill);
      set('strokeStyleId', nc.styleIdForStrokeFill);
      set('textStyleId', nc.styleIdForText);
      set('effectStyleId', nc.styleIdForEffect);
      set('gridStyleId', nc.styleIdForGrid);
      if (Object.keys(styles).length) ds.styles = styles;
    }
    const consumption = (nc.variableConsumptionMap as { entries?: { variableField?: string; variableData?: FigVariableData }[] } | undefined)?.entries;
    if (consumption?.length) {
      const vars: Record<string, string> = {};
      for (const e of consumption) {
        const field = e.variableField ? VARIABLE_FIELDS[e.variableField] : undefined;
        const ref = varOf(e.variableData);
        if (field && ref) vars[field] = ref;
      }
      if (Object.keys(vars).length) ds.vars = vars;
    }
    const paintVars = (list: FigPaint[] | undefined) => (list?.some((p) => p.colorVar) ? list.map((p) => varOf(p.colorVar) ?? null) : undefined);
    const fv = paintVars(nc.fillPaints);
    if (fv) ds.fillVars = fv;
    const sv = paintVars(nc.strokePaints);
    if (sv) ds.strokeVars = sv;
    if (nc.effects?.some((e) => e.colorVar || e.radiusVar || e.spreadVar || e.xVar || e.yVar)) {
      ds.effectVars = nc.effects.map((e) => {
        const m: Record<string, string> = {};
        for (const [f, vd] of [['color', e.colorVar], ['radius', e.radiusVar], ['spread', e.spreadVar], ['offsetX', e.xVar], ['offsetY', e.yVar]] as const) {
          const ref = varOf(vd);
          if (ref) m[f] = ref;
        }
        return Object.keys(m).length ? m : null;
      });
    }
    const modes = modesOf(nc);
    if (modes) ds.modes = modes;
    // Prototype.
    const interactions = (nc.prototypeInteractions as Record<string, unknown>[] | undefined)?.filter((i) => !i.isDeleted);
    if (interactions?.length) ds.interactions = interactions;
    const start = nc.prototypeStartingPoint as { name?: string; description?: string; position?: string } | undefined;
    if (start) ds.flow = { name: start.name ?? '', ...(start.description ? { description: start.description } : {}), position: start.position ?? '' };
    if (typeof nc.scrollDirection === 'string' && nc.scrollDirection !== 'NONE') ds.overflow = nc.scrollDirection;
    if (typeof nc.scrollBehavior === 'string' && nc.scrollBehavior !== 'SCROLLS') ds.scrollBehavior = nc.scrollBehavior;
    if (nc.overlayPositionType || nc.overlayBackgroundInteraction || nc.overlayBackgroundAppearance) {
      const bg = nc.overlayBackgroundAppearance as { backgroundType?: string; backgroundColor?: { r: number; g: number; b: number; a: number } } | undefined;
      ds.overlay = {
        ...(typeof nc.overlayPositionType === 'string' ? { position: nc.overlayPositionType } : {}),
        ...(bg ? { background: { type: bg.backgroundType, color: bg.backgroundColor } } : {}),
        ...(typeof nc.overlayBackgroundInteraction === 'string' ? { interaction: nc.overlayBackgroundInteraction } : {}),
      };
    }
    if (type === 'VARIABLE_SET') {
      if (typeof nc.key === 'string') ds.key = nc.key;
      const list = ((nc.variableSetModes as { id?: FigGuid; name?: string; sortPosition?: string }[] | undefined) ?? []).filter((m) => m.id);
      list.sort((a, b) => ((a.sortPosition ?? '') < (b.sortPosition ?? '') ? -1 : (a.sortPosition ?? '') > (b.sortPosition ?? '') ? 1 : 0));
      ds.collectionModes = list.map((m) => ({ modeId: guidKey(m.id), name: m.name ?? '' }));
    }
    if (type === 'VARIABLE') {
      if (typeof nc.key === 'string') ds.key = nc.key;
      const values: Record<string, unknown> = {};
      for (const e of (nc.variableDataValues as { entries?: { modeID?: FigGuid; variableData?: FigVariableData }[] } | undefined)?.entries ?? []) {
        const v = variableValue(e.variableData);
        if (e.modeID && v !== undefined) values[guidKey(e.modeID)] = v;
      }
      const codeSyntax: Record<string, string> = {};
      for (const e of (nc.codeSyntax as { entries?: { key?: string; value?: string }[] } | undefined)?.entries ?? []) if (e.key && e.value) codeSyntax[e.key] = e.value;
      ds.variable = {
        collection: assetRef(nc.variableSetID as FigAssetRef | undefined) ?? '',
        type: String(nc.variableResolvedType ?? 'FLOAT'),
        values,
        ...(Array.isArray(nc.variableScopes) ? { scopes: nc.variableScopes as string[] } : {}),
        ...(Object.keys(codeSyntax).length ? { codeSyntax } : {}),
      };
      if (nc.description) ds.description = nc.description as string;
    }
    return Object.keys(ds).length ? ds : undefined;
  };

  const styleOf = (ref: unknown): FigNodeChange | undefined => {
    if (!stylesByGuid.size || !ref) return undefined;
    const r = ref as { guid?: FigGuid; assetRef?: { key?: string } };
    if (r.guid) return stylesByGuid.get(guidKey(r.guid));
    return r.assetRef?.key ? stylesByKey.get(r.assetRef.key) : undefined;
  };

  // Instance copies reference the same source glyphs and styles and get a shared array.
  const glyphMemo = new WeakMap<FigGlyph[], WeakMap<object, SceneGlyph[]>>();
  const NO_TEXT_DATA = {};
  function textGlyphs(nc: FigNodeChange): SceneGlyph[] | undefined {
    const glyphs: FigGlyph[] | undefined = nc.derivedTextData?.glyphs ?? nc.textData?.glyphs;
    if (!glyphs?.length) return undefined;
    let byStyles = glyphMemo.get(glyphs);
    if (!byStyles) glyphMemo.set(glyphs, (byStyles = new WeakMap()));
    const styleKey = (nc.textData as object | undefined) ?? NO_TEXT_DATA;
    const cached = byStyles.get(styleKey);
    if (cached) return cached;
    const built = buildGlyphs(nc, glyphs);
    byStyles.set(styleKey, built);
    return built;
  }

  function buildGlyphs(nc: FigNodeChange, glyphs: FigGlyph[]): SceneGlyph[] {
    const styles = new Map<number, FigPaint[]>();
    for (const s of nc.textData?.styleOverrideTable ?? []) {
      const fills = (styleOf(s.styleIdForFill)?.fillPaints as FigPaint[] | undefined) ?? s.fillPaints;
      if (s.styleID !== undefined && fills) styles.set(s.styleID, fills);
    }
    const out: SceneGlyph[] = [];
    for (const g of glyphs) {
      if (g.commandsBlob === undefined || !g.position) continue;
      out.push({
        blob: g.commandsBlob,
        x: g.position.x,
        y: g.position.y,
        fontSize: g.fontSize ?? 12,
        fills: g.styleID ? styles.get(g.styleID) : undefined,
      });
    }
    return out;
  }

  function resolve(nc: FigNodeChange, contexts: InstanceContext[]): FigNodeChange {
    if (!contexts.length) return nc;
    let merged = nc;
    // Inner contexts are applied first, outer ones on top (outer ones take precedence).
    for (let i = contexts.length - 1; i >= 0; i--) {
      const ctx = contexts[i]!;
      const ref = refOf(nc);
      const o = ctx.overrides.get(pathKey([...ctx.prefix, ref])) ?? (ref !== nc.guid ? ctx.overrides.get(pathKey([...ctx.prefix, nc.guid!])) : undefined);
      if (o) stats.overridesApplied++;
      merged = applyOverride(merged, o);
    }
    for (let i = contexts.length - 1; i >= 0; i--) {
      const ctx = contexts[i]!;
      const ref = refOf(nc);
      merged = applyOverride(merged, ctx.derived.get(pathKey([...ctx.prefix, ref])) ?? (ref !== nc.guid ? ctx.derived.get(pathKey([...ctx.prefix, nc.guid!])) : undefined));
    }
    return merged;
  }

  /** Instance properties: default values (of the component or its variant set) and assigned ones. */
  function instanceProps(nc: FigNodeChange, symbol: FigNodeChange): Map<string, FigPropValue> | undefined {
    const assigned = nc.componentPropAssignments as { defID?: FigGuid; value?: FigPropValue }[] | undefined;
    const set = symbol.parentIndex ? byId.get(guidKey(symbol.parentIndex.guid)) : undefined;
    const defs = [
      ...((symbol.componentPropDefs as { id?: FigGuid; initialValue?: FigPropValue }[] | undefined) ?? []),
      ...((set?.componentPropDefs as { id?: FigGuid; initialValue?: FigPropValue }[] | undefined) ?? []),
    ];
    if (!assigned?.length && !defs.length) return undefined;
    const props = new Map<string, FigPropValue>();
    for (const d of defs) if (d.id && d.initialValue) props.set(guidKey(d.id), d.initialValue);
    for (const a of assigned ?? []) if (a.defID && a.value) props.set(guidKey(a.defID), a.value);
    return props;
  }

  function build(raw: FigNodeChange, contexts: InstanceContext[], keyPrefix: string, depth: number): SceneNode | null {
    const nc = applyPropRefs(resolve(raw, contexts), contexts[contexts.length - 1]?.props);
    const type = nc.type ?? 'UNKNOWN';
    if (SKIPPED_TYPES.has(type)) return null;
    stats.nodes++;
    const key = `${keyPrefix}${guidKey(raw.guid)}`;

    // Children on first access: a large frame (a section with tens of thousands of layers) is built as it
    // is translated into the document, in portions, rather than entirely in one background loading step.
    let children: SceneNode[] | undefined;
    const buildKids = (): SceneNode[] => {
      if (type === 'INSTANCE') {
        const symbolId = nc.overriddenSymbolID ?? nc.symbolData?.symbolID;
        const symbol = symbolId ? byId.get(guidKey(symbolId)) : undefined;
        if (!symbol) {
          stats.missingSymbols++;
          return [];
        }
        if (depth >= MAX_INSTANCE_DEPTH) return [];
        stats.instancesExpanded++;
        // Outer contexts keep addressing nodes through this instance's guid.
        const nested: InstanceContext[] = contexts.map((c) => ({ ...c, prefix: [...c.prefix, refOf(raw)] }));
        nested.push({
          overrides: indexByPath(nc.symbolData?.symbolOverrides),
          derived: indexByPath(nc.derivedSymbolData),
          prefix: [],
          props: instanceProps(nc, symbol),
        });
        return buildChildren(guidKey(symbol.guid), nested, `${key}/`, depth + 1);
      }
      // A boolean operation's result is already in its fillGeometry; operands are not drawn.
      if (type === 'BOOLEAN_OPERATION') return [];
      return buildChildren(guidKey(raw.guid), contexts, keyPrefix, depth);
    };

    return {
      key,
      type,
      name: nc.name ?? '',
      visible: nc.visible !== false,
      opacity: nc.opacity ?? 1,
      blendMode: nc.blendMode ?? 'PASS_THROUGH',
      transform: toMatrix(nc.transform),
      size: nc.size ?? { x: 0, y: 0 },
      fills: styleOf(nc.styleIdForFill)?.fillPaints ?? nc.fillPaints ?? [],
      strokes: styleOf(nc.styleIdForStrokeFill)?.fillPaints ?? nc.strokePaints ?? [],
      fillGeometry: geometry(nc.fillGeometry, type === 'VECTOR' ? regionFills(nc) : undefined),
      strokeGeometry: geometry(nc.strokeGeometry),
      strokeOutset: strokeOutsetOf(nc.strokePaints, nc.strokeWeight, nc.strokeAlign),
      strokeAlign: nc.strokeAlign === 'INSIDE' || nc.strokeAlign === 'OUTSIDE' ? nc.strokeAlign : undefined,
      effects: styleOf(nc.styleIdForEffect)?.effects ?? nc.effects ?? [],
      clipsContent: CONTAINER_TYPES.has(type) && nc.frameMaskDisabled !== true,
      reverseZ: nc.stackReverseZIndex === true || undefined,
      isMask: nc.mask === true,
      maskType: (nc.maskType as string | undefined) ?? 'ALPHA',
      glyphs: type === 'TEXT' ? textGlyphs(nc) : undefined,
      get children() {
        return (children ??= buildKids());
      },
      ds: designOf(nc, type),
      source: {
        characters: nc.textData?.characters,
        fontSize: typeof nc.fontSize === 'number' ? nc.fontSize : undefined,
        fontFamily: (nc.fontName as { family?: string } | undefined)?.family,
        fontStyle: (nc.fontName as { style?: string } | undefined)?.style,
        cornerRadius: typeof nc.cornerRadius === 'number' ? nc.cornerRadius : undefined,
        horizontalConstraint: typeof nc.horizontalConstraint === 'string' ? nc.horizontalConstraint : undefined,
        layoutGrids: Array.isArray(nc.layoutGrids) && nc.layoutGrids.length ? (nc.layoutGrids as Record<string, unknown>[]) : undefined,
        verticalConstraint: typeof nc.verticalConstraint === 'string' ? nc.verticalConstraint : undefined,
        cornerRadii: nc.rectangleCornerRadiiIndependent
          ? ([nc.rectangleTopLeftCornerRadius, nc.rectangleTopRightCornerRadius, nc.rectangleBottomRightCornerRadius, nc.rectangleBottomLeftCornerRadius].map((v) => (typeof v === 'number' ? v : 0)) as [number, number, number, number])
          : undefined,
        strokeWeight: typeof nc.strokeWeight === 'number' ? nc.strokeWeight : undefined,
        videoPlayback: nc.videoPlayback as { autoplay?: boolean; mediaLoop?: boolean; muted?: boolean } | undefined,
        variableWidthPoints: Array.isArray(nc.variableWidthPoints) && nc.variableWidthPoints.length ? (nc.variableWidthPoints as { position?: number; ascent?: number; descent?: number }[]) : undefined,
        strokeAlign: typeof nc.strokeAlign === 'string' ? nc.strokeAlign : undefined,
        strokeJoin: typeof nc.strokeJoin === 'string' ? nc.strokeJoin : undefined,
        dashPattern: Array.isArray(nc.dashPattern) && nc.dashPattern.length ? (nc.dashPattern as number[]) : undefined,
        strokeWeights: nc.borderStrokeWeightsIndependent
          ? ([nc.borderTopWeight, nc.borderRightWeight, nc.borderBottomWeight, nc.borderLeftWeight].map((v) => (typeof v === 'number' ? v : 0)) as [number, number, number, number])
          : undefined,
        strokeCap: typeof nc.strokeCap === 'string' ? nc.strokeCap : undefined,
        miterLimit: typeof nc.miterLimit === 'number' ? nc.miterLimit : undefined,
        cornerSmoothing: typeof nc.cornerSmoothing === 'number' && nc.cornerSmoothing > 0 ? nc.cornerSmoothing : undefined,
        vectorNetwork: vectorNetworkSource(nc),
        pointCount: typeof nc.count === 'number' ? nc.count : undefined,
        arcData: arcDataOf(nc.arcData),
        starInnerScale: typeof nc.starInnerScale === 'number' ? nc.starInnerScale : undefined,
        exportSettings: Array.isArray(nc.exportSettings) && nc.exportSettings.length ? (nc.exportSettings as Record<string, unknown>[]) : undefined,
        annotations: Array.isArray(nc.annotations) && nc.annotations.length ? (nc.annotations as Record<string, unknown>[]) : undefined,
        sectionStatus: statusInfo(nc),
        textAutoResize: typeof nc.textAutoResize === 'string' ? nc.textAutoResize : undefined,
        textAlignHorizontal: typeof nc.textAlignHorizontal === 'string' ? nc.textAlignHorizontal : undefined,
        textAlignVertical: typeof nc.textAlignVertical === 'string' ? nc.textAlignVertical : undefined,
        lineHeight: nc.lineHeight as { value: number; units: string } | undefined,
        letterSpacing: nc.letterSpacing as { value: number; units: string } | undefined,
        textCase: typeof nc.textCase === 'string' ? nc.textCase : undefined,
        textDecoration: typeof nc.textDecoration === 'string' ? nc.textDecoration : undefined,
        ...(type === 'TEXT' ? textSource(nc) : {}),
        stack: stackFields(nc as unknown as Record<string, unknown>),
        symbolKey: type === 'INSTANCE' ? (nc.overriddenSymbolID ?? nc.symbolData?.symbolID ? guidKey((nc.overriddenSymbolID ?? nc.symbolData?.symbolID)!) : undefined) : undefined,
      },
    };
  }

  function buildChildren(parentId: string, contexts: InstanceContext[], keyPrefix: string, depth: number): SceneNode[] {
    const out: SceneNode[] = [];
    for (const child of childrenOf.get(parentId) ?? []) {
      const node = build(child, contexts, keyPrefix, depth);
      if (node) out.push(node);
    }
    return out;
  }

  const doc = [...byId.values()].find((n) => n.type === 'DOCUMENT');
  const pages: ScenePage[] = [];
  const internal: ScenePage[] = [];
  for (const page of doc ? (childrenOf.get(guidKey(doc.guid)) ?? []) : []) {
    // The internal canvas (styles, variables, library mains) becomes a separate page at the end.
    const isInternal = page.internalOnly === true;
    if (page.type !== 'CANVAS' || (page.visible === false && !isInternal)) continue;
    const bg = (page.backgroundColor as ScenePage['backgroundColor']) ?? undefined;
    const id = guidKey(page.guid);
    const raw = childrenOf.get(id) ?? [];
    let built: SceneNode[] | undefined;
    const modes = modesOf(page);
    const device = page.prototypeDevice as ScenePage['prototypeDevice'];
    const pbg = page.prototypeBackgroundColor as ScenePage['prototypeBackground'];
    const handoff = ((page.handoffStatusMap as { entries?: { guid?: FigGuid; handoffStatus?: Record<string, unknown> }[] } | undefined)?.entries ?? [])
      .filter((e) => e.guid && e.handoffStatus && e.handoffStatus.status && e.handoffStatus.status !== 'NONE')
      .map((e) => ({ key: guidKey(e.guid), info: e.handoffStatus! }));
    const measurements = Array.isArray(page.measurements) && page.measurements.length ? (page.measurements as Record<string, unknown>[]) : undefined;
    (isInternal ? internal : pages).push({
      key: id,
      name: page.name ?? '',
      ...(isInternal ? { internal: true } : {}),
      ...(modes ? { modes } : {}),
      ...(device ? { prototypeDevice: device } : {}),
      ...(pbg ? { prototypeBackground: pbg } : {}),
      ...(handoff.length ? { handoff } : {}),
      ...(measurements ? { measurements } : {}),
      backgroundColor: bg,
      get children() {
        return (built ??= buildChildren(id, [], '', 0));
      },
      size: raw.length,
      buildChild: (i) => build(raw[i]!, [], '', 0),
    });
  }
  pages.push(...internal);
  const cats = (doc?.annotationCategories as { items?: Record<string, unknown>[] } | undefined)?.items;
  const customShaders = nodes.filter((n) => n.type === 'CODE_COMPONENT' && String(n.codeObjectType).startsWith('CUSTOM_'));
  return { pages, blobs, stats, ...(customShaders.length ? { customShaders } : {}), ...(cats?.length ? { annotationCategories: cats } : {}) };
}

/** Section or frame status (sectionStatusInfo; old files have only sectionStatus). */
function statusInfo(nc: FigNodeChange): Record<string, unknown> | undefined {
  const info = nc.sectionStatusInfo as Record<string, unknown> | undefined;
  if (info?.status && info.status !== 'NONE') return info;
  const s = nc.sectionStatus;
  return typeof s === 'string' && s !== 'NONE' ? { status: s } : undefined;
}

/** Collection modes of a layer or page (variableModeBySetMap). */
function modesOf(nc: FigNodeChange): Record<string, string> | undefined {
  const entries = (nc.variableModeBySetMap as { entries?: { variableSetID?: FigAssetRef; variableModeID?: FigGuid }[] } | undefined)?.entries;
  if (!entries?.length) return undefined;
  const out: Record<string, string> = {};
  for (const e of entries) {
    const set = assetRef(e.variableSetID);
    if (set && e.variableModeID) out[set] = guidKey(e.variableModeID);
  }
  return Object.keys(out).length ? out : undefined;
}

const TEXT_EXTRA = [
  'leadingTrim',
  'textTruncation',
  'maxLines',
  'paragraphSpacing',
  'paragraphIndent',
  'listSpacing',
  'hangingPunctuation',
  'hangingList',
  'fontVariantCommonLigatures',
  'fontVariantContextualLigatures',
  'fontVariantDiscretionaryLigatures',
  'fontVariantHistoricalLigatures',
  'fontVariantOrdinal',
  'fontVariantSlashedZero',
  'fontVariantNumericFigure',
  'fontVariantNumericSpacing',
  'fontVariantNumericFraction',
  'fontVariantCaps',
  'fontVariantPosition',
  'toggledOnOTFeatures',
  'toggledOffOTFeatures',
  'hyperlink',
  'textDecorationStyle',
  'textDecorationThickness',
  'textDecorationColor',
  'textUnderlineOffset',
  'textDecorationSkipInk',
  'textDecorationFillPaints',
  'fontVariations',
];

/** .fig text fields for importing range styles, paragraphs and truncation. */
function textSource(nc: FigNodeChange): Partial<NonNullable<SceneNode['source']>> {
  const out: Partial<NonNullable<SceneNode['source']>> = {};
  const td = nc.textData;
  if (td?.styleOverrideTable?.length && Array.isArray(td.characterStyleIDs)) {
    out.textStyleIds = td.characterStyleIDs as number[];
    const table: Record<number, Record<string, unknown>> = {};
    for (const o of td.styleOverrideTable) {
      const { styleID, guid: _g, ...rest } = o as Record<string, unknown> & { styleID?: number };
      if (typeof styleID === 'number') table[styleID] = rest;
    }
    out.textStyleTable = table;
  }
  const lines = td?.lines as { lineType?: string; indentationLevel?: number }[] | undefined;
  if (lines?.some((l) => (l.lineType && l.lineType !== 'PLAIN') || (l.indentationLevel ?? 0) > 0)) out.textLines = lines.map((l) => ({ lineType: l.lineType, indentationLevel: l.indentationLevel }));
  const extra: Record<string, unknown> = {};
  for (const k of TEXT_EXTRA) if (nc[k] !== undefined) extra[k] = nc[k];
  if (Object.keys(extra).length) out.textExtra = extra;
  return out;
}

/** Node vector network (for custom strokes and path editing): blob, scale and vertex caps. */
function vectorNetworkSource(nc: FigNodeChange): NonNullable<SceneNode['source']>['vectorNetwork'] {
  const vd = nc.vectorData as { vectorNetworkBlob?: number; normalizedSize?: { x: number; y: number }; styleOverrideTable?: ({ styleID?: number; strokeCap?: string } & Record<string, unknown>)[] } | undefined;
  if ((nc.type !== 'VECTOR' && nc.type !== 'LINE') || typeof vd?.vectorNetworkBlob !== 'number') return undefined;
  let vertexCaps: Record<number, string> | undefined;
  let vertexStyles: NonNullable<NonNullable<SceneNode['source']>['vectorNetwork']>['vertexStyles'];
  for (const s of vd.styleOverrideTable ?? []) {
    if (typeof s.styleID !== 'number') continue;
    if (typeof s.strokeCap === 'string') (vertexCaps ??= {})[s.styleID] = s.strokeCap;
    const st = s as { handleMirroring?: unknown; cornerRadius?: unknown; strokeCap?: unknown; strokeJoin?: unknown };
    const out: { handleMirroring?: string; cornerRadius?: number; strokeCap?: string; strokeJoin?: string } = {};
    if (typeof st.handleMirroring === 'string') out.handleMirroring = st.handleMirroring;
    if (typeof st.cornerRadius === 'number' && st.cornerRadius > 0) out.cornerRadius = st.cornerRadius;
    if (typeof st.strokeCap === 'string' && st.strokeCap !== 'NONE') out.strokeCap = st.strokeCap;
    if (typeof st.strokeJoin === 'string') out.strokeJoin = st.strokeJoin;
    if (Object.keys(out).length) (vertexStyles ??= {})[s.styleID] = out;
  }
  return { blob: vd.vectorNetworkBlob, normalizedSize: vd.normalizedSize, vertexCaps, vertexStyles };
}

/** Affine matrix multiplication: result = a · b. */
export function multiply(a: Matrix2D, b: Matrix2D): Matrix2D {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}

export function invert(m: Matrix2D): Matrix2D {
  const det = m[0] * m[4] - m[1] * m[3];
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const id = 1 / det;
  return [
    m[4] * id,
    -m[1] * id,
    (m[1] * m[5] - m[4] * m[2]) * id,
    -m[3] * id,
    m[0] * id,
    (m[3] * m[2] - m[0] * m[5]) * id,
  ];
}

/**
 * Parse path commands from a blob: 0 — close, 1 — moveTo, 2 — lineTo, 3 — quadTo, 4 — cubicTo.
 * Coordinates are float32 LE. Calls callbacks so as not to depend on a specific renderer.
 */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadTo(x1: number, y1: number, x: number, y: number): void;
  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  close(): void;
}

export function decodePathCommands(bytes: Uint8Array, sink: PathSink): boolean {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  const f = () => {
    const x = v.getFloat32(i, true);
    i += 4;
    return x;
  };
  while (i < bytes.length) {
    const cmd = bytes[i++];
    switch (cmd) {
      case 0:
        sink.close();
        break;
      case 1:
        sink.moveTo(f(), f());
        break;
      case 2:
        sink.lineTo(f(), f());
        break;
      case 3: {
        const x1 = f(), y1 = f();
        sink.quadTo(x1, y1, f(), f());
        break;
      }
      case 4: {
        const x1 = f(), y1 = f(), x2 = f(), y2 = f();
        sink.cubicTo(x1, y1, x2, y2, f(), f());
        break;
      }
      default:
        return false;
    }
  }
  return true;
}
