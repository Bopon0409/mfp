// Platform: browser or desktop (Tauri, apps/desktop). On desktop — files on disk (chunked reads,
// atomic writes, folders, recycle bin), open and save dialogs, system fonts without a permission
// prompt, files from the file explorer. Tauri modules load only on desktop.

import type { ByteSource } from '@mfp/io-figma';
import { t, tr } from './i18n/index.ts';

/** The editor runs on desktop. */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface DiskEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  /** Modification time, ms. */
  modified: number;
}

export interface SystemFont {
  family: string;
  style: string;
  path: string;
  index: number;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args as never, headers ? { headers } : undefined);
}

const bytes = (v: unknown): Uint8Array => (v instanceof ArrayBuffer ? new Uint8Array(v) : v instanceof Uint8Array ? v : new Uint8Array(v as number[]));

export const disk = {
  readFile: async (path: string) => bytes(await invoke<ArrayBuffer>('read_file', { path })),
  readRange: async (path: string, offset: number, length: number) => bytes(await invoke<ArrayBuffer>('read_range', { path, offset, length })),
  /** Write the whole file (atomically: a temporary file and a rename). */
  writeFile: (path: string, data: Uint8Array) => invoke<void>('write_file', data, { 'x-path': encodeURIComponent(path) }),
  stat: (path: string) => invoke<DiskEntry | null>('stat', { path }),
  listDir: (path: string) => invoke<DiskEntry[]>('list_dir', { path }),
  makeDir: (path: string) => invoke<void>('make_dir', { path }),
  rename: (from: string, to: string) => invoke<void>('rename_path', { from, to }),
  /** Move to the system recycle bin. */
  trash: (path: string) => invoke<void>('trash_path', { path }),
  /** [Documents/MFP, the app's internal folder]. */
  dirs: () => invoke<[string, string]>('app_dirs'),
  fonts: () => invoke<SystemFont[]>('list_fonts'),
  /** Files the app was launched with (double-click on .mfp / .fig). */
  startupPaths: () => invoke<string[]>('startup_paths'),
  /** Migration from an older version: allow the “Recent” paths (once; afterwards the shell remembers them itself). */
  migrateGrants: (paths: string[]) => invoke<number>('scope_migrate', { paths }),
  /** A line to the app output (debugging). */
  log: (message: string) => invoke<void>('log', { message }),
};

/** A file on disk as a byte source: a .fig of any size is read in chunks. */
export class DiskSource implements ByteSource {
  readonly path: string;
  readonly size: number;
  constructor(path: string, size: number) {
    this.path = path;
    this.size = size;
  }
  static async open(path: string): Promise<DiskSource> {
    const st = await disk.stat(path);
    if (!st || st.dir) throw new Error(`Нет файла: ${path}`);
    return new DiskSource(path, st.size);
  }
  async read(offset: number, length: number) {
    return length <= 0 ? new Uint8Array(0) : disk.readRange(this.path, offset, length);
  }
}

/**
 * Open dialog: paths of the chosen files (empty — cancelled). The dialog is shown by the shell — the
 * chosen files are immediately allowed for reading and writing (apps/desktop/src-tauri/src/scope.rs).
 */
export async function openDialog(opts: { multiple?: boolean; directory?: boolean; title?: string; defaultPath?: string } = {}): Promise<string[]> {
  return invoke<string[]>('pick_open', {
    options: {
      multiple: opts.multiple ?? false,
      directory: opts.directory ?? false,
      title: opts.title && tr(opts.title),
      defaultPath: opts.defaultPath,
      filterName: t('Файлы MFP, Figma, Sketch и PDF'),
      extensions: opts.directory ? [] : ['mfp', 'fig', 'sketch', 'pdf'],
    },
  });
}

/** Save dialog: path (null — cancelled); a name without an extension gets ext. */
export async function saveDialog(opts: { defaultPath?: string; title?: string; ext?: string; label?: string } = {}): Promise<string | null> {
  return invoke<string | null>('pick_save', {
    options: { defaultPath: opts.defaultPath, title: opts.title && tr(opts.title), filterName: tr(opts.label ?? 'Файл MFP'), extensions: [opts.ext ?? 'mfp'] },
  });
}

/** Confirmation (native desktop dialog). */
export async function confirmDialog(message: string, title = 'MFP'): Promise<boolean> {
  const { ask } = await import('@tauri-apps/plugin-dialog');
  return ask(tr(message), { title: tr(title), kind: 'warning', okLabel: t('Да'), cancelLabel: t('Нет') });
}

/** MFP updates — releases on the public GitHub page (latest.json of the latest release). */
export const GITHUB_UPDATES_URL = 'https://github.com/Bopon0409/mfp/releases/latest/download/latest.json';

export interface FoundUpdate {
  version: string;
  notes: string;
  install(progress: (part: number) => void): Promise<void>;
}

/**
 * New version on the update server: latest.json addresses in turn (company server, then MFP) —
 * the first one to respond. null — nothing newer; none responded — the last one's error.
 */
export async function findUpdate(endpoints: string[]): Promise<FoundUpdate | null> {
  const { Channel } = await import('@tauri-apps/api/core');
  let last: unknown = new Error('Сервер обновлений недоступен');
  for (const endpoint of endpoints) {
    let found: { version: string; notes: string } | null;
    try {
      found = await invoke<{ version: string; notes: string } | null>('update_check', { endpoint });
    } catch (e) {
      last = e;
      continue;
    }
    if (!found) return null;
    return {
      ...found,
      install: async (progress) => {
        const channel = new Channel<number>();
        channel.onmessage = progress;
        await invoke('update_install', { endpoint, progress: channel });
      },
    };
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Restart the app (after an update). */
export async function relaunch() {
  const { relaunch: restart } = await import('@tauri-apps/plugin-process');
  await restart();
}

/** Files opened from the file explorer while the app is already running. */
export async function onOpenPaths(cb: (paths: string[]) => void) {
  const { listen } = await import('@tauri-apps/api/event');
  await listen<string[]>('open-paths', (e) => cb(e.payload));
}

/** Desktop window title. */
export async function setWindowTitle(title: string) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setTitle(tr(title));
}

/**
 * Closing the desktop window. The window hides immediately, save finishes writing files (seconds for a
 * huge file), then the window closes (destroy; requires the core:window:allow-destroy permission —
 * without it the window didn't close at all).
 * - save returned false (not written) — the window comes back, and the user decides whether to
 *   close without saving (ask).
 * - While save runs, Rust receives heartbeats: none for 20 s (the UI hung) — it exits on its own (lib.rs).
 * - A file was opened from the file explorer while the window was closing — the window comes back
 *   with that file (reopen).
 */
export async function onWindowClose(save: () => Promise<boolean>, ask: () => Promise<boolean>, reopen: (paths: string[]) => void) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const { listen } = await import('@tauri-apps/api/event');
  const w = getCurrentWindow();
  let closing = false;
  let again: string[] | null = null;
  await listen<string[]>('reopen', (e) => {
    again = [...(again ?? []), ...e.payload];
    // The window hides immediately: writing continues, there will be no close after it.
    void invoke('close_cancelled')
      .then(() => w.show())
      .then(() => w.setFocus())
      .catch(() => {});
  });
  await w.onCloseRequested(async (e) => {
    e.preventDefault();
    if (closing) {
      // The window was brought back by a second launch and is being closed again while writing — close as requested.
      if (again) {
        again = null;
        void w.hide();
      }
      return;
    }
    closing = true;
    const beat = setInterval(() => void invoke('closing_alive').catch(() => {}), 2000);
    try {
      await w.hide();
      let ok = await save().catch((err) => {
        console.error('Запись перед закрытием не удалась', err);
        return false;
      });
      if (!ok && !again) {
        await w.show();
        await w.setFocus();
        ok = await ask();
      }
      if (ok && !again) {
        await w.destroy();
        return;
      }
      // The window stays: closing was cancelled or the file was reopened.
      await invoke('close_cancelled');
      await w.show();
      await w.setFocus();
      const paths = again ?? [];
      again = null;
      if (paths.length) reopen(paths);
    } finally {
      clearInterval(beat);
      closing = false;
    }
  });
}

/** File name without folder and extension. */
export const baseName = (path: string) => path.replace(/^.*[\\/]/, '').replace(/\.(mfp|fig|json)$/i, '');
/** The file's folder. */
export const dirName = (path: string) => path.replace(/[\\/][^\\/]*$/, '');
/** Join a path (separator as in the source path). */
export const joinPath = (dir: string, name: string) => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;

/**
 * A separate app window (prototype presentation): window.open opens nothing inside a WebView2 window.
 * A previous window with the same purpose is closed — like the “mfp-player” tab in the browser.
 */
export async function openAppWindow(kind: string, url: string, title: string): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  for (const w of await WebviewWindow.getAll()) if (w.label.startsWith(`${kind}-`)) await w.close().catch(() => {});
  const w = new WebviewWindow(`${kind}-${Date.now().toString(36)}`, { url, title, width: 1280, height: 820, focus: true });
  await new Promise<void>((resolve, reject) => {
    void w.once('tauri://created', () => resolve());
    void w.once('tauri://error', (e) => reject(new Error(String(e.payload))));
  });
}

/** The app's office server (“Share with colleagues on the network”): Node.js and the MFP server from the office folder. */
export interface OfficeInfo {
  running: boolean;
  port: number;
  /** This computer's addresses on the local network. */
  addresses: string[];
  /** Initial setup code (the server has no accounts yet). */
  setupCode: string | null;
}

export const office = {
  start: (port: number) => invoke<OfficeInfo>('office_start', { port }),
  status: () => invoke<OfficeInfo>('office_status'),
  stop: () => invoke<void>('office_stop'),
};
