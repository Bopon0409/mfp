// The “Prototype” tab of the right panel (Shift+E).
// - Nothing selected: presentation device, presentation background, page flow starts.
// - Screen: flow start; any layer: interactions (list, “+”, settings popup); scrolling.
// Interaction popup: trigger (delay, key, time), actions in order (navigate, change variant,
// overlay, back, scroll, link, variable, mode, condition), destination, animation (type,
// direction, easing, duration); overlay settings are stored on the overlay itself.

import {
  SPRING_PRESETS,
  componentSetOf,
  defaultMode,
  formatPrototypeValue,
  isSpring,
  localCollections,
  localVariables,
  parsePrototypeExpression,
  reactionsOf,
  screenOf,
  screensOf,
  springDuration,
  userPages,
  variantsOf,
  type Document,
  type Easing,
  type Navigation,
  type PrototypeAction,
  type PrototypeDevice,
  type Props,
  type Reaction,
  type RGBA,
  type Transition,
  type Trigger,
} from '@mfp/core';
import type { Editor } from './editor.ts';
import { numberDrag, scrubTextInput } from './number-drag.ts';
import { h, iconBtn, popover, textInput } from './dom.ts';
import { showMenuAt } from './menu.ts';

/** What the tab needs from the panel and the editor. */
export interface PrototypePanelHost {
  colorField(key: string, color: RGBA, onChange: (c: RGBA) => void, alpha?: boolean): HTMLElement;
  /** Presentation from this screen (null — from the page flow). */
  present(start: string | null): void;
  /** Device size presets: [group, [name, width, height][]][]. */
  devices: readonly (readonly [string, readonly (readonly [string, number, number])[]])[];
}

// ---------- Labels ----------

export const TRIGGER_LABEL: Record<Trigger['type'], string> = {
  ON_CLICK: 'Щелчок',
  ON_DOUBLE_CLICK: 'Двойной щелчок',
  ON_RIGHT_CLICK: 'Правый щелчок',
  ON_DRAG: 'Перетаскивание',
  ON_HOVER: 'Пока наведено',
  ON_PRESS: 'Пока нажато',
  ON_KEY_DOWN: 'Клавиша / геймпад',
  MOUSE_ENTER: 'Указатель вошёл',
  MOUSE_LEAVE: 'Указатель ушёл',
  MOUSE_DOWN: 'Кнопка мыши нажата',
  MOUSE_UP: 'Кнопка мыши отпущена',
  AFTER_TIMEOUT: 'Через время',
  ON_MEDIA_HIT: 'Видео дошло до',
  ON_MEDIA_END: 'Видео закончилось',
  ON_SCROLL: 'Прокрутка',
  ON_TEXT_INPUT: 'Ввод в поле',
};
const TRIGGERS: Trigger['type'][] = ['ON_CLICK', 'ON_DOUBLE_CLICK', 'ON_RIGHT_CLICK', 'ON_DRAG', 'ON_HOVER', 'ON_PRESS', 'ON_KEY_DOWN', 'MOUSE_ENTER', 'MOUSE_LEAVE', 'MOUSE_DOWN', 'MOUSE_UP', 'AFTER_TIMEOUT', 'ON_SCROLL', 'ON_TEXT_INPUT'];
const SCROLL_DIRECTION: Record<Extract<Trigger, { type: 'ON_SCROLL' }>['direction'], string> = { DOWN: '↓', UP: '↑', ANY: '↕' };

type ActionKind = Navigation | 'BACK' | 'CLOSE' | 'URL' | 'SET_VARIABLE' | 'SET_VARIABLE_MODE' | 'CONDITIONAL' | 'UPDATE_MEDIA_RUNTIME' | 'SOUND';
const ACTION_LABEL: Record<ActionKind, string> = {
  NAVIGATE: 'Перейти к',
  CHANGE_TO: 'Сменить на',
  OVERLAY: 'Открыть оверлей',
  SWAP: 'Заменить оверлей',
  CLOSE: 'Закрыть оверлей',
  BACK: 'Назад',
  SCROLL_TO: 'Прокрутить к',
  URL: 'Открыть ссылку',
  SET_VARIABLE: 'Задать переменную',
  SET_VARIABLE_MODE: 'Сменить режим',
  CONDITIONAL: 'Условие',
  UPDATE_MEDIA_RUNTIME: 'Видео и Lottie',
  SOUND: 'Звук',
};
const ACTIONS: ActionKind[] = ['NAVIGATE', 'CHANGE_TO', 'OVERLAY', 'SWAP', 'CLOSE', 'BACK', 'SCROLL_TO', 'URL', 'SET_VARIABLE', 'SET_VARIABLE_MODE', 'CONDITIONAL', 'SOUND'];

type TransitionKind = 'INSTANT' | Transition['type'];
const TRANSITION_LABEL: Record<TransitionKind, string> = {
  INSTANT: 'Мгновенно',
  DISSOLVE: 'Растворение',
  SMART_ANIMATE: 'Морфинг',
  SCROLL_ANIMATE: 'Плавно',
  MOVE_IN: 'Надвинуть',
  MOVE_OUT: 'Сдвинуть',
  PUSH: 'Вытолкнуть',
  SLIDE_IN: 'Въехать',
  SLIDE_OUT: 'Выехать',
};
const DIRECTIONAL = new Set<TransitionKind>(['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT']);

// HOLD exists only for animation keyframes, prototype transitions don't have it.
const EASING_LABEL: Record<Exclude<Easing['type'], 'HOLD'>, string> = {
  LINEAR: 'Линейно',
  EASE_IN: 'Ускорение',
  EASE_OUT: 'Замедление',
  EASE_IN_AND_OUT: 'Ускорение и замедление',
  EASE_IN_BACK: 'Ускорение с оттягом',
  EASE_OUT_BACK: 'Замедление с перелётом',
  EASE_IN_AND_OUT_BACK: 'Оттяг и перелёт',
  CUSTOM_CUBIC_BEZIER: 'Своя кривая',
  GENTLE: 'Пружина: мягкая',
  QUICK: 'Пружина: быстрая',
  BOUNCY: 'Пружина: упругая',
  SLOW: 'Пружина: медленная',
  CUSTOM_SPRING: 'Своя пружина',
};

const OVERLAY_POSITION: [string, string][] = [
  ['CENTER', 'По центру'],
  ['TOP_LEFT', 'Сверху слева'],
  ['TOP_CENTER', 'Сверху по центру'],
  ['TOP_RIGHT', 'Сверху справа'],
  ['BOTTOM_LEFT', 'Снизу слева'],
  ['BOTTOM_CENTER', 'Снизу по центру'],
  ['BOTTOM_RIGHT', 'Снизу справа'],
  ['MANUAL', 'Вручную (от слоя)'],
];

const DIRECTION_ARROW: Record<'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM', string> = { LEFT: '←', RIGHT: '→', TOP: '↑', BOTTOM: '↓' };

/** Key by code (for the trigger label). */
function keyName(code: number): string {
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  const named: Record<number, string> = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 27: 'Esc', 32: 'Пробел', 37: '←', 38: '↑', 39: '→', 40: '↓', 46: 'Delete' };
  if (code >= 112 && code <= 123) return `F${code - 111}`;
  return named[code] ?? `#${code}`;
}

/** Gamepad buttons in the W3C standard mapping (number — index) — labels as on the controller. */
const PAD_BUTTONS: Record<string, string[]> = {
  XBOX_ONE: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'Левый стик', 'Правый стик', '↑', '↓', '←', '→', 'Xbox'],
  PS4: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', '↑', '↓', '←', '→', 'PS'],
  SWITCH_PRO: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'Левый стик', 'Правый стик', '↑', '↓', '←', '→', 'Home'],
  UNKNOWN_CONTROLLER: ['Нижняя', 'Правая', 'Левая', 'Верхняя', 'Левый бампер', 'Правый бампер', 'Левый курок', 'Правый курок', 'Выбор', 'Старт', 'Левый стик', 'Правый стик', '↑', '↓', '←', '→', 'Центр'],
};
const PAD_DEVICES = [
  ['KEYBOARD', 'Клавиатура'],
  ['XBOX_ONE', 'Геймпад Xbox'],
  ['PS4', 'Геймпад PlayStation'],
  ['SWITCH_PRO', 'Геймпад Switch'],
  ['UNKNOWN_CONTROLLER', 'Другой геймпад'],
] as const;
const padName = (device: string, code: number) => PAD_BUTTONS[device]?.[code] ?? `Кнопка ${code + 1}`;

export function triggerText(t: Trigger | null): string {
  if (!t) return 'Нет триггера';
  if (t.type === 'ON_KEY_DOWN' && (t.device ?? 'KEYBOARD') !== 'KEYBOARD') return t.keyCodes.length ? `Геймпад ${t.keyCodes.map((c) => padName(t.device, c)).join('+')}` : 'Геймпад';
  if (t.type === 'ON_KEY_DOWN') return t.keyCodes.length ? `Клавиша ${t.keyCodes.map(keyName).join('+')}` : 'Клавиша';
  if (t.type === 'ON_TEXT_INPUT') return t.submit ? 'Enter в поле' : 'Ввод в поле';
  if (t.type === 'AFTER_TIMEOUT') return `Через ${Math.round(t.timeout * 1000)} мс`;
  if (t.type === 'ON_SCROLL') return t.scroll === 'IN_VIEW' ? 'Слой появился при прокрутке' : `Прокрутка до ${Math.round(t.offset)} px ${SCROLL_DIRECTION[t.direction]}`;
  if ((t.type === 'MOUSE_ENTER' || t.type === 'MOUSE_LEAVE' || t.type === 'MOUSE_DOWN' || t.type === 'MOUSE_UP') && t.delay > 0) return `${TRIGGER_LABEL[t.type]} (${Math.round(t.delay * 1000)} мс)`;
  return TRIGGER_LABEL[t.type];
}

const nameOf = (doc: Document, id: string | null | undefined) => (id && doc.has(id) ? (doc.get(id, 'name') ?? '') : null);

export function actionText(doc: Document, a: PrototypeAction): string {
  switch (a.type) {
    case 'BACK':
      return 'Назад';
    case 'CLOSE':
      return 'Закрыть оверлей';
    case 'URL':
      return a.url ? `Ссылка: ${a.url.replace(/^https?:\/\//, '')}` : 'Ссылка: не задана';
    case 'SET_VARIABLE':
      return a.variableId && doc.has(a.variableId) ? `{${doc.get(a.variableId, 'name')}} = ${formatPrototypeValue(doc, a.variableValue) || '…'}` : 'Переменная: не выбрана';
    case 'SET_VARIABLE_MODE': {
      const modes = a.variableCollectionId && doc.has(a.variableCollectionId) ? (doc.get(a.variableCollectionId, 'modes') ?? []) : [];
      const m = modes.find((x) => x.modeId === a.variableModeId);
      return `Режим: ${m?.name ?? 'не выбран'}`;
    }
    case 'CONDITIONAL':
      return `Условие (${a.conditionalBlocks.length === 1 ? 'если' : `${a.conditionalBlocks.length} ветки`})`;
    case 'UPDATE_MEDIA_RUNTIME': {
      const what = MEDIA_ACTIONS.find(([k]) => k === a.mediaAction)?.[1] ?? 'Видео';
      const dest = nameOf(doc, a.destinationId);
      return dest ? `${what}: ${dest}` : what;
    }
    case 'SOUND':
      return `Звук: ${a.soundHash ? (a.name ?? 'файл') : 'не выбран'}`;
    case 'NODE': {
      const dest = nameOf(doc, a.destinationId);
      return `${ACTION_LABEL[a.navigation]}: ${dest ?? 'не выбрано'}`;
    }
  }
}

export function reactionText(doc: Document, r: Reaction): { trigger: string; action: string } {
  const first = r.actions[0];
  const more = r.actions.length > 1 ? ` и ещё ${r.actions.length - 1}` : '';
  return { trigger: triggerText(r.trigger), action: first ? `${actionText(doc, first)}${more}` : 'Нет действия' };
}

// ---------- Defaults ----------

const DEFAULT_EASING: Easing = { type: 'EASE_OUT' };

function defaultTrigger(type: Trigger['type'], prev: Trigger | null): Trigger {
  switch (type) {
    case 'AFTER_TIMEOUT':
      return { type, timeout: prev?.type === 'AFTER_TIMEOUT' ? prev.timeout : 0.8 };
    case 'MOUSE_ENTER':
    case 'MOUSE_LEAVE':
    case 'MOUSE_DOWN':
    case 'MOUSE_UP':
      return { type, delay: prev && 'delay' in prev ? prev.delay : 0 };
    case 'ON_KEY_DOWN':
      return { type, device: 'KEYBOARD', keyCodes: prev?.type === 'ON_KEY_DOWN' ? prev.keyCodes : [] };
    case 'ON_MEDIA_HIT':
      return { type, mediaHitTime: 0 };
    case 'ON_SCROLL':
      return { type, scroll: 'OFFSET', offset: 100, direction: 'DOWN' };
    case 'ON_TEXT_INPUT':
      return { type, submit: true };
    default:
      return { type } as Trigger;
  }
}

/** Set variants for “Change to”: of the instance or of the variant containing the layer. */
function changeTargets(doc: Document, id: string): { set: string | null; current: string | null } {
  for (let n: string | null = id; n; n = doc.parent(n)) {
    const t = doc.type(n);
    if (t === 'INSTANCE') {
      const comp = doc.get(n, 'componentId');
      const set = comp && doc.has(comp) ? componentSetOf(doc, comp) : null;
      if (set) return { set, current: comp ?? null };
    }
    if (t === 'COMPONENT') {
      const set = componentSetOf(doc, n);
      if (set) return { set, current: n };
    }
    if (t === 'PAGE') break;
  }
  return { set: null, current: null };
}

function defaultAction(doc: Document, id: string, kind: ActionKind, prev: PrototypeAction | null): PrototypeAction {
  const prevNode = prev?.type === 'NODE' ? prev : null;
  switch (kind) {
    case 'BACK':
    case 'CLOSE':
      return { type: kind };
    case 'URL':
      return { type: 'URL', url: prev?.type === 'URL' ? prev.url : '', openInNewTab: true };
    case 'SET_VARIABLE': {
      const v = localVariables(doc)[0] ?? null;
      return { type: 'SET_VARIABLE', variableId: v, variableValue: undefined };
    }
    case 'SET_VARIABLE_MODE': {
      const c = localCollections(doc)[0] ?? null;
      return { type: 'SET_VARIABLE_MODE', variableCollectionId: c, variableModeId: c ? defaultMode(doc, c) : null };
    }
    case 'CONDITIONAL':
      return { type: 'CONDITIONAL', conditionalBlocks: [{ condition: undefined, actions: [] }, { actions: [] }] };
    case 'UPDATE_MEDIA_RUNTIME':
      return { type: 'UPDATE_MEDIA_RUNTIME', destinationId: (doc.get(id, 'fills') ?? []).some((p) => p.type === 'VIDEO' || p.type === 'LOTTIE' || p.type === 'MODEL3D') ? id : null, mediaAction: 'TOGGLE_PLAY_PAUSE' };
    case 'SOUND':
      return prev?.type === 'SOUND' ? prev : { type: 'SOUND', soundHash: null };
    default: {
      let dest: string | null = null;
      if (kind === 'CHANGE_TO') {
        const { set, current } = changeTargets(doc, id);
        dest = set ? (variantsOf(doc, set).find((v) => v !== current) ?? null) : null;
      } else if (prevNode && prevNode.navigation !== 'CHANGE_TO' && prevNode.navigation !== 'SCROLL_TO' && kind !== 'SCROLL_TO') dest = prevNode.destinationId;
      const transition: Transition | null = kind === 'SCROLL_TO' ? { type: 'SCROLL_ANIMATE', easing: DEFAULT_EASING, duration: 0.3 } : (prevNode?.transition ?? null);
      return { type: 'NODE', destinationId: dest, navigation: kind, transition, ...(kind === 'NAVIGATE' || kind === 'SWAP' ? { preserveScrollPosition: false } : {}) };
    }
  }
}

function transitionOfKind(kind: TransitionKind, prev: Transition | null): Transition | null {
  if (kind === 'INSTANT') return null;
  const easing = prev?.easing ?? DEFAULT_EASING;
  const duration = prev?.duration || 0.3;
  if (DIRECTIONAL.has(kind)) return { type: kind as 'MOVE_IN', direction: prev && 'direction' in prev ? prev.direction : 'LEFT', matchLayers: prev && 'matchLayers' in prev ? prev.matchLayers : false, easing, duration };
  return { type: kind as 'DISSOLVE', easing, duration };
}

function easingOfType(type: Easing['type'], prev: Easing): Easing {
  if (type === 'CUSTOM_CUBIC_BEZIER') return { type, easingFunctionCubicBezier: prev.easingFunctionCubicBezier ?? { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } };
  if (type === 'CUSTOM_SPRING') {
    const p = SPRING_PRESETS[prev.type];
    return { type, easingFunctionSpring: prev.easingFunctionSpring ?? { mass: p?.[0] ?? 1, stiffness: p?.[1] ?? 100, damping: p?.[2] ?? 15, initialVelocity: 0 } };
  }
  return { type };
}

/** Spring duration, s. */
function springSeconds(e: Easing): number {
  const sp = e.easingFunctionSpring ?? (SPRING_PRESETS[e.type] ? { mass: SPRING_PRESETS[e.type]![0], stiffness: SPRING_PRESETS[e.type]![1], damping: SPRING_PRESETS[e.type]![2], initialVelocity: 0 } : null);
  return sp ? springDuration(sp.mass, sp.stiffness, sp.damping, sp.initialVelocity) : 0.3;
}

// ---------- Fields ----------

const select = <T extends string>(options: readonly (readonly [T, string])[], value: T | null, onChange: (v: T) => void, opts: { placeholder?: string; title?: string } = {}) => {
  const el = h(
    'select',
    { title: opts.title ?? '' },
    ...(value === null || !options.some(([v]) => v === value) ? [h('option', { value: '', selected: true, disabled: true }, opts.placeholder ?? 'Выберите…')] : []),
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
  ) as HTMLSelectElement;
  el.addEventListener('change', () => onChange(el.value as T));
  el.addEventListener('keydown', (e) => e.stopPropagation());
  return h('div', { class: 'field wide' }, el);
};

/** Number field (ms and others): Enter or blur applies. */
const numberField = (label: string, value: number, onChange: (v: number) => void, opts: { unit?: string; min?: number; max?: number; step?: number; title?: string; wide?: boolean } = {}) => {
  const input = h('input', { value: String(Math.round(value * 1000) / 1000) }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (opts.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      input.value = String(Math.round((Number(input.value.replace(',', '.')) + step) * 1000) / 1000);
      input.dispatchEvent(new Event('change'));
    }
  });
  input.addEventListener('change', () => {
    let v = Number(input.value.replace(',', '.'));
    if (!Number.isFinite(v)) return;
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    onChange(v);
  });
  const lab = h('label', {}, label);
  // Label scrubbing: each change goes through change (with min/max limits), one undo step.
  scrubTextInput(lab, input, () => input.dispatchEvent(new Event('change')), () => scrubDoc?.beginGroup(), () => scrubDoc?.endGroup(), { min: opts.min, max: opts.max, step: opts.step !== undefined && opts.step < 1 ? opts.step : undefined });
  return h('div', { class: `field${opts.wide ? ' wide' : ''}`, title: opts.title ?? '' }, lab, input, opts.unit ? h('span', { class: 'unit' }, opts.unit) : null);
};
/** Document for undo groups while scrubbing fields (set by prototypeSections). */
let scrubDoc: { beginGroup(): void; endGroup(): void } | null = null;

const checkRow = (label: string, checked: boolean, onChange: (v: boolean) => void, title?: string) => {
  const box = h('input', { type: 'checkbox', checked }) as HTMLInputElement;
  box.addEventListener('change', () => onChange(box.checked));
  return h('label', { class: 'check-row', title: title ?? '' }, box, label);
};

// ---------- Tab ----------

export function prototypeSections(ed: Editor, host: PrototypePanelHost): HTMLElement[] {
  scrubDoc = ed.doc;
  const doc = ed.doc;
  const sel = ed.selection.filter((id) => doc.has(id));
  if (!sel.length) return pageSections(ed, host);
  const out: HTMLElement[] = [];
  if (sel.length === 1) {
    const id = sel[0]!;
    if (screenOf(doc, id) === id) out.push(flowSection(ed, host, id));
    out.push(interactionsSection(ed, id));
  } else out.push(h('div', { class: 'section' }, h('h3', {}, 'Взаимодействия'), h('div', { class: 'empty' }, 'Выделите один слой, чтобы настроить его взаимодействия.')));
  const input = inputSection(ed, sel);
  if (input) out.push(input);
  const scroll = scrollSection(ed, sel);
  if (scroll) out.push(scroll);
  const video = videoSection(ed, sel);
  if (video) out.push(video);
  return out;
}

/**
 * Input field in presentation (our own): a text or a layer containing text is edited with a real
 * field; the value goes into a string variable; the “On input” trigger fires on Enter or on every change.
 */
function inputSection(ed: Editor, sel: string[]): HTMLElement | null {
  const doc = ed.doc;
  if (sel.length !== 1) return null;
  const id = sel[0]!;
  const hasText = doc.type(id) === 'TEXT' || [...doc.descendants(id)].some((x) => doc.type(x) === 'TEXT');
  if (!hasText) return null;
  const spec = doc.get(id, 'prototypeInput');
  // The section exists only for an enabled field; it is enabled in “⋯” of the “Interactions” header.
  if (!spec) return null;
  const set = (next: Props['prototypeInput'] | undefined) => doc.transact(() => doc.set(id, { prototypeInput: next }));
  const rows: (HTMLElement | null)[] = [];
  {
    const vars = localVariables(doc, 'STRING');
    rows.push(
      h('div', { class: 'proto-label wide' }, 'Вид поля'),
      select(
        [
          ['TEXT', 'Текст'],
          ['PASSWORD', 'Пароль'],
          ['EMAIL', 'Почта'],
          ['NUMBER', 'Число'],
          ['MULTILINE', 'Несколько строк'],
        ] as const,
        spec.kind ?? 'TEXT',
        (v) => set({ ...spec, kind: v }),
      ),
      h('div', { class: 'proto-label wide' }, 'Значение — в переменную'),
      select([['', 'Не сохранять'] as const, ...vars.map((v) => [v, doc.get(v, 'name') ?? v] as const)], spec.variableId ?? '', (v) => set({ ...spec, variableId: v || undefined }), { title: 'Строковая переменная: её можно привязать к тексту и проверять в условиях' }),
      h('div', { class: 'proto-label wide' }, 'Подсказка'),
      textInput(spec.placeholder ?? '', (v) => set({ ...spec, placeholder: v || undefined }), { placeholder: 'Как текст слоя' }),
    );
  }
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, 'Поле ввода в показе', h('span', { class: 'h-acts' }, iconBtn('minus', 'Убрать поле ввода', () => set(undefined), ''))),
    h('div', { class: 'props' }, ...rows.filter((x): x is HTMLElement => !!x)),
  );
}

/** Whether a layer can become an input field (a text or a layer containing text). */
const canBeInput = (doc: Editor['doc'], id: string) => doc.type(id) === 'TEXT' || [...doc.descendants(id)].some((x) => doc.type(x) === 'TEXT');

/** Layer video and Lottie in presentation (for layers with such a fill): autoplay, loop, muted. */
function videoSection(ed: Editor, sel: string[]): HTMLElement | null {
  const doc = ed.doc;
  const ids = sel.filter((id) => (doc.get(id, 'fills') ?? []).some((p) => p.type === 'VIDEO' || p.type === 'LOTTIE' || p.type === 'MODEL3D'));
  if (!ids.length) return null;
  const video = ids.some((id) => (doc.get(id, 'fills') ?? []).some((p) => p.type === 'VIDEO'));
  const pb = (id: string) => doc.get(id, 'videoPlayback') ?? {};
  const set = (key: 'autoplay' | 'loop' | 'muted', on: boolean) => doc.transact(() => ids.forEach((id) => doc.set(id, { videoPlayback: { ...pb(id), [key]: on } })));
  const first = pb(ids[0]!);
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, video ? 'Видео' : ids.some((id) => (doc.get(id, 'fills') ?? []).some((p) => p.type === 'MODEL3D')) ? 'Анимация 3D-модели' : 'Анимация Lottie'),
    h(
      'div',
      { class: 'props' },
      checkRow('Запускать сразу', first.autoplay !== false, (on) => set('autoplay', on), 'Начинает играть, когда экран показан'),
      checkRow('По кругу', first.loop !== false, (on) => set('loop', on), 'Закончившись, начинается сначала'),
      ...(video ? [checkRow('Без звука', first.muted === true, (on) => set('muted', on), 'Звук видео выключен (включить — действием «Видео: звук»)')] : []),
    ),
  );
}

/** Device label: “iPhone 16”, “Custom 390×844”, “Fit to window”. */
export function deviceText(d: PrototypeDevice | undefined): string {
  if (!d) return 'Как у страницы';
  if (d.type === 'PRESET') return d.presetIdentifier ?? 'Устройство';
  if (d.type === 'CUSTOM') return d.size ? `Свой ${d.size.width}×${d.size.height}` : 'Свой размер';
  return d.type === 'NONE' ? 'По размеру экрана' : 'Вписать в окно';
}

/**
 * Presentation device picker: a list; for a custom size — width and height; for a size — “landscape”.
 * inherit — “Same as page” as the first item (the flow device; undefined — not set).
 */
function deviceControls(host: PrototypePanelHost, dev: PrototypeDevice | undefined, setDevice: (d: PrototypeDevice | undefined) => void, inherit = false): HTMLElement[] {
  const presetKey = !dev ? 'INHERIT' : dev.type === 'PRESET' ? `P:${dev.presetIdentifier ?? ''}` : dev.type;
  const deviceSel = h('select', { title: inherit ? 'Устройство показа этого потока' : 'Устройство показа' }) as HTMLSelectElement;
  deviceSel.append(
    ...(inherit ? [h('option', { value: 'INHERIT', selected: presetKey === 'INHERIT' }, 'Как у страницы')] : []),
    h('option', { value: 'PRESENTATION', selected: presetKey === 'PRESENTATION' }, 'Вписать в окно'),
    h('option', { value: 'NONE', selected: presetKey === 'NONE' }, 'По размеру экрана'),
    ...host.devices.slice(0, 3).map(([group, items]) => h('optgroup', { label: group }, ...items.map(([name, w, hh]) => h('option', { value: `P:${name}`, selected: presetKey === `P:${name}`, 'data-w': w, 'data-h': hh }, `${name} — ${w}×${hh}`)))),
    h('option', { value: 'CUSTOM', selected: presetKey === 'CUSTOM' }, 'Свой размер'),
  );
  // A device not in the list (e.g. from a Figma file) — shown by its own name, not as the first item.
  if (dev?.type === 'PRESET' && ![...deviceSel.options].some((o) => o.value === presetKey))
    deviceSel.append(h('option', { value: presetKey, selected: true, 'data-w': dev.size?.width ?? 0, 'data-h': dev.size?.height ?? 0 }, dev.size ? `${dev.presetIdentifier ?? 'Устройство'} — ${dev.size.width}×${dev.size.height}` : (dev.presetIdentifier ?? 'Устройство')));
  deviceSel.addEventListener('keydown', (e) => e.stopPropagation());
  deviceSel.addEventListener('change', () => {
    const v = deviceSel.value;
    if (v === 'INHERIT') setDevice(undefined);
    else if (v === 'PRESENTATION' || v === 'NONE') setDevice({ type: v });
    else if (v === 'CUSTOM') setDevice({ type: 'CUSTOM', size: dev?.size ?? { width: 390, height: 844 }, rotation: dev?.rotation ?? 'NONE' });
    else {
      const opt = deviceSel.selectedOptions[0]!;
      setDevice({ type: 'PRESET', presetIdentifier: v.slice(2), size: { width: Number(opt.dataset.w), height: Number(opt.dataset.h) }, rotation: dev?.rotation ?? 'NONE' });
    }
  });
  const sized = dev && (dev.type === 'PRESET' || dev.type === 'CUSTOM') && dev.size;
  // “Label — value” rows; orientation as two buttons.
  const orientation = (on: boolean, title: string, svg: string) => {
    const b = h('button', { class: on ? 'on' : '', title, 'aria-label': title, onclick: () => sized && setDevice({ ...dev, rotation: title === 'Альбомная' ? 'CCW_90' : 'NONE' }) });
    b.innerHTML = svg;
    return b;
  };
  return [
    settingRow('Устройство', h('div', { class: 'field' }, deviceSel)),
    ...(dev?.type === 'CUSTOM' && dev.size
      ? [
          settingRow('Размер', h('div', { class: 'prow' },
            numberField('Ш', dev.size.width, (w) => setDevice({ ...dev, size: { width: Math.max(1, Math.round(w)), height: dev.size!.height } }), { title: 'Ширина' }),
            numberField('В', dev.size.height, (hh) => setDevice({ ...dev, size: { width: dev.size!.width, height: Math.max(1, Math.round(hh)) } }), { title: 'Высота' }),
          )),
        ]
      : []),
    ...(sized
      ? [
          settingRow('Ориентация', h('div', { class: 'seg' },
            orientation(dev.rotation !== 'CCW_90', 'Книжная', '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="4.5" width="8" height="15" rx="1.5"/></svg>'),
            orientation(dev.rotation === 'CCW_90', 'Альбомная', '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4.5" y="8" width="15" height="8" rx="1.5"/></svg>'),
          )),
        ]
      : []),
  ];
}

/** Settings row: label on the left, value on the right. */
function settingRow(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, label), control);
}

/** Nothing selected: device, presentation background, flows. */
function pageSections(ed: Editor, host: PrototypePanelHost): HTMLElement[] {
  const doc = ed.doc;
  const page = ed.pageId;
  const dev: PrototypeDevice = doc.get(page, 'prototypeDevice') ?? { type: 'PRESENTATION' };
  const setDevice = (d: PrototypeDevice | undefined) => d && doc.transact(() => doc.set(page, { prototypeDevice: d }));
  const bg = doc.get(page, 'prototypeBackgrounds')?.[0];
  const color = bg?.type === 'SOLID' ? bg.color : { r: 0.12, g: 0.12, b: 0.12 };
  // One section: device, size, orientation, background.
  const device = h(
    'div',
    { class: 'section' },
    h('h3', {}, 'Настройки прототипа'),
    h('div', { class: 'props' },
      ...deviceControls(host, dev, setDevice),
      settingRow('Фон', host.colorField(`proto-bg:${page}`, { ...color, a: 1 }, (c) => doc.set(page, { prototypeBackgrounds: [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } }] }), false)),
    ),
  );
  const flows = (doc.get(page, 'flowStartingPoints') ?? []).filter((f) => doc.has(f.nodeId));
  const flowsSec = h(
    'div',
    { class: 'section' },
    h('h3', {}, 'Потоки'),
    flows.length
      ? h(
          'div',
          { class: 'props comp-props' },
          ...flows.map((f) =>
            h(
              'div',
              { class: 'proto-row', title: `Начало: ${doc.get(f.nodeId, 'name') ?? ''}` },
              iconBtn('play', 'Показ с этого потока', () => host.present(f.nodeId), 'icon-btn sm'),
              h('button', { class: 'proto-row-main', onclick: () => (ed.select([f.nodeId]), ed.fitRect(ed.selectionBounds([f.nodeId]))) }, h('span', { class: 'proto-trigger' }, f.name || 'Поток'), h('span', { class: 'proto-action' }, f.device ? `${doc.get(f.nodeId, 'name') ?? ''} · ${deviceText(f.device)}` : (doc.get(f.nodeId, 'name') ?? ''))),
              iconBtn('minus', 'Убрать начало потока', () => removeFlow(doc, page, f.nodeId), 'icon-btn sm'),
            ),
          ),
        )
      : h('div', { class: 'empty' }, 'Начала потоков нет: выделите экран и добавьте его кнопкой «+» в разделе «Начало потока». Показ без потока — с первого экрана страницы.'),
  );
  return [device, flowsSec];
}

function removeFlow(doc: Document, page: string, nodeId: string) {
  doc.transact(() => doc.set(page, { flowStartingPoints: (doc.get(page, 'flowStartingPoints') ?? []).filter((f) => f.nodeId !== nodeId) }));
}

/** Screen: flow start (add, name, description, remove, present). */
function flowSection(ed: Editor, host: PrototypePanelHost, id: string): HTMLElement {
  const doc = ed.doc;
  const page = ed.pageId;
  const flows = doc.get(page, 'flowStartingPoints') ?? [];
  const flow = flows.find((f) => f.nodeId === id);
  const set = (patch: { name?: string; description?: string; device?: PrototypeDevice }) =>
    doc.transact(() => doc.set(page, { flowStartingPoints: (doc.get(page, 'flowStartingPoints') ?? []).map((f) => (f.nodeId === id ? { ...f, ...patch, ...(patch.description === '' ? { description: undefined } : {}) } : f)) }));
  // Flow device: “same as page” removes the field.
  const setDevice = (d: PrototypeDevice | undefined) =>
    doc.transact(() =>
      doc.set(page, {
        flowStartingPoints: (doc.get(page, 'flowStartingPoints') ?? []).map((f) => {
          if (f.nodeId !== id) return f;
          const { device: _, ...rest } = f;
          return d ? { ...rest, device: d } : rest;
        }),
      }),
    );
  if (!flow) {
    const add = () => {
      const n = flows.length + 1;
      doc.transact(() => doc.set(page, { flowStartingPoints: [...flows, { nodeId: id, name: `Поток ${n}` }] }));
    };
    return h('div', { class: 'section' }, h('h3', {}, 'Начало потока', h('span', { class: 'h-acts' }, iconBtn('plus', 'Сделать экран началом потока', add, ''))));
  }
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, 'Начало потока', h('span', { class: 'h-acts' }, iconBtn('play', 'Показ с этого потока', () => host.present(id), ''), iconBtn('minus', 'Убрать начало потока', () => removeFlow(doc, page, id), ''))),
    h(
      'div',
      { class: 'props' },
      h('div', { class: 'field wide' }, textInput(flow.name, (v) => set({ name: v.trim() || flow.name }), { placeholder: 'Имя потока' })),
      h('div', { class: 'field wide' }, textInput(flow.description ?? '', (v) => set({ description: v.trim() }), { placeholder: 'Описание (необязательно)' })),
      h('div', { class: 'proto-label wide' }, 'Устройство потока'),
      ...deviceControls(host, flow.device, setDevice, true),
    ),
  );
}

/** Layer reactions for editing: for an instance — with the component's reactions (its own take precedence). */
function editableReactions(doc: Document, id: string): Reaction[] {
  return doc.type(id) === 'INSTANCE' ? reactionsOf(doc, id) : (doc.get(id, 'reactions') ?? []);
}

function setReactions(doc: Document, id: string, list: Reaction[]) {
  doc.transact(() => doc.set(id, { reactions: list }));
}

/** Layer interactions: list, “+”, settings popup. */
function interactionsSection(ed: Editor, id: string): HTMLElement {
  const doc = ed.doc;
  const list = editableReactions(doc, id);
  const rows = h('div', { class: 'props comp-props' });
  const add = () => {
    const r: Reaction = { trigger: { type: list.some((x) => x.trigger?.type === 'ON_CLICK') ? 'ON_HOVER' : 'ON_CLICK' } as Trigger, actions: [{ type: 'NODE', destinationId: null, navigation: 'NAVIGATE', transition: null }] };
    setReactions(doc, id, [...list, r]);
    // The new interaction's settings popup opens after the panel redraws.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`#properties .proto-row[data-index="${list.length}"] .proto-row-main`)?.click());
  };
  list.forEach((r, i) => {
    const t = reactionText(doc, r);
    const main = h('button', { class: 'proto-row-main' }, h('span', { class: 'proto-trigger' }, t.trigger), h('span', { class: 'proto-action' }, t.action));
    main.addEventListener('click', () => openInteraction(ed, id, i, main));
    rows.append(
      h(
        'div',
        { class: 'proto-row', 'data-index': i },
        main,
        iconBtn('minus', 'Удалить взаимодействие', () => setReactions(doc, id, editableReactions(doc, id).filter((_, k) => k !== i)), 'icon-btn sm'),
      ),
    );
  });
  return h(
    'div',
    { class: 'section' },
    h(
      'h3',
      {},
      'Взаимодействия',
      h(
        'span',
        { class: 'h-acts' },
        ...(canBeInput(doc, id) && !doc.get(id, 'prototypeInput')
          ? [
              iconBtn('more', 'Ещё', (e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                showMenuAt(r.left, r.bottom + 4, [{ label: 'Поле ввода в показе', run: () => doc.transact(() => doc.set(id, { prototypeInput: { kind: 'TEXT' } })) }]);
              }, ''),
            ]
          : []),
        iconBtn('plus', 'Добавить взаимодействие', add, ''),
      ),
    ),
    list.length ? rows : h('div', { class: 'empty' }, 'Нет взаимодействий. «+» — добавить: например, щелчок ведёт на другой экран.'),
  );
}

/** Scrolling: for a frame — the direction, for a layer in a frame — its scroll position behavior. */
function scrollSection(ed: Editor, sel: string[]): HTMLElement | null {
  const doc = ed.doc;
  const frames = sel.filter((id) => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(doc.type(id)!));
  const inFrame = sel.filter((id) => {
    const p = doc.parent(id);
    const pt = p ? doc.type(p) : null;
    return pt === 'FRAME' || pt === 'COMPONENT' || pt === 'INSTANCE';
  });
  if (!frames.length && !inFrame.length) return null;
  const same = <T>(ids: string[], get: (id: string) => T): T | null => {
    const v = get(ids[0]!);
    return ids.every((x) => get(x) === v) ? v : null;
  };
  const props = h('div', { class: 'props' });
  if (frames.length) {
    const cur = same(frames, (x) => doc.get(x, 'overflowDirection') ?? 'NONE');
    props.append(
      h('div', { class: 'proto-label wide' }, 'Прокрутка содержимого'),
      select(
        [
          ['NONE', 'Без прокрутки'],
          ['VERTICAL', 'По вертикали'],
          ['HORIZONTAL', 'По горизонтали'],
          ['BOTH', 'В обе стороны'],
        ],
        cur,
        (v) => doc.transact(() => frames.forEach((x) => doc.set(x, { overflowDirection: v }))),
        { placeholder: 'Разные' },
      ),
    );
  }
  if (inFrame.length) {
    const cur = same(inFrame, (x) => doc.get(x, 'scrollBehavior') ?? 'SCROLLS');
    props.append(
      h('div', { class: 'proto-label wide' }, 'Положение при прокрутке'),
      select(
        [
          ['SCROLLS', 'Прокручивается'],
          ['FIXED', 'Закреплён'],
          ['STICKY_SCROLLS', 'Липкий (прилипает к краю)'],
        ],
        cur,
        (v) => doc.transact(() => inFrame.forEach((x) => doc.set(x, { scrollBehavior: v }))),
        { placeholder: 'Разные' },
      ),
    );
  }
  return h('div', { class: 'section' }, h('h3', {}, 'Прокрутка'), props);
}

// ---------- Interaction popup ----------

/** Open the settings popup of the layer's i-th interaction. */
export function openInteraction(ed: Editor, id: string, index: number, anchor: HTMLElement) {
  const { box, close } = popover(anchor, 'proto-pop', { width: 280, side: 'left' });
  const doc = ed.doc;
  const render = () => {
    const list = editableReactions(doc, id);
    const r = list[index];
    if (!r || !doc.has(id)) {
      box.replaceChildren(h('div', { class: 'empty' }, 'Взаимодействие удалено.'));
      return;
    }
    const update = (next: Reaction) => {
      // A copy: the document's array is left untouched (it is immutable, and Undo needs the previous one).
      const fresh = [...editableReactions(doc, id)];
      if (index >= fresh.length) return render(); // the interaction is already deleted (Undo, collaborator)
      fresh[index] = next;
      setReactions(doc, id, fresh);
      render();
    };
    // Interaction popup: the trigger as the header, “+” adds another action, “×” closes.
    const trigger = triggerEditor(r, (t) => update({ ...r, trigger: t }));
    const trigSel = trigger.firstElementChild as HTMLElement;
    trigSel.classList.add('proto-trigger-sel');
    const head = h(
      'div',
      { class: 'pop-head proto-head' },
      trigSel,
      iconBtn('plus', 'Добавить действие', () => update({ ...r, actions: [...r.actions, defaultAction(doc, id, 'BACK', null)] }), 'icon-btn sm'),
      iconBtn('close', 'Закрыть (Esc)', () => close(), 'icon-btn sm'),
    );
    box.replaceChildren(head, ...(trigger.childElementCount ? [trigger] : []), actionsEditor(ed, id, r.actions, (actions) => update({ ...r, actions }), 0));
  };
  render();
}

function triggerEditor(r: Reaction, set: (t: Trigger) => void): HTMLElement {
  const t = r.trigger;
  const wrap = h('div', { class: 'props proto-block' });
  wrap.append(
    select(
      TRIGGERS.map((x) => [x, TRIGGER_LABEL[x]] as const),
      t?.type ?? null,
      (v) => set(defaultTrigger(v, t)),
      { title: 'Триггер' },
    ),
  );
  if (t?.type === 'AFTER_TIMEOUT') wrap.append(numberField('Через', t.timeout * 1000, (ms) => set({ ...t, timeout: Math.max(0, ms) / 1000 }), { unit: 'мс', step: 100, wide: true, title: 'Задержка до срабатывания' }));
  if (t && (t.type === 'MOUSE_ENTER' || t.type === 'MOUSE_LEAVE' || t.type === 'MOUSE_DOWN' || t.type === 'MOUSE_UP'))
    wrap.append(numberField('Задержка', t.delay * 1000, (ms) => set({ ...t, delay: Math.max(0, ms) / 1000 }), { unit: 'мс', step: 100, wide: true }));
  if (t?.type === 'ON_SCROLL') {
    // Scrolling belongs to the layer's nearest scrollable ancestor (or the screen).
    wrap.append(
      select(
        [
          ['OFFSET', 'До отметки'],
          ['IN_VIEW', 'Слой появился в окне'],
        ] as const,
        t.scroll,
        (v) => set({ ...t, scroll: v }),
        { title: 'Когда срабатывает' },
      ),
    );
    if (t.scroll === 'OFFSET') {
      wrap.append(numberField('Отметка', t.offset, (px) => set({ ...t, offset: Math.max(0, px) }), { unit: 'px', step: 10, wide: true, title: 'Прокрутка контейнера, пикселей' }));
      wrap.append(
        select(
          [
            ['DOWN', 'Вниз (или вправо)'],
            ['UP', 'Вверх (или влево)'],
            ['ANY', 'В обе стороны'],
          ] as const,
          t.direction,
          (v) => set({ ...t, direction: v }),
          { title: 'Направление' },
        ),
      );
    }
  }
  if (t?.type === 'ON_TEXT_INPUT') {
    wrap.append(
      select(
        [
          ['SUBMIT', 'По Enter'],
          ['CHANGE', 'При каждом изменении'],
        ] as const,
        t.submit ? 'SUBMIT' : 'CHANGE',
        (v) => set({ ...t, submit: v === 'SUBMIT' }),
        { title: 'Когда срабатывает: по Enter в поле или при каждом изменении текста' },
      ),
    );
  }
  if (t?.type === 'ON_KEY_DOWN') {
    const device = t.device ?? 'KEYBOARD';
    wrap.append(select(PAD_DEVICES, device, (v) => set({ ...t, device: v, keyCodes: [] }), { title: 'Устройство: клавиатура или геймпад' }));
  }
  if (t?.type === 'ON_KEY_DOWN' && (t.device ?? 'KEYBOARD') !== 'KEYBOARD') {
    // Gamepad button: from the list or by pressing it on a connected gamepad (while the field has focus).
    const names = PAD_BUTTONS[t.device] ?? PAD_BUTTONS.UNKNOWN_CONTROLLER!;
    wrap.append(select(names.map((n, i) => [String(i), n] as const), t.keyCodes.length ? String(t.keyCodes[0]) : null, (v) => set({ ...t, keyCodes: [Number(v)] }), { title: 'Кнопка геймпада', placeholder: 'Кнопка…' }));
    const listen = h('button', { class: 'export-btn wide proto-key', title: 'Щёлкните и нажмите кнопку на подключённом геймпаде' }, 'Нажать на геймпаде…');
    let raf = 0;
    const poll = (before: boolean[][]) => {
      for (const g of navigator.getGamepads?.() ?? []) {
        if (!g) continue;
        const i = g.buttons.findIndex((b, k) => b.pressed && !before[g.index]?.[k]);
        if (i >= 0) {
          listen.blur();
          return set({ ...t, keyCodes: [i] });
        }
      }
      raf = requestAnimationFrame(() => poll(before));
    };
    listen.addEventListener('focus', () => {
      listen.textContent = 'Нажмите кнопку на геймпаде…';
      const before: boolean[][] = [];
      for (const g of navigator.getGamepads?.() ?? []) if (g) before[g.index] = g.buttons.map((b) => b.pressed);
      poll(before);
    });
    listen.addEventListener('blur', () => {
      cancelAnimationFrame(raf);
      listen.textContent = 'Нажать на геймпаде…';
    });
    wrap.append(listen);
  } else if (t?.type === 'ON_KEY_DOWN') {
    const keyBtn = h('button', { class: 'export-btn wide proto-key', title: 'Щёлкните и нажмите клавишу (можно с Shift, Ctrl, Alt)' }, t.keyCodes.length ? t.keyCodes.map(keyName).join(' + ') : 'Нажмите клавишу…');
    keyBtn.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return keyBtn.blur();
      const mods = [e.shiftKey && 16, e.ctrlKey && 17, e.altKey && 18].filter((x): x is number => !!x && x !== e.keyCode);
      set({ ...t, keyCodes: [...mods, e.keyCode] });
    });
    keyBtn.addEventListener('focus', () => (keyBtn.textContent = 'Нажмите клавишу…'));
    wrap.append(keyBtn);
  }
  return wrap;
}

/** Actions in order (including inside condition branches). */
function actionsEditor(ed: Editor, id: string, actions: PrototypeAction[], set: (a: PrototypeAction[]) => void, depth: number): HTMLElement {
  const doc = ed.doc;
  const wrap = h('div', { class: 'proto-actions' });
  actions.forEach((a, i) => {
    const kind: ActionKind = a.type === 'NODE' ? a.navigation : a.type;
    const replace = (next: PrototypeAction) => set(actions.map((x, k) => (k === i ? next : x)));
    const head = h(
      'div',
      { class: 'proto-action-head' },
      select(
        ACTIONS.filter((k) => depth === 0 || k !== 'CONDITIONAL').map((k) => [k, ACTION_LABEL[k]] as const),
        kind,
        (v) => replace(defaultAction(doc, id, v, a)),
        { title: 'Действие' },
      ),
      actions.length > 1 || depth > 0 ? iconBtn('minus', 'Убрать действие', () => set(actions.filter((_, k) => k !== i)), 'icon-btn sm') : null,
    );
    wrap.append(h('div', { class: 'props proto-block' }, head, ...actionFields(ed, id, a, replace, depth)));
  });
  wrap.append(
    h(
      'button',
      {
        class: 'proto-add',
        onclick: () => set([...actions, defaultAction(doc, id, depth > 0 ? 'NAVIGATE' : 'BACK', null)]),
      },
      '+ Действие',
    ),
  );
  return wrap;
}

/** Video and Lottie actions; sound — video only. */
const MEDIA_ACTIONS = [
  ['TOGGLE_PLAY_PAUSE', 'Пуск / пауза'],
  ['PLAY', 'Пуск'],
  ['PAUSE', 'Пауза'],
  ['SKIP_FORWARD', 'Вперёд на…'],
  ['SKIP_BACKWARD', 'Назад на…'],
  ['SKIP_TO', 'Перейти к моменту'],
  ['TOGGLE_MUTE_UNMUTE', 'Видео: звук вкл/выкл'],
  ['MUTE', 'Видео: без звука'],
  ['UNMUTE', 'Видео: со звуком'],
] as const satisfies readonly (readonly [Extract<PrototypeAction, { type: 'UPDATE_MEDIA_RUNTIME' }>['mediaAction'], string])[];

function actionFields(ed: Editor, id: string, a: PrototypeAction, set: (a: PrototypeAction) => void, depth: number): HTMLElement[] {
  const doc = ed.doc;
  switch (a.type) {
    case 'BACK':
    case 'CLOSE':
      return [];
    case 'UPDATE_MEDIA_RUNTIME': {
      // A layer with video or Lottie on the same screen; what to do; how many seconds to seek.
      const screen = screenOf(doc, id) ?? id;
      const media = [screen, ...doc.descendants(screen)].filter((n) => (doc.get(n, 'fills') ?? []).some((p) => p.type === 'VIDEO' || p.type === 'LOTTIE' || p.type === 'MODEL3D'));
      const out: HTMLElement[] = [
        select(media.map((n) => [n, doc.get(n, 'name') ?? n] as const), a.destinationId, (v) => set({ ...a, destinationId: v }), { placeholder: media.length ? 'Слой с видео или Lottie…' : 'На экране нет видео и Lottie', title: 'Чьим воспроизведением управлять' }),
        select(MEDIA_ACTIONS, a.mediaAction, (v) => set({ ...a, mediaAction: v }), { title: 'Что сделать' }),
      ];
      if (a.mediaAction === 'SKIP_FORWARD' || a.mediaAction === 'SKIP_BACKWARD' || a.mediaAction === 'SKIP_TO') {
        const skipTo = a.mediaAction === 'SKIP_TO';
        const input = h('input', { type: 'number', min: '0', step: '0.5', value: String(skipTo ? (a.newTimestamp ?? 0) : (a.amountToSkip ?? 5)) }) as HTMLInputElement;
        input.addEventListener('change', () => {
          const v = Math.max(0, Number(input.value) || 0);
          set(skipTo ? { ...a, newTimestamp: v } : { ...a, amountToSkip: v });
        });
        const lab = h('label', {}, skipTo ? 'Момент, с' : 'Секунд');
        scrubTextInput(lab, input, () => input.dispatchEvent(new Event('change')), () => doc.beginGroup(), () => doc.endGroup(), { min: 0 });
        out.push(h('div', { class: 'field wide' }, lab, input));
      }
      return out;
    }
    case 'SOUND': {
      // The file goes into document storage by hash (like video); volume; preview playback right here.
      const file = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.ogg,.m4a', hidden: true }) as HTMLInputElement;
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        const hash = await ed.store.add(new Uint8Array(await f.arrayBuffer()));
        set({ ...a, soundHash: hash, name: f.name.replace(/\.[^.]+$/, '') });
      });
      const pick = h('button', { class: 'export-btn wide', onclick: () => file.click() }, a.soundHash ? `♪ ${a.name ?? 'Звук'} — заменить…` : 'Выбрать звук…');
      const vol = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round((a.volume ?? 1) * 100)), title: 'Громкость' }) as HTMLInputElement;
      vol.addEventListener('change', () => set({ ...a, volume: Number(vol.value) / 100 }));
      const play = h('button', {
        class: 'export-btn',
        title: 'Прослушать',
        onclick: async () => {
          const bytes = a.soundHash ? await ed.store.readImage(a.soundHash) : undefined;
          if (!bytes) return;
          const audio = new Audio(URL.createObjectURL(new Blob([bytes as BlobPart])));
          audio.volume = Math.max(0, Math.min(1, a.volume ?? 1));
          void audio.play().catch(() => {});
        },
      }, '▶');
      const volLab = h('label', {}, 'Громкость');
      numberDrag(volLab, () => Number(vol.value), (v) => {
        vol.value = String(Math.max(0, Math.min(100, Math.round(v))));
        vol.dispatchEvent(new Event('change'));
      }, () => doc.beginGroup(), () => doc.endGroup());
      return [file, pick, h('div', { class: 'field wide proto-sound' }, volLab, vol, ...(a.soundHash ? [play] : []))];
    }
    case 'URL':
      return [
        h('div', { class: 'field wide' }, textInput(a.url, (v) => set({ ...a, url: v.trim() }), { placeholder: 'https://…' })),
        checkRow('В новой вкладке', a.openInNewTab !== false, (on) => set({ ...a, openInNewTab: on })),
      ];
    case 'SET_VARIABLE': {
      const vars = localVariables(doc);
      const out: HTMLElement[] = [
        select(
          vars.map((v) => [v, doc.get(v, 'name') ?? v] as const),
          a.variableId,
          (v) => set({ ...a, variableId: v }),
          { placeholder: vars.length ? 'Переменная…' : 'Нет переменных', title: 'Переменная' },
        ),
      ];
      if (a.variableId) out.push(expressionField(doc, a.variableValue, (v) => set({ ...a, variableValue: v }), 'Значение или выражение: {Счёт} + 1'));
      return out;
    }
    case 'SET_VARIABLE_MODE': {
      const colls = localCollections(doc);
      const modes = a.variableCollectionId && doc.has(a.variableCollectionId) ? (doc.get(a.variableCollectionId, 'modes') ?? []) : [];
      return [
        select(
          colls.map((c) => [c, doc.get(c, 'name') ?? c] as const),
          a.variableCollectionId,
          (c) => set({ ...a, variableCollectionId: c, variableModeId: defaultMode(doc, c) || null }),
          { placeholder: colls.length ? 'Коллекция…' : 'Нет коллекций', title: 'Коллекция' },
        ),
        select(
          modes.map((m) => [m.modeId, m.name] as const),
          a.variableModeId,
          (m) => set({ ...a, variableModeId: m }),
          { placeholder: 'Режим…', title: 'Режим' },
        ),
      ];
    }
    case 'CONDITIONAL': {
      const blocks = a.conditionalBlocks;
      const out: HTMLElement[] = [];
      blocks.forEach((b, bi) => {
        const isElse = bi > 0 && bi === blocks.length - 1 && !b.condition;
        const replaceBlock = (nb: typeof b) => set({ ...a, conditionalBlocks: blocks.map((x, k) => (k === bi ? nb : x)) });
        out.push(
          h(
            'div',
            { class: 'proto-branch wide' },
            h(
              'div',
              { class: 'proto-branch-head' },
              h('span', {}, bi === 0 ? 'Если' : isElse ? 'Иначе' : 'Иначе если'),
              blocks.length > 1 ? iconBtn('minus', 'Убрать ветку', () => set({ ...a, conditionalBlocks: blocks.filter((_, k) => k !== bi) }), 'icon-btn sm') : null,
            ),
            isElse ? null : expressionField(doc, b.condition, (v) => replaceBlock({ ...b, condition: v }), 'Условие: {Счёт} > 3 и {Звук}'),
            actionsEditor(ed, id, b.actions, (acts) => replaceBlock({ ...b, actions: acts }), depth + 1),
          ),
        );
      });
      const hasElse = blocks.length > 1 && !blocks.at(-1)!.condition;
      out.push(
        h(
          'div',
          { class: 'proto-branch-add wide' },
          h('button', { class: 'proto-add', onclick: () => set({ ...a, conditionalBlocks: hasElse ? [...blocks.slice(0, -1), { condition: undefined, actions: [] }, blocks.at(-1)!] : [...blocks, { condition: undefined, actions: [] }] }) }, '+ Иначе если'),
          hasElse ? null : h('button', { class: 'proto-add', onclick: () => set({ ...a, conditionalBlocks: [...blocks, { actions: [] }] }) }, '+ Иначе'),
        ),
      );
      return out;
    }
    case 'NODE':
      return nodeActionFields(ed, id, a, set);
  }
}

/** Expression field: text ↔ value (error shown below the field, the value doesn't change). */
function expressionField(doc: Document, value: Parameters<typeof formatPrototypeValue>[1], set: (v: NonNullable<Parameters<typeof formatPrototypeValue>[1]>) => void, placeholder: string): HTMLElement {
  const err = h('div', { class: 'proto-error' });
  const input = textInput(formatPrototypeValue(doc, value), (text) => {
    const v = parsePrototypeExpression(doc, text);
    if ('error' in v) {
      err.textContent = v.error;
      return;
    }
    set(v);
  }, { placeholder });
  return h('div', { class: 'wide proto-expr' }, h('div', { class: 'field wide' }, input), err);
}

function nodeActionFields(ed: Editor, id: string, a: Extract<PrototypeAction, { type: 'NODE' }>, set: (a: PrototypeAction) => void): HTMLElement[] {
  const doc = ed.doc;
  const out: HTMLElement[] = [];
  // Destination.
  let targets: (readonly [string, string])[] = [];
  if (a.navigation === 'CHANGE_TO') {
    const { set: cs } = changeTargets(doc, id);
    targets = cs ? variantsOf(doc, cs).map((v) => [v, doc.get(v, 'name') ?? v] as const) : [];
  } else if (a.navigation === 'SCROLL_TO') {
    const screen = screenOf(doc, id);
    const walk = (n: string, depth: number) => {
      for (const c of doc.children(n)) {
        targets.push([c, `${'  '.repeat(depth)}${doc.get(c, 'name') ?? c}`]);
        if (depth < 3) walk(c, depth + 1);
      }
    };
    if (screen) walk(screen, 0);
  } else {
    // Screens of this page, then of other pages (prototype across the whole file): “Page · Screen”.
    const screens = (page: string, prefix: string) =>
      screensOf(doc, page)
        .filter((s) => doc.type(s) !== 'COMPONENT_SET')
        .map((s) => [s, prefix + (doc.get(s, 'name') ?? s)] as const);
    targets = screens(ed.pageId, '');
    for (const p of userPages(doc)) if (p !== ed.pageId) targets.push(...screens(p, `${doc.get(p, 'name') ?? 'Страница'} · `));
  }
  out.push(
    select(targets, a.destinationId, (v) => set({ ...a, destinationId: v }), {
      placeholder: a.navigation === 'CHANGE_TO' && !targets.length ? 'Слой не в компоненте с вариантами' : 'Куда…',
      title: a.navigation === 'CHANGE_TO' ? 'Вариант' : 'Куда',
    }),
  );
  // Overlay: settings live on the overlay itself.
  if ((a.navigation === 'OVERLAY' || a.navigation === 'SWAP') && a.destinationId && doc.has(a.destinationId)) {
    const o = a.destinationId;
    const setO = (props: Props) => {
      doc.transact(() => doc.set(o, props));
      set({ ...a });
    };
    const bg = doc.get(o, 'overlayBackground') ?? { type: 'NONE' };
    out.push(
      h('div', { class: 'proto-label wide' }, 'Оверлей'),
      select(OVERLAY_POSITION as [string, string][], doc.get(o, 'overlayPositionType') ?? 'CENTER', (v) => setO({ overlayPositionType: v as 'CENTER' }), { title: 'Положение оверлея' }),
      checkRow('Закрывать щелчком мимо', (doc.get(o, 'overlayBackgroundInteraction') ?? 'NONE') === 'CLOSE_ON_CLICK_OUTSIDE', (on) => setO({ overlayBackgroundInteraction: on ? 'CLOSE_ON_CLICK_OUTSIDE' : 'NONE' })),
      checkRow('Затемнять фон', bg.type === 'SOLID_COLOR', (on) => setO({ overlayBackground: on ? { type: 'SOLID_COLOR', color: { r: 0, g: 0, b: 0, a: 0.25 } } : { type: 'NONE' } })),
    );
    if (bg.type === 'SOLID_COLOR') out.push(numberField('Тень', bg.color.a * 100, (v) => setO({ overlayBackground: { type: 'SOLID_COLOR', color: { ...bg.color, a: Math.max(0, Math.min(100, v)) / 100 } } }), { unit: '%', wide: true, title: 'Непрозрачность затемнения' }));
  }
  if (a.navigation === 'NAVIGATE' || a.navigation === 'SWAP') out.push(checkRow('Сохранять прокрутку', !!a.preserveScrollPosition, (on) => set({ ...a, preserveScrollPosition: on }), 'Новый экран открывается в том же положении прокрутки'));
  out.push(...transitionFields(a, set));
  return out;
}

function transitionFields(a: Extract<PrototypeAction, { type: 'NODE' }>, set: (a: PrototypeAction) => void): HTMLElement[] {
  const t = a.transition;
  const kind: TransitionKind = t ? t.type : 'INSTANT';
  const kinds: TransitionKind[] = a.navigation === 'SCROLL_TO' ? ['INSTANT', 'SCROLL_ANIMATE'] : a.navigation === 'CHANGE_TO' ? ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE'] : ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE', 'MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'];
  const setT = (nt: Transition | null) => set({ ...a, transition: nt });
  const kindSel = select(kinds.map((k) => [k, TRANSITION_LABEL[k]] as const), kind, (v) => setT(transitionOfKind(v, t)), { title: 'Анимация' });
  const out: HTMLElement[] = [kindSel];
  if (!t) return out;
  if ('direction' in t) {
    out[0] = h(
      'div',
      { class: 'prow proto-anim-row' },
      kindSel,
      h(
        'div',
        { class: 'proto-dirs' },
        ...(['LEFT', 'RIGHT', 'TOP', 'BOTTOM'] as const).map((d) => h('button', { class: `proto-dir${t.direction === d ? ' on' : ''}`, title: { LEFT: 'Влево', RIGHT: 'Вправо', TOP: 'Вверх', BOTTOM: 'Вниз' }[d], onclick: () => setT({ ...t, direction: d }) }, DIRECTION_ARROW[d])),
      ),
    );
    out.push(checkRow('Морфинг совпадающих слоёв', t.matchLayers, (on) => setT({ ...t, matchLayers: on })));
  }
  const e = t.easing;
  const easingSel = (
    select(
      (Object.keys(EASING_LABEL) as (keyof typeof EASING_LABEL)[]).map((k) => [k, EASING_LABEL[k]] as const),
      e.type,
      (v) => {
        const ne = easingOfType(v, e);
        setT({ ...t, easing: ne, duration: isSpring(ne) ? Math.round(springSeconds(ne) * 1000) / 1000 : isSpring(e) ? 0.3 : t.duration });
      },
      { title: 'Кривая' },
    )
  );
  const duration = isSpring(e)
    ? h('div', { class: 'proto-note' }, `≈ ${Math.round((t.duration > 0 ? t.duration : springSeconds(e)) * 1000)} мс`)
    : numberField('', t.duration * 1000, (ms) => setT({ ...t, duration: Math.max(1, ms) / 1000 }), { unit: 'мс', step: 50, title: 'Длительность' });
  out.push(h('div', { class: 'prow proto-ease-row' }, easingSel, duration));
  if (e.type === 'CUSTOM_CUBIC_BEZIER') {
    const b = e.easingFunctionCubicBezier ?? { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
    const setB = (k: keyof typeof b, v: number) => setT({ ...t, easing: { ...e, easingFunctionCubicBezier: { ...b, [k]: k[0] === 'x' ? Math.max(0, Math.min(1, v)) : v } } });
    out.push(numberField('x1', b.x1, (v) => setB('x1', v), { step: 0.05 }), numberField('y1', b.y1, (v) => setB('y1', v), { step: 0.05 }), numberField('x2', b.x2, (v) => setB('x2', v), { step: 0.05 }), numberField('y2', b.y2, (v) => setB('y2', v), { step: 0.05 }));
  }
  if (e.type === 'CUSTOM_SPRING') {
    const sp = e.easingFunctionSpring ?? { mass: 1, stiffness: 100, damping: 15, initialVelocity: 0 };
    const setS = (k: keyof typeof sp, v: number) => {
      const ne: Easing = { ...e, easingFunctionSpring: { ...sp, [k]: Math.max(k === 'initialVelocity' ? -1000 : 0.01, v) } };
      setT({ ...t, easing: ne, duration: Math.round(springSeconds(ne) * 1000) / 1000 });
    };
    out.push(numberField('Масса', sp.mass, (v) => setS('mass', v), { step: 0.1, title: 'Масса' }), numberField('Жёстк.', sp.stiffness, (v) => setS('stiffness', v), { step: 10, title: 'Жёсткость' }), numberField('Демпф.', sp.damping, (v) => setS('damping', v), { step: 1, title: 'Демпфирование' }));
  }
  return out;
}

