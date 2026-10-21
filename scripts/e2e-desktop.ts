// Checks of the built desktop app (Windows): launch and close, edit before close, process crash
// (edit journal), second launch during close, hung UI, write failure, opening
// files of all formats, a large file. Each scenario uses its own WebView2 profile in a temporary
// folder (the user's files are not touched) and debugging over CDP.
//
//   npm run e2e:desktop                — all scenarios;
//   npm run e2e:desktop -- crash big   — selected ones;
//   MFP_EXE=path\to\mfp-desktop.exe    — a different build.
//
// Large files come from fixtures/ (not in git): whichever exist are checked.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { sampleMfp, samplePdf, sampleSketch } from './samples.ts';

const ROOT = resolve(import.meta.dirname, '..');
const EXE = resolve(process.env.MFP_EXE ?? join(ROOT, 'apps/desktop/src-tauri/target/release/mfp-desktop.exe'));
const WORK = join(tmpdir(), 'mfp-e2e');
/** Debug port — unique per launch: the WebView2 of a previous launch may still hold its own. */
let port = 9335;

/**
 * Free debug port: if a foreign browser already answers on it (another check, debugging), App
 * would attach to its page instead of the app's — and the edit would “not find” window.mfp.
 */
async function freePort(): Promise<number> {
  for (;;) {
    const p = ++port;
    try {
      await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(300) });
    } catch {
      return p;
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Result {
  name: string;
  ok: boolean;
  details: string;
}
const results: Result[] = [];

/** App window under debugging. */
class App {
  child: ChildProcess;
  exited: { code: number | null; at: number } | null = null;
  logs: string[] = [];
  imageFailures = 0;
  private ws: WebSocket | null = null;
  private id = 0;
  private pending = new Map<number, (m: { result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } } }) => void>();

  constructor(child: ChildProcess) {
    this.child = child;
    child.on('exit', (code) => (this.exited = { code, at: Date.now() }));
  }

  static async launch(profile: string, args: string[] = []): Promise<App> {
    mkdirSync(profile, { recursive: true });
    const PORT = await freePort();
    const child = spawn(EXE, args, {
      // Office server — only on this computer (no firewall prompt) and with data in the test profile.
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, MFP_LOG_DIR: join(profile, 'logs'), MFP_OFFICE_DATA: join(profile, 'office'), MFP_OFFICE_HOST: '127.0.0.1', MFP_SCOPE_FILE: join(profile, 'granted-files.json'), MFP_E2E_BACKGROUND: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: 'ignore',
    });
    const app = new App(child);
    interface Target {
      type: string;
      webSocketDebuggerUrl: string;
    }
    let target: Target | undefined;
    for (let i = 0; i < 80 && !target; i++) {
      await sleep(250);
      try {
        target = ((await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Target[]).find((t) => t.type === 'page');
      } catch {
        // not up yet
      }
    }
    if (!target) throw new Error('нет страницы для отладки');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('отладка не подключилась')), { once: true });
    });
    app.ws = ws;
    // The page has closed — no responses will come: pending requests fail instead of hanging forever.
    ws.addEventListener('close', () => {
      for (const done of app.pending.values()) done({ result: { exceptionDetails: { exception: { description: 'страница закрыта' } } } });
      app.pending.clear();
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (m.id && app.pending.has(m.id)) {
        app.pending.get(m.id)!(m as never);
        app.pending.delete(m.id);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params!.exceptionDetails as { text?: string; exception?: { description?: string } };
        app.logs.push(`исключение: ${d.exception?.description ?? d.text}`);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const p = m.params as { type: string; args: { value?: unknown; description?: string }[] };
        const text = p.args.map((a) => String(a.value ?? a.description)).join(' ');
        if (text.startsWith('Картинка')) app.imageFailures++;
        else if (p.type === 'error') app.logs.push(`ошибка: ${text.slice(0, 300)}`);
      }
    });
    await app.send('Runtime.enable');
    await app.waitFor('!!window.mfp?.editor', 30_000);
    // The working file is open (under load — not immediately): edits before this would go into a document that gets replaced.
    await app.waitFor('!!window.mfp.files?.current?.id', 15_000);
    return app;
  }

  /** Relaunch with the same profile: on launch — the file list, open the last one, as from the list. */
  static async reopen(profile: string): Promise<App> {
    const app = await App.launch(profile);
    await app.eval('window.mfp.files.start().then(() => 1)');
    return app;
  }

  send(method: string, params: Record<string, unknown> = {}) {
    return new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } } }>((r) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        r({ result: { exceptionDetails: { exception: { description: 'страница закрыта' } } } });
        return;
      }
      const n = ++this.id;
      this.pending.set(n, r);
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }

  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const exc = r.result?.exceptionDetails;
    if (exc) throw new Error(exc.exception?.description ?? 'ошибка в странице');
    return r.result?.result?.value as T;
  }

  async waitFor(expr: string, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval<boolean>(expr).catch(() => false)) return true;
      await sleep(200);
    }
    return false;
  }

  /** A named rectangle on the current page. */
  edit(name: string) {
    return this.eval(`(() => { const ed = window.mfp.editor; const d = ed.doc; return d.transact(() => d.create('RECTANGLE', ed.pageId, { name: ${JSON.stringify(name)}, transform: [1, 0, 40, 0, 1, 40], width: 120, height: 80 })); })()`);
  }

  has(name: string) {
    return this.eval<boolean>(`(() => { const d = window.mfp.doc; for (const p of d.children(d.root)) { const st = [p]; while (st.length) { const n = st.pop(); if (d.get(n, 'name') === ${JSON.stringify(name)}) return true; st.push(...d.children(n)); } } return false; })()`);
  }

  /** Close the window (WM_CLOSE) and measure: how long until the window disappears and the process exits. */
  async close(waitMs = 30_000): Promise<{ hiddenMs: number; exitMs: number | null }> {
    const t0 = Date.now();
    const hidden = Number(
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);'; $p = Get-Process -Id ${this.child.pid}; $h = $p.MainWindowHandle; $sw = [Diagnostics.Stopwatch]::StartNew(); $null = $p.CloseMainWindow(); while ([U.W]::IsWindowVisible($h) -and $sw.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 5 }; $sw.ElapsedMilliseconds`,
      ])
        .toString()
        .trim(),
    );
    const exitMs = await this.waitExit(waitMs, t0);
    return { hiddenMs: hidden, exitMs };
  }

  async waitExit(ms: number, from = Date.now()): Promise<number | null> {
    const end = Date.now() + ms;
    while (!this.exited && Date.now() < end) await sleep(50);
    this.ws?.close();
    return this.exited ? this.exited.at - from : null;
  }

  /** Crash: the process is killed without closing. */
  async kill() {
    this.child.kill();
    await this.waitExit(10_000);
    // WebView2 processes exit afterwards — the profile is needed by the next launch.
    await sleep(1500);
  }

  async dispose() {
    if (!this.exited) await this.kill();
  }
}

/** Kill WebView2 processes of test profiles that outlived their app (only ours, from WORK). */
function reap() {
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*mfp-e2e*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0`,
  ]);
}

function profile(name: string): string {
  reap();
  const dir = join(WORK, name);
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500']);
    }
  }
  return dir;
}

async function scenario(name: string, fn: () => Promise<string>) {
  if (only.length && !only.includes(name)) return;
  const t = Date.now();
  process.stdout.write(`… ${name}\n`);
  try {
    const details = await fn();
    results.push({ name, ok: true, details: `${details} (${((Date.now() - t) / 1000).toFixed(1)} с)` });
  } catch (e) {
    results.push({ name, ok: false, details: (e as Error).message });
  }
  // The scenario may have left the app running (failed midway): close it so the next launch doesn't go into it.
  execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process mfp-desktop -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0']);
  await sleep(1000);
  reap();
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---------- Scenarios ----------

const only = process.argv.slice(2);

async function main() {
  if (process.platform !== 'win32') {
    console.log('Проверки собранного десктопа пока только для Windows.');
    return;
  }
  if (!existsSync(EXE)) {
    console.log(`Нет сборки: ${EXE}\nСоберите: npm run build -w @mfp/desktop -- --no-bundle`);
    process.exitCode = 1;
    return;
  }
  const running = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process mfp-desktop -ErrorAction SilentlyContinue | Measure-Object).Count']).toString().trim();
  if (running !== '0') {
    console.log('Приложение уже запущено: закройте его (второй запуск ушёл бы в открытое окно).');
    process.exitCode = 1;
    return;
  }
  mkdirSync(WORK, { recursive: true });
  const exeTime = new Date(statSync(EXE).mtimeMs).toLocaleString('ru-RU');
  console.log(`Сборка: ${EXE} (${exeTime})\n`);

  await scenario('start-close', async () => {
    const app = await App.launch(profile('start-close'));
    await sleep(500);
    const t = await app.close(10_000);
    check(t.exitMs !== null, 'процесс не вышел за 10 с');
    check(t.hiddenMs < 300, `окно исчезло только через ${t.hiddenMs} мс`);
    check(app.exited!.code === 0, `код выхода ${app.exited!.code}`);
    return `окно ${t.hiddenMs} мс, выход ${t.exitMs} мс`;
  });

  await scenario('local', async () => {
    // First launch: mode selection; “On this computer” — no internet, fonts from the bundle.
    const dir = profile('local');
    const app = await App.launch(dir);
    check(await app.waitFor(`!!document.querySelector('.app-mode-dialog .mode-card')`, 10_000), 'нет окна выбора режима при первом запуске');
    await app.eval(`document.querySelector('.app-mode-dialog .mode-card').click(), 1`);
    const state = await app.eval<{ mode: string | null; local: boolean; collab: string; dialog: boolean }>(`({ mode: localStorage.getItem('mfp.mode'), local: document.body.classList.contains('app-local'), collab: getComputedStyle(document.getElementById('collab-btn')).display, dialog: !!document.querySelector('.app-mode-dialog') })`);
    check(state.mode === 'local' && state.local && !state.dialog, `режим: ${JSON.stringify(state)}`);
    check(state.collab === 'none', 'кнопка совместной работы видна на этом компьютере');
    const net = await app.eval<string>(`fetch('https://example.com/').then(() => 'прошёл', (e) => e.message)`);
    check(/Нет доступа в интернет/.test(net), `запрос в интернет: ${net}`);
    const fonts = await app.eval<Record<string, boolean>>(`(async () => { const f = window.mfp.editor.fonts; await new Promise((r) => setTimeout(r, 1500)); return { inter: f.has({ family: 'Inter', style: 'Regular' }), golos: await f.ensure({ family: 'Golos Text', style: 'Bold' }), ptItalic: await f.ensure({ family: 'PT Serif', style: 'Italic' }), lobster: await f.ensure({ family: 'Lobster', style: 'Regular' }), ui: [...document.fonts].some((x) => x.family.includes('Inter') && x.status === 'loaded') }; })()`);
    check(fonts.inter && fonts.golos && fonts.ptItalic && fonts.ui, `шрифты комплекта: ${JSON.stringify(fonts)}`);
    check(!fonts.lobster, 'шрифт не из комплекта загрузился без интернета');
    const outside = await app.eval<string[]>(`performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /^https?:/.test(n) && !/^https?:\\/\\/([a-z0-9-]+\\.)?localhost[:/]/.test(n) && !n.startsWith(location.origin))`);
    check(!outside.length, `запросы наружу: ${outside.slice(0, 3).join(', ')}`);
    await app.close();
    const again = await App.reopen(dir);
    await sleep(1500);
    const second = await again.eval<boolean>(`!!document.querySelector('.app-mode-dialog')`);
    await again.close();
    check(!second, 'окно выбора режима — и при втором запуске');
    return 'выбор режима, без интернета, Inter/Golos/PT Serif из комплекта, второй запуск без окна';
  });

  await scenario('scope', async () => {
    // Files: the page reads its own folders and files chosen by the person (here — one opened from Explorer),
    // but not other files; not even from a plugin window (an iframe without its own origin).
    const dir = profile('scope');
    const outside = join(WORK, 'scope-files');
    mkdirSync(outside, { recursive: true });
    const secret = join(outside, 'secret.txt');
    const opened = join(outside, 'открыт.mfp');
    writeFileSync(secret, 'secret');
    writeFileSync(opened, await sampleMfp());
    const app = await App.launch(dir, [opened]);
    check(await app.waitFor(`window.mfp.files.name === 'открыт' && window.mfp.doc.size > 2`, 30_000), 'файл из проводника не открылся');
    const q = JSON.stringify;
    const r = await app.eval<Record<string, string | number>>(`(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const tryIt = (p) => p.then((v) => (v && (v.byteLength ?? v.length)) ?? 'ok', (e) => String(e));
      const [docs, data] = await inv('app_dirs');
      return {
        secret: await tryIt(inv('read_file', { path: ${q(secret)} })),
        trick: await tryIt(inv('read_file', { path: docs + '\\\\..'.repeat(12) + '\\\\' + ${q(secret.slice(3))} })),
        opened: await tryIt(inv('read_file', { path: ${q(opened)} })),
        writeOut: await tryIt(inv('write_file', new Uint8Array([1]), { headers: { 'x-path': encodeURIComponent(${q(join(outside, 'new.txt'))}) } })),
        writeOwn: await tryIt(inv('write_file', new Uint8Array([1]), { headers: { 'x-path': encodeURIComponent(data + '\\\\scope-check.tmp') } })),
        data,
        list: await tryIt(inv('list_dir', { path: ${q(outside)} })),
        migrate: await inv('scope_migrate', { paths: [${q(secret)}] }),
        frame: await new Promise((done) => {
          const f = document.createElement('iframe');
          f.sandbox.add('allow-scripts');
          f.srcdoc = '<script>const i = window.__TAURI_INTERNALS__; (i ? i.invoke("read_file", { path: ' + ${q(q(opened))} + ' }).then(() => "прочитал", (e) => "отказ: " + e) : Promise.resolve("нет IPC")).then((m) => parent.postMessage({ scopeFrame: m }, "*"));<\\/script>';
          addEventListener('message', (e) => e.data && e.data.scopeFrame && (done(e.data.scopeFrame), f.remove()));
          setTimeout(() => done('нет ответа'), 5000);
          document.body.append(f);
        }),
      };
    })()`);
    await app.close();
    rmSync(join(String(r.data), 'scope-check.tmp'), { force: true });
    check(/Нет доступа/.test(String(r.secret)), `чужой файл прочитан: ${r.secret}`);
    check(/Нет доступа/.test(String(r.trick)), `обход через «..»: ${r.trick}`);
    check(typeof r.opened === 'number' && r.opened > 0, `открытый файл не читается: ${r.opened}`);
    check(/Нет доступа/.test(String(r.writeOut)), `запись в чужую папку: ${r.writeOut}`);
    check(r.writeOwn === 'ok', `запись в свою папку: ${r.writeOwn}`);
    check(/Нет доступа/.test(String(r.list)), `чужая папка прочитана: ${r.list}`);
    check(r.migrate === 0, 'не документ принят переходом со старой версии');
    check(r.frame !== 'прочитал', 'окно плагина прочитало файл');
    return `чужие файлы и папки закрыты, открытый — читается; окно плагина: ${r.frame}`;
  });

  await scenario('company', async () => {
    // Employee app: mfp-company.json next to the program — the company server, no internet.
    const file = join(dirname(EXE), 'mfp-company.json');
    check(!existsSync(file), `рядом с программой уже есть ${file}`);
    writeFileSync(file, JSON.stringify({ server: 'https://mfp.company.invalid', network: 'off' }));
    try {
      const app = await App.launch(profile('company'));
      await sleep(1500);
      const s = await app.eval<{ mode: string | null; base: string; dialog: boolean; local: boolean; net: string }>(
        `(async () => ({ mode: localStorage.getItem('mfp.mode'), base: localStorage.getItem('mfp-server'), dialog: !!document.querySelector('.app-mode-dialog'), local: document.body.classList.contains('app-local'), net: await fetch('https://example.com/').then(() => 'прошёл', (e) => e.message) }))()`,
      );
      await app.close();
      check(s.mode === 'server' && !s.local, `режим: ${JSON.stringify(s)}`);
      check(s.base === 'https://mfp.company.invalid', `сервер: ${s.base}`);
      check(!s.dialog, 'окно выбора режима при настройках компании');
      check(/запрещён в вашей организации/.test(s.net), `интернет: ${s.net}`);
      return 'сервер компании из файла, без окна выбора, интернет запрещён';
    } finally {
      rmSync(file, { force: true });
    }
  });

  await scenario('update', async () => {
    // Update check from the company server over http (latest.json in Tauri format): the version is visible.
    const server = createServer((req, res) => {
      if (req.url === '/updates/latest.json')
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '9.9.9', notes: 'проверка', pub_date: '2026-10-20T12:00:00Z', platforms: { 'windows-x86_64': { url: 'http://127.0.0.2/updates/x.exe', signature: 'x' } } }));
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.2', r));
    const endpoint = `http://127.0.0.2:${(server.address() as AddressInfo).port}/updates/latest.json`;
    try {
      const app = await App.launch(profile('update'));
      const found = await app.eval<{ version: string; notes: string } | null>(`window.__TAURI_INTERNALS__.invoke('update_check', { endpoint: ${JSON.stringify(endpoint)} })`);
      const missing = await app.eval<string>(`window.__TAURI_INTERNALS__.invoke('update_check', { endpoint: ${JSON.stringify(endpoint.replace('latest.json', 'none.json'))} }).then(() => 'нет ошибки', (e) => String(e))`);
      await app.close();
      check(found?.version === '9.9.9' && found.notes === 'проверка', `проверка обновления: ${JSON.stringify(found)}`);
      check(missing !== 'нет ошибки', 'нет latest.json — а ошибки нет');
      return 'версия 9.9.9 найдена на http-сервере компании, нет файла — ошибка';
    } finally {
      server.close();
    }
  });

  await scenario('office', async () => {
    // “Share with colleagues on the network”: server from the office folder, initial setup, editor for the browser,
    // stop — and the server doesn't outlive the app (Job Object).
    type Info = { running: boolean; port: number; setupCode: string | null; addresses: string[] };
    const up = async (base: string, want: boolean) => {
      for (let i = 0; i < 80; i++) {
        const ok = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false);
        if (ok === want) return true;
        await sleep(250);
      }
      return false;
    };
    const app = await App.launch(profile('office'));
    const info = await app.eval<Info>(`window.__TAURI_INTERNALS__.invoke('office_start', { port: 18686 })`);
    check(info.running && info.port >= 18686, `запуск: ${JSON.stringify(info)}`);
    const base = `http://127.0.0.1:${info.port}`;
    check(await up(base, true), 'сервер не ответил за 20 с');
    let code: string | null = null;
    for (let i = 0; i < 20 && !code; i++) {
      code = (await app.eval<Info>(`window.__TAURI_INTERNALS__.invoke('office_status')`)).setupCode;
      if (!code) await sleep(250);
    }
    check(code && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `код первой настройки: ${code}`);
    const page = await fetch(`${base}/`).then((r) => r.status);
    const font = await fetch(`${base}/fonts/catalog.json`).then((r) => r.status);
    const upscaler = await fetch(`${base}/upscaler/`).then((r) => r.headers.get('content-type') ?? '');
    check(page === 200 && font === 200, `редактор для браузера: страница ${page}, шрифты ${font}`);
    const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, login: 'owner', name: 'Владелец', password: 'Office-check-pass-1' }) });
    check(setup.ok, `первая настройка: ${setup.status}`);
    await app.eval(`window.__TAURI_INTERNALS__.invoke('office_stop')`);
    check(await up(base, false), 'после «Закрыть доступ» сервер отвечает');
    // Open again — data is in place (the account exists, no setup needed); then kill the app.
    const again = await app.eval<Info>(`window.__TAURI_INTERNALS__.invoke('office_start', { port: 18686 })`);
    const base2 = `http://127.0.0.1:${again.port}`;
    check(await up(base2, true), 'второй запуск не ответил');
    const config = (await (await fetch(`${base2}/api/auth/config`)).json()) as { setup?: boolean };
    check(!config.setup, 'после перезапуска сервер снова просит первую настройку');
    await app.kill();
    check(await up(base2, false), 'сервер пережил приложение');
    return `порт ${info.port}, первая настройка, редактор для браузера (апскейлер — ${/html/.test(upscaler) ? 'нет' : 'есть'}), остановка, данные после перезапуска, сервер умирает с приложением`;
  });

  await scenario('edit-close', async () => {
    const dir = profile('edit-close');
    const app = await App.launch(dir);
    await app.edit('до закрытия');
    const state = `JSON.stringify({ file: window.mfp.files.current?.id, size: window.mfp.doc.size })`;
    const before = await app.eval<string>(state);
    const t = await app.close(15_000);
    check(t.exitMs !== null, 'процесс не вышел');
    const again = await App.reopen(dir);
    const ok = await again.waitFor(`(() => { const d = window.mfp.doc; return d.size > 2; })()`, 10_000).then(() => again.has('до закрытия'));
    const after = await again.eval<string>(state);
    await again.close();
    check(ok, `правка, сделанная прямо перед закрытием, не сохранилась (до: ${before}, после: ${after}, журнал: ${[...app.logs, ...again.logs].slice(0, 3).join(' | ')})`);
    return `выход ${t.exitMs} мс, правка на месте`;
  });

  await scenario('crash', async () => {
    const dir = profile('crash');
    const app = await App.launch(dir);
    await app.edit('первая');
    // First snapshot: subsequent edits go to the journal.
    check(await app.waitFor('window.mfp.files.autosave.canJournal', 15_000), 'нет снимка рабочей копии за 15 с');
    await app.edit('после снимка');
    await sleep(900);
    await app.kill();
    const again = await App.reopen(dir);
    await again.waitFor('window.mfp.doc.size > 3', 10_000);
    const first = await again.has('первая');
    const second = await again.has('после снимка');
    await again.close();
    check(first && second, `после сбоя: «первая» ${first ? 'есть' : 'нет'}, «после снимка» ${second ? 'есть' : 'нет'}`);
    return 'правка за 0,9 с до сбоя восстановлена из журнала';
  });

  await scenario('hang', async () => {
    const app = await App.launch(profile('hang'));
    await app.send('Runtime.evaluate', { expression: 'setTimeout(() => { const t = Date.now(); while (Date.now() - t < 120000); }, 300); 1' });
    await sleep(700);
    const t = await app.close(40_000);
    check(t.hiddenMs < 300, `окно исчезло только через ${t.hiddenMs} мс`);
    check(t.exitMs !== null && t.exitMs < 30_000, `сторож не закрыл приложение (${t.exitMs} мс)`);
    return `окно ${t.hiddenMs} мс, сторож — ${(t.exitMs! / 1000).toFixed(1)} с`;
  });

  await scenario('save-fail', async () => {
    const app = await App.launch(profile('save-fail'));
    await app.eval('window.mfp.files.leave = async () => false; 1');
    execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${app.child.pid} -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() }`]);
    await sleep(2500);
    const visible = await app.eval<boolean>(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' })`);
    check(!app.exited && visible, 'окно не вернулось с вопросом');
    // “Yes” in the question dialog. It's a TaskDialog: its buttons have no UI Automation invoke pattern,
    // a mouse click depends on display scaling, keys depend on focus. Reliable: send TDM_CLICK_BUTTON to the
    // question window (its handle via UI Automation). The “Yes” button id is unknown: IDOK, IDYES,
    // the first custom button — in turn, until the question window closes.
    const press = [
      'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
      'Add-Type -Name M -Namespace U -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, int m, System.IntPtr w, System.IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);\'',
      '$A = [System.Windows.Automation.AutomationElement]',
      '$yes = [string]([char]0x0414) + [char]0x0430',
      'for ($i = 0; $i -lt 20; $i++) {',
      `  $wins = $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${app.child.pid})))`,
      '  foreach ($w in $wins) {',
      '    $dlgs = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)))',
      '    foreach ($d in $dlgs) {',
      '      if (-not $d.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $yes)))) { continue }',
      '      $h = [System.IntPtr]$d.Current.NativeWindowHandle',
      '      foreach ($id in 1, 6, 100) {',
      '        [U.M]::SendMessage($h, 0x466, [System.IntPtr]$id, [System.IntPtr]::Zero) | Out-Null',
      '        Start-Sleep -Milliseconds 400',
      '        if (-not [U.M]::IsWindow($h)) { "pressed"; exit 0 }',
      '      }',
      '      "stuck"; exit 0',
      '    }',
      '  }',
      '  Start-Sleep -Milliseconds 250',
      '}',
      '"none"',
    ].join('\n');
    const script = join(WORK, 'press-yes.ps1');
    writeFileSync(script, press);
    const pressed = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]).toString().trim();
    check(pressed === 'pressed', pressed === 'stuck' ? 'окно вопроса не закрылось кнопкой «Да»' : 'нет окна вопроса');
    const exit = await app.waitExit(15_000);
    check(exit !== null, 'после ответа «Да» приложение не закрылось');
    return 'окно вернулось с вопросом, после ответа — закрылось';
  });

  // Files of all formats: open without errors, all images in place.
  const samples = join(WORK, 'samples');
  mkdirSync(samples, { recursive: true });
  const files: string[] = [];
  writeFileSync(join(samples, 'проверка.pdf'), samplePdf());
  writeFileSync(join(samples, 'проверка.sketch'), sampleSketch());
  writeFileSync(join(samples, 'проверка.mfp'), await sampleMfp());
  files.push(...['проверка.pdf', 'проверка.sketch', 'проверка.mfp'].map((f) => join(samples, f)));
  const fixtures = join(ROOT, 'fixtures');
  if (existsSync(fixtures)) {
    for (const f of readdirSync(fixtures)) {
      const p = join(fixtures, f);
      if (/\.(fig|mfp|sketch|pdf)$/i.test(f) && statSync(p).size < 1e9) files.push(p);
    }
  }
  for (const file of files) {
    const short = file.replace(/^.*[\\/]/, '');
    await scenario(`open ${short}`, async () => {
      const app = await App.launch(profile('open'), [file]);
      const base = short.replace(/\.[^.]+$/, '');
      const loaded = await app.waitFor(`window.mfp.files.name === ${JSON.stringify(base)} && window.mfp.doc.size > 2`, 120_000);
      check(loaded, 'файл не открылся за 2 минуты');
      await app.waitFor('!window.mfp.editor.importing', 120_000);
      await sleep(4000);
      const size = await app.eval<number>('window.mfp.doc.size');
      const errors = app.logs.slice();
      const failures = app.imageFailures;
      const t = await app.close(180_000);
      check(!errors.length, `ошибки в консоли: ${errors.slice(0, 3).join(' | ')}`);
      check(!failures, `не загрузилось картинок: ${failures}`);
      check(t.exitMs !== null, 'не закрылось');
      return `узлов ${size}, закрытие ${(t.exitMs! / 1000).toFixed(1)} с`;
    });
  }

  // Large file: import, edit, close (first snapshot; images from the .fig, background download), relaunch from
  // the working copy, edit, close (journal only — fast), launch again — both edits are in place.
  const big = join(fixtures, 'Untitled.fig');
  if (existsSync(big)) {
    await scenario('big', async () => {
      const dir = profile('big');
      const app = await App.launch(dir, [big]);
      check(await app.waitFor(`window.mfp.files.name === 'Untitled' && window.mfp.doc.size > 1000`, 60_000), 'Untitled не открылся');
      await app.edit('большой 1');
      const first = await app.close(180_000);
      check(first.exitMs !== null, 'первое закрытие не закончилось за 3 минуты');
      const second = await App.reopen(dir);
      check(await second.waitFor(`window.mfp.files.name === 'Untitled' && window.mfp.doc.size > 1000`, 60_000), 'Untitled не открылся из рабочей копии');
      check(await second.has('большой 1'), 'первая правка потерялась');
      await second.edit('большой 2');
      await sleep(1000);
      const quick = await second.close(60_000);
      check(quick.exitMs !== null, 'второе закрытие не закончилось');
      const third = await App.reopen(dir);
      check(await third.waitFor(`window.mfp.files.name === 'Untitled' && window.mfp.doc.size > 1000`, 60_000), 'Untitled не открылся в третий раз');
      const both = (await third.has('большой 1')) && (await third.has('большой 2'));
      await third.waitFor('!window.mfp.editor.importing', 60_000);
      await sleep(5000);
      const failures = third.imageFailures;
      await third.close(60_000);
      check(both, 'правки второго сеанса нет');
      check(!failures, `не загрузилось картинок: ${failures}`);
      return `первое закрытие ${(first.exitMs! / 1000).toFixed(1)} с (снимок; картинки импорта — в фоне), второе — ${(quick.exitMs! / 1000).toFixed(1)} с (журнал)`;
    });

    await scenario('second-launch', async () => {
      // The big profile already has Untitled: a second launch during close brings back the window.
      const dir = join(WORK, 'big');
      check(existsSync(dir), 'сначала сценарий big');
      const app = await App.reopen(dir);
      await app.waitFor('window.mfp.doc.size > 1000', 60_000);
      await app.edit('второй запуск');
      // Closing with a journal takes a fraction of a second: stretch the write so the second launch lands during it.
      await app.eval('(() => { const leave = window.mfp.files.leave.bind(window.mfp.files); window.mfp.files.leave = async () => { await new Promise((r) => setTimeout(r, 5000)); return leave(); }; return 1; })()');
      execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${app.child.pid} -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() }`]);
      await sleep(200);
      const second = spawn(EXE, [], { env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: dir }, stdio: 'ignore' });
      await new Promise((r) => second.on('exit', r));
      const back = await app.waitFor(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' })`, 15_000);
      check(back && !app.exited, 'окно не вернулось');
      const t = await app.close(60_000);
      check(t.exitMs !== null, 'после возврата не закрылось');
      return 'окно вернулось, потом закрылось';
    });
  }

  // ---------- Summary ----------
  console.log('');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(28)} ${r.details}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} из ${results.length} сценариев прошли.`);
  if (failed) process.exitCode = 1;
}

await main();
// A failed scenario may have left a debug connection or a child process — don't hang after the summary.
process.exit(process.exitCode ?? 0);
