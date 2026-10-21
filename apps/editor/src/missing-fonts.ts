// Missing fonts: after opening a file, check the fonts of all texts; those found neither in the
// catalog nor among custom fonts get an icon above the canvas. The list popup lets you replace a
// font in all texts (including runs with their own styling) — such texts are re-laid out.

import { restyleText, type Document } from '@mfp/core';
import { textFonts, type FontRef } from '@mfp/renderer';
import type { Editor } from './editor.ts';

const key = (f: FontRef) => `${f.family}|${f.style}`;

export class MissingFonts {
  private ed: Editor;
  private badge: HTMLButtonElement;
  private checked: Document | null = null;
  private list: { font: FontRef; count: number }[] = [];
  /** Families for suggestions (catalog and custom). */
  families: () => string[] = () => [];
  notify: (message: string) => void = () => {};

  constructor(ed: Editor, stage: HTMLElement) {
    this.ed = ed;
    this.badge = document.createElement('button');
    this.badge.className = 'missing-fonts';
    this.badge.hidden = true;
    this.badge.addEventListener('click', () => this.open());
    stage.append(this.badge);
    ed.onPage.push(() => {
      if (this.checked !== ed.doc) void this.check();
    });
    // Custom fonts added — maybe something is no longer missing.
    ed.fonts.onLoad.push(() => {
      if (this.list.length) void this.check();
    });
  }

  /** Fonts of all document texts: missing ones go to the list. */
  async check() {
    const doc = this.ed.doc;
    this.checked = doc;
    // The file loads page by page — wait until all texts arrive.
    await this.ed.importing;
    if (this.ed.doc !== doc) return;
    const used = new Map<string, { font: FontRef; count: number }>();
    for (const id of doc.descendants(doc.root)) {
      if (doc.type(id) !== 'TEXT') continue;
      for (const f of textFonts(doc.props(id))) {
        const e = used.get(key(f));
        if (e) e.count++;
        else used.set(key(f), { font: f, count: 1 });
      }
    }
    const results = await Promise.all([...used.values()].map(async (u) => ((await this.ed.fonts.ensure(u.font)) ? null : u)));
    if (this.ed.doc !== doc) return;
    this.list = results.filter((u): u is { font: FontRef; count: number } => !!u).sort((a, b) => b.count - a.count);
    this.badge.hidden = !this.list.length;
    this.badge.textContent = `Нет шрифтов: ${this.list.length}`;
    this.badge.title = this.list.map((u) => `${u.font.family} ${u.font.style}`).join(', ');
  }

  /** Replacement popup: for each missing font — a replacement family and style. */
  open() {
    document.querySelector('.fonts-dialog')?.remove();
    const box = document.createElement('div');
    box.className = 'fonts-dialog';
    const head = document.createElement('div');
    head.className = 'fd-head';
    head.textContent = 'Недостающие шрифты';
    const close = document.createElement('button');
    close.className = 'pe-close';
    close.textContent = '×';
    close.addEventListener('click', () => box.remove());
    head.append(close);
    const note = document.createElement('p');
    note.className = 'fd-note';
    note.textContent =
      'Тексты с этими шрифтами нарисованы как в исходном файле, но после правки вёрстка пойдёт шрифтом по умолчанию. Замените шрифт или добавьте свой (перетащите файл шрифта на окно, «Шрифты компьютера…» в панели «Текст»).';
    box.append(head, note);
    const datalist = document.createElement('datalist');
    datalist.id = 'fd-families';
    for (const f of this.families()) datalist.append(Object.assign(document.createElement('option'), { value: f }));
    box.append(datalist);
    for (const u of this.list) {
      const row = document.createElement('div');
      row.className = 'fd-row';
      const name = document.createElement('div');
      name.className = 'fd-name';
      name.textContent = `${u.font.family} · ${u.font.style}`;
      const count = document.createElement('span');
      count.className = 'fd-count';
      count.textContent = `${u.count} ${u.count === 1 ? 'текст' : u.count < 5 ? 'текста' : 'текстов'}`;
      name.append(count);
      const family = Object.assign(document.createElement('input'), { value: 'Inter', placeholder: 'Семейство' });
      family.setAttribute('list', 'fd-families');
      family.addEventListener('keydown', (e) => e.stopPropagation());
      const style = Object.assign(document.createElement('input'), { value: u.font.style, placeholder: 'Начертание' });
      style.addEventListener('keydown', (e) => e.stopPropagation());
      const go = Object.assign(document.createElement('button'), { className: 'pe-btn primary', textContent: 'Заменить' });
      go.addEventListener('click', () => {
        const to = { family: family.value.trim() || 'Inter', style: style.value.trim() || 'Regular' };
        const n = this.replace(u.font, to);
        this.notify(`«${u.font.family} ${u.font.style}» → «${to.family} ${to.style}»: ${n} ${n === 1 ? 'текст' : 'текстов'}`);
        row.remove();
        void this.check().then(() => this.list.length || box.remove());
      });
      row.append(name, family, style, go);
      box.append(row);
    }
    document.body.append(box);
  }

  /** Replace a font in all document texts; returns the number of changed texts. */
  replace(from: FontRef, to: FontRef): number {
    const doc = this.ed.doc;
    let n = 0;
    doc.transact(() => {
      for (const id of [...doc.descendants(doc.root)]) {
        if (doc.type(id) !== 'TEXT') continue;
        if (!textFonts(doc.props(id)).some((f) => key(f) === key(from))) continue;
        restyleText(doc, id, 0, (doc.get(id, 'characters') ?? '').length, (s) => (key(s.fontName) === key(from) ? { fontName: { ...to } } : {}));
        n++;
      }
    });
    void this.ed.fonts.ensure(to);
    return n;
  }
}
