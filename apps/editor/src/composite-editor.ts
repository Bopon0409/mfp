// Composite variables in the “Variables” window (our own): a value swatch in the cell and an edit row
// under the variable — gradient (type, angle, stops), shadows (drop / inner, offset, blur, spread,
// color), typography (font, style, size, spacing). Color, font, style and size can
// reference other variables (“=” at the field).

import {
  alias,
  colorHex,
  compositeCss,
  isAlias,
  isColor,
  parseCssColor,
  resolveComposite,
  type CompositeValue,
  type GradientVariableValue,
  type LetterSpacing,
  type LineHeight,
  type RGBA,
  type ShadowVariableValue,
  type TypographyVariableValue,
  type VariableAlias,
  type VariableType,
  type VariableValue,
} from '@mfp/core';
import type { Editor } from './editor.ts';
import { h, iconBtn, svgEl, textInput } from './dom.ts';
import { ICON } from './icons.ts';
import { numberDrag } from './number-drag.ts';
import { openColorEditor } from './paint-editor.ts';
import { openVariablePicker } from './variables-ui.ts';

type Resolve = (id: string) => VariableValue | undefined;

const css = (c: RGBA) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a ?? 1})`;
const num = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
const parseNum = (s: string) => Number(s.trim().replace(',', '.').replace(/(px|%)$/i, ''));
const short = (name: string) => name.split('/').pop()!.trim();

/** Composite value swatch: a gradient strip, a square with a shadow, “Inter 16”. */
export function compositePreview(v: CompositeValue, resolve: Resolve): HTMLElement {
  const r = resolveComposite(v, resolve);
  if (r.type === 'GRADIENT') {
    const el = h('span', { class: 'var-swatch var-grad' });
    el.style.background = compositeCss(r, css, resolve)[0]!;
    return el;
  }
  if (r.type === 'SHADOWS') {
    const el = h('span', { class: 'var-shadow' });
    el.style.boxShadow = r.shadows.map((s) => `${s.inner ? 'inset ' : ''}${s.x / 3}px ${s.y / 3}px ${s.blur / 3}px ${s.spread / 3}px ${css(s.color as RGBA)}`).join(', ');
    return el;
  }
  const lh = r.lineHeight.unit === 'AUTO' ? '' : r.lineHeight.unit === 'PIXELS' ? `/${num(r.lineHeight.value)}` : `/${num(r.lineHeight.value)}%`;
  return h('span', { class: 'var-val' }, `${r.fontFamily} ${r.fontStyle} ${num(r.fontSize as number)}${lh}`);
}

/**
 * Editing a composite value (the row under the variable). set — write the new value; resolve —
 * values of references (for swatches).
 */
export function compositeEditor(ed: Editor, value: CompositeValue, set: (v: CompositeValue) => void, resolve: Resolve, key: string): HTMLElement {
  const doc = ed.doc;
  const box = h('div', { class: 'var-comp' });

  /** A field that can reference a variable: a value or a reference pill and the “=” button. */
  const linkable = <T>(current: T | VariableAlias, types: VariableType[], plain: () => HTMLElement, onChange: (v: T | VariableAlias) => void, fallback: () => T): HTMLElement => {
    if (isAlias(current)) {
      const pill = h('button', { class: 'var-pill', title: 'Ссылка на переменную — щелчок, чтобы сменить' }, h('span', { class: 'var-name' }, short(doc.get(current.id, 'name') ?? '?')));
      pill.addEventListener('click', () =>
        openVariablePicker(ed, pill, { types, field: '', current: current.id, onPick: (id) => onChange(id ? alias(id) : fallback()) }),
      );
      return h('div', { class: 'var-comp-link' }, pill, iconBtn('unlink', 'Значение вместо ссылки', () => onChange(fallback()), 'icon-btn sm'));
    }
    const link = svgEl('button', { class: 'icon-btn sm', title: 'Ссылка на переменную' }, ICON.variable) as HTMLButtonElement;
    link.addEventListener('click', () => openVariablePicker(ed, link, { types, field: '', current: null, onPick: (id) => id && onChange(alias(id)) }));
    return h('div', { class: 'var-comp-link' }, plain(), link);
  };

  /** Color: a swatch with a picker and hex; or a reference to a color variable. */
  const colorField = (c: RGBA | VariableAlias, onChange: (v: RGBA | VariableAlias) => void, k: string) =>
    linkable<RGBA>(
      c,
      ['COLOR'],
      () => {
        const col = c as RGBA;
        const sw = h('button', { class: 'swatch', title: 'Палитра' });
        sw.style.background = css(col);
        sw.addEventListener('click', () =>
          openColorEditor({ key: `${key}:${k}`, anchor: sw, color: { ...col, a: col.a ?? 1 }, alpha: true, onChange: (n) => onChange({ r: n.r, g: n.g, b: n.b, a: n.a }), onStart: () => doc.beginGroup(), onEnd: () => doc.endGroup(), docColors: [] }),
        );
        const input = textInput(colorHex(col), (s) => {
          const p = parseCssColor(s);
          if (p) onChange(p);
        });
        return h('div', { class: 'field' }, sw, input);
      },
      onChange,
      () => {
        const r = isAlias(c) ? resolve(c.id) : c;
        return isColor(r) ? { r: r.r, g: r.g, b: r.b, a: r.a ?? 1 } : { r: 0, g: 0, b: 0, a: 1 };
      },
    );

  const numField = (label: string, v: number, onChange: (n: number) => void, title = label) => {
    const lab = h('label', {}, label);
    const input = textInput(num(v), (s) => {
        const n = parseNum(s);
        if (Number.isFinite(n)) onChange(n);
      });
    numberDrag(lab, () => parseNum(input.value), n => { input.value = num(n); onChange(n); }, () => doc.beginGroup(), () => doc.endGroup());
    return h('div', { class: 'field var-comp-num', title }, lab, input);
  };

  if (value.type === 'GRADIENT') {
    const g = value;
    const put = (patch: Partial<GradientVariableValue>) => set({ ...g, ...patch });
    const type = h(
      'select',
      { title: 'Вид градиента' },
      ...([['GRADIENT_LINEAR', 'Линейный'], ['GRADIENT_RADIAL', 'Радиальный'], ['GRADIENT_ANGULAR', 'Угловой'], ['GRADIENT_DIAMOND', 'Ромб']] as const).map(([v, l]) => h('option', { value: v, selected: v === g.gradientType }, l)),
    ) as HTMLSelectElement;
    type.addEventListener('change', () => put({ gradientType: type.value as GradientVariableValue['gradientType'] }));
    const bar = compositePreview(g, resolve);
    bar.classList.add('wide');
    box.append(h('div', { class: 'var-comp-row' }, h('div', { class: 'field' }, type), g.gradientType === 'GRADIENT_LINEAR' ? numField('°', g.angle, (n) => put({ angle: ((n % 360) + 360) % 360 }), 'Угол, как в CSS: 90 — слева направо, 180 — сверху вниз') : '', bar));
    g.stops.forEach((st, i) => {
      const stops = (fn: (s: GradientVariableValue['stops'][number]) => GradientVariableValue['stops'][number]) => put({ stops: g.stops.map((x, j) => (j === i ? fn(x) : x)) });
      box.append(
        h(
          'div',
          { class: 'var-comp-row' },
          numField('%', st.position * 100, (n) => stops((x) => ({ ...x, position: Math.max(0, Math.min(100, n)) / 100 })), 'Положение стопа'),
          colorField(st.color, (c) => stops((x) => ({ ...x, color: c })), `stop${i}`),
          g.stops.length > 2 ? iconBtn('minus', 'Убрать стоп', () => put({ stops: g.stops.filter((_, j) => j !== i) }), 'icon-btn sm') : '',
        ),
      );
    });
    box.append(
      h('button', {
        class: 'link-btn',
        onclick: () => {
          const last = g.stops[g.stops.length - 1]!;
          put({ stops: [...g.stops, { position: 1, color: isAlias(last.color) ? last.color : { ...(last.color as RGBA) } }] });
        },
      }, '+ Стоп'),
    );
    return box;
  }

  if (value.type === 'SHADOWS') {
    const s = value;
    const put = (shadows: ShadowVariableValue['shadows']) => set({ ...s, shadows });
    s.shadows.forEach((sh, i) => {
      const one = (patch: Partial<ShadowVariableValue['shadows'][number]>) => put(s.shadows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      const kind = h('select', { title: 'Тень снаружи или внутри слоя' }, h('option', { value: 'out', selected: !sh.inner }, 'Снаружи'), h('option', { value: 'in', selected: !!sh.inner }, 'Внутри')) as HTMLSelectElement;
      kind.addEventListener('change', () => one({ inner: kind.value === 'in' || undefined }));
      box.append(
        h(
          'div',
          { class: 'var-comp-row' },
          h('div', { class: 'field' }, kind),
          numField('X', sh.x, (n) => one({ x: n }), 'Сдвиг по X'),
          numField('Y', sh.y, (n) => one({ y: n }), 'Сдвиг по Y'),
          numField('Р', sh.blur, (n) => one({ blur: Math.max(0, n) }), 'Размытие'),
          numField('±', sh.spread, (n) => one({ spread: n }), 'Разлёт'),
          colorField(sh.color, (c) => one({ color: c }), `shadow${i}`),
          s.shadows.length > 1 ? iconBtn('minus', 'Убрать тень', () => put(s.shadows.filter((_, j) => j !== i)), 'icon-btn sm') : '',
        ),
      );
    });
    box.append(h('button', { class: 'link-btn', onclick: () => put([...s.shadows, { color: { r: 0, g: 0, b: 0, a: 0.1 }, x: 0, y: 1, blur: 3, spread: 0 }]) }, '+ Тень'));
    return box;
  }

  const t = value as TypographyVariableValue;
  const put = (patch: Partial<TypographyVariableValue>) => set({ ...t, ...patch });
  const r = resolveComposite(t, resolve);
  const strField = (current: string | VariableAlias, placeholder: string, onChange: (v: string | VariableAlias) => void, fallback: string) =>
    linkable<string>(current, ['STRING'], () => h('div', { class: 'field' }, textInput(current as string, (v) => v.trim() && onChange(v.trim()), { placeholder })), onChange, () => fallback);
  const lhText = (lh: LineHeight) => (lh.unit === 'AUTO' ? 'авто' : lh.unit === 'PIXELS' ? num(lh.value) : `${num(lh.value)}%`);
  const lsText = (ls: LetterSpacing) => (ls.unit === 'PIXELS' ? `${num(ls.value)}px` : `${num(ls.value)}%`);
  box.append(
    h(
      'div',
      { class: 'var-comp-row' },
      strField(t.fontFamily, 'Шрифт', (v) => put({ fontFamily: v }), String(r.fontFamily)),
      strField(t.fontStyle, 'Начертание', (v) => put({ fontStyle: v }), String(r.fontStyle)),
    ),
    h(
      'div',
      { class: 'var-comp-row' },
      linkable<number>(t.fontSize, ['FLOAT'], () => numField('Кегль', t.fontSize as number, (n) => n > 0 && put({ fontSize: n })), (v) => put({ fontSize: v }), () => r.fontSize as number),
      h(
        'div',
        { class: 'field var-comp-num', title: 'Межстрочный: «авто», пиксели (24) или проценты (150%)' },
        h('label', {}, 'Строка'),
        textInput(lhText(t.lineHeight), (s) => {
          const v = s.trim().toLowerCase();
          if (!v || v === 'авто' || v === 'auto') return put({ lineHeight: { unit: 'AUTO' } });
          const n = parseNum(v);
          if (Number.isFinite(n)) put({ lineHeight: v.endsWith('%') ? { unit: 'PERCENT', value: n } : { unit: 'PIXELS', value: n } });
        }),
      ),
      h(
        'div',
        { class: 'field var-comp-num', title: 'Межбуквенный: проценты кегля (2%) или пиксели (0,5px)' },
        h('label', {}, 'Буквы'),
        textInput(lsText(t.letterSpacing), (s) => {
          const n = parseNum(s);
          if (Number.isFinite(n)) put({ letterSpacing: /px$/i.test(s.trim()) ? { unit: 'PIXELS', value: n } : { unit: 'PERCENT', value: n } });
        }),
      ),
    ),
  );
  const intervalFields = box.querySelectorAll<HTMLElement>('.var-comp-row:last-child > .var-comp-num');
  intervalFields.forEach((field, i) => {
    const input = field.querySelector<HTMLInputElement>('input')!;
    numberDrag(field.querySelector('label')!, () => parseNum(input.value), n => {
      if (i === 0) {
        if (t.lineHeight.unit === 'AUTO') return;
        input.value = num(n) + (t.lineHeight.unit === 'PERCENT' ? '%' : '');
        put({ lineHeight: { ...t.lineHeight, value: n } });
      } else {
        input.value = num(n) + (t.letterSpacing.unit === 'PIXELS' ? 'px' : '%');
        put({ letterSpacing: { ...t.letterSpacing, value: n } });
      }
    }, () => doc.beginGroup(), () => doc.endGroup());
  });
  return box;
}
