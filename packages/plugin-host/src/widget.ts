// Widgets (Figma widget API): the component tree returned by the widget code in the sandbox
// (AutoLayout, Frame, Text, Span, Rectangle, Ellipse, Line, SVG, Image, Input, Fragment) becomes layers
// inside the widget frame. Rendering replaces all children; sizes are as in the API: a number,
// “hug-contents” (hug), “fill-parent” (stretch within a parent with auto layout).
// Layers with a handler (onClick) are tagged with the element path, and clicks on them go to the sandbox.

import type { Document, Effect, NodeType, Paint, Props, RGBA } from '@mfp/core';

export interface WidgetElement {
  type: string;
  props: Record<string, unknown>;
  children: (WidgetElement | string)[];
  path: string;
}

export interface WidgetHelpers {
  /** Image from bytes (data: URL) → hash. */
  image(bytes: Uint8Array): string | null;
  /** SVG → a frame with vectors in parent. */
  svg(markup: string, parent: string): string | null;
}

type Dir = 'HORIZONTAL' | 'VERTICAL' | null;

/** Color: “#RGB”, “#RRGGBB”, “#RRGGBBAA” or { r, g, b, a } (0…1). */
export function widgetColor(v: unknown): RGBA | null {
  if (typeof v === 'string') {
    let h = v.trim().replace(/^#/, '');
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  if (v && typeof v === 'object' && 'r' in v) {
    const c = v as { r: number; g: number; b: number; a?: number };
    return { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 };
  }
  return null;
}

/** Widget fill / stroke → paints. */
export function widgetPaints(v: unknown): Paint[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  const out: Paint[] = [];
  for (const p of list) {
    const direct = widgetColor(p);
    if (direct) {
      out.push({ type: 'SOLID', color: { r: direct.r, g: direct.g, b: direct.b }, ...(direct.a < 1 ? { opacity: direct.a } : {}) });
      continue;
    }
    if (p && typeof p === 'object') {
      const o = p as { type?: string; color?: unknown; opacity?: number };
      if (String(o.type).toLowerCase() === 'solid') {
        const c = widgetColor(o.color);
        if (c) out.push({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, ...((o.opacity ?? 1) * c.a < 1 ? { opacity: (o.opacity ?? 1) * c.a } : {}) });
      }
    }
  }
  return out;
}

const WEIGHT: Record<string, string> = {
  '100': 'Thin',
  '200': 'Extra Light',
  '300': 'Light',
  '400': 'Regular',
  '500': 'Medium',
  '600': 'Semi Bold',
  '700': 'Bold',
  '800': 'Extra Bold',
  '900': 'Black',
  thin: 'Thin',
  'extra-light': 'Extra Light',
  light: 'Light',
  normal: 'Regular',
  medium: 'Medium',
  'semi-bold': 'Semi Bold',
  bold: 'Bold',
  'extra-bold': 'Extra Bold',
  black: 'Black',
};

function fontStyle(weight: unknown, italic: unknown): string {
  const w = WEIGHT[String(weight ?? 400)] ?? 'Regular';
  if (italic === true) return w === 'Regular' ? 'Italic' : `${w} Italic`;
  return w;
}

const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

function padding(v: unknown): { paddingTop: number; paddingRight: number; paddingBottom: number; paddingLeft: number } {
  if (typeof v === 'number') return { paddingTop: v, paddingRight: v, paddingBottom: v, paddingLeft: v };
  const o = (v ?? {}) as Record<string, number>;
  const vert = o.vertical ?? 0;
  const hor = o.horizontal ?? 0;
  return { paddingTop: o.top ?? vert, paddingRight: o.right ?? hor, paddingBottom: o.bottom ?? vert, paddingLeft: o.left ?? hor };
}

function corners(v: unknown): Props {
  if (typeof v === 'number') return { cornerRadius: v };
  if (v && typeof v === 'object') {
    const o = v as Record<string, number>;
    return { cornerRadius: o.topLeft ?? 0, topLeftRadius: o.topLeft ?? 0, topRightRadius: o.topRight ?? 0, bottomRightRadius: o.bottomRight ?? 0, bottomLeftRadius: o.bottomLeft ?? 0 };
  }
  return {};
}

function effects(v: unknown): Effect[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const out: Effect[] = [];
  for (const e of list as Record<string, unknown>[]) {
    const t = String(e.type ?? '');
    const blur = num(e.blur, 0);
    if (t === 'drop-shadow' || t === 'inner-shadow') {
      const c = widgetColor(e.color) ?? { r: 0, g: 0, b: 0, a: 0.25 };
      const off = (e.offset ?? {}) as { x?: number; y?: number };
      out.push({ type: t === 'drop-shadow' ? 'DROP_SHADOW' : 'INNER_SHADOW', color: c, offset: { x: off.x ?? 0, y: off.y ?? 0 }, radius: blur, spread: num(e.spread, 0), visible: true, blendMode: 'NORMAL' } as Effect);
    } else if (t === 'layer-blur' || t === 'background-blur') out.push({ type: t === 'layer-blur' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', radius: blur, visible: true } as Effect);
  }
  return out;
}

/** Element text: strings and Span (without per-piece formatting). */
function textOf(el: WidgetElement): string {
  return el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

function base64Bytes(dataUrl: string): Uint8Array | null {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]!);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Render the widget tree in its frame (children recreated). */
export function renderWidget(doc: Document, widgetId: string, tree: WidgetElement | string | null, helpers: WidgetHelpers) {
  doc.transact(() => {
    for (const c of [...doc.children(widgetId)]) doc.delete(c);
    // The widget itself hugs its contents (the size comes from the tree root).
    doc.set(widgetId, { layoutMode: 'VERTICAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, fills: [], clipsContent: false });
    if (tree && typeof tree === 'object') build(doc, tree, widgetId, 'VERTICAL', helpers);
  });
}

function build(doc: Document, el: WidgetElement, parent: string, dir: Dir, helpers: WidgetHelpers) {
  const p = el.props;
  if (el.type === 'Fragment') {
    for (const c of el.children) if (typeof c === 'object') build(doc, c, parent, dir, helpers);
    return;
  }
  const props: Props = { name: typeof p.name === 'string' ? p.name : el.type };
  if (p.hidden === true) props.visible = false;
  if (typeof p.opacity === 'number') props.opacity = p.opacity;
  if (p.onClick === true || p.onTextEditEnd === true) props.widgetHandler = el.path;
  const fx = effects(p.effect);
  if (fx.length) props.effects = fx;
  const absolute = p.positioning === 'absolute' || (dir === null && doc.type(parent) !== 'PAGE');
  const x = num(p.x, 0);
  const y = num(p.y, 0);
  const rot = num(p.rotation, 0);
  const rad = (-rot * Math.PI) / 180;
  props.transform = [Math.cos(rad), -Math.sin(rad), x, Math.sin(rad), Math.cos(rad), y];
  if (p.positioning === 'absolute' && dir) props.layoutPositioning = 'ABSOLUTE';
  // Size along an axis: a number — fixed; fill-parent — stretch within the parent's auto layout.
  const sizeAxis = (key: 'width' | 'height', axisDir: 'HORIZONTAL' | 'VERTICAL', fallback: number | null) => {
    const v = p[key];
    if (typeof v === 'number') {
      props[key] = Math.max(0.01, v);
      return 'FIXED' as const;
    }
    if (v === 'fill-parent' && dir && !absolute) {
      if (dir === axisDir) props.layoutGrow = 1;
      else props.layoutAlign = 'STRETCH';
      if (fallback !== null) props[key] = fallback;
      return 'FILL' as const;
    }
    if (fallback !== null) props[key] = fallback;
    return 'HUG' as const;
  };
  const strokes = widgetPaints(p.stroke);
  const strokeProps: Props = strokes.length ? { strokes, strokeWeight: num(p.strokeWidth, 1), strokeAlign: String(p.strokeAlign ?? 'inside').toUpperCase() as Props['strokeAlign'] } : {};
  let type: NodeType;
  switch (el.type) {
    case 'AutoLayout': {
      type = 'FRAME';
      const d = p.direction === 'vertical' ? 'VERTICAL' : 'HORIZONTAL';
      const w = sizeAxis('width', 'HORIZONTAL', null);
      const h = sizeAxis('height', 'VERTICAL', null);
      const primary = d === 'HORIZONTAL' ? w : h;
      const counter = d === 'HORIZONTAL' ? h : w;
      const align = (v: unknown) => (v === 'center' ? 'CENTER' : v === 'end' ? 'MAX' : v === 'baseline' ? 'BASELINE' : 'MIN');
      const mainAlign = d === 'HORIZONTAL' ? p.horizontalAlignItems : p.verticalAlignItems;
      const crossAlign = d === 'HORIZONTAL' ? p.verticalAlignItems : p.horizontalAlignItems;
      Object.assign(props, {
        layoutMode: d,
        itemSpacing: typeof p.spacing === 'number' ? p.spacing : 0,
        primaryAxisAlignItems: p.spacing === 'auto' ? 'SPACE_BETWEEN' : align(mainAlign) === 'BASELINE' ? 'MIN' : align(mainAlign),
        counterAxisAlignItems: align(crossAlign),
        primaryAxisSizingMode: primary === 'HUG' ? 'AUTO' : 'FIXED',
        counterAxisSizingMode: counter === 'HUG' ? 'AUTO' : 'FIXED',
        ...padding(p.padding),
        ...(p.wrap === true ? { layoutWrap: 'WRAP' } : {}),
        fills: widgetPaints(p.fill),
        clipsContent: p.overflow === 'hidden' || p.overflow === 'scroll',
        ...corners(p.cornerRadius),
        ...strokeProps,
      } as Props);
      break;
    }
    case 'Frame':
      type = 'FRAME';
      sizeAxis('width', 'HORIZONTAL', 100);
      sizeAxis('height', 'VERTICAL', 100);
      Object.assign(props, { fills: widgetPaints(p.fill), clipsContent: p.overflow !== 'visible', ...corners(p.cornerRadius), ...strokeProps });
      break;
    case 'Rectangle':
      type = 'RECTANGLE';
      sizeAxis('width', 'HORIZONTAL', 100);
      sizeAxis('height', 'VERTICAL', 100);
      Object.assign(props, { fills: widgetPaints(p.fill), ...corners(p.cornerRadius), ...strokeProps });
      break;
    case 'Ellipse':
      type = 'ELLIPSE';
      sizeAxis('width', 'HORIZONTAL', 100);
      sizeAxis('height', 'VERTICAL', 100);
      Object.assign(props, { fills: widgetPaints(p.fill), ...strokeProps });
      break;
    case 'Line':
      type = 'LINE';
      props.width = num(p.length, 100);
      props.height = 0;
      Object.assign(props, { strokes: widgetPaints(p.stroke ?? '#000000'), strokeWeight: num(p.strokeWidth, 1) });
      break;
    case 'Text':
    case 'Input': {
      type = 'TEXT';
      const input = el.type === 'Input';
      const value = input ? String(p.value ?? '') : textOf(el);
      const placeholder = input && !value;
      if (input) props.widgetInput = value;
      const w = sizeAxis('width', 'HORIZONTAL', null);
      const lh = p.lineHeight;
      const ls = p.letterSpacing;
      const textProps = (input ? (p.inputFrameProps as Record<string, unknown> | undefined) : undefined) ?? {};
      void textProps;
      Object.assign(props, {
        characters: placeholder ? String(p.placeholder ?? '') : value,
        fontSize: num(p.fontSize, input ? 14 : 16),
        fontName: { family: typeof p.fontFamily === 'string' ? p.fontFamily : 'Inter', style: fontStyle(p.fontWeight, p.italic) },
        fills: placeholder ? [{ type: 'SOLID', color: { r: 0.6, g: 0.6, b: 0.6 } }] : widgetPaints(p.fill ?? '#000000'),
        textAlignHorizontal: p.horizontalAlignText === 'center' ? 'CENTER' : p.horizontalAlignText === 'right' ? 'RIGHT' : p.horizontalAlignText === 'justified' ? 'JUSTIFIED' : 'LEFT',
        textAutoResize: w === 'HUG' ? 'WIDTH_AND_HEIGHT' : 'HEIGHT',
        ...(typeof lh === 'number' ? { lineHeight: { unit: 'PIXELS', value: lh } } : typeof lh === 'string' && lh.endsWith('%') ? { lineHeight: { unit: 'PERCENT', value: parseFloat(lh) } } : {}),
        ...(typeof ls === 'number' ? { letterSpacing: { unit: 'PIXELS', value: ls } } : typeof ls === 'string' && ls.endsWith('%') ? { letterSpacing: { unit: 'PERCENT', value: parseFloat(ls) } } : {}),
        ...(p.textCase ? { textCase: ({ upper: 'UPPER', lower: 'LOWER', title: 'TITLE', 'small-caps': 'SMALL_CAPS' } as Record<string, string>)[String(p.textCase)] ?? 'ORIGINAL' } : {}),
        ...(p.textDecoration ? { textDecoration: p.textDecoration === 'underline' ? 'UNDERLINE' : p.textDecoration === 'strikethrough' ? 'STRIKETHROUGH' : 'NONE' } : {}),
      } as Props);
      break;
    }
    case 'Image': {
      type = 'RECTANGLE';
      sizeAxis('width', 'HORIZONTAL', 100);
      sizeAxis('height', 'VERTICAL', 100);
      const src = String(p.src ?? '');
      const bytes = src.startsWith('data:') ? base64Bytes(src) : null;
      const hash = bytes ? helpers.image(bytes) : null;
      Object.assign(props, { fills: hash ? [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: hash }] : [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }], ...corners(p.cornerRadius) });
      break;
    }
    case 'SVG': {
      const id = helpers.svg(String(p.src ?? ''), parent);
      if (!id) return;
      const set: Props = { name: props.name, transform: props.transform };
      if (props.widgetHandler) set.widgetHandler = props.widgetHandler;
      if (props.layoutPositioning) set.layoutPositioning = props.layoutPositioning;
      doc.set(id, set);
      return;
    }
    default:
      return;
  }
  const id = doc.create(type, parent, props);
  if (type === 'FRAME') {
    const childDir: Dir = el.type === 'AutoLayout' ? (props.layoutMode as Dir) : null;
    for (const c of el.children) if (typeof c === 'object') build(doc, c, id, childDir, helpers);
  }
}
