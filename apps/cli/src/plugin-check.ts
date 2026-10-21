// mfp plugin check <folder>: checks a Figma-format plugin for compatibility with MFP.
// 1) manifest.json — fields, files, warnings;
// 2) code — which Figma APIs it mentions and which of them MFP lacks (the sandbox itself decides: same shim);
// 3) headless run on a sample document: every menu command (with parameters — from the plugin's
//    suggestions), errors, messages, document edits.
// TypeScript code is stripped of types (node:module). import / require — needs a build.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { Document } from '@mfp/core';
import { isCodegen, parseManifest, pluginCommands, PluginRuntime, type PluginBundle, type PluginEnvironment } from '@mfp/plugin-host';

export interface RunResult {
  command: string;
  /** closed — closed by itself; error — error; waiting — kept running (window or subscriptions); skipped — not run (no parameter values). */
  state: 'closed' | 'error' | 'waiting' | 'skipped';
  error: string | null;
  message: string | null;
  ui: boolean;
  notifications: string[];
  /** Document edits (operations). */
  changes: number;
  /** Codegen: what the plugin answered. */
  output?: string;
}

export interface CheckReport {
  dir: string;
  name: string;
  id: string;
  errors: string[];
  warnings: string[];
  /** APIs the plugin mentions: all of them and those missing in MFP (with mention counts). */
  apis: { used: number; missing: { name: string; count: number }[] };
  runs: RunResult[];
  /** other — the plugin is not for Figma Design (FigJam, Slides): not checked in MFP. */
  verdict: 'works' | 'partial' | 'fails' | 'other';
}

/** FigJam-only APIs: plugins for Figma and FigJam call them in FigJam — not counted for Figma Design. */
const FIGJAM_ONLY = new Set([
  'figma.createSticky',
  'figma.createShapeWithText',
  'figma.createConnector',
  'figma.createCodeBlock',
  'figma.createTable',
  'figma.createGif',
  'figma.createLinkPreviewAsync',
  'figma.getCanvasGrid',
  'figma.setCanvasGrid',
  'figma.createCanvasRow',
  'figma.createCanvasColumn',
  'figma.timer',
]);

/** Node members of the Figma Plugin API (to search in code; whether MFP has them is decided by the sandbox). */
const NODE_API = `remove setRelaunchData getRelaunchData isAsset getCSSAsync getPluginData setPluginData getPluginDataKeys getSharedPluginData
setSharedPluginData getSharedPluginDataKeys stuckNodes attachedConnectors componentPropertyReferences boundVariables inferredVariables
resolvedVariableModes explicitVariableModes setExplicitVariableModeForCollection clearExplicitVariableModeForCollection setBoundVariable
getDevResourcesAsync addDevResourceAsync editDevResourceAsync deleteDevResourceAsync setDevResourcePreviewAsync detachedInfo appendChild
insertChild findChildren findChild findAll findOne findAllWithCriteria findWidgetNodesByWidgetId constraints minWidth maxWidth minHeight
maxHeight relativeTransform absoluteTransform absoluteBoundingBox absoluteRenderBounds constrainProportions rotation layoutAlign layoutGrow
layoutPositioning resize resizeWithoutConstraints rescale layoutSizingHorizontal layoutSizingVertical targetAspectRatio lockAspectRatio
unlockAspectRatio blendMode isMask maskType effects effectStyleId setEffectStyleIdAsync fills strokes strokeWeight strokeJoin strokeAlign
dashPattern strokeCap strokeMiterLimit fillGeometry strokeGeometry outlineStroke fillStyleId strokeStyleId setFillStyleIdAsync
setStrokeStyleIdAsync cornerRadius cornerSmoothing topLeftRadius topRightRadius bottomLeftRadius bottomRightRadius exportSettings exportAsync
reactions setReactionsAsync overflowDirection numberOfFixedChildren overlayPositionType overlayBackground overlayBackgroundInteraction
layoutMode layoutWrap paddingLeft paddingRight paddingTop paddingBottom itemSpacing counterAxisSpacing primaryAxisAlignItems
counterAxisAlignItems counterAxisAlignContent primaryAxisSizingMode counterAxisSizingMode strokesIncludedInLayout itemReverseZIndex clipsContent
guides layoutGrids gridStyleId setGridStyleIdAsync inferredAutoLayout characters fontName fontSize fontWeight textAlignHorizontal
textAlignVertical textAutoResize textTruncation maxLines paragraphIndent paragraphSpacing listSpacing hangingPunctuation hangingList textCase
textDecoration letterSpacing lineHeight leadingTrim hyperlink textStyleId setTextStyleIdAsync hasMissingFont autoRename insertCharacters
deleteCharacters getStyledTextSegments getRangeFontSize setRangeFontSize getRangeFontName setRangeFontName getRangeFills setRangeFills
getRangeTextStyleId setRangeTextStyleIdAsync getRangeListOptions setRangeListOptions getRangeHyperlink setRangeHyperlink getRangeBoundVariable
setRangeBoundVariable textPathStartData vectorNetwork setVectorNetworkAsync vectorPaths handleMirroring createInstance getInstancesAsync
instances documentationLinks componentPropertyDefinitions addComponentProperty editComponentProperty deleteComponentProperty
getPublishStatusAsync mainComponent getMainComponentAsync swapComponent setProperties componentProperties detachInstance resetOverrides
scaleFactor exposedInstances isExposedInstance booleanOperation expanded pointCount innerRadius arcData selection backgrounds
flowStartingPoints prototypeStartNode prototypeBackgrounds selectedTextRange loadAsync devStatus annotations clone`.split(/\s+/);

/** Package from a folder: manifest, code (TypeScript — without types), UI. */
export function loadBundle(dir: string): { bundle: PluginBundle | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
  const raw = read('manifest.json');
  if (raw === null) return { bundle: null, errors: ['нет manifest.json'], warnings };
  let parsed: ReturnType<typeof parseManifest>;
  try {
    parsed = parseManifest(JSON.parse(raw));
  } catch (e) {
    return { bundle: null, errors: [(e as Error).message], warnings };
  }
  const { manifest } = parsed;
  warnings.push(...parsed.warnings);
  let code = read(manifest.main);
  let main = manifest.main;
  // No built file — the source is next to it (TypeScript or src / plugin-src folders).
  if (code === null && /\.js$/.test(main)) {
    const base = main.replace(/^(dist|build|out)\//, '').replace(/\.js$/, '');
    for (const alt of [main.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.js`, 'code.ts', `src/${base}.ts`, `src/${base}.js`, `plugin-src/${base}.ts`, `plugin-src/${base}.js`, 'src/main.ts', 'plugin-src/main.ts']) {
      const c = read(alt);
      if (c !== null) {
        code = c;
        main = alt;
        warnings.push(`${manifest.main} нет — взят исходник ${alt}`);
        break;
      }
    }
  }
  if (code === null) return { bundle: null, errors: [`нет файла ${manifest.main} (плагин не собран?)`], warnings };
  if (/\.tsx?$/.test(main)) {
    try {
      // transform — enum / namespace too; without that mode — types only.
      try {
        code = stripTypeScriptTypes(code, { mode: 'transform' } as unknown as Parameters<typeof stripTypeScriptTypes>[1]);
      } catch {
        code = stripTypeScriptTypes(code);
      }
    } catch (e) {
      return { bundle: null, errors: [`TypeScript: ${(e as Error).message.split('\n')[0]}`], warnings };
    }
  }
  if (/^\s*(import\s[^(]|export\s)/m.test(code) || /\brequire\(\s*['"]/.test(code)) warnings.push('в коде import / require — нужна сборка в один файл (как и для Figma)');
  let html: string | undefined;
  let uiFiles: Record<string, string> | undefined;
  if (typeof manifest.ui === 'string') {
    const ui = read(manifest.ui);
    if (ui === null) warnings.push(`нет файла окна ${manifest.ui}`);
    else html = ui;
  } else if (manifest.ui && typeof manifest.ui === 'object') {
    uiFiles = {};
    for (const [k, file] of Object.entries(manifest.ui)) {
      const ui = read(String(file));
      if (ui === null) warnings.push(`нет файла окна ${file}`);
      else uiFiles[k] = ui;
    }
  }
  return { bundle: { manifest, code, html, ...(uiFiles ? { uiFiles } : {}) }, errors, warnings };
}

/** API mentions in code: figma.x.y and node members from the list. */
export function scanApi(code: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const m of code.matchAll(/(?<![\w$.])figma\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    const sub = m[2] && ['ui', 'viewport', 'clientStorage', 'variables', 'util', 'codegen', 'parameters', 'annotations', 'teamLibrary', 'payments', 'textreview', 'timer'].includes(m[1]!) ? `.${m[2]}` : '';
    add(`figma.${m[1]}${sub}`);
  }
  const names = new Set(NODE_API);
  for (const m of code.matchAll(/\.([A-Za-z_$][\w$]*)\b/g)) if (names.has(m[1]!)) add(`node.${m[1]}`);
  return out;
}

/** Sample document: a page with a frame, text, shapes, a component and an instance. */
function sampleEnv() {
  const doc = new Document({ clientId: 7 });
  const page = doc.create('PAGE', doc.root, { name: 'Page 1' });
  const frame = doc.create('FRAME', page, { name: 'Frame', width: 320, height: 200, transform: [1, 0, 0, 0, 1, 0], fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] });
  doc.create('RECTANGLE', frame, { name: 'Rectangle', width: 100, height: 60, transform: [1, 0, 20, 0, 1, 20], fills: [{ type: 'SOLID', color: { r: 0.9, g: 0.3, b: 0.2 } }] });
  doc.create('TEXT', frame, { name: 'Text', characters: 'Hello', width: 80, height: 20, transform: [1, 0, 20, 0, 1, 100] });
  doc.create('ELLIPSE', page, { name: 'Ellipse', width: 50, height: 50, transform: [1, 0, 400, 0, 1, 0] });
  const comp = doc.create('COMPONENT', page, { name: 'Button', width: 120, height: 40, transform: [1, 0, 0, 0, 1, 300] });
  doc.create('RECTANGLE', comp, { name: 'Bg', width: 120, height: 40 });
  let selection = [frame];
  let current = page;
  const notes: string[] = [];
  const state = { ui: false };
  const storage = new Map<string, unknown>();
  const env: PluginEnvironment = {
    doc,
    getCurrentPage: () => current,
    setCurrentPage: (id) => (current = id),
    getSelection: () => selection,
    setSelection: (ids) => (selection = ids),
    notify: (m) => notes.push(m),
    showUI: () => (state.ui = true),
    postToUI: () => {},
    setUIVisible: () => {},
    resizeUI: () => {},
    closeUI: () => {},
    viewport: { center: () => ({ x: 160, y: 100 }), zoom: () => 1, bounds: () => ({ x: -340, y: -300, width: 1000, height: 800 }), setCenter: () => {}, setZoom: () => {}, scrollAndZoomIntoView: () => {} },
    storage: { get: async (k) => storage.get(k), set: async (k, v) => void storage.set(k, v), delete: async (k) => void storage.delete(k), keys: async () => [...storage.keys()] },
    log: () => {},
    // No network needed during the check: the answer is “no connection”.
    fetch: (async () => {
      throw new Error('сеть при проверке отключена');
    }) as typeof fetch,
    exportNode: async (_id, s) => (s.format === 'SVG_STRING' ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : new Uint8Array([137, 80, 78, 71])),
  };
  let changes = 0;
  doc.onChange((ops) => (changes += ops.length));
  return { env, notes, state, changes: () => changes };
}

/** Which API paths exist in the MFP sandbox (figma.x, figma.ui.y, node.z). */
async function supported(paths: string[]): Promise<Set<string>> {
  const { env, notes } = sampleEnv();
  const { manifest } = parseManifest({ name: 'probe', id: 'probe', api: '1.0.0', main: 'code.js' });
  const code = `
    const paths = ${JSON.stringify(paths)};
    const page = figma.currentPage;
    const nodes = [page, figma.createRectangle(), figma.createEllipse(), figma.createPolygon(), figma.createStar(), figma.createVector(),
      figma.createText(), figma.createFrame(), figma.createComponent(), figma.createLine()];
    nodes.push(nodes[8].createInstance());
    nodes.push(figma.union([figma.createRectangle(), figma.createEllipse()], page));
    const ok = paths.filter((p) => {
      try {
        if (p.startsWith('node.')) { const k = p.slice(5); return nodes.some((n) => k in n); }
        const parts = p.split('.');
        let v = globalThis;
        for (const k of parts.slice(0, -1)) { if (v === null || v === undefined) return false; v = v[k]; }
        return v !== null && v !== undefined && parts[parts.length - 1] in Object(v);
      } catch (e) { return false; }
    });
    figma.notify(JSON.stringify(ok));
    figma.closePlugin();`;
  const rt = await PluginRuntime.start({ manifest, code }, env);
  if (rt.error) throw new Error(`Проба API: ${rt.error}`);
  return new Set(JSON.parse(notes[0] ?? '[]') as string[]);
}

/** Codegen plugin: code for the sample frame in each language. */
async function runCodegen(bundle: PluginBundle, timeoutMs: number): Promise<RunResult[]> {
  const { env, notes, changes, state } = sampleEnv();
  const answers = new Map<number, { results: unknown; error: string | null }>();
  Object.assign(env, { editorType: 'dev', mode: 'codegen', codegenResult: (id: number, results: unknown, error: string | null) => answers.set(id, { results, error }) });
  const rt = await PluginRuntime.start(bundle, env, { timeLimitMs: Math.min(timeoutMs, 5000) });
  const langs = bundle.manifest.codegenLanguages?.length ? bundle.manifest.codegenLanguages : [{ label: bundle.manifest.name, value: bundle.manifest.id }];
  const frame = [...env.doc.descendants(env.doc.root)].find((id) => env.doc.type(id) === 'FRAME')!;
  const out: RunResult[] = [];
  for (const [i, lang] of langs.entries()) {
    rt.generate(i + 1, frame, lang.value);
    const start = Date.now();
    while (!answers.has(i + 1) && rt.state === 'running' && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 10));
    const a = answers.get(i + 1);
    const blocks = Array.isArray(a?.results) ? (a!.results as { title?: string }[]) : [];
    // No answer while the window is open — the code is produced by the plugin window (cannot check without a window).
    const viaUi = !a && rt.state === 'running' && state.ui;
    out.push({
      command: lang.label,
      state: rt.state === 'error' || a?.error || (!a && !viaUi) ? 'error' : viaUi ? 'skipped' : 'waiting',
      error: rt.error?.split('\n')[0] ?? a?.error ?? (a || viaUi ? null : 'нет ответа'),
      message: viaUi ? 'код готовит окно плагина — без окна не проверить' : null,
      ui: false,
      notifications: notes.slice(0, 5),
      changes: changes(),
      output: a ? `блоков кода: ${blocks.length}${blocks.length ? ` (${blocks.map((b) => b.title ?? '').join(', ')})` : ''}` : undefined,
    });
  }
  if (rt.state === 'running') rt.stop();
  return out;
}

async function runCommand(bundle: PluginBundle, command: string, parameters: Record<string, unknown> | undefined, timeoutMs: number): Promise<RunResult> {
  const { env, notes, state, changes } = sampleEnv();
  const rt = await PluginRuntime.start(bundle, env, { command, parameters, timeLimitMs: Math.min(timeoutMs, 5000) });
  const start = Date.now();
  while (rt.state === 'running' && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 10));
  const result: RunResult = {
    command,
    state: rt.state === 'running' ? 'waiting' : rt.state,
    error: rt.error ? rt.error.split('\n')[0]! : null,
    message: rt.closeMessage,
    ui: state.ui,
    notifications: notes.slice(0, 5),
    changes: changes(),
  };
  if (rt.state === 'running') rt.stop();
  return result;
}

/**
 * Parameter values for the run: the plugin's first suggestions. If an empty query gives no suggestions —
 * try “1”, “2”, “a” (numeric fields). A required parameter without a value (suggestions from the network) —
 * the command is not checked (null).
 */
async function sampleParameters(bundle: PluginBundle, command: string, params: { key: string; allowFreeform?: boolean; optional?: boolean }[]): Promise<Record<string, unknown> | null> {
  const { env } = sampleEnv();
  const values: Record<string, unknown> = {};
  let reply: { suggestions?: { name: string; data?: unknown }[]; error?: string } = {};
  let seq = 0;
  env.suggestions = (_id, r) => (reply = { ...reply, ...r });
  const rt = await PluginRuntime.start(bundle, env, { command, deferRun: true, timeLimitMs: 2000 });
  try {
    for (const p of params) {
      let picked: { name: string; data?: unknown } | undefined;
      for (const q of ['', '1', '2', 'a']) {
        reply = {};
        rt.parameterInput(++seq, p.key, q, { ...values });
        const start = Date.now();
        while (!reply.suggestions && !reply.error && rt.state === 'running' && Date.now() - start < 800) await new Promise((r) => setTimeout(r, 10));
        picked = reply.suggestions?.[0];
        if (picked) break;
      }
      if (picked) values[p.key] = picked.data !== undefined ? picked.data : picked.name;
      else if (!p.optional) return null;
    }
    return values;
  } finally {
    if (rt.state === 'running') rt.stop();
  }
}

export async function checkPlugin(dir: string, opts: { timeoutMs?: number } = {}): Promise<CheckReport> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const { bundle, errors, warnings } = loadBundle(dir);
  const report: CheckReport = { dir, name: bundle?.manifest.name ?? '', id: bundle?.manifest.id ?? '', errors, warnings, apis: { used: 0, missing: [] }, runs: [], verdict: 'fails' };
  if (!bundle) return report;
  // Not for Figma Design (FigJam, Slides) — not checked.
  const editors = bundle.manifest.editorType ?? ['figma'];
  if (!editors.includes('figma') && !editors.includes('dev')) {
    report.verdict = 'other';
    return report;
  }
  const used = scanApi(bundle.code);
  if (editors.includes('figjam')) for (const k of [...used.keys()]) if (FIGJAM_ONLY.has(k)) used.delete(k);
  report.apis.used = used.size;
  const have = await supported([...used.keys()]);
  report.apis.missing = [...used].filter(([k]) => !have.has(k)).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  if (isCodegen(bundle.manifest)) report.runs.push(...(await runCodegen(bundle, timeoutMs)));
  else
    for (const cmd of pluginCommands(bundle.manifest)) {
      const params = cmd.parameters?.length ? await sampleParameters(bundle, cmd.command, cmd.parameters) : undefined;
      if (params === null) {
        report.runs.push({ command: cmd.command, state: 'skipped', error: null, message: 'нет значений параметров (подсказки — из сети?)', ui: false, notifications: [], changes: 0 });
        continue;
      }
      report.runs.push(await runCommand(bundle, cmd.command, params, timeoutMs));
    }
  const failed = report.errors.length || report.runs.some((r) => r.state === 'error');
  report.verdict = failed ? 'fails' : report.apis.missing.length ? 'partial' : 'works';
  return report;
}

const VERDICT = { works: 'работает', partial: 'частично', fails: 'не работает', other: 'не для Figma Design (FigJam / Slides)' } as const;

/** Human-readable report. */
export function formatReport(r: CheckReport): string {
  const lines = [`Плагин «${r.name || '?'}» (${r.id || 'без id'}) — ${r.dir}`];
  for (const e of r.errors) lines.push(`  ✗ ${e}`);
  for (const w of r.warnings) lines.push(`  ! ${w}`);
  if (r.apis.used) {
    lines.push(`  API: упоминает ${r.apis.used}, нет в MFP — ${r.apis.missing.length}`);
    for (const m of r.apis.missing) lines.push(`    − ${m.name}${m.count > 1 ? ` ×${m.count}` : ''}`);
  }
  for (const run of r.runs) {
    const what = run.command ? `«${run.command}»` : 'запуск';
    const state = run.state === 'error' ? `ошибка: ${run.error}` : run.state === 'skipped' ? `не проверена: ${run.message}` : run.output ? run.output : run.state === 'closed' ? `закрылся${run.message ? `: «${run.message}»` : ''}` : run.ui ? 'окно открыто, ждёт действий' : 'работает (подписки или таймеры)';
    lines.push(`  ${run.state === 'error' ? '✗' : run.state === 'skipped' ? '·' : '✓'} ${what} — ${state}; правок: ${run.changes}${run.notifications.length ? `; сообщения: ${run.notifications.map((n) => `«${n.slice(0, 60)}»`).join(', ')}` : ''}`);
  }
  lines.push(`  Итог: ${VERDICT[r.verdict]}`);
  return lines.join('\n');
}
