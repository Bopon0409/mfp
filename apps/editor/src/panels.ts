// Panels: pages, layers, selection properties. Plain DOM, redrawn once per frame.

import { DEFAULT_PERSPECTIVE, FLAT_DISTORT, has3d, invert, multiply, rotationOf, skewOf, withRotation, withRotationKeepShape, withSkew, type Document, type Effect, type Op, type ExportSetting, type GridTrackSize, type LayoutGrid, type LetterSpacing, type LineHeight, type Matrix, type NodeType, type Paint, type Props, type RGBA, type StrokeCap, type BlendMode } from '@mfp/core';
import type { Editor } from './editor.ts';
import { layerLocked } from '@mfp/core';
import { scrubPointerDelta, valueScrubber } from './value-scrub.ts';
import { numberInText } from './number-drag.ts';
import { canFill, canHug, canLimit, enableAutoLayout, getSizing, gridLayout, isAutoLayout, LIMIT_KEYS, percentKey, percentOfParent, recolorUses, resizeWithConstraints, scaleTree, selectionColors, setLimit, setPercent, setSizing, sizingProps, type Axis, type SelectionColor, type SizingMode } from '@mfp/editing';
import { prototypeSections } from './prototype-panel.ts';
import { constraintLabel, defaultQuality, isLossy, isRaster, parseConstraint } from './export.ts';
import { bindingSection, combineSection, componentSection, instanceSection } from './component-panel.ts';
import { appliedStyleRow, localStylesSection, openStylePicker, styleEditorHead, stylePreview } from './styles-ui.ts';
import { popover } from './dom.ts';
import { bindFields, boundOf, modeRows, openVariablePicker, openVariablesWindow, variablePill } from './variables-ui.ts';
import { formatLength, pxPerUnit, UNIT_LABEL, type DocumentUnits } from '@mfp/core';
import { applyStyle, bindPaintVariable, evaluateNumberInput, paintWithGradient, localCollections, localStyles, localVariables, paintWithVariable, ROOT_FONT_SIZE, type VariableType } from '@mfp/core';
import type { BlurEffect, DecorationThickness, FontVariation, StyleField } from '@mfp/core';
import { ICON, NODE_ICON, NODE_LABEL, layerIcon } from './icons.ts';
import { showMenu, showMenuAt, type MenuEntry } from './menu.ts';
import { align, canAlign, distribute, keyOf, tidyUp, type AlignMode } from './arrange.ts';
import { BLEND_MODES as PAINT_BLENDS, beginRefresh, endRefresh, openColorEditor, openPaintEditor, paintEditorKey, refreshEditor } from './paint-editor.ts';
import { SHADER_EFFECT_PRESETS } from '@mfp/renderer';
import type { GradientTarget } from './gradient-handles.ts';
import type { TextEditing } from './text-edit.ts';
import { effectiveStyle, MIXED, rangeValue, textSegments, type NodeProps, type TextStyle, type TextStyleKey } from '@mfp/core';
import { restyleText, styleWeight, userPages, type EffectiveTextStyle } from '@mfp/core';
import { openFontPicker } from './font-picker.ts';
import { WIDTH_PROFILES } from './width-tool.ts';
import { BRUSHES, SHADER_PRESETS, isLottieBytes, textFonts, type FontAxis } from '@mfp/renderer';
import { isModelBytes } from './model3d.ts';
import { labelColor } from './layer-labels.ts';
import { freeformCss } from './freeform.ts';
import { textStats, convertContainer, resizeToFit, type ContainerKind } from '@mfp/editing';
import { paintLibrary } from './paint-library.ts';
import { textLength } from '@mfp/core';
import { allFolders, cleanFolder, dissolvedFolder, folderName, inFolder, pageTree, parentFolder, renamedFolder } from './page-folders.ts';
import { t } from './i18n/index.ts';

/** Layer blend modes (names as in graphics editors). */
const BLEND_MODES: [string, string][] = [
  ['PASS_THROUGH', 'Сквозной'],
  ['NORMAL', 'Обычный'],
  ['DARKEN', 'Затемнение'],
  ['MULTIPLY', 'Умножение'],
  ['COLOR_BURN', 'Затемнение основы'],
  ['LIGHTEN', 'Замена светлым'],
  ['SCREEN', 'Экран'],
  ['COLOR_DODGE', 'Осветление основы'],
  ['OVERLAY', 'Перекрытие'],
  ['SOFT_LIGHT', 'Мягкий свет'],
  ['HARD_LIGHT', 'Жёсткий свет'],
  ['DIFFERENCE', 'Разница'],
  ['EXCLUSION', 'Исключение'],
  ['HUE', 'Цветовой тон'],
  ['SATURATION', 'Насыщенность'],
  ['COLOR', 'Цветность'],
  ['LUMINOSITY', 'Яркость'],
];

const ALIGN: [AlignMode, keyof typeof ICON, string][] = [
  ['left', 'alignLeft', 'По левому краю (Alt+A)'],
  ['hcenter', 'alignHCenter', 'По центру по горизонтали (Alt+H)'],
  ['right', 'alignRight', 'По правому краю (Alt+D)'],
  ['top', 'alignTop', 'По верхнему краю (Alt+W)'],
  ['vcenter', 'alignVCenter', 'По центру по вертикали (Alt+V)'],
  ['bottom', 'alignBottom', 'По нижнему краю (Alt+S)'],
];

const $ = (id: string) => document.getElementById(id)!;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' || k === 'role' || k.startsWith('data-') || k.startsWith('aria-')) el.setAttribute(k, String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  el.append(...children);
  return el;
};

/** Frame presets (tool F): device screen and format sizes. */
export const FRAME_PRESETS: [string, [string, number, number][]][] = [
  [
    'Телефоны',
    [
      ['iPhone 16', 393, 852],
      ['iPhone 16 Pro Max', 440, 956],
      ['iPhone SE', 375, 667],
      ['Android', 360, 800],
      ['Android большой', 412, 915],
    ],
  ],
  [
    'Планшеты',
    [
      ['iPad mini', 744, 1133],
      ['iPad Pro 11″', 834, 1194],
      ['iPad Pro 13″', 1032, 1376],
      ['Android-планшет', 800, 1280],
    ],
  ],
  [
    'Десктоп',
    [
      ['Desktop', 1440, 1024],
      ['MacBook Air', 1280, 832],
      ['MacBook Pro 14″', 1512, 982],
      ['Full HD', 1920, 1080],
    ],
  ],
  [
    'Соцсети и печать',
    [
      ['Пост 1:1', 1080, 1080],
      ['Сторис 9:16', 1080, 1920],
      ['Обложка 16:9', 1920, 1080],
      ['A4', 595, 842],
    ],
  ],
];

/** List with the i-th element replaced. */
function replace<T>(list: readonly T[], i: number, item: T): T[] {
  const out = [...list];
  out[i] = item;
  return out;
}

/** Per-corner radius properties. */
const CORNERS = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'] as const;

/** Layer row height (as for .row in index.html) and the number of extra rows above and below the visible ones. */
const ROW_H = 32;
const OVERSCAN = 10;

/** An edit after which layer and page rows may change: tree, name, visibility, lock. */
function treeOp(o: Op): boolean {
  if (o.op === 'set') return 'name' in o.props || 'visible' in o.props || 'locked' in o.props || 'internal' in o.props || 'pageFolder' in o.props || 'labelColor' in o.props || 'pageProtection' in o.props;
  return o.op !== 'blob';
}

/** Divider page: a name made only of hyphens or dashes. */
const isDivider = (name: string) => /^[-–—]{3,}$/.test(name.trim());

/** An element containing our own SVG icon (string from icons.ts) or text. */
const svgEl = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown>, content: string) => {
  const el = h(tag, props);
  if (content.startsWith('<svg')) el.innerHTML = content;
  else el.textContent = content;
  return el;
};

const hex = (c: { r: number; g: number; b: number }) =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const parseHex = (s: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};
const fmt = (v: number) => String(Math.round(v * 100) / 100);

/** Variable font axis labels (others shown by tag). */
const AXIS_NAMES: Record<string, string> = { wght: 'Насыщенность', wdth: 'Ширина', slnt: 'Наклон', ital: 'Курсив', opsz: 'Оптич. кегль', GRAD: 'Градация' };

/** Axes with a new value for one of them (order of the rest unchanged). */
const withAxis = (list: FontVariation[], axis: string, value: number): FontVariation[] =>
  list.some((v) => v.axis === axis) ? list.map((v) => (v.axis === axis ? { axis, value } : v)) : [...list, { axis, value }];

/** Line thickness or offset: “Auto”, pixels or % of font size. */
const lengthText = (v: DecorationThickness | null) => (!v ? 'Разные' : v.unit === 'AUTO' ? 'Авто' : v.unit === 'PIXELS' ? fmt(v.value) : `${fmt(v.value)}%`);
function parseLength(text: string): DecorationThickness | null {
  const t = text.trim().toLowerCase();
  if (!t || t === 'авто' || t === 'auto') return { unit: 'AUTO' };
  const m = t.match(/^(-?\d+(?:[.,]\d+)?)\s*(%|px)?$/);
  if (!m) return null;
  const value = Number(m[1]!.replace(',', '.'));
  return m[2] === '%' ? { unit: 'PERCENT', value } : { unit: 'PIXELS', value };
}

const CHECKER = 'repeating-conic-gradient(#999 0 25%,#ddd 0 50%) 0 0/8px 8px';
/** Pattern swatch: dots. */
export const PATTERN_SWATCH = 'radial-gradient(circle,#666 30%,transparent 34%) 0 0/6px 6px,#ddd';
/** Shader swatch. */
export const SHADER_SWATCH = 'conic-gradient(from 45deg,#ff6b4a,#ffc24b,#2dd4bf,#6b5bff,#ff6b4a)';
const rgba = (c: { r: number; g: number; b: number }, a = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${Math.round(a * 1000) / 1000})`;

/** Paint swatch background: color, gradient (approximate, from stops) or image (checkerboard). */
function swatchCss(p: Paint | RGBA): string {
  if (!('type' in p)) return p.a < 1 ? `linear-gradient(${rgba(p, p.a)},${rgba(p, p.a)}),${CHECKER}` : rgba(p);
  if (p.type === 'SOLID') return (p.opacity ?? 1) < 1 ? `linear-gradient(${rgba(p.color, p.opacity)},${rgba(p.color, p.opacity)}),${CHECKER}` : rgba(p.color);
  if (p.type === 'IMAGE' || p.type === 'VIDEO' || p.type === 'LOTTIE' || p.type === 'MODEL3D') return CHECKER;
  if (p.type === 'PATTERN') return PATTERN_SWATCH;
  if (p.type === 'SHADER') return SHADER_SWATCH;
  if (p.type === 'GRADIENT_FREEFORM') return `${freeformCss(p)},${CHECKER}`;
  const stops = [...p.gradientStops].sort((a, b) => a.position - b.position).map((s) => `${rgba(s.color, s.color.a)} ${Math.round(s.position * 1000) / 10}%`).join(',');
  const g = p.type === 'GRADIENT_LINEAR' ? `linear-gradient(90deg,${stops})` : p.type === 'GRADIENT_ANGULAR' ? `conic-gradient(from 90deg,${stops})` : `radial-gradient(circle,${stops})`;
  return `${g},${CHECKER}`;
}

const PAINT_LABEL: Record<Paint['type'], string> = {
  SOLID: 'Сплошная',
  GRADIENT_LINEAR: 'Линейный',
  GRADIENT_RADIAL: 'Радиальный',
  GRADIENT_ANGULAR: 'Угловой',
  GRADIENT_FREEFORM: 'Свободный',
  GRADIENT_DIAMOND: 'Ромб',
  IMAGE: 'Картинка',
  VIDEO: 'Видео',
  LOTTIE: 'Lottie',
  MODEL3D: '3D-модель',
  PATTERN: 'Узор',
  SHADER: 'Шейдер',
};

const EFFECT_TYPES: [Effect['type'], string][] = [
  ['DROP_SHADOW', 'Тень'],
  ['INNER_SHADOW', 'Внутренняя тень'],
  ['LAYER_BLUR', 'Размытие слоя'],
  ['BACKGROUND_BLUR', 'Размытие фона'],
  ['NOISE', 'Шум'],
  ['TEXTURE', 'Текстура'],
  ['GLASS', 'Стекло'],
  ['SHADER', 'Шейдер'],
];

/** Default effect (shadow 0, 4, blur 4, black 25%). */
function defaultEffect(type: Effect['type']): Effect {
  if (type === 'UNSUPPORTED_FIGMA') throw new Error('Неподдерживаемый эффект можно только импортировать');
  if (type === 'SHADER') return { type, code: SHADER_EFFECT_PRESETS[0]!.code, preset: SHADER_EFFECT_PRESETS[0]!.id, visible: true };
  if (type === 'DROP_SHADOW' || type === 'INNER_SHADOW') {
    return { type, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, blendMode: 'NORMAL' };
  }
  if (type === 'NOISE') return { type, noiseType: 'MONOTONE', color: { r: 0, g: 0, b: 0, a: 0.25 }, noiseSize: 1, density: 0.5, blendMode: 'NORMAL', visible: true };
  if (type === 'TEXTURE') return { type, noiseSize: 4, radius: 4, clipToShape: true, visible: true };
  if (type === 'GLASS') return { type, lightIntensity: 0.5, lightAngle: -45, refraction: 0.8, depth: 20, dispersion: 0.5, radius: 4, visible: true };
  return { type, radius: 4, visible: true };
}

/** Effect strength when switching type (blur, shadow, texture, glass — radius). */
const effectRadius = (e: Effect) => ('radius' in e ? e.radius : 4);

/** Popular families (Google Fonts via Fontsource; most have Cyrillic). */
export const FONT_FAMILIES: readonly string[] = [
  'Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Manrope', 'Golos Text', 'Onest', 'Rubik', 'Nunito', 'Raleway',
  'Lato', 'PT Sans', 'PT Serif', 'Noto Sans', 'Noto Serif', 'Source Sans 3', 'IBM Plex Sans', 'Fira Sans',
  'Ubuntu', 'Exo 2', 'Comfortaa', 'Playfair Display', 'Merriweather', 'Lora', 'Oswald', 'Unbounded',
  'JetBrains Mono', 'Roboto Mono', 'Fira Code',
];
const WEIGHTS = ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black'];
const STYLES = [...WEIGHTS, ...WEIGHTS.map((w) => (w === 'Regular' ? 'Italic' : `${w} Italic`))];

/** Alignment icons: three lines of different lengths. */
const lines = (rows: [number, number][]) =>
  `<svg width="14" height="12" viewBox="0 0 14 12">${rows.map(([x, w], i) => `<rect x="${x}" y="${i * 4 + 1}" width="${w}" height="1.6" rx=".8" fill="currentColor"/>`).join('')}</svg>`;
const ALIGN_ICONS = {
  LEFT: lines([[1, 12], [1, 8], [1, 10]]),
  CENTER: lines([[1, 12], [3, 8], [2, 10]]),
  RIGHT: lines([[1, 12], [5, 8], [3, 10]]),
  JUSTIFIED: lines([[1, 12], [1, 12], [1, 12]]),
};

const formatLineHeight = (lh: LineHeight) => (lh.unit === 'AUTO' ? 'Авто' : lh.unit === 'PERCENT' ? `${fmt(lh.value)}%` : fmt(lh.value));
const parseLineHeight = (s: string): LineHeight | null => {
  const t = s.trim().toLowerCase().replace(',', '.');
  if (!t || t === 'авто' || t === 'auto') return { unit: 'AUTO' };
  const v = parseFloat(t);
  if (!Number.isFinite(v) || v <= 0) return null;
  return t.endsWith('%') ? { unit: 'PERCENT', value: v } : { unit: 'PIXELS', value: v };
};
const formatLetterSpacing = (ls: LetterSpacing) => (ls.unit === 'PERCENT' ? `${fmt(ls.value)}%` : `${fmt(ls.value)}px`);
const parseLetterSpacing = (s: string, current: LetterSpacing): LetterSpacing | null => {
  const t = s.trim().toLowerCase().replace(',', '.');
  const v = parseFloat(t);
  if (!Number.isFinite(v)) return null;
  if (t.endsWith('%')) return { unit: 'PERCENT', value: v };
  if (t.endsWith('px')) return { unit: 'PIXELS', value: v };
  return { unit: current.unit, value: v };
};

export class Panels {
  /** Bundled fonts (work without internet). */
  bundledFonts: string[] = [];
  private lastIconClick: { id: string; at: number } | null = null;
  private ed: Editor;
  private expanded = new Set<string>();
  /** Auto layout padding shown per side (toggle in the panel). */
  private paddingSides = false;
  /** Advanced stroke settings (joins, miter) shown. */
  private strokeMore = false;
  /** Page search (icon next to “Pages”). */
  private pageQuery = '';
  /** “Preview” under the export button is expanded. */
  private exportPreview = false;
  private previewImg: { id: string; img: HTMLImageElement; at: number } | null = null;
  /** Layer header actions (code, component, “⋯” — layer menu); set by main. */
  headerActions: { devMode?: () => void; createComponent?: () => void; menu?: () => MenuEntry[] } = {};
  /** Auto layout settings (version, baseline, stacking order, stroke in layout). */
  private layoutMore = false;
  /** The “Corner radius” popup (individual corners and smoothing) is open. */
  private cornersMore = false;
  /** Layout guide whose parameters are open in a popup. */
  private guideOpen: number | null = null;
  /** Open section settings popups: key → popup (content updates on redraw). */
  private setPops = new Map<string, { box: HTMLElement; close: () => void }>();
  private setPopClosed = new Map<string, number>();
  private setPopSel = '';
  /** Effects with expanded parameters — for this selection. */
  private effectsOpen = new Set<number>();
  /** Open effect parameters popup: effect index, selection, popup. */
  private effectPop: { index: number; key: string; box: HTMLElement; close: () => void } | null = null;
  /** Export rows with the suffix field open (“File name suffix” item in “⋯”). */
  private exportSuffixOpen = new Set<number>();
  private effectsOpenFor = '';
  /** On-screen order of layer rows and the row from which a Shift+click range is counted. */
  private rowOrder: string[] = [];
  private anchorRow: string | null = null;
  /**
   * Layer tree rows top to bottom (expanded branches) and row index by id. The DOM holds only the
   * visible ones plus a margin around them (shown): a page can have tens of thousands of layers.
   */
  private flat: { id: string; depth: number }[] = [];
  private rowIndex = new Map<string, number>();
  private shown: [number, number] = [0, 0];
  /** The row Tab lands on (selected or first). */
  private tabRow: string | null = null;
  private rowsScheduled = false;
  /** What to redraw in the next frame besides properties: page list and layer tree. */
  private pagesDirty = true;
  private layersDirty = true;
  /** The selection for which layer rows are drawn. */
  private selectionKey = '';
  /** Layer or page row to refocus after a redraw (keyboard). */
  private focusRow: string | null = null;
  /** Selection reveal must not move keyboard focus away from the canvas/inputs. */
  private revealRow: string | null = null;
  private focusPage: string | null = null;
  /** Right-click on a layer: show the context menu (wired up by main.ts). */
  onContextMenu: ((x: number, y: number) => void) | null = null;
  /** “Move to another file” for a page (wired up by main.ts). */
  onMovePage: ((pageId: string) => void) | null = null;
  /** “Copy link to page” (for files on the server). */
  onCopyLink: ((id: string) => void) | null = null;
  /** Page protection (file on the server): whether it is available here, and the protection dialog. */
  pageProtection: { available(): boolean; open(pageId: string): void } | null = null;
  private scheduled = false;
  private editingName: string | null = null;
  /** Collapsed page folders (per session) and the folder whose name is being edited. */
  private collapsedFolders = new Set<string>();
  private editingFolder: string | null = null;
  /** Export the selection (wired up by main.ts). */
  onExport: (ids: string[]) => void = () => {};
  /** Dragging in the layers panel: what is being dragged and where it will drop. */
  private drag: { ids: string[]; y0: number; active: boolean; drop: { anchor: string; zone: 'above' | 'below' | 'into' } | null } | null = null;
  /** A drag has just ended — ignore the click on the row. */
  private dragged = false;
  /** Text editing on the canvas: the “Text” panel shows and changes the styling of the text selection. */
  textEditing: TextEditing | null = null;
  /** Advanced text settings (lists, paragraphs, trimming, OpenType) shown. */
  private textMore = false;
  /** A gradient is open in the paint popup — handles on the canvas (wired up by main.ts). */
  onGradient: ((t: GradientTarget | null) => void) | null = null;
  /** Crop a paint image on the canvas (layer, paint). */
  onCrop: ((t: { id: string; key: 'fills' | 'strokes'; index: number }) => void) | null = null;
  /** Pattern: picking the source layer on the canvas; targets — layers with this pattern (they and their ancestors can't be picked). */
  onPatternPick: ((targets: string[]) => Promise<string | null>) | null = null;
  /** Message to the user (wired up by main.ts). */
  notify: (message: string, kind?: 'info' | 'error') => void = () => {};
  /** Editing a style in the panel (nothing selected) and the selection to return to. */
  private editingStyle: string | null = null;
  private styleReturn: string[] = [];
  /** Request the computer's fonts (wired up by main.ts). */
  onLocalFonts: (() => void) | null = null;
  /** A number field is being scrubbed: the panel is not rebuilt, only values are updated. */
  scrubbing = false;
  /** Right panel tab: “Design” or “Prototype” (Shift+E). */
  tab: 'design' | 'prototype' = 'design';
  /** Tab switched (the canvas shows prototype connections — wired up by main.ts). */
  onTab: ((tab: 'design' | 'prototype') => void) | null = null;
  /** Present the prototype from a screen (wired up by main.ts). */
  onPresent: (start: string | null) => void = () => {};
  /** Path editing section (point type) — in vector edit mode (wired up by main.ts). */
  vectorSection: (() => HTMLElement | null) | null = null;
  /** “Brush” tool panel (wired up by main.ts). */
  brushSection: (() => HTMLElement) | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    // Layer and page rows are rebuilt only after edits to the tree, names, visibility or lock:
    // dragging on the canvas changes position, and there is no need to rebuild a list of
    // thousands of rows at every step (that was what caused stutter in large files).
    ed.onDocument.push((ops) => {
      if (ops.some(treeOp)) this.pagesDirty = this.layersDirty = true;
      this.schedule(false);
    });
    $('layers').addEventListener('scroll', () => this.scheduleRows());
    // A number in a content-width field (“100%”): clicking the empty part of the field also goes to the number.
    $('properties').addEventListener('mousedown', (e) => {
      const t = e.target as HTMLElement;
      if (!t.classList.contains('field') && !t.classList.contains('unit')) return;
      const input = t.closest('.field')?.querySelector<HTMLInputElement>(':scope > input');
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    });
    ed.onSelection.push(() => {
      // The editor also reports edits to selected layers (at every drag step) — the layer rows
      // need rebuilding only if the selection itself changed.
      const key = ed.selection.join(',');
      if (key === this.selectionKey) return this.schedule(false);
      const previous = new Set(this.selectionKey.split(','));
      this.revealRow = ed.selection.find((id) => !previous.has(id)) ?? ed.selection[0] ?? null;
      this.selectionKey = key;
      // Expand the ancestors of the selected layer so it is visible in the layers panel.
      for (const id of ed.selection) for (let p = ed.doc.parent(id); p && p !== ed.pageId; p = ed.doc.parent(p)) this.expanded.add(p);
      this.layersDirty = true;
      this.schedule(false);
    });
    ed.onPage.push(() => this.schedule());
    $('add-page').innerHTML = ICON.plus;
    // Page search: a field above the list, filter by name; Esc or a second click closes it.
    $('page-search').innerHTML = ICON.search;
    $('page-search').addEventListener('click', () => {
      const old = document.querySelector('.pages-search');
      const close = () => {
        document.querySelector('.pages-search')?.remove();
        $('page-search').classList.remove('on');
        this.pageQuery = '';
        this.pagesDirty = true;
        this.schedule(false);
      };
      if (old) return close();
      const input = h('input', { placeholder: 'Поиск страниц', 'aria-label': 'Поиск страниц' }) as HTMLInputElement;
      input.addEventListener('input', () => {
        this.pageQuery = input.value.trim().toLowerCase();
        this.pagesDirty = true;
        this.schedule(false);
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
      });
      $('pages').before(h('div', { class: 'pages-search' }, input));
      $('page-search').classList.add('on');
      input.focus();
    });
    $('add-page').addEventListener('click', () => {
      const n = userPages(ed.doc).length + 1;
      const id = ed.doc.create('PAGE', ed.doc.root, { name: t('Страница {0}', n) });
      ed.setPage(id);
    });
    for (const tab of ['design', 'prototype'] as const) $(`tab-${tab}`).addEventListener('click', () => this.setTab(tab));
    this.schedule();
  }

  setTab(tab: 'design' | 'prototype') {
    if (this.tab === tab) return;
    this.tab = tab;
    for (const t of ['design', 'prototype'] as const) {
      $(`tab-${t}`).classList.toggle('on', t === tab);
      $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
    }
    this.onTab?.(tab);
    this.schedule();
  }

  /** Redraw the panels in the next frame; all = false — properties only (and whatever is already pending). */
  schedule(all = true) {
    if (all) this.pagesDirty = this.layersDirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      // During a drag only the values change: pages and layers stay the same.
      if (!this.scrubbing) {
        if (this.pagesDirty) this.renderPages();
        if (this.layersDirty) this.renderLayers();
      }
      this.renderProperties();
    });
  }

  // ---------- Layer dragging ----------

  private dragStart(e: PointerEvent, id: string) {
    if (e.button !== 0 || this.ed.devMode || (e.target as HTMLElement).closest('button, .twisty, input')) return;
    const ed = this.ed;
    const ids = ed.selection.includes(id) ? [...ed.selection] : [id];
    if (ids.some(s => layerLocked(ed.doc, s))) return;
    this.drag = { ids, y0: e.clientY, active: false, drop: null };
    const move = (ev: PointerEvent) => this.dragMove(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.dragEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private dragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.active && Math.abs(e.clientY - d.y0) < 4) return;
    d.active = true;
    const doc = this.ed.doc;
    const row = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('#layers .row[data-id]');
    const indicator = this.indicator();
    d.drop = null;
    indicator.style.display = 'none';
    for (const r of document.querySelectorAll('#layers .row.drop-into')) r.classList.remove('drop-into');
    if (!row) return;
    const anchor = row.dataset.id!;
    // A layer cannot be placed inside itself.
    for (let p: string | null = anchor; p; p = doc.parent(p)) if (d.ids.includes(p)) return;
    const rect = row.getBoundingClientRect();
    const f = (e.clientY - rect.top) / rect.height;
    const container = ['FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'BOOLEAN_OPERATION'].includes(doc.type(anchor)!);
    const zone = container && f > 0.25 && f < 0.75 ? 'into' : f < 0.5 ? 'above' : 'below';
    d.drop = { anchor, zone };
    if (zone === 'into') row.classList.add('drop-into');
    else {
      const host = $('layers').getBoundingClientRect();
      indicator.style.display = 'block';
      indicator.style.top = `${(zone === 'above' ? rect.top : rect.bottom) - host.top + $('layers').scrollTop - 1}px`;
      indicator.style.left = `${parseFloat(row.style.paddingLeft) || 0}px`;
    }
  }

  private indicator(): HTMLElement {
    let el = document.getElementById('layers-drop');
    if (!el) {
      el = h('div', { id: 'layers-drop' });
      $('layers').append(el);
    }
    return el;
  }

  private dragEnd() {
    const d = this.drag;
    this.drag = null;
    this.indicator().style.display = 'none';
    for (const r of document.querySelectorAll('#layers .row.drop-into')) r.classList.remove('drop-into');
    if (!d?.active || !d.drop) return;
    this.dragged = true;
    setTimeout(() => (this.dragged = false));
    const { ed } = this;
    const doc = ed.doc;
    const { anchor, zone } = d.drop;
    const parent = zone === 'into' ? anchor : doc.parent(anchor)!;
    const moving = new Set(d.ids);
    // Only the “topmost” of the dragged layers (children of a selected parent move with it).
    const ids = d.ids.filter((id) => {
      for (let p = doc.parent(id); p; p = doc.parent(p)) if (moving.has(p)) return false;
      return doc.has(id);
    });
    // Order by layer (bottom first) to preserve relative stacking.
    const order = new Map<string, number>();
    let k = 0;
    for (const id of doc.descendants(ed.pageId)) order.set(id, k++);
    ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    // In the panel the top layer comes first: “above” a row = higher in stacking = later in the children list.
    const rest = doc.children(parent).filter((c) => !moving.has(c));
    const at = zone === 'into' ? rest.length : rest.indexOf(anchor) + (zone === 'above' ? 1 : 0);
    const pw = (parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(parent)) as Matrix;
    doc.transact(() => {
      const worlds = new Map(ids.map((id) => [id, ed.worldMatrix(id) as Matrix]));
      for (const id of ids) doc.move(id, parent);
      ids.forEach((id, i) => {
        doc.move(id, parent, at + i);
        doc.set(id, { transform: multiply(invert(pw), worlds.get(id)!) });
      });
    });
    if (zone === 'into') this.expanded.add(anchor);
    ed.select(ids);
  }

  // ---------- Pages ----------

  private renderPages() {
    const { ed } = this;
    this.pagesDirty = false;
    const list = $('pages');
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#pages .row')?.dataset.id ?? null;
    const target = this.focusPage ?? focused ?? ed.pageId;
    this.focusPage = null;
    const doc = ed.doc;
    const folderOf = (p: string) => cleanFolder(doc.get(p, 'pageFolder'));
    // Folders (including nested ones — path separated by “/”) as header rows where their first page is.
    const all = userPages(doc);
    const q = this.pageQuery;
    const rows = pageTree(
      (q ? all.filter((id) => (doc.get(id, 'name') ?? '').toLowerCase().includes(q)) : all).map((id) => ({ id, folder: folderOf(id) })),
      this.collapsedFolders,
    );
    /** Move page src next to page at (before or after) — and into its folder. */
    const dropPage = (src: string, at: string, after: boolean) => {
      const rest = all.filter((p) => p !== src);
      doc.transact(() => {
        doc.move(src, doc.root, rest.indexOf(at) + (after ? 1 : 0));
        doc.set(src, { pageFolder: folderOf(at) || undefined });
      });
    };
    /** Assign the subtree's pages a new folder by the rule; one undo step. */
    const remap = (pages: string[], fn: (f: string) => string) =>
      doc.transact(() => {
        for (const p of pages) doc.set(p, { pageFolder: fn(folderOf(p)) || undefined });
      });
    const folderRow = (folder: string, depth: number, pages: string[], open: boolean) => {
      const toggle = () => {
        if (open) this.collapsedFolders.add(folder);
        else this.collapsedFolders.delete(folder);
        this.pagesDirty = true;
        this.schedule(false);
      };
      // New name — inside the same parent folder; “/” in the name nests deeper.
      const rename = (name: string) => {
        const next = cleanFolder(`${parentFolder(folder)}/${name}`);
        this.editingFolder = null;
        if (cleanFolder(name) && next !== folder) remap(pages, (f) => renamedFolder(f, folder, next));
        this.pagesDirty = true;
        this.schedule(false);
      };
      /** Nest this folder in folder target ('' — to the top level). */
      const nestInto = (target: string) => {
        if (inFolder(target, folder)) return;
        remap(pages, (f) => renamedFolder(f, folder, cleanFolder(`${target}/${folderName(folder)}`)));
      };
      let label: HTMLElement;
      if (this.editingFolder === folder) {
        const input = h('input', { class: 'rename', value: folderName(folder) }) as HTMLInputElement;
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') rename(input.value);
          if (e.key === 'Escape') rename(folderName(folder));
        });
        input.addEventListener('blur', () => rename(input.value));
        setTimeout(() => (input.focus(), input.select()), 0);
        label = input;
      } else label = h('span', { class: 'name' }, folderName(folder));
      const row = h(
        'div',
        {
          class: `row page-row page-folder${!open && pages.includes(ed.pageId) ? ' has-current' : ''}`,
          style: `padding-left:${12 + depth * 16}px`,
          'data-folder': folder,
          role: 'treeitem',
          'aria-level': depth + 1,
          'aria-expanded': String(open),
          title: `Папка «${folder}»: ${pages.length} стр. Перетащите на другую папку — вложить`,
          draggable: true,
          onclick: (e: MouseEvent) => !(e.target as HTMLElement).closest('input') && toggle(),
          ondblclick: () => {
            this.editingFolder = folder;
            this.pagesDirty = true;
            this.schedule(false);
          },
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            const parent = parentFolder(folder);
            showMenuAt(e.clientX, e.clientY, [
              { label: 'Переименовать папку', run: () => ((this.editingFolder = folder), (this.pagesDirty = true), this.schedule(false)) },
              {
                label: 'Вложить в папку',
                submenu: allFolders(all.map(folderOf))
                  .filter((x) => !inFolder(x, folder) && x !== parent)
                  .map((x) => ({ label: x.replaceAll('/', ' / '), run: () => nestInto(x) })),
              },
              ...(parent ? [{ label: 'На уровень выше', run: () => nestInto(parentFolder(parent)) }] : []),
              { label: 'Распустить папку', run: () => remap(pages, (f) => dissolvedFolder(f, folder)) },
            ]);
          },
          ondragstart: (e: DragEvent) => {
            e.dataTransfer?.setData('text/x-mfp-folder', folder);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          },
          // A page goes into the folder (at the end of its pages); a folder goes inside this folder.
          ondragover: (e: DragEvent) => {
            const types = e.dataTransfer?.types ?? [];
            if (!types.includes('text/x-mfp-page') && !types.includes('text/x-mfp-folder')) return;
            e.preventDefault();
            row.classList.add('drop-into');
          },
          ondragleave: () => row.classList.remove('drop-into'),
          ondrop: (e: DragEvent) => {
            e.preventDefault();
            row.classList.remove('drop-into');
            const srcFolder = e.dataTransfer?.getData('text/x-mfp-folder');
            if (srcFolder) {
              if (inFolder(folder, srcFolder)) return;
              const moving = all.filter((p) => inFolder(folderOf(p), srcFolder));
              remap(moving, (f) => renamedFolder(f, srcFolder, cleanFolder(`${folder}/${folderName(srcFolder)}`)));
              return;
            }
            const src = e.dataTransfer?.getData('text/x-mfp-page');
            const last = pages[pages.length - 1];
            if (!src || !last || src === last) return src && doc.transact(() => doc.set(src, { pageFolder: folder }));
            dropPage(src, last, true);
            if (folderOf(src) !== folder) doc.transact(() => doc.set(src, { pageFolder: folder }));
          },
        },
        svgEl('span', { class: 'check fold' }, open ? ICON.chevronDown : ICON.chevronRight),
        svgEl('span', { class: 'folder-ic' }, ICON.folder),
        label,
        h('span', { class: 'count' }, String(pages.length)),
      );
      return row;
    };
    list.replaceChildren(
      ...rows.map((item) => {
        if (item.kind === 'folder') return folderRow(item.path, item.depth, item.pages, item.open);
        const id = item.id;
        const divider = isDivider(ed.doc.get(id, 'name') ?? '');
        const row = h(
          'div',
          {
            class: (divider ? 'row page-row page-divider' : `row page-row ${id === ed.pageId ? 'selected' : ''}`) + (folderOf(id) ? ' in-folder' : ''),
            style: item.depth ? `padding-left:${12 + item.depth * 16}px` : undefined,
            'data-id': id,
            role: divider ? 'separator' : 'option',
            'aria-selected': divider ? undefined : String(id === ed.pageId),
            tabIndex: divider ? undefined : id === target ? 0 : -1,
            onkeydown: (e: KeyboardEvent) => this.pageKey(e, id),
            draggable: true,
            onclick: () => !divider && id !== ed.pageId && ed.setPage(id),
            ondblclick: () => this.rename(id),
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              showMenuAt(e.clientX, e.clientY, this.pageMenu(id));
            },
            // Page order by dragging (a line shows where the page will go).
            ondragstart: (e: DragEvent) => {
              e.dataTransfer?.setData('text/x-mfp-page', id);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            },
            ondragover: (e: DragEvent) => {
              if (!e.dataTransfer?.types.includes('text/x-mfp-page')) return;
              e.preventDefault();
              const r = row.getBoundingClientRect();
              const after = e.clientY > r.top + r.height / 2;
              row.classList.toggle('drop-after', after);
              row.classList.toggle('drop-before', !after);
            },
            ondragleave: () => row.classList.remove('drop-after', 'drop-before'),
            ondrop: (e: DragEvent) => {
              e.preventDefault();
              const src = e.dataTransfer?.getData('text/x-mfp-page');
              const after = row.classList.contains('drop-after');
              row.classList.remove('drop-after', 'drop-before');
              if (!src || src === id) return;
              dropPage(src, id, after);
            },
          },
          divider ? h('span', { class: 'divider-line' }) : h('span', { class: 'name' }, this.nameNode(id)),
          ...(!divider && ed.doc.get(id, 'pageProtection') ? [svgEl('span', { class: 'page-lock', title: 'Защищённая страница: правят владелец файла и выбранные им люди' }, ICON.lock)] : []),
        );
        return row;
      }),
    );
    if (focused || target !== ed.pageId) list.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(target)}"]`)?.focus({ preventScroll: true });
  }

  /** Keys in the page list: arrows — adjacent page, Enter and Space — open, F2 — rename. */
  private pageKey(e: KeyboardEvent, id: string) {
    if (e.target !== e.currentTarget) return;
    const pages = userPages(this.ed.doc).filter((p) => !isDivider(this.ed.doc.get(p, 'name') ?? ''));
    const i = pages.indexOf(id);
    const go = (p: string | undefined) => {
      if (!p) return;
      this.focusPage = p;
      this.schedule();
    };
    if (e.key === 'ArrowDown') go(pages[i + 1]);
    else if (e.key === 'ArrowUp') go(pages[i - 1]);
    else if (e.key === 'Home') go(pages[0]);
    else if (e.key === 'End') go(pages[pages.length - 1]);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // The list takes the arrows (otherwise they would nudge the selection on the canvas).
    } else if (e.key === 'Enter' || e.key === ' ') {
      this.focusPage = id;
      if (id !== this.ed.pageId) this.ed.setPage(id);
      else this.schedule();
    } else if (e.key === 'F2') this.rename(id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Page menu (right-click): rename, duplicate, divider, delete. */
  private pageMenu(id: string): MenuEntry[] {
    const { ed } = this;
    const doc = ed.doc;
    const pages = userPages(doc);
    const folders = allFolders(pages.map((p) => doc.get(p, 'pageFolder') || ''));
    const current = cleanFolder(doc.get(id, 'pageFolder'));
    const toFolder = (folder: string | undefined) =>
      doc.transact(() => {
        // At the end of the folder's pages (so the folder isn't split in document order).
        const last = folder ? [...pages].reverse().find((p) => p !== id && inFolder(cleanFolder(doc.get(p, 'pageFolder')), folder)) : undefined;
        if (last) doc.move(id, doc.root, pages.filter((p) => p !== id).indexOf(last) + 1);
        doc.set(id, { pageFolder: folder });
      });
    return [
      { label: 'Переименовать', run: () => this.rename(id) },
      { label: 'Дублировать страницу', disabled: isDivider(doc.get(id, 'name') ?? ''), run: () => this.duplicatePage(id) },
      ...(this.onCopyLink && !isDivider(doc.get(id, 'name') ?? '') ? [{ label: 'Копировать ссылку на страницу', run: () => this.onCopyLink?.(id) }] : []),
      {
        label: 'В папку',
        submenu: [
          ...folders.filter((x) => x !== current).map((x) => ({ label: x.replaceAll('/', ' / '), run: () => toFolder(x) })),
          ...(folders.filter((x) => x !== current).length ? ['sep' as const] : []),
          {
            label: 'Новая папка',
            run: () => {
              const base = 'Папка';
              let name = base;
              for (let i = 2; folders.includes(name); i++) name = `${base} ${i}`;
              toFolder(name);
              this.editingFolder = name;
              this.pagesDirty = true;
              this.schedule(false);
            },
          },
          ...(current
            ? [
                {
                  label: 'Новая папка внутри',
                  run: () => {
                    let name = `${current}/Папка`;
                    for (let i = 2; folders.includes(name); i++) name = `${current}/Папка ${i}`;
                    toFolder(name);
                    this.editingFolder = name;
                    this.pagesDirty = true;
                    this.schedule(false);
                  },
                },
              ]
            : []),
          ...(current ? [{ label: 'Вынуть из папки', run: () => toFolder(parentFolder(current) || undefined) }] : []),
        ],
      },
      { label: 'Добавить разделитель ниже', run: () => doc.transact(() => doc.create('PAGE', doc.root, { name: '---' }, pages.indexOf(id) + 1)) },
      ...(this.onMovePage && !isDivider(doc.get(id, 'name') ?? '') ? [{ label: 'Перенести в другой файл…', run: () => this.onMovePage?.(id) }] : []),
      ...(this.pageProtection?.available() && !isDivider(doc.get(id, 'name') ?? '') ? [{ label: doc.get(id, 'pageProtection') ? 'Защита страницы…' : 'Защитить страницу…', run: () => this.pageProtection?.open(id) }] : []),
      'sep',
      { label: 'Удалить страницу', disabled: pages.length <= 1, run: () => this.deletePage(id) },
    ];
  }

  /** A copy of the page with all its content, right after it. */
  private duplicatePage(id: string) {
    const { ed } = this;
    const doc = ed.doc;
    const pages = userPages(doc);
    const copy = doc.transact(() => {
      const page = doc.create('PAGE', doc.root, { ...structuredClone(doc.node(id)!.props), name: `${doc.get(id, 'name') ?? t('Страница')} (копия)` }, pages.indexOf(id) + 1);
      const walk = (src: string, dst: string) => {
        for (const c of doc.children(src)) {
          const rec = doc.node(c)!;
          walk(c, doc.create(rec.type, dst, structuredClone(rec.props)));
        }
      };
      walk(id, page);
      return page;
    });
    ed.setPage(copy);
  }

  /** Delete a page (not the last one); if it is the current one, go to an adjacent page. */
  private deletePage(id: string) {
    const { ed } = this;
    const doc = ed.doc;
    const pages = userPages(doc).filter((p) => !isDivider(doc.get(p, 'name') ?? ''));
    if (userPages(doc).length <= 1) return;
    if (id === ed.pageId) {
      const next = pages.filter((p) => p !== id);
      if (!next.length) return;
      ed.setPage(next[Math.min(pages.indexOf(id), next.length - 1)]!);
    }
    doc.transact(() => doc.delete(id));
  }

  // ---------- Layers ----------

  private renderLayers() {
    const { ed } = this;
    this.layersDirty = false;
    // Row tree without DOM: walk the expanded branches (top layer first).
    const flat: { id: string; depth: number }[] = [];
    const walk = (parent: string, depth: number) => {
      const kids = ed.doc.children(parent);
      for (let i = kids.length - 1; i >= 0; i--) {
        const id = kids[i]!;
        flat.push({ id, depth });
        if (this.expanded.has(id) && ed.doc.children(id).length) walk(id, depth + 1);
      }
    };
    walk(ed.pageId, 0);
    this.flat = flat;
    this.rowOrder = flat.map((r) => r.id);
    this.rowIndex = new Map(this.rowOrder.map((id, i) => [id, i]));
    // Tab enters the tree on a single row (the selected one); arrows move further. Focus in the tree
    // survives a panel redraw.
    const list = $('layers');
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#layers .row')?.dataset.id ?? null;
    const known = (id: string | null | undefined) => (id && this.rowIndex.has(id) ? id : null);
    const target = known(this.focusRow) ?? known(focused) ?? ed.selection.find((s) => this.rowIndex.has(s)) ?? this.rowOrder[0] ?? null;
    const refocus = !!this.focusRow || !!focused;
    this.focusRow = null;
    this.tabRow = target;
    this.drawRows();
    const reveal = known(this.revealRow) ?? (refocus ? target : null);
    this.revealRow = null;
    if (reveal) {
      // Scroll by virtual row index: offscreen rows do not exist in the DOM yet.
      const top = this.rowIndex.get(reveal)! * ROW_H;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H - list.clientHeight;
      if (!this.rowsCover()) this.drawRows();
    }
    if (refocus && target) {
      list.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(target)}"]`)?.focus({ preventScroll: true });
    }
  }

  /** Visible rows of the layer tree: [first, last + 1). */
  private visibleRows(): [number, number] {
    const list = $('layers');
    const a = Math.floor(list.scrollTop / ROW_H);
    const b = Math.ceil((list.scrollTop + (list.clientHeight || 600)) / ROW_H);
    return [Math.min(a, this.flat.length), Math.min(b, this.flat.length)];
  }

  /** Drawn rows cover the visible ones. */
  private rowsCover(): boolean {
    const [a, b] = this.visibleRows();
    return a >= this.shown[0] && b <= this.shown[1];
  }

  /** The layer tree was scrolled: draw the rows that became visible. */
  private scheduleRows() {
    if (this.rowsScheduled) return;
    this.rowsScheduled = true;
    requestAnimationFrame(() => {
      this.rowsScheduled = false;
      if (!this.rowsCover()) this.drawRows();
    });
  }

  /** Tree rows in the DOM: visible ones plus a margin above and below; the rest are empty spacers of the same height. */
  private drawRows() {
    const list = $('layers');
    const n = this.flat.length;
    if (!n) {
      this.shown = [0, 0];
      list.replaceChildren(h('div', { class: 'empty' }, 'Пусто. Нарисуйте фрейм (F) или прямоугольник (R).'));
      return;
    }
    const [a, b] = this.visibleRows();
    const from = Math.max(0, a - OVERSCAN);
    const to = Math.min(n, b + OVERSCAN);
    this.shown = [from, to];
    const sel = new Set(this.ed.selection);
    const rows: HTMLElement[] = [];
    for (let i = from; i < to; i++) rows.push(this.layerRow(this.flat[i]!.id, this.flat[i]!.depth, sel));
    const tab = rows.find((r) => r.dataset.id === this.tabRow) ?? rows[0];
    if (tab) tab.tabIndex = 0;
    const gap = (rowsCount: number) => h('div', { class: 'rows-gap', style: `height:${rowsCount * ROW_H}px`, 'aria-hidden': 'true' });
    list.replaceChildren(gap(from), ...rows, gap(n - to));
  }

  /** Layer row in the tree. */
  private layerRow(id: string, depth: number, sel: Set<string>): HTMLElement {
    const { ed } = this;
    const type = ed.doc.type(id)!;
    const kids = ed.doc.children(id).length;
    const open = this.expanded.has(id);
    const visible = ed.doc.get(id, 'visible') !== false;
    const locked = layerLocked(ed.doc, id);
    const parent = ed.doc.parent(id);
    const inheritedLock = !!parent && layerLocked(ed.doc, parent);
    const label = labelColor(ed.doc, id);
    return h(
      'div',
      {
        class: `row ${sel.has(id) ? 'selected' : ''} ${visible ? '' : 'hidden'} ${type === 'COMPONENT' || type === 'COMPONENT_SET' || type === 'INSTANCE' ? 'component' : ''} ${label ? 'labeled' : ''}`,
        style: `padding-left:${8 + depth * 14}px${label ? `;--label:${label}` : ''}`,
        'data-id': id,
        role: 'treeitem',
        'aria-level': depth + 1,
        'aria-selected': String(sel.has(id)),
        'aria-expanded': kids ? String(open) : undefined,
        'aria-label': `${ed.doc.get(id, 'name') ?? ''}, ${NODE_LABEL[type] ?? type}${visible ? '' : ', скрыт'}${locked ? ', заблокирован' : ''}${label ? ', с меткой' : ''}`,
        tabIndex: -1,
        onkeydown: (e: KeyboardEvent) => this.layerKey(e, id),
        onpointerdown: (e: PointerEvent) => this.dragStart(e, id),
        onclick: (e: MouseEvent) => {
          if (this.dragged) return;
          // Shift — a range of rows, Ctrl — add or remove a single layer.
          const a = this.anchorRow ? this.rowOrder.indexOf(this.anchorRow) : -1;
          const b = this.rowOrder.indexOf(id);
          if (e.shiftKey && a >= 0 && b >= 0) {
            const range = this.rowOrder.slice(Math.min(a, b), Math.max(a, b) + 1);
            ed.select([...ed.selection.filter((s) => !range.includes(s)), ...range]);
            return;
          }
          if (e.ctrlKey || e.metaKey) ed.select(sel.has(id) ? ed.selection.filter((s) => s !== id) : [...ed.selection, id]);
          else ed.select([id]);
          this.anchorRow = id;
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          if (!sel.has(id)) ed.select([id]);
          this.onContextMenu?.(e.clientX, e.clientY);
        },
        ondblclick: () => this.rename(id),
        onmouseenter: () => {
          ed.hover = id;
          ed.dirty = true;
        },
        onmouseleave: () => {
          if (ed.hover === id) ed.hover = null;
          ed.dirty = true;
        },
      },
      svgEl(
        'span',
        {
          class: `twisty ${open ? 'open' : ''}`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            // Alt — expand or collapse all descendants too.
            const ids = e.altKey ? [id, ...ed.doc.descendants(id)] : [id];
            for (const k of ids) {
              if (open) this.expanded.delete(k);
              else if (ed.doc.children(k).length) this.expanded.add(k);
            }
            this.schedule();
          },
        },
        kids ? ICON.chevronRight : '',
      ),
      svgEl('span', { class: 'icon', title: 'Двойной клик — показать на холсте', onpointerdown: (e: PointerEvent) => e.stopPropagation(), onclick: (e: MouseEvent) => {
        e.stopPropagation();
        const at = performance.now();
        const twice = this.lastIconClick?.id === id && at - this.lastIconClick.at < 500;
        this.lastIconClick = twice ? null : { id, at };
        ed.select([id]);
        if (twice) { ed.fitRect(ed.selectionBounds([id]), 8, true); ed.canvasEl.focus(); }
      }, ondblclick: (e: MouseEvent) => e.stopPropagation() }, layerIcon(type, { layoutMode: ed.doc.get(id, 'layoutMode'), fills: ed.doc.get(id, 'fills') as { type: string; visible?: boolean }[] | undefined })),
      h('span', { class: 'name' }, this.nameNode(id)),
      svgEl(
        'button',
        {
          class: `act ${locked ? 'on' : ''}`,
          title: inheritedLock ? 'Заблокирован родительским слоем' : locked ? 'Разблокировать' : 'Заблокировать',
          disabled: inheritedLock,
          // From the keyboard — Ctrl+Shift+L for the selection; Tab doesn't visit every row.
          tabIndex: -1,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            ed.doc.set(id, { locked: !locked });
          },
        },
        locked ? ICON.lock : ICON.unlock,
      ),
      svgEl(
        'button',
        {
          class: `act ${visible ? '' : 'on'}`,
          title: visible ? 'Скрыть' : 'Показать',
          tabIndex: -1,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            ed.doc.set(id, { visible: !visible });
          },
        },
        visible ? ICON.eye : ICON.eyeOff,
      ),
    );
  }

  /**
   * Keys in the layer tree: ↑↓ — adjacent layer (Shift — add to selection), → — expand or go to the
   * first child, ← — collapse or go to the parent, Home/End — first and last, F2 — rename.
   * Others (Delete, Ctrl+C, …) behave as on the canvas.
   */
  private layerKey(e: KeyboardEvent, id: string) {
    if (e.target !== e.currentTarget) return;
    const { ed } = this;
    const order = this.rowOrder;
    const i = order.indexOf(id);
    const go = (t: string | undefined) => {
      if (!t) return;
      this.focusRow = t;
      ed.select(e.shiftKey ? [...ed.selection.filter((s) => s !== t), t] : [t]);
      this.anchorRow = t;
      this.schedule();
    };
    const kids = ed.doc.children(id).length > 0;
    if (e.key === 'ArrowDown') go(order[i + 1]);
    else if (e.key === 'ArrowUp') go(order[i - 1]);
    else if (e.key === 'Home') go(order[0]);
    else if (e.key === 'End') go(order[order.length - 1]);
    else if (e.key === 'ArrowRight') {
      // The tree always takes the arrows: otherwise they would nudge the selected layer on the canvas.
      if (!kids) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!this.expanded.has(id)) {
        this.expanded.add(id);
        this.focusRow = id;
        this.schedule();
      } else go(order[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      if (kids && this.expanded.has(id)) {
        this.expanded.delete(id);
        this.focusRow = id;
        this.schedule();
      } else {
        const p = ed.doc.parent(id);
        if (p && p !== ed.pageId) go(p);
      }
    } else if (e.key === 'F2') this.rename(id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private nameNode(id: string): Node {
    const name = this.ed.doc.get(id, 'name') ?? '';
    if (this.editingName !== id) return document.createTextNode(name);
    const input = h('input', { value: name }) as HTMLInputElement;
    const commit = () => {
      if (this.editingName !== id) return;
      this.editingName = null;
      if (input.value.trim() && input.value !== name) this.ed.doc.set(id, { name: input.value.trim() });
      else this.schedule();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        this.editingName = null;
        this.schedule();
      }
    });
    input.addEventListener('blur', commit);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  rename(id: string) {
    if (this.ed.devMode) return;
    this.editingName = id;
    this.schedule();
  }

  // ---------- Properties ----------

  private renderProperties() {
    const root = $('properties');
    const next = h('div');
    beginRefresh();
    this.buildProperties(next);
    endRefresh();
    // While a field is being dragged or typed in, the panel elements are not recreated (otherwise
    // the drag and typing would break off) — only the values are updated in place if the structure is the same.
    const busy = this.scrubbing || (root.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT');
    if (busy) {
      if (sameShape(root, next)) patchValues(root, next);
      return;
    }
    root.replaceChildren(...next.childNodes);
  }

  /** Additional property sections from modules (grid repeat etc.) — after the component section. */
  extraSections: ((sel: string[]) => HTMLElement | '')[] = [];

  /** The “Frame” tool was switched back to “Move” (after creating a frame from a preset). */
  onToolReset: (() => void) | null = null;

  /** Frame presets: click creates a frame of this size to the right of the page content. */
  /** Families for the font picker: without internet — bundled and custom, with internet — the catalog too. */
  fontFamilies(): string[] {
    const ed = this.ed;
    const base = ed.fonts.offline() ? this.bundledFonts : [...FONT_FAMILIES, ...this.bundledFonts];
    return [...new Set([...base, ...ed.fonts.localFamilies])].sort((a, b) => a.localeCompare(b));
  }

  private framePresets(): HTMLElement {
    const { ed } = this;
    const doc = ed.doc;
    const create = (name: string, w: number, h: number) => {
      const top = doc.children(ed.pageId);
      const b = top.length ? ed.selectionBounds(top) : null;
      const v = ed.viewportRect();
      const x = b ? Math.round(b[2] + 100) : Math.round((v[0] + v[2]) / 2 - w / 2);
      const y = b ? Math.round(b[1]) : Math.round((v[1] + v[3]) / 2 - h / 2);
      const id = doc.transact(() => doc.create('FRAME', ed.pageId, { name, transform: [1, 0, x, 0, 1, y], width: w, height: h, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }));
      this.onToolReset?.();
      ed.select([id]);
      ed.fitRect([x - 80, y - 80, x + w + 80, y + h + 80]);
    };
    return h(
      'div',
      { class: 'section presets' },
      h('h3', {}, 'Фрейм'),
      ...FRAME_PRESETS.map(([group, items]) =>
        h(
          'div',
          { class: 'preset-group' },
          h('div', { class: 'preset-title' }, group),
          ...items.map(([name, w, hh]) => h('button', { class: 'preset', onclick: () => create(name, w, hh) }, h('span', {}, name), h('span', { class: 'size' }, `${w}×${hh}`))),
        ),
      ),
    );
  }

  /** Scale (K): exact percentage for the selection — from the top-left corner of the combined bounds. */
  private scaleSection(sel: string[]): HTMLElement {
    const { ed } = this;
    const doc = ed.doc;
    const input = h('input', { value: '100' }) as HTMLInputElement;
    const apply = () => {
      const v = Number(input.value.replace(',', '.'));
      input.value = '100';
      if (!(v > 0) || v === 100) return;
      scaleBy(v / 100);
    };
    /** Scale the selection by s from the top-left corner of the combined bounds. */
    const scaleBy = (s: number) => {
      const box = ed.selectionBounds(sel);
      if (!box) return;
      doc.transact(() => {
        for (const id of sel) {
          const parent = doc.parent(id)!;
          const pw = (parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(parent)) as Matrix;
          const w = ed.worldMatrix(id) as Matrix;
          scaleTree(doc, id, s);
          doc.set(id, { transform: multiply(invert(pw), [w[0], w[1], box[0] + (w[2] - box[0]) * s, w[3], w[4], box[1] + (w[5] - box[1]) * s]) });
        }
      });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') apply();
    });
    input.addEventListener('change', apply);
    // Drag: percent of the size at drag start, applied in steps (ratio to the previous step).
    const scaleLabel = h('label', {}, '×');
    scaleLabel.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      let prev = 100;
      this.scrub(scaleLabel, e, 100, (v) => {
        const next = Math.max(1, v);
        input.value = String(next);
        if (next !== prev) scaleBy(next / prev);
        prev = next;
      });
    });
    return h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Масштаб'),
      h('div', { class: 'props' }, h('div', { class: 'field wide', title: 'Масштаб слоёв целиком: размеры, обводки, текст, эффекты' }, scaleLabel, input, h('span', { class: 'unit' }, '%'))),
      h('div', { class: 'empty', style: 'padding:6px 12px 0' }, 'Или тяните ручки рамки. Alt — от центра.'),
    );
  }

  /** Inspect (developer mode) — built by inspect-panel.ts. */
  inspect: { build(root: HTMLElement): void } | null = null;

  /**
   * Section settings in a popup next to the button. The popup lives
   * across panel redraws: rows are rebuilt, onClosed clears the section flag.
   */
  private settingsPop(key: string, anchor: HTMLElement, title: string, rows: (HTMLElement | string)[], onClosed: () => void) {
    let pop = this.setPops.get(key);
    if (!pop || !pop.box.isConnected) {
      // To the left of the whole right panel.
      const made = popover(anchor, 'fx-pop set-pop', {
        width: 260,
        side: 'left',
        leftOf: document.getElementById('right'),
        onClose: () => {
          if (this.setPops.get(key)?.box !== made.box) return;
          this.setPops.delete(key);
          this.setPopClosed.set(key, performance.now());
          onClosed();
          this.schedule();
        },
      });
      pop = made;
      this.setPops.set(key, pop);
    }
    const close = this.iconButton(ICON.close, 'Закрыть', () => pop!.close());
    pop.box.replaceChildren(h('div', { class: 'fx-pop-head' }, title, close), h('div', { class: 'effect-body props' }, ...rows));
    // Content grew — the popup moves up so it doesn't go past the bottom edge.
    const box = pop.box;
    if (box.getBoundingClientRect().bottom > innerHeight - 8) box.style.top = `${Math.max(8, innerHeight - box.offsetHeight - 8)}px`;
  }

  /** Section settings button: open or close its popup (a click that closed the popup doesn't reopen it). */
  private settingsToggle(key: string, open: boolean, set: (on: boolean) => void) {
    if (!open && performance.now() - (this.setPopClosed.get(key) ?? 0) < 300) return;
    if (open) this.setPops.get(key)?.close();
    set(!open);
    this.schedule();
  }

  private buildProperties(root: HTMLElement) {
    const { ed } = this;
    const doc = ed.doc;
    const sel = ed.selection;
    // Different selection — section settings popups close.
    const popSel = sel.join(',');
    if (popSel !== this.setPopSel) {
      this.setPopSel = popSel;
      this.layoutMore = this.strokeMore = this.textMore = this.cornersMore = false;
      this.guideOpen = null;
      for (const pop of [...this.setPops.values()]) pop.close();
    }
    if (ed.devMode && this.inspect) {
      this.inspect.build(root);
      return;
    }
    if (ed.tool === 'frame') {
      root.append(this.framePresets());
      return;
    }
    if (ed.tool === 'brush' && this.brushSection) {
      root.append(this.brushSection());
      return;
    }
    const vs = this.tab === 'design' ? this.vectorSection?.() : null;
    if (vs) root.append(vs);
    if (this.tab === 'prototype') {
      root.append(...prototypeSections(ed, { colorField: (k, c, set, alpha) => this.colorField(k, c, set, alpha), present: (start) => this.onPresent(start), devices: FRAME_PRESETS }));
      return;
    }
    if (sel.length) this.editingStyle = null;
    if (!sel.length && this.editingStyle && doc.has(this.editingStyle)) {
      root.append(...this.styleEditor(this.editingStyle));
      return;
    }
    if (!sel.length) {
      const bg = doc.get(ed.pageId, 'backgrounds')?.[0];
      const color = bg?.type === 'SOLID' ? bg.color : { r: 0.96, g: 0.96, b: 0.96 };
      root.append(
        h(
          'div',
          { class: 'section' },
          h('h3', {}, 'Страница'),
          h('div', { class: 'props' }, this.colorField(`page:${ed.pageId}`, { ...color, a: 1 }, (c) => doc.set(ed.pageId, { backgrounds: [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } }] }), false)),
        ),
        ...(modeRows(ed, [ed.pageId]).length ? [h('div', { class: 'section' }, h('h3', {}, 'Режимы страницы'), h('div', { class: 'props comp-props' }, ...modeRows(ed, [ed.pageId])))] : []),
        h(
          'div',
          { class: 'section' },
          h('h3', {}, 'Локальные переменные'),
          h('div', { class: 'props' }, h('button', { class: 'export-btn wide', onclick: () => openVariablesWindow(ed) }, localVariables(doc).length ? `Открыть переменные (${localVariables(doc).length} в ${localCollections(doc).length} колл.)` : 'Создать переменные')),
        ),
        localStylesSection(ed, (id) => this.openStyle(id)),
        h('div', { class: 'empty', style: 'padding-top:12px' }, 'Выделите слой, чтобы изменить его свойства.'),
      );
      return;
    }
    const same = <T>(get: (id: string) => T): T | null => {
      const v = get(sel[0]!);
      return sel.every((id) => JSON.stringify(get(id)) === JSON.stringify(v)) ? v : null;
    };
    const tf = (id: string) => (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
    const setEach = (fn: (id: string) => Props | null) =>
      doc.transact(() => {
        for (const id of sel) {
          const p = fn(id);
          if (p) doc.set(id, p);
        }
      });
    const types = new Set(sel.map((id) => doc.type(id)!));
    const hasRadius = [...types].every((t) => t === 'RECTANGLE' || t === 'FRAME' || t === 'COMPONENT' || t === 'COMPONENT_SET' || t === 'INSTANCE');
    const allText = [...types].every((t) => t === 'TEXT');
    const frames = [...types].every((t) => t === 'FRAME' || t === 'COMPONENT' || t === 'COMPONENT_SET' || t === 'INSTANCE');
    // Components: instances (property values), main component or set (properties), layer in a component (binding).
    const one = sel.length === 1 ? sel[0]! : null;
    const components = [...types].every((t) => t === 'INSTANCE')
      ? instanceSection(ed, sel)
      : one && (types.has('COMPONENT') || types.has('COMPONENT_SET'))
        ? componentSection(ed, one)
        : combineSection(ed, sel);

    root.append(
      ed.tool === 'scale' ? this.scaleSection(sel) : '',
      this.selHeader(sel, types),
      components,
      ...this.extraSections.map((x) => x(sel)),
      bindingSection(ed, sel),
      this.positionSection(sel, same, setEach, tf),
      this.layoutSection(sel, same, setEach, frames),
      [...types].every((t) => t === 'BOOLEAN_OPERATION') ? this.booleanSection(same, setEach) : '',
      this.appearanceSection(sel, same, setEach, types, hasRadius),
      allText ? this.withStyle(this.textSection(sel, same), sel, 'textStyleId', false) : '',
      this.withStyle(this.paintsSection('Заливка', 'fills', sel, setEach, { r: 0.85, g: 0.85, b: 0.85 }), sel, 'fillStyleId'),
      types.has('TEXT') || types.has('GROUP') ? '' : this.withStyle(this.strokeSection(sel, same, setEach), sel, 'strokeStyleId', false),
      this.selectionColorsSection(sel),
      this.withStyle(this.effectsSection(sel, same, setEach), sel, 'effectStyleId'),
      frames ? this.withStyle(this.layoutGridSection(sel, same, setEach), sel, 'gridStyleId') : '',
      this.exportSection(sel),
    );
  }

  // ---------- Styles ----------

  /** Edit a style in the panel (selection is cleared; “back” restores it). */
  openStyle(id: string) {
    if (this.ed.selection.length) this.styleReturn = [...this.ed.selection];
    this.editingStyle = id;
    if (this.ed.selection.length) this.ed.select([]);
    else this.schedule();
  }

  /**
   * Section with a style: a styles button in the header; if the selection shares one style — a style
   * row (instead of values, and for text and stroke — above them: they also have their own settings).
   */
  private withStyle(section: HTMLElement | string, sel: string[], field: StyleField, replaceBody = true): HTMLElement | string {
    const doc = this.ed.doc;
    if (typeof section === 'string' || !sel.length || sel.some((id) => doc.type(id) === 'STYLE')) return section;
    const head = section.querySelector('h3');
    if (!head) return section;
    let acts = head.querySelector('.h-acts');
    if (!acts) {
      acts = h('span', { class: 'h-acts' });
      head.append(acts);
    }
    const btn = svgEl('button', { title: 'Стили' }, ICON.styles);
    btn.addEventListener('click', () => openStylePicker(this.ed, btn, field, sel));
    acts.prepend(btn);
    const row = appliedStyleRow(this.ed, sel, field, (id) => this.openStyle(id));
    if (!row) return section;
    if (replaceBody) {
      for (const c of [...section.children]) if (c !== head) c.remove();
      section.append(h('div', { class: 'props' }, row));
    } else head.after(h('div', { class: 'props', style: 'margin-bottom:8px' }, row));
    return section;
  }

  /** Style editing: name, description and values (the same sections as for a layer). */
  private styleEditor(id: string): (HTMLElement | string)[] {
    const doc = this.ed.doc;
    const sel = [id];
    const setEach = (fn: (n: string) => Props | null) =>
      doc.transact(() => {
        const p = fn(id);
        if (p) doc.set(id, p);
      });
    const same = <T>(get: (n: string) => T): T | null => get(id);
    const back = () => {
      this.editingStyle = null;
      const ret = this.styleReturn.filter((n) => doc.has(n));
      this.styleReturn = [];
      if (ret.length) this.ed.select(ret);
      else this.schedule();
    };
    const type = doc.get(id, 'styleType');
    const body =
      type === 'PAINT'
        ? this.paintsSection('Цвет', 'fills', sel, setEach, { r: 0.85, g: 0.85, b: 0.85 })
        : type === 'EFFECT'
          ? this.effectsSection(sel, same, setEach)
          : type === 'GRID'
            ? this.layoutGridSection(sel, same, setEach)
            : this.textStyleEditor(id, setEach);
    return [styleEditorHead(this.ed, id, back), body];
  }

  /** Text style values: font, size, spacing, case, decorations. */
  private textStyleEditor(id: string, setEach: (fn: (n: string) => Props | null) => void): HTMLElement {
    const doc = this.ed.doc;
    const font = doc.get(id, 'fontName') ?? { family: 'Inter', style: 'Regular' };
    const family = h('input', { value: font.family }) as HTMLInputElement;
    const style = h('input', { value: font.style }) as HTMLInputElement;
    for (const [input, key] of [[family, 'family'], [style, 'style']] as const) {
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
      });
      input.addEventListener('change', () => {
        const v = input.value.trim();
        if (!v) return;
        setEach(() => ({ fontName: { ...(doc.get(id, 'fontName') ?? font), [key]: v } }));
        void this.ed.fonts.ensure({ ...(doc.get(id, 'fontName') ?? font) });
      });
    }
    const lh = doc.get(id, 'lineHeight') ?? { unit: 'AUTO' };
    const ls = doc.get(id, 'letterSpacing') ?? { unit: 'PERCENT', value: 0 };
    const caseSel = h('select', {}, ...([['ORIGINAL', 'Как есть'], ['UPPER', 'ПРОПИСНЫЕ'], ['LOWER', 'строчные'], ['TITLE', 'Каждое Слово'], ['SMALL_CAPS', 'Капитель']] as const).map(([v, l]) => h('option', { value: v, selected: v === (doc.get(id, 'textCase') ?? 'ORIGINAL') }, l))) as HTMLSelectElement;
    caseSel.addEventListener('change', () => setEach(() => ({ textCase: caseSel.value as Props['textCase'] })));
    const decoSel = h('select', {}, ...([['NONE', 'Без линий'], ['UNDERLINE', 'Подчёркнутый'], ['STRIKETHROUGH', 'Зачёркнутый']] as const).map(([v, l]) => h('option', { value: v, selected: v === (doc.get(id, 'textDecoration') ?? 'NONE') }, l))) as HTMLSelectElement;
    decoSel.addEventListener('change', () => setEach(() => ({ textDecoration: decoSel.value as Props['textDecoration'] })));
    return h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Текст'),
      h(
        'div',
        { class: 'props' },
        h('div', { class: 'field wide', title: 'Семейство' }, family),
        h('div', { class: 'field', title: 'Начертание' }, style),
        this.numField('', doc.get(id, 'fontSize') ?? 12, (v) => (v > 0 ? { fontSize: v } : null), setEach, false, { unit: 'px', title: 'Кегль' }),
        this.numField('↕', lh.unit === 'AUTO' ? 0 : lh.value, (v) => ({ lineHeight: v > 0 ? { unit: lh.unit === 'PERCENT' ? 'PERCENT' : 'PIXELS', value: v } : { unit: 'AUTO' } }), setEach, false, { unit: lh.unit === 'PERCENT' ? '%' : 'px', title: 'Межстрочный (0 — авто)' }),
        this.numField('⇔', ls.value, (v) => ({ letterSpacing: { unit: ls.unit, value: v } }), setEach, false, { unit: ls.unit === 'PERCENT' ? '%' : 'px', title: 'Межбуквенный' }),
        this.numField('¶', doc.get(id, 'paragraphSpacing') ?? 0, (v) => ({ paragraphSpacing: Math.max(0, v) }), setEach, false, { unit: 'px', title: 'Интервал абзацев' }),
        h('div', { class: 'field' }, caseSel),
        h('div', { class: 'field' }, decoSel),
      ),
      this.textStyleColor(id, setEach),
    );
  }

  /**
   * Text from a variable (our own): string, number, color (HEX) or boolean — the value in the
   * layer's mode, updated when the variable is edited or the mode changes. When bound, the button unbinds.
   */
  private textVariableButton(sel: string[]): HTMLElement | string {
    const { ed } = this;
    const doc = ed.doc;
    if (!sel.length || sel.some((id) => doc.type(id) !== 'TEXT')) return '';
    const bound = doc.get(sel[0]!, 'boundVariables')?.characters?.id ?? null;
    const btn = svgEl('button', { class: bound ? 'on' : '', title: bound ? `Текст из переменной «${doc.get(bound, 'name') ?? ''}» — щелчок: сменить или отвязать` : 'Текст из переменной: строка, число или цвет (HEX)' }, ICON.variable) as HTMLButtonElement;
    btn.addEventListener('click', () =>
      openVariablePicker(ed, btn, {
        types: ['STRING', 'FLOAT', 'COLOR', 'BOOLEAN'],
        field: 'characters',
        nodeId: sel[0],
        nodeType: 'TEXT',
        current: bound,
        onPick: (v) => bindFields(ed, sel, ['characters'], v),
        onOpenWindow: () => openVariablesWindow(ed),
      }),
    );
    return btn;
  }

  /**
   * Color in a text style (our own): when on, the style colors the text on apply and on style edit.
   */
  private textStyleColor(id: string, setEach: (fn: (n: string) => Props | null) => void): HTMLElement {
    const doc = this.ed.doc;
    const fills = (doc.get(id, 'fills') ?? []) as Paint[];
    const solid = fills.find((p) => p.type === 'SOLID');
    if (!solid || solid.type !== 'SOLID') {
      return h('div', { class: 'props' }, h('button', { class: 'link-btn', title: 'Стиль будет задавать и цвет текста', onclick: () => setEach(() => ({ fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] })) }, '+ Цвет в стиле'));
    }
    return h(
      'div',
      { class: 'props' },
      this.colorField(`style-color:${id}`, { ...solid.color, a: solid.opacity ?? 1 }, (c) => setEach(() => ({ fills: [{ ...solid, color: { r: c.r, g: c.g, b: c.b }, opacity: c.a < 1 ? c.a : undefined }] }))),
      this.iconButton(ICON.close, 'Убрать цвет из стиля (тексты сохранят нынешний цвет)', () => setEach(() => ({ fills: undefined }))),
    );
  }

  /** Header: type of the selection (for an instance — also the component name). */
  private selHeader(sel: string[], types: Set<NodeType>): HTMLElement {
    const doc = this.ed.doc;
    const one = types.size === 1 ? [...types][0]! : null;
    const label = sel.length > 1 ? `Выделено: ${sel.length}` : one === 'COMPONENT' || one === 'COMPONENT_SET' ? (doc.get(sel[0]!, 'name') || (NODE_LABEL[one] ?? one)) : one ? (NODE_LABEL[one] ?? one) : '';
    let instanceName = '';
    if (sel.length === 1 && one === 'INSTANCE') {
      const m = doc.get(sel[0]!, 'componentId');
      if (m && doc.has(m)) {
        const parent = doc.parent(m);
        instanceName = parent && doc.type(parent) === 'COMPONENT_SET' ? (doc.get(parent, 'name') ?? '') : (doc.get(m, 'name') ?? '');
      }
    }
    // “Frame ⌄”: for a single frame, group or section — change the type in place.
    const kinds: [ContainerKind, string][] = [
      ['FRAME', 'Фрейм'],
      ['GROUP', 'Группа'],
      ...(sel.length === 1 && ['PAGE', 'SECTION'].includes(doc.type(doc.parent(sel[0]!) ?? '') ?? '') ? [['SECTION', 'Секция'] as [ContainerKind, string]] : []),
    ];
    const convertible = sel.length === 1 && (one === 'FRAME' || one === 'GROUP' || one === 'SECTION');
    const title: HTMLElement = convertible
      ? h(
          'button',
          {
            class: 'sel-type',
            title: one === 'FRAME' ? 'Тип слоя и заготовки размеров' : 'Сменить тип: фрейм, группа или секция',
            onclick: () => {
              const r = title.getBoundingClientRect();
              const items: MenuEntry[] = kinds.map(([k, name]) => ({
                label: name,
                checked: k === one,
                run: () => {
                  if (k === one) return;
                  const id = doc.transact(() => convertContainer(doc, sel[0]!, k));
                  this.ed.select([id]);
                },
              }));
              // Size presets for an already created frame: position doesn't change.
              if (one === 'FRAME')
                items.push(
                  'sep',
                  ...FRAME_PRESETS.map(([group, list]) => ({
                    label: group,
                    submenu: list.map(([name, w, hh]) => ({ label: name, hint: `${w}×${hh}`, run: () => doc.transact(() => resizeWithConstraints(doc, sel[0]!, { width: w, height: hh })) })),
                  })),
                );
              showMenuAt(r.left, r.bottom + 4, items);
            },
          },
          h('span', {}, label),
          svgEl('span', { class: 'sel-chevron' }, ICON.chevronDown),
        )
      : h('span', {}, instanceName || label);
    const acts = h('span', { class: 'h-acts sel-acts' });
    // Developer mode is a toggle on the bottom bar, not in the selection header.
    const { createComponent, menu } = this.headerActions;
    if (createComponent && sel.length && !sel.some((id) => ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(doc.type(id) ?? '')))
      acts.append(this.iconButton(ICON.component, 'Создать компонент (Ctrl+Alt+K)', createComponent));
    if (menu) {
      const more: HTMLButtonElement = this.iconButton(ICON.more, 'Ещё действия со слоем', () => {
        const r = more.getBoundingClientRect();
        showMenuAt(r.right - 220, r.bottom + 4, menu());
      });
      acts.append(more);
    }
    return h(
      'div',
      { class: `sel-head ${one === 'COMPONENT' || one === 'COMPONENT_SET' || one === 'INSTANCE' ? 'component' : ''}` },
      svgEl('span', {}, one ? (NODE_ICON[one] ?? ICON.rect) : ICON.boolean),
      title,
      acts,
    );
  }

  /**
   * Key object (our own, as in Illustrator): whose it is, spacing and distribution from it, clear.
   * Without a key — a hint on how to set one (only with multiple layers selected).
   */
  private keyObjectRow(sel: string[]): HTMLElement | string {
    const { ed } = this;
    if (sel.length < 2) return '';
    const key = keyOf(ed, sel);
    // No hint: the key object is set with Alt+click or from “More” in the context menu.
    if (!key) return '';
    const gap = h('input', { value: '', placeholder: 'авто', title: 'Промежуток от ключевого объекта, px; пусто — средний нынешний' }) as HTMLInputElement;
    gap.addEventListener('keydown', (e) => e.stopPropagation());
    const value = () => {
      const r = evaluateNumberInput(gap.value, ed.doc.get(ed.doc.root, 'rootFontSize') ?? ROOT_FONT_SIZE);
      return r && !r.percent ? r.value : undefined;
    };
    return h(
      'div',
      { class: 'key-row' },
      h('span', { class: 'key-name', title: 'Ключевой объект' }, '◆ ', ed.doc.get(key, 'name') || t('Слой')),
      (() => {
        // Drag changes only the number in the field; the buttons next to it apply it (horizontally or vertically).
        const lab = h('label', {}, '↔');
        this.scrubText(lab, gap, () => {}, { fallback: '0', min: 0 });
        return h('div', { class: 'field', title: 'Промежуток' }, lab, gap);
      })(),
      this.iconButton(ICON.distributeH, 'Промежутки по горизонтали от ключевого объекта', () => distribute(ed, sel, 'x', value())),
      this.iconButton(ICON.distributeV, 'Промежутки по вертикали от ключевого объекта', () => distribute(ed, sel, 'y', value())),
      this.iconButton(ICON.close, 'Снять ключевой объект', () => {
        ed.keyObject = null;
        ed.dirty = true;
        this.schedule();
      }),
    );
  }

  /** Field group label above them (“Position”, “Rotation”, “Dimensions”). */
  private caption(text: string): HTMLElement {
    return h('div', { class: 'caption' }, text);
  }

  /** Field with a label above it — in a grid cell or in a row. */
  private labeled(text: string, el: HTMLElement): HTMLElement {
    return h('div', { class: 'labeled' }, h('div', { class: 'caption' }, text), el);
  }

  private iconButton(icon: string, title: string, run: () => void, opts: { on?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
    const b = svgEl('button', { class: `icon-btn ${opts.on ? 'on' : ''}`, title, onclick: run }, icon) as HTMLButtonElement;
    b.disabled = !!opts.disabled;
    return b;
  }

  /** “Position”: alignment, X and Y, rotation and flip. */
  private positionSection(
    sel: string[],
    same: <T>(get: (id: string) => T) => T | null,
    setEach: (fn: (id: string) => Props | null) => void,
    tf: (id: string) => Matrix,
  ): HTMLElement {
    const { ed } = this;
    const doc = ed.doc;
    // A single layer aligns to its parent, several — to each other.
    const alignBtn = ([mode, icon, title]: (typeof ALIGN)[number]) => this.iconButton(ICON[icon], title, () => align(ed, sel, mode), { disabled: !canAlign(ed, sel) });
    const canDistribute = sel.length >= 3 || (sel.length > 1 && !!keyOf(ed, sel));
    const alignMore: HTMLButtonElement = this.iconButton(ICON.more, 'Распределить и упорядочить', () => {
      const r = alignMore.getBoundingClientRect();
      showMenuAt(r.right - 240, r.bottom + 4, [
        { label: 'Распределить по горизонтали', hint: 'Alt+Shift+H', disabled: !canDistribute, run: () => distribute(ed, sel, 'x') },
        { label: 'Распределить по вертикали', hint: 'Alt+Shift+V', disabled: !canDistribute, run: () => distribute(ed, sel, 'y') },
        'sep',
        { label: 'Упорядочить (Tidy up)', hint: 'Ctrl+Alt+T', disabled: sel.length < 2, run: () => tidyUp(ed, sel) },
      ]);
    }, { disabled: sel.length < 2 });
    const alignRow = [h('div', { class: 'prow halves' }, h('div', { class: 'icon-group boxed' }, ...ALIGN.slice(0, 3).map(alignBtn)), h('div', { class: 'icon-group boxed' }, ...ALIGN.slice(3).map(alignBtn)), alignMore)];
    const keyRow = this.keyObjectRow(sel);
    const flip = (sx: number, sy: number) =>
      setEach((id) => ({ transform: multiply(tf(id), [sx, 0, sx < 0 ? (doc.get(id, 'width') ?? 0) : 0, 0, sy, sy < 0 ? (doc.get(id, 'height') ?? 0) : 0]) as Matrix }));
    const acts = h('span', { class: 'h-acts' });
    if (sel.every((id) => isAutoLayout(doc, doc.parent(id)!))) {
      const abs = sel.every((id) => doc.get(id, 'layoutPositioning') === 'ABSOLUTE');
      acts.append(
        svgEl(
          'button',
          {
            class: abs ? 'on' : '',
            title: abs ? 'Вернуть в поток автораскладки' : 'Абсолютная позиция: вне потока автораскладки',
            onclick: () => setEach(() => ({ layoutPositioning: abs ? 'AUTO' : 'ABSOLUTE' })),
          },
          ICON.absolute,
        ),
      );
    }
    const rotationLocked = sel.some((id) => doc.type(id) === 'SECTION' && doc.get(id, 'sectionRotationEnabled') !== true);
    const constraints = this.constraintsRow(sel, same, setEach);
    return h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Положение', acts),
      h(
        'div',
        { class: 'props' },
        this.caption('Выравнивание'),
        ...alignRow,
        keyRow,
        this.caption('Положение'),
        this.numField('X', same((id) => tf(id)[2]), (v, id) => {
          const t = tf(id);
          return { transform: [t[0], t[1], v, t[3], t[4], t[5]] };
        }, setEach, false, { length: true }),
        this.numField('Y', same((id) => tf(id)[5]), (v, id) => {
          const t = tf(id);
          return { transform: [t[0], t[1], t[2], t[3], t[4], v] };
        }, setEach, false, { length: true }),
        ...(constraints ? [this.caption('Привязки'), constraints] : []),
        this.caption('Поворот'),
        h(
          'fieldset',
          { class: 'prow halves', style: 'border:0;margin:0;padding:0;min-width:0', disabled: rotationLocked },
          this.numField(ICON.rotate, same((id) => Math.round(rotationOf(tf(id)) * 100) / 100), (v, id) => doc.type(id) === 'SECTION' && doc.get(id, 'sectionRotationEnabled') !== true ? null : rotateAround(doc, id, v, this.ed.rotationOrigin), setEach, false, { unit: '°', title: 'Поворот (для секций требуется «Разрешить вращение»)' }),
          h(
            'div',
            { class: 'icon-group boxed' },
            this.iconButton(ICON.rotate, 'Повернуть на 90°', () => setEach((id) => doc.type(id) === 'SECTION' && doc.get(id, 'sectionRotationEnabled') !== true ? null : rotateAround(doc, id, rotationOf(tf(id)) + 90, this.ed.rotationOrigin))),
            this.iconButton(ICON.flipH, 'Отразить по горизонтали', () => flip(-1, 1)),
            this.iconButton(ICON.flipV, 'Отразить по вертикали', () => flip(1, -1)),
          ),
          rotationLocked ? h('span') : this.transformMenuButton(sel, setEach, tf),
        ),
        ...(sel.every(id => doc.type(id) === 'SECTION') ? [this.checkRow(same(id => doc.get(id, 'sectionRotationEnabled') === true), 'Разрешить вращение', 'Разрешает поворачивать секцию на холсте и через поле угла', on => setEach(() => ({ sectionRotationEnabled: on })))] : []),
        ...(rotationLocked ? [] : [this.skewRow(sel, same, setEach, tf), this.transform3dRow(sel, same, setEach)]),
      ),
    );
  }

  /**
   * “⋯” next to rotation: custom transforms (3D rotation, skew, distortion) live in a menu so the
   * section stays tidy; an enabled transform shows its fields below.
   */
  private transformMenuButton(sel: string[], setEach: (fn: (id: string) => Props | null) => void, tf: (id: string) => Matrix): HTMLElement {
    const doc = this.ed.doc;
    const has3dNow = sel.some((id) => has3d(doc.props(id)));
    const skewed = sel.some((id) => Math.abs(skewOf(tf(id))) > 0.005);
    const distorted = sel.some((id) => doc.get(id, 'distort'));
    const [ox, oy] = this.ed.rotationOrigin;
    const offCenter = ox !== 0.5 || oy !== 0.5;
    const btn: HTMLButtonElement = this.iconButton(ICON.more, 'Ещё: точка вращения, 3D-поворот, скос, искажение', () => {
      const r = btn.getBoundingClientRect();
      showMenuAt(r.left, r.bottom + 4, [
        { label: 'Точка вращения', submenu: () => this.originMenu() },
        'sep',
        { label: '3D-поворот', checked: has3dNow, run: () => (has3dNow ? undefined : setEach(() => ({ rotateY: 20 }))) },
        { label: 'Скос', checked: skewed, run: () => (skewed ? undefined : setEach((id) => skewAround(doc, id, 15, this.ed.rotationOrigin))) },
        { label: 'Свободное искажение', checked: !!distorted, run: () => (distorted ? undefined : setEach(() => ({ distort: [...FLAT_DISTORT] }))) },
      ]);
    }, { on: has3dNow || skewed || !!distorted || offCenter });
    return btn;
  }

  /**
   * 3D rotation (like CSS rotateX / rotateY with perspective): the layer stays flat, its projection
   * appears on the canvas, in presentation and export. Not on the selection — a “3D” button; present —
   * tilt, rotation, perspective, offset toward the viewer and “remove”.
   */
  /**
   * Layer skew (our own): slant angle along the layer's X axis around the rotation
   * origin (center by default); rotation and size don't change. No skew — empty (the
   * “+ Skew” button is in the 3D rotation row).
   */
  private skewRow(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void, tf: (id: string) => Matrix): HTMLElement | string {
    if (!sel.some((id) => Math.abs(skewOf(tf(id))) > 0.005)) return '';
    const doc = this.ed.doc;
    return h(
      'div',
      { class: 'prow' },
      this.numField(ICON.skew, same((id) => Math.round(skewOf(tf(id)) * 100) / 100), (v, id) => skewAround(doc, id, v, this.ed.rotationOrigin), setEach, false, { unit: '°', title: 'Скос вдоль оси X слоя, градусы (плюс — верх вправо), от −89 до 89' }),
      this.iconButton(ICON.close, 'Убрать скос', () => setEach((id) => skewAround(doc, id, 0, this.ed.rotationOrigin))),
    );
  }

  /**
   * Free distort (our own): “+ Distort” adds diamonds at the corners on the canvas; for a distorted
   * layer — reset the corners or remove the distortion.
   */
  private distortButton(sel: string[], setEach: (fn: (id: string) => Props | null) => void): HTMLElement {
    const doc = this.ed.doc;
    const on = sel.some((id) => doc.get(id, 'distort'));
    if (!on) return h('button', { class: 'link-btn', title: 'Свободное искажение: тяните ромбы в углах слоя на холсте (перспектива, трапеция)', onclick: () => setEach(() => ({ distort: [...FLAT_DISTORT] })) }, '+ Искажение');
    return h(
      'div',
      { class: 'prow' },
      h('span', { class: 'key-hint', style: 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, 'Искажение — ромбы в углах'),
      h('button', { class: 'link-btn', title: 'Углы — на место', onclick: () => setEach(() => ({ distort: [...FLAT_DISTORT] })) }, 'Сбросить'),
      this.iconButton(ICON.close, 'Убрать искажение', () => setEach(() => ({ distort: undefined }))),
    );
  }

  private transform3dRow(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement | string {
    const doc = this.ed.doc;
    const any = sel.some((id) => has3d(doc.props(id)));
    const distorted = sel.some((id) => doc.get(id, 'distort'));
    if (!any) return distorted ? h('div', { class: 'p3d' }, this.distortButton(sel, setEach)) : '';
    const deg = (key: 'rotateX' | 'rotateY', label: string, title: string) =>
      this.numField(label, same((id) => Math.round((doc.get(id, key) ?? 0) * 100) / 100), (v) => ({ [key]: Math.max(-180, Math.min(180, v)) }), setEach, false, { unit: '°', title });
    return h(
      'div',
      { class: 'p3d' },
      distorted ? this.distortButton(sel, setEach) : '',
      h(
        'div',
        { class: 'prow' },
        deg('rotateX', '↕', '3D: наклон вокруг горизонтальной оси (плюс — верх от зрителя)'),
        deg('rotateY', '↔', '3D: поворот вокруг вертикальной оси (плюс — правый край от зрителя)'),
        this.iconButton(ICON.close, 'Убрать 3D-поворот', () => setEach(() => ({ rotateX: undefined, rotateY: undefined, perspective: undefined, translateZ: undefined }))),
      ),
      h(
        'div',
        { class: 'prow' },
        this.numField('P', same((id) => doc.get(id, 'perspective') ?? DEFAULT_PERSPECTIVE), (v) => ({ perspective: Math.max(50, v) }), setEach, false, { title: '3D: перспектива — расстояние до зрителя, px (меньше — сильнее)' }),
        this.numField('Z', same((id) => doc.get(id, 'translateZ') ?? 0), (v) => ({ translateZ: v }), setEach, false, { title: '3D: сдвиг к зрителю, px (минус — от зрителя)' }),
      ),
    );
  }

  /**
   * Constraints: how a layer behaves when its frame is resized. Available for children of
   * frames without auto layout and for absolutely positioned layers inside auto layout.
   */
  private constraintsRow(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement | string {
    const { ed } = this;
    const doc = ed.doc;
    const ok = sel.every((id) => {
      const p = doc.parent(id);
      if (!p || p === ed.pageId) return false;
      const pt = doc.type(p);
      if (pt === 'GROUP' || pt === 'BOOLEAN_OPERATION' || pt === 'PAGE') return false;
      return !isAutoLayout(doc, p) || doc.get(id, 'layoutPositioning') === 'ABSOLUTE';
    });
    if (!ok) return '';
    const select = (axis: 'horizontal' | 'vertical', options: [string, string][]) => {
      const cur = same((id) => (doc.get(id, 'constraints') ?? { horizontal: 'MIN', vertical: 'MIN' })[axis]);
      const el = h('select', { title: axis === 'horizontal' ? 'По горизонтали' : 'По вертикали' }, ...options.map(([v, label]) => h('option', { value: v, selected: v === cur }, label))) as HTMLSelectElement;
      if (cur === null) el.prepend(h('option', { value: '', selected: true, disabled: true }, 'Разные'));
      el.addEventListener('change', () =>
        setEach((id) => ({ constraints: { ...(doc.get(id, 'constraints') ?? { horizontal: 'MIN', vertical: 'MIN' }), [axis]: el.value as 'MIN' } })),
      );
      return h('div', { class: 'field' }, svgEl('label', {}, axis === 'horizontal' ? ICON.constraintH : ICON.constraintV), el);
    };
    // Constraints diagram: edges pin to an edge, the middle line centers;
    // Shift adds the opposite edge (stretch). “Scale” — only from the list.
    type C = 'MIN' | 'MAX' | 'STRETCH' | 'CENTER' | 'SCALE';
    const cur = (axis: 'horizontal' | 'vertical') => same((id) => (doc.get(id, 'constraints') ?? { horizontal: 'MIN', vertical: 'MIN' })[axis] as C);
    const ch = cur('horizontal');
    const cv = cur('vertical');
    const setAxis = (axis: 'horizontal' | 'vertical', v: C) => setEach((id) => ({ constraints: { ...(doc.get(id, 'constraints') ?? { horizontal: 'MIN', vertical: 'MIN' }), [axis]: v } }));
    const edge = (axis: 'horizontal' | 'vertical', side: 'MIN' | 'MAX', cls: string, title: string) => {
      const c = axis === 'horizontal' ? ch : cv;
      const on = c === side || c === 'STRETCH';
      return h('button', {
        class: `cw-line ${cls}${on ? ' on' : ''}`,
        title,
        onclick: (e: MouseEvent) => {
          const other = side === 'MIN' ? 'MAX' : 'MIN';
          if (e.shiftKey && (c === other || c === 'STRETCH')) setAxis(axis, c === 'STRETCH' ? other : 'STRETCH');
          else setAxis(axis, side);
        },
      });
    };
    // Center: the whole square is one zone; the line closer to the cursor (vertical — horizontally,
    // horizontal — vertically) is highlighted and selected. Previously the horizontal line lay on
    // top of the vertical one, which was almost impossible to hit.
    const midH = h('span', { class: `cw-line cw-cv${ch === 'CENTER' ? ' on' : ''}` });
    const midV = h('span', { class: `cw-line cw-ch${cv === 'CENTER' ? ' on' : ''}` });
    const box = h('button', { class: 'cw-box', title: 'По центру: у вертикальной линии — по горизонтали, у горизонтальной — по вертикали' }, midH, midV);
    const nearest = (e: MouseEvent): 'horizontal' | 'vertical' => {
      const r = box.getBoundingClientRect();
      const dx = Math.abs(e.clientX - (r.left + r.width / 2)) / r.width;
      const dy = Math.abs(e.clientY - (r.top + r.height / 2)) / r.height;
      return dx <= dy ? 'horizontal' : 'vertical';
    };
    box.addEventListener('mousemove', (e) => {
      const axis = nearest(e);
      midH.classList.toggle('hot', axis === 'horizontal');
      midV.classList.toggle('hot', axis === 'vertical');
    });
    box.addEventListener('mouseleave', () => {
      midH.classList.remove('hot');
      midV.classList.remove('hot');
    });
    box.addEventListener('click', (e) => setAxis(e.detail === 0 ? 'horizontal' : nearest(e), 'CENTER'));
    const widget = h(
      'div',
      { class: 'constraint-widget', title: 'Привязки: щелчок — к краю или по центру, Shift — растянуть между краями' },
      box,
      edge('horizontal', 'MIN', 'cw-l', 'Слева'),
      edge('horizontal', 'MAX', 'cw-r', 'Справа'),
      edge('vertical', 'MIN', 'cw-t', 'Сверху'),
      edge('vertical', 'MAX', 'cw-b', 'Снизу'),
    );
    return h(
      'div',
      { class: 'constraints-grid' },
      h('div', { class: 'stack' },
      select('horizontal', [
        ['MIN', 'Слева'],
        ['MAX', 'Справа'],
        ['STRETCH', 'Растянуть'],
        ['CENTER', 'По центру'],
        ['SCALE', 'Масштаб'],
      ]),
      select('vertical', [
        ['MIN', 'Сверху'],
        ['MAX', 'Снизу'],
        ['STRETCH', 'Растянуть'],
        ['CENTER', 'По центру'],
        ['SCALE', 'Масштаб'],
      ]),
      ),
      widget,
    );
  }

  /** “Layout”: auto layout (toggle in the header), width and height, clipping. */
  private layoutSection(
    sel: string[],
    same: <T>(get: (id: string) => T) => T | null,
    setEach: (fn: (id: string) => Props | null) => void,
    frames: boolean,
  ): HTMLElement {
    const doc = this.ed.doc;
    const on = frames && sel.every((id) => isAutoLayout(doc, id));
    const acts = h('span', { class: 'h-acts' });
    if (frames) {
      acts.append(
        svgEl(
          'button',
          {
            class: on ? 'on' : '',
            title: on ? 'Убрать автораскладку (Alt+Shift+A)' : 'Добавить автораскладку (Shift+A)',
            onclick: () =>
              doc.transact(() => {
                for (const id of sel) {
                  if (on) doc.set(id, { layoutMode: 'NONE' });
                  else if (!isAutoLayout(doc, id)) enableAutoLayout(doc, id);
                }
              }),
          },
          ICON.autoLayout,
        ),
      );
    }
    const gear = !on
      ? null
      : svgEl('button', {
          class: this.layoutMore ? 'on' : '',
          title: 'Настройки автораскладки: версия, базовая линия текста, порядок наложения, обводка в раскладке',
          onclick: () => this.settingsToggle('layout', this.layoutMore, (on) => (this.layoutMore = on)),
        }, ICON.settings);
    if (gear) acts.prepend(gear);
    const fitIds = sel.filter((id) => ['FRAME', 'COMPONENT', 'SECTION'].includes(doc.type(id) ?? '') && !isAutoLayout(doc, id) && doc.children(id).length > 0);
    if (!on && fitIds.length === sel.length)
      acts.prepend(svgEl('button', { title: 'Подогнать размер по содержимому (Ctrl+Alt+Shift+R)', onclick: () => doc.transact(() => fitIds.forEach((id) => resizeToFit(doc, id))) }, ICON.fitContent));
    const auto = on ? this.autoLayoutControls(sel, same, setEach) : [];
    // Auto layout settings in a popup at the gear icon.
    const layoutPop = auto.filter((el) => el.dataset.more === 'layout');
    const autoRows = auto.filter((el) => el.dataset.more !== 'layout');
    const locked = sel.every((id) => doc.get(id, 'constrainProportions') === true);
    // Size from the W / H fields — with children's constraints.
    const setSize = (fn: (id: string) => Props | null) =>
      doc.transact(() => {
        for (const id of sel) {
          const p = fn(id);
          if (p) resizeWithConstraints(doc, id, p);
        }
      });
    const lock = this.iconButton(ICON.link, locked ? 'Пропорции сохраняются — снять' : 'Сохранять пропорции', () => setEach(() => ({ constrainProportions: !locked })), { on: locked });
    const size = [
      this.caption('Размеры'),
      h('div', { class: 'prow' }, this.sizeField(sel, 'width', setSize, locked), this.sizeField(sel, 'height', setSize, locked), lock),
      ...this.limitFields(sel, same, setEach),
      this.gridCellRow(sel, same, setEach),
      ...this.textResizeRows(sel, same, setEach),
    ];
    const flow = autoRows.findIndex((el) => el.classList.contains('seg')) + 1;
    if (flow) autoRows[flow - 1]!.classList.add('wide');
    const items: (HTMLElement | string)[] = [...autoRows.slice(0, flow), ...size, ...autoRows.slice(flow)];
    if (frames) {
      const clip = same((id) => doc.get(id, 'clipsContent') !== false);
      const box = h('input', { type: 'checkbox', checked: clip === true }) as HTMLInputElement;
      box.indeterminate = clip === null;
      box.addEventListener('change', () => setEach(() => ({ clipsContent: box.checked })));
      items.push(h('label', { class: 'check-row' }, box, 'Обрезать содержимое'));
    }
    if (on && this.layoutMore && gear && layoutPop.length) this.settingsPop('layout', gear, 'Настройки автораскладки', layoutPop, () => (this.layoutMore = false));
    return h('div', { class: 'section' }, h('h3', {}, on ? 'Автораскладка' : 'Раскладка', acts), h('div', { class: 'props' }, ...items));
  }

  /** Size mode of text layers: auto width, auto height, fixed; our own — “Fit”. */
  private textResizeRows(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement[] {
    const doc = this.ed.doc;
    if (!sel.length || !sel.every((id) => doc.type(id) === 'TEXT')) return [];
    const resize = same((id) => ((doc.get(id, 'textAutoResize') ?? 'WIDTH_AND_HEIGHT') === 'NONE' && doc.get(id, 'textFit') === 'SHRINK' ? 'FIT' : (doc.get(id, 'textAutoResize') ?? 'WIDTH_AND_HEIGHT')));
    const fitMin = same((id) => doc.get(id, 'textFitMinSize') ?? 6);
    const options: [string, string, string][] = [
      ['WIDTH_AND_HEIGHT', ICON.textAutoWidth, 'Авто ширина: ширина и высота по тексту'],
      ['HEIGHT', ICON.textAutoHeight, 'Авто высота: ширина задана, высота по тексту'],
      ['NONE', ICON.textFixed, 'Фиксированный размер'],
      ['FIT', ICON.textFit, 'Вписать: размер задан, текст уменьшается, пока не влезет'],
    ];
    const seg = h(
      'div',
      { class: 'seg wide text-resize', role: 'radiogroup', 'aria-label': 'Режим размера текста' },
      ...options.map(([v, icon, title]) => {
        const b = h('button', { class: v === resize ? 'on' : '', title, 'aria-label': title, role: 'radio', 'aria-checked': String(v === resize), onclick: () => setEach(() => (v === 'FIT' ? { textAutoResize: 'NONE', textFit: 'SHRINK' } : { textAutoResize: v as Props['textAutoResize'], textFit: undefined })) });
        b.innerHTML = icon;
        return b;
      }),
    );
    return [
      this.caption('Размер по тексту'),
      seg,
      ...(resize === 'FIT' ? [this.numField('Мин.', fitMin, (v) => ({ textFitMinSize: Math.max(1, v) }), setEach, false, { unit: 'px', title: 'Вписать: меньше этого кегля текст не уменьшается (дальше — обрезается)' })] : []),
    ];
  }

  /**
   * W or H field with a size mode: a number and the mode label (“hug”,
   * “fill”); modes and limits are in the field menu (arrow on the right). Typing a number or
   * scrubbing the label makes the size fixed — for text, “hug contents” frames and “fill” layers too.
   */
  private sizeField(sel: string[], axis: Axis, setEach: (fn: (id: string) => Props | null) => void, locked = false): HTMLElement {
    const doc = this.ed.doc;
    const W = axis === 'width';
    const other: Axis = W ? 'height' : 'width';
    const modes = sel.map((id) => getSizing(doc, id, axis));
    const mode = modes.every((m) => m === modes[0]) ? modes[0]! : null;
    const sizes = sel.map((id) => doc.get(id, axis) ?? 0);
    const value = sizes.every((v) => v === sizes[0]) ? sizes[0]! : null;
    const pk = percentKey(axis);
    const pcts = sel.map((id) => doc.get(id, pk));
    const percentText = mode === 'PERCENT' && pcts.every((p) => p === pcts[0]) ? `${fmt(pcts[0] ?? 0)}%` : undefined;
    const canPct = sel.every((id) => canFill(doc, id));
    const field = this.numField(
      W ? 'W' : 'H',
      value,
      (v, id) => {
        const size = Math.max(0.01, v);
        const props: Props = { ...sizingProps(doc, id, axis, 'FIXED'), [axis]: size };
        // Aspect ratio lock: the other side changes in the same ratio.
        const cur = doc.get(id, axis) ?? 0;
        if (locked && cur > 0) Object.assign(props, sizingProps(doc, id, other, 'FIXED'), { [other]: Math.round(((doc.get(id, other) ?? 0) * size) / cur * 100) / 100 });
        return props;
      },
      setEach,
      false,
      {
        title: W ? 'Ширина; «50%» — доля родителя с автораскладкой' : 'Высота; «50%» — доля родителя с автораскладкой',
        bind: { ids: sel, fields: [axis] },
        display: percentText,
        // In “% of parent” mode a drag changes the percentage (does not convert to pixels).
        scrubPercent: percentText !== undefined,
        length: true,
        onPercent: canPct
          ? (p) =>
              doc.transact(() => {
                for (const id of sel) setPercent(doc, id, axis, p);
              })
          : undefined,
      },
    );
    field.classList.add('size-field');
    // The mode label is always a separate element (empty when fixed) so the field's structure
    // doesn't change during a drag.
    field.append(h('span', { class: 'size-tag' }, mode === 'HUG' ? 'по сод.' : mode === 'FILL' ? 'заполн.' : ''));
    if (mode === 'HUG' || mode === 'FILL') field.title = `${W ? 'Ширина' : 'Высота'}: ${mode === 'HUG' ? 'по содержимому' : 'заполнить контейнер'}`;
    if (mode === 'PERCENT') field.title = `${W ? 'Ширина' : 'Высота'}: доля внутренней области родителя (сейчас ${value !== null ? fmt(value) : '—'} px)`;
    // Menu only when there is something to choose (a plain frame outside auto layout has just a number).
    const can = { hug: sel.every((id) => canHug(doc, id)), fill: sel.every((id) => canFill(doc, id)), limits: sel.every((id) => canLimit(doc, id)) };
    if (!can.hug && !can.fill && !can.limits) return field;
    const menu = svgEl('button', { class: 'size-menu', title: W ? 'Режим ширины' : 'Режим высоты' }, ICON.chevronDown);
    // The button doesn't steal focus from the field.
    menu.addEventListener('pointerdown', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      showMenu(menu, this.sizeMenu(sel, axis, mode, value, can), 'below');
    });
    field.append(menu);
    return field;
  }

  /** W/H field menu: size mode and min/max limits. */
  private sizeMenu(sel: string[], axis: Axis, mode: SizingMode | null, value: number | null, can: { hug: boolean; fill: boolean; limits: boolean }): MenuEntry[] {
    const doc = this.ed.doc;
    const W = axis === 'width';
    const apply = (m: SizingMode) =>
      doc.transact(() => {
        for (const id of sel) setSizing(doc, id, axis, m);
      });
    const { hug, fill, limits } = can;
    // Hovering a mode immediately shows what the layer will become; leaving restores it.
    const preview = (m: SizingMode) => () =>
      doc.preview(() => {
        for (const id of sel) setSizing(doc, id, axis, m);
      });
    const entries: MenuEntry[] = [
      { label: W ? 'Фиксированная ширина' : 'Фиксированная высота', hint: value !== null ? fmt(value) : '', checked: mode === 'FIXED', run: () => apply('FIXED'), preview: preview('FIXED') },
      { label: 'По содержимому', hint: hug ? '' : 'автораскладка и текст', checked: mode === 'HUG', disabled: !hug, run: () => apply('HUG'), preview: preview('HUG') },
      { label: 'Заполнить контейнер', hint: fill ? '' : 'внутри автораскладки', checked: mode === 'FILL', disabled: !fill, run: () => apply('FILL'), preview: preview('FILL') },
      {
        label: 'Процент от родителя',
        hint: fill ? 'как 50% в CSS' : 'внутри автораскладки',
        checked: mode === 'PERCENT',
        disabled: !fill,
        // Current size as a fraction of the parent (it can then be adjusted in the field: “50%”).
        run: () =>
          doc.transact(() => {
            for (const id of sel) setPercent(doc, id, axis, percentOfParent(doc, id, axis) ?? 100);
          }),
      },
      'sep',
    ];
    const [minKey, maxKey] = LIMIT_KEYS[axis];
    const what = W ? 'ширину' : 'высоту';
    for (const [key, name] of [
      [minKey, `мин. ${what}`],
      [maxKey, `макс. ${what}`],
    ] as const) {
      const has = sel.some((id) => doc.get(id, key) != null || doc.get(id, `${key}Percent` as 'minWidthPercent') != null);
      entries.push(
        has
          ? {
              label: `Убрать ${name}`,
              run: () =>
                doc.transact(() => {
                  for (const id of sel) {
                    setLimit(doc, id, key, null);
                    doc.set(id, { [`${key}Percent`]: null } as Props);
                  }
                }),
            }
          : {
              label: `Добавить ${name}`,
              hint: limits ? '' : 'автораскладка',
              disabled: !limits,
              run: () =>
                doc.transact(() => {
                  for (const id of sel) setLimit(doc, id, key, doc.get(id, axis) ?? 0);
                }),
            },
      );
    }
    return entries;
  }

  /** Min/max limit fields — only the ones set (add and remove via the W or H field menu). */
  private limitFields(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement[] {
    const doc = this.ed.doc;
    const out: HTMLElement[] = [];
    for (const axis of ['width', 'height'] as const) {
      for (const key of LIMIT_KEYS[axis]) {
        const pkey = `${key}Percent` as 'minWidthPercent';
        if (!sel.some((id) => doc.get(id, key) != null || doc.get(id, pkey) != null)) continue;
        const min = key.startsWith('min');
        // A limit as a percent of the parent — “30%” in the field (like min-width: 30% in CSS).
        const pct = same((id) => doc.get(id, pkey) ?? null);
        out.push(
          this.numField(axis === 'width' ? 'W' : 'H', pct ?? same((id) => doc.get(id, key) ?? null), (v) => ({ [key]: Math.max(0, v), [pkey]: null }) as Props, setEach, false, {
            bind: pct === null ? { ids: sel, fields: [key] } : undefined,
            unit: min ? 'мин' : 'макс',
            title: `${min ? 'Минимальная' : 'Максимальная'} ${axis === 'width' ? 'ширина' : 'высота'}: пиксели или % родителя (пусто — убрать)`,
            onEmpty: () => ({ [key]: null, [pkey]: null }) as Props,
            onPercent: (v) => doc.transact(() => sel.forEach((id) => doc.set(id, { [pkey]: Math.max(0, v), [key]: null } as Props))),
            ...(pct !== null ? { display: `${fmt(pct)}%`, scrubPercent: true } : {}),
          }),
        );
      }
    }
    return out;
  }

  private booleanSection(same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement {
    const doc = this.ed.doc;
    return h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Булева операция'),
      h(
        'div',
        { class: 'props' },
        h(
          'div',
          { class: 'wide' },
          this.segmented(
            [
              ['UNION', 'Объединить', 'Объединение (Alt+Shift+U)'],
              ['SUBTRACT', 'Вычесть', 'Вычитание из нижнего (Alt+Shift+S)'],
              ['INTERSECT', 'Пересечь', 'Пересечение (Alt+Shift+I)'],
              ['EXCLUDE', 'Исключить', 'Исключение пересечений (Alt+Shift+E)'],
            ],
            same((id) => doc.get(id, 'booleanOperation') ?? 'UNION'),
            (v) => setEach(() => ({ booleanOperation: v })),
          ),
        ),
      ),
    );
  }

  /** “View”: opacity, corner radius, blend mode, visibility. */
  private appearanceSection(
    sel: string[],
    same: <T>(get: (id: string) => T) => T | null,
    setEach: (fn: (id: string) => Props | null) => void,
    types: Set<NodeType>,
    hasRadius: boolean,
  ): HTMLElement {
    const doc = this.ed.doc;
    const visible = same((id) => doc.get(id, 'visible') !== false);
    const eye = svgEl('button', { title: visible === false ? 'Показать' : 'Скрыть', onclick: () => setEach(() => ({ visible: visible === false })) }, visible === false ? ICON.eyeOff : ICON.eye);
    // For shapes “pass through” is no different from normal — show “Normal”.
    const leaf = (id: string) => !['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'SECTION', 'BOOLEAN_OPERATION'].includes(doc.type(id)!);
    const blend = same((id) => {
      const b = (doc.get(id, 'blendMode') as string | undefined) ?? 'PASS_THROUGH';
      return b === 'PASS_THROUGH' && leaf(id) ? 'NORMAL' : b;
    });
    const blendName = BLEND_MODES.find(([v]) => v === blend)?.[1] ?? 'Разные';
    const custom = blend !== 'NORMAL' && blend !== 'PASS_THROUGH';
    const blendBtn: HTMLElement = svgEl('button', {
      class: custom ? 'on' : '',
      title: `Режим наложения: ${blendName}`,
      'aria-label': `Режим наложения: ${blendName}`,
      onclick: () => {
        const r = blendBtn.getBoundingClientRect();
        // Mode groups: normal, darken, lighten, contrast, comparison, color.
        const groups = [['PASS_THROUGH', 'NORMAL'], ['DARKEN', 'MULTIPLY', 'COLOR_BURN'], ['LIGHTEN', 'SCREEN', 'COLOR_DODGE'], ['OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT'], ['DIFFERENCE', 'EXCLUSION'], ['HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']];
        const entries: MenuEntry[] = [];
        for (const g of groups) {
          if (entries.length) entries.push('sep');
          for (const v of g) entries.push({ label: BLEND_MODES.find(([k]) => k === v)![1], checked: v === blend, run: () => setEach(() => ({ blendMode: v as Props['blendMode'] })) });
        }
        showMenuAt(r.left, r.bottom + 4, entries);
      },
    }, ICON.blend);
    const opacity = this.numField(ICON.opacity, same((id) => Math.round((doc.get(id, 'opacity') ?? 1) * 100)), (v) => ({ opacity: Math.max(0, Math.min(100, v)) / 100 }), setEach, false, { unit: '%', title: 'Непрозрачность', bind: { ids: sel, fields: ['opacity'] } });
    const radius = hasRadius ? this.radiusCell(sel, same, setEach) : null;
    const items: (HTMLElement | string)[] = [
      h('div', { class: 'prow with-labels' }, this.labeled('Непрозрачность', opacity), radius ? this.labeled('Скругление', radius.field) : h('div'), ...(radius ? [radius.toggle] : [])),
    ];
    if (custom) items.push(h('button', { class: 'blend-chip wide', title: 'Сменить режим наложения', onclick: () => blendBtn.click() }, svgEl('span', {}, ICON.blend), h('span', {}, blendName)));
    // Individual corners and smoothing — in the “Corner radius” popup.
    if (hasRadius && radius && this.cornersMore) {
      const independent = sel.some((id) => CORNERS.some((k) => doc.get(id, k) !== undefined));
      const smooth = this.numField('◠', same((id) => Math.round((doc.get(id, 'cornerSmoothing') ?? 0) * 100)), (v) => ({ cornerSmoothing: Math.max(0, Math.min(100, v)) / 100 }), setEach, false, {
        unit: '%',
        title: 'Сглаживание углов: 60% — как в iOS',
      });
      const ios = h('button', { class: 'pe-btn', title: 'Сглаживание как в iOS (60%)', onclick: () => setEach(() => ({ cornerSmoothing: 0.6 })) }, 'iOS');
      this.settingsPop('corners', radius.toggle, 'Скругление углов', [
        this.caption('Углы'),
        this.cornerFields(sel, same, setEach),
        ...(independent
          ? [h('button', { class: 'pe-btn wide', onclick: () => setEach((id) => ({ cornerRadius: doc.get(id, 'topLeftRadius') ?? doc.get(id, 'cornerRadius') ?? 0, topLeftRadius: undefined, topRightRadius: undefined, bottomRightRadius: undefined, bottomLeftRadius: undefined })) }, 'Одно скругление для всех углов')]
          : []),
        this.caption('Сглаживание'),
        h('div', { class: 'prow' }, smooth, h('div', { class: 'tight' }, ios)),
      ], () => (this.cornersMore = false));
    }
    if ([...types].every((t) => t === 'POLYGON' || t === 'STAR')) {
      items.push(this.numField('✱', same((id) => doc.get(id, 'pointCount') ?? 3), (v) => ({ pointCount: Math.max(3, Math.min(60, Math.round(v))) }), setEach, false, { title: 'Число вершин' }));
    }
    if ([...types].every((t) => t === 'STAR')) {
      items.push(this.numField('✧', same((id) => Math.round((doc.get(id, 'innerRadius') ?? 0.382) * 100)), (v) => ({ innerRadius: Math.max(0, Math.min(100, v)) / 100 }), setEach, false, { unit: '%', title: 'Доля лучей: внутренний радиус к внешнему' }));
    }
    // Ellipse arc: start, sweep, ratio (like the “Arc” handles on the canvas).
    if ([...types].every((t) => t === 'ELLIPSE')) {
      const TAU = Math.PI * 2;
      const arcOf = (id: string) => doc.get(id, 'arcData') ?? { startingAngle: 0, endingAngle: TAU, innerRadius: 0 };
      const sweepOf = (x: { startingAngle: number; endingAngle: number }) => {
        const v = (((x.endingAngle - x.startingAngle) % TAU) + TAU) % TAU;
        return v < 1e-6 ? TAU : v;
      };
      const deg = (r: number) => Math.round(((((r * 180) / Math.PI) % 360) + 360) % 360);
      items.push(
        this.numField('∠', same((id) => deg(arcOf(id).startingAngle)), (v, id) => {
          const x = arcOf(id);
          const st = (v * Math.PI) / 180;
          return { arcData: { ...x, startingAngle: st, endingAngle: st + sweepOf(x) } };
        }, setEach, false, { unit: '°', title: 'Начало дуги' }),
        this.numField('◔', same((id) => Math.round((sweepOf(arcOf(id)) / TAU) * 1000) / 10), (v, id) => {
          const x = arcOf(id);
          return { arcData: { ...x, endingAngle: x.startingAngle + (Math.max(0.1, Math.min(100, v)) / 100) * TAU } };
        }, setEach, false, { unit: '%', title: 'Охват дуги' }),
        this.numField('◎', same((id) => Math.round(arcOf(id).innerRadius * 100)), (v, id) => ({ arcData: { ...arcOf(id), innerRadius: Math.max(0, Math.min(100, v)) / 100 } }), setEach, false, { unit: '%', title: 'Отверстие: доля внутреннего радиуса' }),
      );
    }
    // Mask: by alpha, by vector or by luminance.
    if (sel.every((id) => doc.get(id, 'isMask') === true)) {
      const mt = same((id) => doc.get(id, 'maskType') ?? 'ALPHA');
      items.push(
        h(
          'div',
          { class: 'seg wide', title: 'Чем маска закрывает слои над ней' },
          ...(
            [
              ['ALPHA', 'Прозрачность', 'Маска по прозрачности слоя'],
              ['VECTOR', 'Форма', 'Маска по форме (заливка не важна)'],
              ['LUMINANCE', 'Яркость', 'Маска по яркости: белое видно, чёрное скрыто'],
            ] as const
          ).map(([v, label, title]) => h('button', { class: mt === v ? 'on' : '', title, onclick: () => setEach(() => ({ maskType: v })) }, label)),
        ),
      );
    }
    // Variable collection modes (if collections have more than one mode).
    const modes = sel.some((id) => doc.type(id) === 'STYLE') ? [] : modeRows(this.ed, sel);
    if (modes.length) items.push(h('div', { class: 'wide comp-props props-inner' }, ...modes));
    return h('div', { class: 'section' }, h('h3', {}, 'Вид', h('span', { class: 'h-acts' }, eye, blendBtn)), h('div', { class: 'props' }, ...items));
  }

  /** Corner radius: a shared field and the “individual corners” button. */
  private radiusCell(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): { field: HTMLElement; toggle: HTMLElement } {
    const doc = this.ed.doc;
    const independent = sel.some((id) => CORNERS.some((k) => doc.get(id, k) !== undefined));
    // Shared value: if corners differ — “Mixed”; input sets one radius for all corners.
    const value = same((id) => {
      const r = doc.get(id, 'cornerRadius') ?? 0;
      const v = CORNERS.map((k) => doc.get(id, k) ?? r);
      return v.every((x) => x === v[0]) ? v[0]! : null;
    });
    const field = this.numField(ICON.corner, value === null || value === undefined ? null : value, (v) => ({ cornerRadius: Math.max(0, v), topLeftRadius: undefined, topRightRadius: undefined, bottomRightRadius: undefined, bottomLeftRadius: undefined }), setEach, false, { title: 'Скругление углов', bind: { ids: sel, fields: ['cornerRadius'] }, length: true });
    const smoothed = sel.some((id) => (doc.get(id, 'cornerSmoothing') ?? 0) > 0);
    const toggle = this.iconButton(
      ICON.corners,
      'Скругление углов: по отдельности и сглаживание',
      () => this.settingsToggle('corners', this.cornersMore, (on) => (this.cornersMore = on)),
      { on: independent || smoothed || this.cornersMore },
    );
    return { field, toggle };
  }

  /** Four corner radius fields: top left, top right, bottom right, bottom left. */
  private cornerFields(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement {
    const doc = this.ed.doc;
    const labels = ['↖', '↗', '↘', '↙'];
    const titles = ['Левый верхний угол', 'Правый верхний угол', 'Правый нижний угол', 'Левый нижний угол'];
    return h(
      'div',
      { class: 'corner-fields' },
      ...CORNERS.map((k, i) =>
        this.numField(labels[i]!, same((id) => doc.get(id, k) ?? doc.get(id, 'cornerRadius') ?? 0), (v) => ({ [k]: Math.max(0, v) }) as Props, setEach, false, { title: titles[i], bind: { ids: sel, fields: [k] } }),
      ),
    );
  }

  /** Shadow blend mode. */
  private shadowBlend(value: BlendMode, set: (b: BlendMode) => void): HTMLElement {
    const select = h('select', {}, ...PAINT_BLENDS.map(([v, label]) => h('option', { value: v, selected: v === (value === 'PASS_THROUGH' ? 'NORMAL' : value) }, label))) as HTMLSelectElement;
    select.addEventListener('change', () => set(select.value as BlendMode));
    return h('div', { class: 'field wide', title: 'Режим наложения тени' }, svgEl('label', {}, ICON.blend), select);
  }

  /** “Layout grid”: columns, rows, grid. */
  private layoutGridSection(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement {
    const doc = this.ed.doc;
    const grids = same((id) => doc.get(id, 'layoutGrids') ?? []);
    const DEFAULT: Record<LayoutGrid['pattern'], LayoutGrid> = {
      GRID: { pattern: 'GRID', sectionSize: 10, visible: true },
      COLUMNS: { pattern: 'COLUMNS', alignment: 'STRETCH', count: 5, gutterSize: 20, offset: 0, visible: true },
      ROWS: { pattern: 'ROWS', alignment: 'STRETCH', count: 5, gutterSize: 20, offset: 0, visible: true },
    };
    const add = svgEl(
      'button',
      { title: 'Добавить направляющие макета', onclick: () => setEach((id) => ({ layoutGrids: [...(grids === null ? [] : (doc.get(id, 'layoutGrids') ?? [])), DEFAULT.GRID] })) },
      ICON.plus,
    );
    const header = h('h3', {}, 'Направляющие макета', h('span', { class: 'h-acts' }, add));
    if (grids === null) return h('div', { class: 'section' }, header, h('div', { class: 'empty' }, 'Разные — «+» заменит их одной'));
    if (!grids.length) return h('div', { class: 'section' }, header);
    const update = (i: number, patch: (g: LayoutGrid) => LayoutGrid | null) =>
      setEach((id) => {
        const list = [...(doc.get(id, 'layoutGrids') ?? [])];
        const next = list[i] ? patch(list[i]!) : null;
        if (next) list[i] = next;
        else list.splice(i, 1);
        return { layoutGrids: list };
      });
    const rows = grids.map((g, i) => {
      const kind = h('select', { title: 'Вид' }, ...(['GRID', 'COLUMNS', 'ROWS'] as const).map((p) => h('option', { value: p, selected: p === g.pattern }, p === 'GRID' ? 'Квадратная сетка' : p === 'COLUMNS' ? 'Колонки' : 'Строки'))) as HTMLSelectElement;
      kind.addEventListener('change', () => update(i, (old) => ({ ...DEFAULT[kind.value as LayoutGrid['pattern']], visible: old.visible, ...(old.color ? { color: old.color } : {}) })));
      const main =
        g.pattern === 'GRID'
          ? this.numField('◫', g.sectionSize, (v, id) => ({ layoutGrids: replace(doc.get(id, 'layoutGrids') ?? [], i, { ...g, sectionSize: Math.max(1, v) }) }), setEach, false, { title: 'Размер ячейки' })
          : this.numField('#', g.count, (v, id) => ({ layoutGrids: replace(doc.get(id, 'layoutGrids') ?? [], i, { ...g, count: Math.max(1, Math.round(v)) }) }), setEach, false, { title: g.pattern === 'COLUMNS' ? 'Число колонок' : 'Число строк' });
      const eye = this.iconButton(g.visible === false ? ICON.eyeOff : ICON.eye, g.visible === false ? 'Показать' : 'Скрыть', () => update(i, (old) => ({ ...old, visible: old.visible === false })));
      const remove = this.iconButton(ICON.minus, 'Убрать', () => update(i, () => null));
      // Row: parameters (popup) · type · eye · “−”.
      const open = this.guideOpen === i;
      const gear = this.iconButton(ICON.settings, 'Параметры направляющих', () => this.settingsToggle(`guide:${i}`, open, (on) => (this.guideOpen = on ? i : null)), { on: open });
      const line = h('div', { class: 'prow' }, gear, h('div', { class: 'field', style: 'flex: 1' }, kind), eye, remove);
      const pop = (rows: HTMLElement[]) => {
        if (open) this.settingsPop(`guide:${i}`, gear, g.pattern === 'GRID' ? 'Квадратная сетка' : g.pattern === 'COLUMNS' ? 'Колонки' : 'Строки', rows, () => this.guideOpen === i && (this.guideOpen = null));
        return [line];
      };
      if (g.pattern === 'GRID') return pop([h('div', { class: 'prow' }, main, h('span'))]);
      const cols = g.pattern === 'COLUMNS';
      const alignSel = h(
        'select',
        { title: 'Выравнивание' },
        ...(['STRETCH', 'MIN', 'CENTER', 'MAX'] as const).map((a) => h('option', { value: a, selected: a === g.alignment }, a === 'STRETCH' ? 'Растянуть' : a === 'CENTER' ? 'По центру' : a === 'MIN' ? (cols ? 'Слева' : 'Сверху') : cols ? 'Справа' : 'Снизу')),
      ) as HTMLSelectElement;
      alignSel.addEventListener('change', () =>
        update(i, (old) => (old.pattern === 'GRID' ? old : { ...old, alignment: alignSel.value as 'STRETCH', sectionSize: old.sectionSize || 60 })),
      );
      const field = (label: string, key: 'gutterSize' | 'offset' | 'sectionSize', title: string) =>
        this.numField(label, (g as Record<string, unknown>)[key] as number ?? 0, (v, id) => ({ layoutGrids: replace(doc.get(id, 'layoutGrids') ?? [], i, { ...g, [key]: Math.max(0, v) } as LayoutGrid) }), setEach, false, { title });
      const extra = h(
        'div',
        { class: 'grid-extra' },
        h('div', { class: 'field' }, alignSel),
        field('⇹', 'gutterSize', 'Промежуток'),
        field(cols ? '⇤' : '⤒', 'offset', g.alignment === 'STRETCH' ? 'Поля' : 'Отступ'),
        g.alignment === 'STRETCH' ? h('span') : field(cols ? 'W' : 'H', 'sectionSize', cols ? 'Ширина колонки' : 'Высота строки'),
      );
      return pop([h('div', { class: 'prow' }, main, h('span')), extra]);
    });
    return h('div', { class: 'section' }, header, h('div', { class: 'props' }, ...rows.flat()));
  }

  // ---------- Auto layout ----------

  private segmented<V extends string>(options: [V, string, string][], current: V | null, pick: (v: V) => void) {
    return h(
      'div',
      { class: 'seg' },
      ...options.map(([v, label, title]) => {
        const b = h('button', { class: v === current ? 'on' : '', title, onclick: () => pick(v) });
        b.innerHTML = label;
        return b;
      }),
    );
  }

  private autoLayoutControls(
    sel: string[],
    same: <T>(get: (id: string) => T) => T | null,
    setEach: (fn: (id: string) => Props | null) => void,
  ): HTMLElement[] {
    const doc = this.ed.doc;
    const mode = same((id) => doc.get(id, 'layoutMode')!);
    const horizontal = mode === 'HORIZONTAL';
    const wrap = same((id) => doc.get(id, 'layoutWrap') ?? 'NO_WRAP');
    const primary = same((id) => doc.get(id, 'primaryAxisAlignItems') ?? 'MIN');
    const counter = same((id) => doc.get(id, 'counterAxisAlignItems') ?? 'MIN');
    // 3×3 alignment grid: columns horizontally, rows vertically.
    const A = ['MIN', 'CENTER', 'MAX'] as const;
    const grid = h('div', { class: 'align-grid', title: 'Выравнивание' });
    for (const row of A)
      for (const col of A) {
        const [p, c] = horizontal ? [col, row] : [row, col];
        const auto = primary === 'SPACE_BETWEEN' || primary === 'SPACE_AROUND' || primary === 'SPACE_EVENLY';
        // Baseline — like the top row (cross axis — from the top of the row).
        const active = (primary === p || (auto && p === 'MIN')) && (counter === c || (counter === 'BASELINE' && c === 'MIN'));
        // With auto spacing the grid sets only cross-axis alignment.
        grid.append(
          h('button', {
            class: active ? 'on' : '',
            onclick: () =>
              setEach((id) => {
                const cur = doc.get(id, 'primaryAxisAlignItems') ?? 'MIN';
                const keep = cur === 'SPACE_BETWEEN' || cur === 'SPACE_AROUND' || cur === 'SPACE_EVENLY';
                return keep ? { counterAxisAlignItems: c } : { primaryAxisAlignItems: p, counterAxisAlignItems: c };
              }),
          }),
        );
      }
    const padH = same((id) => (doc.get(id, 'paddingLeft') === doc.get(id, 'paddingRight') ? (doc.get(id, 'paddingLeft') ?? 0) : null));
    const padV = same((id) => (doc.get(id, 'paddingTop') === doc.get(id, 'paddingBottom') ? (doc.get(id, 'paddingTop') ?? 0) : null));
    const version = same((id) => doc.get(id, 'layoutVersion') ?? 'LEGACY');
    const versionSelect = h('select', { 'aria-label': 'Версия автораскладки', title: 'Latest: поля и внутренние обводки занимают место; единственный слой с авто-промежутком прижат к началу' },
      ...(version === null ? [h('option', { value: '', selected: true, disabled: true }, 'Разные версии')] : []),
      ...(['LEGACY', 'LATEST'] as const).map((v) => h('option', { value: v, selected: v === version }, v === 'LATEST' ? 'Latest' : 'Legacy')),
    ) as HTMLSelectElement;
    versionSelect.disabled = sel.some((id) => doc.type(id) === 'INSTANCE');
    versionSelect.onchange = () => setEach(() => ({ layoutVersion: versionSelect.value as 'LEGACY' | 'LATEST' }));
    return [
        ...(mode === 'GRID' || !this.layoutMore ? [] : [h('label', { class: 'prow', 'data-more': 'layout' }, h('span', {}, 'Версия раскладки'), h('div', { class: 'field' }, versionSelect))]),
        this.segmented(
          [
            ['VERTICAL', ICON.arrowDown, 'В столбец'],
            ['HORIZONTAL', ICON.arrowRight, 'В строку'],
            ['WRAP', ICON.wrap, 'В строку с переносом'],
            ['VWRAP', ICON.wrapV, 'В столбец с переносом (нужна фиксированная высота)'],
            ['GRID', ICON.tidy, 'Сеткой: строки и колонки'],
          ],
          mode === 'GRID' ? 'GRID' : wrap === 'WRAP' ? (mode === 'VERTICAL' ? 'VWRAP' : 'WRAP') : mode,
          (v) =>
            setEach((id) =>
              v === 'GRID'
                ? this.toGrid(id)
                : v === 'WRAP'
                  ? { layoutMode: 'HORIZONTAL', layoutWrap: 'WRAP' }
                  : v === 'VWRAP'
                    ? { layoutMode: 'VERTICAL', layoutWrap: 'WRAP', primaryAxisSizingMode: 'FIXED' }
                    : { layoutMode: v, layoutWrap: 'NO_WRAP' },
            ),
        ),
        ...(mode === 'GRID' ? this.gridControls(sel, same, setEach) : [this.labeled('Выравнивание', grid), this.labeled('Промежуток', h('div', { class: 'stack' }, ...this.gapControls(sel, same, setEach, primary, wrap === 'WRAP')))]),
        this.caption('Отступы'),
        ...this.paddingRows(sel, same, setEach, padH, padV),
        ...(horizontal && this.layoutMore
          ? [
              this.moreRow(this.checkRow(counter === 'BASELINE' ? true : counter === null ? null : false, 'По базовой линии текста', 'Слои строки — по базовой линии первой строки текста (у фреймов — их первого текста, у фигур — по низу)', (on) =>
                setEach(() => ({ counterAxisAlignItems: on ? 'BASELINE' : 'MIN' })),
              )),
            ]
          : []),
        ...(this.layoutMore
          ? [
              this.moreRow(this.checkRow(same((id) => doc.get(id, 'itemReverseZIndex') === true), 'Первый слой сверху', 'Порядок наложения: первый слой потока — поверх остальных', (on) => setEach(() => ({ itemReverseZIndex: on })))),
              this.moreRow(this.checkRow(same((id) => doc.get(id, 'strokesIncludedInLayout') ?? (doc.get(id, 'layoutVersion') === 'LATEST')), 'Обводка в раскладке', 'Latest: только внутренняя обводка этого фрейма. Legacy: учитываются выступающие обводки детей.', (on) => setEach(() => ({ strokesIncludedInLayout: on })))),
            ]
          : []),
    ];
  }

  /** Row of the auto layout settings popup. */
  private moreRow(el: HTMLElement): HTMLElement {
    el.dataset.more = 'layout';
    return el;
  }

  /** Turn on grid: columns by the number of layers (up to three), as many rows as needed by content. */
  private toGrid(id: string): Props {
    const doc = this.ed.doc;
    const n = doc.children(id).filter((k) => doc.get(k, 'visible') !== false && doc.get(k, 'layoutPositioning') !== 'ABSOLUTE').length;
    const cols = Math.max(1, Math.min(3, n));
    const rows = Math.max(1, Math.ceil(n / cols));
    const gap = Math.max(0, doc.get(id, 'itemSpacing') ?? 0) || 10;
    return {
      layoutMode: 'GRID',
      layoutWrap: 'NO_WRAP',
      gridColumnSizes: Array.from({ length: cols }, () => ({ type: 'FLEX', value: 1 })),
      gridRowSizes: Array.from({ length: rows }, () => ({ type: 'HUG' })),
      gridColumnGap: gap,
      gridRowGap: gap,
    };
  }

  /** Grid: number of columns and rows, track type (fractions, fixed, hug), gaps. */
  private gridControls(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement[] {
    const doc = this.ed.doc;
    const tracks = (key: 'gridColumnSizes' | 'gridRowSizes', label: string, title: string) => {
      const list = same((id) => doc.get(id, key) ?? []);
      const count = list ? Math.max(1, list.length) : null;
      const kind = list ? (list.every((t) => t.type === list[0]?.type) ? (list[0]?.type ?? 'FLEX') : 'MIXED') : 'MIXED';
      const resize = (n: number, type?: GridTrackSize['type']) => (id: string) => {
        const cur = doc.get(id, key) ?? [];
        const t = type ?? cur[0]?.type ?? 'FLEX';
        const proto: GridTrackSize = t === 'FIXED' ? { type: 'FIXED', value: cur.find((x) => x.type === 'FIXED')?.value ?? 100 } : t === 'HUG' ? { type: 'HUG' } : { type: 'FLEX', value: 1 };
        return { [key]: Array.from({ length: Math.max(1, Math.min(48, n)) }, (_, i) => (type ? proto : (cur[i] ?? proto))) } as Props;
      };
      const select = h(
        'select',
        { title: 'Размер дорожек' },
        ...(
          [
            ['FLEX', 'Доли'],
            ['FIXED', 'Фикс'],
            ['HUG', 'По содерж.'],
          ] as const
        ).map(([v, l]) => h('option', { value: v, selected: v === kind }, l)),
      ) as HTMLSelectElement;
      if (kind === 'MIXED') select.prepend(h('option', { value: '', selected: true, disabled: true }, 'Разные'));
      select.addEventListener('change', () => setEach((id) => resize((doc.get(id, key) ?? []).length || 1, select.value as GridTrackSize['type'])(id)));
      const row = h(
        'div',
        { class: 'prow' },
        this.numField(label, count, (v, id) => resize(Math.round(v))(id), setEach, false, { title }),
        h('div', { class: 'field' }, select),
      );
      // Fixed tracks — their size.
      if (kind === 'FIXED') {
        const v = same((id) => (doc.get(id, key) ?? [])[0]?.value ?? 100);
        row.append(this.numField('px', v, (x, id) => ({ [key]: (doc.get(id, key) ?? []).map(() => ({ type: 'FIXED', value: Math.max(1, x) })) }) as Props, setEach, false, { title: 'Размер дорожки' }));
      }
      // Tracks one by one (for a single layer): “1fr” — fractions, a number — px, “hug” — by content.
      if (sel.length !== 1 || !list || list.length < 2 || list.length > 12) return row;
      const text = (t: GridTrackSize) => (t.type === 'FLEX' ? `${fmt(t.value ?? 1)}fr` : t.type === 'HUG' ? 'hug' : fmt(t.value ?? 100));
      const parse = (v: string): GridTrackSize | null => {
        const t = v.trim().toLowerCase().replace(',', '.');
        if (t === 'hug' || t === 'авто' || t === 'auto' || t.startsWith('по')) return { type: 'HUG' };
        const fr = t.match(/^(\d+(?:\.\d+)?)\s*(fr|д)$/);
        if (fr) return { type: 'FLEX', value: Math.max(0.01, Number(fr[1])) };
        const px = Number(t.replace(/px$/, ''));
        return Number.isFinite(px) && px > 0 ? { type: 'FIXED', value: px } : null;
      };
      const chips = h(
        'div',
        { class: 'track-row', title: `${title} по одной: 1fr — доли, число — px, hug — по содержимому` },
        ...list.map((t, i) => {
          const input = h('input', { class: 'track', value: text(t) }) as HTMLInputElement;
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') input.blur();
          });
          input.addEventListener('change', () => {
            const next = parse(input.value);
            if (!next) return this.schedule();
            setEach((id) => ({ [key]: (doc.get(id, key) ?? []).map((x, k) => (k === i ? next : x)) }) as Props);
          });
          return input;
        }),
      );
      return h('div', { class: 'stack wide' }, row, chips);
    };
    return [
      tracks('gridColumnSizes', '║', 'Колонки'),
      tracks('gridRowSizes', '═', 'Строки'),
      h(
        'div',
        { class: 'prow' },
        this.numField(ICON.gap, same((id) => doc.get(id, 'gridColumnGap') ?? 0), (v) => ({ gridColumnGap: Math.max(0, v) }), setEach, false, { bind: { ids: sel, fields: ['gridColumnGap'] }, title: 'Промежуток между колонками' }),
        this.numField(ICON.gapRows, same((id) => doc.get(id, 'gridRowGap') ?? 0), (v) => ({ gridRowGap: Math.max(0, v) }), setEach, false, { bind: { ids: sel, fields: ['gridRowGap'] }, title: 'Промежуток между строками' }),
      ),
    ];
  }

  /** A layer's grid cell: row and column (1-based), how many it spans. */
  private gridCellRow(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement | string {
    const doc = this.ed.doc;
    const parents = new Set(sel.map((id) => doc.parent(id)));
    if (parents.size !== 1) return '';
    const parent = [...parents][0]!;
    if (!parent || doc.get(parent, 'layoutMode') !== 'GRID' || sel.some((id) => doc.get(id, 'layoutPositioning') === 'ABSOLUTE')) return '';
    // Where the layer is now (including one placed by order).
    const res = gridLayout(doc, parent);
    const kids = doc.children(parent);
    const cell = (id: string) => res?.cells[kids.indexOf(id)] ?? null;
    const anchor = (id: string, key: 'gridRowAnchorIndex' | 'gridColumnAnchorIndex', axis: 'row' | 'column') => {
      const a = doc.get(id, key) ?? -1;
      return (a >= 0 ? a : (cell(id)?.[axis] ?? 0)) + 1;
    };
    return h(
      'div',
      { class: 'grid-extra' },
      this.numField('↓', same((id) => anchor(id, 'gridRowAnchorIndex', 'row')), (v) => ({ gridRowAnchorIndex: Math.max(0, Math.round(v) - 1) }), setEach, false, { title: 'Строка (с единицы)' }),
      this.numField('→', same((id) => anchor(id, 'gridColumnAnchorIndex', 'column')), (v) => ({ gridColumnAnchorIndex: Math.max(0, Math.round(v) - 1) }), setEach, false, { title: 'Колонка (с единицы)' }),
      this.numField('⇕', same((id) => doc.get(id, 'gridRowSpan') ?? 1), (v) => ({ gridRowSpan: Math.max(1, Math.round(v)) }), setEach, false, { title: 'Занимает строк' }),
      this.numField('⇔', same((id) => doc.get(id, 'gridColumnSpan') ?? 1), (v) => ({ gridColumnSpan: Math.max(1, Math.round(v)) }), setEach, false, { title: 'Занимает колонок' }),
    );
  }

  /** Gap: a number or auto (between, around, evenly); when wrapping — between rows too. */
  private gapControls(
    sel: string[],
    same: <T>(get: (id: string) => T) => T | null,
    setEach: (fn: (id: string) => Props | null) => void,
    primary: string | null,
    wrap: boolean,
  ): HTMLElement[] {
    const doc = this.ed.doc;
    const auto = primary === 'SPACE_BETWEEN' || primary === 'SPACE_AROUND' || primary === 'SPACE_EVENLY';
    const modeSel = h(
      'select',
      { title: 'Промежуток' },
      ...(
        [
          ['FIXED', 'Число'],
          ['SPACE_BETWEEN', 'Авто: между'],
          ['SPACE_AROUND', 'Авто: вокруг'],
          ['SPACE_EVENLY', 'Авто: равномерно'],
        ] as const
      ).map(([v, label]) => h('option', { value: v, selected: v === (auto ? primary : 'FIXED') }, label)),
    ) as HTMLSelectElement;
    if (primary === null) modeSel.prepend(h('option', { value: '', selected: true, disabled: true }, 'Разные'));
    modeSel.addEventListener('change', () => setEach(() => ({ primaryAxisAlignItems: modeSel.value === 'FIXED' ? 'MIN' : (modeSel.value as 'SPACE_BETWEEN') })));
    const out: HTMLElement[] = [
      auto
        ? h('div', { class: 'field' }, svgEl('label', {}, ICON.gap), modeSel)
        : h(
            'div',
            { class: 'gap-row' },
            this.numField(ICON.gap, same((id) => doc.get(id, 'itemSpacing') ?? 0), (v) => ({ itemSpacing: v }), setEach, false, { title: 'Промежуток между слоями', bind: { ids: sel, fields: ['itemSpacing'] } }),
            h('div', { class: 'field' }, modeSel),
          ),
    ];
    if (wrap) {
      out.push(
        this.numField(ICON.gapRows, same((id) => doc.get(id, 'counterAxisSpacing') ?? doc.get(id, 'itemSpacing') ?? 0), (v) => ({ counterAxisSpacing: v }), setEach, false, { bind: { ids: sel, fields: ['counterAxisSpacing'] }, title: 'Промежуток между строками переноса' }),
      );
    }
    return out;
  }

  /** Full-width section checkbox (null — differs across the selection). */
  private checkRow(value: boolean | null, label: string, title: string, set: (on: boolean) => void): HTMLElement {
    const box = h('input', { type: 'checkbox', checked: value === true }) as HTMLInputElement;
    box.indeterminate = value === null;
    box.addEventListener('change', () => set(box.checked));
    return h('label', { class: 'check-row', title }, box, label);
  }

  /** Auto layout padding: two pairs (horizontal and vertical) or four sides. */
  private paddingRows(
    sel: string[],
    same: <T>(get: (id: string) => T) => T | null,
    setEach: (fn: (id: string) => Props | null) => void,
    padH: number | null,
    padV: number | null,
  ): HTMLElement[] {
    const doc = this.ed.doc;
    // Asymmetric padding is shown per side right away.
    const sides = this.paddingSides || (padH === null && sel.length === 1) || (padV === null && sel.length === 1);
    const toggle = this.iconButton(
      ICON.paddingSides,
      sides ? 'Отступы парами' : 'Отступы по сторонам',
      () => {
        this.paddingSides = !sides;
        this.schedule();
      },
      { on: sides },
    );
    if (!sides) {
      return [
        h(
          'div',
          { class: 'prow' },
          this.numField(ICON.paddingH, padH, (v) => ({ paddingLeft: Math.max(0, v), paddingRight: Math.max(0, v) }), setEach, false, { title: 'Отступы слева и справа', bind: { ids: sel, fields: ['paddingLeft', 'paddingRight'] } }),
          this.numField(ICON.paddingV, padV, (v) => ({ paddingTop: Math.max(0, v), paddingBottom: Math.max(0, v) }), setEach, false, { title: 'Отступы сверху и снизу', bind: { ids: sel, fields: ['paddingTop', 'paddingBottom'] } }),
          toggle,
        ),
      ];
    }
    const side = (key: 'paddingLeft' | 'paddingTop' | 'paddingRight' | 'paddingBottom', label: string, title: string) =>
      this.numField(label, same((id) => doc.get(id, key) ?? 0), (v) => ({ [key]: Math.max(0, v) }) as Props, setEach, false, { title, bind: { ids: sel, fields: [key] } });
    return [
      h('div', { class: 'prow' }, side('paddingLeft', '⇤', 'Отступ слева'), side('paddingTop', '⤒', 'Отступ сверху'), toggle),
      h('div', { class: 'prow' }, side('paddingRight', '⇥', 'Отступ справа'), side('paddingBottom', '⤓', 'Отступ снизу'), h('span', { class: 'tight' })),
    ];
  }

  private effectsSection(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement {
    const doc = this.ed.doc;
    const effects = same((id) => doc.get(id, 'effects') ?? []);
    const selKey = sel.join(',');
    if (this.effectsOpenFor !== selKey) {
      this.effectsOpenFor = selKey;
      this.effectsOpen.clear();
      if (this.effectPop) this.effectPop.close();
    }
    const openPop = (i: number, anchor: HTMLElement) => {
      if (this.effectPop?.index === i && this.effectPop.key === selKey && this.effectPop.box.isConnected) {
        this.effectPop.close();
        return;
      }
      const pop = popover(anchor, 'fx-pop', { width: 240, onClose: () => {
        if (this.effectPop?.box === pop.box) this.effectPop = null;
        this.schedule();
      } });
      this.effectPop = { index: i, key: selKey, box: pop.box, close: pop.close };
      this.schedule();
    };
    // A new effect opens with its parameters right away.
    const add = svgEl('button', {
      title: 'Добавить тень',
      onclick: () => {
        this.effectsOpen.add(effects?.length ?? 0);
        setEach((id) => ({ effects: [...(doc.get(id, 'effects') ?? []), defaultEffect('DROP_SHADOW')] }));
      },
    }, ICON.plus);
    // Shadows from a composite “Shadows” variable (our own): replaces the layer's shadows; blur and the rest stay.
    const shadowIds = sel.filter((id) => doc.type(id) !== 'STYLE');
    const boundShadows = shadowIds.length === sel.length ? boundOf(doc, shadowIds, ['shadows']) : null;
    const pickShadows = (anchor: HTMLElement) =>
      openVariablePicker(this.ed, anchor, { types: ['SHADOW'], field: 'shadows', nodeId: sel[0], current: boundShadows, onPick: (v) => bindFields(this.ed, shadowIds, ['shadows'], v), onOpenWindow: () => openVariablesWindow(this.ed) });
    const shadowVar = shadowIds.length === sel.length && !boundShadows ? (svgEl('button', { class: 'hover-act', title: 'Тени из переменной' }, ICON.variable) as HTMLButtonElement) : null;
    shadowVar?.addEventListener('click', () => pickShadows(shadowVar));
    const header = h('h3', {}, 'Эффекты', h('span', { class: 'h-acts' }, ...(shadowVar ? [shadowVar] : []), add));
    const shadowPill = boundShadows ? h('div', { class: 'wide var-field' }, variablePill(this.ed, boundShadows, { nodeId: sel[0], onPick: pickShadows, onDetach: () => bindFields(this.ed, shadowIds, ['shadows'], null) })) : null;
    if (effects === null) {
      const clear = h('button', { class: 'export-btn', onclick: () => setEach(() => ({ effects: [] })) }, 'Разные эффекты — убрать все');
      return h('div', { class: 'section' }, header, h('div', { class: 'props' }, ...(shadowPill ? [shadowPill] : []), h('div', { class: 'wide' }, clear)));
    }
    // Change the i-th effect on all selected layers (they have the same set).
    const update = (i: number, fn: (e: Effect) => Effect | null) =>
      setEach((id) => {
        const list = [...(doc.get(id, 'effects') ?? [])];
        const next = fn(list[i]!);
        if (next) list[i] = next;
        else list.splice(i, 1);
        return { effects: list };
      });
    const rows = effects.map((e, i) => {
      const type = h('select', {}, ...EFFECT_TYPES.map(([v, label]) => h('option', { value: v, selected: v === e.type }, label))) as HTMLSelectElement;
      if (e.type === 'UNSUPPORTED_FIGMA') {
        type.prepend(h('option', { value: e.type, selected: true, disabled: true }, `Figma: ${e.originalType}`));
      }
      type.addEventListener('change', () =>
        update(i, (old) => {
          const next = defaultEffect(type.value as Effect['type']);
          if ('radius' in next) next.radius = effectRadius(old);
          next.visible = old.visible;
          return next;
        }),
      );
      // Effect row: [parameters · type] eye minus; parameters under the row via a button.
      // Parameters open in a popup on the left; a new effect opens it right away.
      const open = this.effectPop?.index === i && this.effectPop.key === selKey && this.effectPop.box.isConnected;
      const toggle: HTMLButtonElement = this.iconButton(ICON.effects, 'Параметры эффекта', () => openPop(i, toggle), { on: open });
      if (this.effectsOpen.has(i)) {
        this.effectsOpen.delete(i);
        requestAnimationFrame(() => toggle.isConnected && openPop(i, toggle));
      }
      const eye = this.iconButton(e.visible ? ICON.eye : ICON.eyeOff, e.visible ? 'Скрыть' : 'Показать', () => update(i, (old) => ({ ...old, visible: !old.visible })));
      const remove = this.iconButton(ICON.minus, 'Убрать', () => {
        this.effectsOpen.clear();
        this.effectPop?.close();
        update(i, () => null);
      });
      const head = h('div', { class: 'paint-row effect-row' }, h('div', { class: 'field effect-head' }, toggle, type), eye, remove);
      if (e.type === 'UNSUPPORTED_FIGMA') return [head, h('div', { class: 'wide' }, 'Эффект сохранён, но пока не отображается. Смена типа заменит исходные данные.')];
      if (e.type === 'SHADER') {
        const key = `shader-effect:${i}:${sel.join(',')}`;
        const paint = { ...e, type: 'SHADER' as const };
        refreshEditor(key, paint);
        const name = SHADER_EFFECT_PRESETS.find((p) => p.code === e.code)?.name ?? 'Свой код';
        const edit = h('button', { class: 'export-btn', title: 'Параметры шейдерного эффекта' }, name + '…');
        edit.addEventListener('click', () => openPaintEditor({
          key, anchor: edit, paint, shaderKind: 'effect',
          onChange: (next) => {
            if (next.type !== 'SHADER') return;
            update(i, (old) => old.type === 'SHADER' ? { ...old, code: next.code, params: next.params, preset: next.preset, animate: next.animate } : old);
          },
          onStart: () => doc.beginGroup(), onEnd: () => doc.endGroup(),
          docColors: this.docColors(), pickImage: async () => null,
          shaderError: (code) => this.ed.shaderError(code, 'effect'),
        }));
        return [head, h('div', { class: 'wide' }, edit)];
      }
      // Number field of the i-th effect: label scrubbing, arrows and input — like the other fields.
      const num = (label: string, title: string, value: number, apply: (e: Effect, v: number) => Effect) => {
        const f = this.numField(
          label,
          value,
          (v, id) => {
            const list = [...(doc.get(id, 'effects') ?? [])];
            if (!list[i]) return null;
            list[i] = apply(list[i]!, v);
            return { effects: list };
          },
          setEach,
        );
        f.title = title;
        return f;
      };
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        const sh = e;
        return [
          head,
          this.caption('Смещение'),
          num('X', 'Смещение по X', sh.offset.x, (o, v) => ({ ...(o as typeof sh), offset: { ...(o as typeof sh).offset, x: v } })),
          num('Y', 'Смещение по Y', sh.offset.y, (o, v) => ({ ...(o as typeof sh), offset: { ...(o as typeof sh).offset, y: v } })),
          this.labeled('Размытие', num('◌', 'Размытие', sh.radius, (o, v) => ({ ...(o as typeof sh), radius: Math.max(0, v) }))),
          this.labeled('Разлёт', num('⇔', 'Разлёт', sh.spread ?? 0, (o, v) => ({ ...(o as typeof sh), spread: v }))),
          this.caption('Цвет'),
          (() => {
            // Color and opacity in one field, as for fills.
            const pct = num('', 'Непрозрачность тени', Math.round(sh.color.a * 100), (o, v) => ({ ...(o as typeof sh), color: { ...(o as typeof sh).color, a: Math.max(0, Math.min(100, v)) / 100 } }));
            pct.classList.add('pct');
            pct.querySelector('input')?.after(h('span', { class: 'unit' }, '%'));
            return h('div', { class: 'paint-row' }, this.colorField(`fx:${i}:${sel.join(',')}`, sh.color, (c) => update(i, (o) => ({ ...(o as typeof sh), color: c }))), pct);
          })(),
          this.shadowBlend(sh.blendMode, (b) => update(i, (o) => ({ ...(o as typeof sh), blendMode: b }))),
          sh.type === 'DROP_SHADOW'
            ? this.checkRow(sh.showShadowBehindNode === true, 'Видна за прозрачным', 'Тень видна и за прозрачными частями слоя (по умолчанию — только снаружи)', (on) =>
                update(i, (o) => {
                  const next = { ...(o as typeof sh) };
                  if (on) next.showShadowBehindNode = true;
                  else delete next.showShadowBehindNode;
                  return next;
                }),
              )
            : '',
        ];
      }
      const pct = (label: string, title: string, value: number, apply: (e: Effect, v: number) => Effect) => num(label, `${title}, %`, Math.round(value * 100), (o, v) => apply(o, Math.max(0, Math.min(100, v)) / 100));
      const seg = <V extends string>(options: [V, string, string][], current: V, pick: (v: V) => void) =>
        h('div', { class: 'seg wide' }, ...options.map(([v, label, title]) => h('button', { class: v === current ? 'on' : '', title, onclick: () => pick(v) }, label)));
      if (e.type === 'NOISE') {
        const nz = e;
        const key = `fx:${i}:${sel.join(',')}`;
        return [
          head,
          seg(
            [
              ['MONOTONE', 'Один цвет', 'Зерно одного цвета'],
              ['DUOTONE', 'Два', 'Зерно двух цветов'],
              ['MULTITONE', 'Разноцветный', 'Зерно всех цветов'],
            ],
            nz.noiseType,
            (v) =>
              update(i, (o) => {
                const n = { ...(o as typeof nz), noiseType: v };
                if (v === 'DUOTONE') n.secondaryColor ??= { r: 1, g: 1, b: 1, a: 0.25 };
                if (v === 'MULTITONE') n.opacity ??= 0.25;
                return n;
              }),
          ),
          num('▦', 'Размер зерна, px', nz.noiseSize, (o, v) => ({ ...(o as typeof nz), noiseSize: Math.max(0.5, v) })),
          pct('◔', 'Плотность', nz.density, (o, v) => ({ ...(o as typeof nz), density: v })),
          ...(nz.noiseType === 'MULTITONE'
            ? [pct('%', 'Непрозрачность зерна', nz.opacity ?? 1, (o, v) => ({ ...(o as typeof nz), opacity: v }))]
            : [
                this.colorField(key, nz.color, (c) => update(i, (o) => ({ ...(o as typeof nz), color: c }))),
                ...(nz.noiseType === 'DUOTONE' ? [this.colorField(`${key}:2`, nz.secondaryColor ?? { r: 1, g: 1, b: 1, a: 0.25 }, (c) => update(i, (o) => ({ ...(o as typeof nz), secondaryColor: c })))] : []),
              ]),
          this.shadowBlend(nz.blendMode, (b) => update(i, (o) => ({ ...(o as typeof nz), blendMode: b }))),
        ];
      }
      if (e.type === 'TEXTURE') {
        const tx = e;
        return [
          head,
          num('▦', 'Размер зерна, px', tx.noiseSize, (o, v) => ({ ...(o as typeof tx), noiseSize: Math.max(0.5, v) })),
          num('◌', 'Сила: насколько края и заливка расходятся, px', tx.radius, (o, v) => ({ ...(o as typeof tx), radius: Math.max(0, v) })),
          this.checkRow(tx.clipToShape, 'В пределах формы', 'Зерно не выходит за форму слоя', (on) => update(i, (o) => ({ ...(o as typeof tx), clipToShape: on }))),
        ];
      }
      if (e.type === 'GLASS') {
        const gl = e;
        return [
          head,
          num('∠', 'Угол света, °', gl.lightAngle, (o, v) => ({ ...(o as typeof gl), lightAngle: v })),
          pct('☀', 'Сила блика', gl.lightIntensity, (o, v) => ({ ...(o as typeof gl), lightIntensity: v })),
          pct('≈', 'Преломление', gl.refraction, (o, v) => ({ ...(o as typeof gl), refraction: v })),
          num('▭', 'Глубина преломления у краёв, px', gl.depth, (o, v) => ({ ...(o as typeof gl), depth: Math.max(0, v) })),
          pct('◐', 'Расхождение цветов', gl.dispersion, (o, v) => ({ ...(o as typeof gl), dispersion: v })),
          num('◌', 'Матовость (размытие фона), px', gl.radius, (o, v) => ({ ...(o as typeof gl), radius: Math.max(0, v) })),
        ];
      }
      // Layer or background blur: uniform or progressive (from start to end — via handles on the canvas).
      const bl = e as BlurEffect;
      const progressive = bl.blurType === 'PROGRESSIVE';
      return [
        head,
        seg(
          [
            ['NORMAL', 'Равномерное', 'Одинаковое по всему слою'],
            ['PROGRESSIVE', 'Прогрессивное', 'Нарастает от начала к концу (точки — ручками на холсте)'],
          ],
          progressive ? 'PROGRESSIVE' : 'NORMAL',
          (v) =>
            update(i, (o) => {
              const b = { ...(o as typeof bl) };
              if (v === 'PROGRESSIVE') Object.assign(b, { blurType: 'PROGRESSIVE', startRadius: b.startRadius ?? 0, startOffset: b.startOffset ?? { x: 0.5, y: 0 }, endOffset: b.endOffset ?? { x: 0.5, y: 1 } });
              else {
                delete b.blurType;
                delete b.startRadius;
                delete b.startOffset;
                delete b.endOffset;
              }
              return b;
            }),
        ),
        ...(progressive ? [num('◌₁', 'Размытие в начале', bl.startRadius ?? 0, (o, v) => ({ ...(o as typeof bl), startRadius: Math.max(0, v) }))] : []),
        num(progressive ? '◌₂' : '◌', progressive ? 'Размытие в конце' : 'Размытие', bl.radius, (o, v) => ({ ...(o as typeof bl), radius: Math.max(0, v) })),
      ];
    });
    // Parameters popup: header (effect type) and fields — rebuilt on every render (values stay fresh).
    const pop = this.effectPop;
    if (pop && pop.key === selKey && pop.box.isConnected) {
      const params = rows[pop.index]?.slice(1) ?? [];
      const e = effects?.[pop.index];
      if (!e || !params.length) pop.close();
      else {
        const title = EFFECT_TYPES.find(([t]) => t === e.type)?.[1] ?? 'Эффект';
        pop.box.replaceChildren(
          h('div', { class: 'fx-pop-head' }, h('span', {}, title), this.iconButton(ICON.close, 'Закрыть (Esc)', () => pop.close())),
          h('div', { class: 'props effect-body' }, ...params),
        );
        // Left of the properties panel, at the height of the effect row.
        requestAnimationFrame(() => {
          const right = document.getElementById('right')!.getBoundingClientRect();
          const anchor = document.querySelectorAll('#properties .effect-row')[pop.index]?.getBoundingClientRect();
          const hgt = pop.box.offsetHeight;
          pop.box.style.left = `${Math.max(8, right.left - pop.box.offsetWidth - 8)}px`;
          pop.box.style.top = `${Math.max(8, Math.min(anchor ? anchor.top - 8 : 80, innerHeight - hgt - 8))}px`;
        });
      }
    }
    const shown = rows.map(([head]) => [head!]);
    return h('div', { class: 'section' }, header, ...(rows.length || shadowPill ? [h('div', { class: 'props' }, ...(shadowPill ? [shadowPill] : []), ...shown.flat())] : []));
  }

  /** “Export” section for the developer mode inspect panel. */
  exportSectionFor(sel: string[]): HTMLElement {
    return this.exportSection(sel);
  }

  /**
   * Export: a layer has a list of “size, suffix, format” settings; “+” adds another one
   * (next scale), “−” removes one; SVG also has outlined text and layer ids. The button exports all
   * settings of all selected layers. If the selection has different settings, an edit makes them all the same.
   */
  private exportSection(sel: string[]): HTMLElement {
    const doc = this.ed.doc;
    const lists = sel.map((id) => doc.get(id, 'exportSettings') ?? []);
    const first = lists[0] ?? [];
    const mixed = lists.some((l) => JSON.stringify(l) !== JSON.stringify(first));
    const settings = first;
    // Unchecked flags (undefined) — no key.
    const set = (list: ExportSetting[]) => doc.transact(() => sel.forEach((id) => doc.set(id, { exportSettings: list.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as ExportSetting) })));
    const update = (i: number, patch: Partial<ExportSetting>) => set(settings.map((x, k) => (k === i ? { ...x, ...patch } : x)));
    const add = () => {
      const last = settings[settings.length - 1];
      const next: ExportSetting = !last
        ? { format: 'PNG', suffix: '', constraint: { type: 'SCALE', value: 1 } }
        : { ...last, suffix: '', constraint: last.constraint?.type === 'SCALE' ? { type: 'SCALE', value: Math.min(4, Math.floor(last.constraint.value) + 1) } : { type: 'SCALE', value: 2 } };
      set([...settings, next]);
    };
    const rows = settings.map((x, i) => {
      const raster = isRaster(x.format);
      const size = h('input', { class: 'exp-size', value: raster ? constraintLabel(x.constraint) : '—', disabled: !raster, title: 'Размер: 2x — масштаб, 512w — ширина, 300h — высота' }) as HTMLInputElement;
      size.setAttribute('list', 'exp-sizes');
      size.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') size.blur();
      });
      size.addEventListener('change', () => {
        const c = parseConstraint(size.value);
        if (c) update(i, { constraint: c });
        else size.value = constraintLabel(x.constraint);
      });
      const suffix = h('input', { class: 'exp-suffix', value: x.suffix ?? '', placeholder: 'Суффикс', title: 'Добавляется к имени файла' }) as HTMLInputElement;
      suffix.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') suffix.blur();
      });
      suffix.addEventListener('change', () => update(i, { suffix: suffix.value }));
      const format = h('select', { class: 'exp-format', title: 'Формат: WEBP и AVIF — меньше файл при том же виде' }, ...(['PNG', 'JPG', 'WEBP', 'AVIF', 'SVG', 'PDF'] as const).map((v) => h('option', { value: v, selected: v === x.format }, v))) as HTMLSelectElement;
      format.addEventListener('change', () => {
        const v = format.value as ExportSetting['format'];
        // Quality only for lossy formats; on format change — its default value.
        update(i, isRaster(v) ? { format: v, constraint: x.constraint ?? { type: 'SCALE', value: 1 }, quality: undefined } : v === 'SVG' ? { format: v, svgOutlineText: x.svgOutlineText ?? true, quality: undefined } : { format: v, quality: undefined });
      });
      // Options: overlapping layers and bounds for all formats, SVG also has text and ids.
      const more = svgEl('button', {
        class: 'icon-btn sm',
        title: 'Параметры экспорта',
        onclick: (e: MouseEvent) =>
          showMenu(e.currentTarget as HTMLElement, [
            {
              label: 'Суффикс имени файла',
              checked: !!x.suffix || this.exportSuffixOpen.has(i),
              run: () => {
                if (x.suffix) update(i, { suffix: '' });
                else if (this.exportSuffixOpen.has(i)) this.exportSuffixOpen.delete(i);
                else this.exportSuffixOpen.add(i);
                this.schedule();
              },
            },
            'sep',
            { label: 'Без слоёв поверх', checked: x.contentsOnly !== false, run: () => update(i, { contentsOnly: x.contentsOnly === false ? undefined : false }) },
            { label: 'Ровно по рамке слоя', checked: !!x.useAbsoluteBounds, run: () => update(i, { useAbsoluteBounds: x.useAbsoluteBounds ? undefined : true }) },
            ...(x.format === 'SVG'
              ? [
                  'sep' as const,
                  { label: 'Текст кривыми', checked: x.svgOutlineText !== false, run: () => update(i, { svgOutlineText: x.svgOutlineText === false }) },
                  { label: 'id слоёв (имена)', checked: !!x.svgIdAttribute, run: () => update(i, { svgIdAttribute: !x.svgIdAttribute }) },
                ]
              : []),
            ...(isLossy(x.format)
              ? [
                  'sep' as const,
                  {
                    label: `Качество: ${x.quality ?? defaultQuality(x.format)}%`,
                    submenu: [100, 95, 90, 85, 80, 70, 60, 50].map((q) => ({ label: `${q}%${q === defaultQuality(x.format) ? ' — по умолчанию' : ''}`, checked: (x.quality ?? defaultQuality(x.format)) === q, run: () => update(i, { quality: q === defaultQuality(x.format) ? undefined : q }) })),
                  },
                ]
              : []),
          ]),
      }, ICON.more);
      const remove = svgEl('button', { class: 'icon-btn sm', title: 'Убрать', onclick: () => set(settings.filter((_, k) => k !== i)) }, ICON.minus);
      // Size | format | ⋯ | −; suffix on the line below if set or enabled in “⋯”.
      const row = h('div', { class: 'exp-row' }, h('div', { class: 'field' }, size), h('div', { class: 'field' }, format), more, remove);
      return x.suffix || this.exportSuffixOpen.has(i) ? h('div', { class: 'exp-item' }, row, h('div', { class: 'field exp-suffix-field', title: 'Суффикс: добавляется к имени файла' }, h('label', {}, '…_'), suffix)) : row;
    });
    const name = sel.length === 1 ? (doc.get(sel[0]!, 'name') ?? '') : `${sel.length} слоёв`;
    const button = settings.length ? h('button', { class: 'export-btn', title: 'Ctrl+Shift+E', onclick: () => this.onExport(sel) }, `Экспортировать «${name}»`) : null;
    return h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Экспорт', h('span', { class: 'h-acts' }, svgEl('button', { title: 'Добавить настройку экспорта', onclick: add }, ICON.plus))),
      ...(mixed ? [h('div', { class: 'empty' }, 'У выделенных слоёв разные настройки — правка задаст всем одинаковые.')] : []),
      ...(rows.length ? [h('div', { class: 'exp-rows' }, ...rows)] : []),
      ...(button ? [h('div', { class: 'props', style: 'margin-top:8px' }, h('div', { class: 'wide' }, button))] : []),
      ...(button && sel.length === 1 ? [this.exportPreviewBlock(sel[0]!)] : []),
      h('datalist', { id: 'exp-sizes' }, ...['0.5x', '0.75x', '1x', '1.5x', '2x', '3x', '4x', '512w', '512h'].map((v) => h('option', { value: v }))),
    );
  }

  /** “› Preview”: the layer image as export will produce it. */
  private exportPreviewBlock(id: string): HTMLElement {
    const toggle = h('button', { class: `exp-preview-toggle${this.exportPreview ? ' on' : ''}`, 'aria-expanded': String(this.exportPreview) }, 'Предпросмотр');
    toggle.addEventListener('click', () => {
      this.exportPreview = !this.exportPreview;
      this.schedule();
    });
    const wrap = h('div', { class: 'exp-preview' }, toggle);
    if (this.exportPreview) {
      const box = h('div', { class: 'exp-preview-img' });
      wrap.append(box);
      // Previous image immediately (no flicker); a new one at most once every 400 ms (dragging doesn't lag).
      const last = this.previewImg;
      if (last?.id === id) box.append(last.img);
      const stale = last?.id !== id || performance.now() - last.at > 400;
      if (stale) {
        this.previewImg = { id, img: last?.id === id ? last.img : (h('img', { alt: 'Предпросмотр экспорта' }) as HTMLImageElement), at: performance.now() };
        const img = this.previewImg.img;
        void this.ed.renderThumbnail(id, 480).then((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          img.onload = () => URL.revokeObjectURL(url);
          img.src = url;
          if (box.isConnected && !img.isConnected) box.append(img);
        });
      }
    }
    return wrap;
  }

  /**
   * Fill or stroke: a list of paints (top one first). Each has a color or type,
   * opacity, visibility and delete; “+” adds a solid paint on top.
   */
  private paintsSection(
    title: string,
    key: 'fills' | 'strokes',
    sel: string[],
    setEach: (fn: (id: string) => Props | null) => void,
    fallback: { r: number; g: number; b: number },
    extra: (HTMLElement | string)[] = [],
  ): HTMLElement {
    const doc = this.ed.doc;
    const lists = sel.map((id) => (doc.get(id, key) ?? []) as Paint[]);
    const first = JSON.stringify(lists[0]);
    const mixed = lists.some((l) => JSON.stringify(l) !== first);
    const paints = mixed ? [] : lists[0]!;
    const add = svgEl(
      'button',
      {
        title: `Добавить: ${title.toLowerCase()}`,
        onclick: () =>
          setEach((id) => ({ [key]: [...(mixed ? [] : ((doc.get(id, key) ?? []) as Paint[])), { type: 'SOLID', color: key === 'strokes' ? { r: 0, g: 0, b: 0 } : fallback }] })),
      },
      ICON.plus,
    );
    const header = h('h3', {}, title, h('span', { class: 'h-acts' }, add));
    if (mixed) return h('div', { class: 'section' }, header, h('div', { class: 'empty' }, `Разные — «+» заменит их одной`));
    if (!paints.length) return h('div', { class: 'section' }, header);
    // Change the i-th paint on all selected layers (they have the same list).
    const update = (i: number, fn: (p: Paint) => Paint | null) =>
      setEach((id) => {
        const list = [...((doc.get(id, key) ?? []) as Paint[])];
        if (!list[i]) return null;
        const next = fn(list[i]!);
        if (next) list[i] = next;
        else list.splice(i, 1);
        return { [key]: list };
      });
    const rows: HTMLElement[] = [];
    for (let i = paints.length - 1; i >= 0; i--) {
      const p = paints[i]!;
      const peKey = `${key}:${i}:${sel.join(',')}`;
      refreshEditor(peKey, p);
      const open = (anchor: HTMLElement) =>
        openPaintEditor({
          key: peKey,
          anchor,
          paint: p,
          onChange: (next) =>
            update(i, () => {
              // The color was changed in the popup — it is now custom (not from a variable).
              if (next.type === 'SOLID' && p.type === 'SOLID' && next.boundVariables && JSON.stringify(next.color) !== JSON.stringify(p.color)) {
                const { boundVariables: _, ...rest } = next;
                return rest;
              }
              if (p.boundVariables?.gradient && next.boundVariables?.gradient) {
                const shape = (x: Paint) => JSON.stringify([x.type, 'gradientStops' in x ? x.gradientStops : null, 'gradientTransform' in x ? x.gradientTransform : null]);
                if (shape(next) !== shape(p)) return paintWithGradient(doc, next, null);
              }
              return next;
            }),
          onStart: () => doc.beginGroup(),
          onEnd: () => doc.endGroup(),
          docColors: this.docColors(),
          // “Libraries”: a color style applies to the whole field of the selection, a variable — to this paint.
          library: sel.length && doc.type(sel[0]!) !== 'STYLE'
            ? () =>
                paintLibrary(this.ed, {
                  field: key,
                  nodeId: sel[0]!,
                  nodeType: doc.type(sel[0]!),
                  currentStyle: doc.get(sel[0]!, key === 'fills' ? 'fillStyleId' : 'strokeStyleId') ?? null,
                  currentVariable: p.type === 'SOLID' ? (p.boundVariables?.color?.id ?? null) : null,
                  onStyle: (id) => doc.transact(() => sel.forEach((s) => applyStyle(doc, s, key === 'fills' ? 'fillStyleId' : 'strokeStyleId', id))),
                  onVariable: (v) =>
                    update(i, (old) =>
                      doc.get(v, 'resolvedType') === 'GRADIENT'
                        ? paintWithGradient(doc, paintWithVariable(doc, old, null), v, sel[0] ?? null)
                        : paintWithVariable(doc, paintWithGradient(doc, old, null), v, null),
                    ),
                })
            : undefined,
          pickImage: () => this.pickImage(),
          pickVideo: () => this.pickVideo(),
          pickLottie: () => this.pickLottie(),
          pickModel: () => this.pickModel(),
          modelInfo: (hash) => this.ed.models.info(hash),
          // Gradient handles only for a layer on the canvas (not for a style).
          onGradient: (state) => this.onGradient?.(state && sel.length === 1 && doc.type(sel[0]!) !== 'STYLE' ? { id: sel[0]!, key, index: i, stop: state.stop } : null),
          onCrop: sel.length === 1 && doc.type(sel[0]!) !== 'STYLE' && key === 'fills' ? () => this.onCrop?.({ id: sel[0]!, key, index: i }) : undefined,
          pickPatternSource: () => this.onPatternPick?.(sel) ?? Promise.resolve(null),
          shaderError: (code) => this.ed.shaderError(code),
          patternSourceName: (id) => {
            const source = doc.patternSourceNode(id);
            if (!source || doc.type(source) === 'PAGE') return null;
            const name = doc.get(source, 'name') ?? doc.type(source)!;
            return source === id ? name : `${name} · сохранённый узор`;
          },
        });
      const isGradient = p.type.startsWith('GRADIENT');
      const varId = p.type === 'SOLID' ? (p.boundVariables?.color?.id ?? null) : isGradient ? (p.boundVariables?.gradient?.id ?? null) : null;
      // Color from a color variable, gradient from a composite “Gradient” variable (our own); pick from both.
      const pickVar = (anchor: HTMLElement) =>
        openVariablePicker(this.ed, anchor, {
          types: ['COLOR', 'GRADIENT'],
          field: key,
          nodeId: sel[0],
          nodeType: doc.type(sel[0]!),
          current: varId,
          onPick: (v) =>
            update(i, (old) => {
              if (v && doc.get(v, 'resolvedType') === 'GRADIENT') return paintWithGradient(doc, paintWithVariable(doc, old, null), v, sel[0] ?? null);
              return paintWithVariable(doc, paintWithGradient(doc, old, null), v, null);
            }),
          onOpenWindow: () => openVariablesWindow(this.ed),
        });
      const main =
        varId
          ? h('div', { class: 'field var-field paint-var' }, variablePill(this.ed, varId, { nodeId: sel[0], onPick: pickVar, onDetach: () => update(i, (old) => paintWithGradient(doc, paintWithVariable(doc, old, null), null)) }))
          : this.paintField(p, peKey, open, (c) => update(i, (old) => {
              // Custom color — no longer from a variable.
              const { boundVariables: _, ...rest } = old as Extract<Paint, { type: 'SOLID' }>;
              return { ...rest, color: c };
            }));
      const varBtn: HTMLButtonElement | null = (p.type === 'SOLID' || isGradient) && !varId ? this.iconButton(ICON.variable, isGradient ? 'Градиент или цвет из переменной' : 'Цвет или градиент из переменной', () => varBtn && pickVar(varBtn)) : null;
      if (varBtn) {
        varBtn.classList.add('var-btn');
        main.append(varBtn);
      }
      const opacity = this.numField('', Math.round((p.opacity ?? 1) * 100), (v, id) => {
        const list = [...((doc.get(id, key) ?? []) as Paint[])];
        if (!list[i]) return null;
        list[i] = { ...list[i]!, opacity: Math.max(0, Math.min(100, v)) / 100 };
        return { [key]: list };
      }, setEach, false, { unit: '%', title: 'Непрозрачность' });
      opacity.classList.add('pct');
      const shown = p.visible !== false;
      const eye = this.iconButton(shown ? ICON.eye : ICON.eyeOff, shown ? 'Скрыть' : 'Показать', () => update(i, (old) => ({ ...old, visible: !shown })));
      const remove = this.iconButton(ICON.minus, 'Убрать', () => update(i, () => null));
      const row = h('div', { class: 'paint-row' }, paints.length > 1 ? h('span', { class: 'grip', title: 'Перетащите, чтобы изменить порядок' }) : '', main, opacity, eye, remove);
      if (paints.length > 1)
        this.rowDrag(row, i, paints.length, (from, to) =>
          setEach((id) => {
            const list = [...((doc.get(id, key) ?? []) as Paint[])];
            const [moved] = list.splice(from, 1);
            if (!moved) return null;
            list.splice(to, 0, moved);
            return { [key]: list };
          }),
        );
      rows.push(row);
    }
    return h('div', { class: 'section' }, header, h('div', { class: 'props paints' }, ...rows, ...extra));
  }

  /**
   * Reordering a row by dragging (paints top to bottom — from last to first).
   * Drag by an empty part of the row or by the label; fields and buttons work as usual.
   */
  private rowDrag(row: HTMLElement, i: number, n: number, move: (from: number, to: number) => void) {
    row.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0 || t.closest('input, select, button, label')) return;
      const list = row.parentElement;
      if (!list) return;
      const rows = [...list.querySelectorAll(':scope > .paint-row')] as HTMLElement[];
      const y0 = e.clientY;
      let active = false;
      let slot = n - 1 - i;
      const line = h('div', { class: 'paint-drop' });
      const mv = (ev: PointerEvent) => {
        if (!active && Math.abs(ev.clientY - y0) < 4) return;
        if (!active) {
          active = true;
          row.classList.add('dragging');
          list.append(line);
        }
        slot = rows.length;
        for (let k = 0; k < rows.length; k++) {
          const r = rows[k]!.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            slot = k;
            break;
          }
        }
        const lr = list.getBoundingClientRect();
        const ref = rows[Math.min(slot, rows.length - 1)]!.getBoundingClientRect();
        line.style.top = `${(slot < rows.length ? ref.top - 4 : ref.bottom + 3) - lr.top}px`;
      };
      const up = () => {
        document.removeEventListener('pointermove', mv);
        document.removeEventListener('pointerup', up);
        line.remove();
        row.classList.remove('dragging');
        if (!active) return;
        const from = n - 1 - i;
        const place = slot > from ? slot - 1 : slot;
        const to = n - 1 - place;
        if (to !== i) move(i, to);
      };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
    });
  }

  /** Paint swatch and label: hex for solid, type for gradient and image; click opens the paint popup. */
  private paintField(p: Paint, peKey: string, open: (anchor: HTMLElement) => void, setColor: (c: { r: number; g: number; b: number }) => void): HTMLElement {
    const swatch = h('button', { class: `swatch${paintEditorKey() === peKey ? ' open' : ''}`, 'data-pe-key': peKey, title: 'Цвет, градиент или картинка', style: `background:${swatchCss(p)}` });
    let label: HTMLElement;
    if (p.type === 'SOLID') {
      const text = h('input', { value: hex(p.color).slice(1) }) as HTMLInputElement;
      text.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') text.blur();
      });
      text.addEventListener('change', () => {
        const c = parseHex(text.value);
        if (c) setColor(c);
        else text.value = hex(p.color).slice(1);
      });
      label = text;
    } else if (p.type === 'SHADER') {
      const preset = SHADER_PRESETS.find((x) => x.code === p.code);
      label = h('span', { class: 'paint-label', 'data-pe-key': peKey }, preset ? `Шейдер · ${preset.name}` : 'Шейдер · свой');
    } else if (p.type === 'PATTERN') {
      const doc = this.ed.doc;
      const src = p.sourceNodeId && doc.has(p.sourceNodeId) ? (doc.get(p.sourceNodeId, 'name') ?? '') : '';
      label = h('span', { class: 'paint-label', 'data-pe-key': peKey, title: src ? `Источник: ${src}` : 'Источник не выбран' }, src ? `Узор · ${src}` : 'Узор');
    } else {
      label = h('span', { class: 'paint-label', 'data-pe-key': peKey }, PAINT_LABEL[p.type]);
    }
    const field = h('div', { class: 'field wide' }, swatch, label);
    swatch.addEventListener('click', () => open(field));
    if (p.type !== 'SOLID') label.addEventListener('click', () => open(field));
    return field;
  }

  /** Rotation origin: 3 × 3 — corners, side midpoints, bounds center (per session, like the reference point in Affinity). */
  /** Rotation origin (our own): center, corners and side midpoints — the “⋯” submenu of rotation. */
  private originMenu(): MenuEntry[] {
    const ed = this.ed;
    const [ox, oy] = ed.rotationOrigin;
    const NAMES = [
      ['Левый верхний угол', 'Середина верхней стороны', 'Правый верхний угол'],
      ['Середина левой стороны', 'Центр', 'Середина правой стороны'],
      ['Левый нижний угол', 'Середина нижней стороны', 'Правый нижний угол'],
    ];
    const items: MenuEntry[] = [];
    for (let row = 0; row < 3; row++) {
      if (row) items.push('sep');
      for (let col = 0; col < 3; col++) {
        const fx = col / 2;
        const fy = row / 2;
        items.push({
          label: NAMES[row]![col]!,
          checked: fx === ox && fy === oy,
          run: () => {
            ed.rotationOrigin = [fx, fy];
            ed.dirty = true;
            this.schedule();
          },
        });
      }
    }
    return items;
  }

  /** Collapse all layers in the panel (Alt+L). */
  collapseLayers() {
    this.expanded.clear();
    this.layersDirty = true;
    this.schedule(false);
  }

  /** “Selection colors” fully expanded (otherwise the first six). */
  private selColorsAll = false;

  /**
   * Selection colors: custom colors, styles and paint variables of the selected layers and
   * everything inside. Editing a row changes the color everywhere at once; a style or variable can be replaced.
   * Only for multiple layers or a layer with content.
   */
  private selectionColorsSection(sel: string[]): HTMLElement | '' {
    const doc = this.ed.doc;
    if (!(sel.length > 1 || sel.some((id) => doc.children(id).length))) return '';
    const colors = selectionColors(doc, sel);
    if (!colors?.length) return '';
    const shown = this.selColorsAll ? colors : colors.slice(0, 6);
    const count = (g: SelectionColor) => h('span', { class: 'sc-count', title: `Мест с этим цветом: ${g.uses.length}` }, String(g.uses.length));
    const layers = (g: SelectionColor) => g.uses.filter((u) => u.run === undefined);
    const rows = shown.map((g, i) => {
      if (g.kind === 'style') {
        const btn = h('button', { class: 'style-applied', title: 'Заменить стиль во всех местах' }, stylePreview(doc, g.ref!), h('span', { class: 'style-name' }, doc.get(g.ref!, 'name') ?? ''));
        btn.addEventListener('click', () => this.swapPaintStyle(btn, g));
        return h('div', { class: 'paint-row selection-color-row' }, btn, count(g));
      }
      if (g.kind === 'variable') {
        const bind = (v: string | null) => doc.transact(() => layers(g).forEach((u) => bindPaintVariable(doc, u.id, u.key, u.index, v)));
        const pick = (anchor: HTMLElement) =>
          openVariablePicker(this.ed, anchor, { types: ['COLOR'], field: 'fills', nodeId: sel[0], current: g.ref, onPick: (v) => bind(v), onOpenWindow: () => openVariablesWindow(this.ed) });
        return h('div', { class: 'paint-row selection-color-row' }, h('div', { class: 'field var-field paint-var' }, variablePill(this.ed, g.ref!, { nodeId: sel[0], onPick: pick, onDetach: () => bind(null) })), count(g));
      }
      const field = this.colorField(`selcolor:${i}`, { ...g.color, a: g.opacity }, (c) => doc.transact(() => recolorUses(doc, g.uses, c, c.a)));
      const pct = h('input', { value: `${Math.round(g.opacity * 100)}%`, title: 'Непрозрачность' }) as HTMLInputElement;
      pct.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') pct.blur();
      });
      pct.addEventListener('change', () => {
        const v = Number(pct.value.replace('%', '').replace(',', '.'));
        if (Number.isFinite(v)) doc.transact(() => recolorUses(doc, g.uses, g.color, Math.max(0, Math.min(100, v)) / 100));
        else pct.value = `${Math.round(g.opacity * 100)}%`;
      });
      return h('div', { class: 'paint-row selection-color-row' }, field, h('div', { class: 'field pct' }, pct), count(g));
    });
    const more =
      colors.length > 6
        ? [
            h(
              'button',
              {
                class: 'link-btn',
                onclick: () => {
                  this.selColorsAll = !this.selColorsAll;
                  this.schedule();
                },
              },
              this.selColorsAll ? 'Свернуть' : `Показать все (${colors.length})`,
            ),
          ]
        : [];
    return h('div', { class: 'section' }, h('h3', { title: 'Цвета красок всего выделенного: правка меняет цвет во всех местах сразу' }, 'Цвета выделения'), h('div', { class: 'props' }, ...rows, ...more));
  }

  /** Replace a paint style everywhere in a “Selection colors” row (or detach — the color stays). */
  private swapPaintStyle(anchor: HTMLElement, g: SelectionColor) {
    const doc = this.ed.doc;
    const { box, close } = popover(anchor, 'picker', { width: 260, side: 'left' });
    if (!box.isConnected) return;
    const apply = (styleId: string) => {
      close();
      doc.transact(() => {
        for (const u of g.uses) if (u.run === undefined) applyStyle(doc, u.id, u.key === 'fills' ? 'fillStyleId' : 'strokeStyleId', styleId);
      });
    };
    const list = h('div', { class: 'pop-list' });
    for (const st of localStyles(doc, 'PAINT')) list.append(h('button', { class: `style-item${st === g.ref ? ' current' : ''}`, onclick: () => apply(st) }, stylePreview(doc, st), h('span', { class: 'style-name' }, doc.get(st, 'name') ?? '')));
    box.append(h('div', { class: 'pop-head' }, 'Заменить стиль'), list, h('button', { class: 'link-btn', onclick: () => apply('') }, 'Отвязать от стиля (цвет останется)'));
  }

  /** Document colors for the color picker: solid fills and strokes of the page, most frequent first. */
  private docColors(): RGBA[] {
    const doc = this.ed.doc;
    const count = new Map<string, { c: RGBA; n: number }>();
    const stack = [...doc.children(this.ed.pageId)];
    let budget = 20000;
    while (stack.length && budget-- > 0) {
      const id = stack.pop()!;
      for (const key of ['fills', 'strokes'] as const) {
        for (const p of (doc.get(id, key) ?? []) as Paint[]) {
          if (p.type !== 'SOLID' || p.visible === false) continue;
          const c = { ...p.color, a: Math.round((p.opacity ?? 1) * 100) / 100 };
          const k = `${hex(c)}${c.a}`;
          const e = count.get(k);
          if (e) e.n++;
          else count.set(k, { c, n: 1 });
        }
      }
      stack.push(...doc.children(id));
    }
    return [...count.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 24)
      .map((e) => e.c);
  }

  /** An image from disk for a fill: stored by SHA-1; null — cancelled or unreadable. */
  /** Video from disk goes into document storage (like images). */
  private pickVideo(): Promise<{ hash: string } | null> {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime' }) as HTMLInputElement;
      input.addEventListener('cancel', () => resolve(null));
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        resolve({ hash: await this.ed.store.add(new Uint8Array(await f.arrayBuffer())) });
      });
      input.click();
    });
  }

  private pickModel(): Promise<{ hash: string } | null> {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept: '.glb,.gltf,model/gltf-binary,model/gltf+json' }) as HTMLInputElement;
      input.addEventListener('cancel', () => resolve(null));
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!isModelBytes(bytes)) {
          this.notify(`«${f.name}» — не модель glTF (нужен .glb или .gltf со встроенными данными)`, 'error');
          return resolve(null);
        }
        resolve({ hash: await this.ed.store.add(bytes) });
      });
      input.click();
    });
  }

  private pickLottie(): Promise<{ hash: string } | null> {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept: '.json,.lottie,application/json' }) as HTMLInputElement;
      input.addEventListener('cancel', () => resolve(null));
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!isLottieBytes(bytes)) {
          this.notify(`«${f.name}» — не анимация Lottie (нужен .json из Bodymovin или .lottie)`, 'error');
          return resolve(null);
        }
        resolve({ hash: await this.ed.store.add(bytes) });
      });
      input.click();
    });
  }

  private pickImage(): Promise<{ hash: string; width: number } | null> {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
      input.addEventListener('cancel', () => resolve(null));
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        const bytes = new Uint8Array(await f.arrayBuffer());
        try {
          const bmp = await createImageBitmap(new Blob([bytes]));
          const width = bmp.width;
          bmp.close();
          resolve({ hash: await this.ed.store.add(bytes), width });
        } catch {
          this.notify(`Не удалось прочитать картинку «${f.name}»`, 'error');
          resolve(null);
        }
      });
      input.click();
    });
  }

  private strokeSection(sel: string[], same: <T>(get: (id: string) => T) => T | null, setEach: (fn: (id: string) => Props | null) => void): HTMLElement {
    const doc = this.ed.doc;
    const has = sel.some((id) => (doc.get(id, 'strokes') ?? []).length > 0);
    if (!has) return this.paintsSection('Обводка', 'strokes', sel, setEach, { r: 0, g: 0, b: 0 });
    const types = sel.map((id) => doc.type(id));
    const isLine = types.every((t) => t === 'LINE');
    const rectLike = types.every((t) => t === 'RECTANGLE' || t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE');
    const hasEnds = types.every((t) => t === 'LINE' || t === 'VECTOR');
    // Per-side weight (for rectangles): 'all' — strokeWeight on all sides.
    const SIDE_KEYS = ['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'] as const;
    const clearSides: Props = { strokeTopWeight: undefined, strokeRightWeight: undefined, strokeBottomWeight: undefined, strokeLeftWeight: undefined };
    const sidesOf = (id: string): [number, number, number, number] | 'all' => {
      const v = SIDE_KEYS.map((k) => doc.get(id, k));
      if (v.every((x) => x === undefined)) return 'all';
      const w = doc.get(id, 'strokeWeight') ?? 1;
      return v.map((x) => x ?? w) as [number, number, number, number];
    };
    const sides = rectLike ? same(sidesOf) : 'all';
    const weight = this.numField(ICON.stroke, sides === 'all' ? same((id) => doc.get(id, 'strokeWeight') ?? 1) : null, (v) => ({ strokeWeight: Math.max(0, v), ...clearSides }), setEach, false, { title: 'Толщина обводки', bind: sides === 'all' ? { ids: sel, fields: ['strokeWeight'] } : undefined });
    const heaviest = (id: string) => {
      const s = sidesOf(id);
      return s === 'all' ? (doc.get(id, 'strokeWeight') ?? 1) : Math.max(...s);
    };
    const only = (k: number) => (id: string): Props => {
      const w = heaviest(id) || 1;
      return Object.fromEntries(SIDE_KEYS.map((key, i) => [key, i === k ? w : 0])) as Props;
    };
    const sidesBtn = rectLike
      ? this.iconButton(
          ICON.strokeSides,
          'Обводка по сторонам',
          () => {
            const r = sidesBtn!.getBoundingClientRect();
            showMenuAt(r.left, r.bottom + 4, [
              { label: 'Все стороны', checked: sides === 'all', run: () => setEach((id) => ({ strokeWeight: heaviest(id), ...clearSides })) },
              'sep',
              { label: 'Сверху', run: () => setEach(only(0)) },
              { label: 'Справа', run: () => setEach(only(1)) },
              { label: 'Снизу', run: () => setEach(only(2)) },
              { label: 'Слева', run: () => setEach(only(3)) },
              'sep',
              {
                label: 'Свои для каждой',
                checked: sides !== 'all' && sides !== null,
                run: () =>
                  setEach((id) => {
                    const s = sidesOf(id);
                    const w = doc.get(id, 'strokeWeight') ?? 1;
                    const v = s === 'all' ? [w, w, w, w] : s;
                    return Object.fromEntries(SIDE_KEYS.map((key, i) => [key, v[i]])) as Props;
                  }),
              },
            ]);
          },
          { on: sides !== 'all' },
        )
      : null;
    const moreBtn = this.iconButton(ICON.settings, 'Настройки обводки: пунктир, обрезка, кисть, профиль ширины, соединения', () => this.settingsToggle('stroke', this.strokeMore, (on) => (this.strokeMore = on)), { on: this.strokeMore });
    const align = same((id) => doc.get(id, 'strokeAlign') ?? 'INSIDE');
    const alignSelect = h(
      'select',
      {},
      ...(
        [
          ['INSIDE', 'Внутри'],
          ['CENTER', 'По центру'],
          ['OUTSIDE', 'Снаружи'],
        ] as const
      ).map(([v, label]) => h('option', { value: v, selected: v === align }, label)),
    ) as HTMLSelectElement;
    if (align === null) alignSelect.prepend(h('option', { value: '', selected: true, disabled: true }, 'Разные'));
    alignSelect.addEventListener('change', () => setEach(() => ({ strokeAlign: alignSelect.value as 'INSIDE' | 'CENTER' | 'OUTSIDE' })));
    const dashed = same((id) => (doc.get(id, 'dashPattern') ?? []).length > 0);
    const dash = h(
      'div',
      { class: 'seg wide' },
      h('button', { class: dashed === false ? 'on' : '', title: 'Сплошная', onclick: () => setEach(() => ({ dashPattern: [] })) }, 'Сплошная'),
      h('button', { class: dashed ? 'on' : '', title: 'Пунктир', onclick: () => setEach((id) => ({ dashPattern: [Math.max(2, (doc.get(id, 'strokeWeight') ?? 1) * 4), Math.max(2, (doc.get(id, 'strokeWeight') ?? 1) * 2)] })) }, 'Пунктир'),
    );
    const extra: (HTMLElement | string)[] = [
      h('div', { class: 'prow with-labels' }, ...(isLine ? [] : [this.labeled('Положение', h('div', { class: 'field', title: 'Положение обводки' }, alignSelect))]), this.labeled('Толщина', weight), ...(sidesBtn ? [sidesBtn] : []), moreBtn),
    ];
    // Side weights — when set individually.
    if (sides !== 'all' && sides !== null) {
      const side = (k: number, label: string, title: string) =>
        this.numField(label, sides[k]!, (v, id) => {
          const s = sidesOf(id);
          const w = doc.get(id, 'strokeWeight') ?? 1;
          const cur = s === 'all' ? [w, w, w, w] : [...s];
          cur[k] = Math.max(0, v);
          return Object.fromEntries(SIDE_KEYS.map((key, i) => [key, cur[i]])) as Props;
        }, setEach, false, { title });
      extra.push(h('div', { class: 'grid-extra' }, side(0, '↑', 'Сверху'), side(1, '→', 'Справа'), side(2, '↓', 'Снизу'), side(3, '←', 'Слева')));
    }
    // Next — rows of the “Stroke settings” popup (the ones that are set are also visible in the section while the popup is closed).
    const moreFrom = extra.length;
    if (this.strokeMore || dashed !== false) extra.push(dash);
    // Dashes: dash and gap lengths.
    if (dashed) {
      const dashOf = (id: string) => doc.get(id, 'dashPattern') ?? [];
      const part = (k: number, label: string, title: string) =>
        this.numField(label, same((id) => dashOf(id)[k] ?? 0), (v, id) => {
          const d = [...dashOf(id)];
          while (d.length < 2) d.push(d[0] ?? 4);
          d[k] = Math.max(0, v);
          return { dashPattern: d };
        }, setEach, false, { title });
      extra.push(h('div', { class: 'prow' }, part(0, 'Черта', 'Длина черты'), part(1, 'Пробел', 'Длина пробела')));
    }
    // Path trim: the visible part of the stroke, as fractions of the path length.
    // Shown in “More” or when already set; animated on the timeline.
    const trimStart = same((id) => Math.round((doc.get(id, 'pathTrimStart') ?? 0) * 1000) / 10);
    const trimEnd = same((id) => Math.round((doc.get(id, 'pathTrimEnd') ?? 1) * 1000) / 10);
    if (this.strokeMore || trimStart !== 0 || trimEnd !== 100) {
      const share = (v: number) => Math.round(Math.max(0, Math.min(100, v)) * 10) / 1000;
      extra.push(
        h(
          'div',
          { class: 'prow' },
          this.numField('Начало', trimStart, (v) => ({ pathTrimStart: share(v) || undefined }), setEach, false, { unit: '%', title: 'Обрезка контура: обводка видна с этой доли длины' }),
          this.numField('Конец', trimEnd, (v) => ({ pathTrimEnd: share(v) >= 1 ? undefined : share(v) }), setEach, false, { unit: '%', title: 'Обрезка контура: обводка видна до этой доли длины' }),
        ),
      );
    }
    // Line and vector endpoints: start, swap, end.
    if (hasEnds) {
      const CAPS: [StrokeCap, string][] = [
        ['NONE', 'Нет'],
        ['ROUND', 'Круглый'],
        ['SQUARE', 'Квадратный'],
        ['ARROW_LINES', 'Стрелка'],
        ['ARROW_EQUILATERAL', 'Треугольник'],
        ['TRIANGLE_FILLED', 'Обр. треугольник'],
        ['CIRCLE_FILLED', 'Круг'],
        ['DIAMOND_FILLED', 'Ромб'],
      ];
      const capSelect = (key: 'strokeStartCap' | 'strokeEndCap', title: string) => {
        const v = same((id) => doc.get(id, key) ?? 'NONE');
        const s = h('select', { title }, ...CAPS.map(([c, label]) => h('option', { value: c, selected: c === v }, label))) as HTMLSelectElement;
        if (v === null) s.prepend(h('option', { value: '', selected: true, disabled: true }, 'Разные'));
        s.addEventListener('change', () => setEach(() => ({ [key]: s.value as StrokeCap }) as Props));
        return h('div', { class: 'field' }, s);
      };
      const swap = this.iconButton(ICON.swap, 'Поменять концы местами', () =>
        setEach((id) => ({ strokeStartCap: doc.get(id, 'strokeEndCap') ?? 'NONE', strokeEndCap: doc.get(id, 'strokeStartCap') ?? 'NONE' })),
      );
      extra.push(h('div', { class: 'prow' }, capSelect('strokeStartCap', 'Начало'), swap, capSelect('strokeEndCap', 'Конец')));
    }
    // Stroke brush from a set; scatter has step and scatter, dynamic has frequency and wave.
    if (sel.every((id) => ['VECTOR', 'LINE', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR'].includes(doc.type(id) ?? ''))) {
      const cur = same((id) => doc.get(id, 'strokeBrush')?.name ?? '');
      const brushSel = h(
        'select',
        { title: 'Кисть обводки (как в Draw): растягивание, разброс, динамика' },
        h('option', { value: '', selected: cur === '' }, 'Без кисти'),
        ...BRUSHES.map((b) => h('option', { value: b.name, selected: b.name === cur }, b.label)),
      ) as HTMLSelectElement;
      if (cur === null) brushSel.prepend(h('option', { value: '-', selected: true, disabled: true }, 'Разные'));
      brushSel.addEventListener('change', () => {
        const b = BRUSHES.find((x) => x.name === brushSel.value);
        setEach((id) => ({ strokeBrush: b ? { type: b.type, name: b.name, seed: doc.get(id, 'strokeBrush')?.seed ?? 1 + Math.floor(Math.random() * 1e6) } : undefined }) as Props);
      });
      // Brush — in the stroke settings (⚙) or when already chosen.
      if (this.strokeMore || cur !== '') extra.push(h('div', { class: 'field wide', title: 'Кисть' }, h('label', {}, '✎'), brushSel));
      const brush = sel.length === 1 ? doc.get(sel[0]!, 'strokeBrush') : undefined;
      const num = (label: string, title: string, value: number, set: (v: number) => Props) => {
        const input = h('input', { type: 'number', step: '0.1', value: String(Math.round(value * 100) / 100), title }) as HTMLInputElement;
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('change', () => {
          const v = Number(input.value);
          if (Number.isFinite(v)) setEach(() => set(v));
        });
        const lab = h('label', {}, label);
        this.scrubText(lab, input, (t) => {
          const v = Number(t);
          if (Number.isFinite(v)) setEach(() => set(v));
        }, { step: 0.1 });
        return h('div', { class: 'field' }, lab, input);
      };
      if (brush?.type === 'SCATTER') {
        extra.push(
          h(
            'div',
            { class: 'prow' },
            num('Шаг', 'Шаг между оттисками (доля толщины)', brush.spacing ?? 1.5, (v) => ({ strokeBrush: { ...brush, spacing: Math.max(0.2, v) } })),
            num('Разброс', 'Сдвиг поперёк линии (доля толщины)', brush.scatter ?? 0.5, (v) => ({ strokeBrush: { ...brush, scatter: Math.max(0, v) } })),
          ),
        );
      } else if (brush?.type === 'DYNAMIC') {
        extra.push(
          h(
            'div',
            { class: 'prow' },
            num('Частота', 'Волн на 100 px', brush.frequency ?? 2, (v) => ({ strokeBrush: { ...brush, frequency: Math.max(0.05, v) } })),
            num('Волна', 'Размах волны (доля толщины)', brush.wiggle ?? 0.5, (v) => ({ strokeBrush: { ...brush, wiggle: Math.max(0, v) } })),
          ),
        );
      }
    }
    // Width profile (variable width): presets; points on the canvas via the Shift+W tool.
    if (sel.every((id) => ['VECTOR', 'LINE', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR'].includes(doc.type(id) ?? ''))) {
      const widths = same((id) => JSON.stringify(doc.get(id, 'variableWidthPoints') ?? []));
      const current = widths === null ? null : widths === '[]' ? 'uniform' : 'custom';
      const sel2 = h(
        'select',
        { title: 'Профиль ширины обводки (точки — инструментом «Ширина обводки», Shift+W)' },
        ...WIDTH_PROFILES.map((p) => h('option', { value: p.id, selected: p.id === current }, p.label)),
        h('option', { value: 'custom', selected: current === 'custom', disabled: true }, 'Своя'),
      ) as HTMLSelectElement;
      if (current === null) sel2.prepend(h('option', { value: '', selected: true, disabled: true }, 'Разные'));
      sel2.addEventListener('change', () => {
        const prof = WIDTH_PROFILES.find((p) => p.id === sel2.value);
        if (!prof) return;
        setEach((id) => {
          const half = (doc.get(id, 'strokeWeight') ?? 1) / 2;
          return { variableWidthPoints: prof.points.map(([position, k]) => ({ position, ascent: k * half, descent: k * half })) };
        });
      });
      if (this.strokeMore || current !== 'uniform') extra.push(h('div', { class: 'field wide', title: 'Ширина обводки' }, h('label', {}, '≈'), sel2));
    }
    // Joins and miter angle.
    if (this.strokeMore) {
      const join = same((id) => doc.get(id, 'strokeJoin') ?? 'MITER');
      extra.push(
        h(
          'div',
          { class: 'seg wide', title: 'Соединение отрезков' },
          ...(
            [
              ['MITER', 'Острое'],
              ['BEVEL', 'Срезанное'],
              ['ROUND', 'Круглое'],
            ] as const
          ).map(([v, label]) => h('button', { class: join === v ? 'on' : '', onclick: () => setEach(() => ({ strokeJoin: v })) }, label)),
        ),
      );
      if (join === 'MITER') {
        // Miter angle: sharper corners are beveled. Limit (as in SVG) = 1 / sin(angle / 2).
        const angle = same((id) => (2 * Math.asin(1 / Math.max(1, doc.get(id, 'strokeMiterLimit') ?? 4)) * 180) / Math.PI);
        extra.push(
          h(
            'div',
            { class: 'prow' },
            this.numField('∠', angle, (v) => ({ strokeMiterLimit: v >= 180 ? 1 : 1 / Math.sin((Math.max(1, v) * Math.PI) / 360) }), setEach, false, { unit: '°', title: 'Угол митры: углы острее срезаются' }),
            h('span'),
          ),
        );
      }
    }
    if (this.strokeMore) this.settingsPop('stroke', moreBtn, 'Настройки обводки', extra.splice(moreFrom), () => (this.strokeMore = false));
    return this.paintsSection('Обводка', 'strokes', sel, setEach, { r: 0, g: 0, b: 0 }, extra);
  }

  // ---------- Text ----------

  private textSection(sel: string[], same: <T>(get: (id: string) => T) => T | null): HTMLElement {
    const { ed } = this;
    const doc = ed.doc;
    // Layer properties (alignment, box size) apply to the whole layer. Styling changes the
    // layout — imported pre-shaped glyphs are no longer valid.
    const setText = (fn: (id: string) => Props | null) =>
      doc.transact(() => {
        for (const id of sel) {
          const p = fn(id);
          if (!p) continue;
          if (doc.get(id, 'textGlyphs')) p.textGlyphs = undefined;
          doc.set(id, p);
        }
      });
    // Text editing on the canvas: styling applies to the text selection (without one — to the typing style).
    const te = this.textEditing;
    const editing = te && te.id && sel.length === 1 && sel[0] === te.id ? te : null;
    const loadFont = (f: { family: string; style: string }) =>
      void ed.fonts.ensure(f).then((ok) => ok || this.notify(`Шрифт «${f.family} ${f.style}» не найден — текст показан шрифтом по умолчанию`, 'error'));
    /** Resolved run styles: of the selection while editing, otherwise of the whole text of all layers. */
    const styles = (): EffectiveTextStyle[] =>
      editing
        ? editing.styles()
        : sel.flatMap((id) => {
            const p = doc.props(id);
            return textSegments(p.textRuns, Math.max(1, (p.characters ?? '').length)).map((s) => effectiveStyle(p, s.style));
          });
    /** Styling value: the same across all runs — that value, different — null (“Mixed”). */
    const styleValue = <K extends TextStyleKey>(key: K): NodeProps[K] | null => {
      if (editing) {
        const v = editing.value(key);
        return v === MIXED ? null : v;
      }
      const MIX = '\u0000mixed';
      const v = same((id) => {
        const p = doc.props(id);
        const len = (p.characters ?? '').length;
        const r = rangeValue(p, p.textRuns, len, 0, len, key);
        return r === MIXED ? MIX : r;
      });
      return v === MIX ? null : (v as NodeProps[K] | null);
    };
    /** Change styling: fn receives a run's resolved style and returns the new values. */
    const restyle = (fn: (s: EffectiveTextStyle) => TextStyle, paragraph = false) => {
      if (editing) editing.apply(fn, paragraph);
      else doc.transact(() => sel.forEach((id) => restyleText(doc, id, 0, (doc.get(id, 'characters') ?? '').length, fn, paragraph)));
      for (const id of sel) for (const f of textFonts(doc.props(id))) loadFont(f);
    };
    const all = styles();
    const family = all.length && all.every((s) => s.fontName.family === all[0]!.fontName.family) ? all[0]!.fontName.family : null;
    const style = all.length && all.every((s) => s.fontName.style === all[0]!.fontName.style) ? all[0]!.fontName.style : null;

    // Font and style via string variables: “=” in the font field, a button next to the style.
    // The binding applies to the whole layer (not available while editing part of the text).
    const bindIds = this.textEditing?.active ? null : sel;
    const pickVar = (field: 'fontFamily' | 'fontStyle', anchor: HTMLElement, current: string | null) =>
      bindIds &&
      openVariablePicker(ed, anchor, {
        types: ['STRING'],
        field,
        nodeId: bindIds[0],
        nodeType: 'TEXT',
        current,
        onPick: (v) => bindFields(ed, bindIds, [field], v),
        onOpenWindow: () => openVariablesWindow(ed),
      });
    const boundFamily = bindIds ? boundOf(doc, bindIds, ['fontFamily']) : null;
    const boundStyle = bindIds ? boundOf(doc, bindIds, ['fontStyle']) : null;
    const boundField = (field: 'fontFamily' | 'fontStyle', v: string, wide: boolean) =>
      h('div', { class: `field var-field${wide ? ' wide' : ''}` }, variablePill(ed, v, { nodeId: sel[0], onPick: (a) => pickVar(field, a, v), onDetach: () => bindFields(ed, sel, [field], null) }));

    const familyInput = h('input', { value: family ?? 'Разные', placeholder: 'Шрифт' }) as HTMLInputElement;
    if (bindIds) familyInput.title = 'Шрифт; «=» — привязать к переменной';
    familyInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') familyInput.blur();
      if (e.key === '=' && bindIds) {
        e.preventDefault();
        pickVar('fontFamily', familyInput.parentElement!, null);
      }
    });
    familyInput.addEventListener('change', () => {
      const v = familyInput.value.trim();
      if (!v) return this.schedule();
      restyle((s) => ({ fontName: { family: v, style: s.fontName.style } }));
    });
    const families = this.fontFamilies();
    // List with preview: arrow next to the field or click on the field.
    const pickerBtn = svgEl('button', { class: 'fp-open', title: 'Все шрифты с предпросмотром' }, ICON.chevronDown) as HTMLButtonElement;
    const openPicker = () =>
      openFontPicker(familyInput.parentElement!, {
        families,
        current: family,
        fonts: ed.fonts,
        onPick: (v) => restyle((s) => ({ fontName: { family: v, style: s.fontName.style } })),
      });
    pickerBtn.addEventListener('click', openPicker);
    familyInput.addEventListener('dblclick', openPicker);
    // Style preview: list rows, each in its own weight and slant.
    const list = h('span');
    // A custom font — its real styles; otherwise the standard set.
    const own = family ? ed.fonts.localStyles(family) : [];
    const base = own.length ? own : STYLES;
    const styleList = style && !base.includes(style) ? [style, ...base] : base;
    const styleSelect = h(
      'select',
      {},
      ...styleList.map((s) => {
        const o = h('option', { value: s, selected: s === style }, s) as HTMLOptionElement;
        const w = styleWeight(s);
        o.style.fontWeight = String(w.weight);
        if (w.italic) o.style.fontStyle = 'italic';
        return o;
      }),
    ) as HTMLSelectElement;
    if (style === null) styleSelect.prepend(h('option', { value: '', selected: true, disabled: true }, 'Разные'));
    styleSelect.addEventListener('change', () => {
      const v = styleSelect.value;
      restyle((s) => ({ fontName: { family: s.fontName.family, style: v } }));
    });

    // Spacing field: text with a unit (“150%”, “24”, “Auto”); field — variable binding (“=”),
    // a bound one shows as a variable pill (the unit belongs to the variable: %, unitless, rem).
    const textField = (label: string, title: string, value: string, apply: (s: string) => boolean, field?: 'lineHeight' | 'letterSpacing') => {
      const bound = field && bindIds ? boundOf(doc, bindIds, [field]) : null;
      const pick = (anchor: HTMLElement, current: string | null) =>
        field &&
        bindIds &&
        openVariablePicker(ed, anchor, {
          types: ['FLOAT'],
          field,
          nodeId: bindIds[0],
          nodeType: 'TEXT',
          current,
          onPick: (v) => bindFields(ed, bindIds, [field], v),
          onOpenWindow: () => openVariablesWindow(ed),
        });
      if (field && bound) return h('div', { class: 'field var-field', title }, h('label', {}, label), variablePill(ed, bound, { nodeId: sel[0], onPick: (a) => pick(a, bound), onDetach: () => bindFields(ed, sel, [field], null) }));
      const input = h('input', { value }) as HTMLInputElement;
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
        if (e.key === '=' && field && bindIds) {
          e.preventDefault();
          pick(input.parentElement!, null);
        }
      });
      input.addEventListener('change', () => apply(input.value) || this.schedule());
      const lab = h('label', {}, label);
      // Label scrubbing: line height “Auto” starts from 120 %, letter spacing from zero.
      this.scrubText(lab, input, (t) => void apply(t), { fallback: field === 'lineHeight' ? '120%' : '0%', min: field === 'lineHeight' ? 0 : undefined });
      const variableButton = field && bindIds ? svgEl('button', { type: 'button', class: 'field-variable-button', title: 'Выбрать переменную', 'aria-label': `Выбрать переменную: ${title}`, onclick: (e: MouseEvent) => pick(e.currentTarget as HTMLElement, null) }, ICON.variable) : null;
      return h('div', { class: 'field', title: field && bindIds ? `${title}; «=» — переменная` : title }, lab, input, ...(variableButton ? [variableButton] : []));
    };
    const lh = styleValue('lineHeight') as LineHeight | null;
    const ls = styleValue('letterSpacing') as LetterSpacing | null;

    const segmented = <V extends string>(options: [V, string, string][], current: V | null, pick: (v: V) => void) =>
      h(
        'div',
        { class: 'seg' },
        ...options.map(([v, icon, title]) => {
          const b = h('button', { class: v === current ? 'on' : '', title, onclick: () => pick(v) });
          b.innerHTML = icon;
          return b;
        }),
      );
    const align = same((id) => doc.get(id, 'textAlignHorizontal') ?? 'LEFT');
    const alignV = same((id) => doc.get(id, 'textAlignVertical') ?? 'TOP');
    const textCase = styleValue('textCase');
    const decoration = styleValue('textDecoration');
    // Typography via a composite variable (our own): font, style, size and spacing at once.
    const boundTypo = bindIds ? boundOf(doc, bindIds, ['typography']) : null;
    const pickTypo = (anchor: HTMLElement) =>
      bindIds && openVariablePicker(ed, anchor, { types: ['TYPOGRAPHY'], field: 'typography', nodeId: bindIds[0], nodeType: 'TEXT', current: boundTypo, onPick: (v) => bindFields(ed, bindIds, ['typography'], v), onOpenWindow: () => openVariablesWindow(ed) });
    const typoBtn = bindIds && !boundTypo ? (svgEl('button', { class: 'hover-act', title: 'Типографика из переменной' }, ICON.variable) as HTMLButtonElement) : null;
    typoBtn?.addEventListener('click', () => pickTypo(typoBtn));
    const typoPill = boundTypo ? h('div', { class: 'wide var-field' }, variablePill(ed, boundTypo, { nodeId: bindIds![0], onPick: pickTypo, onDetach: () => bindFields(ed, bindIds!, ['typography'], null) })) : '';

    // Words and characters of the selected texts (our own).
    const stats = sel.map((id) => textStats(doc.get(id, 'characters') ?? '')).reduce((a, b) => ({ words: a.words + b.words, chars: a.chars + b.chars, charsNoSpaces: a.charsNoSpaces + b.charsNoSpaces }), { words: 0, chars: 0, charsNoSpaces: 0 });
    // Length limit (our own): for a single text — “80/100”, overflow in red.
    const maxLen = sel.length === 1 ? doc.get(sel[0]!, 'textMaxLength') : undefined;
    const minLen = sel.length === 1 ? doc.get(sel[0]!, 'textMinLength') : undefined;
    const len = sel.length === 1 ? textLength(doc.get(sel[0]!, 'characters') ?? '') : stats.chars;
    const bad = (!!maxLen && len > maxLen) || (!!minLen && len < minLen);
    const statsEl = h(
      'span',
      { class: `text-stats${bad ? ' over' : ''}`, title: `Слов: ${stats.words}; символов: ${stats.chars} (без пробелов: ${stats.charsNoSpaces})${maxLen ? `; лимит ${maxLen}` : ''}${minLen ? `; минимум ${minLen}` : ''}` },
      `${stats.words} сл. · ${maxLen ? `${len}/${maxLen}` : stats.chars} симв.`,
    );
    // Text settings: case, decorations, lists, paragraphs, truncation, OpenType.
    const moreBtn = this.iconButton(ICON.settings, 'Настройки текста: регистр, подчёркивание, списки, абзацы, обрезка, OpenType', () => this.settingsToggle('text', this.textMore, (on) => (this.textMore = on)), { on: this.textMore });
    moreBtn.setAttribute('aria-pressed', String(this.textMore));
    // Case and decoration are in the settings popup; the ones set are also visible in the section while the popup is closed.
    const showCase = !this.textMore && textCase !== 'ORIGINAL' && textCase !== undefined;
    const showDecoration = !this.textMore && decoration !== 'NONE' && decoration !== undefined;
    const caseSeg = () =>
      segmented(
        [
          ['ORIGINAL', '—', 'Регистр как есть'],
          ['UPPER', 'AA', 'Все прописные'],
          ['LOWER', 'aa', 'Все строчные'],
          ['TITLE', 'Aa', 'Каждое слово с прописной'],
        ],
        textCase as 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | null,
        (v) => restyle(() => ({ textCase: v })),
      );
    const decoSeg = () =>
      segmented(
        [
          ['NONE', '—', 'Без линии'],
          ['UNDERLINE', '<u>U</u>', 'Подчёркнутый'],
          ['STRIKETHROUGH', '<s>S</s>', 'Зачёркнутый'],
        ],
        decoration,
        (v) => restyle(() => ({ textDecoration: v })),
      );
    const varBtn = this.textVariableButton(sel);
    if (varBtn instanceof HTMLElement && !varBtn.classList.contains('on')) varBtn.classList.add('hover-act');
    const section = h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Текст', h('span', { class: 'h-acts' }, varBtn, typoBtn ?? '')),
      h(
        'div',
        { class: 'props' },
        typoPill,
        boundFamily ? boundField('fontFamily', boundFamily, true) : h('div', { class: 'field wide' }, familyInput, list, pickerBtn),
        boundStyle
          ? boundField('fontStyle', boundStyle, false)
          : h(
              'div',
              { class: 'field' },
              styleSelect,
              ...(bindIds
                ? [
                    (() => {
                      const b = svgEl('button', { class: 'icon-btn sm hover-var', title: 'Начертание — переменной' }, ICON.variable) as HTMLButtonElement;
                      b.addEventListener('click', () => pickVar('fontStyle', b.parentElement!, null));
                      return b;
                    })(),
                  ]
                : []),
            ),
        (() => {
          const size = this.numField('Aa', styleValue('fontSize'), (v) => (restyle(() => ({ fontSize: Math.max(1, Math.min(2000, v)) })), null), (fn) => fn(sel[0]!), false, { bind: this.textEditing?.active ? undefined : { ids: sel, fields: ['fontSize'] } });
          const pickSize: HTMLButtonElement = svgEl('button', {
            type: 'button',
            class: 'size-pick',
            title: 'Готовые размеры',
            onclick: () => {
              const r = size.getBoundingClientRect();
              const cur = styleValue('fontSize');
              showMenuAt(r.left, r.bottom + 4, [10, 11, 12, 13, 14, 15, 16, 20, 24, 32, 36, 40, 48, 64, 96, 128].map((n) => ({ label: String(n), checked: cur === n, run: () => restyle(() => ({ fontSize: n })) })));
            },
          }, ICON.chevronDown) as HTMLButtonElement;
          size.classList.add('has-pick');
          size.append(pickSize);
          return size;
        })(),
        this.labeled('Межстрочный', textField('↕', 'Межстрочный интервал: Авто, пиксели или % кегля', lh ? formatLineHeight(lh) : 'Разные', (s) => {
          const v = parseLineHeight(s);
          if (v) restyle(() => ({ lineHeight: v }));
          return !!v;
        }, 'lineHeight')),
        this.labeled('Межбуквенный', textField('↔', 'Межбуквенный интервал: % кегля или px', ls ? formatLetterSpacing(ls) : 'Разные', (s) => {
          const v = parseLetterSpacing(s, ls ?? { unit: 'PERCENT', value: 0 });
          if (v) restyle(() => ({ letterSpacing: v }));
          return !!v;
        }, 'letterSpacing')),
        this.caption('Выравнивание'),
        h(
          'div',
          { class: 'prow' },
          segmented(
            [
              ['LEFT', ALIGN_ICONS.LEFT, 'По левому краю'],
              ['CENTER', ALIGN_ICONS.CENTER, 'По центру'],
              ['RIGHT', ALIGN_ICONS.RIGHT, 'По правому краю'],
              ['JUSTIFIED', ALIGN_ICONS.JUSTIFIED, 'По ширине'],
            ],
            align,
            (v) => setText(() => ({ textAlignHorizontal: v })),
          ),
          segmented(
            [
              ['TOP', '⤒', 'Сверху'],
              ['CENTER', '⇕', 'По центру'],
              ['BOTTOM', '⤓', 'Снизу'],
            ],
            alignV,
            (v) => setText(() => ({ textAlignVertical: v })),
          ),
          moreBtn,
        ),
        showCase || showDecoration ? this.caption('Регистр и линия') : '',
        !showCase ? '' : caseSeg(),
        !showDecoration ? '' : decoSeg(),
      ),
    );
    // “Text settings” popup: case, decoration, paragraphs, OpenType; counter and computer fonts at the bottom.
    if (this.textMore) {
      const foot = h('div', { class: 'text-foot wide' }, statsEl, h(
        'button',
        {
          class: 'link-btn',
          title: 'Шрифты, установленные на компьютере (Chrome, Edge). Файлы .ttf, .otf, .woff и .woff2 можно перетащить на окно',
          onclick: () => this.onLocalFonts?.(),
        },
        ed.fonts.localFamilies.length ? `Свои шрифты: ${ed.fonts.localFamilies.length}` : 'Шрифты компьютера…',
      ));
      this.settingsPop('text', moreBtn, 'Настройки текста', [this.caption('Регистр'), caseSeg(), this.caption('Линия'), decoSeg(), ...this.textMoreRows(sel, same, setText, styleValue, restyle), foot], () => (this.textMore = false));
    }
    return section;
  }

  /**
   * Advanced (the Advanced checkbox): lists, paragraph spacing and indent, “…” truncation and line
   * count, vertical trim, Balance / Pretty wrapping, underline style, link, OpenType.
   */
  private textMoreRows(
    sel: string[],
    same: <T>(get: (id: string) => T) => T | null,
    setText: (fn: (id: string) => Props | null) => void,
    styleValue: <K extends TextStyleKey>(key: K) => NodeProps[K] | null,
    restyle: (fn: (s: EffectiveTextStyle) => TextStyle, paragraph?: boolean) => void,
  ): HTMLElement[] {
    const doc = this.ed.doc;
    if (!this.textMore) return [];
    const rows: HTMLElement[] = [];
    const seg = <V extends string>(options: [V, string, string][], current: V | null, pick: (v: V) => void) =>
      h('div', { class: 'seg wide' }, ...options.map(([v, label, title]) => h('button', { class: v === current ? 'on' : '', title, onclick: () => pick(v) }, label)));
    // Lists apply to whole paragraphs.
    rows.push(
      seg(
        [
          ['NONE', 'Без списка', 'Обычные абзацы'],
          ['UNORDERED', '• Маркеры', 'Маркированный список (Ctrl+Shift+8)'],
          ['ORDERED', '1. Номера', 'Нумерованный список (Ctrl+Shift+7)'],
        ],
        styleValue('listType'),
        (v) => restyle(() => ({ listType: v }), true),
      ),
    );
    rows.push(
      this.checkRow(same((id) => doc.get(id, 'hangingPunctuation') ?? false), 'Висячая пунктуация', 'Кавычки, скобки и тире в начале строки — за краем блока, буквы — по краю', (on) => setText(() => ({ hangingPunctuation: on }))),
      this.checkRow(same((id) => doc.get(id, 'hangingList') ?? false), 'Висячие маркеры', 'Маркеры и номера списка — за краем блока, текст пунктов — по краю', (on) => setText(() => ({ hangingList: on }))),
    );
    const num = (label: string, key: 'paragraphSpacing' | 'paragraphIndent' | 'listSpacing', title: string) =>
      this.numField(label, same((id) => doc.get(id, key) ?? 0), (v) => ({ [key]: Math.max(0, v) }) as Props, setText, false, { title, bind: key === 'listSpacing' ? undefined : { ids: sel, fields: [key] } });
    rows.push(h('div', { class: 'prow' }, num('¶↕', 'paragraphSpacing', 'Интервал между абзацами, px'), num('¶→', 'paragraphIndent', 'Отступ первой строки абзаца, px')));
    rows.push(h('div', { class: 'prow' }, num('•↕', 'listSpacing', 'Интервал между пунктами списка, px'), h('span')));
    // Length limit and width in characters (our own; requests “max and min character on text property”,
    // “use character count for max width”).
    rows.push(
      h(
        'div',
        { class: 'prow' },
        this.numField('Макс.', same((id) => doc.get(id, 'textMaxLength') ?? null), (v) => ({ textMaxLength: v >= 1 ? Math.round(v) : undefined }), setText, false, { title: 'Лимит длины, символов: длиннее — подсветка на холсте и в «Проверке дизайна» (текст не обрезается); пусто — без лимита', onEmpty: () => ({ textMaxLength: undefined }), blank: true }),
        this.numField('Мин.', same((id) => doc.get(id, 'textMinLength') ?? null), (v) => ({ textMinLength: v >= 1 ? Math.round(v) : undefined }), setText, false, { title: 'Не короче, символов; пусто — без минимума', onEmpty: () => ({ textMinLength: undefined }), blank: true }),
      ),
    );
    rows.push(
      h(
        'div',
        { class: 'prow' },
        this.numField('ch', same((id) => {
          const ch = this.ed.chWidth(id);
          const w = doc.get(id, 'width') ?? 0;
          return ch ? Math.round((w / ch) * 10) / 10 : null;
        }), (v, id) => {
          const ch = this.ed.chWidth(id);
          return ch && v > 0 ? { width: Math.round(v * ch * 100) / 100, textAutoResize: 'HEIGHT' } : null;
        }, setText, false, { title: 'Ширина блока в символах (как ch в CSS: ширина «0» этим шрифтом); высота — по тексту. Удобно для длины строки 45–75 символов' }),
        h('span'),
      ),
    );
    // “…” truncation and line count.
    const trunc = same((id) => doc.get(id, 'textTruncation') ?? 'DISABLED');
    const maxLines = same((id) => doc.get(id, 'maxLines') ?? null);
    rows.push(
      h(
        'div',
        { class: 'prow' },
        this.checkRow(trunc === 'ENDING' ? true : trunc === null ? null : false, 'Обрезать «…»', 'Не поместилось — многоточие в конце', (on) => setText(() => ({ textTruncation: on ? 'ENDING' : 'DISABLED' }))),
        this.numField('≡', maxLines, (v) => ({ maxLines: v >= 1 ? Math.round(v) : null }), setText, false, { title: 'Не больше строк (пусто — без ограничения)', onEmpty: () => ({ maxLines: null }), blank: true }),
      ),
    );
    // Vertical trim and line wrapping.
    const trim = same((id) => doc.get(id, 'leadingTrim') ?? 'NONE');
    rows.push(this.checkRow(trim === 'CAP_HEIGHT' ? true : trim === null ? null : false, 'Обрезать по высоте прописных', 'Блок текста — от верха прописных до базовой линии (удобно для кнопок)', (on) => setText(() => ({ leadingTrim: on ? 'CAP_HEIGHT' : 'NONE' }))));
    rows.push(
      seg(
        [
          ['AUTO', 'Перенос: обычный', 'Строки заполняются до края'],
          ['BALANCE', 'Ровный', 'Строки примерно одной длины (Balance)'],
          ['PRETTY', 'Без вдовы', 'Последняя строка — не из одного слова (Pretty)'],
        ],
        same((id) => doc.get(id, 'textWrap') ?? 'AUTO'),
        (v) => setText(() => ({ textWrap: v })),
      ),
    );
    // Text decoration when present: underline has style, thickness, offset, skip ink and color;
    // strikethrough has thickness and color.
    const deco = styleValue('textDecoration');
    if (deco === 'UNDERLINE' || deco === 'STRIKETHROUGH') {
      const under = deco === 'UNDERLINE';
      if (under)
        rows.push(
          seg(
            [
              ['SOLID', '—', 'Сплошное'],
              ['DOTTED', '···', 'Точками'],
              ['WAVY', '∿', 'Волной'],
            ],
            styleValue('textDecorationStyle'),
            (v) => restyle(() => ({ textDecorationStyle: v })),
          ),
        );
      const lengthField = (label: string, title: string, key: 'textDecorationThickness' | 'textDecorationOffset') => {
        const input = h('input', { value: lengthText(styleValue(key)) }) as HTMLInputElement;
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') input.blur();
        });
        input.addEventListener('change', () => {
          const v = parseLength(input.value);
          if (v) restyle(() => ({ [key]: v }) as TextStyle);
          else this.schedule();
        });
        const lab = h('label', {}, label);
        this.scrubText(lab, input, (t) => {
          const v = parseLength(t);
          if (v) restyle(() => ({ [key]: v }) as TextStyle);
        }, { fallback: key === 'textDecorationThickness' ? '1px' : '0px', min: key === 'textDecorationThickness' ? 0 : undefined });
        return h('div', { class: 'field', title }, lab, input);
      };
      rows.push(
        h(
          'div',
          { class: 'prow' },
          lengthField('━', 'Толщина линии: Авто, px или % кегля', 'textDecorationThickness'),
          under ? lengthField('⇣', 'Отступ линии от базовой: Авто, px или % кегля', 'textDecorationOffset') : h('span'),
        ),
      );
      if (under) rows.push(this.checkRow(styleValue('textDecorationSkipInk'), 'Пропускать выносные', 'Линия обходит выносные элементы букв (у, р, д)', (on) => restyle(() => ({ textDecorationSkipInk: on }))));
      // Decoration color: same as text (Auto) or custom.
      const dc = styleValue('textDecorationColor');
      if (dc && dc !== 'AUTO') {
        rows.push(
          h(
            'div',
            { class: 'prow' },
            this.colorField('text-decoration', dc, (c) => restyle(() => ({ textDecorationColor: c }))),
            h('button', { class: 'link-btn tight', title: 'Цвет линии — как у текста', onclick: () => restyle(() => ({ textDecorationColor: 'AUTO' })) }, 'Авто'),
          ),
        );
      } else {
        const fill = styleValue('fills')?.find((p) => p.type === 'SOLID' && p.visible !== false);
        const start: RGBA = fill?.type === 'SOLID' ? { ...fill.color, a: fill.opacity ?? 1 } : { r: 0, g: 0, b: 0, a: 1 };
        rows.push(h('button', { class: 'link-btn wide', title: 'Свой цвет линии', onclick: () => restyle(() => ({ textDecorationColor: start })) }, dc === null ? 'Цвет линии: разный' : 'Цвет линии: как у текста · задать свой'));
      }
    }
    // Link on the selection.
    const link = styleValue('hyperlink');
    if (link) rows.push(h('div', { class: 'empty wide', title: link.value }, `Ссылка: ${link.value}`));
    // OpenType: common features.
    const features = styleValue('openTypeFeatures') ?? {};
    const OT: [string, string, string][] = [
      ['liga', 'Лигатуры', 'Стандартные лигатуры (fi, fl)'],
      ['dlig', 'Доп. лигатуры', 'Дискреционные лигатуры'],
      ['tnum', 'Табличные цифры', 'Цифры одной ширины'],
      ['onum', 'Старые цифры', 'Цифры с выносными элементами'],
      ['zero', 'Ноль с чертой', 'Перечёркнутый ноль'],
      ['frac', 'Дроби', '1/2 → ½'],
      ['ss01', 'Набор 1', 'Стилистический набор 1'],
      ['ss02', 'Набор 2', 'Стилистический набор 2'],
    ];
    const defaultsOn = new Set(['liga', 'calt', 'kern']);
    rows.push(
      h(
        'div',
        { class: 'ot-row wide' },
        ...OT.map(([tag, label, title]) => {
          const on = features[tag] ?? defaultsOn.has(tag);
          return h(
            'button',
            {
              class: `ot ${on ? 'on' : ''}`,
              title: `${title} (${tag})`,
              onclick: () =>
                restyle((s) => {
                  const next = { ...(s.openTypeFeatures ?? {}) };
                  if (!on === defaultsOn.has(tag)) delete next[tag];
                  else next[tag] = !on;
                  return { openTypeFeatures: next };
                }),
            },
            label,
          );
        }),
      ),
    );
    // Variable font axes: sliders (a drag is one undo step).
    const font = styleValue('fontName');
    if (font) {
      const axes = this.ed.fonts.knownAxes(font.family);
      if (axes === undefined) void this.ed.fonts.axes(font.family).then((a) => a && this.schedule());
      else if (axes) {
        const current = styleValue('fontVariations');
        const weight = styleWeight(font.style).weight;
        rows.push(
          h(
            'div',
            { class: 'axes-head' },
            h('span', { title: 'Шрифт вариативный: начертание можно настроить по осям' }, 'Оси шрифта'),
            current?.length ? h('button', { class: 'link-btn', title: 'Начертание как есть', onclick: () => restyle(() => ({ fontVariations: [] })) }, 'Сбросить') : h('span'),
          ),
        );
        for (const a of axes) {
          const value = current === null ? null : (current.find((x) => x.axis === a.tag)?.value ?? (a.tag === 'wght' ? Math.max(a.min, Math.min(a.max, weight)) : a.default));
          rows.push(this.axisRow(a, value, (v) => restyle((st) => ({ fontVariations: withAxis(st.fontVariations ?? [], a.tag, v) }))));
        }
      }
    }
    // Small caps are under case.
    rows.push(
      seg(
        [
          ['ORIGINAL', 'Капитель: нет', 'Без капители'],
          ['SMALL_CAPS', 'Капитель', 'Строчные — малыми прописными (smcp)'],
          ['SMALL_CAPS_FORCED', 'Вся', 'И прописные — малыми прописными'],
        ],
        (styleValue('textCase') === 'SMALL_CAPS' || styleValue('textCase') === 'SMALL_CAPS_FORCED' ? styleValue('textCase') : 'ORIGINAL') as 'ORIGINAL' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED',
        (v) => restyle(() => ({ textCase: v })),
      ),
    );
    return rows;
  }

  /** Font axis: label, slider and number; dragging the slider is one undo step. */
  private axisRow(a: FontAxis, value: number | null, set: (v: number) => void): HTMLElement {
    const doc = this.ed.doc;
    const name = AXIS_NAMES[a.tag] ?? a.tag;
    const range = h('input', { type: 'range', min: String(a.min), max: String(a.max), step: String(a.step), value: String(value ?? a.default) }) as HTMLInputElement;
    const num = h('input', { class: 'axis-num', value: value === null ? 'Разные' : fmt(value) }) as HTMLInputElement;
    let live = false;
    const end = () => {
      if (!live) return;
      live = false;
      doc.endGroup();
      this.scrubbing = false;
      this.schedule();
    };
    range.addEventListener('pointerdown', () => {
      if (live) return;
      live = true;
      this.scrubbing = true;
      doc.beginGroup();
      document.addEventListener('pointerup', end, { once: true });
    });
    range.addEventListener('input', () => {
      const v = Number(range.value);
      num.value = fmt(v);
      set(v);
    });
    range.addEventListener('change', end);
    num.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') num.blur();
    });
    num.addEventListener('change', () => {
      const v = Number(num.value.replace(',', '.'));
      if (Number.isFinite(v)) set(Math.max(a.min, Math.min(a.max, v)));
      else this.schedule();
    });
    return h('div', { class: 'axis-row', title: `${name} (${a.tag}): ${fmt(a.min)}–${fmt(a.max)}` }, h('label', {}, name), range, num);
  }

  /** Document units, if not pixels. */
  private docUnits(): DocumentUnits | undefined {
    const u = this.ed.doc.get(this.ed.doc.root, 'documentUnits');
    return u && u.unit !== 'px' ? u : undefined;
  }

  private numField(
    label: string,
    value: number | null,
    toProps: (v: number, id: string) => Props | null,
    setEach: (fn: (id: string) => Props | null) => void,
    wide = false,
    opts: {
      unit?: string;
      title?: string;
      onEmpty?: (id: string) => Props | null;
      bind?: { ids: string[]; fields: string[]; type?: VariableType };
      /** Input ending with % (for W and H — percent of parent); absent — the field doesn't accept percent. */
      onPercent?: (v: number) => void;
      /** Field text instead of a number (for a size in percent — “50%”). */
      display?: string;
      /** Length: display and input in document units (mm, cm, inches, pt), the value in px. */
      length?: boolean;
      /** Optional value (limits): absent — an empty field with “—”, drag starts from zero. */
      blank?: boolean;
      /** The field value is a percentage (display “30%”): dragging changes the percent (onPercent), not pixels. */
      scrubPercent?: boolean;
    } = {},
  ) {
    const bind = opts.bind && opts.bind.ids.length && !opts.bind.ids.some((id) => this.ed.doc.type(id) === 'STYLE') ? opts.bind : null;
    const pick = (anchor: HTMLElement, current: string | null) =>
      bind &&
      openVariablePicker(this.ed, anchor, {
        types: [bind.type ?? 'FLOAT'],
        field: bind.fields[0]!,
        nodeId: bind.ids[0],
        nodeType: this.ed.doc.type(bind.ids[0]!),
        current,
        onPick: (v) => bindFields(this.ed, bind.ids, bind.fields, v),
        onOpenWindow: () => openVariablesWindow(this.ed),
      });
    const boundVar = bind ? boundOf(this.ed.doc, bind.ids, bind.fields) : null;
    if (bind && boundVar) {
      const lab = h('label', { title: opts.title ?? '' });
      if (label.startsWith('<svg')) lab.innerHTML = label;
      else lab.textContent = label;
      return h('div', { class: `field var-field ${wide ? 'wide' : ''}`, title: opts.title ?? '' }, ...(label ? [lab] : []), variablePill(this.ed, boundVar, { nodeId: bind.ids[0], onPick: (a) => pick(a, boundVar), onDetach: () => bindFields(this.ed, bind.ids, bind.fields, null) }));
    }
    // Document units for length fields: shown in them, input in them or with any unit (“5mm”).
    const lu = opts.length ? this.docUnits() : undefined;
    const k = lu ? pxPerUnit(lu.unit, lu.dpi) : 1;
    const show = (px: number) => (lu ? formatLength(px, lu) : fmt(px));
    const shown = () => opts.display ?? (value === null ? (opts.blank ? '' : 'Разные') : show(value));
    const input = h('input', { value: shown(), placeholder: opts.blank ? '—' : '' }) as HTMLInputElement;
    // Formulas and units as in CSS: “100/3”, “1.5rem + 8”, “50%”, “10mm” (core/units.ts).
    const rem = this.ed.doc.get(this.ed.doc.root, 'rootFontSize') ?? ROOT_FONT_SIZE;
    if (bind) {
      input.title = 'Значение; «=» — привязать к переменной';
      input.addEventListener('keydown', (e) => {
        if (e.key !== '=') return;
        e.preventDefault();
        e.stopPropagation();
        pick(input.parentElement!, null);
      });
    }
    const commit = () => {
      if (opts.onEmpty && !input.value.trim()) return setEach(opts.onEmpty);
      if (input.value === shown()) return;
      const r = evaluateNumberInput(input.value, rem, lu);
      if (!r || (r.percent && !opts.onPercent)) return this.schedule();
      if (r.percent) return opts.onPercent!(r.value);
      setEach((id) => toProps(r.value, id));
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Enter removes focus; the value is applied once on the change event.
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        input.value = shown();
        input.blur();
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        const cur = evaluateNumberInput(input.value, rem, lu);
        // Percent — by percent step; number — by number step (for lengths — by document unit step).
        if (cur?.percent && opts.onPercent) {
          const p = Math.max(1, cur.value + step);
          input.value = `${fmt(p)}%`;
          return opts.onPercent(p);
        }
        const v = (cur?.value ?? (value ?? 0)) + step * k;
        input.value = show(v);
        setEach((id) => toProps(v, id));
      }
    });
    input.addEventListener('change', commit);
    const lab = h('label', { title: opts.title ? `${opts.title}: тяните влево-вправо (Shift — шаг 10, Alt — медленнее, Ctrl — быстрее)` : 'Тяните влево-вправо (Shift — шаг 10, Alt — медленнее, Ctrl — быстрее)' });
    if (label.startsWith('<svg')) lab.innerHTML = label;
    else lab.textContent = label;
    // Label scrubbing changes the value; the whole drag is one undo step.
    lab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Dragging always works in numbers (for percent — from the current size).
      const start = opts.display !== undefined ? (value ?? NaN) / k : opts.blank && !input.value.trim() ? 0 : Number(input.value.replace(',', '.'));
      if (!Number.isFinite(start)) return; // “Mixed”
      e.preventDefault();
      const pctStart = opts.display !== undefined ? parseFloat(opts.display.replace(',', '.')) : NaN;
      if (opts.scrubPercent && opts.onPercent && Number.isFinite(pctStart)) {
        const onPercent = opts.onPercent;
        this.scrub(lab, e, pctStart, (v) => {
          const p = Math.max(0, v);
          input.value = `${fmt(p)}%`;
          onPercent(p);
        });
        return;
      }
      this.scrub(lab, e, start, (v) => {
        input.value = lu ? String(Math.round(v * 1000) / 1000) : fmt(v);
        setEach((id) => toProps(v * k, id));
      });
    });
    const field = h('div', { class: `field ${wide ? 'wide' : ''}` }, ...(label ? [lab] : []), input, ...(opts.unit || lu ? [h('span', { class: 'unit' }, opts.unit ?? UNIT_LABEL[lu!.unit])] : []));
    if (bind) field.append(svgEl('button', { type: 'button', class: 'field-variable-button', title: 'Выбрать переменную', 'aria-label': 'Выбрать переменную', onclick: (e: MouseEvent) => pick(e.currentTarget as HTMLElement, null) }, ICON.variable));
    if (opts.title) field.title = opts.title;
    return field;
  }

  /**
   * Label scrubbing for a text field (number with a unit: “2%”, “24px”, “150%”): the number changes,
   * the unit stays, commit applies the text; the whole drag is one undo step. fallback — where to
   * start if the field has no number (“Auto”, “Mixed”).
   */
  private scrubText(lab: HTMLElement, input: HTMLInputElement, commit: (text: string) => void, opts: { fallback?: string; min?: number; max?: number; step?: number } = {}) {
    lab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('input, select, button')) return;
      const parsed = numberInText(input.value) ?? (opts.fallback ? numberInText(opts.fallback) : null);
      if (!parsed) return;
      e.preventDefault();
      // step — value per pixel of drag (0.1 for fractional parameters).
      const k = opts.step ?? 1;
      const start = parsed.value;
      this.scrub(lab, e, start, (v) => {
        const x = Math.round((start + (v - start) * k) * 1000) / 1000;
        input.value = parsed.with(Math.max(opts.min ?? -Infinity, Math.min(opts.max ?? Infinity, x)));
        commit(input.value);
      });
    });
  }

  /**
   * Number scrubbing from the press point, without pointer lock and movementX jumps.
   * Shift — step 10, Alt — slow down ×10, Ctrl — speed up ×10.
   */
  private scrub(el: HTMLElement, e: PointerEvent, start: number, apply: (v: number) => void) {
    const doc = this.ed.doc;
    this.scrubbing = true;
    doc.beginGroup();
    const scrubValue = valueScrubber(start);
    const delta = scrubPointerDelta(e);
    let finished = false;
    let current = start;
    let cx = e.clientX;
    const cursor = h('div', { class: 'scrub-cursor', style: `left:${cx}px;top:${e.clientY}px` });
    cursor.innerHTML = SCRUB_CURSOR;
    document.body.append(cursor);
    document.body.classList.add('scrubbing');
    el.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = delta(ev);
      if (!dx) return;
      cx = ev.clientX;
      cursor.style.left = `${cx}px`;
      cursor.style.top = `${ev.clientY}px`;
      const v = scrubValue(dx, ev);
      if (v === current) return;
      current = v;
      apply(v);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      el.removeEventListener('lostpointercapture', finish);
      window.removeEventListener('blur', finish);
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      cursor.remove();
      document.body.classList.remove('scrubbing');
      doc.endGroup();
      this.scrubbing = false;
      this.schedule();
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(); };
    // Pointer events, not mouse events: after pointerdown is cancelled the browser doesn't send mouse events.
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    el.addEventListener('lostpointercapture', finish);
    window.addEventListener('blur', finish);
  }

  /** Color: swatch (click opens the picker) and hex. key — whose picker popup it is (one per field). */
  colorField(key: string, color: RGBA, onChange: (c: RGBA) => void, alpha = true) {
    const doc = this.ed.doc;
    refreshEditor(key, color);
    const text = h('input', { value: hex(color).slice(1) }) as HTMLInputElement;
    const swatch = h('button', { class: `swatch${paintEditorKey() === key ? ' open' : ''}`, 'data-pe-key': key, title: 'Палитра', style: `background:${swatchCss(color)}` });
    const field = h('div', { class: 'field wide' }, swatch, text);
    swatch.addEventListener('click', () =>
      openColorEditor({ key, anchor: field, color, alpha, onChange, onStart: () => doc.beginGroup(), onEnd: () => doc.endGroup(), docColors: this.docColors() }),
    );
    text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') text.blur();
    });
    text.addEventListener('change', () => {
      const c = parseHex(text.value);
      if (c) onChange({ ...c, a: color.a });
      else text.value = hex(color).slice(1);
    });
    return field;
  }
}

/** Scrub cursor: double-headed arrow. */
const SCRUB_CURSOR =
  '<svg width="22" height="14" viewBox="0 0 22 14"><path d="M1 7h20M1 7l5-5M1 7l5 5M21 7l-5-5M21 7l-5 5" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 7h20M1 7l5-5M1 7l5 5M21 7l-5-5M21 7l-5 5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Whether two panel trees have the same structure (same elements in the same order). */
function sameShape(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a instanceof HTMLInputElement && b instanceof HTMLInputElement && a.type !== b.type) return false;
  const ac = a.childNodes;
  const bc = b.childNodes;
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) if (!sameShape(ac[i]!, bc[i]!)) return false;
  return true;
}

/** Transfer values and styling from the new tree to the live one (the field with the text cursor is left alone). */
function patchValues(a: Node, b: Node) {
  if (a.nodeType === Node.TEXT_NODE) {
    if (a.textContent !== b.textContent) a.textContent = b.textContent;
    return;
  }
  if (a instanceof HTMLElement && b instanceof HTMLElement) {
    if (a.className !== b.className) a.className = b.className;
    const style = b.getAttribute('style');
    if (style !== a.getAttribute('style')) {
      if (style === null) a.removeAttribute('style');
      else a.setAttribute('style', style);
    }
    if ((a instanceof HTMLInputElement || a instanceof HTMLSelectElement) && a !== document.activeElement) {
      const v = (b as HTMLInputElement | HTMLSelectElement).value;
      if (a.value !== v) a.value = v;
    }
  }
  const ac = a.childNodes;
  const bc = b.childNodes;
  for (let i = 0; i < ac.length; i++) patchValues(ac[i]!, bc[i]!);
}

/** Rotation around a bounds point (fractions: [½, ½] — center): the corner position is recomputed. */
function rotateAround(doc: Document, id: string, degrees: number, origin: [number, number] = [0.5, 0.5]): Props {
  const t = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
  const w = (doc.get(id, 'width') ?? 0) * origin[0];
  const hgt = (doc.get(id, 'height') ?? 0) * origin[1];
  const cx = t[0] * w + t[1] * hgt + t[2];
  const cy = t[3] * w + t[4] * hgt + t[5];
  // A skewed layer rotates as a whole — skew and flip are preserved.
  const r = Math.abs(skewOf(t)) > 1e-6 ? withRotationKeepShape(t, degrees) : withRotation(t, degrees);
  return { transform: [r[0], r[1], cx - r[0] * w - r[1] * hgt, r[3], r[4], cy - r[3] * w - r[4] * hgt] };
}

/** Skew around the layer point origin (fractions of width and height): this point stays in place. */
function skewAround(doc: Document, id: string, degrees: number, origin: [number, number] = [0.5, 0.5]): Props {
  const t = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
  const w = (doc.get(id, 'width') ?? 0) * origin[0];
  const hgt = (doc.get(id, 'height') ?? 0) * origin[1];
  const cx = t[0] * w + t[1] * hgt + t[2];
  const cy = t[3] * w + t[4] * hgt + t[5];
  const r = withSkew(t, degrees);
  return { transform: [r[0], r[1], cx - r[0] * w - r[1] * hgt, r[3], r[4], cy - r[3] * w - r[4] * hgt] };
}
