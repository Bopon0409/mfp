// Plugins in the UI: the “Plugins” menu (plugin commands as a submenu), running with parameters
// (quick action in the actions menu), the MFP catalog, installing your own and by URL.

import { isCodegen, isWidget, pluginCommands, type ManifestMenuItem, type ManifestParameter, type PluginBundle } from '@mfp/plugin-host';
import type { PluginHost } from '@mfp/plugin-host/browser';
import { openParameters } from './actions.ts';
import { fill, h, modal } from './dom.ts';
import type { MenuEntry, MenuItem } from './menu.ts';
import { fetchBundle, type CatalogEntry, type InstalledPlugin, type PluginRegistry } from './plugin-registry.ts';

export interface PluginUiDeps {
  registry: PluginRegistry;
  host(): PluginHost | null;
  /** Code generation plugin — into the developer mode code panel. */
  addCodegen(bundle: PluginBundle): void;
  /** Choose the folder of your own plugin (manifest.json and files). */
  pickFiles(): void;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Widget — onto the canvas. */
  insertWidget?(bundle: PluginBundle): void;
  /** Plugin from a description (a model with your own key). */
  generate?(): void;
}

/** MFP catalog: plugins that can be installed in one click (next to the editor). */
export const CATALOG_URL = 'catalog/catalog.json';

/** Run a plugin command: with parameters — input in the actions menu first. */
/** Last plugin run — for “Run last plugin” (Ctrl+Alt+P). */
let last: { d: PluginUiDeps; bundle: PluginBundle; command: string; parameters?: ManifestParameter[]; parameterOnly: boolean } | null = null;

/** Name of the last run plugin (null — no plugins have been run yet). */
export const lastPluginName = () => (last ? last.bundle.manifest.name : null);

/** Run the last plugin with the same command (with parameters — the parameters popup again). */
export function relaunchLastPlugin(): boolean {
  if (!last) return false;
  launch(last.d, last.bundle, last.command, last.parameters, last.parameterOnly);
  return true;
}

export function launch(d: PluginUiDeps, bundle: PluginBundle, command: string, parameters?: ManifestParameter[], parameterOnly = true) {
  const host = d.host();
  if (!host) return;
  last = { d, bundle, command, parameters, parameterOnly };
  if (isCodegen(bundle.manifest)) return d.addCodegen(bundle);
  if (!parameters?.length || !parameterOnly) {
    host.run(bundle, { command });
    return;
  }
  const flow = host.runWithParameters(bundle, command);
  const cmd = pluginCommands(bundle.manifest).find((c) => c.command === command);
  openParameters({
    title: [bundle.manifest.name, ...(cmd?.path ?? [])].join(' › '),
    params: parameters,
    input: flow.input,
    done: flow.done,
    cancel: flow.cancel,
  });
}

function menuOf(d: PluginUiDeps, bundle: PluginBundle, items: ManifestMenuItem[]): MenuEntry[] {
  return items.map((it): MenuEntry => {
    if (it.separator) return 'sep';
    if (it.menu) return { label: it.name ?? '', submenu: menuOf(d, bundle, it.menu) };
    return { label: it.name ?? '', ...(it.parameters?.length ? { hint: 'параметры' } : {}), run: () => launch(d, bundle, it.command ?? '', it.parameters, it.parameterOnly !== false) };
  });
}

/** Plugin item: commands as a submenu, no menu — the plugin itself. */
function entryOf(d: PluginUiDeps, p: InstalledPlugin): MenuEntry {
  const m = p.bundle.manifest;
  if (isCodegen(m)) return { label: m.name, hint: 'код', run: () => d.addCodegen(p.bundle) };
  if (isWidget(m)) return { label: m.name, hint: 'виджет', run: () => d.insertWidget?.(p.bundle) };
  if (m.menu?.length) return { label: m.name, submenu: menuOf(d, p.bundle, m.menu) };
  return { label: m.name, ...(m.parameters?.length ? { hint: 'параметры' } : {}), run: () => launch(d, p.bundle, '', m.parameters, m.parameterOnly !== false) };
}

/** The “Plugins” menu. */
const PINS_KEY = 'mfp.pinnedPlugins';

/** Pinned plugins (ids, in pin order) — on this device. */
export function pinnedPlugins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function setPinned(ids: string[]) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(ids));
  } catch {
    /* won't be remembered */
  }
}

export async function pluginMenu(d: PluginUiDeps): Promise<MenuEntry[]> {
  const list = await d.registry.list();
  const own = list.filter((p) => p.source !== 'dev');
  const lastName = lastPluginName();
  // Pinned ones first (our own; request “pinning function to plugins and widgets”, 03.2026).
  const pins = pinnedPlugins().filter((id) => list.some((p) => p.bundle.manifest.id === id));
  const pinned = pins.map((id) => list.find((p) => p.bundle.manifest.id === id)!);
  const rest = list.filter((p) => !pins.includes(p.bundle.manifest.id));
  return [
    ...(lastName ? [{ label: `Запустить последний: ${lastName}`, hint: 'Ctrl+Alt+P', run: () => void relaunchLastPlugin() } as MenuEntry, 'sep' as MenuEntry] : []),
    ...pinned.map((p) => ({ ...(entryOf(d, p) as MenuItem), icon: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M10 2l4 4-2 1-2 3 1 3-1 1-3-3-3 3H3v-1l3-3-3-3 1-1 3 1 3-2z" fill="currentColor"/></svg>' }) as MenuEntry),
    ...(pinned.length && rest.length ? (['sep'] as MenuEntry[]) : []),
    ...rest.map((p) => entryOf(d, p)),
    ...(list.length ? (['sep'] as MenuEntry[]) : []),
    ...(list.length
      ? [
          {
            label: 'Закрепить наверху',
            submenu: list.map((p) => {
              const id = p.bundle.manifest.id;
              const on = pins.includes(id);
              return { label: p.bundle.manifest.name, checked: on, run: () => setPinned(on ? pinnedPlugins().filter((x) => x !== id) : [...pinnedPlugins(), id]) };
            }),
          } as MenuEntry,
        ]
      : []),
    { label: 'Каталог плагинов…', run: () => void catalogDialog(d) },
    ...(d.generate ? [{ label: 'Создать плагин по описанию…', hint: 'AI', run: d.generate } as MenuEntry] : []),
    { label: 'Загрузить свой плагин…', hint: 'manifest + code', run: d.pickFiles },
    ...(own.length
      ? [
          {
            label: 'Удалить плагин',
            submenu: own.map((p) => ({
              label: p.bundle.manifest.name,
              run: () => {
                if (!confirm(`Удалить плагин «${p.bundle.manifest.name}»?`)) return;
                void d.registry.remove(p.bundle.manifest.id).then(() => d.notify(`Плагин «${p.bundle.manifest.name}» удалён`));
              },
            })),
          } as MenuEntry,
        ]
      : []),
  ];
}

/** Install a plugin and say right away where it is. */
export async function installBundle(d: PluginUiDeps, bundle: PluginBundle, source: 'local' | 'catalog', url?: string) {
  await d.registry.install(bundle, source, url);
  if (isCodegen(bundle.manifest)) {
    d.addCodegen(bundle);
    return;
  }
  if (isWidget(bundle.manifest)) {
    d.notify(`Виджет «${bundle.manifest.name}» установлен и поставлен на холст (ещё — меню «Плагины»)`);
    d.insertWidget?.(bundle);
    return;
  }
  d.notify(`Плагин «${bundle.manifest.name}» установлен: меню «Плагины» и меню действий (Ctrl+K)`);
}

/** Catalog dialog: the catalog's plugin list, install and remove; install by URL. */
export async function catalogDialog(d: PluginUiDeps) {
  const m = modal('Каталог плагинов', { cls: 'wide' });
  let entries: CatalogEntry[] = [];
  let error: string | null = null;
  const base = new URL(CATALOG_URL, location.href);
  try {
    const res = await fetch(base);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entries = ((await res.json()) as { plugins: CatalogEntry[] }).plugins ?? [];
  } catch (e) {
    error = `Каталог недоступен: ${(e as Error).message}`;
  }
  const urlInput = h('input', { class: 'm-input', placeholder: 'https://…/папка-плагина/ (с manifest.json)', spellcheck: 'false' }) as HTMLInputElement;
  const render = async () => {
    const installed = new Map((await d.registry.list()).map((p) => [p.bundle.manifest.id, p]));
    const row = (e: CatalogEntry) => {
      const have = installed.get(e.id);
      const busy = h('span', { class: 'm-note' });
      const btn = h(
        'button',
        {
          class: `m-btn${have ? '' : ' primary'}`,
          onclick: async () => {
            try {
              if (have && have.source !== 'dev') {
                await d.registry.remove(e.id);
                d.notify(`Плагин «${e.name}» удалён`);
              } else {
                fill(busy, 'Загрузка…');
                const url = new URL(e.url, base).href;
                const { bundle } = await fetchBundle(url);
                await installBundle(d, bundle, 'catalog', url);
              }
            } catch (err) {
              d.notify(`«${e.name}»: ${(err as Error).message}`, 'error');
            }
            void render();
          },
        },
        have ? (have.source === 'dev' ? 'Пример' : 'Удалить') : 'Установить',
      ) as HTMLButtonElement;
      if (have?.source === 'dev') btn.disabled = true;
      return h(
        'div',
        { class: 'catalog-row' },
        h('div', { class: 'catalog-text' }, h('div', { class: 'catalog-name' }, e.name), h('div', { class: 'catalog-desc' }, e.description), h('div', { class: 'catalog-meta' }, `${e.author} · ${e.license}`, e.source ? h('a', { href: e.source, target: '_blank', rel: 'noopener' }, ' · исходный код') : null)),
        busy,
        btn,
      );
    };
    fill(
      m.body,
      h('p', { class: 'm-note' }, 'Плагины в формате Figma: из каталога, из своей папки или по адресу пакета с открытым кодом. Плагин работает в песочнице и видит только этот файл.'),
      error ? h('p', { class: 'm-error' }, error) : entries.length ? h('div', { class: 'm-list' }, ...entries.map(row)) : h('p', { class: 'm-note' }, 'В каталоге пока пусто.'),
      h('div', { class: 'm-row' }, urlInput, h('button', { class: 'm-btn', onclick: () => void fromUrl() }, 'Установить по адресу')),
      h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => (m.close(), d.pickFiles()) }, 'Загрузить свой…')),
    );
  };
  const fromUrl = async () => {
    const url = urlInput.value.trim();
    if (!/^https?:\/\//.test(url)) return d.notify('Нужен адрес http(s):// папки с manifest.json', 'error');
    try {
      const { bundle, warnings } = await fetchBundle(url);
      for (const w of warnings) d.notify(`Плагин: ${w}`);
      await installBundle(d, bundle, 'catalog', url);
      urlInput.value = '';
      void render();
    } catch (e) {
      d.notify(`Не удалось установить: ${(e as Error).message}`, 'error');
    }
  };
  await render();
}
