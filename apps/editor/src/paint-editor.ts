// Paint popup (fill or stroke): paint type and blend mode; for solid — a color picker; for a
// gradient — a bar with stops (click adds a stop, Delete removes it) and the selected stop's color
// picker, handles on the canvas (gradient-handles.ts); for an image — replace, mode, rotation and
// adjustments; for a pattern — the source layer (picked on the canvas), grid, scale, spacing;
// for a shader — a preset shader, its parameters, animation and custom SkSL code.
// The color popup (shadow, page background) is the same frame with a single color picker.
//
// The popup identifies itself by key: the properties panel is rebuilt after every edit and reports
// the paint's new value (refreshEditor); if the row with that key is gone, the popup closes.

import type { BlendMode, ColorStop, GradientPaint, ImageFilters, ImagePaint, PatternPaint, ShaderPaint, VideoPaint, LottiePaint, Model3DPaint, Paint, RGBA } from '@mfp/core';
import { SHADER_PRESETS, SHADER_EFFECT_PRESETS, shaderParams, shaderUsesTime } from '@mfp/renderer';
import { resolveFigmaShader } from '@mfp/io-figma';
import { modal } from './dom.ts';
import { colorPicker, parseHex, toHex, type ColorPickerHandle } from './color-picker.ts';
import { colorAt, defaultTransform, rotateGradient, sortStops } from './gradient.ts';
import { defaultFreeform } from './freeform.ts';
import type { FreeformGradientPaint } from '@mfp/core';
import { numberDrag } from './number-drag.ts';
import { ICON } from './icons.ts';
import { showMenuAt } from './menu.ts';

interface Common {
  /** “Libraries” tab (color styles and variables); absent — only “Custom”. */
  library?: () => HTMLElement;
  /** Panel row key (one paint of one selection). */
  key: string;
  anchor: HTMLElement;
  /** Drag start and end: edits in between are one undo step. */
  onStart(): void;
  onEnd(): void;
  docColors: RGBA[];
}

export interface PaintEditorOptions extends Common {
  shaderKind?: 'effect';
  paint: Paint;
  /** Apply the paint (on every change). */
  onChange(p: Paint): void;
  /** Pick an image from disk: hash and width (or null — cancelled). */
  pickImage(): Promise<{ hash: string; width: number } | null>;
  /** Video from disk: hash in storage. */
  pickVideo?(): Promise<{ hash: string } | null>;
  /** Lottie from disk (.json, .lottie): hash in storage. */
  pickLottie?(): Promise<{ hash: string } | null>;
  /** 3D model from disk (.glb, .gltf): hash in storage; the model's clips (for the animation list). */
  pickModel?(): Promise<{ hash: string } | null>;
  modelInfo?(hash: string): Promise<{ clips: { name: string; duration: number }[] } | null>;
  /** Gradient opened (stop selected) or closed — show or hide the handles on the canvas. */
  onGradient?(state: { stop: number } | null): void;
  /** Crop the image with a frame on the canvas (absent — no button: e.g. for a style). */
  onCrop?(): void;
  /** Pattern: pick the source layer by clicking on the canvas (id or null — cancelled). */
  pickPatternSource?(): Promise<string | null>;
  /** Pattern: name of the source layer (null — no such layer). */
  patternSourceName?(id: string): string | null;
  /** Shader: code compilation error (null — compiles). */
  shaderError?(code: string): string | null;
}

export interface ColorEditorOptions extends Common {
  color: RGBA;
  alpha?: boolean;
  onChange(c: RGBA): void;
}

const TYPES: [Paint['type'], string][] = [
  ['SOLID', 'Сплошная'],
  ['GRADIENT_LINEAR', 'Линейный'],
  ['GRADIENT_RADIAL', 'Радиальный'],
  ['GRADIENT_ANGULAR', 'Угловой'],
  ['GRADIENT_DIAMOND', 'Ромб'],
  ['GRADIENT_FREEFORM', 'Свободный'],
  ['IMAGE', 'Картинка'],
  ['VIDEO', 'Видео'],
  ['LOTTIE', 'Lottie'],
  ['MODEL3D', '3D-модель'],
  ['PATTERN', 'Узор'],
  ['SHADER', 'Шейдер'],
];

export const BLEND_MODES: [BlendMode, string][] = [
  ['NORMAL', 'Обычный'],
  ['DARKEN', 'Затемнение'],
  ['MULTIPLY', 'Умножение'],
  ['LINEAR_BURN', 'Линейный затемнитель'],
  ['COLOR_BURN', 'Затемнение основы'],
  ['LIGHTEN', 'Замена светлым'],
  ['SCREEN', 'Экран'],
  ['LINEAR_DODGE', 'Линейный осветлитель'],
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

const FILTERS: [keyof ImageFilters, string][] = [
  ['exposure', 'Экспозиция'],
  ['contrast', 'Контраст'],
  ['saturation', 'Насыщенность'],
  ['temperature', 'Температура'],
  ['tint', 'Оттенок'],
  ['highlights', 'Света'],
  ['shadows', 'Тени'],
];

const isGradient = (p: Paint): p is GradientPaint => p.type !== 'SOLID' && p.type !== 'IMAGE' && p.type !== 'VIDEO' && p.type !== 'LOTTIE' && p.type !== 'MODEL3D' && p.type !== 'PATTERN' && p.type !== 'SHADER' && p.type !== 'GRADIENT_FREEFORM';

interface Open {
  key: string;
  close(): void;
  /** New value from the document (after undo, canvas handles, a panel edit). */
  update(v: Paint | RGBA): void;
  selectStop?(i: number): void;
  /** Delete with a gradient open: remove the selected stop (true — the popup took the key). */
  removeStop?(): boolean;
}

let current: Open | null = null;
let seen = false;
/** A canvas click hit a gradient handle — keep the popup open (wired up by main.ts). */
let canvasHit: (e: PointerEvent) => boolean = () => false;

export const setCanvasHit = (fn: (e: PointerEvent) => boolean) => (canvasHit = fn);
export const paintEditorKey = () => current?.key ?? null;
export const closePaintEditor = () => current?.close();
/** A gradient stop was selected on the canvas. */
export const selectPaintStop = (i: number) => current?.selectStop?.(i);

/** Keys while the popup is open (focus on the canvas): Delete on a gradient removes a stop, not the layer. */
export function paintEditorKeydown(e: KeyboardEvent): boolean {
  if ((e.key === 'Delete' || e.key === 'Backspace') && current?.removeStop?.()) {
    e.preventDefault();
    return true;
  }
  return false;
}

/** The panel starts rebuilding: note whether the open popup's row is encountered. */
export function beginRefresh() {
  seen = false;
}

/** Panel row with this key: pass the current value to the popup. */
export function refreshEditor(key: string, value: Paint | RGBA) {
  if (current?.key !== key) return;
  seen = true;
  current.update(value);
}

/** Panel rebuilt: the open popup's row is gone (selection changed, paint removed) — close. */
export function endRefresh() {
  if (current && !seen) current.close();
}

/** Popup frame: left of the properties panel, level with the swatch; Esc and outside click close it. */
function popover(opts: Common, onClose: () => void, keep: (e: PointerEvent) => boolean = () => false): { box: HTMLElement; close(): void; place(): void } {
  const box = document.createElement('div');
  box.className = 'paint-editor';
  document.body.append(box);
  const place = () => {
    const r = opts.anchor.getBoundingClientRect();
    const panel = document.getElementById('right')?.getBoundingClientRect();
    const x = (panel?.left ?? r.left) - box.offsetWidth - 8;
    const y = Math.max(8, Math.min(r.top - 40, innerHeight - box.offsetHeight - 8));
    box.style.left = `${Math.max(8, x)}px`;
    box.style.top = `${y}px`;
  };
  const onDown = (e: PointerEvent) => {
    const t = e.target as Element;
    if (box.contains(t)) return;
    // The swatch of this same row closes the popup itself (toggle).
    if (t.closest?.('[data-pe-key]')?.getAttribute('data-pe-key') === opts.key) return;
    if (keep(e)) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
    onClose();
  };
  return { box, close, place };
}

/** Convert a paint to another type, keeping the color (and the gradient — when switching gradient type). */
function convert(p: Paint, type: Paint['type']): Paint {
  if (p.type === type) return p;
  const base = { visible: p.visible, opacity: p.opacity, blendMode: p.blendMode };
  const firstColor = (): RGBA => (p.type === 'SOLID' ? { ...p.color, a: 1 } : p.type === 'GRADIENT_FREEFORM' && p.points[0] ? { ...p.points[0].color } : !isGradient(p) ? { r: 0.85, g: 0.85, b: 0.85, a: 1 } : { ...(p.gradientStops[0]?.color ?? { r: 0, g: 0, b: 0, a: 1 }) });
  if (type === 'SOLID') {
    const c = firstColor();
    return { ...base, type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } };
  }
  if (type === 'IMAGE') return { ...base, type: 'IMAGE', scaleMode: 'FILL', imageHash: null };
  if (type === 'VIDEO') return { ...base, type: 'VIDEO', scaleMode: 'FILL', videoHash: null };
  if (type === 'LOTTIE') return { ...base, type: 'LOTTIE', scaleMode: 'FIT', lottieHash: null };
  if (type === 'MODEL3D') return { ...base, type: 'MODEL3D', scaleMode: 'FIT', modelHash: null, camera: { yaw: 30, pitch: 15, zoom: 1 }, orbit: true };
  if (type === 'PATTERN') return { ...base, type: 'PATTERN', sourceNodeId: '', tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' };
  if (type === 'SHADER') return { ...base, type: 'SHADER', code: SHADER_PRESETS[0]!.code, preset: SHADER_PRESETS[0]!.id };
  // Mesh gradient — points from the previous gradient's colors (at the corners) or from the color.
  if (type === 'GRADIENT_FREEFORM') {
    const pts = defaultFreeform(firstColor());
    if (isGradient(p)) p.gradientStops.slice(0, 4).forEach((st, i) => (pts[i]!.color = { ...st.color }));
    return { ...base, type: 'GRADIENT_FREEFORM', points: pts };
  }
  if (p.type === 'GRADIENT_FREEFORM') {
    const stops: ColorStop[] = p.points.slice(0, 4).map((q, i, all) => ({ position: all.length > 1 ? i / (all.length - 1) : 0, color: { ...q.color } }));
    return { ...base, type: type as GradientPaint['type'], gradientTransform: defaultTransform(type as GradientPaint['type']), gradientStops: stops.length ? stops : [{ position: 0, color: firstColor() }] } as GradientPaint;
  }
  if (isGradient(p)) return { ...p, type, gradientTransform: (p.type === 'GRADIENT_LINEAR') === (type === 'GRADIENT_LINEAR') ? p.gradientTransform : defaultTransform(type) };
  // From solid — from the color to its transparent version.
  const c = firstColor();
  const stops: ColorStop[] = [
    { position: 0, color: { ...c } },
    { position: 1, color: { ...c, a: 0 } },
  ];
  return { ...base, type: type as GradientPaint['type'], gradientTransform: defaultTransform(type as GradientPaint['type']), gradientStops: stops } as GradientPaint;
}

const cssColor = (c: RGBA) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);

export function openPaintEditor(opts: PaintEditorOptions) {
  const shaderPresets = opts.shaderKind === 'effect' ? SHADER_EFFECT_PRESETS : SHADER_PRESETS;
  // Clicking the swatch again closes it.
  if (current?.key === opts.key) return current.close();
  current?.close();
  let paint = opts.paint;
  let stopIndex = 0;
  /** Update the display without rebuilding (stops, picker color). */
  let refresh: (() => void) | null = null;
  let removeStop: (() => void) | null = null;
  /** Pattern: picking a source on the canvas is in progress (a canvas click doesn't close the popup). */
  let picking = false;
  let startPick: (() => void) | null = null;
  const pop = popover(
    opts,
    () => {
      opts.onGradient?.(null);
      if (current === handle) current = null;
    },
    (e) =>
      (picking && e.target instanceof HTMLCanvasElement) ||
      // The shader code popup is part of the paint popup.
      !!(e.target as Element).closest?.('.shader-code') ||
      ((isGradient(paint) || paint.type === 'GRADIENT_FREEFORM') && e.target instanceof HTMLCanvasElement && canvasHit(e)),
  );
  const box = pop.box;
  // Header: a row of paint type icons (gradient is one, its type is a list in the popup),
  // custom types (Lottie, 3D, shader) in “⋯”, blend mode as an icon with a menu, close.
  const head = el('div', { className: 'pe-head' });
  const typeSel = el('select', { title: 'Вид краски' });
  for (const [t, label] of opts.shaderKind === 'effect' ? [['SHADER', 'Шейдерный эффект']] : TYPES) typeSel.append(el('option', { value: t, textContent: label }));
  const blendSel = el('select', { title: 'Режим наложения краски' });
  for (const [b, label] of BLEND_MODES) blendSel.append(el('option', { value: b, textContent: label }));
  const closeBtn = el('button', { className: 'pe-close', textContent: '×', title: 'Закрыть (Esc)' });
  closeBtn.addEventListener('click', () => pop.close());
  const pick = (t: Paint['type']) => {
    if (t === paint.type) return;
    typeSel.value = t;
    typeSel.dispatchEvent(new Event('change'));
  };
  const gradientKinds = new Set<Paint['type']>(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'GRADIENT_FREEFORM']);
  const iconBtn = (icon: string, title: string, run: () => void) => {
    const b = el('button', { className: 'pe-type', title });
    b.innerHTML = icon;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', run);
    return b;
  };
  const kinds: [Paint['type'] | 'GRADIENT', string, string][] = [
    ['SOLID', ICON.paintSolid, 'Сплошная'],
    ['GRADIENT', ICON.paintGradient, 'Градиент'],
    ['PATTERN', ICON.paintPattern, 'Узор'],
    ['IMAGE', ICON.image, 'Картинка'],
    ['VIDEO', ICON.paintVideo, 'Видео'],
  ];
  const typeBtns = kinds.map(([t, icon, title]) => {
    const b = iconBtn(icon, title, () => pick(t === 'GRADIENT' ? (gradientKinds.has(paint.type) ? paint.type : 'GRADIENT_LINEAR') : t));
    b.dataset.kind = t;
    return b;
  });
  const OWN: [Paint['type'], string][] = [['LOTTIE', 'Lottie'], ['MODEL3D', '3D-модель'], ['SHADER', 'Шейдер']];
  const moreBtn: HTMLButtonElement = iconBtn(ICON.more, 'Ещё: Lottie, 3D-модель, шейдер', () => {
    const r = moreBtn.getBoundingClientRect();
    showMenuAt(r.left, r.bottom + 4, OWN.map(([t, label]) => ({ label, checked: paint.type === t, run: () => pick(t) })));
  });
  const blendBtn: HTMLButtonElement = iconBtn(ICON.blend, 'Режим наложения краски', () => {
    const r = blendBtn.getBoundingClientRect();
    const cur = paint.blendMode && paint.blendMode !== 'PASS_THROUGH' ? paint.blendMode : 'NORMAL';
    showMenuAt(r.left, r.bottom + 4, BLEND_MODES.map(([b, label]) => ({
      label,
      checked: b === cur,
      run: () => {
        blendSel.value = b;
        blendSel.dispatchEvent(new Event('change'));
      },
    })));
  });
  const types = el('div', { className: 'pe-types' });
  types.append(...typeBtns, moreBtn);
  // Two header rows: “Custom | Libraries” and close; below — paint types and blending.
  const tabs = el('div', { className: 'pe-tabs' });
  const ownTab = el('button', { className: 'pe-tab on', textContent: 'Свой' });
  const libTab = el('button', { className: 'pe-tab', textContent: 'Библиотеки' });
  tabs.append(ownTab, libTab);
  const kindsRow = el('div', { className: 'pe-kinds' });
  let libraryOpen = false;
  const showLibrary = (on: boolean) => {
    libraryOpen = on;
    ownTab.classList.toggle('on', !on);
    libTab.classList.toggle('on', on);
    kindsRow.hidden = on;
    if (on && opts.library) {
      opts.onGradient?.(null);
      body.replaceChildren(opts.library());
    } else render();
  };
  ownTab.addEventListener('click', () => libraryOpen && showLibrary(false));
  libTab.addEventListener('click', () => !libraryOpen && showLibrary(true));
  if (opts.library && opts.shaderKind !== 'effect') {
    head.append(tabs, closeBtn);
    kindsRow.append(types, blendBtn);
  } else head.append(types, blendBtn, closeBtn);
  if (opts.shaderKind === 'effect') {
    types.hidden = true;
    blendBtn.hidden = true;
    head.prepend(el('span', { className: 'pe-title', textContent: 'Шейдерный эффект' }));
  }
  // Gradient type as a list at the top of the popup.
  const gradSel = el('select', { className: 'pe-grad-kind', title: 'Вид градиента' });
  for (const [t, label] of TYPES) if (gradientKinds.has(t)) gradSel.append(el('option', { value: t, textContent: label }));
  gradSel.addEventListener('change', () => pick(gradSel.value as Paint['type']));
  const body = el('div', { className: 'pe-body' });
  box.append(head, ...(kindsRow.childElementCount ? [kindsRow] : []), body);
  const syncHead = () => {
    typeSel.value = paint.type;
    blendSel.value = paint.blendMode && paint.blendMode !== 'PASS_THROUGH' ? paint.blendMode : 'NORMAL';
    const kind = gradientKinds.has(paint.type) ? 'GRADIENT' : paint.type;
    for (const b of typeBtns) b.classList.toggle('on', b.dataset.kind === kind);
    moreBtn.classList.toggle('on', OWN.some(([t]) => t === paint.type));
    blendBtn.classList.toggle('on', blendSel.value !== 'NORMAL');
    gradSel.value = paint.type;
  };

  const change = (p: Paint) => {
    paint = p;
    opts.onChange(p);
  };

  const render = () => {
    // The “Libraries” tab is open — leave its list alone.
    if (libraryOpen) return;
    body.replaceChildren();
    refresh = null;
    removeStop = null;
    syncHead();
    if (paint.type === 'GRADIENT_FREEFORM' && opts.shaderKind !== 'effect') body.append(gradSel);
    if (paint.type === 'SOLID') body.append(solidControls());
    else if (paint.type === 'IMAGE') body.append(imageControls(paint));
    else if (paint.type === 'VIDEO') body.append(videoControls(paint));
    else if (paint.type === 'LOTTIE') body.append(lottieControls(paint));
    else if (paint.type === 'MODEL3D') body.append(modelControls(paint));
    else if (paint.type === 'PATTERN') body.append(patternControls(paint));
    else if (paint.type === 'SHADER') body.append(shaderControls(paint));
    else if (paint.type === 'GRADIENT_FREEFORM') body.append(freeformControls());
    else body.append(...gradientControls(paint));
    opts.onGradient?.(isGradient(paint) ? { stop: stopIndex } : null);
  };

  const solidControls = (): HTMLElement => {
    const solid = () => paint as Extract<Paint, { type: 'SOLID' }>;
    const picker = colorPicker({ ...solid().color, a: solid().opacity ?? 1 }, (c) => {
      const next: Paint = { ...solid(), color: { r: c.r, g: c.g, b: c.b } };
      if (c.a < 1) next.opacity = c.a;
      else delete next.opacity;
      change(next);
    }, {
      onStart: opts.onStart,
      onEnd: opts.onEnd,
      docColors: opts.docColors,
    });
    refresh = () => picker.set({ ...solid().color, a: solid().opacity ?? 1 });
    return picker.el;
  };

  /**
   * Mesh gradient: points (number — select, color — via the picker), X/Y position and point
   * strength, “+ point” adds one in the middle; on the canvas points are dragged with the mouse
   * (handles in main.ts).
   */
  let freeformIndex = 0;
  const freeformControls = (): HTMLElement => {
    const ff = () => paint as FreeformGradientPaint;
    const wrap = el('div', { className: 'pe-freeform' });
    freeformIndex = Math.max(0, Math.min(freeformIndex, ff().points.length - 1));
    const setPoints = (points: FreeformGradientPaint['points']) => change({ ...ff(), points });
    const cur = () => ff().points[freeformIndex]!;
    const picker: ColorPickerHandle = colorPicker(
      { ...cur().color },
      (c) => setPoints(ff().points.map((q, i) => (i === freeformIndex ? { ...q, color: c } : q))),
      { onStart: opts.onStart, onEnd: opts.onEnd, docColors: opts.docColors },
    );
    const list = el('div', { className: 'pe-row' });
    const sliders = el('div');
    const slider = (label: string, get: () => number, put: (v: number) => void) => {
      const line = el('label', { className: 'pe-slider' });
      const range = el('input', { type: 'range', min: '0', max: '100', step: '1' });
      range.value = String(Math.round(get() * 100));
      const out = el('span', { textContent: `${range.value}%` });
      range.addEventListener('pointerdown', () => opts.onStart());
      range.addEventListener('pointerup', () => opts.onEnd());
      range.addEventListener('input', () => {
        out.textContent = `${range.value}%`;
        put(Number(range.value) / 100);
      });
      line.append(el('span', { textContent: label }), range, out);
      return line;
    };
    const draw = () => {
      list.replaceChildren();
      ff().points.forEach((q, i) => {
        const b = el('button', { className: 'pe-btn', textContent: String(i + 1), title: `Точка ${i + 1}` });
        b.style.borderBottom = `3px solid ${cssColor(q.color)}`;
        b.setAttribute('aria-pressed', String(i === freeformIndex));
        b.addEventListener('click', () => {
          freeformIndex = i;
          picker.set({ ...cur().color });
          draw();
        });
        list.append(b);
      });
      const add = el('button', { className: 'pe-btn', textContent: '+', title: 'Новая точка в середине' });
      add.disabled = ff().points.length >= 16;
      add.addEventListener('click', () => {
        const c = cur().color;
        setPoints([...ff().points, { x: 0.5, y: 0.5, color: { r: 1 - c.r, g: 1 - c.g, b: 1 - c.b, a: c.a } }]);
        freeformIndex = ff().points.length - 1;
        picker.set({ ...cur().color });
        draw();
      });
      const del = el('button', { className: 'pe-btn', textContent: '−', title: 'Убрать выбранную точку' });
      del.disabled = ff().points.length <= 1;
      del.addEventListener('click', () => {
        setPoints(ff().points.filter((_, i) => i !== freeformIndex));
        freeformIndex = Math.max(0, freeformIndex - 1);
        picker.set({ ...cur().color });
        draw();
      });
      list.append(add, del);
      const at = (patch: Partial<FreeformGradientPaint['points'][number]>) => setPoints(ff().points.map((q, i) => (i === freeformIndex ? { ...q, ...patch } : q)));
      sliders.replaceChildren(
        slider('X', () => cur().x, (v) => at({ x: v })),
        slider('Y', () => cur().y, (v) => at({ y: v })),
        slider('Сила', () => cur().spread ?? 0.5, (v) => at({ spread: Math.max(0.02, v) })),
      );
    };
    draw();
    refresh = () => {
      freeformIndex = Math.min(freeformIndex, ff().points.length - 1);
      picker.set({ ...cur().color });
      draw();
    };
    wrap.append(list, picker.el, sliders, el('p', { className: 'pe-note', textContent: 'Точки можно тянуть на холсте. Свой вид MFP: в SVG и PDF — растром, в CSS — приближённо.' }));
    return wrap;
  };

  const gradientControls = (g: GradientPaint): HTMLElement[] => {
    const grad = () => paint as GradientPaint;
    stopIndex = Math.max(0, Math.min(stopIndex, g.gradientStops.length - 1));
    const bar = el('div', { className: 'pe-stops' });
    const strip = el('div', { className: 'pe-strip', title: 'Щелчок — новая точка' });
    const markers = el('div', { className: 'pe-markers' });
    const stopRows = el('div', { className: 'pe-stop-rows' });
    bar.append(strip, markers);
    /** New stops (ascending) and the selected one among them — the stop that had index sel before sorting. */
    const setStops = (stops: ColorStop[], sel: number) => {
      const r = sortStops(stops, sel);
      stopIndex = r.index;
      change({ ...grad(), gradientStops: r.stops });
    };
    const picker: ColorPickerHandle = colorPicker(
      { ...g.gradientStops[stopIndex]!.color },
      (c) => {
        setStops(grad().gradientStops.map((s, i) => (i === stopIndex ? { ...s, color: c } : s)), stopIndex);
        drawMarkers();
      },
      { onStart: opts.onStart, onEnd: opts.onEnd, docColors: opts.docColors },
    );
    const paintStrip = () => {
      const sorted = [...grad().gradientStops].sort((x, y) => x.position - y.position);
      strip.style.background = `linear-gradient(90deg, ${sorted.map((s) => `${cssColor(s.color)} ${s.position * 100}%`).join(', ')}), repeating-conic-gradient(#999 0 25%, #ddd 0 50%) 0 0 / 8px 8px`;
    };
    const select = (i: number) => {
      stopIndex = i;
      picker.set({ ...grad().gradientStops[i]!.color });
      drawMarkers();
      opts.onGradient?.({ stop: i });
    };
    /** Highlight the selected stop without rebuilding the markers (a drag is in progress under the pointer). */
    const highlight = (m: HTMLElement) => {
      for (const x of markers.children) x.classList.toggle('on', x === m);
    };
    const drawMarkers = () => {
      paintStrip();
      markers.replaceChildren();
      stopRows.replaceChildren();
      grad().gradientStops.forEach((s, i) => {
        const row = el('div', { className: `pe-stop${i === stopIndex ? ' on' : ''}` });
        row.addEventListener('click', (e) => {
          if (i !== stopIndex && !(e.target as Element).closest('button.pe-stop-del')) select(i);
        });
        const label = el('label', { textContent: '%', title: 'Тяните — позиция точки' });
        const input = el('input', { value: String(Math.round(s.position * 10000) / 100), title: 'Позиция точки, %' });
        input.setAttribute('aria-label', `Позиция точки ${i + 1}, %`);
        // Stop color: swatch, HEX and opacity — one field.
        const swatch = el('span', { className: 'pe-stop-swatch' });
        swatch.style.setProperty('--c', cssColor(s.color));
        const hexIn = el('input', { className: 'pe-stop-hex', value: toHex(s.color), title: 'Цвет точки (HEX)' });
        const alphaIn = el('input', { className: 'pe-stop-a', value: String(Math.round(s.color.a * 100)), title: 'Непрозрачность точки, %' });
        const setColor = (c: ColorStop['color']) => {
          setStops(grad().gradientStops.map((st, k) => (k === index ? { ...st, color: c } : st)), index);
          select(stopIndex);
        };
        hexIn.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') hexIn.blur();
        });
        hexIn.addEventListener('change', () => {
          const c = parseHex(hexIn.value);
          if (c) setColor({ ...c, a: grad().gradientStops[index]!.color.a });
          else hexIn.value = toHex(grad().gradientStops[index]!.color);
        });
        alphaIn.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') alphaIn.blur();
        });
        alphaIn.addEventListener('change', () => {
          const v = Number(alphaIn.value.replace('%', '').replace(',', '.'));
          if (Number.isFinite(v)) setColor({ ...grad().gradientStops[index]!.color, a: Math.max(0, Math.min(100, v)) / 100 });
          else alphaIn.value = String(Math.round(grad().gradientStops[index]!.color.a * 100));
        });
        const colorField = el('div', { className: 'pe-stop-color' });
        colorField.append(swatch, hexIn, alphaIn, el('span', { className: 'pe-unit', textContent: '%' }));
        const del = el('button', { className: 'pe-stop-del', title: 'Убрать точку (Delete)' });
        del.innerHTML = ICON.minus;
        del.disabled = grad().gradientStops.length <= 2;
        del.addEventListener('click', () => {
          stopIndex = index;
          removeSelected();
        });
        let index = i;
        const putPosition = (percent: number) => {
          if (!Number.isFinite(percent)) return;
          setStops(grad().gradientStops.map((st, k) => k === index ? { ...st, position: Math.max(0, Math.min(100, percent)) / 100 } : st), index);
          index = stopIndex;
          picker.set({ ...grad().gradientStops[index]!.color });
          input.value = String(Math.round(grad().gradientStops[index]!.position * 10000) / 100);
          paintStrip(); opts.onGradient?.({ stop: index });
        };
        let committing = false;
        const commitPosition = () => {
          if (committing || !input.isConnected) return;
          committing = true;
          const raw = input.value.trim().replace(',', '.').replace(/%$/, '');
          const value = raw ? Number(raw) : NaN;
          if (Number.isFinite(value) && Math.max(0, Math.min(100, value)) / 100 !== grad().gradientStops[index]!.position) putPosition(value);
          drawMarkers();
        };
        input.addEventListener('change', commitPosition);
        input.addEventListener('blur', commitPosition);
        input.addEventListener('keydown', e => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commitPosition(); }
          if (e.key === 'Escape') { input.value = String(grad().gradientStops[index]!.position * 100); input.blur(); }
        });
        numberDrag(label, () => grad().gradientStops[index]!.position * 100, putPosition, opts.onStart, () => { opts.onEnd(); drawMarkers(); });
        const posField = el('div', { className: 'pe-stop-pos' });
        posField.append(input, label);
        row.append(posField, colorField, del);
        stopRows.append(row);
        const m = el('span', { className: `pe-marker${i === stopIndex ? ' on' : ''}`, title: `${Math.round(s.position * 100)}%` });
        m.style.left = `${s.position * 100}%`;
        m.style.setProperty('--c', cssColor(s.color));
        m.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          stopIndex = i;
          picker.set({ ...grad().gradientStops[i]!.color });
          highlight(m);
          opts.onGradient?.({ stop: i });
          box.focus();
          try {
            m.setPointerCapture(e.pointerId);
          } catch {
            // synthetic pointer
          }
          let started = false;
          const move = (ev: PointerEvent) => {
            if (!started) {
              opts.onStart();
              started = true;
            }
            const r = strip.getBoundingClientRect();
            const pos = Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 1000) / 1000;
            setStops(grad().gradientStops.map((x, k) => (k === stopIndex ? { ...x, position: pos } : x)), stopIndex);
            m.style.left = `${pos * 100}%`;
            m.title = `${Math.round(pos * 100)}%`;
            paintStrip();
          };
          const up = () => {
            m.removeEventListener('pointermove', move);
            m.removeEventListener('pointerup', up);
            m.removeEventListener('pointercancel', up);
            if (!started) return;
            opts.onEnd();
            drawMarkers();
            opts.onGradient?.({ stop: stopIndex });
          };
          m.addEventListener('pointermove', move);
          m.addEventListener('pointerup', up);
          m.addEventListener('pointercancel', up);
        });
        markers.append(m);
      });
    };
    // Clicking the bar adds a stop with the gradient's color at that position.
    strip.addEventListener('pointerdown', (e) => {
      const r = strip.getBoundingClientRect();
      const pos = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 1000) / 1000;
      const color = colorAt(grad().gradientStops, pos);
      setStops([...grad().gradientStops, { position: pos, color }], grad().gradientStops.length);
      select(stopIndex);
    });
    const removeSelected = () => {
      if (grad().gradientStops.length <= 2) return;
      change({ ...grad(), gradientStops: grad().gradientStops.filter((_, k) => k !== stopIndex) });
      select(Math.max(0, stopIndex - 1));
    };
    const tools = el('div', { className: 'pe-grad-top' });
    const flip = el('button', { className: 'pe-type', title: 'Развернуть: поменять цвета местами' });
    flip.innerHTML = ICON.swap;
    const rotate = el('button', { className: 'pe-type', title: 'Повернуть на 90°' });
    rotate.innerHTML = ICON.rotate;
    rotate.addEventListener('click', () => {
      change({ ...grad(), gradientTransform: rotateGradient(grad()) });
      opts.onGradient?.({ stop: stopIndex });
    });
    const stopsHead = el('div', { className: 'pe-stops-head' });
    const addStop = el('button', { className: 'pe-type', title: 'Добавить точку' });
    addStop.innerHTML = ICON.plus;
    addStop.addEventListener('click', () => {
      // New stop — halfway between the selected one and the next (or previous) one.
      const st = [...grad().gradientStops].sort((x, y) => x.position - y.position);
      const cur = grad().gradientStops[stopIndex]!;
      const k = st.indexOf(cur);
      const other = st[k + 1] ?? st[k - 1] ?? { position: cur.position < 0.5 ? 1 : 0 };
      const pos = Math.round(((cur.position + other.position) / 2) * 1000) / 1000;
      setStops([...grad().gradientStops, { position: pos, color: colorAt(grad().gradientStops, pos) }], grad().gradientStops.length);
      select(stopIndex);
    });
    stopsHead.append(el('span', { textContent: 'Точки' }), addStop);
    flip.addEventListener('click', () => {
      setStops(grad().gradientStops.map((s) => ({ ...s, position: Math.round((1 - s.position) * 1000) / 1000 })), stopIndex);
      select(stopIndex);
    });
    tools.append(gradSel, flip, rotate);
    box.onkeydown = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        e.stopPropagation();
        removeSelected();
      }
    };
    removeStop = removeSelected;
    refresh = () => {
      stopIndex = Math.min(stopIndex, grad().gradientStops.length - 1);
      picker.set({ ...grad().gradientStops[stopIndex]!.color });
      drawMarkers();
    };
    drawMarkers();
    return [tools, bar, stopsHead, stopRows, picker.el];
  };

  /** Video: how it fills the layer, rotation, file from disk (plays muted on the canvas). */
  const videoControls = (vid: VideoPaint): HTMLElement => {
    const video = () => paint as VideoPaint;
    const wrap = el('div', { className: 'pe-image' });
    const row = el('div', { className: 'pe-row' });
    const modeSel = el('select', { title: 'Как видео заполняет слой' });
    for (const [m, label] of [
      ['FILL', 'Заполнить'],
      ['FIT', 'Вписать'],
      ['CROP', 'Обрезать'],
      ['TILE', 'Замостить'],
    ] as const)
      modeSel.append(el('option', { value: m, textContent: label, selected: m === vid.scaleMode }));
    modeSel.addEventListener('change', () => change({ ...video(), scaleMode: modeSel.value as VideoPaint['scaleMode'] }));
    const rotate = el('button', { className: 'pe-btn', textContent: '↻ 90°', title: 'Повернуть видео на 90°' });
    rotate.addEventListener('click', () => change({ ...video(), rotation: ((video().rotation ?? 0) + 90) % 360 }));
    const replace = el('button', { className: 'pe-btn primary', textContent: vid.videoHash ? 'Заменить…' : 'Выбрать…', title: 'Видео с диска (MP4, WebM)' });
    replace.addEventListener('click', async () => {
      const res = await opts.pickVideo?.();
      if (!res) return;
      change({ ...video(), videoHash: res.hash });
      render();
    });
    row.append(modeSel, rotate, replace);
    wrap.append(row, el('div', { className: 'pe-note', textContent: 'На холсте видео играет без звука; в показе — по настройкам слоя и действиям прототипа.' }));
    return wrap;
  };

  /** 3D model: file, mode, view angle, lighting, clip and frame on the canvas, behavior in presentation. */
  const modelControls = (mp: Model3DPaint): HTMLElement => {
    const model = () => paint as Model3DPaint;
    const cam = () => model().camera ?? { yaw: 30, pitch: 15, zoom: 1 };
    const wrap = el('div', { className: 'pe-image' });
    const row = el('div', { className: 'pe-row' });
    const modeSel = el('select', { title: 'Как модель заполняет слой' });
    for (const [m, label] of [
      ['FIT', 'Вписать'],
      ['FILL', 'Заполнить'],
    ] as const)
      modeSel.append(el('option', { value: m, textContent: label, selected: m === mp.scaleMode }));
    modeSel.addEventListener('change', () => change({ ...model(), scaleMode: modeSel.value as Model3DPaint['scaleMode'] }));
    const lightSel = el('select', { title: 'Освещение' });
    for (const [v, label] of [
      ['STUDIO', 'Студия'],
      ['SOFT', 'Мягкий свет'],
      ['CONTRAST', 'Контраст'],
    ] as const)
      lightSel.append(el('option', { value: v, textContent: label, selected: v === (mp.lighting ?? 'STUDIO') }));
    lightSel.addEventListener('change', () => change({ ...model(), lighting: lightSel.value as Model3DPaint['lighting'] }));
    const replace = el('button', { className: 'pe-btn primary', textContent: mp.modelHash ? 'Заменить…' : 'Выбрать…', title: '3D-модель с диска (.glb или .gltf)' });
    replace.addEventListener('click', async () => {
      const res = await opts.pickModel?.();
      if (!res) return;
      change({ ...model(), modelHash: res.hash });
      render();
    });
    row.append(modeSel, lightSel, replace);
    wrap.append(row);
    // View angle: rotation, tilt, zoom; double-click resets to default.
    const slider = (label: string, min: number, max: number, step: number, reset: number, get: () => number, set: (v: number) => Model3DPaint, fmt = (v: number) => String(v)) => {
      const line = el('label', { className: 'pe-slider', title: 'Двойной щелчок — сбросить' });
      const range = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
      range.value = String(get());
      const out = el('span', { textContent: fmt(get()) });
      const apply = (v: number) => {
        out.textContent = fmt(v);
        change(set(v));
      };
      range.addEventListener('pointerdown', () => opts.onStart());
      range.addEventListener('pointerup', () => opts.onEnd());
      range.addEventListener('input', () => apply(Number(range.value)));
      line.addEventListener('dblclick', () => {
        range.value = String(reset);
        apply(reset);
      });
      line.append(el('span', { textContent: label }), range, out);
      wrap.append(line);
      return range;
    };
    slider('Поворот', -180, 180, 1, 30, () => cam().yaw, (v) => ({ ...model(), camera: { ...cam(), yaw: v } }), (v) => `${v}°`);
    slider('Наклон', -80, 80, 1, 15, () => cam().pitch, (v) => ({ ...model(), camera: { ...cam(), pitch: v } }), (v) => `${v}°`);
    slider('Приближение', 50, 300, 5, 100, () => Math.round(cam().zoom * 100), (v) => ({ ...model(), camera: { ...cam(), zoom: v / 100 } }), (v) => `${v}%`);
    // Animation: clip and frame on the canvas (the clip list comes from the model file).
    const clipRow = el('div', { className: 'pe-row' });
    const clipSel = el('select', { title: 'Клип анимации из файла модели' });
    clipSel.append(el('option', { value: '', textContent: 'Без анимации', selected: mp.clip === '' }));
    clipRow.append(clipSel);
    wrap.append(clipRow);
    const poseLine = el('label', { className: 'pe-slider', title: 'Кадр клипа на холсте (в показе клип играет)' });
    const poseRange = el('input', { type: 'range', min: '0', max: '1', step: '0.01' });
    const poseOut = el('span');
    poseLine.append(el('span', { textContent: 'Кадр' }), poseRange, poseOut);
    wrap.append(poseLine);
    poseRange.addEventListener('pointerdown', () => opts.onStart());
    poseRange.addEventListener('pointerup', () => opts.onEnd());
    poseRange.addEventListener('input', () => {
      poseOut.textContent = `${Number(poseRange.value).toFixed(2).replace('.', ',')} с`;
      change({ ...model(), pose: Number(poseRange.value) });
    });
    const clips: { name: string; duration: number }[] = [];
    const syncPose = () => {
      const name = model().clip === '' ? null : (model().clip ?? clips[0]?.name ?? null);
      const d = clips.find((c) => c.name === name)?.duration ?? 0;
      poseLine.hidden = !d;
      poseRange.max = String(Math.max(0.01, d));
      poseRange.value = String(Math.min(d, model().pose ?? 0));
      poseOut.textContent = `${Number(poseRange.value).toFixed(2).replace('.', ',')} с`;
    };
    poseLine.hidden = true;
    clipSel.addEventListener('change', () => {
      change({ ...model(), clip: clipSel.value === '__first' ? undefined : clipSel.value, pose: 0 });
      syncPose();
    });
    if (mp.modelHash && opts.modelInfo)
      void opts.modelInfo(mp.modelHash).then((info) => {
        if (!info) return;
        clips.push(...info.clips);
        for (const c of info.clips) clipSel.append(el('option', { value: c.name, textContent: `${c.name} — ${c.duration.toFixed(1).replace('.', ',')} с`, selected: (model().clip ?? info.clips[0]?.name) === c.name }));
        if (!info.clips.length) clipSel.disabled = true;
        syncPose();
      });
    // Presentation: rotate with the mouse or a finger; auto-rotate.
    const check = (label: string, title: string, on: boolean, set: (v: boolean) => Model3DPaint) => {
      const box = el('input', { type: 'checkbox', checked: on });
      box.addEventListener('change', () => change(set(box.checked)));
      const line = el('label', { className: 'pe-check', title });
      line.append(box, el('span', { textContent: label }));
      return line;
    };
    const checks = el('div', { className: 'pe-row' });
    checks.append(check('Вращать в показе', 'В показе модель можно поворачивать мышью или пальцем', mp.orbit !== false, (v) => ({ ...model(), orbit: v })), check('Вращается сама', 'В показе модель медленно вращается', mp.autoRotate === true, (v) => ({ ...model(), autoRotate: v })));
    wrap.append(checks, el('div', { className: 'pe-note', textContent: 'На холсте — кадр с выбранного ракурса; в показе клип играет (настройки слоя на вкладке «Прототип», действия «Видео и Lottie»).' }));
    return wrap;
  };

  /** Lottie: fill mode, speed, file. */
  const lottieControls = (lot: LottiePaint): HTMLElement => {
    const lottie = () => paint as LottiePaint;
    const wrap = el('div', { className: 'pe-image' });
    const row = el('div', { className: 'pe-row' });
    const modeSel = el('select', { title: 'Как анимация заполняет слой' });
    for (const [m, label] of [
      ['FIT', 'Вписать'],
      ['FILL', 'Заполнить'],
      ['TILE', 'Замостить'],
    ] as const)
      modeSel.append(el('option', { value: m, textContent: label, selected: m === lot.scaleMode }));
    modeSel.addEventListener('change', () => change({ ...lottie(), scaleMode: modeSel.value as LottiePaint['scaleMode'] }));
    const speedSel = el('select', { title: 'Скорость анимации' });
    for (const v of [0.25, 0.5, 1, 1.5, 2])
      speedSel.append(el('option', { value: String(v), textContent: `${String(v).replace('.', ',')}×`, selected: v === (lot.speed ?? 1) }));
    speedSel.addEventListener('change', () => {
      const v = Number(speedSel.value);
      const { speed: _, ...rest } = lottie();
      change(v === 1 ? rest : { ...rest, speed: v });
    });
    const replace = el('button', { className: 'pe-btn primary', textContent: lot.lottieHash ? 'Заменить…' : 'Выбрать…', title: 'Анимация Lottie с диска (.json из Bodymovin или .lottie)' });
    replace.addEventListener('click', async () => {
      const res = await opts.pickLottie?.();
      if (!res) return;
      change({ ...lottie(), lottieHash: res.hash });
      render();
    });
    row.append(modeSel, speedSel, replace);
    wrap.append(row, el('div', { className: 'pe-note', textContent: 'На холсте анимация играет по кругу; в показе — по настройкам слоя и действиям прототипа, как видео.' }));
    return wrap;
  };

  /** Pattern: source (picked on the canvas), grid, scale, spacing as fractions of a tile, alignment. */
  const patternControls = (pat: PatternPaint): HTMLElement => {
    const pattern = () => paint as PatternPaint;
    const wrap = el('div', { className: 'pe-image' });
    const srcRow = el('div', { className: 'pe-row' });
    const name = pat.sourceNodeId ? (opts.patternSourceName?.(pat.sourceNodeId) ?? null) : null;
    const src = el('span', {
      className: `pe-src${name ? '' : ' missing'}`,
      textContent: name ?? (pat.sourceNodeId ? 'Источник удалён' : 'Источник не выбран'),
      title: name ? 'Слой-источник: правка его меняет узор везде' : '',
    });
    const pick = el('button', { className: 'pe-btn primary', textContent: pat.sourceNodeId ? 'Другой…' : 'Выбрать…', title: 'Щёлкните слой на холсте (Ctrl — вложенный слой, Esc — отмена)' });
    startPick = () => {
      if (picking || !opts.pickPatternSource) return;
      picking = true;
      pick.classList.add('on');
      pick.textContent = 'Щёлкните слой…';
      void opts.pickPatternSource().then((id) => {
        picking = false;
        if (id) change({ ...pattern(), sourceNodeId: id });
        render();
        pop.place();
      });
    };
    pick.addEventListener('click', () => startPick?.());
    srcRow.append(src, pick);
    const row = el('div', { className: 'pe-row' });
    const tileSel = el('select', { title: 'Сетка плиток' });
    for (const [t, label] of [
      ['RECTANGULAR', 'Сетка'],
      ['HORIZONTAL_HEXAGONAL', 'Ряды со сдвигом'],
      ['VERTICAL_HEXAGONAL', 'Столбцы со сдвигом'],
    ] as const)
      tileSel.append(el('option', { value: t, textContent: label, selected: t === pat.tileType }));
    tileSel.addEventListener('change', () => change({ ...pattern(), tileType: tileSel.value as PatternPaint['tileType'] }));
    const alignSel = el('select', { title: 'Выравнивание по горизонтали: первая плитка у левого края, по центру или у правого' });
    for (const [a, label] of [
      ['START', 'Слева'],
      ['CENTER', 'По центру'],
      ['END', 'Справа'],
    ] as const)
      alignSel.append(el('option', { value: a, textContent: label, selected: a === pat.horizontalAlignment }));
    alignSel.addEventListener('change', () => change({ ...pattern(), horizontalAlignment: alignSel.value as PatternPaint['horizontalAlignment'] }));
    row.append(tileSel, alignSel);
    wrap.append(srcRow, row);
    // Scale and spacing in percent (spacing is a fraction of a tile); double-click resets.
    const sliders: [HTMLInputElement, HTMLElement, () => number][] = [];
    const slider = (label: string, min: number, max: number, reset: number, get: () => number, set: (v: number) => PatternPaint) => {
      const line = el('label', { className: 'pe-slider', title: 'Двойной щелчок — сбросить' });
      const range = el('input', { type: 'range', min: String(min), max: String(max), step: '1' });
      const out = el('span');
      const apply = (v: number) => {
        out.textContent = String(v);
        change(set(v));
      };
      range.addEventListener('pointerdown', () => opts.onStart());
      range.addEventListener('pointerup', () => opts.onEnd());
      range.addEventListener('input', () => apply(Number(range.value)));
      line.addEventListener('dblclick', () => {
        range.value = String(reset);
        apply(reset);
      });
      line.append(el('span', { textContent: label }), range, out);
      wrap.append(line);
      sliders.push([range, out, get]);
    };
    slider('Масштаб, %', 10, 400, 100, () => Math.round(pattern().scalingFactor * 100), (v) => ({ ...pattern(), scalingFactor: Math.max(0.01, v / 100) }));
    slider('Зазор →, %', 0, 200, 0, () => Math.round(pattern().spacing.x * 100), (v) => ({ ...pattern(), spacing: { ...pattern().spacing, x: v / 100 } }));
    slider('Зазор ↓, %', 0, 200, 0, () => Math.round(pattern().spacing.y * 100), (v) => ({ ...pattern(), spacing: { ...pattern().spacing, y: v / 100 } }));
    wrap.append(el('div', { className: 'pe-note', textContent: 'Плитка — рамка слоя-источника. Правка источника меняет узор во всех слоях.' }));
    refresh = () => {
      tileSel.value = pattern().tileType;
      alignSel.value = pattern().horizontalAlignment;
      for (const [range, out, get] of sliders) {
        const v = String(get());
        if (document.activeElement !== range) range.value = v;
        out.textContent = v;
      }
    };
    refresh();
    return wrap;
  };

  /** Shader: preset or custom code, parameters from its uniforms, animation. */
  const shaderControls = (original: ShaderPaint): HTMLElement => {
    const sh = resolveFigmaShader(original);
    const shader = () => resolveFigmaShader(paint as ShaderPaint);
    const wrap = el('div', { className: 'pe-image' });
    const row = el('div', { className: 'pe-row' });
    const presetSel = el('select', { title: 'Готовый шейдер' });
    const known = shaderPresets.find((p) => p.code === sh.code);
    for (const p of shaderPresets) presetSel.append(el('option', { value: p.id, textContent: p.name, selected: known?.id === p.id }));
    if (!known) presetSel.append(el('option', { value: '', textContent: sh.wgsl?.name ?? 'Свой код', selected: true, disabled: true }));
    presetSel.addEventListener('change', () => {
      const p = shaderPresets.find((x) => x.id === presetSel.value);
      if (!p) return;
      const { params: _, wgsl: _wgsl, figma: _figma, ...rest } = shader();
      change({ ...rest, code: p.code, preset: p.id });
      render();
      pop.place();
    });
    const codeBtn = el('button', { className: 'pe-btn', textContent: 'Код…', title: 'Код шейдера (SkSL)' });
    codeBtn.addEventListener('click', () => openCode());
    codeBtn.hidden = !!sh.wgsl;
    row.append(presetSel, codeBtn);
    wrap.append(row);
    if (sh.figma && !sh.code && !sh.wgsl) wrap.append(el('p', { className: 'pe-note', textContent: 'Ссылка и параметры шейдера Figma сохранены. Для отображения нужен его исполняемый исходник, которого нет в этом .fig.' }));
    const params = sh.wgsl ? sh.wgsl.uniforms.map((p) => ({ ...p, size: p.kind === 'color' ? 4 : 1 })) : shaderParams(sh.code);
    const value = (name: string, def: number[]) => shader().params?.[name] ?? def;
    const setParam = (name: string, v: number[]) => change({ ...shader(), params: { ...(shader().params ?? {}), [name]: v } });
    const syncs: (() => void)[] = [];
    const toHex = (c: number[]) => '#' + c.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
    for (const p of params) {
      if (p.kind === 'color') {
        const line = el('label', { className: 'pe-slider pe-color' });
        const input = el('input', { type: 'color', value: toHex(value(p.name, p.value)) });
        input.addEventListener('input', () => {
          const x = input.value;
          setParam(p.name, [parseInt(x.slice(1, 3), 16) / 255, parseInt(x.slice(3, 5), 16) / 255, parseInt(x.slice(5, 7), 16) / 255, value(p.name, p.value)[3] ?? 1]);
        });
        input.addEventListener('pointerdown', () => opts.onStart());
        input.addEventListener('change', () => opts.onEnd());
        line.append(el('span', { textContent: p.label }), input, el('span'));
        wrap.append(line);
        syncs.push(() => {
          if (document.activeElement !== input) input.value = toHex(value(p.name, p.value));
        });
      } else if (p.kind === 'float' && p.min !== undefined && p.max !== undefined) {
        const line = el('label', { className: 'pe-slider', title: 'Двойной щелчок — по умолчанию' });
        const step = (p.max - p.min) / 200;
        const range = el('input', { type: 'range', min: String(p.min), max: String(p.max), step: String(step) });
        const out = el('span');
        const fmt = (v: number) => String(Math.round(v * 100) / 100);
        range.addEventListener('pointerdown', () => opts.onStart());
        range.addEventListener('pointerup', () => opts.onEnd());
        range.addEventListener('input', () => {
          out.textContent = fmt(Number(range.value));
          setParam(p.name, [Number(range.value)]);
        });
        line.addEventListener('dblclick', () => {
          range.value = String(p.value[0]);
          out.textContent = fmt(p.value[0]!);
          setParam(p.name, [...p.value]);
        });
        line.append(el('span', { textContent: p.label }), range, out);
        wrap.append(line);
        syncs.push(() => {
          const v = value(p.name, p.value)[0] ?? 0;
          if (document.activeElement !== range) range.value = String(v);
          out.textContent = fmt(v);
        });
      } else {
        // No bounds — number fields (one field per component for a vector).
        const line = el('label', { className: 'pe-slider pe-vec' });
        const box = el('span', { className: 'pe-nums' });
        const inputs = p.value.map((_, k) => {
          const inp = el('input', { type: 'number', step: 'any' });
          inp.addEventListener('change', () => {
            const v = [...value(p.name, p.value)];
            v[k] = Number(inp.value) || 0;
            setParam(p.name, v);
          });
          inp.addEventListener('keydown', (e) => e.stopPropagation());
          box.append(inp);
          return inp;
        });
        line.append(el('span', { textContent: p.label }), box, el('span'));
        wrap.append(line);
        syncs.push(() => inputs.forEach((inp, k) => document.activeElement !== inp && (inp.value = String(value(p.name, p.value)[k] ?? 0))));
      }
    }
    if (sh.wgsl || shaderUsesTime(sh.code)) {
      const anim = el('label', { className: 'pe-check' });
      const box = el('input', { type: 'checkbox', checked: sh.animate !== false });
      box.addEventListener('change', () => change({ ...shader(), animate: box.checked ? undefined : false }));
      anim.append(box, el('span', { textContent: 'Анимация в показе' }));
      wrap.append(anim);
      syncs.push(() => (box.checked = shader().animate !== false));
    }
    refresh = () => syncs.forEach((x) => x());
    refresh();
    return wrap;
  };

  /** Shader code popup: SkSL, live compile check; “Apply” writes to the paint (parameters are kept by name). */
  const openCode = () => {
    const m = modal('Код шейдера', { cls: 'shader-code' });
    const area = el('textarea', { className: 'sh-code', spellcheck: false, value: (paint as ShaderPaint).code });
    const status = el('div', { className: 'sh-status' });
    const apply = el('button', { className: 'm-btn primary', textContent: 'Применить' });
    const check = () => {
      const err = opts.shaderError?.(area.value) ?? null;
      status.textContent = err ? err.trim() : 'Собирается';
      status.classList.toggle('err', !!err);
      apply.disabled = !!err;
    };
    let t = 0;
    area.addEventListener('input', () => {
      clearTimeout(t);
      t = window.setTimeout(check, 250);
    });
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Tab indents rather than moving focus.
      if (e.key === 'Tab') {
        e.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      }
    });
    apply.addEventListener('click', () => {
      const cur = paint as ShaderPaint;
      const names = new Set(shaderParams(area.value).map((p) => p.name));
      const params = Object.fromEntries(Object.entries(cur.params ?? {}).filter(([k]) => names.has(k)));
      const { preset: _, params: __, ...rest } = cur;
      const preset = shaderPresets.find((p) => p.code === area.value);
      change({ ...rest, code: area.value, ...(Object.keys(params).length ? { params } : {}), ...(preset ? { preset: preset.id } : {}) });
      m.close();
      render();
      pop.place();
    });
    const note = el('p', { className: 'm-note', textContent: 'half4 main(float2 p): p — точка слоя. size и time задаёт редактор. Параметр: uniform float имя; // Подпись: 1 (0..10). Цвет: uniform half4 имя; // Подпись: #RRGGBB' });
    if (opts.shaderKind === 'effect') note.append(' uniform shader content; content.eval(p) — слой с дочерними элементами, RGB умножен на alpha. Эффект обрезается границами содержимого.');
    const actions = el('div', { className: 'm-row end' });
    const cancel = el('button', { className: 'm-btn', textContent: 'Отмена' });
    cancel.addEventListener('click', () => m.close());
    actions.append(cancel, apply);
    m.body.append(area, status, note, actions);
    check();
    setTimeout(() => area.focus(), 0);
  };

  const imageControls = (img: ImagePaint): HTMLElement => {
    const image = () => paint as ImagePaint;
    const wrap = el('div', { className: 'pe-image' });
    const row = el('div', { className: 'pe-row' });
    const modeSel = el('select', { title: 'Как картинка заполняет слой' });
    for (const [m, label] of [
      ['FILL', 'Заполнить'],
      ['FIT', 'Вписать'],
      ['CROP', 'Обрезать'],
      ['TILE', 'Замостить'],
    ] as const)
      modeSel.append(el('option', { value: m, textContent: label, selected: m === img.scaleMode }));
    modeSel.addEventListener('change', () => change({ ...image(), scaleMode: modeSel.value as ImagePaint['scaleMode'] }));
    const rotate = el('button', { className: 'pe-btn', textContent: '↻ 90°', title: 'Повернуть картинку на 90°' });
    rotate.addEventListener('click', () => change({ ...image(), rotation: ((image().rotation ?? 0) + 90) % 360 }));
    const replace = el('button', { className: 'pe-btn primary', textContent: img.imageHash ? 'Заменить…' : 'Выбрать…', title: 'Картинка с диска' });
    replace.addEventListener('click', async () => {
      const res = await opts.pickImage();
      if (!res) return;
      change({ ...image(), imageHash: res.hash, originalWidth: res.width });
      render();
    });
    row.append(modeSel, rotate, replace);
    wrap.append(row);
    if (opts.onCrop && img.imageHash) {
      const crop = el('button', { className: 'pe-btn', textContent: '✂ Обрезать на холсте', title: 'Рамка слоя — окно обрезки; картинку двигать и масштабировать мышью (Enter — готово)' });
      crop.addEventListener('click', () => opts.onCrop?.());
      const cropRow = el('div', { className: 'pe-row' });
      cropRow.append(crop);
      wrap.append(cropRow);
    }
    // Adjustments: −100…100; double-click resets.
    const ranges: [keyof ImageFilters, HTMLInputElement, HTMLElement][] = [];
    for (const [key, label] of FILTERS) {
      const line = el('label', { className: 'pe-slider', title: 'Двойной щелчок — сбросить' });
      const range = el('input', { type: 'range', min: '-100', max: '100', step: '1' });
      const out = el('span');
      const set = (v: number) => {
        const filters: ImageFilters = { ...(image().filters ?? {}), [key]: v / 100 };
        if (!v) delete filters[key];
        change({ ...image(), filters: Object.keys(filters).length ? filters : undefined });
      };
      range.addEventListener('pointerdown', () => opts.onStart());
      range.addEventListener('pointerup', () => opts.onEnd());
      range.addEventListener('input', () => {
        out.textContent = range.value;
        set(Number(range.value));
      });
      line.addEventListener('dblclick', () => {
        range.value = '0';
        out.textContent = '0';
        set(0);
      });
      line.append(el('span', { textContent: label }), range, out);
      wrap.append(line);
      ranges.push([key, range, out]);
    }
    refresh = () => {
      modeSel.value = image().scaleMode;
      for (const [key, range, out] of ranges) {
        const v = String(Math.round(((image().filters ?? {})[key] ?? 0) * 100));
        if (document.activeElement !== range) range.value = v;
        out.textContent = v;
      }
    };
    refresh();
    return wrap;
  };

  typeSel.addEventListener('change', () => {
    change(convert(paint, typeSel.value as Paint['type']));
    stopIndex = 0;
    render();
    pop.place();
    // New pattern — pick a source right away.
    if (paint.type === 'PATTERN' && !paint.sourceNodeId) startPick?.();
  });
  blendSel.addEventListener('change', () => {
    const next: Paint = { ...paint };
    if (blendSel.value === 'NORMAL') delete next.blendMode;
    else next.blendMode = blendSel.value as BlendMode;
    change(next);
  });

  box.tabIndex = -1;
  const handle: Open = {
    key: opts.key,
    close: pop.close,
    update(v) {
      const p = v as Paint;
      if (JSON.stringify(p) === JSON.stringify(paint)) return;
      const typeChanged =
        p.type !== paint.type ||
        (p.type === 'IMAGE' && (paint as ImagePaint).imageHash !== p.imageHash) ||
        (p.type === 'VIDEO' && (paint as VideoPaint).videoHash !== p.videoHash) ||
        (p.type === 'LOTTIE' && (paint as LottiePaint).lottieHash !== p.lottieHash) ||
        (p.type === 'MODEL3D' && (paint as Model3DPaint).modelHash !== p.modelHash) ||
        (p.type === 'PATTERN' && (paint as PatternPaint).sourceNodeId !== p.sourceNodeId) ||
        (p.type === 'SHADER' && (paint as ShaderPaint).code !== p.code);
      paint = p;
      if (typeChanged || !refresh) render();
      else {
        syncHead();
        refresh();
      }
    },
    selectStop(i) {
      if (!isGradient(paint) || i >= paint.gradientStops.length) return;
      stopIndex = i;
      refresh?.();
    },
    removeStop() {
      if (!removeStop) return false;
      removeStop();
      return true;
    },
  };
  current = handle;
  render();
  pop.place();
}

/** Single color popup (shadow, page background): a color picker without paint type. */
export function openColorEditor(opts: ColorEditorOptions) {
  if (current?.key === opts.key) return current.close();
  current?.close();
  let color = opts.color;
  const pop = popover(opts, () => {
    if (current === handle) current = null;
  });
  const body = el('div', { className: 'pe-body' });
  const picker = colorPicker(
    { ...color },
    (c) => {
      color = opts.alpha === false ? { ...c, a: 1 } : c;
      opts.onChange(color);
    },
    { onStart: opts.onStart, onEnd: opts.onEnd, docColors: opts.docColors, alpha: opts.alpha },
  );
  body.append(picker.el);
  pop.box.append(body);
  const handle: Open = {
    key: opts.key,
    close: pop.close,
    update(v) {
      const c = v as RGBA;
      if (JSON.stringify(c) === JSON.stringify(color)) return;
      color = c;
      picker.set({ ...c });
    },
  };
  current = handle;
  pop.place();
}
