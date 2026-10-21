// Components in the right panel.
// - Instance: component (swap — picker window), property values — variants, toggles,
//   texts, nested swap; properties of nested instances exposed outward; reset a property
//   and all overrides, “push to main”, detach.
// - Component and variant set: properties (add, rename, default value,
//   delete), variant values, description, “+ variant”.
// - Layer inside a component: binding visibility, text and nested component to properties.

import {
  exposedPropertyKeys,
  acceptsChildren,
  addComponentProperty,
  instantiate,
  combineAsVariants,
  componentSetOf,
  definitionsHolder,
  deleteComponentProperty,
  detachInstance,
  editComponentProperty,
  instancePropertyValues,
  parseVariantName,
  propertyDefinitions,
  propertyOwner,
  pushOverridesToMain,
  resetOverrides,
  setInstanceProperties,
  setPropertyReference,
  swapComponent,
  variantName,
  variantsOf,
  type ComponentPropertyDefinition,
  type Document,
} from '@mfp/core';
import type { Editor } from './editor.ts';
import { h, iconBtn, svgEl, textInput, popover } from './dom.ts';
import { ICON } from './icons.ts';
import { showMenu, type MenuEntry } from './menu.ts';
import { scrubTextInput } from './number-drag.ts';
import { openComponentPicker } from './assets.ts';
import { t } from './i18n/index.ts';

type Defs = Record<string, ComponentPropertyDefinition>;

const TYPE_LABEL: Record<ComponentPropertyDefinition['type'], string> = {
  VARIANT: 'Вариант',
  BOOLEAN: 'Логическое',
  TEXT: 'Текст',
  INSTANCE_SWAP: 'Замена инстанса',
  SLOT: 'Слот',
};
const TYPE_ICON: Record<ComponentPropertyDefinition['type'], string> = {
  VARIANT: ICON.componentSet,
  BOOLEAN: ICON.toggleProp,
  TEXT: ICON.textProp,
  INSTANCE_SWAP: ICON.instance,
  SLOT: ICON.slot,
};

/** Override labels (the “Reset override” menu). */
const OVERRIDE_LABEL: Record<string, string> = {
  fills: 'Заливка',
  strokes: 'Обводка',
  effects: 'Эффекты',
  characters: 'Текст',
  textRuns: 'Оформление текста',
  fontName: 'Шрифт',
  fontSize: 'Кегль',
  visible: 'Видимость',
  opacity: 'Непрозрачность',
  width: 'Ширина',
  height: 'Высота',
  transform: 'Положение',
  componentId: 'Замена инстанса',
  componentProperties: 'Свойства вложенного инстанса',
  fillStyleId: 'Стиль заливки',
  strokeStyleId: 'Стиль обводки',
  textStyleId: 'Стиль текста',
  effectStyleId: 'Стиль эффектов',
  boundVariables: 'Переменные',
  children: 'Содержимое слота',
  name: 'Имя',
  cornerRadius: 'Скругление',
};

/** Property name without “#id”. */
export const propName = (key: string) => key.split('#')[0]!;

/** Go to a node (to its page; the service page doesn't open). */
export function goTo(ed: Editor, id: string) {
  const doc = ed.doc;
  let page = id;
  while (doc.parent(page) && doc.parent(page) !== doc.root) page = doc.parent(page)!;
  if (doc.get(page, 'internal')) return false;
  if (page !== ed.pageId) ed.setPage(page);
  ed.select([id]);
  const b = ed.selectionBounds([id]);
  if (b) ed.fitRect([b[0] - 40, b[1] - 40, b[2] + 40, b[3] + 40]);
  return true;
}

/** Toggle (boolean value). */
function toggle(value: boolean | null, set: (v: boolean) => void, title = ''): HTMLElement {
  const b = h('button', { class: `toggle${value ? ' on' : ''}${value === null ? ' mixed' : ''}`, title, 'aria-pressed': String(!!value) });
  b.addEventListener('click', () => set(!value));
  return b;
}

/** Button with the component name (component picker window). */
function componentButton(ed: Editor, id: string | null, pick: (anchor: HTMLElement) => void): HTMLElement {
  const name = id && ed.doc.has(id) ? (ed.doc.get(id, 'name') ?? '') : 'Не выбран';
  const b = h('button', { class: 'comp-pick', title: 'Выбрать компонент' }, svgEl('span', { class: 'cp-ic' }, ICON.instance), h('span', { class: 'cp-name' }, name), svgEl('span', { class: 'cp-chev' }, ICON.chevronDown));
  b.addEventListener('click', () => pick(b));
  return b;
}

/** Property row: label and value field (with a reset button if the value is overridden). */
function propRow(label: string, icon: string, control: HTMLElement, reset?: (() => void) | HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'prop-row' },
    h('div', { class: 'prop-label', title: label }, svgEl('span', { class: 'prop-ic' }, icon), h('span', {}, label)),
    h('div', { class: 'prop-control' }, control),
    reset instanceof HTMLElement ? reset : reset ? iconBtn('reset', 'Вернуть как у главного компонента', () => reset(), 'icon-btn sm') : h('span', { class: 'prop-pad' }),
  );
}

/** Instance property values (several selected from one set — shared values or “Mixed”). */
/** Instance property rows; only — only these keys and in this order (choice on a nested one). */
function instanceRows(ed: Editor, ids: string[], only?: readonly string[]): HTMLElement[] {
  const doc = ed.doc;
  const comp = doc.get(ids[0]!, 'componentId')!;
  const all0 = propertyDefinitions(doc, comp);
  const defs = only ? Object.fromEntries(only.filter((k) => k in all0).map((k) => [k, all0[k]!])) : all0;
  const all = ids.map((id) => instancePropertyValues(doc, id));
  const own = ids.map((id) => doc.get(id, 'componentProperties') ?? {});
  const value = (k: string) => (all.every((v) => v[k] === all[0]![k]) ? all[0]![k]! : null);
  const set = (k: string, v: string | boolean) => doc.transact(() => ids.forEach((id) => setInstanceProperties(doc, id, { [k]: v })));
  const reset = (k: string) =>
    own.some((o) => k in o)
      ? () =>
          doc.transact(() => {
            for (const id of ids) {
              const o = { ...(doc.get(id, 'componentProperties') ?? {}) };
              delete o[k];
              doc.set(id, { componentProperties: Object.keys(o).length ? o : undefined });
            }
          })
      : undefined;
  const rows: HTMLElement[] = [];
  for (const [k, d] of Object.entries(defs)) {
    const v = value(k);
    if (d.type === 'VARIANT') {
      const sel = h('select', {}, ...(v === null ? [h('option', { value: '', selected: true, disabled: true }, 'Разные')] : []), ...(d.variantOptions ?? []).map((o) => h('option', { value: o, selected: o === v }, o))) as HTMLSelectElement;
      sel.addEventListener('change', () => set(k, sel.value));
      rows.push(propRow(propName(k), TYPE_ICON.VARIANT, h('div', { class: 'field' }, sel)));
    } else if (d.type === 'BOOLEAN') {
      rows.push(propRow(propName(k), TYPE_ICON.BOOLEAN, toggle(v === null ? null : v === true || v === 'true', (on) => set(k, on)), reset(k)));
    } else if (d.type === 'TEXT') {
      const input = textInput(v === null ? '' : String(v), (t) => set(k, t), { placeholder: v === null ? 'Разные' : '' });
      rows.push(propRow(propName(k), TYPE_ICON.TEXT, h('div', { class: 'field' }, input), reset(k)));
    } else if (d.type === 'INSTANCE_SWAP') {
      const cur = v === null ? null : String(v);
      rows.push(propRow(propName(k), TYPE_ICON.INSTANCE_SWAP, componentButton(ed, cur, (a) => openComponentPicker(ed, a, { current: cur, preferred: d.preferredValues, title: propName(k), onPick: (id) => set(k, id) })), reset(k)));
    }
  }
  return rows;
}

/**
 * Choosing properties of an exposed nested instance: checkbox — show on instances of the outer
 * component, arrows — order. Until anything is touched, all are shown.
 */
function exposedChooser(ed: Editor, id: string): HTMLElement[] {
  const doc = ed.doc;
  const c = doc.get(id, 'componentId');
  if (!c || !doc.has(c)) return [];
  const defs = propertyDefinitions(doc, c);
  const keys = Object.keys(defs);
  if (!keys.length) return [];
  const chosen = exposedPropertyKeys(doc, id, keys);
  const rest = keys.filter((k) => !chosen.includes(k));
  const save = (next: string[]) => doc.transact(() => doc.set(id, { exposedProperties: next }));
  const move = (k: string, by: number) => {
    const next = [...chosen];
    const i = next.indexOf(k);
    const j = i + by;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    save(next);
  };
  const line = (k: string, on: boolean, i: number) =>
    h(
      'div',
      { class: 'exposed-prop' + (on ? '' : ' off') },
      h('input', { type: 'checkbox', checked: on, title: on ? 'Не показывать у инстансов' : 'Показывать у инстансов', onchange: () => save(on ? chosen.filter((x) => x !== k) : [...chosen, k]) }),
      svgEl('span', { class: 'prop-ic' }, TYPE_ICON[defs[k]!.type] ?? ICON.instance),
      h('span', { class: 'exposed-name' }, propName(k)),
      ...(on
        ? [
            h('button', { class: 'icon-btn small', title: 'Выше', disabled: i === 0, onclick: () => move(k, -1) }, '↑'),
            h('button', { class: 'icon-btn small', title: 'Ниже', disabled: i === chosen.length - 1, onclick: () => move(k, 1) }, '↓'),
          ]
        : []),
    );
  return [
    h('div', { class: 'exposed-list', title: 'Какие свойства вложенного инстанса видны у инстансов этого компонента и в каком порядке' },
      h('div', { class: 'exposed-head' }, 'Показывать у инстансов'),
      ...chosen.map((k, i) => line(k, true, i)),
      ...rest.map((k, i) => line(k, false, i)),
    ),
  ];
}

/** Nested instances exposed outward (isExposedInstance on the main's node) — on the instance. */
function exposedInstances(doc: Document, id: string): string[] {
  const out: string[] = [];
  const walk = (n: string) => {
    for (const c of doc.children(n)) {
      if (doc.type(c) === 'INSTANCE') {
        if (doc.get(c, 'isExposedInstance')) out.push(c);
        continue;
      }
      walk(c);
    }
  };
  walk(id);
  return out;
}

/** Instance section (one or several of the same component). */
export function instanceSection(ed: Editor, ids: string[]): HTMLElement {
  const doc = ed.doc;
  const id = ids[0]!;
  const comp = doc.get(id, 'componentId');
  const found = !!comp && doc.has(comp);
  const set = found ? componentSetOf(doc, comp) : null;
  const sameComp = ids.every((i) => doc.get(i, 'componentId') === comp);
  const sameSet = set && ids.every((i) => componentSetOf(doc, doc.get(i, 'componentId') ?? '') === set);
  const overrides = ids.reduce((n, i) => n + [i, ...doc.descendants(i)].reduce((m, k) => m + (doc.get(k, 'overrides')?.length ?? 0), 0), 0);
  const menu: MenuEntry[] = [
    { label: 'Перейти к главному компоненту', disabled: !found, run: () => found && !goTo(ed, comp) && ed.notify?.('Главный компонент — в библиотеке (на служебной странице)') },
    { label: 'Сбросить все правки', disabled: !overrides && !ids.some((i) => Object.keys(doc.get(i, 'componentProperties') ?? {}).length), run: () => doc.transact(() => ids.forEach((i) => resetOverrides(doc, i))) },
    {
      label: 'Применить правки к главному',
      disabled: !overrides || ids.length !== 1,
      run: () => {
        const n = doc.transact(() => pushOverridesToMain(doc, id));
        ed.notify?.(`Правок перенесено в главный компонент: ${n}`);
      },
    },
    {
      label: 'Сбросить правку',
      disabled: !overrides,
      submenu: () => {
        // Which properties were overridden (across the whole instance) — reset one of them.
        const keys = new Set<string>();
        for (const i of ids) for (const n of [i, ...doc.descendants(i)]) for (const k of doc.get(n, 'overrides') ?? []) keys.add(k);
        return [...keys].sort().map((k) => ({ label: OVERRIDE_LABEL[k] ?? k, run: () => doc.transact(() => ids.forEach((i) => resetOverrides(doc, i, [k]))) }));
      },
    },
    'sep',
    { label: 'Отсоединить инстанс', hint: 'Ctrl+Alt+B', run: () => doc.transact(() => ed.select(ids.map((i) => detachInstance(doc, i)))) },
  ];
  const moreBtn = iconBtn('more', 'Действия с инстансом', () => showMenu(moreBtn, menu));
  const head = h(
    'h3',
    {},
    h('span', {}, 'Инстанс'),
    h('span', { class: 'h-acts' }, found ? iconBtn('target', 'Перейти к главному компоненту', () => !goTo(ed, comp) && ed.notify?.('Главный компонент — в библиотеке (на служебной странице)')) : '', moreBtn),
  );
  const title = found ? (set ? (doc.get(set, 'name') ?? '') : (doc.get(comp, 'name') ?? '')) : 'Компонент не найден';
  const swap = componentButton(ed, found ? (set ?? comp) : null, (a) =>
    openComponentPicker(ed, a, {
      current: set ?? comp,
      title: 'Заменить инстанс',
      onPick: (c) => doc.transact(() => ids.forEach((i) => swapComponent(doc, i, c))),
    }),
  );
  (swap.querySelector('.cp-name') as HTMLElement).textContent = title;
  const rows = sameComp || sameSet ? instanceRows(ed, ids) : [h('div', { class: 'empty' }, 'Разные компоненты')];
  // Exposed nested instances — their properties are here too.
  const nested: HTMLElement[] = [];
  if (ids.length === 1) {
    for (const n of exposedInstances(doc, id)) {
      const c = doc.get(n, 'componentId');
      if (!c || !doc.has(c) || !Object.keys(propertyDefinitions(doc, c)).length) continue;
      // Only the properties chosen in the main component — in its order.
      const keys = exposedPropertyKeys(doc, n, Object.keys(propertyDefinitions(doc, c)));
      if (!keys.length) continue;
      nested.push(h('div', { class: 'nested-head' }, svgEl('span', { class: 'prop-ic' }, ICON.instance), doc.get(n, 'name') ?? ''), ...instanceRows(ed, [n], keys));
    }
  }
  // Slots: how many are allowed and “+” — an instance (preferred ones on top).
  const slots: HTMLElement[] = [];
  if (ids.length === 1 && found) {
    const defs = propertyDefinitions(doc, comp);
    const walk = (n: string) => {
      for (const c of doc.children(n)) {
        const key = doc.get(c, 'componentPropertyReferences')?.slot;
        if (key && acceptsChildren(doc, c)) {
          const d = defs[key];
          const count = doc.children(c).length;
          const limits = d?.minChildren || d?.maxChildren ? ` (${d?.minChildren ?? 0}–${d?.maxChildren || '∞'})` : '';
          const bad = (d?.minChildren && count < d.minChildren) || (d?.maxChildren && count > d.maxChildren);
          const add = iconBtn('plus', 'Вставить инстанс в слот', () =>
            openComponentPicker(ed, add, {
              preferred: d?.preferredValues,
              title: `В слот «${propName(key)}»`,
              onPick: (cid) =>
                doc.transact(() => {
                  const inst = instantiate(doc, cid, c, [1, 0, 0, 0, 1, 0]);
                  ed.select([inst]);
                }),
            }),
          'icon-btn sm');
          slots.push(propRow(propName(key), ICON.slot, h('span', { class: `def-sub${bad ? ' warn' : ''}`, title: 'Элементов в слоте' }, `элементов: ${count}${limits}`), add));
        }
        if (doc.type(c) !== 'INSTANCE') walk(c);
      }
    };
    walk(id);
  }
  return h(
    'div',
    { class: 'section comp-section' },
    head,
    h('div', { class: 'props comp-props' }, h('div', { class: 'wide' }, swap), ...rows, ...slots, ...nested),
    overrides ? h('div', { class: 'empty' }, `Своих правок: ${overrides}`) : '',
  );
}

/** Add a property: types menu. */
function addPropertyMenu(ed: Editor, holder: string): MenuEntry[] {
  const doc = ed.doc;
  const defs = propertyDefinitions(doc, holder);
  const unique = (base: string) => {
    const names = new Set(Object.keys(defs).map(propName));
    let n = 1;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  };
  const isSet = doc.type(holder) === 'COMPONENT_SET';
  return [
    {
      label: 'Вариант',
      icon: ICON.componentSet,
      run: () =>
        doc.transact(() => {
          let set = holder;
          // A standalone component — first a set of one variant.
          if (!isSet) set = combineAsVariants(doc, [holder], doc.parent(holder)!, doc.children(doc.parent(holder)!).indexOf(holder));
          addComponentProperty(doc, set, unique('Свойство'), 'VARIANT', 'По умолчанию');
          ed.select([set]);
        }),
    },
    { label: 'Логическое', icon: ICON.toggleProp, run: () => doc.transact(() => addComponentProperty(doc, holder, unique('Показать'), 'BOOLEAN', true)) },
    { label: 'Текст', icon: ICON.textProp, run: () => doc.transact(() => addComponentProperty(doc, holder, unique('Текст'), 'TEXT', 'Текст')) },
    {
      label: 'Замена инстанса',
      icon: ICON.instance,
      run: () => {
        // Default — the component of the first nested instance.
        const comps = isSet ? variantsOf(doc, holder) : [holder];
        let first = '';
        for (const c of comps) for (const n of doc.descendants(c)) if (!first && doc.type(n) === 'INSTANCE') first = doc.get(n, 'componentId') ?? '';
        doc.transact(() => addComponentProperty(doc, holder, unique('Инстанс'), 'INSTANCE_SWAP', first));
      },
    },
    { label: 'Слот', icon: ICON.slot, run: () => doc.transact(() => addComponentProperty(doc, holder, unique('Слот'), 'SLOT', '')) },
  ];
}

/** Property definition row: name (double-click — rename), default value, delete. */
function definitionRow(ed: Editor, holder: string, key: string, d: ComponentPropertyDefinition): HTMLElement {
  const doc = ed.doc;
  const name = h('span', { class: 'def-name', title: `${TYPE_LABEL[d.type]} — двойной щелчок, чтобы переименовать` }, propName(key));
  name.addEventListener('dblclick', () => {
    const input = textInput(propName(key), (v) => v.trim() && doc.transact(() => editComponentProperty(doc, holder, key, { name: v.trim() })));
    name.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener('blur', () => input.isConnected && input.replaceWith(name));
  });
  let control: HTMLElement;
  const setDefault = (v: string | boolean) => doc.transact(() => editComponentProperty(doc, holder, key, { defaultValue: v }));
  if (d.type === 'VARIANT') {
    const sel = h('select', {}, ...(d.variantOptions ?? []).map((o) => h('option', { value: o, selected: o === d.defaultValue }, o))) as HTMLSelectElement;
    sel.title = 'Значение по умолчанию';
    sel.addEventListener('change', () => setDefault(sel.value));
    control = h('div', { class: 'field' }, sel);
  } else if (d.type === 'BOOLEAN') control = toggle(d.defaultValue === true, setDefault, 'По умолчанию');
  else if (d.type === 'TEXT') control = h('div', { class: 'field' }, textInput(String(d.defaultValue), setDefault));
  else if (d.type === 'INSTANCE_SWAP')
    control = componentButton(ed, String(d.defaultValue) || null, (a) => openComponentPicker(ed, a, { current: String(d.defaultValue), title: 'По умолчанию', preferred: d.preferredValues, onPick: (id) => setDefault(id) }));
  else {
    // Slot: how many items (0 — unlimited) and preferred components.
    const lim = (label: string, key: 'minChildren' | 'maxChildren') => {
      const input = textInput(String(d[key] ?? 0), (v) => {
        const n = Math.max(0, Math.round(Number(v) || 0));
        const defs = { ...(doc.get(holder, 'componentPropertyDefinitions') ?? {}) };
        defs[key2] = { ...defs[key2]!, [key]: n || undefined };
        doc.transact(() => doc.set(holder, { componentPropertyDefinitions: defs }));
      });
      input.title = label;
      const lab = h('label', {}, key === 'minChildren' ? 'мин' : 'макс');
      scrubTextInput(lab, input as HTMLInputElement, () => input.dispatchEvent(new Event('change')), () => doc.beginGroup(), () => doc.endGroup(), { min: 0 });
      return h('div', { class: 'field slot-lim', title: label }, lab, input);
    };
    const key2 = key;
    const pref = h('button', { class: 'pe-btn', title: 'Предпочтительные компоненты (сверху в окне выбора)' }, `★ ${d.preferredValues?.length ?? 0}`);
    pref.addEventListener('click', () =>
      openComponentPicker(ed, pref, {
        sets: true,
        title: 'Добавить предпочтительный',
        preferred: d.preferredValues,
        onPick: (id) => doc.transact(() => editComponentProperty(doc, holder, key, { preferredValues: [...new Set([...(d.preferredValues ?? []), id])] })),
      }),
    );
    control = h('div', { class: 'slot-ctl' }, lim('Не меньше элементов', 'minChildren'), lim('Не больше элементов (0 — без предела)', 'maxChildren'), pref);
  }
  const del = iconBtn('minus', 'Удалить свойство', () => doc.transact(() => deleteComponentProperty(doc, holder, key)), 'icon-btn sm');
  return h('div', { class: 'prop-row def-row' }, h('div', { class: 'prop-label' }, svgEl('span', { class: 'prop-ic' }, TYPE_ICON[d.type]), name), h('div', { class: 'prop-control' }, control), del);
}

/** Component property as a pill: icon, name and value summary; click — edit window (name, default, delete). */
function propertyPill(ed: Editor, holder: string, key: string, d: ComponentPropertyDefinition): HTMLElement {
  const doc = ed.doc;
  const summary =
    d.type === 'VARIANT'
      ? (d.variantOptions ?? []).join(', ')
      : d.type === 'BOOLEAN'
        ? d.defaultValue === true ? 'Да' : 'Нет'
        : d.type === 'TEXT'
          ? String(d.defaultValue)
          : d.type === 'INSTANCE_SWAP'
            ? (doc.get(String(d.defaultValue), 'name') ?? '—')
            : 'Слот';
  const pill: HTMLElement = h(
    'button',
    { class: 'prop-pill wide', title: `${TYPE_LABEL[d.type]}: ${propName(key)} — щелчок, чтобы изменить` },
    svgEl('span', { class: 'prop-ic' }, TYPE_ICON[d.type]),
    h('span', { class: 'pill-name' }, propName(key)),
    summary ? h('span', { class: 'pill-sub' }, `· ${summary}`) : '',
  );
  pill.addEventListener('click', () => {
    const { box } = popover(pill, 'prop-pop', { width: 260, side: 'left' });
    if (!box.isConnected) return;
    box.append(h('div', { class: 'pop-head' }, TYPE_LABEL[d.type]), h('div', { class: 'props comp-props' }, definitionRow(ed, holder, key, d)));
  });
  return pill;
}

/** Section of a main component or variant set. */
export function componentSection(ed: Editor, id: string): HTMLElement {
  const doc = ed.doc;
  const type = doc.type(id);
  const set = type === 'COMPONENT' ? componentSetOf(doc, id) : null;
  const holder = type === 'COMPONENT_SET' ? id : (set ?? id);
  const defs: Defs = propertyDefinitions(doc, holder);
  const add = iconBtn('plus', 'Добавить свойство', () => showMenu(add, addPropertyMenu(ed, holder)));
  const blocks: (HTMLElement | string)[] = [];
  // Variant inside a set: its values (editing renames the variant).
  if (set) {
    const values = parseVariantName(doc.get(id, 'name') ?? '');
    const order = Object.entries(defs).filter(([, d]) => d.type === 'VARIANT').map(([k]) => k);
    blocks.push(
      h('div', { class: 'nested-head' }, 'Значения варианта'),
      ...order.map((k) =>
        propRow(
          k,
          ICON.componentSet,
          h('div', { class: 'field' }, textInput(values[k] ?? '', (v) => doc.transact(() => doc.set(id, { name: variantName({ ...values, [k]: v.trim() }, order) })))),
        ),
      ),
      h('div', { class: 'nested-head' }, 'Свойства набора'),
    );
  }
  // Properties as pills “◈ Size · Large, Small”; click — property edit window.
  const rows: HTMLElement[] = Object.entries(defs).map(([k, d]) => propertyPill(ed, holder, k, d));
  if (!rows.length) rows.push(h('div', { class: 'empty wide' }, 'Свойств нет. «+» — вариант, переключатель, текст, замена инстанса или слот; слои привязываются в разделе «Свойство компонента».'));
  // Description — as a field if present; otherwise as a link (where it is in component settings).
  const descValue = doc.get(holder, 'description') ?? '';
  const descField = () => textInput(descValue, (v) => doc.transact(() => doc.set(holder, { description: v })), { placeholder: 'Описание', multiline: true, cls: 'desc' });
  let desc: HTMLElement;
  if (descValue) desc = descField();
  else {
    const link: HTMLElement = h('button', { class: 'link-btn' }, '+ Описание');
    link.addEventListener('click', () => {
      const f = descField();
      link.replaceWith(f);
      f.focus();
    });
    desc = link;
  }
  const addVariant =
    type === 'COMPONENT_SET' || set
      ? h('button', {
          class: 'link-btn wide',
          onclick: () =>
            doc.transact(() => {
              // Copy of the last (or selected) variant with a new value of the first property.
              const s = set ?? id;
              const src = set ? id : variantsOf(doc, s).at(-1)!;
              const vals = parseVariantName(doc.get(src, 'name') ?? '');
              const first = Object.keys(vals)[0] ?? 'Property 1';
              const taken = new Set(variantsOf(doc, s).map((v) => parseVariantName(doc.get(v, 'name') ?? '')[first]));
              let n = 2;
              while (taken.has(`Вариант ${n}`)) n++;
              const copy = duplicateVariant(doc, src, variantName({ ...vals, [first]: `Вариант ${n}` }));
              ed.select([copy]);
            }),
        }, '+ Вариант')
      : '';
  return h(
    'div',
    { class: 'section comp-section' },
    h('h3', {}, h('span', {}, set ? 'Вариант' : 'Свойства'), h('span', { class: 'h-acts' }, set ? iconBtn('componentSet', 'Выделить набор', () => ed.select([set])) : '', add)),
    h('div', { class: 'props comp-props' }, ...blocks, ...rows, addVariant, h('div', { class: 'wide' }, desc)),
  );
}

/** Copy of a variant next to it (below) with a new name. */
function duplicateVariant(doc: Document, src: string, name: string): string {
  const parent = doc.parent(src)!;
  const copyTree = (from: string, to: string, index?: number): string => {
    const props = { ...(doc.node(from)!.props as Record<string, unknown>) };
    delete props.componentRef;
    delete props.overrides;
    const id = doc.create(doc.type(from)!, to, props, index);
    for (const c of doc.children(from)) copyTree(c, id);
    return id;
  };
  const id = copyTree(src, parent, doc.children(parent).indexOf(src) + 1);
  const t = doc.get(src, 'transform') ?? [1, 0, 0, 0, 1, 0];
  doc.set(id, { name, transform: [t[0], t[1], t[2], t[3], t[4], t[5] + (doc.get(src, 'height') ?? 0) + 20] });
  // The set grows to fit the new variant.
  const bottom = t[5] + 2 * (doc.get(src, 'height') ?? 0) + 40;
  if ((doc.get(parent, 'height') ?? 0) < bottom) doc.set(parent, { height: bottom });
  return id;
}

/** Several main components are selected — combine them into a variant set. */
export function combineSection(ed: Editor, sel: string[]): HTMLElement | '' {
  const doc = ed.doc;
  if (sel.length < 2 || !sel.every((id) => doc.type(id) === 'COMPONENT' && !componentSetOf(doc, id))) return '';
  const parent = doc.parent(sel[0]!)!;
  if (!sel.every((id) => doc.parent(id) === parent)) return '';
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, 'Компоненты'),
    h('div', { class: 'props' }, h('button', { class: 'export-btn wide', onclick: () => doc.transact(() => ed.select([combineAsVariants(doc, sel, parent)])) }, 'Объединить в набор вариантов')),
  );
}

/** Binding a field of a layer inside a component to a component property. */
export function bindingSection(ed: Editor, sel: string[]): HTMLElement | '' {
  const doc = ed.doc;
  if (sel.length !== 1) return '';
  const id = sel[0]!;
  const owner = propertyOwner(doc, id);
  if (!owner || doc.type(owner) !== 'COMPONENT') return '';
  const holder = definitionsHolder(doc, owner);
  const defs: Defs = propertyDefinitions(doc, owner);
  const refs = doc.get(id, 'componentPropertyReferences') ?? {};
  const type = doc.type(id);
  const row = (field: 'visible' | 'characters' | 'mainComponent' | 'slot', label: string, propType: ComponentPropertyDefinition['type'], create: () => { name: string; value: string | boolean }) => {
    const options = Object.entries(defs).filter(([, d]) => d.type === propType);
    const sel = h(
      'select',
      {},
      h('option', { value: '', selected: !refs[field] }, '—'),
      ...options.map(([k]) => h('option', { value: k, selected: refs[field] === k }, propName(k))),
      h('option', { value: '+' }, 'Новое свойство…'),
    ) as HTMLSelectElement;
    sel.addEventListener('change', () =>
      doc.transact(() => {
        let key: string | null = sel.value || null;
        if (key === '+') {
          const c = create();
          key = addComponentProperty(doc, holder, c.name, propType, c.value);
        }
        setPropertyReference(doc, id, field, key);
      }),
    );
    return propRow(label, TYPE_ICON[propType], h('div', { class: 'field' }, sel));
  };
  const name = doc.get(id, 'name') ?? t('Слой');
  const rows: HTMLElement[] = [row('visible', 'Видимость', 'BOOLEAN', () => ({ name: `Показать ${name}`, value: doc.get(id, 'visible') !== false }))];
  if (type === 'TEXT') rows.push(row('characters', 'Текст', 'TEXT', () => ({ name, value: doc.get(id, 'characters') ?? '' })));
  if (type === 'FRAME') rows.push(row('slot', 'Слот', 'SLOT', () => ({ name, value: '' })));
  if (type === 'INSTANCE') {
    rows.push(row('mainComponent', 'Компонент', 'INSTANCE_SWAP', () => ({ name, value: doc.get(id, 'componentId') ?? '' })));
    rows.push(propRow('Свойства наружу', ICON.instance, toggle(!!doc.get(id, 'isExposedInstance'), (on) => doc.transact(() => doc.set(id, { isExposedInstance: on || undefined })), 'Показывать свойства этого инстанса у инстансов компонента')));
    if (doc.get(id, 'isExposedInstance')) rows.push(...exposedChooser(ed, id));
  }
  return h('div', { class: 'section comp-section' }, h('h3', {}, 'Свойство компонента'), h('div', { class: 'props comp-props' }, ...rows));
}
