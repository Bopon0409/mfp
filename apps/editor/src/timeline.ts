// Animation timeline: bottom panel — playback, time cursor, tracks of the frame's
// animated layers with keyframes. The pose on the canvas at the cursor time is applied as edits without history and
// without sync (Document.preview). Editing a layer while the panel is open — a keyframe at the cursor time;
// for a property without a track (with recording on and not at time zero) — also a keyframe with the previous
// value at zero. Regular properties of animated layers always hold the pose at time zero: that is what
// other participants, the file and everything unaware of animation see.

import {
  ANIM_PROPERTIES,
  DEFAULT_KEY_EASING,
  MOTION_PRESETS,
  animatedNodes,
  animatedProps,
  animatedValue,
  animationRoot,
  applyMotion,
  baseValue,
  effectField,
  EFFECT_FIELDS,
  framePose,
  indexedProperty,
  timelinePlayback,
  timelineTime,
  withPlayback,
  motionFromTracks,
  textAnimationEnd,
  timelineDuration,
  withKey,
  withoutKey,
  withoutTrack,
  type AnimProperty,
  type AnimTrack,
  type BaseAnimProperty,
  type EffectField,
  type TimelinePlayback,
  type Easing,
  type Keyframe,
  type MotionStyle,
  type TextAnimation,
  type Op,
  type RGBA,
} from '@mfp/core';
import type { Editor } from './editor.ts';
import { h } from './dom.ts';
import { showMenu } from './menu.ts';
import { scrubTextInput } from './number-drag.ts';
import { ANIM_FORMATS, type AnimFormat } from './anim-export.ts';
import { lang } from './i18n/index.ts';

const LABEL: Record<BaseAnimProperty, string> = {
  x: 'X',
  y: 'Y',
  rotation: 'Поворот',
  scale: 'Масштаб',
  scaleX: 'Масштаб X',
  scaleY: 'Масштаб Y',
  opacity: 'Непрозрачность',
  width: 'Ширина',
  height: 'Высота',
  fill: 'Цвет заливки',
  stroke: 'Цвет обводки',
  strokeWeight: 'Толщина обводки',
  cornerRadius: 'Скругление',
  topLeftRadius: 'Скругление ↖',
  topRightRadius: 'Скругление ↗',
  bottomRightRadius: 'Скругление ↘',
  bottomLeftRadius: 'Скругление ↙',
  trimStart: 'Обрезка: начало',
  trimEnd: 'Обрезка: конец',
  itemSpacing: 'Промежуток',
  counterAxisSpacing: 'Промежуток строк',
  paddingLeft: 'Отступ слева',
  paddingTop: 'Отступ сверху',
  paddingRight: 'Отступ справа',
  paddingBottom: 'Отступ снизу',
  gridRowGap: 'Сетка: между строками',
  gridColumnGap: 'Сетка: между столбцами',
  strokeTopWeight: 'Обводка сверху',
  strokeRightWeight: 'Обводка справа',
  strokeBottomWeight: 'Обводка снизу',
  strokeLeftWeight: 'Обводка слева',
  rotateX: '3D: наклон X',
  rotateY: '3D: поворот Y',
  modelYaw: 'Модель: поворот',
  modelPitch: 'Модель: наклон',
  modelZoom: 'Модель: приближение',
  modelTime: 'Модель: кадр клипа',
};

const MODEL_GROUP: BaseAnimProperty[] = ['modelYaw', 'modelPitch', 'modelZoom', 'modelTime'];
const hasModel = (doc: Editor['doc'], id: string) => (doc.get(id, 'fills') ?? []).some((p) => p.type === 'MODEL3D');

/** Property groups in the “property for keyframe” list. */
const GROUPS: [string, BaseAnimProperty[]][] = [
  ['Положение и размер', ['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'width', 'height']],
  ['Вид', ['opacity', 'fill', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius']],
  ['Обводка', ['stroke', 'strokeWeight', 'trimStart', 'trimEnd', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight']],
  ['Раскладка', ['itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'gridRowGap', 'gridColumnGap']],
  ['3D', ['rotateX', 'rotateY']],
];

const EFFECT_LABEL: Record<EffectField, string> = {
  OFFSET_X: 'смещение X',
  OFFSET_Y: 'смещение Y',
  RADIUS: 'размытие',
  SPREAD: 'растяжение',
  COLOR: 'цвет',
  START_RADIUS: 'размытие в начале',
  NOISE_SIZE: 'размер зерна',
  DENSITY: 'плотность',
  EFFECT_OPACITY: 'непрозрачность',
  SECONDARY_COLOR: 'второй цвет',
  REFRACTION_RADIUS: 'глубина',
  REFRACTION_INTENSITY: 'преломление',
  SPECULAR_ANGLE: 'угол света',
  SPECULAR_INTENSITY: 'блик',
  CHROMATIC_ABERRATION: 'дисперсия',
};

const EFFECT_NAME: Record<string, string> = {
  DROP_SHADOW: 'Тень',
  INNER_SHADOW: 'Внутр. тень',
  LAYER_BLUR: 'Размытие',
  BACKGROUND_BLUR: 'Размытие фона',
  NOISE: 'Шум',
  TEXTURE: 'Текстура',
  GLASS: 'Стекло',
};

/** Property label (for effects — by the layer effect's kind). */
function propLabel(doc: Editor['doc'], id: string, p: AnimProperty): string {
  const ix = indexedProperty(p);
  if (!ix) return LABEL[p as BaseAnimProperty] ?? p;
  if (ix.kind === 'effect') return `${EFFECT_NAME[doc.get(id, 'effects')?.[ix.index]?.type ?? ''] ?? 'Эффект'} ${ix.index + 1}: ${EFFECT_LABEL[ix.field]}`;
  return `${ix.kind === 'fill' ? 'Заливка' : 'Обводка'} ${ix.index + 1}: цвет`;
}

/** Layer effect fields that can be animated. */
function effectProps(doc: Editor['doc'], id: string): AnimProperty[] {
  const out: AnimProperty[] = [];
  (doc.get(id, 'effects') ?? []).forEach((e, i) => {
    for (const f of EFFECT_FIELDS) if (effectField(e, f) !== null) out.push(`effect.${i}.${f}`);
  });
  return out;
}

/** Units in the keyframe value field: multiplier and label. */
const UNIT: Partial<Record<string, [number, string]>> = {
  rotation: [1, '°'],
  scale: [100, '%'],
  scaleX: [100, '%'],
  scaleY: [100, '%'],
  opacity: [100, '%'],
  trimStart: [100, '%'],
  trimEnd: [100, '%'],
  rotateX: [1, '°'],
  rotateY: [1, '°'],
  modelYaw: [1, '°'],
  modelPitch: [1, '°'],
  modelZoom: [100, '%'],
  modelTime: [1, 'с'],
};

const EASINGS: [Easing['type'], string][] = [
  ['EASE_IN_AND_OUT', 'Плавно'],
  ['LINEAR', 'Равномерно'],
  ['EASE_IN', 'Разгон'],
  ['EASE_OUT', 'Торможение'],
  ['EASE_IN_BACK', 'Разгон с замахом'],
  ['EASE_OUT_BACK', 'Торможение с перелётом'],
  ['EASE_IN_AND_OUT_BACK', 'С отскоком'],
  ['GENTLE', 'Пружина мягкая'],
  ['QUICK', 'Пружина быстрая'],
  ['BOUNCY', 'Пружина упругая'],
  ['SLOW', 'Пружина медленная'],
  ['HOLD', 'Удержание (скачком)'],
];

const PLAYBACKS: [TimelinePlayback, string][] = [
  ['ONCE', 'Один раз'],
  ['LOOP', 'По кругу'],
  ['PING_PONG', 'Туда-обратно'],
];

/** Document properties → animation properties they change (without the index). */
const SOURCES: Record<string, BaseAnimProperty[]> = {
  transform: ['x', 'y', 'rotation'],
  width: ['width', 'x'],
  height: ['height', 'y'],
  opacity: ['opacity'],
  cornerRadius: ['cornerRadius'],
  topLeftRadius: ['topLeftRadius'],
  topRightRadius: ['topRightRadius'],
  bottomRightRadius: ['bottomRightRadius'],
  bottomLeftRadius: ['bottomLeftRadius'],
  strokeWeight: ['strokeWeight'],
  strokeTopWeight: ['strokeTopWeight'],
  strokeRightWeight: ['strokeRightWeight'],
  strokeBottomWeight: ['strokeBottomWeight'],
  strokeLeftWeight: ['strokeLeftWeight'],
  pathTrimStart: ['trimStart'],
  pathTrimEnd: ['trimEnd'],
  itemSpacing: ['itemSpacing'],
  counterAxisSpacing: ['counterAxisSpacing'],
  paddingLeft: ['paddingLeft'],
  paddingTop: ['paddingTop'],
  paddingRight: ['paddingRight'],
  paddingBottom: ['paddingBottom'],
  gridRowGap: ['gridRowGap'],
  gridColumnGap: ['gridColumnGap'],
  rotateX: ['rotateX'],
  rotateY: ['rotateY'],
};

/**
 * Animation properties changed by editing the layer's document property key: color — the tracks with a paint
 * index, if any (otherwise the first solid), effects — all their fields.
 */
function sourcesOf(doc: Editor['doc'], id: string, key: string): AnimProperty[] {
  // Camera angle and frame of a 3D model live in the fill: editing the model's fill — their keyframes (what changed).
  if (key === 'fills' && hasModel(doc, id)) {
    const indexed = (doc.get(id, 'animation') ?? []).map((tr) => tr.property).filter((p) => indexedProperty(p)?.kind === 'fill');
    return [...MODEL_GROUP, ...(indexed.length ? indexed : ['fill' as const])];
  }
  if (key === 'fills' || key === 'strokes') {
    const kind = key === 'fills' ? 'fill' : 'stroke';
    const indexed = (doc.get(id, 'animation') ?? []).map((tr) => tr.property).filter((p) => indexedProperty(p)?.kind === kind);
    return indexed.length ? indexed : [kind];
  }
  if (key === 'effects') return effectProps(doc, id);
  return SOURCES[key] ?? [];
}

/** Layer properties whose values the cursor remembers (for recording keyframes). */
function rememberedProps(doc: Editor['doc'], id: string): AnimProperty[] {
  const tracks = (doc.get(id, 'animation') ?? []).map((tr) => tr.property);
  return [...new Set<AnimProperty>([...ANIM_PROPERTIES, ...effectProps(doc, id), ...tracks])];
}

const FPS = 60;
// Decimal separator of the interface language: a comma in Russian, a point in English.
const decimal = (s: string) => (lang === 'en' ? s : s.replace('.', ','));
const fmt = (t: number) => decimal(t.toFixed(2));
const num = (v: number) => decimal(String(Math.round(v * 100) / 100));
const same = (a: number | RGBA, b: number | RGBA) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-3 : JSON.stringify(a) === JSON.stringify(b);
const hex = (c: RGBA) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

export class Timeline {
  private ed: Editor;
  private host: HTMLElement;
  private el: HTMLElement;
  open = false;
  private root: string | null = null;
  private t = 0;
  private playing = false;
  /** Editing a property without a track while the panel is open — a new track (keyframes at zero and at the cursor). */
  recording = true;
  private raf = 0;
  private revert: (() => void) | null = null;
  /** Property values at the cursor time before the edit (for recording keyframes). */
  private shown = new Map<string, Map<AnimProperty, number | RGBA>>();
  private selected: { id: string; property: AnimProperty; t: number } | null = null;
  /** Our own document edits (pose, keyframes): changed skips them. */
  private applying = false;
  private renderQueued = false;
  private poseQueued = false;
  private dragging = false;
  private lastSelection = '';
  private doc: Editor['doc'] | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Export in progress: the pose is removed. */
  private suspended = false;
  /** Animation export (wired up by main.ts). */
  onExport: ((format: AnimFormat) => void) | null = null;
  /** The cursor moved, the panel opened or closed (figma.motion.playheadPosition for plugins). */
  onTime: (() => void)[] = [];

  /** Timeline cursor, seconds; panel closed or no frame — undefined. */
  get playhead(): number | undefined {
    return this.rootId ? this.t : undefined;
  }
  private exporting: number | null = null;

  constructor(ed: Editor, host: HTMLElement) {
    this.ed = ed;
    this.host = host;
    this.el = h('div', { class: 'timeline', hidden: true, tabindex: '-1' });
    host.append(this.el);
    this.attach();
    ed.onSelection.push(() => {
      if (!this.open || this.applying) return;
      const key = ed.selection.join(',');
      if (key !== this.lastSelection) this.follow();
      else this.queueRender();
    });
    // Page or file change: another frame, another document.
    ed.onPage.push(() => {
      if (this.ed.doc !== this.doc) {
        this.revert = null;
        this.root = null;
        this.attach();
      }
      if (this.open) this.follow();
    });
    this.el.addEventListener('keydown', (e) => this.key(e));
  }

  /** Subscription to edits of the editor's current document. */
  private attach() {
    this.unsubscribe?.();
    this.doc = this.ed.doc;
    this.unsubscribe = this.doc.onChange((ops, origin) => this.changed(ops, origin));
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  /** Timeline frame (null — panel closed or no frame). */
  get rootId(): string | null {
    return this.open && this.root && this.ed.doc.has(this.root) ? this.root : null;
  }

  /** Export: remove the pose until restored (call the result). */
  suspend(): () => void {
    this.pause();
    this.revertPose();
    this.suspended = true;
    return () => {
      this.suspended = false;
      if (this.open) {
        this.applyPose();
        this.render();
      }
    };
  }

  /** Export progress (0…1) in the panel header; null — finished. */
  progress(part: number | null) {
    this.exporting = part;
    const el = this.el.querySelector('.tl-export');
    if (el) el.textContent = part === null ? 'Экспорт' : `${Math.round(part * 100)}%`;
  }

  show() {
    if (this.open) return;
    this.open = true;
    queueMicrotask(() => this.onTime.forEach((cb) => cb()));
    this.el.hidden = false;
    this.host.classList.add('with-timeline');
    this.lastSelection = '';
    this.follow();
    this.el.focus();
  }

  close() {
    if (!this.open) return;
    this.pause();
    this.open = false;
    for (const cb of this.onTime) cb();
    this.revertPose();
    this.ed.setModelClock(null);
    this.normalize();
    this.el.hidden = true;
    this.host.classList.remove('with-timeline');
  }

  /** The selection's frame owns the timeline (otherwise the previous or first frame of the page). */
  private follow() {
    const doc = this.ed.doc;
    this.lastSelection = this.ed.selection.join(',');
    const sel = this.ed.selection.find((id) => doc.has(id));
    const root = (sel && animationRoot(doc, sel)) ?? (this.root && doc.has(this.root) ? this.root : (doc.children(this.ed.pageId).find((k) => doc.type(k) === 'FRAME') ?? null));
    if (root !== this.root) {
      this.pause();
      this.revertPose();
      this.normalize();
      this.root = root;
      this.t = 0;
      this.selected = null;
      this.applyPose();
    } else this.remember();
    this.render();
  }

  // ---------- Pose on the canvas ----------

  private revertPose() {
    this.applying = true;
    try {
      this.revert?.();
    } finally {
      this.applying = false;
    }
    this.revert = null;
  }

  /** The frame's pose at the cursor time — as a preview (without history and sync). */
  private applyPose() {
    this.poseQueued = false;
    const doc = this.ed.doc;
    const root = this.root;
    this.revertPose();
    this.shown.clear();
    // 3D model clips without frame keyframes play on the canvas following the timeline time (as in export).
    this.ed.setModelClock(root && doc.has(root) && !this.suspended ? this.t : null);
    if (!root || !doc.has(root) || this.suspended) return;
    this.applying = true;
    try {
      this.remember();
      const pose = framePose(doc, root, this.t);
      this.revert = pose.size
        ? doc.preview(() => {
            for (const [id, props] of pose) doc.set(id, props);
          })
        : null;
    } finally {
      this.applying = false;
    }
  }

  /** After others' and derived edits — re-pose once the batch of edits reaches everyone. */
  private schedulePose() {
    if (this.poseQueued) return;
    this.poseQueued = true;
    queueMicrotask(() => {
      if (this.poseQueued && this.open) this.applyPose();
      this.poseQueued = false;
    });
  }

  /** Values at the cursor time for the frame's animated and selected layers (previous ones — for keyframes). */
  private remember() {
    const doc = this.ed.doc;
    const root = this.root;
    if (!root || !doc.has(root)) return;
    for (const id of [...animatedNodes(doc, root), ...this.ed.selection]) {
      if (this.shown.has(id) || !doc.has(id) || animationRoot(doc, id) !== root) continue;
      this.shown.set(id, new Map(rememberedProps(doc, id).map((p) => [p, animatedValue(doc, id, p, this.t)])));
    }
  }

  /** Regular properties of animated layers — the pose at time zero (outside history, like layout). */
  private normalize() {
    const doc = this.ed.doc;
    const root = this.root;
    if (!root || !doc.has(root) || doc.previewing) return;
    const ids = animatedNodes(doc, root);
    if (!ids.length) return;
    this.applying = true;
    try {
      doc.transact(() => {
        for (const id of ids) {
          const p = animatedProps(doc, id, 0);
          if (p) doc.set(id, p);
        }
      }, 'layout');
    } finally {
      this.applying = false;
    }
  }

  /**
   * Layer tracks — in one undo step together with regular properties (pose at zero). amend — append
   * to the user's edit step (recording a keyframe from an edit on the canvas or in the panel).
   */
  private setTracks(id: string, tracks: AnimTrack[], amend = false) {
    const doc = this.ed.doc;
    if (!amend) this.revertPose();
    this.applying = true;
    try {
      const fn = () => {
        doc.set(id, { animation: tracks.length ? tracks : undefined });
        const p = animatedProps(doc, id, 0);
        if (p) doc.set(id, p);
      };
      if (amend) doc.amend(fn, 'local');
      else doc.transact(fn);
    } finally {
      this.applying = false;
    }
    if (!amend) {
      this.applyPose();
      this.queueRender();
    }
  }

  // ---------- Keyframe recording ----------

  private changed(ops: Op[], origin: string) {
    if (!this.open || this.applying || origin === 'preview') return;
    const doc = this.ed.doc;
    const root = this.root;
    if (root && !doc.has(root)) {
      this.root = null;
      this.revert = null;
    }
    if (origin !== 'local' || !root) {
      this.schedulePose();
      this.queueRender();
      return;
    }
    // Edits of the frame's layers: keyframes at the cursor time.
    const edits = new Map<string, Set<AnimProperty>>();
    for (const o of ops) {
      if (o.op !== 'set' || 'animation' in o.props || !doc.has(o.id) || animationRoot(doc, o.id) !== root) continue;
      for (const k of Object.keys(o.props)) {
        const props = sourcesOf(doc, o.id, k);
        if (!props.length) continue;
        const set = edits.get(o.id) ?? new Set<AnimProperty>();
        for (const p of props) set.add(p);
        edits.set(o.id, set);
      }
    }
    for (const [id, props] of edits) {
      const before = this.shown.get(id);
      let tracks: AnimTrack[] = [...(doc.get(id, 'animation') ?? [])];
      let keyed = false;
      for (const p of props) {
        // The edit is already in the document properties.
        const now = baseValue(doc, id, p);
        const was = before?.get(p);
        if (was !== undefined && same(was, now)) continue;
        if (!tracks.some((tr) => tr.property === p)) {
          // Without a track: at time zero or without recording — a regular edit.
          if (!this.recording || this.t < 1e-6 || was === undefined) continue;
          tracks = withKey(tracks, p, 0, was);
        }
        tracks = withKey(tracks, p, this.t, now);
        keyed = true;
      }
      if (keyed || tracks.length) this.setTracks(id, tracks, true);
    }
    this.applyPose();
    this.queueRender();
  }

  // ---------- Time ----------

  private seek(t: number) {
    const d = this.duration();
    this.t = Math.max(0, Math.min(d, Math.round(t * FPS) / FPS));
    this.applyPose();
    this.updatePlayhead();
  }

  private duration(): number {
    return this.root && this.ed.doc.has(this.root) ? timelineDuration(this.ed.doc, this.root) : 1;
  }

  play() {
    if (this.playing || !this.root) return;
    this.playing = true;
    const d = this.duration();
    if (this.t >= d - 1e-3) this.t = 0;
    const playback = timelinePlayback(this.ed.doc.get(this.root, 'timeline'));
    // Playback clock: ping-pong goes backward after the end (the time follows the clock).
    const start = performance.now() - this.t * 1000;
    const tick = (now: number) => {
      if (!this.playing) return;
      const clock = (now - start) / 1000;
      if (playback === 'ONCE' && clock >= d) this.playing = false;
      this.t = timelineTime(playback, d, clock);
      this.applyPose();
      this.updatePlayhead();
      if (this.playing) this.raf = requestAnimationFrame(tick);
      else this.render();
    };
    this.raf = requestAnimationFrame(tick);
    this.render();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.t = Math.round(this.t * FPS) / FPS;
    this.applyPose();
    this.render();
  }

  private key(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, select')) return;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (mod) return;
    let handled = true;
    if (e.key === ' ') {
      if (this.playing) this.pause();
      else this.play();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.pause();
      this.seek(this.t + (e.key === 'ArrowLeft' ? -1 : 1) / (e.shiftKey ? 10 : FPS));
    } else if (e.key === 'Home') {
      this.pause();
      this.seek(0);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) this.removeKey();
    else if (e.key === 'Escape') this.close();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private removeKey() {
    const s = this.selected;
    const doc = this.ed.doc;
    if (!s || !doc.has(s.id)) return;
    this.selected = null;
    this.setTracks(s.id, withoutKey(doc.get(s.id, 'animation') ?? [], s.property, s.t));
  }

  // ---------- Panel ----------

  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (this.open && !this.playing && !this.dragging) this.render();
    });
  }

  private updatePlayhead() {
    for (const cb of this.onTime) cb();
    const ph = this.el.querySelector<HTMLElement>('.tl-playhead');
    if (ph) ph.style.left = `${(this.t / this.duration()) * 100}%`;
    const time = this.el.querySelector('.tl-time');
    if (time) time.textContent = `${fmt(this.t)} / ${fmt(this.duration())} с`;
  }

  /** Value field of the selected keyframe (a number in its units or a color). */
  private valueField(id: string, property: AnimProperty, key: Keyframe) {
    const doc = this.ed.doc;
    const save = (value: number | RGBA) => this.setTracks(id, withKey(doc.get(id, 'animation') ?? [], property, key.t, value, key.easing));
    if (typeof key.value === 'object') {
      const c = key.value;
      const input = h('input', { type: 'color', class: 'tl-color', value: hex(c), title: 'Цвет в ключе' }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const v = input.value;
        save({ r: parseInt(v.slice(1, 3), 16) / 255, g: parseInt(v.slice(3, 5), 16) / 255, b: parseInt(v.slice(5, 7), 16) / 255, a: c.a });
      });
      return input;
    }
    const [k, unit] = UNIT[property] ?? [1, ''];
    const input = h('input', { class: 'tl-num tl-value', value: num(key.value * k), title: 'Значение в ключе' }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', () => {
      const v = Number(input.value.replace(',', '.').replace(/[^\d.+-]/g, ''));
      if (Number.isFinite(v)) save(v / k);
      else this.render();
    });
    return h('span', { class: 'tl-key' }, input, unit);
  }

  render() {
    if (!this.open) return;
    const doc = this.ed.doc;
    const root = this.root && doc.has(this.root) ? this.root : null;
    this.el.replaceChildren();
    if (!root) {
      this.el.append(h('div', { class: 'tl-empty' }, 'Выделите фрейм или слой в нём — у фрейма верхнего уровня свой таймлайн.'));
      return;
    }
    const d = this.duration();
    const tl = doc.get(root, 'timeline') ?? { duration: d };
    const setTimeline = (patch: Partial<typeof tl>) => {
      this.applying = true;
      try {
        doc.set(root, { timeline: { ...tl, duration: d, ...patch } });
      } finally {
        this.applying = false;
      }
      this.t = Math.min(this.t, this.duration());
      this.applyPose();
      this.render();
    };
    const btn = (label: string, title: string, on: () => void, cls = '') => h('button', { class: `tl-btn ${cls}`, title, onclick: on }, label);
    const duration = h('input', { class: 'tl-num', value: fmt(d), title: 'Длительность, секунды' }) as HTMLInputElement;
    duration.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') duration.blur();
    });
    duration.addEventListener('change', () => {
      const v = Number(duration.value.replace(',', '.'));
      if (Number.isFinite(v) && v > 0) setTimeline({ duration: Math.min(600, v) });
      else this.render();
    });
    const check = (label: string, on: boolean, set: (v: boolean) => void, title: string) => {
      const box = h('input', { type: 'checkbox', checked: on }) as HTMLInputElement;
      box.addEventListener('change', () => set(box.checked));
      return h('label', { class: 'tl-check', title }, box, label);
    };
    // Keyframe for the selected layer: property and “◆”.
    const target = this.ed.selection.find((id) => doc.has(id) && animationRoot(doc, id) === root) ?? null;
    const propSel = h(
      'select',
      { title: 'Свойство для ключа' },
      ...(target && hasModel(doc, target) ? [h('optgroup', { label: '3D-модель' }, ...MODEL_GROUP.map((p) => h('option', { value: p }, LABEL[p])))] : []),
      ...GROUPS.map(([label, props]) => h('optgroup', { label }, ...props.map((p) => h('option', { value: p }, LABEL[p])))),
      ...(target && effectProps(doc, target).length ? [h('optgroup', { label: 'Эффекты' }, ...effectProps(doc, target).map((p) => h('option', { value: p }, propLabel(doc, target, p))))] : []),
    ) as HTMLSelectElement;
    const addKey = () => {
      if (!target) return;
      const p = propSel.value as AnimProperty;
      this.selected = { id: target, property: p, t: this.t };
      this.setTracks(target, withKey(doc.get(target, 'animation') ?? [], p, this.t, animatedValue(doc, target, p, this.t)));
    };
    // Selected keyframe: value and the curve to the next one.
    const s = this.selected;
    const key = s && doc.has(s.id) ? (doc.get(s.id, 'animation') ?? []).find((tr) => tr.property === s.property)?.keys.find((k) => Math.abs(k.t - s.t) < 1e-3) : undefined;
    const keyTools = (() => {
      if (!s || !key) return h('span');
      const sel = h('select', { title: 'Кривая до следующего ключа' }, ...EASINGS.map(([v, l]) => h('option', { value: v, selected: v === (key.easing ?? DEFAULT_KEY_EASING).type }, l))) as HTMLSelectElement;
      sel.addEventListener('change', () => this.setTracks(s.id, withKey(doc.get(s.id, 'animation') ?? [], s.property, s.t, key.value, { type: sel.value as Easing['type'] })));
      return h('span', { class: 'tl-key' }, `${propLabel(doc, s.id, s.property)} в ${fmt(s.t)} с:`, this.valueField(s.id, s.property, key), sel, btn('Удалить', 'Удалить ключ (Delete)', () => this.removeKey()));
    })();
    // Motion styles: presets and custom ones — for the selected layers of this frame from the cursor time (0.08 s cascade).
    const selected = this.ed.selection.filter((id) => doc.has(id) && animationRoot(doc, id) === root);
    const motionBtn = h('button', { class: 'tl-btn', title: 'Стиль движения выделенным слоям с момента курсора (несколько — каскадом)' }, 'Движение ▾') as HTMLButtonElement;
    motionBtn.addEventListener('click', () => {
      const own = doc.get(doc.root, 'motionStyles') ?? [];
      const apply = (style: MotionStyle) => {
        doc.transact(() => {
          const end = applyMotion(doc, selected, style, this.t, selected.length > 1 ? 0.08 : 0);
          if (end > this.duration()) setTimeline({ duration: Math.min(600, Math.ceil(end * 10) / 10) });
        });
        this.applyPose();
        this.render();
      };
      const tracks = target ? (doc.get(target, 'animation') ?? []) : [];
      showMenu(
        motionBtn,
        [
          ...MOTION_PRESETS.map((p) => ({ label: p.name, disabled: !selected.length, run: () => apply(p) })),
          ...(own.length ? (['sep'] as const) : []),
          ...own.map((st) => ({ label: st.name, disabled: !selected.length, run: () => apply(st) })),
          ...(selected.some((id) => hasModel(doc, id))
            ? ([
                'sep',
                {
                  label: '3D: проиграть клип с этого момента',
                  run: () => void this.playClip(selected.filter((id) => hasModel(doc, id))),
                },
              ] as const)
            : []),
          'sep' as const,
          {
            label: 'Сохранить движение слоя как стиль…',
            disabled: !tracks.length,
            run: () => {
              const name = prompt('Название стиля движения', doc.get(target!, 'name') ?? 'Движение')?.trim();
              const style = name ? motionFromTracks(name, tracks) : null;
              if (style) doc.transact(() => doc.set(doc.root, { motionStyles: [...own.filter((x) => x.name !== name), style] }));
            },
          },
          ...(own.length ? [{ label: 'Удалить свой стиль', submenu: own.map((st) => ({ label: st.name, run: () => doc.transact(() => doc.set(doc.root, { motionStyles: own.filter((x) => x !== st) })) })) }] : []),
        ],
        'above',
      );
    });
    // Text animation for the selected text layer: effect and runs; start — the cursor time.
    const textTarget = target && doc.type(target) === 'TEXT' ? target : null;
    const textBtn = textTarget ? (h('button', { class: 'tl-btn', title: 'Анимация текста по буквам, словам или строкам с момента курсора' }, 'Текст ▾') as HTMLButtonElement) : null;
    textBtn?.addEventListener('click', () => {
      const cur = doc.get(textTarget!, 'textAnimation');
      const EFFECTS: [TextAnimation['effect'], string][] = [
        ['FADE', 'Появление'],
        ['RISE', 'Подъём'],
        ['DROP', 'Падение'],
        ['SCALE', 'Рост'],
        ['TYPEWRITER', 'Печатная машинка'],
      ];
      const BY: [TextAnimation['by'], string, number][] = [
        ['LETTER', 'По буквам', 0.035],
        ['WORD', 'По словам', 0.09],
        ['LINE', 'По строкам', 0.18],
      ];
      const set = (next: TextAnimation | undefined) => {
        doc.transact(() => {
          doc.set(textTarget!, { textAnimation: next });
          const end = next ? textAnimationEnd(next, doc.get(textTarget!, 'characters') ?? '') : 0;
          if (end > this.duration()) setTimeline({ duration: Math.min(600, Math.ceil(end * 10) / 10) });
        });
        this.applyPose();
        this.render();
      };
      showMenu(
        textBtn!,
        [
          ...EFFECTS.map(([effect, label]) => ({
            label,
            checked: cur?.effect === effect,
            submenu: BY.map(([by, byLabel, stagger]) => ({
              label: byLabel,
              checked: cur?.effect === effect && cur.by === by,
              run: () => set({ by, effect, start: Math.round(this.t * 100) / 100, duration: effect === 'TYPEWRITER' ? 0.01 : 0.45, stagger, easing: { type: 'EASE_OUT' } }),
            })),
          })),
          ...(cur ? (['sep', { label: 'Убрать анимацию текста', run: () => set(undefined) }] as const) : []),
        ],
        'above',
      );
    });
    const exportBtn = h('button', { class: 'tl-btn tl-export', title: 'Экспорт анимации: Lottie, GIF, видео' }, this.exporting === null ? 'Экспорт' : `${Math.round(this.exporting * 100)}%`) as HTMLButtonElement;
    exportBtn.addEventListener('click', () => {
      if (this.exporting !== null) return;
      showMenu(exportBtn, ANIM_FORMATS.map((f) => ({ label: `${f.label}…`, run: () => this.onExport?.(f.format) })), 'above');
    });
    const head = h(
      'div',
      { class: 'tl-head' },
      btn(this.playing ? '❚❚' : '▶', this.playing ? 'Пауза (пробел)' : 'Играть (пробел)', () => (this.playing ? this.pause() : this.play()), 'tl-play'),
      btn('⏮', 'В начало (Home)', () => (this.pause(), this.seek(0), this.render())),
      h('span', { class: 'tl-time' }, `${fmt(this.t)} / ${fmt(d)} с`),
      (() => {
        const lab = h('label', { class: 'tl-check tl-scrub', title: 'Длительность анимации; тяните подпись — менять' }, 'Длит.', duration);
        scrubTextInput(lab, duration, () => duration.dispatchEvent(new Event('change')), () => this.ed.doc.beginGroup(), () => this.ed.doc.endGroup(), { min: 0.1, max: 600, step: 0.1 });
        return lab;
      })(),
      (() => {
        const pb = h('select', { title: 'Повтор: один раз, по кругу или туда-обратно' }, ...PLAYBACKS.map(([v, l]) => h('option', { value: v, selected: v === timelinePlayback(tl) }, l))) as HTMLSelectElement;
        pb.addEventListener('change', () => setTimeline(withPlayback({ ...tl, duration: d }, pb.value as TimelinePlayback)));
        return pb;
      })(),
      check('В показе сразу', tl.autoplay !== false, (v) => setTimeline({ autoplay: v }), 'Анимация экрана играет, когда его показывают'),
      check('Запись', this.recording, (v) => ((this.recording = v), this.render()), 'Правка свойства без дорожки не в нулевой момент — новая дорожка с ключами'),
      h('span', { class: 'tl-sep' }),
      ...(target ? [propSel, btn('◆ Ключ', 'Ключ выделенному слою в момент курсора', addKey)] : []),
      keyTools,
      motionBtn,
      ...(textBtn ? [textBtn] : []),
      exportBtn,
      btn('×', 'Закрыть (Esc)', () => this.close(), 'tl-close'),
    );
    // Tracks: a layer — header row, properties — rows with keyframes.
    const ticks = h('div', { class: 'tl-ticks' });
    const step = d <= 2 ? 0.25 : d <= 5 ? 0.5 : d <= 15 ? 1 : 5;
    for (let i = 0; i * step <= d + 1e-6; i++) ticks.append(h('span', { class: 'tl-tick', style: `left:${((i * step) / d) * 100}%` }, fmt(i * step)));
    const ruler = h('div', { class: 'tl-ruler' }, ticks);
    const names = h('div', { class: 'tl-names' }, h('div', { class: 'tl-name tl-name-head' }, doc.get(root, 'name') ?? 'Фрейм'));
    const lanes = h('div', { class: 'tl-lanes' });
    const ids = animatedNodes(doc, root);
    if (target && !ids.includes(target)) ids.push(target);
    for (const id of ids) {
      names.append(h('div', { class: `tl-name tl-layer${this.ed.selection.includes(id) ? ' sel' : ''}`, onclick: () => this.ed.select([id]) }, doc.get(id, 'name') ?? id));
      lanes.append(h('div', { class: 'tl-lane tl-lane-layer' }));
      // Text animation — a bar from start to end.
      const ta = doc.get(id, 'textAnimation');
      if (ta) {
        const end = textAnimationEnd(ta, doc.get(id, 'characters') ?? '');
        names.append(h('div', { class: 'tl-name tl-prop' }, 'Текст'));
        lanes.append(h('div', { class: 'tl-lane' }, h('span', { class: 'tl-span tl-text-span', style: `left:${(ta.start / d) * 100}%;width:${(Math.max(0.02, end - ta.start) / d) * 100}%` })));
      }
      for (const tr of doc.get(id, 'animation') ?? []) {
        names.append(h('div', { class: 'tl-name tl-prop' }, propLabel(doc, id, tr.property)));
        const lane = h('div', { class: 'tl-lane' });
        // Segments between keyframes — as a bar.
        for (let i = 0; i + 1 < tr.keys.length; i++) lane.append(h('span', { class: 'tl-span', style: `left:${(tr.keys[i]!.t / d) * 100}%;width:${((tr.keys[i + 1]!.t - tr.keys[i]!.t) / d) * 100}%` }));
        for (const k of tr.keys) {
          const sel = s?.id === id && s.property === tr.property && Math.abs(s.t - k.t) < 1e-3;
          const dia = h('span', { class: `tl-keyframe${sel ? ' sel' : ''}${k.easing?.type === 'HOLD' ? ' hold' : ''}`, title: `${propLabel(doc, id, tr.property)}: ${fmt(k.t)} с`, style: `left:${(k.t / d) * 100}%` });
          dia.addEventListener('pointerdown', (e) => this.dragKey(e, dia, id, tr.property, k.t));
          lane.append(dia);
        }
        lanes.append(lane);
      }
    }
    const playhead = h('div', { class: 'tl-playhead', style: `left:${(this.t / d) * 100}%` });
    const area = h('div', { class: 'tl-area' }, ruler, lanes, playhead);
    area.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).classList.contains('tl-keyframe') || e.button !== 0) return;
      const r = ruler.getBoundingClientRect();
      const at = (ev: PointerEvent) => ((ev.clientX - r.left) / r.width) * d;
      this.pause();
      this.selected = null;
      this.dragging = true;
      this.seek(at(e));
      this.track((ev) => this.seek(at(ev)), () => {
        this.dragging = false;
        this.render();
        this.el.focus();
      });
    });
    this.el.append(head, h('div', { class: 'tl-rows' }, names, area));
  }

  /**
   * 3D model clip — as “Model: clip frame” keyframes from the cursor to the clip end (evenly): the clip follows
   * the timeline on the canvas, in presentation and in export. The timeline is extended to the clip end.
   */
  private async playClip(ids: string[]) {
    const doc = this.ed.doc;
    const t0 = this.t;
    let end = t0;
    for (const id of ids) {
      const m = (doc.get(id, 'fills') ?? []).find((p) => p.type === 'MODEL3D');
      if (m?.type !== 'MODEL3D' || !m.modelHash) continue;
      const info = await this.ed.models.info(m.modelHash);
      const name = m.clip === '' ? null : (m.clip ?? info?.clips[0]?.name ?? null);
      const d = info?.clips.find((c) => c.name === name)?.duration ?? 0;
      if (!d) {
        this.ed.notify?.('У модели нет клипа анимации');
        continue;
      }
      let tracks = withoutTrack(doc.get(id, 'animation') ?? [], 'modelTime');
      tracks = withKey(tracks, 'modelTime', t0, 0, { type: 'LINEAR' });
      tracks = withKey(tracks, 'modelTime', t0 + d, d);
      this.setTracks(id, tracks);
      end = Math.max(end, t0 + d);
    }
    const root = this.root;
    if (root && end > this.duration()) {
      const tl = doc.get(root, 'timeline') ?? { duration: end };
      doc.transact(() => doc.set(root, { timeline: { ...tl, duration: Math.min(600, Math.ceil(end * 10) / 10) } }));
      this.applyPose();
      this.render();
    }
  }

  /** Dragging a keyframe in time (step — one frame at 60 fps); one drag — one undo step. */
  private dragKey(e: PointerEvent, dia: HTMLElement, id: string, property: AnimProperty, t0: number) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const doc = this.ed.doc;
    this.pause();
    this.selected = { id, property, t: t0 };
    const r = dia.parentElement!.getBoundingClientRect();
    const d = this.duration();
    const startX = e.clientX;
    let cur = t0;
    let moved = false;
    this.dragging = true;
    const move = (ev: PointerEvent) => {
      const t = Math.max(0, Math.min(d, Math.round((t0 + ((ev.clientX - startX) / r.width) * d) * FPS) / FPS));
      if (Math.abs(t - cur) < 1e-6) return;
      const tracks = doc.get(id, 'animation') ?? [];
      const key = tracks.find((tr) => tr.property === property)?.keys.find((k) => Math.abs(k.t - cur) < 1e-3);
      if (!key) return;
      if (!moved) {
        moved = true;
        doc.beginGroup();
      }
      this.setTracks(id, withKey(withoutKey(tracks, property, cur), property, t, key.value, key.easing));
      cur = t;
      this.selected = { id, property, t };
      dia.style.left = `${(t / d) * 100}%`;
      dia.title = `${propLabel(doc, id, property)}: ${fmt(t)} с`;
    };
    this.track(move, () => {
      this.dragging = false;
      if (moved) doc.endGroup();
      else this.seek(t0);
      this.render();
      this.el.focus();
    });
  }

  /** Mouse drag: moves and release are tracked on the whole window (the pointer may leave the panel). */
  private track(move: (e: PointerEvent) => void, done: () => void) {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      done();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
}
