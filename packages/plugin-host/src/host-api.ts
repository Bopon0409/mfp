// Host side of the Plugin API: executes calls from the sandbox against the document model.
// Property names and data shapes as in the Plugin API.

import { Document, textAutoRename, multiply, invert, rotationOf, withRotation, CONTAINER_TYPES, userPages, IDENTITY, MIXED, PARAGRAPH_KEYS, TEXT_STYLE_KEYS, compactText, effectiveStyle, rangeValue, spliceRuns, styleAt, textSegments, restyleText, styleWeight, type TextStyleKey, addMeasurement, annotationCategories, deleteMeasurement, editMeasurement, measurementsOf, type AnnotationCategory, type Measurement, type MeasurementSide } from '@mfp/core';
import type { Matrix, NodeType, Paint, Props, StrokeCap, WidgetData } from '@mfp/core';
import { renderWidget, type WidgetElement } from './widget.ts';
import { getSizing, setSizing, canHug, canFill, type SizingMode } from '@mfp/editing/sizing';
import { scaleTree } from '@mfp/editing/scale';
import { resizeWithConstraints } from '@mfp/editing/sizing';
import { applyTextStyleRange, reactionsOf, type FlowStartingPoint, type Reaction } from '@mfp/core';
import { textPathFromStart, textPathStartFromOffset } from './text-path.ts';
import { encodeNetwork, decodeNetwork, networkFillPaths, mergeNetworks, networkFromSvg, networkOf, networkProps, type HandleMirroring, type VectorNetwork, type VectorRegion } from '@mfp/core';
import { NOT, designGet, designGlobals, designMethod, designRemove, designSet } from './design-api.ts';
import { MOTION_NOT, figmaAnimationStyles, motionGet, motionMethod, motionSet } from './motion-api.ts';
import { physicalSpringToNormalized } from '@mfp/core';
import { cssDeclarations, importSvgText, nodeOutline, parsePath, pathBounds, pathKit, pathToSvg, transformPath, type Seg } from '@mfp/editing';
import { base64Decode, base64Encode, imageSize, sha1Hex } from './bytes.ts';
import { urlAllowed } from './network.ts';
import { devApiAllowed } from './dev-access.ts';

/** Environment provided by the editor (or a test harness). */
export interface PluginEnvironment {
  doc: Document;
  /** Forward explicit undo boundaries to the editor when running in a Worker. */
  commitUndo?(): void;
  getCurrentPage(): string;
  setCurrentPage(id: string): void;
  getSelection(): string[];
  setSelection(ids: string[]): void;
  notify(message: string, options: unknown): void;
  showUI(html: string, options: { width?: number; height?: number; visible?: boolean; title?: string } | null): void;
  postToUI(message: unknown): void;
  setUIVisible(visible: boolean): void;
  resizeUI(width: number, height: number): void;
  closeUI(): void;
  viewport: {
    center(): { x: number; y: number };
    zoom(): number;
    bounds(): { x: number; y: number; width: number; height: number };
    setCenter(c: { x: number; y: number }): void;
    setZoom(z: number): void;
    scrollAndZoomIntoView(ids: string[]): void;
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  log(level: string, args: string[]): void;
  /** figma.currentUser (id, name, photoUrl, color, sessionId). */
  currentUser?: { id: string | null; name: string; photoUrl?: string | null; color?: string; sessionId?: number } | null;
  /** Load a font (loadFontAsync): true — available. Absent — considered available. */
  loadFont?(font: { family: string; style: string }): Promise<boolean>;
  /** Codegen: figma.editorType and figma.mode, settings and the response to generate. */
  editorType?: 'figma' | 'dev';
  mode?: 'default' | 'inspect' | 'codegen';
  codegenPreferences?: { unit: 'PIXEL' | 'SCALED'; scaleFactor: number; customSettings: Record<string, string> };
  codegenResult?(requestId: number, results: unknown, error: string | null): void;
  codegenRefresh?(): void;
  /** The plugin subscribed to an event (on = true) or removed the last subscriber: documentchange etc. */
  listen?(type: string, on: boolean): void;
  /** New plugin image (createImage) into the editor storage. */
  addImage?(hash: string, bytes: Uint8Array): void;
  /** Bytes of a document image by hash (Image.getBytesAsync); absent — null. */
  imageBytes?(hash: string): Promise<Uint8Array | null>;
  /** createImageAsync(url): load the image, return the hash. */
  imageFromUrl?(url: string): Promise<string>;
  /** exportAsync: PNG / JPG / SVG / PDF (bytes) or SVG_STRING (a string). */
  exportNode?(id: string, settings: Record<string, unknown>): Promise<Uint8Array | string>;
  /** flatten: exact path from the renderer (SVG path relative to origin, page) or null. */
  flattenGeometry?(ids: string[], origin: [number, number]): Promise<string | null>;
  /** Suggestions for a quick action parameter (response to input requestId). */
  suggestions?(requestId: number, result: SuggestionResult): void;
  /** fetch for plugin code (global by default). */
  fetch?: typeof fetch;
  /** figma.openExternal: open a URL in the browser. */
  openExternal?(url: string): void;
  /** listAvailableFontsAsync: editor fonts. */
  fonts?(): Promise<{ family: string; style: string }[]>;
  /** saveVersionHistoryAsync: file version, id. */
  saveVersion?(title: string, description: string): Promise<string>;
  /** figma.motion.playheadPosition: playhead of the open timeline, seconds (no panel — undefined). */
  motionPlayhead?(): number | undefined;
}

/** Plugin response to parameter input: suggestions, an error or “loading…”. */
export interface SuggestionResult {
  suggestions?: { name: string; data?: unknown }[];
  error?: string;
  loading?: string;
}

/** Heavy derived data is not included in JSON_REST_V1 (as in the server REST API). */
const REST_SKIP = new Set(['textGlyphs', 'vectorPaths', 'strokePaths', 'centerPaths', 'geometrySize']);
function restJson(doc: Document, id: string): Record<string, unknown> {
  const n = doc.node(id)!;
  const out: Record<string, unknown> = { id, type: n.type };
  for (const [k, v] of Object.entries(n.props)) if (!REST_SKIP.has(k) && v !== undefined) out[k] = v;
  const kids = doc.children(id);
  if (kids.length) out.children = kids.map((c) => restJson(doc, c));
  return out;
}

const BOOLEAN_NAMES: Record<string, string> = { UNION: 'Union', SUBTRACT: 'Subtract', INTERSECT: 'Intersect', EXCLUDE: 'Exclude' };

type Wire = unknown;
const node = (id: string | null | undefined) => (id ? { $node: id } : null);
const nodeId = (v: Wire): string => {
  if (v && typeof v === 'object' && '$node' in v) return String((v as { $node: string }).$node);
  throw new Error('Ожидался узел');
};

/**
 * Text decoration color: in the model RGBA or 'AUTO', in the Plugin API { value: SolidPaint } or
 * { value: 'AUTO' }. Other text properties as is.
 */
function textValueOut(key: string, v: unknown): Wire {
  if (key !== 'textDecorationColor') return v as Wire;
  if (!v || v === 'AUTO') return { value: 'AUTO' };
  const c = v as { r: number; g: number; b: number; a?: number };
  return { value: { type: 'SOLID', visible: true, opacity: c.a ?? 1, blendMode: 'NORMAL', color: { r: c.r, g: c.g, b: c.b } } };
}

function textValueIn(key: string, v: unknown): unknown {
  if (key !== 'textDecorationColor') return v;
  const x = (v as { value?: unknown } | null)?.value;
  if (x === undefined || x === null || x === 'AUTO') return 'AUTO';
  const p = x as { type?: string; color?: { r: number; g: number; b: number }; opacity?: number };
  if (p.type !== 'SOLID' || !p.color) throw new Error('textDecorationColor: ожидалось { value: SolidPaint } или { value: "AUTO" }');
  return { r: p.color.r, g: p.color.g, b: p.color.b, a: p.opacity ?? 1 };
}

/** Properties stored in the model one-to-one. */
const DIRECT = new Set<keyof Props>([
  'name',
  'visible',
  'locked',
  'opacity',
  'blendMode',
  'fills',
  'strokes',
  'strokeAlign',
  'strokeJoin',
  'strokeMiterLimit',
  'dashPattern',
  'cornerRadius',
  'cornerSmoothing',
  'paragraphSpacing',
  'paragraphIndent',
  'listSpacing',
  'hangingPunctuation',
  'hangingList',
  'textTruncation',
  'maxLines',
  'leadingTrim',
  'hyperlink',
  'openTypeFeatures',
  'topLeftRadius',
  'topRightRadius',
  'bottomRightRadius',
  'bottomLeftRadius',
  'constrainProportions',
  'constraints',
  'layoutGrids',
  'itemReverseZIndex',
  'gridRowSizes',
  'gridColumnSizes',
  'gridRowGap',
  'gridColumnGap',
  'gridRowAnchorIndex',
  'gridColumnAnchorIndex',
  'gridRowSpan',
  'gridColumnSpan',
  'gridChildHorizontalAlign',
  'gridChildVerticalAlign',
  'strokesIncludedInLayout',
  'effects',
  'isMask',
  'clipsContent',
  'characters',
  'fontSize',
  'fontName',
  'textAlignHorizontal',
  'textAlignVertical',
  'textAutoResize',
  'lineHeight',
  'letterSpacing',
  'textCase',
  'textDecoration',
  'pointCount',
  'innerRadius',
  'arcData',
  'booleanOperation',
  'layoutMode',
  'layoutVersion',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'primaryAxisSizingMode',
  'counterAxisSizingMode',
  'layoutWrap',
  'counterAxisAlignContent',
  'layoutGrow',
  'layoutAlign',
  'layoutPositioning',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
]);

const SIDE_KEYS = ['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'] as const;

const READONLY = new Set(['id', 'type', 'width', 'height', 'parent', 'children', 'removed', 'absoluteTransform', 'absoluteBoundingBox', 'overlayPositionType', 'overlayBackground', 'overlayBackgroundInteraction', 'prototypeStartNode']);

/** Nodes that have scrolling and overlay settings (frames). */
const SCROLL_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

/** Reactions in Plugin API form: with the deprecated action (= the first action). */
const wireReactions = (list: Reaction[]) => list.map((r) => ({ action: r.actions[0] ?? null, actions: r.actions, trigger: r.trigger }));

/** Reactions from the plugin: action (deprecated) as the only action. */
function readReactions(value: Wire): Reaction[] {
  if (!Array.isArray(value)) throw new Error('reactions: ожидался массив');
  return value.map((r) => {
    const o = (r ?? {}) as { trigger?: Reaction['trigger']; actions?: Reaction['actions']; action?: Reaction['actions'][number] | null };
    const actions = Array.isArray(o.actions) ? o.actions : o.action ? [o.action] : [];
    return { trigger: o.trigger ?? null, actions: actions.map((a) => ({ ...a })) };
  });
}

export interface HostCallbacks {
  /** The plugin called closePlugin. */
  onClose(message: string | null): void;
  setTimer(id: number, ms: number): void;
  clearTimer(id: number): void;
  /** Resolve a promise in the sandbox. */
  settle(id: number, value: unknown, error?: string): void;
  /** Bytes for the sandbox: a {$blob} reference. */
  blob(bytes: Uint8Array): { $blob: number };
  /** Bytes from the sandbox by a {$blob} reference. */
  takeBlob(id: number): Uint8Array | undefined;
}

export class HostApi {
  private env: PluginEnvironment;
  private pluginId: string;
  private command: string;
  /** manifest.networkAccess: allowed addresses (null — any). */
  private domains: string[] | null;
  private cb: HostCallbacks;
  /** Images created by the plugin (createImage): hash → bytes. */
  private images = new Map<string, Uint8Array>();
  private undoGroup = {};
  private skipInvisible: boolean;

  constructor(env: PluginEnvironment, pluginId: string, command: string, domains: string[] | null, callbacks: HostCallbacks) {
    this.env = env;
    this.skipInvisible = env.editorType === 'dev';
    this.pluginId = pluginId;
    this.command = command;
    this.domains = domains;
    this.cb = callbacks;
  }

  private get doc() {
    return this.env.doc;
  }

  call(method: string, args: Wire[]): Wire {
    if (this.env.editorType === 'dev' && !devApiAllowed(method, args)) throw new Error(`Developer mode is read-only: ${method}`);
    const fn = (this as unknown as Record<string, (...a: Wire[]) => Wire>)[`m_${method}`];
    if (!fn) throw new Error(`Метод Plugin API не поддерживается: ${method}`);
    return this.doc.withUndoGroup(this.undoGroup, () => fn.apply(this, args));
  }

  m_commitUndo() {
    this.undoGroup = {};
    this.env.commitUndo?.();
    return null;
  }

  // ---------- figma.* ----------

  /** figma.motion: timeline playhead, motion styles, spring conversion. */
  m_motion(method: Wire, arg?: Wire): Wire {
    if (method === 'playhead') return this.env.motionPlayhead?.() ?? null;
    if (method === 'styles') return figmaAnimationStyles() as unknown as Wire;
    if (method === 'spring') {
      const sp = arg as { mass?: number; stiffness?: number; damping?: number } | null;
      if (!sp || ![sp.mass, sp.stiffness, sp.damping].every((v) => typeof v === 'number' && v > 0)) throw new Error('PhysicalSpring requires positive mass, stiffness and damping');
      return physicalSpringToNormalized(sp as { mass: number; stiffness: number; damping: number });
    }
    throw new Error(`"${String(method)}" is not a supported API`);
  }

  m_meta(key: Wire) {
    if (key === 'pluginId') return this.pluginId;
    if (key === 'command') return this.command;
    if (key === 'currentUser') return this.env.currentUser ?? null;
    if (key === 'editorType') return this.env.editorType ?? 'figma';
    if (key === 'mode') return this.env.mode ?? 'default';
    if (key === 'codegenPreferences') return this.env.codegenPreferences ?? { unit: 'PIXEL', scaleFactor: 1, customSettings: {} };
    return null;
  }

  /** Codegen response to request requestId (results or an error). */
  m_codegenResult(requestId: Wire, results: Wire, error: Wire) {
    this.env.codegenResult?.(Number(requestId), results, typeof error === 'string' ? error : null);
  }

  m_codegenRefresh() {
    this.env.codegenRefresh?.();
  }

  m_root() {
    return node(this.doc.root);
  }

  m_currentPage() {
    return node(this.env.getCurrentPage());
  }

  m_setCurrentPage(page: Wire) {
    const id = nodeId(page);
    if (this.doc.type(id) !== 'PAGE') throw new Error('currentPage должен быть страницей');
    this.env.setCurrentPage(id);
  }

  m_getNodeById(id: Wire) {
    return this.doc.has(String(id)) && !this.skipped(String(id)) ? node(String(id)) : null;
  }

  private skipped(id: string): boolean {
    if (!this.skipInvisible || !this.doc.has(id)) return false;
    let hidden = false;
    for (let at: string | null = id; at; at = this.doc.parent(at)) {
      // A hidden instance itself is accessible; only hidden descendants inside
      // an instance are omitted (including descendants of a hidden nested one).
      if (hidden && this.doc.type(at) === 'INSTANCE') return true;
      hidden ||= this.doc.get(at, 'visible') === false;
    }
    return false;
  }

  m_skipInvisible(value?: Wire) {
    if (value !== undefined) {
      if (typeof value !== 'boolean') throw new Error('skipInvisibleInstanceChildren must be boolean');
      this.skipInvisible = value;
    }
    return this.skipInvisible;
  }

  m_assertAccessible(id: Wire) {
    if (this.skipped(String(id))) throw new Error('Node is inaccessible: skipInvisibleInstanceChildren is enabled');
    return null;
  }

  m_create(type: Wire) {
    const t = String(type) as NodeType;
    return node(this.doc.create(t, this.env.getCurrentPage()));
  }

  m_createPage() {
    return node(this.doc.create('PAGE', this.doc.root));
  }

  m_group(nodes: Wire, parent: Wire, index: Wire) {
    const ids = (nodes as Wire[]).map(nodeId);
    if (!ids.length) throw new Error('group: нужен хотя бы один узел');
    const parentId = nodeId(parent);
    return this.doc.transact(() => {
      const box = this.unionBox(ids);
      // A group takes the bounds of the nodes; its position is set relative to the parent.
      const parentAbs = this.doc.type(parentId) === 'PAGE' ? IDENTITY : this.absoluteTransform(parentId);
      const groupAbs: Matrix = [1, 0, box.x, 0, 1, box.y];
      const group = this.doc.create(
        'GROUP',
        parentId,
        { transform: multiply(invert(parentAbs), groupAbs), width: box.width, height: box.height },
        index === null ? undefined : Number(index),
      );
      for (const id of ids) {
        // The node's absolute position does not change when it moves into a group.
        const abs = this.absoluteTransform(id);
        this.doc.move(id, group);
        this.doc.set(id, { transform: multiply(invert(groupAbs), abs) });
      }
      return node(group);
    });
  }

  /** loadFontAsync: the promise resolves once the font is loaded (not found — error). */
  m_loadFont(promiseId: Wire, font: Wire) {
    const f = font as { family?: string; style?: string } | null;
    if (!f?.family) return this.cb.settle(Number(promiseId), null, 'loadFontAsync: нужен { family, style }');
    const load = this.env.loadFont?.({ family: f.family, style: f.style ?? 'Regular' }) ?? Promise.resolve(true);
    this.settleAsync(
      Number(promiseId),
      load.then((ok) => {
        if (!ok) throw new Error(`The font "${f.family} ${f.style ?? 'Regular'}" could not be loaded`);
        return null;
      }),
    );
  }

  // ---------- Text by ranges (getRange* / setRange*, segments, insertion) ----------

  private textNode(idw: Wire): { id: string; length: number } {
    const id = String(idw);
    if (this.doc.type(id) !== 'TEXT') throw new Error('Метод есть только у текстовых узлов');
    return { id, length: (this.doc.get(id, 'characters') ?? '').length };
  }

  private checkRange(length: number, s: number, e: number) {
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > length || s >= e) throw new Error(`Expected 0 <= start < end <= ${length}, got start=${s}, end=${e}`);
  }

  m_getRange(idw: Wire, key: Wire, sw: Wire, ew: Wire): Wire {
    const { id, length } = this.textNode(idw);
    const [s, e] = [Number(sw), Number(ew)];
    this.checkRange(length, s, e);
    const p = this.doc.props(id);
    const k = String(key);
    if (k === 'fontWeight') {
      const v = rangeValue(p, p.textRuns, length, s, e, 'fontName');
      if (v !== MIXED) return styleWeight(v.style).weight;
      const weights = new Set(textSegments(p.textRuns, length).filter((g) => g.end > s && g.start < e).map((g) => styleWeight((g.style.fontName ?? p.fontName ?? { style: 'Regular' }).style).weight));
      return weights.size === 1 ? [...weights][0] : { $mixed: true };
    }
    if (k === 'allFontNames') {
      const seen = new Map<string, unknown>();
      for (const g of textSegments(p.textRuns, length)) {
        if (g.end <= s || g.start >= e) continue;
        const f = g.style.fontName ?? p.fontName ?? { family: 'Inter', style: 'Regular' };
        seen.set(`${f.family}|${f.style}`, f);
      }
      return [...seen.values()];
    }
    if (k === 'listOptions') {
      const v = rangeValue(p, p.textRuns, length, s, e, 'listType');
      return v === MIXED ? { $mixed: true } : { type: v ?? 'NONE' };
    }
    if (k === 'textStyleId' || k === 'fillStyleId') return '';
    if (!TEXT_STYLE_KEYS.includes(k as TextStyleKey)) throw new Error(`getRange: неизвестное свойство ${k}`);
    const v = rangeValue(p, p.textRuns, length, s, e, k as TextStyleKey);
    return v === MIXED ? { $mixed: true } : textValueOut(k, v);
  }

  m_setRange(idw: Wire, key: Wire, sw: Wire, ew: Wire, value: Wire) {
    const { id, length } = this.textNode(idw);
    const [s, e] = [Number(sw), Number(ew)];
    this.checkRange(length, s, e);
    let k = String(key);
    let v = value;
    if (k === 'listOptions') {
      k = 'listType';
      v = (value as { type?: string } | null)?.type ?? 'NONE';
    }
    // Style on part of the text: reference and style values.
    if (k === 'textStyleId' || k === 'fillStyleId') {
      const styleId = v && typeof v === 'object' && '$node' in (v as object) ? String((v as { $node: string }).$node) : String(v ?? '');
      if (styleId && this.doc.type(styleId) !== 'STYLE') throw new Error(`Нет стиля ${styleId}`);
      return applyTextStyleRange(this.doc, id, s, e, k, styleId);
    }
    if (!TEXT_STYLE_KEYS.includes(k as TextStyleKey)) throw new Error(`setRange: неизвестное свойство ${k}`);
    if (k === 'fills') for (const p of v as Paint[]) validatePaint(p);
    const next = textValueIn(k, v);
    restyleText(this.doc, id, s, e, () => ({ [k]: next }), PARAGRAPH_KEYS.includes(k as TextStyleKey));
  }

  /** Segments with equal values of the requested properties (getStyledTextSegments). */
  m_styledSegments(idw: Wire, fields: Wire, sw: Wire, ew: Wire): Wire {
    const { id, length } = this.textNode(idw);
    const s = sw === null || sw === undefined ? 0 : Number(sw);
    const e = ew === null || ew === undefined ? length : Number(ew);
    if (length) this.checkRange(length, s, e);
    const p = this.doc.props(id);
    const chars = p.characters ?? '';
    const keys = (fields as string[]).map((f) => (f === 'listOptions' ? 'listType' : f)).filter((f) => TEXT_STYLE_KEYS.includes(f as TextStyleKey) || f === 'fontWeight') as (TextStyleKey | 'fontWeight')[];
    const valueOf = (style: ReturnType<typeof effectiveStyle>, k: TextStyleKey | 'fontWeight') => (k === 'fontWeight' ? styleWeight(style.fontName.style).weight : style[k]);
    const out: Record<string, unknown>[] = [];
    let prev: string | null = null;
    for (const g of textSegments(p.textRuns, length)) {
      const a = Math.max(s, g.start);
      const b = Math.min(e, g.end);
      if (b <= a) continue;
      const eff = effectiveStyle(p, g.style);
      const vals: Record<string, unknown> = {};
      for (const k of keys) vals[k === 'listType' ? 'listOptions' : k] = k === 'listType' ? { type: eff.listType ?? 'NONE' } : textValueOut(k, valueOf(eff, k));
      const sig = JSON.stringify(vals);
      const last = out[out.length - 1];
      if (last && sig === prev) {
        last.end = b;
        last.characters = chars.slice(last.start as number, b);
      } else out.push({ characters: chars.slice(a, b), start: a, end: b, ...vals });
      prev = sig;
    }
    return out;
  }

  /** insertCharacters: insert using the style of the character before (BEFORE, default) or after (AFTER). */
  m_insertCharacters(idw: Wire, startw: Wire, text: Wire, useStyle: Wire) {
    const { id, length } = this.textNode(idw);
    const start = Number(startw);
    if (!Number.isInteger(start) || start < 0 || start > length) throw new Error(`insertCharacters: позиция ${start} вне текста`);
    const add = String(text);
    const p = this.doc.props(id);
    const style = useStyle === 'AFTER' && start < length ? styleAt(p.textRuns, start) : start > 0 ? styleAt(p.textRuns, start - 1) : styleAt(p.textRuns, 0);
    const chars = p.characters ?? '';
    const next = chars.slice(0, start) + add + chars.slice(start);
    const c = compactText(p, spliceRuns(p.textRuns, length, start, 0, add.length, style), next.length);
    this.doc.set(id, { characters: next, ...c.props, textRuns: c.runs, ...(p.textGlyphs ? { textGlyphs: undefined } : {}) });
  }

  m_deleteCharacters(idw: Wire, sw: Wire, ew: Wire) {
    const { id, length } = this.textNode(idw);
    const [s, e] = [Number(sw), Number(ew)];
    this.checkRange(length, s, e);
    const p = this.doc.props(id);
    const chars = p.characters ?? '';
    const next = chars.slice(0, s) + chars.slice(e);
    const c = compactText(p, spliceRuns(p.textRuns, length, s, e - s, 0), next.length);
    this.doc.set(id, { characters: next, ...c.props, textRuns: c.runs, ...(p.textGlyphs ? { textGlyphs: undefined } : {}) });
  }

  m_notify(message: Wire, options: Wire) {
    this.env.notify(String(message), options);
  }

  m_showUI(html: Wire, options: Wire) {
    this.env.showUI(String(html), (options ?? null) as Parameters<PluginEnvironment['showUI']>[1]);
  }

  m_postToUI(message: Wire) {
    this.env.postToUI(message);
  }

  m_uiVisible(visible: Wire) {
    this.env.setUIVisible(Boolean(visible));
  }

  m_uiResize(w: Wire, h: Wire) {
    this.env.resizeUI(Number(w), Number(h));
  }

  m_uiClose() {
    this.env.closeUI();
  }

  m_closePlugin(message: Wire) {
    this.env.closeUI();
    this.cb.onClose(message === null ? null : String(message));
  }

  m_viewport(key: Wire) {
    const v = this.env.viewport;
    if (key === 'center') return v.center();
    if (key === 'zoom') return v.zoom();
    if (key === 'bounds') return v.bounds();
    return null;
  }

  m_setViewport(key: Wire, value: Wire) {
    if (key === 'center') {
      const c = value as { x?: unknown; y?: unknown } | null;
      const x = Number(c?.x);
      const y = Number(c?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('viewport.center: нужны числа x и y');
      this.env.viewport.setCenter({ x, y });
    }
    if (key === 'zoom') {
      const z = Number(value);
      if (!(z > 0) || !Number.isFinite(z)) throw new Error('viewport.zoom: нужно положительное число');
      this.env.viewport.setZoom(Math.min(256, Math.max(0.01, z)));
    }
  }

  /** Parameter suggestions: setSuggestions / setError / setLoadingMessage. */
  m_suggestions(requestId: Wire, list: Wire, error: Wire, loading: Wire) {
    const result: SuggestionResult = {};
    if (Array.isArray(list)) {
      result.suggestions = (list as Wire[]).slice(0, 500).map((x) => {
        const o = (x && typeof x === 'object' ? x : { name: String(x) }) as { name?: unknown; data?: unknown };
        return { name: String(o.name ?? ''), ...(o.data !== undefined ? { data: o.data } : {}) };
      });
    }
    if (typeof error === 'string') result.error = error;
    if (typeof loading === 'string') result.loading = loading;
    this.env.suggestions?.(Number(requestId), result);
  }

  m_listen(type: Wire, on: Wire) {
    this.env.listen?.(String(type), Boolean(on));
  }

  m_scrollAndZoomIntoView(nodes: Wire) {
    this.env.viewport.scrollAndZoomIntoView((nodes as Wire[]).map(nodeId));
  }

  m_setTimer(id: Wire, ms: Wire) {
    this.cb.setTimer(Number(id), Number(ms));
  }

  m_clearTimer(id: Wire) {
    this.cb.clearTimer(Number(id));
  }

  m_log(level: Wire, args: Wire) {
    this.env.log(String(level), (args as Wire[]).map(String));
  }

  m_parseColor(color: Wire, withAlpha: Wire) {
    const c = parseColor(String(color));
    return withAlpha ? c : { r: c.r, g: c.g, b: c.b };
  }

  // ---------- clientStorage: asynchronous, via sandbox promises ----------

  m_storageGet(promiseId: Wire, key: Wire) {
    this.settleAsync(Number(promiseId), this.env.storage.get(String(key)));
  }

  m_storageSet(promiseId: Wire, key: Wire, value: Wire) {
    this.settleAsync(Number(promiseId), this.env.storage.set(String(key), value));
  }

  m_storageDelete(promiseId: Wire, key: Wire) {
    this.settleAsync(Number(promiseId), this.env.storage.delete(String(key)));
  }

  m_storageKeys(promiseId: Wire) {
    this.settleAsync(Number(promiseId), this.env.storage.keys());
  }

  private settleAsync(id: number, p: Promise<unknown>) {
    p.then(
      (value) => this.cb.settle(id, value instanceof Uint8Array ? this.cb.blob(value) : (value ?? null)),
      (e) => this.cb.settle(id, null, String(e?.message ?? e)),
    );
  }

  /** Bytes from the sandbox ({$blob}). */
  private bytesOf(w: Wire, what: string): Uint8Array {
    const id = w && typeof w === 'object' && '$blob' in w ? Number((w as { $blob: number }).$blob) : NaN;
    const bytes = Number.isFinite(id) ? this.cb.takeBlob(id) : undefined;
    if (!bytes) throw new Error(`${what}: ожидался Uint8Array`);
    return bytes;
  }

  // ---------- Widgets ----------

  /** figma.widget: widget node state, writing it and rendering the component tree. */
  m_widget(action: Wire, ...args: Wire[]) {
    const doc = this.doc;
    if (action === 'registered') return null;
    const id = String(args[0] ?? '');
    const w = doc.get(id, 'widget');
    if (!w) throw new Error(`${id} — не виджет`);
    if (action === 'getState') return w.state ?? {};
    if (action === 'setState') {
      doc.set(id, { widget: { ...w, state: { ...w.state, [String(args[1])]: args[2] as unknown } } });
      return null;
    }
    if (action === 'rendered') {
      const created = (args[3] ?? {}) as Record<string, unknown>;
      renderWidget(doc, id, args[1] as unknown as WidgetElement | null, {
        image: (bytes) => {
          if (!imageSize(bytes)) return null;
          const hash = sha1Hex(bytes);
          if (!this.images.has(hash)) {
            this.images.set(hash, bytes);
            this.env.addImage?.(hash, bytes);
          }
          return hash;
        },
        svg: (markup, parent) => {
          const frame = importSvgText(doc, markup, { kit: pathKit, parent, name: 'SVG', origin: [0, 0] });
          return frame;
        },
      });
      doc.set(id, { widget: { ...w, state: { ...created, ...w.state }, menu: (args[2] as unknown as WidgetData['menu']) ?? null } });
      return null;
    }
    throw new Error(`figma.widget: ${String(action)}`);
  }

  // ---------- Images ----------

  /** figma.createImage(bytes): hash — SHA-1 of the content; the image goes into the editor storage. */
  m_createImage(data: Wire) {
    const bytes = this.bytesOf(data, 'createImage');
    if (!imageSize(bytes)) throw new Error('Image type is unsupported');
    const hash = sha1Hex(bytes);
    if (!this.images.has(hash)) {
      this.images.set(hash, bytes);
      this.env.addImage?.(hash, bytes);
    }
    return { hash };
  }

  /** figma.createVideoAsync(bytes): video (MP4, MOV, WebM) into the same storage as images; hash — SHA-1. */
  m_createVideo(data: Wire) {
    const bytes = this.bytesOf(data, 'createVideoAsync');
    const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    const mp4 = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0) === 'ftyp';
    if (!webm && !mp4) throw new Error('Video type is unsupported');
    const hash = sha1Hex(bytes);
    if (!this.images.has(hash)) {
      this.images.set(hash, bytes);
      this.env.addImage?.(hash, bytes);
    }
    return { hash };
  }

  private async imageData(hash: string): Promise<Uint8Array> {
    const own = this.images.get(hash);
    if (own) return own;
    const bytes = await this.env.imageBytes?.(hash);
    if (!bytes) throw new Error(`Нет картинки ${hash}`);
    return bytes;
  }

  m_imageBytes(promiseId: Wire, hash: Wire) {
    this.settleAsync(Number(promiseId), this.imageData(String(hash)));
  }

  m_imageSize(promiseId: Wire, hash: Wire) {
    this.settleAsync(
      Number(promiseId),
      this.imageData(String(hash)).then((b) => {
        const size = imageSize(b);
        if (!size) throw new Error('Не удалось прочитать размер картинки');
        return size;
      }),
    );
  }

  m_createImageAsync(promiseId: Wire, src: Wire) {
    const url = String(src);
    const load = this.env.imageFromUrl ? this.env.imageFromUrl(url).then((hash) => ({ hash })) : Promise.reject(new Error('createImageAsync недоступен'));
    this.settleAsync(Number(promiseId), load);
  }

  // ---------- Misc: external links, fonts, versions, selection colors, components ----------

  m_openExternal(url: Wire) {
    const u = String(url);
    if (!/^https?:\/\//i.test(u)) throw new Error('openExternal: нужен адрес http(s)://');
    this.env.openExternal?.(u);
  }

  m_listFonts(promiseId: Wire) {
    const list = this.env.fonts ? this.env.fonts() : Promise.resolve(['Regular', 'Medium', 'SemiBold', 'Bold'].map((style) => ({ family: 'Inter', style })));
    this.settleAsync(Number(promiseId), list.then((fonts) => fonts.map((fontName) => ({ fontName }))));
  }

  m_saveVersion(promiseId: Wire, title: Wire, description: Wire) {
    const job = this.env.saveVersion ? this.env.saveVersion(String(title ?? ''), String(description ?? '')).then((id) => ({ id })) : Promise.reject(new Error('История версий недоступна'));
    this.settleAsync(Number(promiseId), job);
  }

  /** figma.activeUsers: in this window, the user themselves. */
  m_activeUsers() {
    const u = this.env.currentUser;
    if (!u) return [];
    const v = this.env.viewport;
    return [{ id: u.id, name: u.name, photoUrl: u.photoUrl ?? null, color: u.color ?? '#4d7bfd', sessionId: u.sessionId ?? 0, position: v.center(), viewport: v.bounds(), selection: this.env.getSelection() }];
  }

  /** Data for “run again” buttons (setRelaunchData): stored on the node. */
  m_setRelaunchData(id: Wire, data: Wire) {
    const key = String(id);
    const value = data && typeof data === 'object' ? JSON.stringify(Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, String(v)]))) : '';
    const all = { ...(this.doc.get(key, 'sharedPluginData') ?? {}) };
    all['figma.relaunch'] = { ...(all['figma.relaunch'] ?? {}), [this.pluginId]: value };
    if (!value || value === '{}') delete all['figma.relaunch']![this.pluginId];
    this.doc.set(key, { sharedPluginData: all });
  }

  m_getRelaunchData(id: Wire) {
    const raw = this.doc.get(String(id), 'sharedPluginData')?.['figma.relaunch']?.[this.pluginId];
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  /** getSelectionColors: paints and paint styles of the selection and everything inside (at most 1000 layers). */
  m_selectionColors() {
    const doc = this.doc;
    const sel = this.env.getSelection().filter((id) => doc.has(id));
    if (!sel.length) return null;
    const paints = new Map<string, Paint>();
    const styles = new Set<string>();
    let n = 0;
    const visit = (id: string) => {
      if (++n > 1000) return;
      const p = doc.props(id);
      for (const paint of [...(p.fills ?? []), ...(p.strokes ?? [])]) if (paint.type !== 'IMAGE') paints.set(JSON.stringify(paint), paint);
      for (const sid of [p.fillStyleId, p.strokeStyleId]) if (sid && doc.has(sid)) styles.add(sid);
      for (const c of doc.children(id)) visit(c);
    };
    for (const id of sel) visit(id);
    if (n > 1000) return null;
    return { paints: [...paints.values()], styles: [...styles].map((s) => node(s)) };
  }

  /** Converts the existing shape; retain ID, parent, stacking and undo. */
  m_createTextPath(nodew: Wire, segmentw: Wire, positionw: Wire) {
    const doc = this.doc;
    const id = nodeId(nodew);
    const t = doc.type(id);
    const parent = doc.parent(id);
    if (!t || !parent || !['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE'].includes(t)) throw new Error('createTextPath: expected a vector-like node');
    const net = t === 'VECTOR' ? networkOf(doc, id) : networkFromSvg(pathToSvg(nodeOutline(doc, id), 0, 0));
    if (!net?.segments.length) throw new Error('createTextPath: empty path');
    if (typeof segmentw !== 'number' || typeof positionw !== 'number') throw new Error('createTextPath: segment and position must be numbers');
    const textPath = textPathFromStart(net, segmentw, positionw);
    const props = doc.props(id);
    const index = doc.children(parent).indexOf(id);
    doc.transact(() => {
      doc.delete(id);
      doc.createWithId(id, 'TEXT', parent, {
        ...props, characters: '', textRuns: [], textGlyphs: undefined, autoRename: true,
        fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16,
        textAutoResize: 'NONE', textAlignHorizontal: 'LEFT',
        vectorNetwork: { data: encodeNetwork(net) }, vectorPaths: networkFillPaths(net),
        geometrySize: { width: props.width ?? 0, height: props.height ?? 0 },
        textPath,
      }, index);
    });
    return node(id);
  }

  /** createComponentFromNode: a frame becomes a component; another layer goes inside a new component. */
  m_createComponentFromNode(nodew: Wire) {
    const doc = this.doc;
    const id = nodeId(nodew);
    const t = doc.type(id);
    const parent = doc.parent(id);
    if (!t || !parent || t === 'PAGE' || t === 'DOCUMENT') throw new Error('createComponentFromNode: нужен слой');
    if (t === 'COMPONENT' || t === 'COMPONENT_SET') throw new Error('Узел уже компонент');
    return node(
      doc.transact(() => {
        const index = doc.children(parent).indexOf(id);
        if (t === 'FRAME') {
          const c = doc.create('COMPONENT', parent, { ...doc.props(id) }, index);
          for (const k of [...doc.children(id)]) doc.move(k, c);
          doc.delete(id);
          return c;
        }
        const p = doc.props(id);
        const tf = (p.transform ?? IDENTITY) as Matrix;
        const c = doc.create('COMPONENT', parent, { name: p.name ?? 'Component', transform: tf, width: p.width ?? 0, height: p.height ?? 0, fills: [], clipsContent: false }, index);
        doc.move(id, c);
        doc.set(id, { transform: [1, 0, 0, 0, 1, 0] });
        return c;
      }),
    );
  }

  // ---------- Network ----------

  /** fetch from plugin code: only addresses from manifest.networkAccess. */
  m_fetch(promiseId: Wire, urlw: Wire, initw: Wire) {
    const url = String(urlw);
    const job = (async () => {
      if (!urlAllowed(url, this.domains)) throw new Error(`Адрес ${url} не разрешён в manifest.networkAccess (allowedDomains)`);
      const i = (initw ?? {}) as { method?: unknown; headers?: unknown; body?: Wire; redirect?: unknown };
      const body = i.body === undefined || i.body === null ? undefined : typeof i.body === 'string' ? i.body : this.bytesOf(i.body, 'fetch: body');
      const headers = i.headers && typeof i.headers === 'object' ? Object.fromEntries(Object.entries(i.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined;
      const res = await (this.env.fetch ?? fetch)(url, {
        method: typeof i.method === 'string' ? i.method : 'GET',
        headers,
        body: body as BodyInit | undefined,
        redirect: i.redirect === 'manual' || i.redirect === 'error' ? i.redirect : 'follow',
        credentials: 'omit',
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
      return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url || url, redirected: res.redirected, type: res.type, headers: out, body: this.cb.blob(bytes) };
    })();
    this.settleAsync(Number(promiseId), job);
  }

  /** Bytes → UTF-8 string (Response.text for the plugin's fetch). */
  m_utf8(data: Wire) {
    return new TextDecoder().decode(this.bytesOf(data, 'text'));
  }

  m_base64Encode(data: Wire) {
    return base64Encode(this.bytesOf(data, 'base64Encode'));
  }

  m_base64Decode(text: Wire) {
    return this.cb.blob(base64Decode(String(text)));
  }

  // ---------- Export and code ----------

  /** exportAsync: PNG 1x by default; JSON_REST_V1 is handled here, the rest is rendered by the editor. */
  m_exportAsync(promiseId: Wire, idw: Wire, settings: Wire) {
    const id = String(idw);
    const s = (settings ?? {}) as Record<string, unknown>;
    const format = String(s.format ?? 'PNG');
    const job = (async () => {
      if (!this.doc.has(id)) throw new Error(`The node (id: ${id}) does not exist`);
      if (format === 'JSON_REST_V1') return { document: restJson(this.doc, id), components: {}, componentSets: {}, styles: {}, schemaVersion: 0 };
      if (!['PNG', 'JPG', 'SVG', 'SVG_STRING', 'PDF'].includes(format)) throw new Error(`exportAsync: неизвестный формат ${format}`);
      if (!this.env.exportNode) throw new Error('exportAsync: экспорт недоступен');
      return this.env.exportNode(id, { ...s, format });
    })();
    this.settleAsync(Number(promiseId), job);
  }

  /** getCSSAsync: CSS properties of the layer (as in Inspect). */
  m_getCSS(promiseId: Wire, idw: Wire) {
    const id = String(idw);
    const job = (async () => {
      if (!this.doc.has(id)) throw new Error(`The node (id: ${id}) does not exist`);
      return Object.fromEntries(cssDeclarations(this.doc, id));
    })();
    this.settleAsync(Number(promiseId), job);
  }

  // ---------- SVG, boolean operations, flatten, ungroup ----------

  /** figma.createNodeFromSvg: a frame with vectors at (0, 0) of the current page. */
  m_createNodeFromSvg(svg: Wire) {
    const frame = importSvgText(this.doc, String(svg), { kit: pathKit, parent: this.env.getCurrentPage(), name: 'svg', origin: [0, 0] });
    if (!frame) throw new Error('Failed to parse SVG');
    return node(frame);
  }

  /** Wrap nodes in a new container in parent: bounds follow the nodes; their position on the page does not change. */
  private wrap(ids: string[], parentId: string, index: Wire, type: 'BOOLEAN_OPERATION', props: Props): string {
    const box = this.unionBox(ids);
    const parentAbs = this.doc.type(parentId) === 'PAGE' ? IDENTITY : this.absoluteTransform(parentId);
    const groupAbs: Matrix = [1, 0, box.x, 0, 1, box.y];
    const g = this.doc.create(type, parentId, { ...props, transform: multiply(invert(parentAbs), groupAbs), width: box.width, height: box.height }, index === null || index === undefined ? undefined : Number(index));
    for (const id of ids) {
      const abs = this.absoluteTransform(id);
      this.doc.move(id, g);
      this.doc.set(id, { transform: multiply(invert(groupAbs), abs) });
    }
    return g;
  }

  /** Bottom layer of the nodes (the result of a boolean operation and flatten takes its appearance). */
  private bottomOf(ids: string[]): string {
    const parent = this.doc.parent(ids[0]!);
    if (!parent || ids.some((id) => this.doc.parent(id) !== parent)) return ids[0]!;
    const order = this.doc.children(parent);
    return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]!;
  }

  /** figma.union / subtract / intersect / exclude. */
  m_booleanOp(op: Wire, nodes: Wire, parent: Wire, index: Wire) {
    const kind = String(op);
    if (!BOOLEAN_NAMES[kind]) throw new Error(`Неизвестная булева операция ${kind}`);
    const ids = (nodes as Wire[]).map(nodeId);
    if (!ids.length) throw new Error('Нужен хотя бы один узел');
    const parentId = nodeId(parent);
    const bottom = this.doc.props(this.bottomOf(ids));
    return node(
      this.doc.transact(() =>
        this.wrap(ids, parentId, index, 'BOOLEAN_OPERATION', {
          name: BOOLEAN_NAMES[kind],
          booleanOperation: kind as Props['booleanOperation'],
          fills: bottom.fills ?? [],
          strokes: bottom.strokes ?? [],
          strokeWeight: bottom.strokeWeight ?? 1,
        }),
      ),
    );
  }

  /**
   * figma.flatten: nodes become one vector (paths combined). The path is built immediately (svg-path); the
   * exact one (boolean operations, text, smoothed corners) is sent by the editor afterwards and the vector updates.
   */
  m_flatten(nodes: Wire, parent: Wire, index: Wire) {
    const doc = this.doc;
    const ids = (nodes as Wire[]).map(nodeId).filter((id) => doc.has(id));
    if (!ids.length) throw new Error('flatten: нужен хотя бы один узел');
    const parentId = parent ? nodeId(parent) : doc.parent(ids[0]!)!;
    const segs: Seg[] = [];
    for (const id of ids) segs.push(...transformPath(nodeOutline(doc, id), this.absoluteTransform(id)));
    let [x0, y0, x1, y1] = pathBounds(segs);
    if (!segs.length) {
      const b = this.unionBox(ids);
      [x0, y0, x1, y1] = [b.x, b.y, b.x + b.width, b.y + b.height];
    }
    const at = index === null || index === undefined ? (parent ? undefined : doc.children(parentId).indexOf(this.bottomOf(ids))) : Number(index);
    // The exact path comes from the editor while the source layers still exist there (before the edits below).
    const exact = this.env.flattenGeometry?.(ids, [x0, y0]);
    const style = doc.props(this.bottomOf(ids));
    const width = Math.max(0.01, x1 - x0);
    const height = Math.max(0.01, y1 - y0);
    const v = doc.transact(() => {
      const parentAbs = doc.type(parentId) === 'PAGE' ? IDENTITY : this.absoluteTransform(parentId);
      const vec = doc.create(
        'VECTOR',
        parentId,
        {
          name: 'Vector',
          transform: multiply(invert(parentAbs), [1, 0, x0, 0, 1, y0]),
          width,
          height,
          geometrySize: { width, height },
          vectorPaths: [{ windingRule: 'NONZERO', data: pathToSvg(segs, -x0, -y0) }],
          fills: style.fills ?? [],
          strokes: style.strokes ?? [],
          strokeWeight: style.strokeWeight ?? 1,
          strokeAlign: style.strokeAlign,
          effects: style.effects,
          opacity: style.opacity,
        },
        at === undefined || at < 0 ? undefined : at,
      );
      for (const id of ids) if (doc.has(id)) doc.delete(id);
      return vec;
    });
    const undoGroup = this.undoGroup;
    exact?.then(
      (svg) => {
        const exactSegs = svg ? parsePath(svg) : null;
        if (!exactSegs || !doc.has(v)) return;
        const [ex0, ey0, ex1, ey1] = pathBounds(exactSegs);
        const w = Math.max(0.01, ex1 - ex0);
        const h = Math.max(0.01, ey1 - ey0);
        const t = (doc.get(v, 'transform') ?? IDENTITY) as Matrix;
        doc.withUndoGroup(undoGroup, () => doc.set(v, {
          transform: multiply(t, [1, 0, ex0, 0, 1, ey0]),
          width: w,
          height: h,
          geometrySize: { width: w, height: h },
          vectorPaths: [{ windingRule: 'NONZERO', data: pathToSvg(exactSegs, -ex0, -ey0) }],
        }));
      },
      () => {},
    );
    return node(v);
  }

  /** figma.ungroup: children move into the parent in place of the node (same position on the page); the node is removed. */
  m_ungroup(nodew: Wire) {
    const doc = this.doc;
    const id = nodeId(nodew);
    const parent = doc.parent(id);
    if (!parent || !CONTAINER_TYPES.has(doc.type(id)!)) throw new Error('ungroup: нужен узел с детьми');
    const kids = [...doc.children(id)];
    const m = (doc.get(id, 'transform') ?? IDENTITY) as Matrix;
    doc.transact(() => {
      let at = doc.children(parent).indexOf(id);
      for (const k of kids) {
        const km = (doc.get(k, 'transform') ?? IDENTITY) as Matrix;
        doc.move(k, parent, at++);
        doc.set(k, { transform: multiply(m, km) });
      }
      doc.delete(id);
    });
    return kids.map((k) => node(k));
  }

  // ---------- Nodes ----------

  m_has(id: Wire, prop: Wire) {
    return this.m_get(id, prop) !== undefined;
  }

  m_get(idw: Wire, propw: Wire): Wire {
    const id = String(idw);
    const prop = String(propw);
    const doc = this.doc;
    const rec = doc.node(id);
    if (prop === 'removed') return !rec;
    if (!rec) throw new Error(`The node (id: ${id}) does not exist`);
    const t = rec.type;
    const tf = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
    // Motion: keyframes, motion styles, timeline.
    const mv = motionGet(doc, id, prop);
    if (mv !== MOTION_NOT) return mv as Wire;
    // Styles, variables, component properties.
    const ds = designGet(doc, id, t, prop);
    if (ds !== NOT) return ds;
    switch (prop) {
      case 'type':
        return t === 'TEXT' && doc.get(id, 'textPath') ? 'TEXT_PATH' : t;
      case 'textPathStartData': {
        const path = doc.get(id, 'textPath');
        if (!path) return undefined;
        if (path.startData) return path.startData;
        const net = networkFromSvg(path.data);
        return net ? textPathStartFromOffset(net, path.offset ?? 0) : undefined;
      }
      case 'parent':
        return node(rec.parent);
      case 'children':
        // The internal page (styles, variables) is not a document page.
        if (t === 'DOCUMENT') return userPages(doc).map((c) => node(c));
        return CONTAINER_TYPES.has(t) ? doc.children(id).filter(c => !this.skipped(c)).map((c) => node(c)) : undefined;
      case 'x':
        return tf[2];
      case 'y':
        return tf[5];
      case 'width':
        return doc.get(id, 'width') ?? 0;
      case 'height':
        return doc.get(id, 'height') ?? 0;
      case 'rotation':
        return rotationOf(tf);
      case 'relativeTransform':
        return [
          [tf[0], tf[1], tf[2]],
          [tf[3], tf[4], tf[5]],
        ];
      case 'absoluteTransform': {
        const m = this.absoluteTransform(id);
        return [
          [m[0], m[1], m[2]],
          [m[3], m[4], m[5]],
        ];
      }
      case 'absoluteBoundingBox':
      case 'absoluteRenderBounds': {
        return this.unionBox([id]);
      }
      case 'selection':
        return t === 'PAGE' ? (id === this.env.getCurrentPage() ? this.env.getSelection().filter(s => !this.skipped(s)).map((s) => node(s)) : []) : undefined;
      case 'backgrounds':
        return t === 'PAGE' ? (doc.get(id, 'backgrounds') ?? []) : undefined;
      case 'layoutSizingHorizontal':
      case 'layoutSizingVertical':
        if (t === 'PAGE' || t === 'DOCUMENT') return undefined;
        const mode = getSizing(doc, id, prop === 'layoutSizingHorizontal' ? 'width' : 'height');
        // The plugin API has no percentages: for a plugin this is a fixed size.
        return mode === 'PERCENT' ? 'FIXED' : mode;
      case 'constraints':
        return t === 'PAGE' || t === 'DOCUMENT' ? undefined : doc.get(id, 'constraints');
      case 'autoRename':
        return t === 'TEXT' ? textAutoRename(doc.props(id)) : undefined;
      case 'hasMissingFont':
        return t === 'TEXT' ? false : undefined;
      case 'listOptions':
        if (t !== 'TEXT') return undefined;
        break;
      // Per-side weight: a shared value if all sides are equal, otherwise figma.mixed.
      case 'strokeWeight': {
        const sides = SIDE_KEYS.map((k) => doc.get(id, k));
        const w = doc.get(id, 'strokeWeight');
        if (sides.every((v) => v === undefined)) return w;
        const all = sides.map((v) => v ?? w);
        return all.every((v) => v === all[0]) ? all[0] : { $mixed: true };
      }
      case 'strokeTopWeight':
      case 'strokeRightWeight':
      case 'strokeBottomWeight':
      case 'strokeLeftWeight':
        return doc.get(id, prop) ?? doc.get(id, 'strokeWeight');
      // Caps: the Plugin API has a single strokeCap; different start and end caps give figma.mixed.
      case 'strokeCap': {
        const a = doc.get(id, 'strokeStartCap');
        const b = doc.get(id, 'strokeEndCap');
        return a === b ? a : { $mixed: true };
      }
      case 'exportSettings':
        return structuredClone(doc.get(id, 'exportSettings') ?? []);
      // Developer mode.
      case 'devStatus': {
        const st = doc.get(id, 'devStatus');
        return st ? { type: st.type, ...(st.description ? { description: st.description } : {}) } : null;
      }
      case 'annotations':
        return (doc.get(id, 'annotations') ?? []).map((a) => ({
          label: (a.labelMarkdown ?? '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)'),
          labelMarkdown: a.labelMarkdown ?? '',
          properties: a.properties ?? [],
          ...(a.categoryId ? { categoryId: a.categoryId } : {}),
        }));
      // Prototype.
      case 'reactions':
        return t === 'PAGE' || t === 'DOCUMENT' ? undefined : wireReactions(reactionsOf(doc, id));
      case 'overflowDirection':
      case 'overlayPositionType':
      case 'overlayBackground':
      case 'overlayBackgroundInteraction':
        return SCROLL_TYPES.has(t) ? doc.get(id, prop) : undefined;
      case 'numberOfFixedChildren': {
        if (!SCROLL_TYPES.has(t)) return undefined;
        // Pinned ones are the last children (top layers).
        const kids = doc.children(id);
        let n = 0;
        while (n < kids.length && doc.get(kids[kids.length - 1 - n]!, 'scrollBehavior') === 'FIXED') n++;
        return n;
      }
      case 'scrollBehavior':
        return t === 'PAGE' || t === 'DOCUMENT' ? undefined : (doc.get(id, 'scrollBehavior') ?? 'SCROLLS');
      case 'flowStartingPoints':
        return t === 'PAGE' ? (doc.get(id, 'flowStartingPoints') ?? []).filter((f) => doc.has(f.nodeId)) : undefined;
      case 'prototypeBackgrounds':
        return t === 'PAGE' ? (doc.get(id, 'prototypeBackgrounds') ?? []) : undefined;
      case 'prototypeStartNode': {
        if (t !== 'PAGE') return undefined;
        const f = (doc.get(id, 'flowStartingPoints') ?? []).find((x) => doc.has(x.nodeId));
        return node(f?.nodeId);
      }
      case 'targetAspectRatio':
        if (t === 'PAGE' || t === 'DOCUMENT') return undefined;
        return doc.get(id, 'constrainProportions') ? { x: doc.get(id, 'width') ?? 0, y: doc.get(id, 'height') ?? 0 } : null;
      // Vector paths (like VectorNode.vectorPaths).
      case 'vectorPaths':
        if (t !== 'VECTOR' && !(t === 'TEXT' && doc.get(id, 'textPath'))) return undefined;
        return (doc.get(id, 'vectorPaths') ?? (doc.get(id, 'textPath') ? [{ windingRule: 'NONZERO', data: doc.get(id, 'textPath')!.data }] : [])).map((p) => ({ windingRule: p.windingRule, data: p.data ?? (p.blob ? (doc.blob(p.blob) ?? '') : '') }));
      // Vector network (like VectorNode.vectorNetwork): at the current node size.
      case 'vectorNetwork': {
        if (t !== 'VECTOR' && !(t === 'TEXT' && doc.get(id, 'textPath'))) return undefined;
        const net = networkOf(doc, id) ?? (doc.get(id, 'textPath') ? networkFromSvg(doc.get(id, 'textPath')!.data) : null);
        if (!net) return { vertices: [], segments: [], regions: [] };
        return {
          vertices: net.vertices.map((v) => ({ ...v })),
          segments: net.segments.map((g) => ({ start: g.start, end: g.end, tangentStart: { ...(g.tangentStart ?? { x: 0, y: 0 }) }, tangentEnd: { ...(g.tangentEnd ?? { x: 0, y: 0 }) } })),
          regions: (net.regions ?? []).map((r) => ({ windingRule: r.windingRule, loops: r.loops.map((l) => [...l]), ...(r.fills ? { fills: r.fills } : {}), ...(r.fillStyleId ? { fillStyleId: r.fillStyleId } : {}) })),
        } as unknown as Wire;
      }
      // Handle mirroring across all vertices (differing — figma.mixed).
      case 'handleMirroring': {
        if (t !== 'VECTOR' && !(t === 'TEXT' && doc.get(id, 'textPath'))) return undefined;
        const net = networkOf(doc, id) ?? (doc.get(id, 'textPath') ? networkFromSvg(doc.get(id, 'textPath')!.data) : null);
        const values = new Set((net?.vertices ?? []).map((v) => v.handleMirroring ?? 'NONE'));
        if (values.size > 1) return { $mixed: true };
        return [...values][0] ?? 'NONE';
      }
      case 'isAsset':
        return false;
      case 'mainComponent':
        return null;
      case 'expanded':
        return false;
      default:
        break;
    }
    // Text formatting: differing across pieces — figma.mixed.
    if (t === 'TEXT' && (TEXT_STYLE_KEYS.includes(prop as TextStyleKey) || prop === 'listOptions')) {
      const p = doc.props(id);
      const len = (p.characters ?? '').length;
      const key = (prop === 'listOptions' ? 'listType' : prop) as TextStyleKey;
      const v = rangeValue(p, p.textRuns, len, 0, len, key);
      if (v === MIXED) return { $mixed: true };
      return prop === 'listOptions' ? { type: v ?? 'NONE' } : textValueOut(prop, v);
    }
    if (DIRECT.has(prop as keyof Props)) return doc.get(id, prop as keyof Props);
    return undefined;
  }

  m_set(idw: Wire, propw: Wire, value: Wire) {
    const id = String(idw);
    const prop = String(propw);
    const rec = this.doc.node(id);
    if (!rec) throw new Error(`The node (id: ${id}) does not exist`);
    if (READONLY.has(prop)) throw new Error(`Cannot assign to read only property '${prop}' of object '[object ${rec.type}Node]'`);
    const textPath = this.doc.get(id, 'textPath');
    if (rec.type === 'TEXT' && textPath && ['vectorPaths', 'vectorNetwork', 'handleMirroring'].includes(prop)) throw new Error(prop + ' is read only on TEXT_PATH');
    if (motionSet(this.doc, id, prop, value)) return;
    if (prop === 'textPathStartData') {
      if (rec.type !== 'TEXT' || !textPath) throw new Error('textPathStartData is only available on TEXT_PATH');
      const ref = this.doc.get(id, 'vectorNetwork');
      const raw = ref?.data ?? (ref?.blob ? this.doc.blob(ref.blob) : undefined);
      const net = raw ? decodeNetwork(raw) : networkFromSvg(textPath.data);
      if (!net) throw new Error('Text path geometry is unavailable');
      const start = value as { segment: number; position: number } | null;
      return this.doc.set(id, { textPath: textPathFromStart(net, start?.segment as number, start?.position as number) });
    }
    if (designSet(this.doc, id, rec.type, prop, value)) return;
    const tf = (this.doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
    switch (prop) {
      case 'autoRename':
        if (rec.type !== 'TEXT') throw new Error('autoRename is only available on text nodes');
        if (typeof value !== 'boolean') throw new Error('autoRename must be a boolean');
        return this.doc.set(id, { autoRename: value });
      case 'x':
        return this.doc.set(id, { transform: [tf[0], tf[1], Number(value), tf[3], tf[4], tf[5]] });
      case 'y':
        return this.doc.set(id, { transform: [tf[0], tf[1], tf[2], tf[3], tf[4], Number(value)] });
      case 'rotation':
        return this.doc.set(id, { transform: withRotation(tf, Number(value)) });
      case 'relativeTransform': {
        const m = value as [[number, number, number], [number, number, number]];
        return this.doc.set(id, { transform: [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2]] });
      }
      case 'selection': {
        if (rec.type !== 'PAGE') throw new Error('selection есть только у страницы');
        return this.env.setSelection((value as Wire[]).map(nodeId));
      }
      case 'backgrounds':
        return this.doc.set(id, { backgrounds: value as Paint[] });
      // Developer mode: status, annotations, export settings.
      case 'devStatus': {
        const v = value as { type?: string; description?: string } | null;
        if (v && v.type !== 'READY_FOR_DEV' && v.type !== 'COMPLETED') throw new Error('devStatus.type: READY_FOR_DEV или COMPLETED');
        return this.doc.set(id, { devStatus: v ? { type: v.type as 'READY_FOR_DEV' | 'COMPLETED', updated: Date.now(), ...(v.description ? { description: String(v.description) } : {}) } : null });
      }
      case 'annotations': {
        if (!Array.isArray(value)) throw new Error('annotations должен быть массивом');
        const list = (value as { label?: string; labelMarkdown?: string; properties?: { type: string }[]; categoryId?: string }[]).map((a) => ({
          labelMarkdown: String(a.labelMarkdown ?? a.label ?? ''),
          ...(a.properties?.length ? { properties: a.properties.map((p) => ({ type: p.type as never })) } : {}),
          ...(a.categoryId ? { categoryId: String(a.categoryId) } : {}),
        }));
        return this.doc.set(id, { annotations: list.length ? list : undefined });
      }
      case 'exportSettings': {
        if (!Array.isArray(value)) throw new Error('exportSettings должен быть массивом');
        return this.doc.set(id, { exportSettings: structuredClone(value) as Props['exportSettings'] });
      }
      // Prototype.
      case 'reactions':
        if (rec.type === 'PAGE' || rec.type === 'DOCUMENT') throw new Error('У страницы нет reactions');
        return this.doc.set(id, { reactions: readReactions(value) });
      case 'overflowDirection': {
        const v = String(value);
        if (!SCROLL_TYPES.has(rec.type)) throw new Error(`overflowDirection есть только у фреймов`);
        if (!['NONE', 'HORIZONTAL', 'VERTICAL', 'BOTH'].includes(v)) throw new Error(`Invalid overflowDirection: ${v}`);
        return this.doc.set(id, { overflowDirection: v as Props['overflowDirection'] });
      }
      case 'scrollBehavior': {
        const v = String(value);
        if (!['SCROLLS', 'FIXED', 'STICKY_SCROLLS'].includes(v)) throw new Error(`Invalid scrollBehavior: ${v}`);
        return this.doc.set(id, { scrollBehavior: v as Props['scrollBehavior'] });
      }
      case 'numberOfFixedChildren': {
        if (!SCROLL_TYPES.has(rec.type)) throw new Error('numberOfFixedChildren есть только у фреймов');
        const kids = this.doc.children(id);
        const n = Math.max(0, Math.min(kids.length, Math.floor(Number(value))));
        this.doc.transact(() => kids.forEach((c, i) => {
          const fixed = i >= kids.length - n;
          const cur = this.doc.get(c, 'scrollBehavior') ?? 'SCROLLS';
          if (fixed && cur !== 'FIXED') this.doc.set(c, { scrollBehavior: 'FIXED' });
          else if (!fixed && cur === 'FIXED') this.doc.set(c, { scrollBehavior: 'SCROLLS' });
        }));
        return;
      }
      case 'flowStartingPoints': {
        if (rec.type !== 'PAGE') throw new Error('flowStartingPoints есть только у страницы');
        if (!Array.isArray(value)) throw new Error('flowStartingPoints: ожидался массив');
        const flows: FlowStartingPoint[] = (value as { nodeId?: unknown; name?: unknown; description?: unknown }[]).map((f) => ({ nodeId: String(f.nodeId), name: String(f.name ?? ''), ...(f.description ? { description: String(f.description) } : {}) }));
        return this.doc.set(id, { flowStartingPoints: flows });
      }
      case 'prototypeBackgrounds':
        if (rec.type !== 'PAGE') throw new Error('prototypeBackgrounds есть только у страницы');
        return this.doc.set(id, { prototypeBackgrounds: value as Paint[] });
      case 'layoutSizingHorizontal':
      case 'layoutSizingVertical': {
        const mode = String(value) as SizingMode;
        if (mode === 'HUG' && !canHug(this.doc, id)) throw new Error('HUG can only be set on auto-layout frames and text nodes');
        if (mode === 'FILL' && !canFill(this.doc, id)) throw new Error('FILL can only be set on children of auto-layout frames');
        if (mode !== 'FIXED' && mode !== 'HUG' && mode !== 'FILL') throw new Error(`Invalid layout sizing: ${mode}`);
        setSizing(this.doc, id, prop === 'layoutSizingHorizontal' ? 'width' : 'height', mode);
        return;
      }
      case 'strokeWeight':
        return this.doc.set(id, { strokeWeight: Number(value), strokeTopWeight: undefined, strokeRightWeight: undefined, strokeBottomWeight: undefined, strokeLeftWeight: undefined });
      case 'strokeTopWeight':
      case 'strokeRightWeight':
      case 'strokeBottomWeight':
      case 'strokeLeftWeight': {
        // First individual side: the others get the current shared weight.
        const w = this.doc.get(id, 'strokeWeight') ?? 1;
        const props: Props = {};
        for (const k of SIDE_KEYS) props[k] = k === prop ? Number(value) : (this.doc.get(id, k) ?? w);
        return this.doc.set(id, props);
      }
      case 'strokeCap':
        return this.doc.set(id, { strokeStartCap: value as StrokeCap, strokeEndCap: value as StrokeCap });
      case 'vectorPaths': {
        if (rec.type !== 'VECTOR') throw new Error('vectorPaths есть только у вектора');
        if (!Array.isArray(value)) throw new Error('vectorPaths: ожидался массив');
        // Paths become a network; layer bounds follow the shape, everything stays in place on the page.
        const nets = (value as { windingRule?: string; data?: unknown }[]).map((p) => {
          const segs = parsePath(String(p?.data ?? ''));
          const net = segs && networkFromSvg(pathToSvg(segs, 0, 0), p.windingRule === 'EVENODD' ? 'EVENODD' : 'NONZERO');
          if (!net) throw new Error(`vectorPaths: не удалось разобрать «${String(p?.data ?? '').slice(0, 40)}»`);
          return net;
        });
        return this.doc.transact(() => this.doc.set(id, networkProps(this.doc, id, mergeNetworks(nets), { shared: true })));
      }
      case 'vectorNetwork': {
        if (rec.type !== 'VECTOR') throw new Error('vectorNetwork есть только у вектора');
        const net = apiNetwork(value);
        return this.doc.transact(() => this.doc.set(id, networkProps(this.doc, id, net, { shared: true })));
      }
      case 'handleMirroring': {
        if (rec.type !== 'VECTOR') throw new Error('handleMirroring есть только у вектора');
        if (value !== 'NONE' && value !== 'ANGLE' && value !== 'ANGLE_AND_LENGTH') throw new Error('handleMirroring: NONE, ANGLE или ANGLE_AND_LENGTH');
        const cur = networkOf(this.doc, id);
        if (!cur) return;
        const net: VectorNetwork = { ...cur, vertices: cur.vertices.map((v) => ({ ...v, handleMirroring: value as HandleMirroring })) };
        return this.doc.transact(() => this.doc.set(id, networkProps(this.doc, id, net, { shared: true })));
      }
      case 'characters': {
        if (rec.type !== 'TEXT') return;
        // The whole new text uses the formatting of the first character.
        const p = this.doc.props(id);
        const first = effectiveStyle(p, styleAt(p.textRuns, 0));
        const props: Props = { characters: String(value), textRuns: [], ...(p.textGlyphs ? { textGlyphs: undefined } : {}) };
        for (const k of TEXT_STYLE_KEYS) if (JSON.stringify(first[k]) !== JSON.stringify(p[k])) (props as Record<string, unknown>)[k] = first[k];
        return this.doc.set(id, props);
      }
      case 'listOptions':
        if (rec.type !== 'TEXT') return;
        return restyleText(this.doc, id, 0, (this.doc.get(id, 'characters') ?? '').length, () => ({ listType: ((value as { type?: string }) ?? {}).type as Props['listType'] ?? 'NONE' }), true);
      case 'fills':
      case 'strokes':
        if (!Array.isArray(value)) throw new Error(`${prop} должен быть массивом заливок`);
        if (prop === 'fills' && rec.type === 'TEXT') {
          for (const p of value as Paint[]) validatePaint(p);
          return restyleText(this.doc, id, 0, (this.doc.get(id, 'characters') ?? '').length, () => ({ fills: value as Paint[] }));
        }
        for (const p of value as Paint[]) validatePaint(p);
        return this.doc.set(id, { [prop]: value } as Props);
      default:
        // Formatting of the whole text: the node value; per-piece differences are removed.
        if (rec.type === 'TEXT' && TEXT_STYLE_KEYS.includes(prop as TextStyleKey)) {
          const v = textValueIn(prop, value);
          return restyleText(this.doc, id, 0, (this.doc.get(id, 'characters') ?? '').length, () => ({ [prop]: v }), PARAGRAPH_KEYS.includes(prop as TextStyleKey));
        }
        if (DIRECT.has(prop as keyof Props)) return this.doc.set(id, { [prop]: value } as Props);
        // Unknown properties are silently ignored, as many hosts do.
        return;
    }
  }

  m_appendChild(parent: Wire, child: Wire) {
    this.doc.move(nodeId(child), String(parent));
  }

  m_insertChild(parent: Wire, index: Wire, child: Wire) {
    this.doc.move(nodeId(child), String(parent), Number(index));
  }

  m_remove(id: Wire) {
    if (!designRemove(this.doc, String(id))) this.doc.delete(String(id));
  }

  /** Methods of styles, variables, collections, components and instances. */
  m_nodeMethod(id: Wire, name: Wire, args: Wire) {
    if (!this.doc.node(String(id))) throw new Error(`The node (id: ${String(id)}) does not exist`);
    const mr = motionMethod(this.doc, String(id), String(name), (args as Wire[]) ?? []);
    if (mr !== MOTION_NOT) return (mr ?? null) as Wire;
    const r = designMethod(this.doc, String(id), String(name), (args as Wire[]) ?? []);
    if (r === NOT) throw new Error(`Метод ${String(name)} не поддерживается`);
    return r;
  }

  /** Developer mode: annotation categories (figma.annotations) and page measurements. */
  m_dev(method: Wire, ...args: Wire[]) {
    const doc = this.doc;
    const wireM = (m: Measurement) => ({ id: m.id, start: { node: node(m.start.node), side: m.start.side }, end: { node: node(m.end.node), side: m.end.side }, offset: m.offset, freeText: m.freeText });
    const page = () => {
      const p = String(args[0]);
      if (doc.type(p) !== 'PAGE') throw new Error('Измерения есть только у страницы');
      return p;
    };
    const side = (v: unknown): MeasurementSide => {
      const s = String(v);
      if (s !== 'TOP' && s !== 'RIGHT' && s !== 'BOTTOM' && s !== 'LEFT') throw new Error('side: TOP, RIGHT, BOTTOM или LEFT');
      return s;
    };
    switch (String(method)) {
      case 'categories':
        return annotationCategories(doc);
      case 'category':
        return annotationCategories(doc).find((c) => c.id === String(args[0])) ?? null;
      case 'addCategory': {
        const c = args[0] as { label?: string; color?: string };
        const cat = { id: doc.newId(), label: String(c?.label ?? 'Категория'), color: (String(c?.color ?? 'blue').toLowerCase() as AnnotationCategory['color']), isPreset: false };
        doc.set(doc.root, { annotationCategories: [...annotationCategories(doc), cat] });
        return cat;
      }
      case 'getMeasurements':
        return measurementsOf(doc, page()).map(wireM);
      case 'getMeasurementsForNode': {
        const n = nodeId(args[1]);
        return measurementsOf(doc, page()).filter((m) => m.start.node === n || m.end.node === n).map(wireM);
      }
      case 'addMeasurement': {
        const s = args[1] as { node: Wire; side: string };
        const e = args[2] as { node: Wire; side: string };
        const o = (args[3] ?? {}) as { offset?: Measurement['offset']; freeText?: string };
        return wireM(addMeasurement(doc, page(), { node: nodeId(s.node), side: side(s.side) }, { node: nodeId(e.node), side: side(e.side) }, { offset: o.offset, freeText: o.freeText }));
      }
      case 'editMeasurement': {
        const p = page();
        editMeasurement(doc, p, String(args[1]), (args[2] ?? {}) as { offset?: Measurement['offset']; freeText?: string });
        const m = measurementsOf(doc, p).find((x) => x.id === String(args[1]));
        return m ? wireM(m) : null;
      }
      case 'deleteMeasurement':
        deleteMeasurement(doc, page(), String(args[1]));
        return null;
    }
    throw new Error(`Метод ${String(method)} не поддерживается`);
  }

  /** Design system figma.*: styles, variables, variant sets. */
  m_ds(method: Wire, ...args: Wire[]) {
    const fn = (designGlobals as Record<string, (doc: Document, ...a: Wire[]) => Wire>)[String(method)];
    if (!fn) throw new Error(`Метод ${String(method)} не поддерживается`);
    return fn(this.doc, ...args);
  }

  /** resize(): children follow their constraints. */
  m_resize(id: Wire, w: Wire, h: Wire) {
    const width = Number(w);
    const height = Number(h);
    if (!(width >= 0.01) || !(height >= 0)) throw new Error('resize: размеры должны быть положительными');
    resizeWithConstraints(this.doc, String(id), { width, height });
  }

  /** resizeWithoutConstraints(): children stay in place. */
  m_resizeWithoutConstraints(id: Wire, w: Wire, h: Wire) {
    const width = Number(w);
    const height = Number(h);
    if (!(width >= 0.01) || !(height >= 0)) throw new Error('resize: размеры должны быть положительными');
    this.doc.set(String(id), { width, height });
  }

  /** Like the “Scale” tool: the layer and all its contents, including strokes, text and effects. */
  m_rescale(id: Wire, scale: Wire) {
    const s = Number(scale);
    if (!(s > 0)) throw new Error('rescale: масштаб должен быть больше нуля');
    if (!this.doc.node(String(id))) return;
    scaleTree(this.doc, String(id), s);
  }

  m_clone(idw: Wire) {
    const id = String(idw);
    const doc = this.doc;
    const src = doc.node(id);
    if (!src?.parent) throw new Error('Нельзя клонировать этот узел');
    return doc.transact(() => {
      const copy = (from: string, parent: string, index?: number): string => {
        const rec = doc.node(from)!;
        const newId = doc.create(rec.type, parent, rec.props, index);
        for (const c of doc.children(from)) copy(c, newId);
        return newId;
      };
      // The copy appears immediately on top of the original in the same parent.
      const siblings = doc.children(src.parent!);
      return node(copy(id, src.parent!, siblings.indexOf(id) + 1));
    });
  }

  m_getPluginData(id: Wire, key: Wire) {
    return this.doc.get(String(id), 'pluginData')?.[this.pluginId]?.[String(key)] ?? '';
  }

  m_setPluginData(id: Wire, key: Wire, value: Wire) {
    const all = { ...(this.doc.get(String(id), 'pluginData') ?? {}) };
    all[this.pluginId] = { ...(all[this.pluginId] ?? {}), [String(key)]: String(value) };
    if (value === '') delete all[this.pluginId]![String(key)];
    this.doc.set(String(id), { pluginData: all });
  }

  m_getPluginDataKeys(id: Wire) {
    return Object.keys(this.doc.get(String(id), 'pluginData')?.[this.pluginId] ?? {});
  }

  m_getSharedPluginData(id: Wire, ns: Wire, key: Wire) {
    return this.doc.get(String(id), 'sharedPluginData')?.[String(ns)]?.[String(key)] ?? '';
  }

  m_setSharedPluginData(id: Wire, ns: Wire, key: Wire, value: Wire) {
    const all = { ...(this.doc.get(String(id), 'sharedPluginData') ?? {}) };
    all[String(ns)] = { ...(all[String(ns)] ?? {}), [String(key)]: String(value) };
    if (value === '') delete all[String(ns)]![String(key)];
    this.doc.set(String(id), { sharedPluginData: all });
  }

  m_getSharedPluginDataKeys(id: Wire, ns: Wire) {
    return Object.keys(this.doc.get(String(id), 'sharedPluginData')?.[String(ns)] ?? {});
  }

  // ---------- Helpers ----------

  /** Absolute transform of a node relative to the page. */
  absoluteTransform(id: string): Matrix {
    return absoluteTransformOf(this.doc, id);
  }

  /** Node bounds in page coordinates. */
  unionBox(ids: string[]) {
    return unionBoxOf(this.doc, ids);
  }
}

/** Absolute transform of a node relative to the page. */
export function absoluteTransformOf(doc: Document, id: string): Matrix {
  const chain: Matrix[] = [];
  for (let cur: string | null = id; cur; cur = doc.parent(cur)) {
    const t = doc.type(cur);
    if (t === 'PAGE' || t === 'DOCUMENT') break;
    chain.unshift((doc.get(cur, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix);
  }
  return chain.reduce((acc, m) => multiply(acc, m), [1, 0, 0, 0, 1, 0] as Matrix);
}

/** Node bounds in page coordinates. */
export function unionBoxOf(doc: Document, ids: readonly string[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const m = absoluteTransformOf(doc, id);
    const w = doc.get(id, 'width') ?? 0;
    const h = doc.get(id, 'height') ?? 0;
    for (const [px, py] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ] as const) {
      const x = m[0] * px + m[1] * py + m[2];
      const y = m[3] * px + m[4] * py + m[5];
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Network from the plugin (like VectorNetwork): validation and copy. */
function apiNetwork(value: Wire): VectorNetwork {
  const v = value as { vertices?: unknown; segments?: unknown; regions?: unknown } | null;
  if (!v || !Array.isArray(v.vertices) || !Array.isArray(v.segments)) throw new Error('vectorNetwork: нужны vertices и segments');
  const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const vertices = (v.vertices as Record<string, unknown>[]).map((p, i) => {
    if (!p || !finite(p.x) || !finite(p.y)) throw new Error(`vectorNetwork: вершина ${i} без x и y`);
    const out: VectorNetwork['vertices'][number] = { x: p.x as number, y: p.y as number };
    if (p.handleMirroring === 'NONE' || p.handleMirroring === 'ANGLE' || p.handleMirroring === 'ANGLE_AND_LENGTH') out.handleMirroring = p.handleMirroring;
    if (typeof p.strokeCap === 'string') out.strokeCap = p.strokeCap as StrokeCap;
    if (p.strokeJoin === 'MITER' || p.strokeJoin === 'BEVEL' || p.strokeJoin === 'ROUND') out.strokeJoin = p.strokeJoin;
    if (finite(p.cornerRadius) && (p.cornerRadius as number) > 0) out.cornerRadius = p.cornerRadius as number;
    return out;
  });
  const tangent = (t: unknown, what: string) => {
    if (t === undefined) return undefined;
    const q = t as { x?: unknown; y?: unknown };
    if (!finite(q?.x) || !finite(q?.y)) throw new Error(`vectorNetwork: ${what} — нужны x и y`);
    return { x: q.x as number, y: q.y as number };
  };
  const segments = (v.segments as Record<string, unknown>[]).map((g, i) => {
    const start = g?.start;
    const end = g?.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) < 0 || (start as number) >= vertices.length || (end as number) >= vertices.length) throw new Error(`vectorNetwork: отрезок ${i} ссылается на несуществующую вершину`);
    const ts = tangent(g.tangentStart, `касательная начала отрезка ${i}`);
    const te = tangent(g.tangentEnd, `касательная конца отрезка ${i}`);
    const out: VectorNetwork['segments'][number] = { start: start as number, end: end as number };
    if ((ts && (ts.x || ts.y)) || (te && (te.x || te.y))) {
      out.tangentStart = ts ?? { x: 0, y: 0 };
      out.tangentEnd = te ?? { x: 0, y: 0 };
    }
    return out;
  });
  const net: VectorNetwork = { vertices, segments };
  if (Array.isArray(v.regions) && v.regions.length) {
    net.regions = (v.regions as Record<string, unknown>[]).map((r, i) => {
      if (!Array.isArray(r?.loops)) throw new Error(`vectorNetwork: у области ${i} нет loops`);
      const loops = (r.loops as unknown[][]).map((l) => {
        if (!Array.isArray(l) || !l.every((k) => Number.isInteger(k) && (k as number) >= 0 && (k as number) < segments.length)) throw new Error(`vectorNetwork: петля области ${i} ссылается на несуществующий отрезок`);
        return l as number[];
      });
      const out: VectorRegion = { windingRule: r.windingRule === 'EVENODD' ? 'EVENODD' : 'NONZERO', loops };
      if (Array.isArray(r.fills)) {
        for (const p of r.fills as Paint[]) validatePaint(p);
        out.fills = r.fills as Paint[];
      }
      if (typeof r.fillStyleId === 'string' && r.fillStyleId) out.fillStyleId = r.fillStyleId;
      return out;
    });
  }
  return net;
}

function validatePaint(p: Paint) {
  if (!p || typeof p !== 'object' || !('type' in p)) throw new Error('Некорректная заливка');
  if (p.type === 'SOLID') {
    const c = p.color;
    if (!c || [c.r, c.g, c.b].some((v) => typeof v !== 'number' || v < 0 || v > 1)) {
      throw new Error('Цвет заливки: r, g, b должны быть числами от 0 до 1');
    }
  }
  if (p.type === 'SHADER') {
    if (typeof p.code !== 'string' || !p.code.includes('main')) throw new Error('Шейдер: code — код SkSL с half4 main(float2 p)');
  }
  if (p.type === 'PATTERN') {
    if (typeof p.sourceNodeId !== 'string' || !p.sourceNodeId) throw new Error('Узор: sourceNodeId — id слоя-источника');
    if (!['RECTANGULAR', 'HORIZONTAL_HEXAGONAL', 'VERTICAL_HEXAGONAL'].includes(p.tileType)) throw new Error('Узор: tileType — RECTANGULAR, HORIZONTAL_HEXAGONAL или VERTICAL_HEXAGONAL');
    if (typeof p.scalingFactor !== 'number' || !(p.scalingFactor > 0)) throw new Error('Узор: scalingFactor — число больше 0');
    if (!p.spacing || typeof p.spacing.x !== 'number' || typeof p.spacing.y !== 'number') throw new Error('Узор: spacing — { x, y }');
    if (!['START', 'CENTER', 'END'].includes(p.horizontalAlignment)) throw new Error('Узор: horizontalAlignment — START, CENTER или END');
  }
  if (p.type === 'VIDEO') {
    if (p.videoHash !== null && typeof p.videoHash !== 'string') throw new Error('Видео в заливке: videoHash — строка или null');
    if (!['FILL', 'FIT', 'CROP', 'TILE'].includes(p.scaleMode)) throw new Error('Видео в заливке: scaleMode — FILL, FIT, CROP или TILE');
  }
}

/** Color parsing for figma.util.rgb/rgba: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(). */
export function parseColor(input: string): { r: number; g: number; b: number; a: number } {
  const s = input.trim();
  const hex = /^#?([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const [r = 0, g = 0, b = 0, a = 1] = fn[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }
  throw new Error(`Не удалось разобрать цвет: ${input}`);
}
