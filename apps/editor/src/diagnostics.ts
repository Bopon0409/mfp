// Error log and “Report a problem”.
//
// Errors and warnings (console.error / warn, unhandled exceptions and promise rejections) —
// into a ring of recent entries in memory; on desktop — also into a log file on disk (the app data
// folder, logs/, one file per day, kept for a week; the shell writes its crashes there too).
// “Report a problem” builds an archive: log, version, system, GPU, memory and info about the
// open file — numbers only, no content or names. Nothing is sent anywhere: the person saves the archive
// themselves and decides whom to give it to (and no foreign services — 152-FZ).

import { strToU8, zipSync } from 'fflate';
import { isDesktop } from './platform.ts';

type Level = 'ошибка' | 'внимание' | 'сведения';

interface Entry {
  at: number;
  level: Level;
  text: string;
  count: number;
}

const MAX = 500;
const ring: Entry[] = [];
let toDisk: string[] = [];
let diskTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

const stamp = (at: number) => new Date(at).toISOString();

function describe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function record(level: Level, text: string) {
  const last = ring[ring.length - 1];
  // The same entry in a row — as a counter (image after image, frame after frame).
  if (last && last.level === level && last.text === text) {
    last.count++;
    last.at = Date.now();
    return;
  }
  const e: Entry = { at: Date.now(), level, text: text.slice(0, 4000), count: 1 };
  ring.push(e);
  if (ring.length > MAX) ring.shift();
  if (isDesktop) {
    toDisk.push(`${stamp(e.at)} [${level}] ${e.text}`);
    diskTimer ??= setTimeout(flushDisk, 2000);
  }
}

function flushDisk() {
  diskTimer = null;
  const lines = toDisk;
  toDisk = [];
  if (!lines.length) return;
  // No console.*: a log write error must not write to the log.
  void import('@tauri-apps/api/core').then((core) => core.invoke('log_append', { lines })).catch(() => {});
}

/** Info for the log (file open report, startup). */
export function note(text: string) {
  record('сведения', text);
}

/** Watch for errors: once at startup. */
export function installDiagnostics() {
  if (installed) return;
  installed = true;
  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    error(...args);
    record('ошибка', args.map(describe).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warn(...args);
    record('внимание', args.map(describe).join(' '));
  };
  window.addEventListener('error', (e) => record('ошибка', `${e.message} (${e.filename}:${e.lineno}:${e.colno})${e.error instanceof Error && e.error.stack ? `\n${e.error.stack}` : ''}`));
  window.addEventListener('unhandledrejection', (e) => record('ошибка', `Необработанный отказ: ${describe(e.reason)}`));
  // Leaving — flush the log to disk right away.
  window.addEventListener('pagehide', () => {
    if (diskTimer) clearTimeout(diskTimer);
    flushDisk();
  });
  note(`запуск: ${navigator.userAgent}`);
}

/** Log entries as text (newest at the bottom). */
export function journalText(): string {
  return ring.map((e) => `${stamp(e.at)} [${e.level}]${e.count > 1 ? ` ×${e.count}` : ''} ${e.text}`).join('\n');
}

/** GPU (as WebGL sees it). */
function gpu(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'WebGL недоступен';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return String(name);
  } catch {
    return 'неизвестно';
  }
}

/**
 * “Report a problem” archive: report (system and state — numbers about the file and editor), log from
 * memory and (on desktop) logs from disk for the last few days.
 */
export async function problemReport(state: Record<string, unknown>): Promise<Uint8Array> {
  let version = 'веб';
  if (isDesktop) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      version = `десктоп ${await getVersion()}`;
    } catch {
      version = 'десктоп';
    }
  }
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const lines = [
    'Отчёт о проблеме MFP',
    `Создан: ${new Date().toISOString()}`,
    `Версия: ${version}`,
    `Браузер: ${navigator.userAgent}`,
    `Платформа: ${navigator.platform}, ядер ${navigator.hardwareConcurrency ?? '?'}, памяти ${nav.deviceMemory ?? '?'} ГБ`,
    `Экран: ${screen.width}×${screen.height}, масштаб ${devicePixelRatio}`,
    `Видеокарта: ${gpu()}`,
    mem ? `Память JS: ${Math.round(mem.usedJSHeapSize / 2 ** 20)} МБ из ${Math.round(mem.jsHeapSizeLimit / 2 ** 20)} МБ` : '',
    '',
    'Состояние (без содержимого файла):',
    JSON.stringify(state, null, 2),
  ].filter((l) => l !== '');
  const files: Record<string, Uint8Array> = {
    'отчёт.txt': strToU8(lines.join('\n')),
    'журнал.txt': strToU8(journalText()),
  };
  if (isDesktop) {
    flushDisk();
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const disk = await invoke<string>('read_logs', { days: 3 });
      if (disk) files['журнал-с-диска.txt'] = strToU8(disk);
    } catch {
      // no logs on disk
    }
  }
  return zipSync(files);
}
