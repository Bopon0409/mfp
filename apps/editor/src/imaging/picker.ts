// The “Images from projects” dialog: on the left, the open file and team files (projects, drafts, shared with me);
// in the middle, the file's pages; on the right, layers with images. Multiple can be selected, across pages and files.

import { fill, h, modal } from '../dom.ts';
import type { Editor } from '../editor.ts';
import type { ServerLink } from './magnific.ts';
import { CloudDocs, imageBlob, pageImages, pagesOf, type Cloud, type FileRef, type ImageLayer, type ImageOrigin } from './projects.ts';

export interface Picked {
  origin: ImageOrigin;
  load: () => Promise<Blob>;
}

export interface PickerEnv {
  editor: Editor;
  server: ServerLink;
  cloud: Cloud;
}

type Doc = Editor['doc'];
const OPEN = 'open';
const THUMB = 256;
const THUMB_JOBS = 6;

export function pickImages(env: PickerEnv, opts: { multiple: boolean; title?: string; action?: string }): Promise<Picked[] | null> {
  return new Promise((resolve) => {
    const { editor, cloud } = env;
    const signedIn = cloud.signedIn();
    const docs = signedIn ? new CloudDocs(editor, cloud) : null;
    const urls = new Map<string, Promise<string>>();
    const jobs = new WeakMap<Element, () => Promise<void>>();
    const queue: (() => Promise<void>)[] = [];
    let active = 0;
    let done = false;
    let file: { key: string; fileId: string | null; name: string; doc: Doc } | null = null;
    let pageId: string | null = null;
    let query = '';
    let shown: ImageLayer[] = [];
    let seq = 0;
    const selected = new Map<string, Picked>();

    const pump = () => {
      while (active < THUMB_JOBS && queue.length) {
        active++;
        void queue.shift()!().finally(() => {
          active--;
          pump();
        });
      }
    };
    const grid = h('div', { class: 'pk-grid' });
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          const job = jobs.get(e.target);
          if (job) queue.push(job);
        }
        pump();
      },
      { root: grid, rootMargin: '300px' },
    );
    const m = modal(opts.title ?? 'Картинки из проектов', {
      cls: 'img-picker',
      onClose: () => {
        observer.disconnect();
        for (const u of urls.values()) void u.then((x) => URL.revokeObjectURL(x)).catch(() => undefined);
        docs?.dispose();
        if (!done) resolve(null);
      },
    });

    const note = (text: string, cls = '') => h('div', { class: `img-note ${cls}` }, text);
    const filesCol = h('div', { class: 'pk-col pk-files' });
    const pagesCol = h('div', { class: 'pk-col pk-pages' });
    const search = h('input', {
      class: 'img-input pk-search',
      placeholder: 'Найти по имени слоя',
      oninput: () => {
        query = search.value.trim().toLowerCase();
        renderGrid();
      },
    }) as HTMLInputElement;
    const allBtn = h('button', { class: 'ups-btn', hidden: !opts.multiple, onclick: () => selectShown() }, 'Выбрать все');
    const info = h('span', { class: 'pk-info' });
    const okBtn = h('button', { class: 'img-btn primary', disabled: true, onclick: () => confirm() }, opts.action ?? 'Выбрать');
    m.body.append(
      h('div', { class: 'pk' }, filesCol, pagesCol, h('div', { class: 'pk-main' }, h('div', { class: 'pk-bar' }, search, allBtn), grid)),
      h('div', { class: 'pk-foot' }, info, h('button', { class: 'img-btn', onclick: () => m.close() }, 'Отмена'), okBtn),
    );

    const updateInfo = () => {
      const n = selected.size;
      info.textContent = n ? `Выбрано: ${n}` : opts.multiple ? 'Щелчок — выбрать; можно с разных страниц и файлов' : 'Щелчок — выбрать, двойной — сразу взять';
      okBtn.disabled = !n;
      okBtn.textContent = opts.multiple && n ? `${opts.action ?? 'Выбрать'} (${n})` : (opts.action ?? 'Выбрать');
    };

    const confirm = () => {
      if (!selected.size) return;
      done = true;
      const list = [...selected.values()];
      m.close();
      resolve(list);
    };

    // ---------- files ----------

    const markFile = () => {
      for (const b of filesCol.querySelectorAll<HTMLElement>('.pk-item')) b.classList.toggle('on', b.dataset.key === file?.key);
    };

    const fileItem = (key: string, fileId: string | null, name: string, sub = '') =>
      h('button', { class: 'pk-item', 'data-key': key, title: name, onclick: () => void openFile(key, fileId, name) }, h('span', { class: 'pk-item-name' }, name), sub ? h('span', { class: 'pk-item-sub' }, sub) : null);

    const folder = (title: string, load: () => Promise<FileRef[]>) => {
      let open = false;
      let list: FileRef[] | null = null;
      let error = '';
      const box = h('div', { class: 'pk-group' });
      const render = () => {
        fill(box,
          h('button', { class: `pk-folder${open ? ' open' : ''}`, title, onclick: () => void toggle() }, title),
          open ? (list ? h('div', { class: 'pk-sub' }, ...(list.length ? list.map((f) => fileItem(f.id, f.id, f.name, f.id === cloud.openFileId() ? 'открыт' : '')) : [note('Файлов нет')])) : note(error || 'Загружаю…', error ? 'error' : '')) : null,
        );
        markFile();
      };
      const toggle = async () => {
        open = !open;
        render();
        if (!open || list) return;
        try {
          list = await load();
        } catch (e) {
          error = (e as Error).message;
        }
        render();
      };
      render();
      return box;
    };

    const openFile = async (key: string, fileId: string | null, name: string) => {
      const token = ++seq;
      file = null;
      markFile();
      pagesCol.replaceChildren(note('Загружаю файл…'));
      grid.replaceChildren();
      shown = [];
      try {
        const doc = fileId === null ? editor.doc : (await docs!.open(fileId)).doc;
        if (token !== seq) return;
        file = { key, fileId, name, doc };
        markFile();
        const pages = pagesOf(doc);
        pageId = doc === editor.doc && pages.some((p) => p.id === editor.pageId) ? editor.pageId : (pages[0]?.id ?? null);
        renderPages();
        renderGrid();
      } catch (e) {
        if (token !== seq) return;
        const status = (e as { status?: number }).status;
        pagesCol.replaceChildren(note(status === 403 ? 'Нет доступа к файлу' : (e as Error).message, 'error'));
      }
    };

    const openId = cloud.openFileId();
    filesCol.append(h('div', { class: 'pk-label' }, 'Открытый файл'), fileItem(OPEN, openId, 'Открытый файл', 'с отменой правок (Ctrl+Z)'));
    if (signedIn) {
      for (const team of cloud.teams()) {
        const projects = cloud.projects().filter((p) => p.teamId === team.id);
        filesCol.append(h('div', { class: 'pk-label' }, team.name));
        if (!projects.length) filesCol.append(note('Проектов нет'));
        for (const p of projects) filesCol.append(folder(p.name, async () => (await cloud.api<{ files: FileRef[] }>('GET', `/api/projects/${p.id}`)).files));
      }
      filesCol.append(
        h('div', { class: 'pk-label' }, 'Ещё'),
        folder('Черновики', async () => (await cloud.api<{ files: FileRef[] }>('GET', '/api/files?scope=drafts')).files),
        folder('Доступные мне', async () => (await cloud.api<{ files: FileRef[] }>('GET', '/api/files?scope=shared')).files),
      );
    } else {
      filesCol.append(note('Войдите, чтобы брать картинки из файлов команды'));
    }

    // ---------- pages and images ----------

    const renderPages = () => {
      if (!file) return;
      const doc = file.doc;
      const pages = pagesOf(doc);
      pagesCol.replaceChildren(
        h('div', { class: 'pk-label' }, 'Страницы'),
        ...pages.map((p) => {
          const n = pageImages(doc, p.id).length;
          return h(
            'button',
            {
              class: `pk-item${p.id === pageId ? ' on' : ''}`,
              disabled: !n,
              onclick: () => {
                pageId = p.id;
                renderPages();
                renderGrid();
              },
            },
            h('span', { class: 'pk-item-name' }, p.name),
            h('span', { class: 'pk-item-sub' }, n ? `картинок: ${n}` : 'без картинок'),
          );
        }),
      );
    };

    const thumb = (hash: string, live: boolean): Promise<string> => {
      const key = `${live ? 'l' : 'r'}:${hash}`;
      let p = urls.get(key);
      if (!p) {
        p = imageBlob(editor, env.server, { doc: live ? editor.doc : null, hash }, live ? undefined : THUMB).then((b) => URL.createObjectURL(b));
        p.catch(() => urls.delete(key));
        urls.set(key, p);
      }
      return p;
    };

    const keyOf = (l: ImageLayer) => `${file!.key}/${l.id}`;
    const pick = (l: ImageLayer): Picked => {
      const f = file!;
      const origin: ImageOrigin = { fileId: f.fileId, fileName: f.name, doc: f.doc === editor.doc ? f.doc : null, nodeId: l.id, hash: l.hash, name: l.name, width: l.width, height: l.height };
      return { origin, load: () => imageBlob(editor, env.server, origin) };
    };

    const toggle = (l: ImageLayer, el: HTMLElement) => {
      const key = keyOf(l);
      if (!opts.multiple) {
        selected.clear();
        for (const c of grid.querySelectorAll('.pk-card.on')) c.classList.remove('on');
      }
      if (selected.has(key)) selected.delete(key);
      else selected.set(key, pick(l));
      el.classList.toggle('on', selected.has(key));
      updateInfo();
    };

    const selectShown = () => {
      for (const l of shown) selected.set(keyOf(l), selected.get(keyOf(l)) ?? pick(l));
      for (const c of grid.querySelectorAll('.pk-card')) c.classList.add('on');
      updateInfo();
    };

    const card = (l: ImageLayer) => {
      const live = file!.doc === editor.doc;
      const img = h('img', { class: 'pk-thumb', alt: '', draggable: false }) as HTMLImageElement;
      const el = h(
        'button',
        {
          class: `pk-card${selected.has(keyOf(l)) ? ' on' : ''}`,
          title: `${l.name} · ${l.width}×${l.height}`,
          onclick: () => toggle(l, el),
          ondblclick: () => {
            if (opts.multiple) return;
            if (!selected.has(keyOf(l))) toggle(l, el);
            confirm();
          },
        },
        h('span', { class: 'pk-thumb-box' }, img),
        h('span', { class: 'pk-name' }, l.name),
        h('span', { class: 'pk-size' }, `${l.width}×${l.height}`),
      );
      jobs.set(el, async () => {
        try {
          img.src = await thumb(l.hash, live);
        } catch {
          el.classList.add('broken');
        }
      });
      observer.observe(el);
      return el;
    };

    const renderGrid = () => {
      if (!file || !pageId) {
        grid.replaceChildren(note(file ? 'В файле нет страниц' : ''));
        shown = [];
        return;
      }
      const layers = pageImages(file.doc, pageId);
      shown = query ? layers.filter((l) => l.name.toLowerCase().includes(query)) : layers;
      grid.replaceChildren(...(shown.length ? shown.map(card) : [note(layers.length ? 'Ничего не нашлось' : 'На этой странице нет слоёв с картинкой')]));
      (allBtn as HTMLButtonElement).disabled = !shown.length;
    };

    updateInfo();
    void openFile(OPEN, openId, 'Открытый файл');
    setTimeout(() => search.focus());
  });
}
