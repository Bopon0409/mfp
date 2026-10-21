// Component playground (developer mode): an instance in a separate copy — variants, texts, booleans and
// swaps change live, the image and code (from the code connection and generated) update
// immediately; the file doesn't change.

import { codeConnectOf, componentSetOf, playgroundDoc, propertyDefinitions, renderCodeConnect, setInstanceProperties, variantDefinitions, instancePropertyValues } from '@mfp/core';
import { CODE_LANGUAGES, generateCode, type CodeLanguage } from '@mfp/editing';
import { h, iconBtn } from './dom.ts';
import type { Editor } from './editor.ts';
import { highlight, hlLanguage } from './inspect-panel.ts';

export async function openPlayground(ed: Editor, id: string, language: string, notify: (m: string) => void) {
  const doc = ed.doc;
  const comp = doc.type(id) === 'INSTANCE' ? doc.get(id, 'componentId') : id;
  if (!comp || !doc.has(comp)) {
    notify('Главного компонента нет в файле — площадка недоступна');
    return;
  }
  const pg = playgroundDoc(doc, comp);
  if (!pg) return;
  const scratch = pg.doc;
  const inst = pg.instance;
  // Initial values match the selected instance.
  if (doc.type(id) === 'INSTANCE') {
    try {
      scratch.transact(() => setInstanceProperties(scratch, inst, instancePropertyValues(doc, id)), 'import');
    } catch {
      // A property missing in the copy is left at its default.
    }
  }
  const urls: string[] = [];
  const close = () => {
    for (const u of urls) URL.revokeObjectURL(u);
    root.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  const set = componentSetOf(scratch, scratch.get(inst, 'componentId') ?? '');
  const title = doc.get(set ?? comp, 'name') ?? '';
  const preview = h('div', { class: 'pg-preview' }, h('div', { class: 'cmp-empty' }, 'Рисую…'));
  const controls = h('div', { class: 'pg-controls' });
  const code = h('div', { class: 'pg-code' });
  // The plugin language isn't for the playground: use CSS then.
  let lang: CodeLanguage = CODE_LANGUAGES.some((l) => l.id === language) ? (language as CodeLanguage) : 'css';
  const root = h(
    'div',
    { class: 'cmp', role: 'dialog', 'aria-label': `Площадка «${title}»` },
    h('div', { class: 'cmp-box pg-box' }, h('div', { class: 'cmp-head' }, h('span', { class: 'cmp-title' }, `Площадка: ${title}`), h('span', { class: 'dv-dim' }, 'файл не меняется'), iconBtn('close', 'Закрыть (Esc)', close)), h('div', { class: 'pg-main' }, h('div', { class: 'pg-left' }, preview, code), controls)),
  );
  root.addEventListener('pointerdown', (e) => e.target === root && close());
  document.body.append(root);
  document.addEventListener('keydown', onKey, true);

  const update = async () => {
    const r = await ed.renderNode(inst, 520, scratch);
    if (!root.isConnected) return;
    if (r) {
      const url = URL.createObjectURL(r.blob);
      urls.push(url);
      preview.replaceChildren(h('img', { src: url, alt: title }));
    } else preview.replaceChildren(h('div', { class: 'cmp-empty' }, 'Не удалось нарисовать'));
    // Code: from the code connection (if any) and generated.
    const links = codeConnectOf(scratch, inst);
    const langSel = h('select', { class: 'dv-select', 'aria-label': 'Язык' }, ...CODE_LANGUAGES.map((l) => h('option', { value: l.id, selected: l.id === lang }, l.label))) as HTMLSelectElement;
    langSel.addEventListener('change', () => {
      lang = langSel.value as CodeLanguage;
      void update();
    });
    const block = (label: string, text: string, kind: CodeLanguage) => {
      const pre = h('pre', { class: 'dv-code' });
      pre.innerHTML = highlight(text, kind);
      return h('div', { class: 'pg-block' }, h('div', { class: 'pg-block-head' }, h('span', {}, label), iconBtn('copy', 'Скопировать', () => void navigator.clipboard?.writeText(text).then(() => notify('Код скопирован')))), pre);
    };
    code.replaceChildren(
      ...links.map((l) => block(`Код компонента · ${l.language}${l.source ? ` · ${l.source}` : ''}`, renderCodeConnect(scratch, inst, l), hlLanguage(l.language))),
      h('div', { class: 'pg-block-head' }, h('span', {}, 'Сгенерированный код'), langSel),
      block('', generateCode(scratch, inst, { language: lang }), lang),
    );
  };

  // Property controls.
  const defs = propertyDefinitions(scratch, scratch.get(inst, 'componentId')!);
  const variants = set ? variantDefinitions(scratch, set) : {};
  const values = () => instancePropertyValues(scratch, inst);
  const apply = (key: string, value: string | boolean) => {
    try {
      scratch.transact(() => setInstanceProperties(scratch, inst, { [key]: value }), 'import');
    } catch (e) {
      notify(String((e as Error).message ?? e));
    }
    // The variant may have switched to the nearest one — other properties too: re-read the values
    // (except while typing — the field is not recreated, otherwise focus would be lost).
    if (defs[key]?.type !== 'TEXT') renderControls();
    void update();
  };
  const renderControls = () => {
    const rows: HTMLElement[] = [];
    for (const [key, d] of Object.entries(defs)) {
      const name = key.split('#')[0]!;
      const v = values()[key];
      let input: HTMLElement;
      if (d.type === 'VARIANT') {
        const opts = variants[key]?.variantOptions ?? d.variantOptions ?? [];
        const s = h('select', { class: 'dv-select', 'aria-label': name }, ...opts.map((o) => h('option', { value: o, selected: o === v }, o))) as HTMLSelectElement;
        s.addEventListener('change', () => apply(key, s.value));
        input = s;
      } else if (d.type === 'BOOLEAN') {
        const c = h('input', { type: 'checkbox', checked: v === true, 'aria-label': name }) as HTMLInputElement;
        c.addEventListener('change', () => apply(key, c.checked));
        input = c;
      } else if (d.type === 'TEXT') {
        const t = h('input', { class: 'cfield', value: String(v ?? ''), 'aria-label': name }) as HTMLInputElement;
        t.addEventListener('keydown', (e) => e.stopPropagation());
        t.addEventListener('input', () => apply(key, t.value));
        input = t;
      } else if (d.type === 'INSTANCE_SWAP') {
        const choices = [d.defaultValue, ...(d.preferredValues ?? [])].filter((x, i, a): x is string => typeof x === 'string' && scratch.has(x) && a.indexOf(x) === i);
        const s = h('select', { class: 'dv-select', 'aria-label': name }, ...choices.map((c) => h('option', { value: c, selected: c === v }, scratch.get(c, 'name') ?? c))) as HTMLSelectElement;
        s.addEventListener('change', () => apply(key, s.value));
        input = s;
      } else continue;
      rows.push(h('label', { class: 'pg-row' }, h('span', { class: 'dv-label' }, name), input));
    }
    controls.replaceChildren(h('div', { class: 'pg-sub' }, 'Свойства'), ...(rows.length ? rows : [h('div', { class: 'empty' }, 'У компонента нет свойств.')]));
  };
  renderControls();
  await update();
}
