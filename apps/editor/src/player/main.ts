// Prototype presentation tab (and the preview window in the editor — the same page in an iframe,
// &embed). The document, images and edits come from the editor tab via BroadcastChannel
// (protocol.ts); on edits in the editor the presentation is rebuilt on the same screen. Keys: R —
// restart, ← / Backspace — back, F — fullscreen, H — highlight hotspots, 0 — 100% / fit,
// C — screen comments (comments.ts). “● Record” — records a prototype walkthrough to video (recorder.ts).

import '../ui/tokens.css';
import { network } from '../network.ts';
// Full CanvasKit build: it includes Skottie (Lottie in fills).
import CanvasKitInit from 'canvaskit-wasm/full';
import wasmUrl from 'canvaskit-wasm/bin/full/canvaskit.wasm?url';
import { Document, flowsOf } from '@mfp/core';
import { FontLibrary } from '@mfp/renderer';
import { PlayerComments } from './comments.ts';
import { Player } from './player.ts';
import { channelName, type ToEditor, type ToPlayer } from './protocol.ts';
import { GIF_LIMIT_S, RECORD_FORMATS, Recorder, defaultVideoFormat, type RecordFormat } from './recorder.ts';

const params = new URLSearchParams(location.search);
const token = params.get('player') ?? '';
const embed = params.has('embed');
const me = Math.random().toString(36).slice(2, 10);

document.title = 'Показ — MFP';
document.body.replaceChildren();
const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; height: 100%; background: var(--bg, #17191f); color: var(--text, #eceef2); font: 12px/1.4 Inter, system-ui, sans-serif; overflow: hidden; }
  #player { position: fixed; left: 0; top: 0; width: 100%; height: calc(100% - 44px); display: block; outline: none; touch-action: none; }
  body.full #player, body.embed #player { height: 100%; }
  .pbar { position: fixed; left: 0; right: 0; bottom: 0; height: 44px; display: flex; align-items: center; gap: 6px; padding: 0 12px; background: var(--panel, #22242a); border-top: 1px solid var(--line, #00000080); box-sizing: border-box; }
  :root[data-ui='classic'] .pbar, :root[data-contrast] .pbar { border-top-color: #00000080; }
  body.full .pbar, body.embed .pbar { display: none; }
  .pbar .title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-2, #c7c7c7); }
  .pbar button, .pbar select { height: 28px; padding: 0 10px; border: none; border-radius: 6px; background: var(--panel-2, #383838); color: var(--text, #eceef2); cursor: pointer; font: inherit; }
  .pbar button:hover, .pbar select:hover { background: var(--panel-3, #444); }
  .pbar button.on { background: var(--accent, #4d7bfd); color: #fff; }
  .pbar button.rec { background: #e5484d; }
  .pbar button:disabled { opacity: 0.6; cursor: default; }
  .ptoast { position: fixed; left: 50%; bottom: 56px; transform: translateX(-50%); max-width: 80%; padding: 8px 14px; border-radius: 8px; background: var(--panel-2, #383838); color: var(--text, #eceef2); box-shadow: 0 4px 16px #0006; }
  .p-input { position: fixed; z-index: 5; margin: 0; padding: 0; border: none; outline: none; background: transparent; resize: none; overflow: hidden; line-height: 1.25; }
  .p-input::placeholder { color: inherit; opacity: 0.45; }
  .pmsg { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: var(--text-2, #c7c7c7); }
`;
document.head.append(style);
document.body.classList.toggle('embed', embed);

const message = (text: string) => {
  const msg = document.createElement('div');
  msg.className = 'pmsg';
  msg.textContent = text;
  document.body.append(msg);
  return msg;
};

if (!token) message('Показ открывается из редактора: кнопка ▷ справа вверху, Ctrl+Alt+Enter или Shift+Space.');
else await start();

async function start() {
  const channel = new BroadcastChannel(channelName(token));
  const send = (m: ToEditor) => channel.postMessage(m);
  let nextImage = 1;
  const imageWaits = new Map<number, (b: Uint8Array | undefined) => void>();
  let docWait: ((m: Extract<ToPlayer, { type: 'doc' }>) => void) | null = null;
  let onChanged: () => void = () => {};
  let comments: PlayerComments | null = null;
  channel.onmessage = (ev: MessageEvent<ToPlayer>) => {
    const m = ev.data;
    if (m.type === 'changed') onChanged();
    else if (m.type === 'commentsChanged') comments?.changed();
    else if (m.to !== me) return;
    else if (m.type === 'comments') comments?.receive(m);
    else if (m.type === 'doc') docWait?.(m);
    else if (m.type === 'image') {
      imageWaits.get(m.id)?.(m.bytes ?? undefined);
      imageWaits.delete(m.id);
    }
  };
  window.addEventListener('pagehide', () => send({ type: 'bye', from: me }));
  let page = params.get('page');
  /** Document from the editor (null — the editor didn't respond: closed or reloaded). */
  const requestDoc = () =>
    new Promise<Extract<ToPlayer, { type: 'doc' }> | null>((resolve) => {
      const t = setTimeout(() => {
        docWait = null;
        resolve(null);
      }, 5000);
      docWait = (m) => {
        clearTimeout(t);
        docWait = null;
        resolve(m);
      };
      send({ type: 'hello', from: me, page });
    });
  const images = {
    readImage: (hash: string) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        const id = nextImage++;
        const t = setTimeout(() => {
          imageWaits.delete(id);
          resolve(undefined);
        }, 15000);
        imageWaits.set(id, (b) => {
          clearTimeout(t);
          resolve(b);
        });
        send({ type: 'image', from: me, id, hash });
      }),
  };

  const [first, ck] = await Promise.all([requestDoc(), CanvasKitInit({ locateFile: () => wasmUrl })]);
  if (!first) {
    message('Редактор, из которого открыт показ, закрыт или перезагружен. Откройте показ из редактора ещё раз.');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.id = 'player';
  canvas.tabIndex = 0;
  const bar = document.createElement('div');
  bar.className = 'pbar';
  document.body.append(canvas, bar);
  const fonts = new FontLibrary(ck);
  // Fonts come from the bundle; the online catalog only if allowed (as in the editor).
  fonts.useBundled('/fonts');
  fonts.offline = () => !network.allowed;
  void restoreFonts(fonts);
  let player: Player | null = null;
  let tabVisible = true;
  window.addEventListener('message', (e) => {
    if (window.parent === window || e.source !== window.parent || e.origin !== location.origin || e.data?.type !== 'mfp-player-visible') return;
    tabVisible = e.data.visible === true;
    player?.setSuspended(!tabVisible);
  });
  if (window.parent !== window) window.parent.postMessage({ type: 'mfp-player-ready' }, location.origin);
  window.addEventListener('keydown', (e) => {
    if (window.parent === window || !(e.ctrlKey || e.metaKey) || e.altKey || !(e.key === 'Tab' || e.code === 'KeyW')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    window.parent.postMessage({ type: 'mfp-tab-key', key: e.key === 'Tab' ? 'Tab' : 'w', shift: e.shiftKey }, location.origin);
  }, true);
  let hotspots = false;
  let zoom: 'fit' | 'actual' = 'fit';
  // Device frame: whether to show it (remembered in the browser).
  let frame = true;
  try {
    frame = params.get('frame') !== '0' && localStorage.getItem('mfp.player.frame') !== '0';
  } catch {
    // Storage unavailable — frame on by default.
  }
  let name = first.name;

  const title = document.createElement('div');
  title.className = 'title';
  const flowSel = document.createElement('select');
  flowSel.title = 'Поток';
  const btn = (label: string, hint: string, run: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = hint;
    b.addEventListener('click', () => {
      run();
      canvas.focus();
    });
    return b;
  };
  const restart = () => player?.restart(flowSel.value || params.get('start') || undefined);
  const toggleHotspots = () => {
    hotspots = !hotspots;
    if (player) player.hotspots = hotspots;
    hotBtn.classList.toggle('on', hotspots);
    player?.flashHotspots();
  };
  const toggleZoom = () => {
    zoom = zoom === 'fit' ? 'actual' : 'fit';
    if (player) player.zoom = zoom;
    zoomBtn.textContent = zoom === 'fit' ? 'Вписать' : '100%';
  };
  const toggleFrame = () => {
    frame = !frame;
    if (player) player.frame = frame;
    frameBtn.classList.toggle('on', frame);
    try {
      localStorage.setItem('mfp.player.frame', frame ? '1' : '0');
    } catch {
      // Not remembered — no big deal.
    }
  };
  const fullscreen = () => void document.documentElement.requestFullscreen?.().catch(() => {});
  const backBtn = btn('← Назад', 'Назад (← или Backspace)', () => player?.session.back());
  const restartBtn = btn('↺ Сначала', 'Начать сначала (R)', restart);
  const hotBtn = btn('Активные зоны', 'Подсвечивать активные зоны (H)', toggleHotspots);
  const zoomBtn = btn('Вписать', 'Масштаб: вписать / 100% (0)', toggleZoom);
  const frameBtn = btn('Рамка', 'Рамка устройства (D) — у готового устройства страницы', toggleFrame);
  frameBtn.classList.toggle('on', frame);
  const fullBtn = btn('Во весь экран', 'Во весь экран (F)', fullscreen);
  const commentsBtn = btn('Комментарии', 'Комментарии к экранам (C)', () => comments?.toggle());
  // Walkthrough recording: format and button (while recording it shows the time; click stops and saves the file).
  const recFormat = document.createElement('select');
  recFormat.title = 'Формат записи';
  const videoOk = typeof VideoEncoder !== 'undefined';
  recFormat.append(...RECORD_FORMATS.filter((x) => videoOk || x.format === 'gif').map((x) => Object.assign(document.createElement('option'), { value: x.format, textContent: x.label })));
  void defaultVideoFormat().then((fmt) => (recFormat.value = fmt));
  let recorder: Recorder | null = null;
  let recClock: ReturnType<typeof setInterval> | null = null;
  const toast = (text: string) => {
    const t = Object.assign(document.createElement('div'), { className: 'ptoast', textContent: text });
    document.body.append(t);
    setTimeout(() => t.remove(), 5000);
  };
  const save = (bytes: Uint8Array, file: string, mime: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const toggleRecord = async () => {
    if (recorder) {
      const r = recorder;
      recorder = null;
      if (recClock) clearInterval(recClock);
      recBtn.textContent = 'Сохраняю…';
      recBtn.disabled = true;
      try {
        const { bytes, mime, ext } = await r.stop();
        save(bytes, `${name} — проход.${ext}`, mime);
        toast(`Запись сохранена: ${(bytes.length / 2 ** 20).toFixed(1)} МБ`);
      } catch (e) {
        toast(`Запись не сохранилась: ${(e as Error).message}`);
      } finally {
        recBtn.disabled = false;
        recBtn.textContent = '● Запись';
        recBtn.classList.remove('rec');
        recFormat.disabled = false;
      }
      return;
    }
    try {
      recorder = await Recorder.start(canvas, recFormat.value as RecordFormat);
    } catch (e) {
      toast(`Запись не началась: ${(e as Error).message}`);
      return;
    }
    player?.redraw();
    recBtn.classList.add('rec');
    recFormat.disabled = true;
    const tick = () => {
      const r = recorder;
      if (!r) return;
      const sec = Math.floor(r.seconds);
      recBtn.textContent = `■ ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      if (r.error || (r.format === 'gif' && sec >= GIF_LIMIT_S)) void toggleRecord();
    };
    tick();
    recClock = setInterval(tick, 250);
  };
  const recBtn = btn('● Запись', 'Записать проход прототипа в видео: щелчок — начать, ещё щелчок — сохранить', () => void toggleRecord());
  // Taps shown as circles in the recording (in canvas pixels).
  canvas.addEventListener('pointerdown', (e) => {
    const box = canvas.getBoundingClientRect();
    recorder?.tap(((e.clientX - box.left) * canvas.width) / box.width, ((e.clientY - box.top) * canvas.height) / box.height);
  });
  bar.append(title, flowSel, backBtn, restartBtn, hotBtn, zoomBtn, frameBtn, commentsBtn, recFormat, recBtn, fullBtn);
  comments = new PlayerComments(send, me, () => player, commentsBtn);
  flowSel.addEventListener('change', () => player?.restart(flowSel.value || undefined));

  const showTitle = (screen: string | null) => {
    comments?.setScreen(screen);
    const doc = player?.doc;
    const s = screen && doc?.has(screen) ? doc.get(screen, 'name') : '';
    title.textContent = s ? `${name} — ${s}` : name;
    document.title = s ? `${s} — показ` : 'Показ — MFP';
  };

  /** Build the presentation from the editor's document (keep — stay on this screen if it exists). */
  const boot = (m: Extract<ToPlayer, { type: 'doc' }>, keep: string | null) => {
    page = m.page;
    name = m.name;
    const doc = Document.fromSnapshot(m.snapshot);
    const flows = flowsOf(doc, page);
    const prevFlow = flowSel.value;
    flowSel.replaceChildren(...flows.map((f) => Object.assign(document.createElement('option'), { value: f.nodeId, textContent: f.name || doc.get(f.nodeId, 'name') || 'Поток' })));
    flowSel.hidden = flows.length < 2;
    const want = keep ?? params.get('start');
    if (prevFlow && flows.some((f) => f.nodeId === prevFlow)) flowSel.value = prevFlow;
    else if (want && flows.some((f) => f.nodeId === want)) flowSel.value = want;
    player?.dispose();
    player = new Player({
      ck,
      canvas,
      doc,
      page,
      start: want && doc.has(want) ? want : null,
      images,
      fonts,
      onScreen: showTitle,
      onError: toast,
      onUrl: (url, newTab) => {
        if (/^(https?:|mailto:)/i.test(url)) window.open(url, newTab ? '_blank' : '_self', 'noopener');
      },
    });
    player.hotspots = hotspots;
    player.suspended = !tabVisible;
    player.zoom = zoom;
    player.frame = frame;
    player.onDrawn = () => recorder?.grab(canvas);
    showTitle(player.session.screen);
  };
  boot(first, null);
  // Edits in the editor: fresh document, same screen.
  let reloading = false;
  onChanged = async () => {
    if (reloading) return;
    reloading = true;
    const m = await requestDoc();
    reloading = false;
    if (m) boot(m, player?.session.screen ?? null);
  };

  window.addEventListener('keydown', (e) => {
    if (!player || e.ctrlKey || e.metaKey || e.altKey) return;
    // Typing in a prototype input field — not presentation keys.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // Prototype keys take precedence over service keys.
    if (player.key(e)) {
      e.preventDefault();
      return;
    }
    const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    if (k === 'r') restart();
    else if (k === 'arrowleft' || k === 'backspace') player.session.back();
    else if (k === 'f') fullscreen();
    else if (k === 'h') toggleHotspots();
    else if (k === 'd') toggleFrame();
    else if (k === 'c') comments?.toggle();
    else if (k === '0') toggleZoom();
    else return;
    e.preventDefault();
  });
  document.addEventListener('fullscreenchange', () => document.body.classList.toggle('full', !!document.fullscreenElement));
  canvas.focus();
  // For automated tests and debugging.
  (window as unknown as { mfpPlayer: unknown }).mfpPlayer = {
    get player() {
      return player;
    },
    get recorder() {
      return recorder;
    },
    toggleRecord,
    recFormat,
  };
}

/** Custom fonts, as in the editor: files from OPFS (fonts/) and computer fonts if access was already granted. */
async function restoreFonts(fonts: FontLibrary) {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('fonts', { create: true });
    for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemFileHandle> }).values()) {
      await fonts.addFile(await (await handle.getFile()).arrayBuffer(), handle.name.replace(/^.* — /, '').replace(/\.font$/, ''));
    }
  } catch {
    // OPFS unavailable.
  }
  try {
    const p = await navigator.permissions?.query({ name: 'local-fonts' as PermissionName });
    const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string; style: string; blob(): Promise<Blob> }[]> }).queryLocalFonts;
    if (p?.state === 'granted' && query) {
      const list = await query.call(window);
      fonts.addLocal(list.map((f) => ({ family: f.family, style: f.style, data: async () => (await f.blob()).arrayBuffer() })));
    }
  } catch {
    // No access — not needed.
  }
}
