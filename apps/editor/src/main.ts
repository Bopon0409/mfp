// MFP editor entry point.

import './ui/tokens.css';
import { historyShortcut } from './history-shortcut.ts';
import { layerLocked } from '@mfp/core';
import './ui/new.css';
import './ui/radii.css';
import { fileOpening } from './file-opening.ts';
import { startFrameLoop } from './frame-loop.ts';
import { fileUpload } from './file-upload.ts';
import { appearance, canvasAccent } from './appearance.ts';
import { installDiagnostics } from './diagnostics.ts';
// Full CanvasKit build: it includes Skottie (Lottie in fills).
import CanvasKitInit from 'canvaskit-wasm/full';
import wasmUrl from 'canvaskit-wasm/bin/full/canvaskit.wasm?url';
import { Document, mediaHashes, collectClipboardPatterns, insertClipboardPatterns, remapPatternPaints, type ClipboardPatterns, animationRoot, blobRefs, invert, multiply, networkChains, networkOf, transplantComments, type Matrix, type NodeRecord, type Props, acceptsChildren, userPages } from '@mfp/core';
import { isCodegen, parseManifest, pluginCommands, type PluginBundle } from '@mfp/plugin-host';
import { collectClipboardResources, insertClipboardResources, prepareClipboardTree, remapClipboardProps, type ClipboardResources } from '@mfp/core';
import { PluginRegistry } from './plugin-registry.ts';
import { openVariablesWindow } from './variables-ui.ts';
import { installBundle, launch, pluginMenu, relaunchLastPlugin, type PluginUiDeps } from './plugins-ui.ts';
import { CodegenHost, PluginHost, type PluginHostCallbacks } from '@mfp/plugin-host/browser';
import { Editor, type Rect, type Tool } from './editor.ts';
import { Tools } from './tools.ts';
import { Panels } from './panels.ts';
import { TextEditing } from './text-edit.ts';
import { download, openDiskFile, openFile, openFixture } from './io.ts';
import { enableAutoLayout, isAutoLayout, wrapInAutoLayout } from '@mfp/editing';
import { Files } from './files.ts';
import { deliver, download as downloadBytes, exportFramesPdf, exportNode, exportSelectionFiles, openExportDialog, openPrintDialog } from './export.ts';
import type { PdfPrint } from './pdf-export.ts';
import { cssOf } from './css-export.ts';
import { Home } from './home.ts';
import { HistoryPanel, versionLabel } from './history-ui.ts';
import { Comments } from './comments-ui.ts';
import { LocalCommentStore, ServerCommentStore, type CommentEvent } from './comment-store.ts';
import { Notifications } from './notifications-ui.ts';
import { branchesDialog } from './branches-ui.ts';
import { CursorChat } from './cursor-chat.ts';
import { TeamLibraries } from './team-libraries.ts';
import { announce, contrast, labelIconButtons } from './a11y.ts';
import { FileTabs } from './tabs.ts';
import { DevMode } from './devmode.ts';
import { InspectPanel } from './inspect-panel.ts';
import { Annotations } from './annotations-ui.ts';
import { Measurements } from './measurements-ui.ts';
import { DevStatusUI } from './dev-status.ts';
import { openCompare } from './compare.ts';
import { openPlayground } from './playground.ts';
import type { ImageBytesSource } from '@mfp/io-figma';
import { openPageMove } from './page-move-ui.ts';
import { installPageGuard, openPageProtection, pageLocked } from './page-protect-ui.ts';
import { confirmDialog, disk, findUpdate, GITHUB_UPDATES_URL, isDesktop, onOpenPaths, onWindowClose, openDialog, relaunch, saveDialog, setWindowTitle } from './platform.ts';
import { nodeOutline, parsePath, pathToSvg, transformPath, wrapNodes } from '@mfp/editing';
import type { ExportSetting } from '@mfp/core';
import { SUB_TOOLS, VectorTool, vectorPointsSection, brushToolSection, type VectorSubTool } from './vector.ts';
import { openOffsetDialog, simplifySelection } from './vector-ops.ts';
import { ShapeBuilder } from './shape-builder.ts';
import { detachInstance, instantiate } from '@mfp/editing';
import { exportSvg } from './svg-export.ts';
import { importSvg } from './svg-import.ts';
import { buildScene, decodeFigKiwi, figmaClipboardBytes, readFigKiwi, sceneToCore } from '@mfp/io-figma';
import { toggleShortcuts } from './shortcuts.ts';
import { installTooltips } from './tooltip.ts';
import { Collab } from './collab.ts';
import { VoiceChat } from './voice.ts';
import { AiPanel } from './ai/panel.ts';
import { openPluginGenerator } from './ai/plugin-gen.ts';
import { Widgets } from './widgets.ts';
import { Account, ApiError, canComment, canEdit, whoIs, type ServerFile } from './account.ts';
import { accountMenu, chooseDestination, signIn } from './account-ui.ts';
import { shareLocalFile, shareServerFile } from './share-ui.ts';
import { LoroBridge, loroReady } from '@mfp/sync';
import { imageHashes } from '@mfp/io-figma';
import { Navigation } from './navigation.ts';
import { ICON, iconEl, NODE_LABEL, type IconName } from './icons.ts';
import { actionsFromMenu, openActions, type Action, type ActionsTab } from './actions.ts';
import { actionKey, boundAction, hintOf, openKeysDialog } from './custom-keys.ts';
import { align, distribute, tidyUp, type AlignMode } from './arrange.ts';
import { labelMenu } from './layer-labels.ts';
import { Minimap } from './minimap.ts';
import { DistortHandles } from './distort-handles.ts';
import { openArcLayout } from './arc-layout-ui.ts';
import { savedViewsMenu } from './saved-views.ts';
import { defaultTextMenu } from './default-text.ts';
import { invertMenu, orderMenu, textOpsMenu } from './layer-ops-ui.ts';
import { FocusMode } from './focus-mode.ts';
import { TextLimits } from './text-limits.ts';
import { FreeformHandles } from './freeform-handles.ts';
import { VISION_LABEL, VisionSim, type VisionMode } from './vision-sim.ts';
import { installRepeatGrids, openDataFill, repeatSection, repeatSelection } from './repeat-data-ui.ts';
import { DEFAULT_DPI, type LengthUnit } from '@mfp/core';
import { resizeToFit, resizeWithConstraints, sizingProps } from '@mfp/editing';
import { textKeyOf, textKeyStyle, type TextKey } from './text-keys.ts';
import { devKeyAllowed } from './dev-keys.ts';
import { figmaKeyOf } from './figma-keys.ts';
import { KeyboardSelection, keyboardSelectionShortcut, regionShortcut } from './keyboard-selection.ts';
import { showMenu, showMenuAt, type MenuEntry } from './menu.ts';
import { folderName } from './library.ts';
import { CanvasLabels } from './canvas-labels.ts';
import { Measure } from './measure.ts';
import { Rulers } from './rulers.ts';
import { LayoutGrids } from './layout-grids.ts';
import { GridOverlay } from './grid-overlay.ts';
import { openBatchRename, openFind } from './find.ts';
import { GradientHandles } from './gradient-handles.ts';
import { ImageCrop } from './image-crop.ts';
import { PatternPick } from './pattern-pick.ts';
import { hasImageFill, openVectorizeDialog } from './vectorize-ui.ts';
import { BlurHandles } from './blur-handles.ts';
import { videoSize } from './video-cache.ts';
import { isModelBytes } from './model3d.ts';
import { WidthTool } from './width-tool.ts';
import { Timeline } from './timeline.ts';
import { ANIM_FORMATS, exportAnimation, type AnimFormat } from './anim-export.ts';
import { MissingFonts } from './missing-fonts.ts';
import { AssetsPanel, componentEntries, insertComponent } from './assets.ts';
import { openLibraries, tokensMenu } from './design-menu.ts';
import { helpItems } from './help-menu.ts';
import { openMcpDialog } from './mcp-ui.ts';
import { isOAuthPage, openOAuthConsent } from './oauth-consent.ts';
import { appMode, installNetworkGuard, network, offlineMessage, trustedServers, trustServer, updatesCheck } from './network.ts';
import { chooseAppMode } from './app-mode-ui.ts';
import { readCompanyConfig } from './company.ts';
import { officeAuto, openOfficeDialog, startOffice } from './office-ui.ts';
import { openCheckDesigns } from './check-designs.ts';
import { FONT_FAMILIES } from './panels.ts';
import { effectiveStyle, textSegments, type TextStyle } from '@mfp/core';
import { restyleText, styleWeight, toggleBold, toggleItalic, type EffectiveTextStyle } from '@mfp/core';
import { PathTextMap, isLottieBytes, textFonts, textPathScale } from '@mfp/renderer';
import { closePaintEditor, paintEditorKeydown, selectPaintStop, setCanvasHit } from './paint-editor.ts';
import { playerUrl, present, presentComments, presentTabs } from './present.ts';
import { togglePreview, presentInPage } from './preview.ts';
import { ProtoCanvas } from './proto-canvas.ts';
import { ShapeHandles } from './shape-handles.ts';
import { imagingMenuItems, installImaging } from './imaging/page.ts';
import { lang, setLang, t } from './i18n/index.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// Error log before anything else (startup errors are also needed in the problem report).
installDiagnostics();
/** File tabs (desktop; in the browser for testing, ?tabs). Created together with the file list. */
let fileTabs: FileTabs | null = null;
const ck = await CanvasKitInit({ locateFile: () => wasmUrl });

// ---------- Internet access ----------

/** Team servers are reachable even without internet (addresses are added on sign-in and when a server is entered). */
const ownServers = trustedServers;
installNetworkGuard(() => ownServers);
/** Employee app: the company server and the internet ban from mfp-company.json next to the program. */
const company = await readCompanyConfig();
if (company?.network === 'off') network.lockedByCompany = true;
if (company?.server) appMode.set('server');

// ---------- Default document ----------

function newDocument(): { doc: Document; page: string } {
  const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
  const page = doc.create('PAGE', doc.root, { name: t('Страница {0}', 1) }, undefined);
  doc.clearHistory();
  return { doc, page };
}

const initial = newDocument();
const canvas = $<HTMLCanvasElement>('canvas');
const editor = new Editor(ck, canvas, initial.doc, initial.page);
// Fonts: our own bundle first (works offline); the online catalog only if it is allowed.
editor.fonts.useBundled('/fonts');
editor.fonts.offline = () => !network.allowed;
network.onChange.push(() => network.allowed && editor.fonts.retryMissing());
void editor.fonts.bundledFamilies().then((list) => (panels.bundledFonts = list));
const tools = new Tools(editor);
const keyboardSelection = new KeyboardSelection(editor, (x, y) => tools.pick(x, y, false));
const panels = new Panels(editor);
panels.notify = (message, kind) => toast(message, kind);
panels.onToolReset = () => setTool('select');
panels.onExport = (ids) => void exportSelection(ids);
panels.onPresent = (start) => present(editor, () => files.name, start);
panels.pageProtection = {
  available: () => !!files.remote && files.remote.role === 'owner',
  open: (pageId) => files.remote && void openPageProtection({ editor, account, fileId: files.remote.id, notify: (m, k) => toast(m, k) }, pageId),
};
panels.onCopyLink = (pageId) => copyNodeLink(pageId);
panels.onMovePage = (pageId) => void openPageMove({ editor, files, notify: (m, k) => toast(m, k), openFile: (id) => void files.openId(id) }, pageId);
const textEditing = new TextEditing(editor, editor.fonts, $('stage'));
textEditing.notify = (message) => toast(message);
tools.onEditText = (id, isNew, at) => textEditing.start(id, isNew, at);
// While editing, the “Text” panel shows and changes the styling of the text selection.
panels.textEditing = textEditing;
textEditing.onChange.push(() => panels.schedule());
// Missing fonts: a badge above the canvas and a replacement dialog.
const missingFonts = new MissingFonts(editor, $('stage'));
const assets = new AssetsPanel(editor);
assets.onLibraries = () => openLibraries(editor, teamLibs);
missingFonts.families = () => panels.fontFamilies();
missingFonts.notify = (m) => toast(m);
// Pen and path editing: while active, they own the pointer.
const vectorTool = new VectorTool(editor);
// Shape builder (Shift+M): while active, it owns the pointer.
const shapeBuilder = new ShapeBuilder(editor);
shapeBuilder.onDone = () => updateChrome();
const rulers = new Rulers(editor, $('stage'));
const layoutGrids = new LayoutGrids(editor);
new GridOverlay(editor);
// Gradient handles: visible while a gradient is open in the paint popover.
const gradientHandles = new GradientHandles(editor);
const imageCrop = new ImageCrop(editor);
const patternPick = new PatternPick(editor);
const blurHandles = new BlurHandles(editor);
const widthTool = new WidthTool(editor);
const timeline = new Timeline(editor, document.getElementById('stage')!);
timeline.onExport = (format) => void exportAnim(format);

/** A frame with animation for export: from the timeline or the selection. */
function animRoot(): string | null {
  const doc = editor.doc;
  const sel = editor.selection.find((id) => doc.has(id));
  return timeline.rootId ?? (sel ? animationRoot(doc, sel) : null);
}

/** Frame animation export (Lottie, GIF, WebM): the timeline pose is lifted for the duration of the export. */
async function exportAnim(format: AnimFormat) {
  const root = animRoot();
  if (!root) {
    toast('Выделите фрейм верхнего уровня или слой в нём');
    return;
  }
  const resume = timeline.suspend();
  try {
    const r = await exportAnimation(editor, root, format, (p) => timeline.progress(p));
    const where = await deliver([r.file], r.file.name);
    if (where) toast(`Сохранено: ${where}`);
    for (const w of r.warnings) toast(w);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    timeline.progress(null);
    resume();
  }
}
widthTool.onExit = () => setTool('select');
panels.onGradient = (t) => gradientHandles.set(t);
panels.onCrop = (t) => {
  closePaintEditor();
  imageCrop.start(t);
};
panels.onPatternPick = (targets) => {
  toast('Щёлкните слой — источник узора (Ctrl — вложенный слой, Esc — отмена)');
  return patternPick.start(targets);
};
imageCrop.onChange = () => {
  if (imageCrop.target) toast('Обрезка: тяните картинку и её углы, рамку — за ручки. Enter — готово');
};
gradientHandles.onStop = (i) => selectPaintStop(i);
setCanvasHit((e) => gradientHandles.hitEvent(e) || freeformHandles.hitEvent(e));
// The “Prototype” tab: connections on the canvas, flow badges, the new-connection handle.
const protoCanvas = new ProtoCanvas(editor, $('labels'));
// Ellipse arc handles and star ray ratio handles.
const shapeHandles = new ShapeHandles(editor);
panels.onTab = (tab) => protoCanvas.set(tab === 'prototype');
protoCanvas.onCreated = (id, index) => {
  editor.select([id]);
  // The new connection settings dialog, once the panel re-renders.
  setTimeout(() => document.querySelector<HTMLElement>(`#properties .proto-row[data-index="${index}"] .proto-row-main`)?.click(), 60);
};
// Pointer interception: guides first (grab and move), gradient handles, then pen and path editing.
// Text editing comes first: clicks inside the text place the caret, clicks outside end editing.
// Comment mode right after text: a click on the canvas there places a new comment.
tools.interceptor = {
  get active() {
    return distortHandles.active || freeformHandles.active || patternPick.active || textEditing.active || comments.mode || devMode.active || rulers.active || imageCrop.active || gradientHandles.active || blurHandles.active || protoCanvas.active || shapeHandles.active || vectorTool.active || shapeBuilder.active || widthTool.active;
  },
  down: (e, x, y) => distortHandles.down(e, x, y) || freeformHandles.down(e, x, y) || patternPick.down(e, x, y) || textEditing.down(e, x, y) || comments.down(e, x, y) || annotations.down(e, x, y) || measurements.down(e, x, y) || devMode.down(e, x, y) || rulers.down(e) || imageCrop.down(e, x, y) || gradientHandles.down(e, x, y) || blurHandles.down(e, x, y) || protoCanvas.down(e, x, y) || shapeHandles.down(e, x, y) || vectorTool.down(e, x, y) || shapeBuilder.down(e, x, y) || widthTool.down(e, x, y),
  move: (e, x, y) => distortHandles.move(e, x, y) || freeformHandles.move(e, x, y) || patternPick.move(e, x, y) || textEditing.move(e, x, y) || comments.move() || annotations.move() || measurements.move(e, x, y) || devMode.move(e, x, y) || rulers.move(e) || imageCrop.move(e, x, y) || gradientHandles.move(e, x, y) || blurHandles.move(e, x, y) || protoCanvas.move(e, x, y) || shapeHandles.move(e, x, y) || vectorTool.move(e, x, y) || shapeBuilder.move(e, x, y) || widthTool.move(e, x, y),
  up: (e) => distortHandles.up() || freeformHandles.up() || textEditing.up() || comments.up() || annotations.up() || measurements.up() || devMode.up() || rulers.up(e) || imageCrop.up() || gradientHandles.up() || blurHandles.up() || protoCanvas.up() || shapeHandles.up() || vectorTool.up() || shapeBuilder.up() || widthTool.up(),
  dblclick: (e, x, y) => devMode.dblclick() || textEditing.dblclick() || vectorTool.dblclick(e, x, y),
};
tools.onEditVector = (id) => vectorTool.startEdit(id);
tools.onTextOnPath = (wx, wy) => textOnPathAt(wx, wy);
vectorTool.onChange = () => {
  panels.schedule();
  renderVectorBar();
};

/** Bottom toolbar for vector editing (Enter): replaces the main one; “Done” exits (Enter / Esc). */
const VECTOR_ICON: Record<VectorSubTool, string> = { move: ICON.move, pen: ICON.pen, bucket: ICON.bucket, lasso: ICON.lasso, knife: ICON.knife, eraser: ICON.eraser };
const vectorBar = document.createElement('nav');
vectorBar.id = 'vector-bar';
vectorBar.setAttribute('role', 'toolbar');
vectorBar.setAttribute('aria-label', 'Правка вектора');
vectorBar.hidden = true;
$('stage').append(vectorBar);
function renderVectorBar() {
  const on = vectorTool.mode === 'edit';
  vectorBar.hidden = !on;
  $('toolbar').classList.toggle('vector-editing', on);
  if (!on) return;
  const buttons = SUB_TOOLS.map((s) => {
    const b = document.createElement('button');
    b.className = `tool-btn${vectorTool.sub === s.tool ? ' on' : ''}`;
    b.title = `${s.label} (${s.key})`;
    b.setAttribute('aria-label', s.label);
    b.setAttribute('aria-pressed', String(vectorTool.sub === s.tool));
    b.innerHTML = VECTOR_ICON[s.tool];
    b.addEventListener('click', () => vectorTool.setSub(s.tool));
    return b;
  });
  const done = document.createElement('button');
  done.className = 'vector-done';
  done.textContent = 'Готово';
  done.title = 'Закончить правку (Enter)';
  done.addEventListener('click', () => {
    vectorTool.stopEdit();
    editor.canvasEl.focus();
  });
  const sep = document.createElement('span');
  sep.className = 'tool-sep';
  vectorBar.replaceChildren(...buttons, sep, done);
}
panels.vectorSection = () => vectorPointsSection(vectorTool);
panels.brushSection = () => brushToolSection(vectorTool);
vectorTool.onDone = () => {
  if (editor.tool === 'pen' || editor.tool === 'pencil' || editor.tool === 'brush') editor.tool = 'select';
  updateChrome();
  panels.schedule();
};
const canvasLabels = new CanvasLabels(editor, $('labels'));
const minimap = new Minimap(editor, $('stage'));
const distortHandles = new DistortHandles(editor);
const focusMode = new FocusMode(editor, $('stage'));
new TextLimits(editor);
const freeformHandles = new FreeformHandles(editor);
const vision = new VisionSim($('canvas'), $('stage'));
installRepeatGrids(editor);
panels.extraSections.push(repeatSection(editor, (m) => toast(m)));
// A frame is dragged by its label on the canvas; Shift adds it to the selection.
canvasLabels.onLabelDown = (id, e) => {
  if (e.shiftKey) editor.select(editor.selection.includes(id) ? editor.selection.filter((s) => s !== id) : [...editor.selection, id]);
  else if (!editor.selection.includes(id)) editor.select([id]);
  if (editor.selection.includes(id)) tools.beginMove(e);
};
canvasLabels.onLabelDblClick = (id) => panels.rename(id);
new Measure(editor, $('labels'));
// Developer mode (Shift+D): view only, inspect on the right.
const devMode = new DevMode(editor, $('labels'));
// Annotations and measurements (visible in developer mode or via “View”), statuses and focus.
const annotations = new Annotations(editor, { pick: (x, y) => devMode.pickAt(x, y), notify: (m) => toast(m) }, $('stage'));
const measurements = new Measurements(editor, { pick: (x, y) => devMode.pickAt(x, y), notify: (m) => toast(m), visible: () => annotations.visible }, $('labels'));
const devStatus = new DevStatusUI(
  editor,
  {
    markVersion: async (label) => (await files.versions?.snapshot('auto', undefined, label, true))?.id ?? null,
    compare: (id, versionId) => void compareNode(id, versionId),
    notify: (m) => toast(m),
  },
  $('left'),
  $('stage'),
);
devMode.allow = (id) => devStatus.inScope(id);
devMode.onChange.push(() => {
  if (!editor.devMode) devStatus.unfocus();
  devStatus.refresh();
});
const inspect = new InspectPanel(editor, {
  notify: (m) => toast(m),
  exportNode: async (id, settings) => {
    const out = await exportNode(editor, id, settings);
    await deliver(out, editor.doc.get(id, 'name') ?? 'export');
  },
  goTo: (id) => goToNode(id),
  status: { markable: (id) => devStatus.markable(id), menu: (ids) => devStatus.menuItems(ids), focus: (id) => devStatus.focus(id), compare: (id, v) => void compareNode(id, v) },
  annotations: { add: (id) => annotations.add(id), edit: (id, i) => annotations.edit(id, i) },
  playground: (id) => void openPlayground(editor, id, inspect.language, (m) => toast(m)),
  exportSection: (ids) => panels.exportSectionFor(ids),
  pluginLanguages: () => [...codegenHosts.values()].flatMap((c) => c.languages.map((l) => ({ key: `plugin:${c.bundle.manifest.id}:${l.value}`, label: `${l.label} · ${c.bundle.manifest.name}` }))),
  pluginCode: (key, nodeId) => {
    const [, pid, ...rest] = key.split(':');
    const host = codegenHosts.get(pid ?? '');
    if (!host) return Promise.reject(new Error('плагин не подключён'));
    return host.generate(nodeId, rest.join(':'));
  },
});

// Installed plugins (OPFS) and development server samples.
const pluginRegistry = new PluginRegistry({ dev: !isDesktop });
// Codegen plugins (developer mode): their languages appear in the inspect code panel.
const codegenHosts = new Map<string, CodegenHost>();
function addCodegen(bundle: PluginBundle, quiet = false) {
  codegenHosts.get(bundle.manifest.id)?.stop();
  codegenHosts.set(
    bundle.manifest.id,
    new CodegenHost(bundle, {
      doc: () => editor.doc,
      getPage: () => editor.pageId,
      getSelection: () => editor.selection,
      notify: (m, k) => toast(m, k),
      onRefresh: () => panels.schedule(),
    }),
  );
  if (!quiet) toast(`Плагин кодогенерации «${bundle.manifest.name}» подключён: его языки — в панели кода режима разработчика (Shift+D)`);
  panels.schedule();
}
/** Installed codegen plugins (and development server samples), connected right away. */
async function discoverCodegen() {
  for (const p of await pluginRegistry.list()) if (isCodegen(p.bundle.manifest)) addCodegen(p.bundle, true);
}
void discoverCodegen();

/** Compare a layer with a file version (by default, the one captured when marked “Ready for development”). */
async function compareNode(id: string, versionId?: string) {
  const v = files.versions;
  const file = files.lib ? files.current.id : null;
  if (!v || !file) {
    toast('История версий недоступна — сравнивать не с чем');
    return;
  }
  await files.autosave.flush();
  await openCompare(
    editor,
    id,
    {
      versions: async () => (await v.list(file)).slice().reverse().map((x) => ({ id: x.id, label: versionLabel(x) })),
      load: (vid) => v.load(file, vid).catch(() => null),
      notify: (m) => toast(m),
    },
    versionId,
  );
}
inspect.onRefresh = () => panels.schedule();
panels.inspect = inspect;

/** Show a layer: its page, its box on screen, selection (an internal page cannot be shown). */
function goToNode(id: string) {
  const doc = editor.doc;
  let page: string | null = null;
  for (let p: string | null = id; p; p = doc.parent(p)) {
    if (doc.type(p) === 'PAGE') {
      page = p;
      break;
    }
  }
  if (!page || doc.get(page, 'internal')) {
    toast('Компонент — из подключённой библиотеки: в этом файле его не показать');
    return;
  }
  if (page !== editor.pageId) editor.setPage(page);
  editor.select([id]);
  editor.fitRect(editor.selectionBounds([id]));
}

interface ToolItem {
  tool: Tool;
  label: string;
  key?: string;
  icon: IconName;
}
/** Tool groups: the button shows the last chosen tool of the group. */
const TOOL_GROUPS: { id: string; tools: ToolItem[] }[] = [
  {
    id: 'pointer',
    tools: [
      { tool: 'select', label: 'Перемещение', key: 'V', icon: 'move' },
      { tool: 'hand', label: 'Рука', key: 'H', icon: 'hand' },
      { tool: 'scale', label: 'Масштаб', key: 'K', icon: 'scale' },
    ],
  },
  {
    id: 'frame',
    tools: [
      { tool: 'frame', label: 'Фрейм', key: 'F', icon: 'frame' },
      { tool: 'section', label: 'Секция', key: 'Shift+S', icon: 'section' },
      { tool: 'slice', label: 'Срез', key: 'S', icon: 'slice' },
    ],
  },
  {
    id: 'shapes',
    tools: [
      { tool: 'rect', label: 'Прямоугольник', key: 'R', icon: 'rect' },
      { tool: 'line', label: 'Линия', key: 'L', icon: 'line' },
      { tool: 'arrow', label: 'Стрелка', key: 'Shift+L', icon: 'arrow' },
      { tool: 'ellipse', label: 'Эллипс', key: 'O', icon: 'ellipse' },
      { tool: 'polygon', label: 'Многоугольник', icon: 'polygon' },
      { tool: 'star', label: 'Звезда', icon: 'star' },
    ],
  },
  {
    id: 'pen',
    tools: [
      { tool: 'pen', label: 'Перо', key: 'P', icon: 'pen' },
      { tool: 'pencil', label: 'Карандаш', key: 'Shift+P', icon: 'pencil' },
    ],
  },
  // “Drawing” mode: each tool has its own button.
  { id: 'draw-pen', tools: [{ tool: 'pen', label: 'Перо', key: 'P', icon: 'pen' }] },
  { id: 'draw-pencil', tools: [{ tool: 'pencil', label: 'Карандаш', key: 'Shift+P', icon: 'pencil' }] },
  { id: 'draw-brush', tools: [{ tool: 'brush', label: 'Кисть', key: 'B', icon: 'brush' }] },
  { id: 'draw-width', tools: [{ tool: 'width', label: 'Ширина обводки', key: 'Shift+W', icon: 'width' }] },
  { id: 'text', tools: [{ tool: 'text', label: 'Текст', key: 'T', icon: 'text' }] },
  // Comments, annotations and measurements are one group in both modes.
  {
    id: 'comment',
    tools: [
      { tool: 'comment', label: 'Комментарий', key: 'C', icon: 'comment' },
      { tool: 'annotate', label: 'Аннотация', icon: 'annotate' },
      { tool: 'measure', label: 'Измерение', icon: 'ruler' },
    ],
  },
];
const groupCurrent = new Map(TOOL_GROUPS.map((g) => [g.id, g.tools[0]!]));
const groupEls = new Map<string, { root: HTMLElement; main: HTMLButtonElement }>();
const imageInput = document.createElement('input');
imageInput.type = 'file';
imageInput.accept = 'image/*,.svg,video/mp4,video/webm,video/quicktime,.json,.lottie,.glb,.gltf';
imageInput.multiple = true;
imageInput.addEventListener('change', () => {
  const files = [...(imageInput.files ?? [])];
  imageInput.value = '';
  const at = editor.screenToWorld(editor.viewW / 2, editor.viewH / 2);
  for (const f of files.filter(isSvg)) void f.text().then((text) => placeSvg(text, f.name.replace(/\.svg$/i, ''), at));
  const images = files.filter(isImage);
  if (images.length) void placeImages(images, at);
  const videos = files.filter(isVideo);
  if (videos.length) void placeVideos(videos, at);
  const lotties = files.filter(maybeLottie);
  if (lotties.length) void placeLotties(lotties, at);
  const models = files.filter(isModelFile);
  if (models.length) void placeModels(models, at);
});
{
  const bar = $('toolbar');
  for (const g of TOOL_GROUPS) {
    const root = document.createElement('div');
    root.className = 'tgroup';
    const main = document.createElement('button');
    main.className = 'tbtn';
    main.addEventListener('click', () => setTool(groupCurrent.get(g.id)!.tool));
    root.append(main);
    if (g.tools.length > 1) {
      const more = document.createElement('button');
      more.className = 'tmore';
      more.title = 'Ещё инструменты';
      more.innerHTML = ICON.chevronDown;
      more.addEventListener('click', () => {
        const items: MenuEntry[] = g.tools.map((t) => ({
          label: t.label,
          hint: t.key,
          icon: ICON[t.icon],
          run: () => setTool(t.tool),
        }));
        if (g.id === 'shapes') items.push('sep', { label: 'Картинка или SVG…', hint: 'Ctrl+Shift+K', icon: ICON.image, run: () => imageInput.click() });
        showMenu(root, items, 'above');
      });
      root.append(more);
    }
    bar.append(root);
    groupEls.set(g.id, { root, main });
  }
  const sep = document.createElement('span');
  sep.className = 'tsep';
  // “Actions”: commands, plugins and the assistant, Ctrl+K. Plugins are also in “Tools” on the left.
  const plugins = document.createElement('button');
  plugins.className = 'tbtn';
  plugins.id = 'plugins-btn';
  plugins.title = 'Действия: команды и плагины (Ctrl+K)';
  plugins.innerHTML = ICON.sparkle;
  // Mode switcher: “Design | Develop” on a backdrop.
  const modes = document.createElement('div');
  modes.className = 'tmodes';
  const design = document.createElement('button');
  design.className = 'tmode';
  design.id = 'design-btn';
  design.title = 'Режим дизайна';
  design.innerHTML = ICON.designMode;
  design.addEventListener('click', () => setUiMode('design'));
  const draw = document.createElement('button');
  draw.className = 'tmode';
  draw.id = 'draw-btn';
  draw.title = 'Рисование: перо, карандаш, кисть, ширина обводки';
  draw.innerHTML = ICON.brush;
  draw.addEventListener('click', () => setUiMode('draw'));
  const dev = document.createElement('button');
  dev.className = 'tmode dev-toggle';
  dev.id = 'dev-btn';
  dev.title = 'Режим разработчика (Shift+D)';
  dev.innerHTML = ICON.code;
  dev.addEventListener('click', () => setUiMode('dev'));
  modes.append(design, draw, dev);
  bar.append(sep, plugins, Object.assign(document.createElement('span'), { className: 'tsep' }), modes);
}
$('menu-btn').innerHTML = ICON.logo;

// Side panel width: drag their edge (remembered).
for (const side of ['left', 'right'] as const) {
  const key = `mfp-${side}-w`;
  const saved = Number(localStorage.getItem(key));
  if (saved) document.documentElement.style.setProperty(`--${side}-w`, `${saved}px`);
  const handle = document.createElement('div');
  handle.className = 'resizer';
  handle.title = 'Потяните, чтобы изменить ширину панели';
  $(side).append(handle);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const start = e.clientX;
    // Left width excludes the section strip (it is fixed).
    const width = $(side).getBoundingClientRect().width - (side === 'left' ? $('rail').getBoundingClientRect().width : 0);
    handle.classList.add('drag');
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.max(200, Math.min(480, width + (side === 'left' ? ev.clientX - start : start - ev.clientX))));
      document.documentElement.style.setProperty(`--${side}-w`, `${w}px`);
      localStorage.setItem(key, String(w));
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      handle.classList.remove('drag');
      document.body.classList.remove('resizing');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
// Narrow canvas: “?” and the status line do not overlap the toolbar.
new ResizeObserver(() => $('stage').classList.toggle('narrow', $('stage').clientWidth < 620)).observe($('stage'));
$('shortcuts-btn').innerHTML = ICON.help;

// File name: click for the file menu, double-click to rename.
const fileNameSpan = () => {
  const span = document.createElement('span');
  span.id = 'filename';
  const chevron = document.createElement('span');
  chevron.className = 'file-chevron';
  chevron.innerHTML = ICON.chevronDown;
  return [span, chevron];
};
$('file-title').replaceChildren(...fileNameSpan());
$('file-title').addEventListener('click', (e) => {
  if ($('file-title').querySelector('input') || e.detail > 1) return;
  showMenu($('file-title'), [
    { label: 'Переименовать', run: renameFile },
    ...(home ? [{ label: 'Все файлы…', run: () => home.open() }] : []),
    ...(versionPanel ? [{ label: 'История версий', checked: versionPanel.isOpen, run: () => void versionPanel.toggle() }] : []),
  ]);
});
$('file-title').addEventListener('dblclick', () => {
  document.querySelector('.menu')?.remove();
  renameFile();
});
function renameFile() {
  const title = $('file-title');
  if (title.querySelector('input')) return;
  if (files.remote && !canEdit(files.remote.role)) {
    toast('Переименовать файл может тот, у кого есть право на правку');
    return;
  }
  const input = document.createElement('input');
  input.value = files.name;
  title.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save && input.value.trim()) void files.rename(input.value.trim());
    title.replaceChildren(...fileNameSpan());
    updateChrome();
    canvas.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// Collapse the interface with the button next to the file name; restore it with the badge at the top left.
$('ui-min-btn').innerHTML = ICON.sidebar;
$('ui-min-btn').addEventListener('click', () => toggleUi('min'));
{
  const restore = document.createElement('div');
  restore.className = 'ui-restore';
  const name = document.createElement('span');
  const btn = document.createElement('button');
  btn.title = 'Развернуть интерфейс (Ctrl+Shift+\\)';
  btn.setAttribute('aria-label', 'Развернуть интерфейс');
  btn.innerHTML = ICON.sidebar;
  btn.addEventListener('click', () => toggleUi('min'));
  restore.insertAdjacentHTML('afterbegin', ICON.logo);
  restore.append(name, btn);
  document.body.append(restore);
  new MutationObserver(() => (name.textContent = files.name)).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
// “Pages” and “Layers” collapse (remembered); layers also have “collapse all”.
for (const [sec, key] of [['pages', 'mfp.pagesOpen'], ['layers', 'mfp.layersOpen']] as const) {
  const toggle = $(`${sec}-toggle`);
  const section = $(`${sec}-section`);
  const apply = (open: boolean) => {
    section.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    /* no storage: expanded */
  }
  apply(stored !== '0');
  toggle.addEventListener('click', () => {
    const open = section.classList.contains('collapsed');
    apply(open);
    try {
      localStorage.setItem(key, open ? '1' : '0');
    } catch {
      /* will not be remembered */
    }
  });
}
$('collapse-layers').innerHTML = ICON.collapseAll;
$('collapse-layers').addEventListener('click', () => panels.collapseLayers());

// Left strip: “Files” (the file list) at the top, like “home”.

// Account on the MFP server: sign-in with an email code, teams, files on the server.
const account = new Account();
if (company?.server) account.setServer(company.server);
// This computer is a server for colleagues (sharing is on and “when MFP starts” is enabled): start it again.
if (isDesktop && !company?.server && officeAuto.on) void startOffice(account).catch((e) => console.warn('Доступ для коллег не открылся', e));
trustServer(account.base);
/** Team server policy: closed network (MFP_NETWORK=off) turns the internet off for all its editors. */
const serverPolicy = () => {
  if (isDesktop && appMode.local) return;
  void account
    .api<{ network?: string }>('GET', '/api/auth/config')
    .then((c) => network.applyServerPolicy(c.network === 'off' ? 'off' : 'on', account.base))
    .catch(() => {});
};
serverPolicy();
account.onChange.push(() => {
  trustServer(account.base);
  serverPolicy();
});
/** Developer mode was turned on because of the “can view” or “can comment” role (turn it off when the file changes). */
let forcedDev = false;
/** Server file documents → their comment sources. */
const serverComments = new WeakMap<Document, () => ServerCommentStore>();
/** Waits for the document of the server file being opened (true: opened). */
let openingFile: ((ok: boolean) => void) | null = null;
let serverOpening: { id: string; promise: Promise<boolean> } | null = null;
let openingStatus: ((text: string) => void) | null = null;

// Collaboration: a room on the server (npm run dev:server), the address is #room=name;
// a server file is #file=<id> (with permissions; via a link, &link=<token>).
const collab = new Collab(editor, localStorage.getItem('mfp-name') || t('Гость'));
// Voice: a call among the participants of a room or file (WebRTC; the server relays signaling).
const voice = new VoiceChat(collab);
voice.onChange = () => renderPresence();
voice.onError = (m) => toast(m, 'error');
const collabBtn = $('collab-btn');
// Prototype presentation opens in a separate tab.
const presentBtn = $('present-btn');
// Assistant (AI with your own key): a panel at the right edge of the canvas.
const ai = new AiPanel(editor, $('stage'));
// The assistant button is in the section strip on the left.
const aiBtn = document.createElement('button');
aiBtn.id = 'ai-btn';
aiBtn.className = 'rail-btn';
aiBtn.title = 'Ассистент — AI со своим ключом (Ctrl+J)';
aiBtn.innerHTML = `<span class="rail-ic">${ICON.sparkle}</span><span>Ассистент</span>`;
aiBtn.addEventListener('click', () => ai.toggle());
ai.onToggle = (open) => aiBtn.classList.toggle('on', open);
$('rail').append(aiBtn);
presentBtn.innerHTML = ICON.play;
presentBtn.addEventListener('click', () => present(editor, () => files.name));
// “▷ ⌄”: presentation options.
{
  const more = document.createElement('button');
  more.className = 'present-more';
  more.title = 'Способы показа';
  more.setAttribute('aria-label', 'Способы показа');
  more.innerHTML = ICON.chevronDown;
  more.addEventListener('click', () =>
    showMenu(more, [
      { label: 'Показ в новой вкладке', hint: 'Ctrl+Alt+Enter', run: () => present(editor, () => files.name) },
      { label: 'Показ на этой странице', run: () => presentInPage(editor, () => files.name) },
      { label: 'Предпросмотр поверх холста', hint: 'Shift+Space', run: () => togglePreview(editor, () => files.name) },
      'sep',
      { label: 'Копировать ссылку на показ', run: () => void navigator.clipboard.writeText(new URL(playerUrl(editor, () => files.name), location.href).href).then(() => toast('Ссылка на показ скопирована')) },
    ]),
  );
  presentBtn.after(more);
}
// Own avatar with an arrow: account and theme. In a room, among the participants.
const meBtn = document.createElement('button');
meBtn.className = 'me-btn';
meBtn.title = 'Учётная запись и оформление';
meBtn.addEventListener('click', () =>
  showMenu(meBtn, [
    ...(account.signedIn ? accountMenu(account, { notify: (m, k) => toast(m, k), signIn: () => void signIn(account) }) : [{ label: 'Войти…', run: () => void signIn(account) } as MenuEntry]),
    'sep',
    { label: 'Оформление', submenu: appearanceMenu },
  ]),
);
$('presence').before(meBtn);
const paintMe = () => {
  const name = account.user?.name || collab.me.name || '?';
  meBtn.innerHTML = `<span class="me-av" style="--c:${collab.me.color}">${name.trim().charAt(0).toUpperCase()}</span>${ICON.chevronDown}`;
  meBtn.hidden = collab.inRoom;
};
paintMe();
collab.onStatus = (text) => {
  openingStatus?.(text);
  const room = collab.mode === 'room';
  collabBtn.textContent = room ? (collab.connected ? 'В комнате' : 'Подключение…') : 'Поделиться';
  collabBtn.classList.toggle('live', room);
  collabBtn.title = room ? `${text}. Щелчок — выйти из комнаты` : collab.mode === 'file' ? `${text}. Щелчок — доступ к файлу` : 'Поделиться: загрузить файл на сервер или комната';
  renderPresence();
};
/** Avatars: click a participant to follow them (again to stop); click yourself to have everyone follow you. */
function renderPresence() {
  paintMe();
  // Left the room, so leave the call too.
  if (!collab.inRoom && voice.active) voice.leave();
  const people = collab.inRoom
    ? [{ id: collab.me.id, name: collab.me.name, color: collab.me.color, spotlight: collab.spotlight, voice: collab.voice ?? undefined, speaking: collab.speaking }, ...collab.people]
    : [];
  const voiceButtons: HTMLElement[] = [];
  if (collab.inRoom) {
    const btn = (icon: string, title: string, cls: string, run: () => void) => {
      const b = document.createElement('button');
      b.className = `voice-btn ${cls}`;
      b.innerHTML = icon;
      b.title = title;
      b.addEventListener('click', run);
      return b;
    };
    const talking = people.filter((p) => p.voice).length;
    if (!voice.active) voiceButtons.push(btn(ICON.mic, talking ? `Голос: присоединиться к разговору (говорят: ${talking})` : 'Голос: начать разговор', talking ? 'join live' : 'join', () => void voice.join()));
    else {
      voiceButtons.push(btn(voice.muted ? ICON.micOff : ICON.mic, voice.muted ? 'Включить микрофон' : 'Выключить микрофон', voice.muted ? 'muted' : 'on', () => voice.toggleMute()));
      voiceButtons.push(btn(ICON.hangup, 'Выйти из разговора', 'leave', () => voice.leave()));
    }
  }
  $('presence').replaceChildren(
    ...voiceButtons,
    ...people.slice(0, 8).map((p, i) => {
      const self = i === 0;
      const following = collab.following === p.id;
      const a = document.createElement('button');
      a.className = `avatar${following ? ' following' : ''}${p.spotlight ? ' spot' : ''}${p.voice ? ` voice ${p.voice}` : ''}${p.speaking ? ' speaking' : ''}`;
      a.style.background = p.color;
      a.style.setProperty('--c', p.color);
      a.textContent = (p.name.trim()[0] ?? '?').toUpperCase();
      a.title = (self
        ? `${p.name} (вы)${collab.spotlight ? ' — зовёте всех за собой' : ' — щелчок: позвать всех за собой'}`
        : following
          ? `Вы следуете за ${p.name} — щелчок или Esc: перестать`
          : `${p.name} — щелчок: следовать${p.spotlight ? ' (зовёт всех за собой)' : ''}`) + (p.voice ? (p.voice === 'muted' ? ' · в разговоре, микрофон выключен' : ' · в разговоре') : '');
      a.addEventListener('click', () => {
        if (!self && !collab.follow(following ? null : p.id)) toast('Нельзя следовать по замкнутой цепочке: участник уже следует за вами');
        else
          showMenu(a, [
            {
              label: collab.spotlight ? 'Перестать звать за собой' : 'Позвать всех за собой',
              run: () => {
                collab.setSpotlight(!collab.spotlight);
                renderPresence();
                toast(collab.spotlight ? 'Остальные следуют за вами: видят то же, что вы' : 'Больше не зовёте за собой');
              },
            },
          ]);
      });
      return a;
    }),
  );
}
// Following: a border in the participant's color around the canvas and a label.
const followLabel = document.createElement('span');
followLabel.className = 'follow-label';
const followFrame = document.createElement('div');
followFrame.className = 'follow-frame';
followFrame.hidden = true;
followFrame.append(followLabel);
$('stage').append(followFrame);
collab.onFollow = (p, reason) => {
  followFrame.hidden = !p;
  if (p) {
    followFrame.style.setProperty('--c', p.color);
    followLabel.textContent = `${reason === 'spotlight' ? `${p.name} зовёт всех за собой` : `Вы следуете за ${p.name}`} · Esc — перестать`;
  } else if (reason === 'left') toast('Участник вышел — следование закончилось');
  renderPresence();
};
// Cursor chat: “/”.
const cursorChat = new CursorChat(editor, collab, $('stage'));
// Team libraries: publishing, connecting, the “updates available” badge.
const teamLibs = new TeamLibraries(account, editor, $('stage'), {
  file: () => (files.remote ? { id: files.remote.id, role: files.remote.role, branch: !!files.remote.parentId } : null),
  notify: (m, k) => toast(m, k),
});
teamLibs.onChange.push(() => assets.setLibraryUpdates(teamLibs.outdated().length));
collab.onDocument = (doc, room, images) => {
  pluginHost?.stop();
  editor.setDocument(doc, undefined, images);
  rebindPlugins();
  void files.adopt(room, { source: `room:${room}`, reuse: true });
  editor.fitPage();
  updateChrome();
  toast(`Комната «${room}»: документ загружен`);
};
collab.onFile = (doc, file, images) => {
  // This document's comments come from the server (the source is set up before display: onPage waits for it).
  serverComments.set(doc, () => new ServerCommentStore(account, file.id, file.link, doc, () => (files.remote?.id === file.id ? files.remote.role : null)));
  pluginHost?.stop();
  exitPreview(false);
  editor.setDocument(doc, undefined, images);
  // Page permissions: edits to locked pages are not sent (and the server would not accept them).
  installPageGuard(doc, account, () => (files.remote?.id === file.id ? files.remote.role : null), (m) => toast(m, 'error'));
  rebindPlugins();
  files.openRemote(file, file.role);
  editor.fitPage();
  $('status').textContent = '';
  if (!canEdit(file.role)) toast(file.role === 'comment' ? 'Просмотр и комментарии: править файл нельзя' : 'Только просмотр');
  // How many library instances are in the file, for library authors (statistics).
  void teamLibs.report();
  openingFile?.(true);
};
collab.onRole = (role) => {
  if (files.remote) files.remote.role = role;
  toast(canEdit(role) ? 'Теперь вы можете править файл' : `Доступ к файлу изменён: ${role === 'comment' ? 'просмотр и комментарии' : 'только просмотр'}`);
  enforceRole();
  updateChrome();
};
collab.onError = (message, fatal) => {
  toast(message, 'error');
  if (!fatal) return;
  $('status').textContent = '';
  if (files.remote && files.remote.id === collab.file?.id) {
    files.remote.role = 'view';
    enforceRole();
    updateChrome();
  }
  openingFile?.(false);
};
collab.onLocalUpdate = () => files.remoteEdited();
collab.onEvent = (e) => {
  const ev = e as { type: string; branch?: { id: string; name: string }; main?: { name: string }; by?: string };
  if (ev.type === 'branch-merged') {
    toast(files.remote?.id === ev.branch?.id ? `Эта ветка слита в «${ev.main?.name ?? 'основной файл'}» (${ev.by ?? ''})` : `${ev.by ?? 'Кто-то'}: ветка «${ev.branch?.name ?? ''}» слита в этот файл`);
    return;
  }
  const store = comments.source;
  if (store instanceof ServerCommentStore && store.doc === editor.doc) store.event(e as CommentEvent);
};
/** Branches of the open server file. */
const openBranches = () => branchesDialog({ account, editor, current: () => files.remote?.id ?? null, open: (id) => openServerFile(id), notify: (m, k) => toast(m, k) });
collab.onRejoin = () => {
  const store = comments.source;
  if (store instanceof ServerCommentStore) void store.load();
};
collab.onLeave = () => {
  if (/(^|[#&])(file|room)=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
};

/** Name and color in collaboration: the account's when signed in, otherwise the name that was set. */
function setIdentity() {
  const u = account.user;
  collab.me.name = u?.name ?? (localStorage.getItem('mfp-name') || t('Гость'));
  if (u) collab.me.color = u.color;
}

/** The open page is protected and locked for editing by this person. */
const onLockedPage = () => !!files.remote && canEdit(files.remote.role) && pageLocked(editor.doc, editor.pageId, account, files.remote.role);

/**
 * Role in a server file: “can view” and “can comment” get developer mode with no way out of it; the same
 * applies on a protected page this person may not edit.
 */
function enforceRole() {
  const locked = onLockedPage();
  if (locked && !editor.devMode) toast('Страница защищена: только просмотр и комментарии — править её могут владелец файла и выбранные им люди');
  const ro = (!!files.remote && !canEdit(files.remote.role)) || locked;
  if (ro && !editor.devMode) {
    setDevMode(true, true);
    forcedDev = true;
  } else if (!ro && forcedDev) {
    forcedDev = false;
    if (editor.devMode) setDevMode(false, true);
  }
  if (ro && (editor.tool === 'annotate' || editor.tool === 'measure')) setTool('select');
}

/** Open a server file: check access, connect, show it with the role. true: opened. */
function openServerFile(id: string, link: string | null = null, name?: string): Promise<boolean> {
  if (serverOpening) return serverOpening.id === id ? serverOpening.promise : Promise.resolve(false);
  const loading = fileOpening(name);
  const fromHome = !!home?.isOpen;
  home?.close();
  openingStatus = text => loading.status(text);
  const promise = (async () => {
    try {
      await loading.painted();
      const opened = await loadServerFile(id, link);
      if (!opened && fromHome) home?.open();
      return opened;
    } catch (error) {
      toast(`Не удалось открыть файл: ${(error as Error).message}`, 'error');
      if (fromHome) home?.open();
      return false;
    } finally {
      openingStatus = null; loading.close(); serverOpening = null;
    }
  })();
  serverOpening = { id, promise };
  return promise;
}

async function loadServerFile(id: string, link: string | null): Promise<boolean> {
  // Warm the sync runtime in parallel with authentication and the access request.
  void loroReady().catch(() => {});
  await account.whenReady();
  if (!account.signedIn && !link && !(await signIn(account, 'Чтобы открыть файл с сервера, войдите.'))) return false;
  // Check access before disconnecting from the current file: without access nothing changes.
  let info: ServerFile;
  openingStatus?.('Проверяем доступ к файлу…');
  try {
    info = await account.api<ServerFile>('GET', `/api/files/${id}${link ? `?link=${encodeURIComponent(link)}` : ''}`);
  } catch (e) {
    toast(e instanceof ApiError && e.status === 404 ? 'Файл не найден или к нему нет доступа' : (e as Error).message, 'error');
    return false;
  }
  if (files.remote?.id === id && collab.mode === 'file' && collab.inRoom) return true;
  await files.leave();
  exitPreview(false);
  setIdentity();
  history.replaceState(null, '', `#file=${id}${link ? `&link=${encodeURIComponent(link)}` : ''}`);
  openingFile?.(false);
  const opened = new Promise<boolean>((resolve) => (openingFile = resolve));
  $('status').textContent = `Открываю «${info.name}»…`;
  void collab.connectFile(account.ws, id, account.token, link).catch(error => {
    toast(`Ошибка подключения: ${(error as Error).message}`, 'error');
    openingFile?.(false);
  });
  const ok = await opened;
  openingFile = null;
  return ok;
}

/** Document snapshot in Loro (a new file on the server). */
async function loroSnapshot(doc: Document): Promise<Uint8Array> {
  await loroReady();
  const bridge = new LoroBridge(doc);
  const bytes = bridge.loro.export({ mode: 'snapshot' });
  bridge.dispose();
  return bytes;
}

/** The document as a new file on the server: images first, then the snapshot, then the thumbnail. */
async function uploadDocument(doc: Document, name: string, projectId: string | null, readImage: (hash: string) => Promise<Uint8Array | undefined>, thumb: Blob | null, progress: ReturnType<typeof fileUpload>): Promise<ServerFile | null> {
  const status = $('status');
  status.textContent = `Загружаю «${name}» на сервер…`;
  try {
    await progress.status('Проверяем и загружаем изображения…');
    const missing = await account.uploadImages(imageHashes(doc), readImage, progress.images);
    await progress.status('Подготавливаем документ…');
    const snapshot = await loroSnapshot(doc);
    await progress.status(`Отправляем документ (${(snapshot.byteLength / 1048576).toFixed(1)} МБ)…`);
    const file = await account.createFile(name, projectId, snapshot);
    await progress.status('Сохраняем миниатюру…');
    if (thumb) await account.api('PUT', `/api/files/${file.id}/thumb`, thumb).catch(() => {});
    toast(`«${name}» — на сервере: ${account.projectLabel(projectId)}${missing ? `; не найдено картинок: ${missing}` : ''}`);
    return file;
  } catch (e) {
    toast(`Не удалось загрузить на сервер: ${(e as Error).message}`, 'error');
    return null;
  } finally {
    status.textContent = '';
  }
}

/** The open file goes to the server (ask where) and is reopened from there. */
async function uploadCurrent(): Promise<boolean> {
  const to = await chooseDestination(account, `Загрузить «${files.name}» на сервер`);
  if (to === undefined) return false;
  const progress = fileUpload(files.name);
  try {
    await progress.status('Сохраняем локальный файл…');
    const local = files.lib && !files.remote ? files.current.id : null;
    if (local) await files.leave();
    const thumb = local ? await files.lib!.thumbnail(local).catch(() => null) : null;
    const file = await uploadDocument(editor.doc, files.name, to, (h) => editor.store.readImage(h), thumb, progress);
    progress.close();
    return !!file && (await openServerFile(file.id));
  } catch (e) { toast(`Не удалось загрузить файл: ${(e as Error).message}`, 'error'); return false; }
  finally { progress.close(); }
}

/** A library file goes to the server (from “Files”). */
async function uploadLocal(id: string): Promise<boolean> {
  const meta = await files.lib?.get(id);
  if (!meta || !files.lib) return false;
  const to = await chooseDestination(account, `Загрузить «${meta.name}» на сервер`);
  if (to === undefined) return false;
  const progress = fileUpload(meta.name);
  try {
    await progress.status('Читаем локальный файл…');
    if (id === files.current.id) await files.leave();
    const r = await files.lib.readDocument(id);
    if (!r) {
      toast(`Файл «${meta.name}» не прочитать`, 'error');
      return false;
    }
    const file = await uploadDocument(r.doc, meta.name, to, (h) => r.images.readImage(h), await files.lib.thumbnail(id).catch(() => null), progress);
    if (file) home?.show(to ? { kind: 'project', id: to } : { kind: 'drafts' });
    return !!file;
  } catch (e) { toast(`Не удалось загрузить файл: ${(e as Error).message}`, 'error'); return false; }
  finally { progress.close(); }
}

/** A new empty file on the server (null: drafts), then open it. */
async function newServerFile(projectId: string | null) {
  try {
    const file = await account.createFile(t('Без названия'), projectId, await loroSnapshot(newDocument().doc));
    await openServerFile(file.id);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}
// Comments: the author is the collaboration participant's name (no accounts).
const comments = new Comments(
  editor,
  {
    me: () => ({ name: collab.me.name, named: account.signedIn || !!localStorage.getItem('mfp-name'), color: account.user?.color }),
    storeFor: (doc) => serverComments.get(doc)?.() ?? new LocalCommentStore(doc, () => collab.me.name),
    setName: (name) => {
      collab.me.name = name;
      localStorage.setItem('mfp-name', name);
    },
    notify: (m) => toast(m),
    exit: () => setTool('select'),
  },
  $('stage'),
  $('right'),
);

presentComments(() => comments.source);

// Accessibility: labels for icon buttons from their tooltips, high contrast (thicker selection borders),
// and the screen reader is told what is selected and which page is open.
labelIconButtons(document.body);
contrast.onChange.push((on) => editor.setHighContrast(on));
// Theme: the canvas selection color comes from its accent (classic and high contrast keep the old one).
appearance.onChange.push(() => editor.setAccent(canvasAccent));
contrast.onChange.push(() => appearance.refresh());
contrast.init();
appearance.init();
// First encounter with the new theme: how to get the old one back.
try {
  if (appearance.look === 'new' && !localStorage.getItem('mfp-ui-told')) {
    localStorage.setItem('mfp-ui-told', '1');
    setTimeout(() => toast('Новое оформление интерфейса. Вернуть прежнее: Меню → Вид → Оформление → Классическое'), 1200);
  }
} catch {
  // No storage: no hint.
}
let spoken = '';
editor.onSelection.push(() => {
  const text = describeSelection();
  if (text === spoken) return;
  spoken = text;
  announce(text);
});
const canvasLabel = () => editor.canvasEl.setAttribute('aria-label', `Холст, страница «${editor.doc.get(editor.pageId, 'name') ?? ''}»`);
editor.onPage.push(() => {
  canvasLabel();
  spoken = '';
});
canvasLabel();

/** Selection in words: type, name, size and position (for the screen reader). */
function describeSelection(): string {
  const sel = editor.selection;
  if (!sel.length) return 'Ничего не выделено';
  if (sel.length > 1) return `Выделено слоёв: ${sel.length}`;
  const id = sel[0]!;
  const doc = editor.doc;
  const type = doc.type(id)!;
  const b = editor.selectionBounds([id]);
  const size = b ? t(', {0} на {1}, X {2}, Y {3}', Math.round(b[2] - b[0]), Math.round(b[3] - b[1]), Math.round(b[0]), Math.round(b[1])) : '';
  const hidden = doc.get(id, 'visible') === false ? t(', скрыт') : '';
  return `${t(NODE_LABEL[type] ?? type)} «${doc.get(id, 'name') ?? ''}»${size}${hidden}`;
}

/** F6: next window region: canvas, layers, pages, properties, tools (Shift goes back). */
function cycleRegion(dir: 1 | -1) {
  const first = (root: HTMLElement | null) =>
    root?.querySelector<HTMLElement>('[tabindex="0"], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea') ?? null;
  const regions: { root: () => HTMLElement | null; target: () => HTMLElement | null }[] = [
    // The toolbar is inside the canvas area, so the canvas is identified by the element itself.
    { root: () => editor.canvasEl, target: () => editor.canvasEl },
    { root: () => $('layers'), target: () => first($('layers')) },
    { root: () => $('pages'), target: () => first($('pages')) },
    { root: () => $('right'), target: () => first(document.querySelector<HTMLElement>('#right .cpanel:not([hidden]), #right .history:not([hidden])') ?? $('properties')) ?? first($('right')) },
    { root: () => $('toolbar'), target: () => first($('toolbar')) },
  ];
  const a = document.activeElement;
  const at = regions.findIndex((r) => !!a && !!r.root()?.contains(a));
  for (let k = 1; k <= regions.length; k++) {
    const r = regions[(((at < 0 ? 0 : at) + dir * k) % regions.length + regions.length) % regions.length]!;
    const t = r.target();
    if (t) {
      t.focus();
      return;
    }
  }
}
collabBtn.addEventListener('click', () => {
  if (collab.mode === 'room') {
    collab.disconnect();
    collab.onStatus?.('Вышли из комнаты', 0);
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }
  const remote = files.remote;
  if (remote && account.signedIn) shareServerFile(account, remote.id, (m, k) => toast(m, k));
  else if (remote) void signIn(account, 'Чтобы поделиться файлом, войдите.').then((ok) => ok && shareServerFile(account, remote.id, (m, k) => toast(m, k)));
  else shareLocalFile(account, { name: files.name, notify: (m, k) => toast(m, k), upload: () => uploadCurrent(), room: joinRoom });
});
/** A room without accounts: ask for the room name and your own. */
function joinRoom() {
  const room = prompt('Комната (у всех участников — одинаковая):', collab.room || 'demo')?.trim();
  if (!room) return;
  if (!account.signedIn) {
    const name = prompt('Ваше имя для других участников:', collab.me.name)?.trim();
    if (name) localStorage.setItem('mfp-name', name);
  }
  setIdentity();
  history.replaceState(null, '', `#room=${encodeURIComponent(room)}`);
  void collab.connect(account.ws, room);
}
/** A #file=<id>[&link=<token>] link opens a server file, #room=name joins a room. */
function joinFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  // Return from company SSO: the session token (or an error) is in the URL; remove it from there right away.
  const sso = p.get('sso');
  const ssoError = p.get('sso_error');
  if (sso || ssoError) {
    history.replaceState(null, '', location.pathname + location.search);
    if (sso) void account.adopt(sso).then(() => toast(account.user ? `Вы вошли: ${whoIs(account.user.email)}` : 'Вход не удался', account.user ? 'info' : 'error'));
    else toast(`Вход через SSO не удался: ${ssoError}`, 'error');
    return;
  }
  const file = p.get('file');
  if (file) {
    const comment = p.get('comment');
    const node = p.get('node');
    const open = files.remote?.id === file && collab.mode === 'file' ? Promise.resolve(true) : openServerFile(file, p.get('link'));
    if (comment) void open.then(async (ok) => ok && !(await comments.reveal(comment)) && toast('Комментарий не найден — возможно, его удалили'));
    if (node) void open.then((ok) => ok && revealNode(node));
    // Presentation link (QR code for a phone): open the file and go straight to full-page presentation.
    if (p.get('present')) void open.then((ok) => ok && presentInPage(editor, () => files.name));
    return;
  }
  const room = p.get('room') ?? '';
  if (room && !(collab.inRoom && collab.room === room)) {
    setIdentity();
    void collab.connect(account.ws, room);
  }
}
window.addEventListener('hashchange', joinFromHash);

// “Back / forward” navigation through document locations: Alt+← / Alt+→ and the mouse side buttons.
const navigation = new Navigation(editor);
window.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  // Otherwise the browser would leave the page through its own history.
  e.preventDefault();
  if (e.button === 3) navigation.back();
  else navigation.forward();
});

// Custom fonts: from the computer (Local Font Access API, Chrome/Edge) and from .ttf, .otf, .woff, .woff2 files.
// The files are stored in OPFS (fonts/) and loaded at startup.
interface LocalFontData {
  family: string;
  style: string;
  blob(): Promise<Blob>;
}
async function loadLocalFonts(ask: boolean) {
  // Desktop: system fonts without a permission prompt.
  if (isDesktop) {
    try {
      const list = await disk.fonts();
      editor.fonts.addLocal(list.map((f) => ({ family: f.family, style: f.style, data: async () => (await disk.readFile(f.path)).slice().buffer })));
      if (ask) toast(`Шрифты компьютера: ${editor.fonts.localFamilies.length} семейств`);
      panels.schedule();
    } catch (e) {
      if (ask) toast(`Шрифты системы не прочитать: ${(e as Error).message}`, 'error');
    }
    return;
  }
  const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (!query) {
    if (ask) toast('Браузер не даёт доступа к шрифтам компьютера (нужен Chrome или Edge) — перетащите файлы шрифтов (.ttf, .otf, .woff, .woff2) на окно', 'error');
    return;
  }
  try {
    const list = await query.call(window);
    editor.fonts.addLocal(list.map((f) => ({ family: f.family, style: f.style, data: async () => (await f.blob()).arrayBuffer() })));
    if (ask) toast(`Шрифты компьютера: ${editor.fonts.localFamilies.length} семейств`);
    panels.schedule();
  } catch (e) {
    if (ask) toast(`Нет доступа к шрифтам компьютера: ${(e as Error).message}`, 'error');
  }
}
panels.onLocalFonts = () => void loadLocalFonts(true);
// Desktop: right away; in the browser, if access was already granted earlier (silently).
if (isDesktop) void loadLocalFonts(false);
else void navigator.permissions
  ?.query({ name: 'local-fonts' as PermissionName })
  .then((p) => {
    if (p.state === 'granted') void loadLocalFonts(false);
  })
  .catch(() => {});

const fontsDir = () => navigator.storage.getDirectory().then((root) => root.getDirectoryHandle('fonts', { create: true }));
async function addFontFiles(files: File[]) {
  for (const file of files) {
    const data = await file.arrayBuffer();
    const font = await editor.fonts.addFile(data, file.name);
    if (!font) {
      toast(`«${file.name}»: не получилось прочитать шрифт (нужен .ttf, .otf, .woff или .woff2)`, 'error');
      continue;
    }
    toast(`Шрифт «${font.family} ${font.style}» добавлен`);
    // Selected texts switch to this font right away.
    const texts = editor.selection.filter((id) => editor.doc.type(id) === 'TEXT');
    if (texts.length) editor.doc.transact(() => texts.forEach((id) => editor.doc.set(id, { fontName: { family: font.family, style: font.style }, textGlyphs: undefined })));
    try {
      const dir = await fontsDir();
      // The style is taken from the file name: WOFF2 does not let us read it from the file itself.
      const handle = await dir.getFileHandle(`${font.family} — ${font.style}.font`.replace(/[\\/:*?"<>|]/g, '_'), { create: true });
      const w = await handle.createWritable();
      await w.write(data);
      await w.close();
    } catch {
      // Without OPFS the font works until reload.
    }
  }
  panels.schedule();
}
void (async () => {
  try {
    const dir = await fontsDir();
    for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemFileHandle> }).values()) {
      await editor.fonts.addFile(await (await handle.getFile()).arrayBuffer(), handle.name.replace(/^.* — /, '').replace(/\.font$/, ''));
    }
  } catch {
    // OPFS unavailable: no custom font files.
  }
})();

// Files: the open file, working copy (autosave), versions, thumbnails, disk (desktop).
const files = await Files.create(editor, {
  show: (doc, _name, images) => {
    pluginHost?.stop();
    exitPreview(false);
    editor.setDocument(doc, undefined, images);
    rebindPlugins();
    editor.fitPage();
    updateChrome();
  },
  notify: (m, k) => toast(m, k),
  changed: () => {
    enforceRole();
    updateChrome();
  },
  remote: {
    rename: async (id, name) => void (await account.api('PATCH', `/api/files/${id}`, { name })),
    thumbnail: async (id, png) => void (await account.api('PUT', `/api/files/${id}/thumb`, png)),
  },
  saved: (ms) => {
    const st = $('status');
    if (!st.textContent || st.textContent.startsWith('Автосохранено')) st.textContent = `Автосохранено (${ms} мс)`;
  },
});
if (files.versions) files.versions.author = () => collab.me.name;
// File list (File → Files…) and version history (on the right).
const home = files.lib
  ? new Home(files.lib, {
      openId: async (id) => void (await files.openId(id)),
      openPath: (p) => openPath(p),
      newFile: (folder) => {
        void newFile(folder);
        home?.close();
      },
      importFiles: () => openFiles(),
      currentId: () => files.current.id,
      notify: (m, k) => toast(m, k),
      workspace: () => files.workspace,
      server: {
        account,
        openServer: (id, name) => openServerFile(id, null, name),
        newServerFile: (projectId) => newServerFile(projectId),
        upload: (id) => uploadLocal(id),
        share: (id) => shareServerFile(account, id, (m, k) => toast(m, k)),
        signIn: () => void signIn(account),
        renamed: (id, name) => {
          if (files.remote?.id !== id) return;
          files.current.name = name;
          updateChrome();
        },
        bell: () => notes.button('icon-btn'),
      },
    })
  : null;
// Notifications: mentions, replies, opened files; the bell at the top right and in “Files”.
const notes = new Notifications(account, {
  open: (fileId, thread) =>
    void (async () => {
      const ok = (files.remote?.id === fileId && collab.mode === 'file') || (await openServerFile(fileId));
      if (!ok) return;
      home?.close();
      if (thread && !(await comments.reveal(thread))) toast('Комментарий не найден — возможно, его удалили');
    })(),
  home: () => home?.open(),
  notify: (m, k) => toast(m, k),
});
// Notifications at the bottom of the section strip.
$('rail').append(notes.button('rail-bell'));
// Account: check sign-in once files exist (the handler touches the open file).
let lastUser: string | null = null;
account.onChange.push(() => {
  const user = account.user?.id ?? null;
  const switched = user !== lastUser;
  lastUser = user;
  setIdentity();
  collab.setToken(account.token);
  // Signed out while a server file (not opened via a link) is open: the connection was made as the previous sign-in, so close it.
  if (!account.signedIn && collab.mode === 'file' && !collab.file?.link) {
    collab.disconnect();
    collab.onStatus?.('Вы вышли', 0);
    if (files.remote) files.remote.role = 'view';
    enforceRole();
    toast('Вы вышли: файл с сервера остался на экране только для просмотра, без связи');
  }
  // Signed in (possibly as someone else) while a server file without a connection is on screen: reopen it.
  else if (switched && user && files.remote && collab.mode !== 'file') void openServerFile(files.remote.id);
  updateChrome();
});
void account.refresh();
if (isDesktop || new URLSearchParams(location.search).has('tabs')) {
  fileTabs = new FileTabs(files.lib, {
    current: () => ({ id: files.current.id, name: files.name, dirty: isDesktop && !!files.current.path && files.diskDirty }),
    open: (id, canReplace) => (id.startsWith('srv:') ? openServerFile(id.slice(4)) : files.openId(id, false, canReplace)),
    newFile: () => {
      void newFile();
      home?.close();
    },
    home: () => home,
    notify: (m) => toast(m),
  });
  home?.onToggle.push(() => fileTabs?.sync());
  presentTabs((id, name, url) => fileTabs?.openView(id, name, url));
}
const versionPanel = files.versions
  ? new HistoryPanel(
      files.versions,
      {
        fileId: () => (files.lib && !files.remote ? files.current.id : null),
        preview: (doc, label) => previewVersion(doc, label),
        compare: (versionId) => {
          const id = editor.selection.find((s) => editor.doc.has(s));
          if (!id) toast('Выделите фрейм, который нужно сравнить с этой версией');
          else void compareNode(id, versionId);
        },
        restore: (doc, label) => restoreVersion(doc, label),
        copyToNew: (doc, label) => copyVersion(doc, label),
        notify: (m, k) => toast(m, k),
      },
      $('right'),
    )
  : null;
void (async () => {
  // Desktop: files the app was launched with (double-click on .mfp / .fig).
  const paths = isDesktop ? await disk.startupPaths().catch(() => [] as string[]) : [];
  if (paths.length) for (const p of paths) await openPath(p);
  // Normal launch shows the file list. Explicit links and launches from Explorer keep their target.
  else if (/(^|[#&])room=/.test(location.hash) && editor.doc === initial.doc && editor.doc.undoDepth === 0) await files.start(() => editor.doc === initial.doc && editor.doc.undoDepth === 0);
  else if (!/(^|[#&])file=/.test(location.hash)) home?.open();
})()
  .catch((e) => console.error(e))
  // A room from a link comes after recovery: the recovered document goes into an empty room.
  .then(joinFromHash);
if (isDesktop) {
  // Startup report goes to the app output (desktop debugging).
  setTimeout(() => void disk.log(`запуск: файл «${files.name}», семейств шрифтов системы ${editor.fonts.localFamilies.length}, папка файлов ${files.workspace ?? "—"}, библиотека ${files.lib ? "есть" : "нет"}`).catch(() => {}), 4000);
  // Closing the window finishes writing files; files from Explorer get opened.
  void onWindowClose(
    () => files.leave(),
    () => confirmDialog('Не удалось сохранить изменения файла. Закрыть без сохранения?'),
    (paths) => void (async () => {
      for (const p of paths) await openPath(p);
    })(),
  );
  // Updates: silently 15 s after startup (no server or network: say nothing; without internet: do not check).
  setTimeout(() => void checkUpdates(true, true), 15_000);
  void onOpenPaths((paths) => void (async () => {
    for (const p of paths) await openPath(p);
  })());
}

/**
 * Where to get updates from: the company server (an app with a team server, even in a closed network),
 * then MFP releases on GitHub. The updater goes to the network by itself, bypassing the fetch guard, so
 * the choice is made only here.
 */
function updateEndpoints(auto: boolean): string[] {
  const list: string[] = [];
  if (!appMode.local && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(account.base)) list.push(`${account.base}/updates/latest.json`);
  // GitHub releases: automatically at startup only with “Check for updates” on; manually, also
  // only when internet is allowed.
  if (updatesCheck.on || (!auto && network.allowed)) list.push(GITHUB_UPDATES_URL);
  return list;
}

/** Desktop: check for an update; if there is one, ask, download, install and restart. */
async function checkUpdates(quiet: boolean, auto = false) {
  const endpoints = updateEndpoints(auto);
  if (!endpoints.length) {
    if (!quiet) toast(offlineMessage(), 'error');
    return;
  }
  try {
    const u = await findUpdate(endpoints);
    if (!u) {
      if (!quiet) toast('Установлена последняя версия');
      return;
    }
    const ok = await confirmDialog(`Доступна версия ${u.version}.${u.notes ? `\n\n${u.notes}` : ''}\n\nСкачать и установить? Приложение перезапустится, открытые файлы сохранятся.`, 'Обновление MFP');
    if (!ok) return;
    await files.leave();
    toast(`Загрузка версии ${u.version}…`);
    await u.install((p) => ($('status').textContent = `Обновление: ${Math.round(p * 100)}%`));
    await relaunch();
  } catch (e) {
    if (quiet) return;
    const text = String((e as Error)?.message ?? e);
    toast(/404|not found|endpoint/i.test(text) ? 'На сервере обновлений пока нет новых версий' : `Не удалось проверить обновления: ${text}`, 'error');
  }
}

// ---------- Viewing and restoring versions ----------

/** The current document while a version is being viewed. */
let live: { doc: Document; page: string; camera: { x: number; y: number; zoom: number }; images: ImageBytesSource } | null = null;
const banner = document.createElement('div');
banner.className = 'version-banner';
banner.hidden = true;
$('stage').append(banner);

/** Version images: from the open file's images, then from the working copy. */
function versionImages(): ImageBytesSource {
  const store = live?.images ?? editor.store;
  const id = files.current.id;
  return {
    readImage: async (hash) => (await store.readImage(hash)) ?? (files.lib ? (await files.lib.images(id)).readImage(hash) : undefined),
  };
}

async function previewVersion(doc: Document | null, label: string) {
  if (!doc) return exitPreview(true);
  if (!live) {
    // Before viewing, save the edits and capture them as a version (returning goes back to them).
    await files.autosave.flush();
    await files.versions?.snapshot('auto');
    live = { doc: editor.doc, page: editor.pageId, camera: { ...editor.camera }, images: editor.store };
  }
  files.autosave.paused = true;
  if (files.versions) files.versions.paused = true;
  const camera = { ...editor.camera };
  editor.setDocument(doc, doc.has(live.page) ? live.page : undefined, versionImages());
  editor.setCamera(camera);
  banner.replaceChildren(
    Object.assign(document.createElement('span'), { textContent: `Просмотр: ${label} — правки здесь не сохранятся` }),
    Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Восстановить', onclick: () => void restoreVersion(doc, label) }),
    Object.assign(document.createElement('button'), { textContent: 'Вернуться к текущей', onclick: () => void versionPanel?.back() }),
  );
  banner.hidden = false;
  updateChrome();
}

/** Exit version viewing (restoreLive brings back the current document). */
function exitPreview(restoreLive: boolean) {
  const l = live;
  live = null;
  banner.hidden = true;
  files.autosave.paused = false;
  if (files.versions) files.versions.paused = false;
  if (!l) return;
  if (restoreLive) {
    editor.setDocument(l.doc, l.page, l.images);
    editor.setCamera(l.camera);
    updateChrome();
  }
}

async function restoreVersion(doc: Document, label: string) {
  if (!live) {
    await files.autosave.flush();
    await files.versions?.snapshot('auto');
  }
  const camera = { ...editor.camera };
  const images = versionImages();
  const page = live?.page ?? editor.pageId;
  // Comments are not rolled back: a restored version gets the current ones.
  const current = live?.doc ?? editor.doc;
  exitPreview(false);
  pluginHost?.stop();
  if (current !== doc) transplantComments(current, doc);
  if (editor.doc !== doc) editor.setDocument(doc, doc.has(page) ? page : undefined, images);
  editor.setCamera(camera);
  rebindPlugins();
  files.versions?.attach(files.current.id, doc);
  files.autosave.markDirty();
  await files.versions?.snapshot('auto', undefined, `Восстановлено: ${label}`);
  updateChrome();
  toast(`Восстановлено: ${label}`);
}

async function copyVersion(doc: Document, label: string) {
  const images = versionImages();
  const name = `${files.name} — ${label}`;
  exitPreview(true);
  await files.leave();
  pluginHost?.stop();
  editor.setDocument(doc, undefined, images);
  rebindPlugins();
  editor.fitPage();
  await files.adopt(name, { source: 'version' });
  updateChrome();
  toast(`Копия версии — новый файл «${name}»`);
}

/** Open files (desktop: a dialog, web: a file picker). */
function openFiles() {
  if (!isDesktop) return openInput.click();
  void openDialog({ multiple: true, defaultPath: files.workspace ?? undefined }).then(async (paths) => {
    for (const p of paths) await openPath(p);
    home?.close();
  });
}

/** Desktop: open a file from disk (.mfp is the same library file, .fig is imported). */
async function openPath(path: string) {
  if (/\.mfp$/i.test(path)) {
    const known = await files.lib?.findBy('path', path);
    if (known && (await files.openId(known.id))) return;
    return load(openDiskFile(path), { path });
  }
  return load(openDiskFile(path), { source: `fig:${path}` });
}

// ---------- Notifications and status ----------

editor.notify = (m) => toast(m);

function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = document.createElement('div');
  el.className = kind === 'error' ? 'toast error' : 'toast';
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

function updateChrome() {
  $('zoom').innerHTML = `${Math.round(editor.camera.zoom * 100)}%${ICON.chevronDown}`;
  const name = document.getElementById('filename');
  const shown = `${files.name}${isDesktop && files.current.path && files.diskDirty ? ' •' : ''}`;
  if (name && name.textContent !== shown) name.textContent = shown;
  // Below the name: where the file lives (like the project under the file name).
  const where = files.remote ? 'На сервере' : files.current.path ? (files.current.path.split(/[\\/]/).slice(-2, -1)[0] ?? '') : files.current.folder ? folderName(files.current.folder) : 'Мои файлы';
  if ($('file-where').textContent !== where) $('file-where').textContent = where;
  // A server file without edit permission: a mark next to the name.
  const roleBadge = files.remote && !canEdit(files.remote.role) ? (files.remote.role === 'comment' ? 'комментарии' : 'просмотр') : '';
  let badge = document.getElementById('file-badge');
  if (roleBadge && !badge && name) {
    badge = document.createElement('span');
    badge.id = 'file-badge';
    badge.className = 'home-badge';
    name.after(badge);
  }
  if (badge) {
    badge.hidden = !roleBadge;
    badge.textContent = roleBadge;
  }
  let branchBtn = document.getElementById('branch-btn');
  if (!branchBtn && name) {
    branchBtn = document.createElement('button');
    branchBtn.id = 'branch-btn';
    branchBtn.className = 'branch-btn';
    branchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openBranches();
    });
    $('file-title').after(branchBtn);
  }
  if (branchBtn) {
    branchBtn.hidden = !files.remote;
    const inBranch = !!files.remote?.parentId;
    branchBtn.textContent = inBranch ? '⑂ ветка' : '⑂';
    branchBtn.classList.toggle('on', inBranch);
    branchBtn.title = inBranch ? 'Ветка: обновить из основного, слить, другие ветки' : 'Ветки файла';
  }
  const title = `${files.name} — MFP`;
  if (document.title !== title) {
    document.title = title;
    if (isDesktop) void setWindowTitle(title);
  }
  for (const g of TOOL_GROUPS) {
    const el = groupEls.get(g.id)!;
    const active = g.tools.find((t) => t.tool === editor.tool);
    if (active) groupCurrent.set(g.id, active);
    const cur = groupCurrent.get(g.id)!;
    el.root.classList.toggle('active', !!active);
    if (el.main.dataset.icon !== cur.icon) {
      el.main.innerHTML = ICON[cur.icon];
      el.main.dataset.icon = cur.icon;
    }
    el.main.title = cur.key ? `${cur.label} (${cur.key})` : cur.label;
    el.main.setAttribute('aria-pressed', String(!!active));
  }
  const stage = $('stage');
  stage.classList.toggle('tool-hand', editor.tool === 'hand' || tools.spaceHeld);
  stage.classList.toggle('tool-create', ['frame', 'slice', 'rect', 'ellipse', 'line', 'arrow', 'polygon', 'star', 'pen', 'pencil', 'brush'].includes(editor.tool));
  stage.classList.toggle('tool-text', editor.tool === 'text');
  stage.classList.toggle('tool-comment', editor.tool === 'comment');
  // Developer mode: only its tools, its own switcher, inspect instead of tabs.
  const dev = editor.devMode;
  document.body.classList.toggle('dev-mode', dev);
  const draw = drawMode && !dev;
  document.body.classList.toggle('draw-mode', draw);
  for (const g of TOOL_GROUPS) groupEls.get(g.id)!.root.hidden = dev ? !DEV_GROUPS.has(g.id) : draw ? !DRAW_GROUPS.has(g.id) : !DESIGN_GROUPS.has(g.id);
  document.getElementById('draw-btn')?.classList.toggle('on', draw);
  const devBtn = document.getElementById('dev-btn');
  devBtn?.classList.toggle('on', dev);
  devBtn?.setAttribute('aria-pressed', String(dev));
  document.getElementById('design-btn')?.classList.toggle('on', !dev && !draw);
  fileTabs?.sync();
}
editor.onCamera.push(updateChrome);
editor.onDocument.push(updateChrome);
editor.onSelection.push(updateChrome);
// Collapsed interface: on selection the right panel appears floating.
editor.onSelection.push(() => document.body.classList.toggle('has-sel', editor.selection.length > 0));
tools.onToolChange = updateChrome;

/** Tool groups available in developer mode. */
const DEV_GROUPS = new Set(['pointer', 'comment']);
/** “Drawing” mode and design mode: which tool groups are on the toolbar. */
const DRAW_GROUPS = new Set(['pointer', 'draw-pen', 'draw-pencil', 'draw-brush', 'draw-width', 'text', 'comment']);
const DESIGN_GROUPS = new Set(['pointer', 'frame', 'shapes', 'pen', 'text', 'comment']);
let drawMode = false;

/** Mode switcher on the toolbar: design, drawing, development. */
function setUiMode(mode: 'design' | 'draw' | 'dev') {
  if (mode === 'dev') {
    drawMode = false;
    setDevMode(true);
  } else {
    setDevMode(false);
    if (editor.devMode) return;
    drawMode = mode === 'draw';
    if (drawMode && !['pen', 'pencil', 'brush', 'width', 'select', 'hand', 'text', 'comment'].includes(editor.tool)) setTool('pencil');
  }
  updateChrome();
}
const DEV_TOOLS = new Set<Tool>(['select', 'hand', 'comment', 'annotate', 'measure']);

/** Developer mode: turn on or off. */
function setDevMode(on: boolean, quiet = false) {
  if (on === editor.devMode) return;
  if (!on && files.remote && !canEdit(files.remote.role)) {
    toast('Только просмотр: чтобы править, попросите у владельца доступ «может редактировать»');
    return;
  }
  if (!on && onLockedPage()) {
    toast('Страница защищена: править её могут владелец файла и выбранные им люди');
    return;
  }
  if (on) {
    if (textEditing.active) textEditing.commit();
    vectorTool.stopEdit(false);
    vectorTool.stopPencil();
    if (!DEV_TOOLS.has(editor.tool)) setTool('select');
  }
  devMode.set(on);
  pluginHost?.stop();
  widgets.rebind();
  if (!quiet) toast(on ? 'Режим разработчика: щелчок — слой, справа — код и свойства (Shift+D — назад)' : 'Режим дизайна');
}
devMode.onChange.push(() => {
  updateChrome();
  panels.schedule();
});

function setTool(t: Tool) {
  keyboardSelection.stop();
  // In developer mode, only its tools.
  if (editor.devMode && !DEV_TOOLS.has(t)) return;
  if ((t === 'annotate' || t === 'measure') && files.remote && !canEdit(files.remote.role)) {
    toast('Аннотации и измерения добавляет тот, у кого есть право на правку');
    return;
  }
  // In design mode annotations are visible by choice (the “View” menu); the tool shows them.
  if ((t === 'annotate' || t === 'measure') && !annotations.visible) annotations.toggle();
  vectorTool.stopEdit(false);
  vectorTool.stopPencil();
  shapeBuilder.stop();
  editor.tool = t;
  tools.prepareKeyboardCreation();
  if (t === 'pen') vectorTool.startPen();
  if (t === 'pencil') vectorTool.startPencil();
  if (t === 'brush') vectorTool.startPencil(true);
  // Comment mode: badges, a list on the right (over the version history if it is open).
  comments.setMode(t === 'comment');
  editor.canvasEl.style.cursor = '';
  editor.dirty = true;
  updateChrome();
  // The properties panel depends on the tool (frame presets, scale).
  panels.schedule();
}
// Zoom: menu.
const zoomBy = (f: number) => editor.zoomCenter(f);
const zoomTo = (z: number) => {
  const [cx, cy] = editor.screenToWorld(editor.viewW / 2, editor.viewH / 2);
  editor.setCamera({ zoom: z, x: cx - editor.viewW / 2 / z, y: cy - editor.viewH / 2 / z });
};
$('zoom').addEventListener('click', () => showMenu($('zoom'), zoomMenu()));

/** Zoom and view menu (top right): custom percentage, zoom levels, view toggles. */
function zoomMenu(): MenuEntry[] {
  const at = (z: number) => Math.abs(editor.camera.zoom - z) < 1e-6;
  return [
    {
      label: 'Масштаб, %',
      field: {
        value: `${Math.round(editor.camera.zoom * 100)}%`,
        submit: (v) => {
          const n = Number(v.replace(/[%\s]/g, '').replace(',', '.'));
          if (Number.isFinite(n) && n > 0) zoomTo(Math.min(256, Math.max(0.02, n / 100)));
        },
      },
    },
    { label: 'Увеличить', hint: 'Ctrl++', run: () => zoomBy(1.25) },
    { label: 'Уменьшить', hint: 'Ctrl+−', run: () => zoomBy(0.8) },
    { label: 'Показать всё', hint: 'Shift+1', run: () => editor.fitPage(true) },
    { label: 'К выделению', hint: 'Shift+2', disabled: !editor.selection.length, run: () => editor.fitRect(editor.selectionBounds(), 8, true) },
    { label: '50%', checked: at(0.5), run: () => zoomTo(0.5) },
    { label: '100%', hint: 'Shift+0', checked: at(1), run: () => editor.zoomTo100(true) },
    { label: '200%', checked: at(2), run: () => zoomTo(2) },
    'sep',
    ...viewToggles(),
  ];
}

/** View toggles shared by the zoom menu and the main menu's “View”. */
function viewToggles(): MenuEntry[] {
  return [
    {
      label: 'Предпросмотр пикселей',
      submenu: ([0, 1, 2] as const).map((v) => ({ label: v ? `${v}x` : 'Выключен', hint: v === 1 ? 'Ctrl+Alt+Y' : '', checked: editor.pixelPreview === v, run: () => setPixelPreview(v) })),
    },
    { label: 'Пиксельная сетка', hint: "Ctrl+'", checked: editor.pixelGrid, run: togglePixelGrid },
    { label: 'Привязка к пикселям', hint: "Ctrl+Shift+'", checked: editor.pixelSnap, run: togglePixelSnap },
    { label: 'Направляющие макета', hint: 'Shift+G', checked: layoutGrids.visible, run: () => layoutGrids.toggle() },
    { label: 'Линейки', hint: 'Shift+R', checked: rulers.visible, run: () => rulers.toggle() },
    { label: 'Контуры', hint: outlineHint(), checked: editor.outline, run: toggleOutline },
    { label: 'Курсоры участников', hint: 'Ctrl+Alt+\\', checked: !document.body.classList.contains('peer-cursors-off'), run: toggleCursors },
    { label: 'Подписи свойств', checked: !document.body.classList.contains('no-prop-labels'), run: togglePropLabels },
  ];
}

/** Labels above the right panel fields: on by default, remembered. */
function togglePropLabels() {
  const off = document.body.classList.toggle('no-prop-labels');
  try {
    localStorage.setItem('mfp.propLabels', off ? '0' : '1');
  } catch {
    /* will not be remembered */
  }
}
try {
  if (localStorage.getItem('mfp.propLabels') === '0') document.body.classList.add('no-prop-labels');
} catch {
  /* storage unavailable */
}

// ---------- Selection operations ----------

/**
 * Clipboard: subtree snapshots and their roots' world matrices (position on the page at copy time).
 * The world matrix is needed to paste the copy in the same place, even if the original was inside a frame.
 */
let clipboard: NodeRecord[][] = [];
let clipboardWorld: (Matrix | null)[] = [];
let clipboardPatterns: ClipboardPatterns = { nodes: [], aliases: {} };
let clipboardResources: ClipboardResources | undefined;
let clipboardOrigin = '';
let clipboardBlobs: string[] = [];
let clipboardImageStore: ImageBytesSource | null = null;
const clipboardDocKeys = new WeakMap<Document, string>();
function clipboardDocKey(doc: Document): string {
  let key = clipboardDocKeys.get(doc);
  if (!key) { key = crypto.randomUUID(); clipboardDocKeys.set(doc, key); }
  return key;
}

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];
/** Where to paste if exactly this container is selected (not into an instance). */
const PASTE_INTO = new Set(['FRAME', 'COMPONENT', 'SECTION']);
/** Top-level frames are placed to the right of the original when duplicated. */
const FRAME_LIKE = new Set(['FRAME', 'COMPONENT', 'SECTION', 'INSTANCE']);
const DUPLICATE_GAP = 40;

function snapshotSubtree(id: string): NodeRecord[] {
  const out: NodeRecord[] = [];
  const walk = (n: string) => {
    const rec = editor.doc.node(n)!;
    out.push(structuredClone(rec) as NodeRecord);
    for (const c of editor.doc.children(n)) walk(c);
  };
  walk(id);
  return out;
}

const worldOf = (id: string): Matrix => (id === editor.pageId ? IDENTITY : (editor.worldMatrix(id) as Matrix));

/**
 * Insert subtree copies into parent (at index and above in the layer order) with the given root matrices
 * in parent coordinates; return the ids of the new roots. The caller opens the transaction.
 */
function insertTrees(trees: NodeRecord[][], parent: string, index: number | undefined, locals: Matrix[]): string[] {
  const doc = editor.doc;
  const roots: string[] = [];
  const map = new Map<string, string>();
  const created: string[] = [];
  const fromClipboard = trees === clipboard;
  const sameDocument = !fromClipboard || clipboardOrigin === clipboardDocKey(doc);
  const patterns = fromClipboard ? clipboardPatterns : collectClipboardPatterns(doc, trees);
  trees.forEach((source, ti) => {
    const tree = prepareClipboardTree(source);
    const root = tree[0]!;
    const at = index === undefined ? undefined : index + ti;
    // A copy of a main component becomes its instance.
    if (sameDocument && root.type === 'COMPONENT' && doc.has(root.id) && doc.type(root.id) === 'COMPONENT') {
      const id = instantiate(doc, root.id, parent, locals[ti]!, at);
      map.set(root.id, id);
      roots.push(id);
      return;
    }
    tree.forEach((rec, i) => {
      const p = i === 0 ? parent : map.get(rec.parent!)!;
      const props = structuredClone(rec.props);
      delete props.preservedPatternSource;
      delete props.clipboardSource;
      if (i === 0) props.transform = locals[ti]!;
      const id = doc.create(rec.type, p, props, i === 0 ? at : undefined);
      map.set(rec.id, id);
      created.push(id);
      if (i === 0) roots.push(id);
    });
  });
  if (fromClipboard && clipboardResources) {
    // Duplicating a local master creates an instance, not a replacement master.
    if (sameDocument) for (const [from, to] of map) if (doc.type(from) === 'COMPONENT' && doc.type(to) === 'INSTANCE') map.set(from, from);
    const original = new Map([...map].map(([from, to]) => [to, from]));
    insertClipboardResources(doc, clipboardResources, map, clipboardOrigin, sameDocument);
    for (const id of created) doc.set(id, remapClipboardProps(doc.props(id), map, clipboardResources.swapProperties[original.get(id)!]));
  } else {
    insertClipboardPatterns(doc, patterns, map, sameDocument);
    for (const id of created) doc.set(id, remapPatternPaints(doc.props(id), map));
  }
  return roots;
}

/** Move nodes by (dx, dy) in page coordinates (parents may be rotated). */
function moveWorld(ids: string[], dx: number, dy: number) {
  if (!dx && !dy) return;
  const doc = editor.doc;
  for (const id of ids) {
    const w = editor.worldMatrix(id) as Matrix;
    doc.set(id, { transform: multiply(invert(worldOf(doc.parent(id)!)), [w[0], w[1], Math.round(w[2] + dx), w[3], w[4], Math.round(w[5] + dy)]) });
  }
}

const centerOf = (r: Rect): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

function copySelection() {
  const sel = editor.selection.filter((id) => editor.doc.has(id));
  if (!sel.length) return;
  clipboard = sel.map(snapshotSubtree);
  clipboardPatterns = collectClipboardPatterns(editor.doc, clipboard);
  clipboardResources = collectClipboardResources(editor.doc, clipboard);
  clipboardOrigin = clipboardDocKey(editor.doc);
  clipboardImageStore = editor.store;
  const blobKeys = new Set([...clipboard.flat(), ...clipboardResources.nodes].flatMap(n => [...blobRefs(n.props)]));
  clipboardBlobs = [...blobKeys].map(k => editor.doc.blob(k)).filter((v): v is string => !!v);
  clipboardWorld = sel.map((id) => editor.worldMatrix(id) as Matrix);
  toast(`Скопировано: ${clipboard.length}`);
  void writeSystemClipboard(clipboard, clipboardWorld);
}

/**
 * Copy also into the system clipboard (across tabs and documents): HTML with <!--(mfp)base64(/mfp)-->,
 * containing the layers, their positions on the page, paths from the geometry table and images (unless too large).
 */
async function writeSystemClipboard(trees: NodeRecord[][], worlds: (Matrix | null)[]) {
  if (!navigator.clipboard?.write) return;
  const { html, text } = await clipboardHtml(trees, worlds);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
  } catch {
    // No permission to write to the system clipboard: the internal copy remains.
  }
}

async function clipboardHtml(trees: NodeRecord[][], worlds: (Matrix | null)[] = []): Promise<{ html: string; text: string }> {
  const doc = editor.doc;
  const patterns = collectClipboardPatterns(doc, trees);
  const resources = collectClipboardResources(doc, trees);
  const origin = clipboardDocKey(doc);
  const imageStore = editor.store;
  const blobs: Record<string, string> = {};
  const hashes = new Set<string>();
  for (const tree of [...trees, resources.nodes])
    for (const rec of tree) {
      const p = rec.props;
      for (const k of blobRefs(p)) blobs[k] = doc.blob(k) ?? '';
      for (const hash of mediaHashes(p)) hashes.add(hash);
    }
  const images: Record<string, string> = {};
  let total = 0;
  for (const h of hashes) {
    const bytes = await imageStore.readImage(h);
    if (!bytes || total + bytes.length > 20 * 2 ** 20) continue;
    total += bytes.length;
    images[h] = toBase64(bytes);
  }
  const json = JSON.stringify({ format: 'mfp-clipboard', version: 1, trees, worlds, blobs, images, patterns, resources, origin });
  const html = `<meta charset="utf-8"><span data-mfp="<!--(mfp)${toBase64(new TextEncoder().encode(json))}(/mfp)-->"></span>`;
  const text = trees.map((t) => t[0]!.props.name ?? '').join('\n');
  return { html, text };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Paste from the system clipboard in MFP format (from this or another tab); false: no such format. */
async function pasteMfpClipboard(html: string, mode: PasteMode = 'normal'): Promise<boolean> {
  const m = /\(mfp\)([A-Za-z0-9+/=]+)\(\/mfp\)/.exec(html);
  if (!m) return false;
  try {
    const bin = atob(m[1]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const data = JSON.parse(new TextDecoder().decode(bytes)) as {
      format: string;
      patterns?: ClipboardPatterns;
      resources?: ClipboardResources;
      origin?: string;
      trees: NodeRecord[][];
      worlds?: (Matrix | null)[];
      blobs: Record<string, string>;
      images: Record<string, string>;
    };
    if (data.format !== 'mfp-clipboard') return false;
    const doc = editor.doc;
    // Images go into the store before the layers are inserted (otherwise the renderer would request them too early).
    await Promise.all(
      Object.values(data.images ?? {}).map((b64) => {
        const b = atob(b64);
        const img = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) img[i] = b.charCodeAt(i);
        return editor.store.add(img);
      }),
    );
    if (editor.doc !== doc) { toast('Файл сменился во время чтения буфера. Повторите вставку.'); return true; }
    clipboard = data.trees;
    clipboardPatterns = data.patterns ?? { nodes: [], aliases: {} };
    clipboardResources = data.resources;
    clipboardOrigin = data.origin ?? '';
    clipboardImageStore = null;
    clipboardBlobs = Object.values(data.blobs ?? {}).filter(Boolean);
    clipboardWorld = data.trees.map((_, i) => data.worlds?.[i] ?? null);
    doc.transact(() => {
      for (const data2 of Object.values(data.blobs ?? {})) if (data2) doc.putBlob(data2);
    });
    await paste(mode);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

type PasteMode = 'normal' | 'over' | 'replace' | 'here';

/**
 * Paste from the clipboard:
 * - normal (Ctrl+V): into a selected frame, at the previous coordinates relative to the parent
 *   (if it does not fit, centered in the frame); with a layer selected, next to it, above in the layer order;
 *   with no selection, at the same place on the page; if that place is not visible, in the center of the screen;
 * - over selection (Ctrl+Shift+V): above the selected layer, not inside it, aligned by the top-left corner;
 * - replace (Ctrl+Shift+R): in place of each selected layer (by its center), the layer itself is deleted;
 * - paste here (context menu): top-left corner at the point under the cursor.
 * The whole paste is one undo step.
 */
async function paste(mode: PasteMode = 'normal', at?: [number, number]) {
  if (!clipboard.length || editor.devMode) return;
  const doc = editor.doc;
  const copiedTrees = clipboard;
  const targetStore = editor.store;
  const sourceStore = clipboardImageStore;
  if (sourceStore && clipboardOrigin !== clipboardDocKey(doc)) {
    const hashes = new Set([...clipboard.flat(), ...(clipboardResources?.nodes ?? clipboardPatterns.nodes)].flatMap(n => [...mediaHashes(n.props)]));
    await Promise.all([...hashes].map(async hash => {
      const bytes = await sourceStore.readImage(hash);
      if (bytes) await targetStore.add(bytes);
    }));
    if (editor.doc !== doc || copiedTrees !== clipboard || editor.devMode) return;
  }
  for (const data of clipboardBlobs) doc.putBlob(data);
  const sel = editor.selection.filter((id) => doc.has(id) && editor.isOnPage(id));
  const worlds = clipboard.map((t, i) => clipboardWorld[i] ?? ((t[0]!.props.transform ?? IDENTITY) as Matrix));
  const toLocal = (parent: string) => worlds.map((w) => multiply(invert(worldOf(parent)), w));
  if ((mode === 'over' || mode === 'replace') && !sel.length) mode = 'normal';
  const roots = doc.transact(() => {
    if (mode === 'replace') {
      return sel.flatMap((s) => {
        const parent = doc.parent(s)!;
        const target = editor.selectionBounds([s])!;
        const ids = insertTrees(clipboard, parent, doc.children(parent).indexOf(s), toLocal(parent));
        const b = editor.selectionBounds(ids);
        if (b) moveWorld(ids, centerOf(target)[0] - centerOf(b)[0], centerOf(target)[1] - centerOf(b)[1]);
        doc.delete(s);
        return ids;
      });
    }
    if (mode === 'over') {
      const s = sel[0]!;
      const parent = doc.parent(s)!;
      const ids = insertTrees(clipboard, parent, doc.children(parent).indexOf(s) + 1, toLocal(parent));
      const target = editor.selectionBounds([s])!;
      const b = editor.selectionBounds(ids);
      if (b) moveWorld(ids, target[0] - b[0], target[1] - b[1]);
      return ids;
    }
    if (mode === 'here' && at) {
      // Into the frame under the cursor (except auto layout: there the paste goes on top).
      let parent = editor.pageId;
      for (const n of editor.scene.hitPath(at[0], at[1])) {
        const id = editor.scene.id(n)!;
        if (PASTE_INTO.has(doc.type(id) ?? '') && !isAutoLayout(doc, id) && doc.get(id, 'locked') !== true && acceptsChildren(doc, id)) parent = id;
      }
      const ids = insertTrees(clipboard, parent, undefined, toLocal(parent));
      const b = editor.selectionBounds(ids);
      if (b) moveWorld(ids, at[0] - b[0], at[1] - b[1]);
      return ids;
    }
    const copied = new Set(clipboard.map((t) => t[0]!.id));
    const frame = sel.length === 1 && PASTE_INTO.has(doc.type(sel[0]!) ?? '') && !copied.has(sel[0]!) && acceptsChildren(doc, sel[0]!) ? sel[0]! : null;
    let ids: string[];
    if (frame) {
      // Previous coordinates relative to the parent; along axes where it does not fit, centered in the frame.
      ids = insertTrees(clipboard, frame, undefined, clipboard.map((t) => (t[0]!.props.transform ?? IDENTITY) as Matrix));
      const fb = editor.selectionBounds([frame])!;
      const b = editor.selectionBounds(ids);
      if (b) {
        const fitsX = b[0] >= fb[0] && b[2] <= fb[2];
        const fitsY = b[1] >= fb[1] && b[3] <= fb[3];
        moveWorld(ids, fitsX ? 0 : centerOf(fb)[0] - centerOf(b)[0], fitsY ? 0 : centerOf(fb)[1] - centerOf(b)[1]);
      }
    } else if (sel.length) {
      const s = sel[sel.length - 1]!;
      const parent = doc.parent(s)!;
      ids = insertTrees(clipboard, parent, doc.children(parent).indexOf(s) + 1, toLocal(parent));
    } else {
      ids = insertTrees(clipboard, editor.pageId, undefined, worlds);
    }
    // The paste location is not visible on screen: use the center of the screen.
    const b = editor.selectionBounds(ids);
    const v = editor.viewportRect();
    if (b && (b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3])) moveWorld(ids, centerOf(v)[0] - centerOf(b)[0], centerOf(v)[1] - centerOf(b)[1]);
    return ids;
  }, 'clipboard');
  editor.select(roots);
}

/** The last duplication: from which layers and which copies (to repeat the offset). */
let lastDuplicate: { from: string[]; to: string[] } | null = null;

/**
 * Ctrl+D: a top-level frame goes to the right of the original, everything else on top of it.
 * Transform repeat: if the copies from the previous duplication (or Alt-drag) were moved,
 * rotated (around the pivot) or scaled and Ctrl+D is pressed again, the new copies
 * get the same transform relative to the previous ones: a step, a circular pattern, a growing row.
 */
function duplicate() {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id));
  if (!sel.length) return;
  let step: [number, number] | null = null;
  let delta: Matrix | null = null;
  const last = lastDuplicate;
  if (last && last.to.length === sel.length && last.to.every((id) => sel.includes(id)) && last.from.every((id) => doc.has(id))) {
    const a = editor.worldMatrix(last.from[0]!) as Matrix;
    const b = editor.worldMatrix(last.to[0]!) as Matrix;
    // The “original → copy” transform in page coordinates.
    const d = multiply(b, invert(a));
    const linear = Math.abs(d[0] - 1) > 1e-6 || Math.abs(d[1]) > 1e-6 || Math.abs(d[3]) > 1e-6 || Math.abs(d[4] - 1) > 1e-6;
    if (linear) delta = d;
    else if (Math.abs(d[2]) > 1e-6 || Math.abs(d[5]) > 1e-6) step = [d[2], d[5]];
  }
  const roots = doc.transact(() =>
    sel.flatMap((id) => {
      const parent = doc.parent(id)!;
      const ids = insertTrees([snapshotSubtree(id)], parent, doc.children(parent).indexOf(id) + 1, [(doc.get(id, 'transform') ?? IDENTITY) as Matrix]);
      if (delta) {
        const parentWorld = (parent === editor.pageId ? IDENTITY : editor.worldMatrix(parent)) as Matrix;
        for (const nid of ids) doc.set(nid, { transform: multiply(invert(parentWorld), multiply(delta, editor.worldMatrix(nid) as Matrix)) });
      } else if (step) moveWorld(ids, step[0], step[1]);
      else if (parent === editor.pageId && FRAME_LIKE.has(doc.type(id) ?? '')) {
        // To the right of the original, in free space among the top-level frames.
        const own = editor.selectionBounds([id])!;
        const others = doc.children(editor.pageId).filter((k) => k !== id && !ids.includes(k)).map((k) => editor.selectionBounds([k])!);
        let x = own[2] + DUPLICATE_GAP;
        const w = own[2] - own[0];
        for (let guard = 0; guard < 100; guard++) {
          const hit = others.find((o) => o[0] < x + w && o[2] > x && o[1] < own[3] && o[3] > own[1]);
          if (!hit) break;
          x = hit[2] + DUPLICATE_GAP;
        }
        moveWorld(ids, x - own[0], 0);
      }
      return ids;
    }),
  );
  lastDuplicate = { from: sel, to: roots };
  editor.select(roots);
}

/** Copies for Alt-drag: in place of the originals, above in the layer order (the copies are dragged, the originals stay). */
function duplicateInPlace(ids: string[]): string[] {
  const doc = editor.doc;
  const roots = ids.flatMap((id) => {
    const parent = doc.parent(id)!;
    return insertTrees([snapshotSubtree(id)], parent, doc.children(parent).indexOf(id) + 1, [(doc.get(id, 'transform') ?? IDENTITY) as Matrix]);
  });
  lastDuplicate = { from: ids, to: roots };
  return roots;
}

/**
 * “Move to page”: the selection (minus anything nested in the selection) goes to another
 * page, at the same place in page coordinates. Comments on the layers travel with them.
 * Layers inside an instance are not moved (an instance is a copy of a component).
 */
function moveToPage(target: string) {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id));
  const roots = sel.filter((id) => {
    for (let p = doc.parent(id); p; p = doc.parent(p)) if (sel.includes(p)) return false;
    return true;
  });
  const inInstance = (id: string) => {
    for (let p = doc.parent(id); p; p = doc.parent(p)) if (doc.type(p) === 'INSTANCE') return true;
    return false;
  };
  const movable = roots.filter((id) => !inInstance(id));
  if (!movable.length || target === editor.pageId || !doc.has(target)) {
    if (roots.length) toast('Слои внутри инстанса не переносятся: сначала отсоедините инстанс');
    return;
  }
  const worlds = movable.map((id) => editor.worldMatrix(id) as Matrix);
  doc.transact(() => {
    movable.forEach((id, i) => {
      doc.move(id, target);
      doc.set(id, { transform: worlds[i]! });
    });
  });
  editor.select([]);
  const skipped = roots.length - movable.length;
  toast(`Перенесено на страницу «${doc.get(target, 'name') ?? ''}»: ${movable.length}${skipped ? ` (внутри инстанса не перенесено: ${skipped})` : ''}. Отменить — Ctrl+Z`);
}

/**
 * Link to the selected layer (Ctrl+L): a server file
 * plus #node; the link opens the file at this layer. A file that exists only on this device has no link.
 */
function copyNodeLink(target?: string) {
  const id = target ?? editor.selection.find((s) => editor.doc.has(s));
  if (!id) return;
  const page = editor.doc.type(id) === 'PAGE';
  if (!files.remote) {
    toast(`Ссылка на ${page ? 'страницу' : 'слой'} есть у файлов на сервере: «Поделиться» → загрузить на сервер`);
    return;
  }
  const url = `${account.fileUrl(files.remote.id)}&node=${encodeURIComponent(id)}`;
  void navigator.clipboard.writeText(url).then(
    () => toast(page ? 'Ссылка на страницу скопирована' : 'Ссылка на слой скопирована'),
    () => toast('Не удалось скопировать ссылку', 'error'),
  );
}

/** Show the layer from a link: its page, selection, fit to window. */
function revealNode(id: string) {
  const doc = editor.doc;
  if (!doc.has(id)) {
    toast('Слой из ссылки не найден — возможно, его удалили');
    return;
  }
  let page: string | null = id;
  while (page && doc.type(page) !== 'PAGE') page = doc.parent(page);
  if (page && page !== editor.pageId) editor.setPage(page);
  // A link to a page: open the whole page.
  if (page === id) {
    editor.fitPage(true);
    return;
  }
  editor.select([id]);
  editor.fitRect(editor.selectionBounds([id]), 40, true);
}

/** Style properties for Ctrl+Alt+C / Ctrl+Alt+V (without size and position). */
const STYLE_KEYS = ['fills', 'strokes', 'strokeWeight', 'strokeAlign', 'strokeJoin', 'dashPattern', 'effects', 'opacity', 'blendMode', 'cornerRadius'] as const;
const TEXT_STYLE_KEYS = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'textAlignHorizontal', 'textAlignVertical'] as const;
let propsClipboard: { props: Props; text: boolean } | null = null;

function copyProperties() {
  const doc = editor.doc;
  const id = editor.selection.find((s) => doc.has(s));
  if (!id) return;
  const props: Props = {};
  const text = doc.type(id) === 'TEXT';
  for (const k of [...STYLE_KEYS, ...(text ? TEXT_STYLE_KEYS : [])]) {
    const v = doc.get(id, k);
    if (v !== undefined) (props as Record<string, unknown>)[k] = structuredClone(v);
  }
  propsClipboard = { props, text };
  toast('Свойства скопированы');
}

function pasteProperties() {
  const doc = editor.doc;
  const clip = propsClipboard;
  const sel = editor.selection.filter((s) => doc.has(s));
  if (!clip || !sel.length) return;
  const corner = new Set(['RECTANGLE', 'FRAME', 'COMPONENT', 'INSTANCE']);
  doc.transact(() => {
    for (const id of sel) {
      const props: Props = {};
      for (const [k, v] of Object.entries(clip.props)) {
        if (TEXT_STYLE_KEYS.includes(k as (typeof TEXT_STYLE_KEYS)[number]) && doc.type(id) !== 'TEXT') continue;
        if (k === 'cornerRadius' && !corner.has(doc.type(id) ?? '')) continue;
        (props as Record<string, unknown>)[k] = structuredClone(v);
      }
      doc.set(id, props);
    }
  });
}

function deleteSelection() {
  const doc = editor.doc;
  doc.transact(() => {
    for (const id of editor.selection) if (doc.has(id)) doc.delete(id);
  });
}

/** Arrow key nudge step (Settings → Nudge step): small and with Shift. */
const nudgeStep = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('mfp.nudge') ?? 'null') as { small?: number; big?: number } | null;
    return { small: v?.small && v.small > 0 ? v.small : 1, big: v?.big && v.big > 0 ? v.big : 10 };
  } catch {
    return { small: 1, big: 10 };
  }
})();

function editNudge() {
  const ask = (text: string, now: number) => {
    const v = Number(String(prompt(text, String(now)) ?? '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const small = ask('Шаг сдвига стрелками, px', nudgeStep.small);
  if (small === null) return;
  const big = ask('Шаг сдвига с Shift, px', nudgeStep.big);
  if (big === null) return;
  nudgeStep.small = small;
  nudgeStep.big = big;
  try {
    localStorage.setItem('mfp.nudge', JSON.stringify(nudgeStep));
  } catch {
    /* will not be remembered */
  }
  toast(`Шаг сдвига: ${small} px, с Shift — ${big} px`);
}

function nudge(dx: number, dy: number) {
  const doc = editor.doc;
  doc.transact(() => {
    for (const id of editor.selection) {
      if (layerLocked(doc, id)) continue;
      const t = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
      doc.set(id, { transform: [t[0], t[1], t[2] + dx, t[3], t[4], t[5] + dy] });
    }
  });
}

/** Selected siblings of the first selected layer (only a common parent can be wrapped). */
function selectedSiblings(): string[] {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id));
  if (!sel.length) return [];
  const parent = doc.parent(sel[0]!);
  return sel.filter((id) => doc.parent(id) === parent);
}

/** Wrap the selected siblings in a new node (group, frame) in place of the topmost one. */
function wrapSelection(type: 'GROUP' | 'FRAME', props: Props): string | null {
  const doc = editor.doc;
  const sel = selectedSiblings();
  if (!sel.length) return null;
  const g = doc.transact(() => wrapNodes(doc, sel, editor.pageId, (id) => editor.worldMatrix(id) as Matrix, editor.selectionBounds(sel)!, type, props));
  editor.select([g]);
  return g;
}

function group() {
  wrapSelection('GROUP', { name: 'Group' });
}

/** Ctrl+Alt+G: wrap the selection in a frame (no fill or clipping, so the appearance does not change). */
function frameSelection() {
  wrapSelection('FRAME', { name: 'Frame', fills: [], clipsContent: false });
}

/**
 * Ctrl+Alt+M: the bottom selected layer becomes the mask, all go into a “Mask group”.
 * For a single layer, toggle the mask flag (it masks the layers above it in the same parent).
 */
function useAsMask() {
  const doc = editor.doc;
  const sel = selectedSiblings();
  if (!sel.length) return;
  if (sel.length === 1) {
    doc.set(sel[0]!, { isMask: doc.get(sel[0]!, 'isMask') !== true });
    return;
  }
  const order = doc.children(doc.parent(sel[0]!)!);
  const bottom = [...sel].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]!;
  const g = doc.transact(() => {
    doc.set(bottom, { isMask: true });
    return wrapNodes(doc, sel, editor.pageId, (id) => editor.worldMatrix(id) as Matrix, editor.selectionBounds(sel)!, 'GROUP', { name: 'Mask group' });
  });
  editor.select([g]);
}

/** Ctrl+Shift+H / Ctrl+Shift+L: hide or show, lock or unlock the selection. */
function toggleSelection(key: 'visible' | 'locked') {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id));
  if (!sel.length) return;
  const value = key === 'visible' ? sel.every((id) => doc.get(id, 'visible') === false) : !sel.every((id) => doc.get(id, 'locked') === true);
  doc.transact(() => {
    for (const id of sel) doc.set(id, { [key]: value });
  });
  toast(key === 'visible' ? (value ? 'Показано' : 'Скрыто') : value ? 'Заблокировано' : 'Разблокировано');
}

/** Layers that can be selected: visible and unlocked. */
const selectable = (id: string) => editor.doc.get(id, 'visible') !== false && !layerLocked(editor.doc, id);
const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'SECTION', 'BOOLEAN_OPERATION']);

/** Enter: select children. */
function selectChildren() {
  const doc = editor.doc;
  const kids = editor.selection.flatMap((id) => (CONTAINERS.has(doc.type(id) ?? '') ? doc.children(id) : [])).filter(selectable);
  if (kids.length) editor.select(kids);
}

/** Shift+Enter: select parents. */
function selectParents() {
  const doc = editor.doc;
  const parents = [...new Set(editor.selection.map((id) => doc.parent(id)))].filter((p): p is string => !!p && p !== editor.pageId && doc.type(p) !== 'PAGE');
  if (parents.length) editor.select(parents);
}

/** Tab / Shift+Tab: next / previous sibling in the layer list (top to bottom). */
function selectSibling(step: 1 | -1) {
  const doc = editor.doc;
  const id = editor.selection[editor.selection.length - 1];
  if (!id || !doc.has(id)) return;
  // In the model children go bottom to top, while the layer list goes top to bottom.
  const list = [...doc.children(doc.parent(id)!)].reverse().filter((k) => k === id || selectable(k));
  const i = list.indexOf(id);
  editor.select([list[(i + step + list.length) % list.length]!]);
}

/** Ctrl+A: all siblings of the selection (inside a frame); with no selection, the top level of the page. */
function selectAllSiblings() {
  const doc = editor.doc;
  const first = editor.selection.find((id) => doc.has(id));
  const parent = first ? doc.parent(first)! : editor.pageId;
  editor.select(doc.children(parent).filter(selectable));
}

/** Ctrl+Shift+A: invert the selection among siblings. */
function selectInverse() {
  const doc = editor.doc;
  const first = editor.selection.find((id) => doc.has(id));
  const parent = first ? doc.parent(first)! : editor.pageId;
  const sel = new Set(editor.selection);
  editor.select(doc.children(parent).filter((id) => !sel.has(id) && selectable(id)));
}

type SameKind = 'matching' | 'fill' | 'stroke' | 'effect' | 'font' | 'instance';

/**
 * Select similar layers on the page. “Matching” (Ctrl+Alt+A): same type and same name,
 * like repeated list items; the others: same fill, stroke, effects, font,
 * or instances of the same component.
 */
function selectSame(kind: SameKind) {
  const doc = editor.doc;
  const ref = editor.selection.find((id) => doc.has(id));
  if (!ref) return;
  const key = (id: string): string | null => {
    switch (kind) {
      case 'matching':
        return `${doc.type(id)}|${doc.get(id, 'name')}`;
      case 'fill':
        return JSON.stringify(doc.get(id, 'fills') ?? []);
      case 'stroke':
        return (doc.get(id, 'strokes') ?? []).length ? JSON.stringify([doc.get(id, 'strokes'), doc.get(id, 'strokeWeight')]) : null;
      case 'effect':
        return (doc.get(id, 'effects') ?? []).length ? JSON.stringify(doc.get(id, 'effects')) : null;
      case 'font':
        return doc.type(id) === 'TEXT' ? JSON.stringify([doc.get(id, 'fontName'), doc.get(id, 'fontSize')]) : null;
      case 'instance':
        return doc.type(id) === 'INSTANCE' ? (doc.get(id, 'componentId') ?? null) : null;
    }
  };
  const want = key(ref);
  if (want === null) return toast('У выделенного слоя нет такого свойства');
  const found = [...doc.descendants(editor.pageId)].filter((id) => selectable(id) && key(id) === want);
  editor.select(found);
  toast(`Выделено: ${found.length}`);
}

/** Digits set opacity: 1 is 10%, 0 is 100%; two digits in a row give an exact value (4, 5 → 45%). */
let lastDigit: { d: number; at: number } | null = null;
function opacityKey(d: number) {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id));
  if (!sel.length) return;
  const now = performance.now();
  const pct = lastDigit && now - lastDigit.at < 600 ? lastDigit.d * 10 + d : d === 0 ? 100 : d * 10;
  lastDigit = lastDigit && now - lastDigit.at < 600 ? null : { d, at: now };
  doc.transact(() => {
    for (const id of sel) doc.set(id, { opacity: Math.max(0, Math.min(100, pct)) / 100 });
  });
}

/** Shift+A: for a frame without layout, turn on auto layout; otherwise wrap the selection in a new frame with it. */
function addAutoLayout() {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id));
  if (!sel.length) return;
  const t = doc.type(sel[0]!);
  if (sel.length === 1 && (t === 'FRAME' || t === 'COMPONENT') && !isAutoLayout(doc, sel[0]!)) {
    doc.transact(() => enableAutoLayout(doc, sel[0]!));
    return;
  }
  // Only siblings (a common parent) can be wrapped.
  const parent = doc.parent(sel[0]!);
  const siblings = sel.filter((id) => doc.parent(id) === parent);
  const frame = doc.transact(() => wrapInAutoLayout(doc, siblings, editor.pageId, (id) => editor.worldMatrix(id) as Matrix, editor.selectionBounds(siblings)!));
  editor.select([frame]);
}

const BOOLEAN_NAMES = { UNION: 'Union', SUBTRACT: 'Subtract', INTERSECT: 'Intersect', EXCLUDE: 'Exclude' } as const;

/** Boolean operation on the selected siblings (Alt+Shift+U/S/I/E); for a boolean group, change the operation. */
function booleanOp(op: keyof typeof BOOLEAN_NAMES) {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id) && doc.type(id) !== 'TEXT');
  if (!sel.length) return;
  if (sel.length === 1 && doc.type(sel[0]!) === 'BOOLEAN_OPERATION') {
    doc.set(sel[0]!, { booleanOperation: op, name: BOOLEAN_NAMES[op] });
    return;
  }
  const parent = doc.parent(sel[0]!);
  const siblings = sel.filter((id) => doc.parent(id) === parent);
  const order = doc.children(parent!);
  const bottom = [...siblings].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]!;
  // The result is styled like the bottom operand.
  const g = doc.transact(() =>
    wrapNodes(doc, siblings, editor.pageId, (id) => editor.worldMatrix(id) as Matrix, editor.selectionBounds(siblings)!, 'BOOLEAN_OPERATION', {
      name: BOOLEAN_NAMES[op],
      booleanOperation: op,
      fills: doc.get(bottom, 'fills'),
      strokes: doc.get(bottom, 'strokes'),
      strokeWeight: doc.get(bottom, 'strokeWeight'),
    }),
  );
  editor.select([g]);
}

/** “Flatten” (Ctrl+E): the layer becomes a vector with its final shape. */
/** Flip the selection around its own center (Shift+H / Shift+V). */
function flipSelection(sx: number, sy: number) {
  const doc = editor.doc;
  doc.transact(() => {
    for (const id of editor.selection) {
      const t = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
      const w = doc.get(id, 'width') ?? 0;
      const h = doc.get(id, 'height') ?? 0;
      doc.set(id, { transform: multiply(t, [sx, 0, sx < 0 ? w : 0, 0, sy, sy < 0 ? h : 0]) as Matrix });
    }
  });
}

function flatten() {
  const doc = editor.doc;
  const out: string[] = [];
  doc.transact(() => {
    for (const id of editor.selection) {
      const t = doc.type(id);
      if (!doc.has(id) || t === 'TEXT' || t === 'VECTOR' || t === 'FRAME' || t === 'SECTION') continue;
      const svg = editor.scene.flattenSvg(id);
      if (!svg) continue;
      const parent = doc.parent(id)!;
      const index = doc.children(parent).indexOf(id);
      const p = doc.props(id);
      const v = doc.create(
        'VECTOR',
        parent,
        {
          name: p.name,
          transform: p.transform,
          width: p.width,
          height: p.height,
          opacity: p.opacity,
          fills: p.fills,
          strokes: p.strokes,
          strokeWeight: p.strokeWeight,
          effects: p.effects,
          vectorPaths: [{ windingRule: 'NONZERO', data: svg }],
          geometrySize: { width: p.width ?? 0, height: p.height ?? 0 },
        },
        index,
      );
      doc.delete(id);
      out.push(v);
    }
  });
  if (out.length) editor.select(out);
}

/**
 * Styling of the selected texts as a whole (Ctrl+B / I / U, Ctrl+Shift+X, lists) without editing
 * the text. toggle: if all runs already have it, remove it, otherwise apply it to all.
 */
function styleSelectedTexts(test: (s: EffectiveTextStyle) => boolean, make: (s: EffectiveTextStyle, on: boolean) => TextStyle, paragraph = false): boolean {
  const doc = editor.doc;
  const ids = editor.selection.filter((id) => doc.type(id) === 'TEXT');
  if (!ids.length || ids.length !== editor.selection.length) return false;
  const all = ids.every((id) => {
    const p = doc.props(id);
    const len = (p.characters ?? '').length;
    return textSegments(p.textRuns, Math.max(1, len)).every((s) => test(effectiveStyle(p, s.style)));
  });
  doc.transact(() => {
    for (const id of ids) restyleText(doc, id, 0, (doc.get(id, 'characters') ?? '').length, (s) => make(s, !all), paragraph);
  });
  for (const id of ids) for (const f of textFonts(doc.props(id))) void editor.fonts.ensure(f);
  return true;
}

/** Styling toggles for the selected texts, for keys and the “Text” menu. */
const TEXT_TOGGLES = {
  bold: () => styleSelectedTexts((s) => styleWeight(s.fontName.style).weight >= 600, (s, on) => ({ fontName: { family: s.fontName.family, style: toggleBold(s.fontName.style, on) } })),
  italic: () => styleSelectedTexts((s) => styleWeight(s.fontName.style).italic, (s, on) => ({ fontName: { family: s.fontName.family, style: toggleItalic(s.fontName.style, on) } })),
  underline: () => styleSelectedTexts((s) => s.textDecoration === 'UNDERLINE', (_s, on) => ({ textDecoration: on ? 'UNDERLINE' : 'NONE' })),
  strike: () => styleSelectedTexts((s) => s.textDecoration === 'STRIKETHROUGH', (_s, on) => ({ textDecoration: on ? 'STRIKETHROUGH' : 'NONE' })),
  ordered: () => styleSelectedTexts((s) => s.listType === 'ORDERED', (_s, on) => ({ listType: on ? 'ORDERED' : 'NONE' }), true),
  bullets: () => styleSelectedTexts((s) => s.listType === 'UNORDERED', (_s, on) => ({ listType: on ? 'UNORDERED' : 'NONE' }), true),
};

/**
 * Eyedropper (I): a color from the screen becomes the fill of the selected layers (for text and shapes
 * the first solid fill is replaced, otherwise one is added). EyeDropper API: Chrome, Edge, desktop.
 */
async function eyedropper() {
  const Ctor = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (!Ctor) return toast('Пипетка не поддерживается этим браузером');
  const ids = editor.selection.filter((id) => editor.doc.has(id));
  if (!ids.length) return toast('Выделите слой — пипетка зальёт его выбранным цветом');
  let hex: string;
  try {
    hex = (await new Ctor().open()).sRGBHex;
  } catch {
    return; // Esc cancels
  }
  const m = /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return;
  const v = parseInt(m[1]!, 16);
  const color = { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
  const doc = editor.doc;
  doc.transact(() => {
    for (const id of ids) {
      if (!doc.has(id)) continue;
      const fills = [...(doc.get(id, 'fills') ?? [])];
      const i = fills.map((f) => f.type).lastIndexOf('SOLID');
      if (i >= 0) fills[i] = { ...fills[i]!, type: 'SOLID', color } as (typeof fills)[number];
      else fills.push({ type: 'SOLID', color });
      doc.set(id, { fills });
    }
  });
}

/**
 * “Outline stroke” (Ctrl+Alt+O): the stroke becomes a vector filled with the stroke paints.
 * A layer without a fill is replaced by it; one with a fill stays, without the stroke, under the new vector.
 */
function outlineStroke() {
  const doc = editor.doc;
  const out: string[] = [];
  doc.transact(() => {
    for (const id of editor.selection) {
      if (!doc.has(id) || doc.type(id) === 'TEXT') continue;
      const p = doc.props(id);
      if (!(p.strokes ?? []).some((s) => s.visible !== false)) continue;
      const o = editor.scene.strokeOutline(id);
      if (!o) continue;
      const parent = doc.parent(id)!;
      const index = doc.children(parent).indexOf(id);
      const t = (p.transform ?? [1, 0, 0, 0, 1, 0]) as Matrix;
      const hasFill = (p.fills ?? []).some((f) => f.visible !== false);
      const v = doc.create(
        'VECTOR',
        parent,
        {
          name: p.name,
          transform: [t[0], t[1], t[2] + t[0] * o.x + t[1] * o.y, t[3], t[4], t[5] + t[3] * o.x + t[4] * o.y],
          width: o.width,
          height: o.height,
          opacity: p.opacity,
          blendMode: p.blendMode,
          fills: p.strokes,
          strokes: [],
          effects: hasFill ? [] : p.effects,
          constraints: p.constraints,
          vectorPaths: [{ windingRule: o.windingRule, data: o.svg }],
          geometrySize: { width: o.width, height: o.height },
          // Next to a layer in auto layout, the vector must not push its siblings.
          ...(hasFill && isAutoLayout(doc, parent) ? { layoutPositioning: 'ABSOLUTE' as const } : {}),
        },
        index + 1,
      );
      if (hasFill) doc.set(id, { strokes: [] });
      else doc.delete(id);
      out.push(v);
    }
  });
  if (out.length) editor.select(out);
  else toast('У выделения нет обводки');
}

/**
 * Text on a path: clicking a vector or shape path with the “Text” tool puts
 * text on that path, starting at the click point. The path stays (it can be hidden or deleted).
 */
function textOnPathAt(wx: number, wy: number): boolean {
  const doc = editor.doc;
  const tol = 6 / editor.camera.zoom;
  let best: { id: string; data: string; s: number; d: number } | null = null;
  for (const n of editor.scene.hitPath(wx, wy, tol)) {
    const id = editor.scene.id(n)!;
    const t = doc.type(id);
    if (t !== 'VECTOR' && t !== 'RECTANGLE' && t !== 'ELLIPSE' && t !== 'POLYGON' && t !== 'STAR' && t !== 'LINE') continue;
    // Node paths: for a vector, the network chains (defined at geometrySize, stretched to the box),
    // for a shape, its outline.
    const net = t === 'VECTOR' ? networkOf(doc, id) : null;
    const datas = net ? networkChains(net).map((c) => c.data) : [pathToSvg(nodeOutline(doc, id), 0, 0)];
    const [sx, sy] = net ? textPathScale(doc.props(id)) : [1, 1];
    const im = invert(editor.worldMatrix(id) as Matrix);
    const lx = im[0] * wx + im[1] * wy + im[2];
    const ly = im[3] * wx + im[4] * wy + im[5];
    // Tolerance is in node coordinates (the node may be scaled).
    const scale = Math.hypot(im[0], im[3]) || 1;
    for (const data of datas) {
      const map = new PathTextMap(editor.ck, data, 0, 0, 'LEFT', 0, sx, sy);
      if (map.ok) {
        const [s, d] = map.fromLocal(lx, ly);
        if (Math.abs(d) <= tol * scale && s >= -tol * scale && s <= map.length + tol * scale && (!best || Math.abs(d) < best.d)) best = { id, data: sx === 1 && sy === 1 ? data : map.svg(), s: Math.max(0, Math.min(map.length, s)), d: Math.abs(d) };
      }
      map.delete();
    }
  }
  if (!best) return false;
  const p = doc.props(best.id);
  const parent = doc.parent(best.id)!;
  const index = doc.children(parent).indexOf(best.id) + 1;
  const id = doc.transact(() =>
    doc.create(
      'TEXT',
      parent,
      {
        name: 'Текст по контуру',
        characters: '',
        fontSize: 16,
        fontName: { family: 'Inter', style: 'Regular' },
        textAutoResize: 'NONE',
        transform: (p.transform ?? [1, 0, 0, 0, 1, 0]) as Matrix,
        width: Math.max(1, p.width ?? 1),
        height: Math.max(1, p.height ?? 1),
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
        textPath: { data: best.data, offset: Math.round(best.s * 100) / 100 },
      },
      index,
    ),
  );
  editor.select([id]);
  textEditing.start(id, true);
  return true;
}

/** Ctrl+Alt+K: turn a frame into a component; otherwise wrap the selection in a new component. */
function createComponent() {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id));
  if (!sel.length) return;
  const id = doc.transact(() => {
    if (sel.length === 1 && doc.type(sel[0]!) === 'FRAME') {
      const f = sel[0]!;
      const parent = doc.parent(f)!;
      const index = doc.children(parent).indexOf(f);
      const c = doc.create('COMPONENT', parent, { ...doc.props(f) }, index);
      for (const k of [...doc.children(f)]) doc.move(k, c);
      doc.delete(f);
      return c;
    }
    const parent = doc.parent(sel[0]!);
    const siblings = sel.filter((s) => doc.parent(s) === parent);
    return wrapNodes(doc, siblings, editor.pageId, (n) => editor.worldMatrix(n) as Matrix, editor.selectionBounds(siblings)!, 'COMPONENT', { name: 'Component', fills: [], clipsContent: false });
  });
  editor.select([id]);
  toast('Создан компонент: копии (Ctrl+C / Ctrl+V, Ctrl+D) — его инстансы');
}

/** Ctrl+Alt+B: detach instances into regular frames. */
function detachSelection() {
  const doc = editor.doc;
  const out = doc.transact(() => editor.selection.filter((id) => doc.has(id) && doc.type(id) === 'INSTANCE').map((id) => detachInstance(doc, id)));
  if (out.length) editor.select(out);
}

function ungroup() {
  const doc = editor.doc;
  const out: string[] = [];
  doc.transact(() => {
    for (const g of editor.selection) {
      if (doc.type(g) !== 'GROUP' && doc.type(g) !== 'FRAME') continue;
      const parent = doc.parent(g)!;
      const parentWorld = (parent === editor.pageId ? [1, 0, 0, 0, 1, 0] : editor.worldMatrix(parent)) as Matrix;
      const index = doc.children(parent).indexOf(g);
      for (const c of [...doc.children(g)]) {
        const abs = editor.worldMatrix(c) as Matrix;
        doc.move(c, parent, index);
        doc.set(c, { transform: multiply(invert(parentWorld), abs) });
        out.push(c);
      }
      doc.delete(g);
    }
  });
  if (out.length) editor.select(out);
}

function reorder(delta: number) {
  const doc = editor.doc;
  doc.transact(() => {
    for (const id of editor.selection) {
      const parent = doc.parent(id)!;
      const sib = doc.children(parent);
      const i = sib.indexOf(id);
      const target = delta === Infinity ? sib.length : delta === -Infinity ? 0 : Math.max(0, i + delta + (delta > 0 ? 1 : 0));
      doc.move(id, parent, target);
    }
  });
}

/** Ctrl+arrows: resize the selection by 1 px (Shift: 10); right / left change width, down / up change height. */
function resizeBy(dw: number, dh: number) {
  const doc = editor.doc;
  doc.transact(() => {
    for (const id of editor.selection) {
      if (!doc.has(id) || layerLocked(doc, id)) continue;
      const props: Props = {};
      if (dw) Object.assign(props, sizingProps(doc, id, 'width', 'FIXED'), { width: Math.max(1, (doc.get(id, 'width') ?? 0) + dw) });
      // A line has no height.
      if (dh && doc.type(id) !== 'LINE') Object.assign(props, sizingProps(doc, id, 'height', 'FIXED'), { height: Math.max(1, (doc.get(id, 'height') ?? 0) + dh) });
      if (Object.keys(props).length) resizeWithConstraints(doc, id, props);
    }
  });
}

/** Alt+Shift+A: remove auto layout (children stay in place). */
function removeAutoLayout() {
  const doc = editor.doc;
  const ids = editor.selection.filter((id) => doc.has(id) && isAutoLayout(doc, id));
  if (ids.length) doc.transact(() => ids.forEach((id) => doc.set(id, { layoutMode: 'NONE' })));
}

const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

/** N / Shift+N: next / previous frame on the page (in reading order: rows top to bottom, left to right within a row). */
function stepFrame(step: 1 | -1) {
  const doc = editor.doc;
  const frames = doc
    .children(editor.pageId)
    .filter((id) => SCREEN_TYPES.has(doc.type(id) ?? '') && doc.get(id, 'visible') !== false)
    .map((id) => ({ id, b: editor.selectionBounds([id])! }))
    .filter((f) => f.b);
  if (!frames.length) return;
  frames.sort((a, b) => {
    const rowTol = Math.min(a.b[3] - a.b[1], b.b[3] - b.b[1]) / 2;
    return Math.abs(a.b[1] - b.b[1]) < rowTol ? a.b[0] - b.b[0] : a.b[1] - b.b[1];
  });
  // The current one is the top-level frame of the selection.
  let cur = editor.selection.find((id) => doc.has(id));
  while (cur && doc.parent(cur) !== editor.pageId) cur = doc.parent(cur) ?? undefined;
  const i = frames.findIndex((f) => f.id === cur);
  const next = frames[i < 0 ? (step > 0 ? 0 : frames.length - 1) : (i + step + frames.length) % frames.length]!;
  editor.select([next.id]);
  editor.fitRect(next.b, 8, true);
}

/** PageUp / PageDown: previous / next page. */
function stepPage(step: 1 | -1) {
  const pages = userPages(editor.doc);
  const p = pages[pages.indexOf(editor.pageId) + step];
  if (p) editor.setPage(p);
}

/** Alt+/ removes fills, Shift+/ removes strokes. */
function clearPaints(key: 'fills' | 'strokes') {
  const doc = editor.doc;
  const ids = editor.selection.filter((id) => doc.has(id));
  if (ids.length) doc.transact(() => ids.forEach((id) => doc.set(id, { [key]: [], [key === 'fills' ? 'fillStyleId' : 'strokeStyleId']: '' })));
}

/** Shift+X: swap fill and stroke (with styles). */
function swapFillStroke() {
  const doc = editor.doc;
  const ids = editor.selection.filter((id) => doc.has(id));
  doc.transact(() => {
    for (const id of ids) {
      const p = doc.props(id);
      const props: Props = { fills: p.strokes ?? [], strokes: p.fills ?? [], fillStyleId: p.strokeStyleId ?? '', strokeStyleId: p.fillStyleId ?? '' };
      // There was no stroke: give the new one a width of 1, otherwise it is invisible.
      if ((p.fills ?? []).length && !p.strokeWeight) props.strokeWeight = 1;
      doc.set(id, props);
    }
  });
}

/** Shortcuts for styling selected text layers as a whole (see text-keys.ts). */
function styleTextKey(k: TextKey): boolean {
  const doc = editor.doc;
  const ids = editor.selection.filter((id) => doc.type(id) === 'TEXT');
  if (!ids.length || ids.length !== editor.selection.length) return false;
  doc.transact(() => {
    for (const id of ids) {
      if (k.kind === 'align') doc.set(id, { textAlignHorizontal: k.value });
      else restyleText(doc, id, 0, (doc.get(id, 'characters') ?? '').length, (st) => textKeyStyle(k, st, editor.fonts.localStyles(st.fontName.family)));
    }
  });
  for (const id of ids) for (const f of textFonts(doc.props(id))) void editor.fonts.ensure(f);
  return true;
}

/** Leave “Tools” in the left strip (set when the strip is built). */
let exitTools: () => void = () => {};

/** Alt+1 / 2 / 8 / 9: layers, assets, design, prototype (shows the interface if hidden). */
function showPanel(code: string) {
  document.body.classList.remove('ui-hidden', 'ui-min');
  if (code === 'Digit1' || code === 'Digit2') exitTools();
  if (code === 'Digit1') assets.showFile();
  else if (code === 'Digit2') assets.show();
  else panels.setTab(code === 'Digit8' ? 'design' : 'prototype');
}

/** Ctrl+Alt+\: show or hide participants' cursors. */
function toggleCursors() {
  const off = document.body.classList.toggle('peer-cursors-off');
  toast(off ? 'Курсоры участников скрыты (Ctrl+Alt+\\ — показать)' : 'Курсоры участников видны');
}

/** Ctrl+Alt+S: save a version to the history. */
function saveVersion() {
  if (!versionPanel) return toast('История версий — у файлов на диске и на сервере');
  versionPanel.open();
  requestAnimationFrame(() => versionPanel.saveDialog(document.querySelector<HTMLElement>('#history .history-head .icon-btn') ?? $('right')));
}

/** The “Legacy outline shortcuts” setting: outlines on Shift+O, outline stroke on Ctrl+Shift+O. */
const OLD_OUTLINE_KEY = 'mfp-old-outline-keys';
function oldOutlineKeys(): boolean {
  try {
    return localStorage.getItem(OLD_OUTLINE_KEY) === '1';
  } catch {
    return false;
  }
}
function setOldOutlineKeys(on: boolean) {
  try {
    if (on) localStorage.setItem(OLD_OUTLINE_KEY, '1');
    else localStorage.removeItem(OLD_OUTLINE_KEY);
  } catch {
    // Storage unavailable: unchanged until restart.
  }
  toast(on ? 'Контуры — Shift+O, контур обводки — Ctrl+Shift+O' : 'Контуры — Ctrl+Shift+O, контур обводки — Ctrl+Alt+O');
}
const outlineHint = () => (oldOutlineKeys() ? 'Shift+O' : 'Ctrl+Shift+O');
const outlineStrokeHint = () => (oldOutlineKeys() ? 'Ctrl+Shift+O' : 'Ctrl+Alt+O');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  const action = historyShortcut(e);
  if (!action || editor.devMode || editor.sceneBuilding || serverOpening || fileTabs?.fileLoading || boundAction(e)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (textEditing.active) textEditing.commit();
  editor.doc[action]();
}, true);

window.addEventListener('keydown', (e) => {
  if (editor.sceneBuilding || serverOpening || fileTabs?.fileLoading) return;
  // F6 moves to the next window region (also out of inputs: Tab on the canvas selects layers, there is no way out).
  if (regionShortcut(e, isMac)) {
    keyboardSelection.stop();
    cycleRegion(e.shiftKey ? -1 : 1);
    e.preventDefault();
    return;
  }
  const tag = (e.target as HTMLElement).tagName;
  if (e.isComposing || e.getModifierState('AltGraph') || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable) return;
  // Custom shortcuts take precedence over built-in ones.
  const custom = boundAction(e);
  if (custom) {
    e.preventDefault();
    void runBound(custom);
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (keyboardSelectionShortcut(e, isMac)) {
    if (!e.repeat) {
      if (keyboardSelection.point) keyboardSelection.stop();
      else { setTool('select'); keyboardSelection.start(); }
    }
    e.preventDefault();
    return;
  }
  if ((e.target === editor.canvasEl || e.target === document.body) && keyboardSelection.key(e)) {
    e.preventDefault();
    return;
  }
  // Letters go by physical key: in the Russian layout Ctrl+C, V, Z and tools work the same.
  const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  // Collaboration: Esc stops following a participant, “/” opens cursor chat.
  if (e.key === 'Escape' && collab.following) {
    collab.follow(null);
    e.preventDefault();
    return;
  }
  if (e.code === 'Slash' && !mod && !e.altKey && !e.shiftKey && collab.connected) {
    cursorChat.start();
    e.preventDefault();
    return;
  }
  if (!mod && !e.altKey && e.shiftKey && k === 'd') {
    setDevMode(!editor.devMode);
    e.preventDefault();
    return;
  }
  // Developer mode: editing is unavailable (and so are browser shortcuts like bookmarking).
  if (editor.devMode && !devKeyAllowed(e, oldOutlineKeys(), !!editor.selection.length)) {
    if (mod) e.preventDefault();
    return;
  }
  // Enter in developer mode navigates the hierarchy; it must not enter vector/text editing.
  if (editor.devMode && !mod && !e.altKey && k === 'enter') {
    if (e.shiftKey) selectParents();
    else selectChildren();
    e.preventDefault();
    return;
  }
  // Shift+Space: prototype preview over the canvas.
  if (e.code === 'Space' && e.shiftKey && !mod && !e.altKey && !e.repeat) {
    togglePreview(editor, () => files.name);
    e.preventDefault();
    return;
  }
  if (e.code === 'Space' && !tools.spaceHeld) {
    tools.spaceHeld = true;
    updateChrome();
    e.preventDefault();
    return;
  }
  // Cheat sheet: Ctrl+Shift+?; without a selection, just “?” too (with a selection Shift+/ removes the stroke).
  const sheet = (e.code === 'Slash' && e.shiftKey && !e.altKey && (mod || !editor.selection.length)) || (e.key === '?' && !mod && !editor.selection.length);
  if (sheet || (e.key === 'Escape' && document.getElementById('shortcuts'))) {
    toggleShortcuts();
    e.preventDefault();
    return;
  }
  // Back / forward through document locations (without leaving the page, as the browser would).
  if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    if (e.key === 'ArrowLeft') navigation.back();
    else navigation.forward();
    e.preventDefault();
    return;
  }
  if (paintEditorKeydown(e)) return;
  if (tools.creationKey(e)) {
    e.preventDefault();
    return;
  }
  // Contextual vector keys (notably eraser [ / ]) take precedence over layer commands.
  if (vectorTool.active && vectorTool.key(e)) {
    e.preventDefault();
    return;
  }
  const figmaKey = figmaKeyOf(e, isMac);
  if (figmaKey) {
    if (figmaKey === 'layoutGuides') layoutGrids.toggle();
    else if (figmaKey === 'flatten') flatten();
    else if (figmaKey === 'mask') useAsMask();
    else reorder(figmaKey === 'front' ? Infinity : -Infinity);
    e.preventDefault();
    return;
  }
  // Text: alignment, font size, weight, spacing for the selected text layers.
  const tk = textKeyOf(e);
  if (tk && !editor.devMode && styleTextKey(tk)) {
    e.preventDefault();
    return;
  }
  // Styling of the selected texts as a whole.
  if (mod && !e.altKey) {
    const kk = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
    const done =
      (!e.shiftKey && kk === 'b' && TEXT_TOGGLES.bold()) ||
      (!e.shiftKey && kk === 'i' && TEXT_TOGGLES.italic()) ||
      (!e.shiftKey && kk === 'u' && TEXT_TOGGLES.underline()) ||
      (e.shiftKey && kk === 'x' && TEXT_TOGGLES.strike()) ||
      (e.shiftKey && e.code === 'Digit7' && TEXT_TOGGLES.ordered()) ||
      (e.shiftKey && e.code === 'Digit8' && TEXT_TOGGLES.bullets());
    if (done) {
      e.preventDefault();
      return;
    }
  }
  // Stroke width: Delete removes a width point, Esc exits.
  if (widthTool.key(e)) {
    e.preventDefault();
    return;
  }
  // Shape builder: Esc / Enter exits; Shift+M enters.
  if (shapeBuilder.active && (k === 'escape' || k === 'enter')) {
    shapeBuilder.stop();
    e.preventDefault();
    return;
  }
  if (!mod && !e.altKey && e.shiftKey && k === 'm') {
    const why = shapeBuilder.active ? (shapeBuilder.stop(), null) : shapeBuilder.start();
    if (why) toast(why);
    e.preventDefault();
    return;
  }
  // Enter: edit a vector, or a shape as a vector.
  if (!mod && !e.shiftKey && k === 'enter' && editor.selection.length === 1 && vectorTool.canEdit(editor.selection[0]!)) {
    vectorTool.startEdit(editor.selection[0]!);
    e.preventDefault();
    return;
  }
  // Ctrl+plus and Ctrl+minus zoom the canvas, not the page.
  if (mod && !e.altKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract')) {
    editor.zoomCenter(e.key === '-' || e.code === 'NumpadSubtract' ? 0.8 : 1.25);
    e.preventDefault();
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && (k === 'k' || e.code === 'Slash')) openActionsMenu();
  else if (mod && !e.shiftKey && !e.altKey && k === 'f') openFind(editor, (m) => toast(m));
  else if (mod && e.altKey && e.code === 'Backslash') toggleCursors();
  else if (mod && e.code === 'Backslash') toggleUi(e.shiftKey ? 'min' : 'hidden');
  else if (!mod && !e.altKey && !e.shiftKey && e.code === 'Backslash') selectParents();
  else if (isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && k === 'g') layoutGrids.toggle();
  else if (mod && e.shiftKey && e.code === 'Digit4') layoutGrids.toggle();
  else if (mod && !e.altKey && e.code === 'Quote') {
    if (e.shiftKey) togglePixelSnap();
    else togglePixelGrid();
  }
  // Outlines and outline stroke: Ctrl+Shift+O and Ctrl+Alt+O (legacy shortcuts: Shift+O and Ctrl+Shift+O).
  else if (mod && e.shiftKey && !e.altKey && k === 'o') {
    if (oldOutlineKeys()) outlineStroke();
    else toggleOutline();
  } else if (mod && e.altKey && !e.shiftKey && k === 'o') {
    if (!oldOutlineKeys()) outlineStroke();
  } else if (!mod && !e.altKey && e.shiftKey && k === 'o' && oldOutlineKeys()) toggleOutline();
  // Ctrl+Y: redo.
  else if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && k === 'y') editor.doc.redo();
  else if (!mod && !e.altKey && !e.shiftKey && k === 'z') {
    if (!e.repeat) setZoomHeld(true);
  }
  else if (e.altKey && !mod && !e.shiftKey && ALIGN_KEYS[k]) align(editor, editor.selection, ALIGN_KEYS[k]!);
  else if (e.altKey && !mod && e.shiftKey && (k === 'h' || k === 'v')) distribute(editor, editor.selection, k === 'h' ? 'x' : 'y');
  else if (mod && e.altKey && k === 't') tidyUp(editor, editor.selection);
  else if (mod && k === 'z' && !e.shiftKey) editor.doc.undo();
  else if (mod && k === 'z' && e.shiftKey) editor.doc.redo();
  else if (mod && k === 'd') duplicate();
  else if (mod && e.shiftKey && k === 'c') void copyAsPng();
  else if (mod && e.shiftKey && k === 'k') imageInput.click();
  else if (mod && e.shiftKey && k === 'e') openExportDialog(editor, (ids) => void exportSelection(ids));
  else if (!mod && e.altKey && e.shiftKey && (k === 'u' || k === 's' || k === 'i' || k === 'e')) booleanOp(({ u: 'UNION', s: 'SUBTRACT', i: 'INTERSECT', e: 'EXCLUDE' } as const)[k]);
  else if (!mod && e.altKey && e.shiftKey && k === 'a') removeAutoLayout();
  else if (mod && e.altKey && !e.shiftKey && k === 's') saveVersion();
  else if (e.altKey && !mod && !e.shiftKey && ['Digit1', 'Digit2', 'Digit8', 'Digit9'].includes(e.code)) showPanel(e.code);
  else if (e.altKey && !mod && !e.shiftKey && e.code === 'Digit3') openLibraries(editor, teamLibs);
  else if (e.altKey && !mod && !e.shiftKey && e.code === 'Slash') clearPaints('fills');
  else if (!mod && !e.altKey && e.shiftKey && e.code === 'Slash') clearPaints('strokes');
  else if (!mod && !e.altKey && e.shiftKey && k === 'x') swapFillStroke();
  else if (!mod && !e.altKey && k === 'n') stepFrame(e.shiftKey ? -1 : 1);
  else if (!mod && !e.altKey && (k === 'pageup' || k === 'pagedown')) stepPage(k === 'pageup' ? -1 : 1);
  else if (mod && !e.shiftKey && k === 'e') flatten();
  else if (!mod && !e.shiftKey && !e.altKey && k === 'i') void eyedropper();
  else if (!mod && e.shiftKey && !e.altKey && k === 'i' && !editor.devMode) openActionsMenu('assets');
  else if (mod && e.altKey && k === 'k') createComponent();
  else if (mod && e.altKey && k === 'enter') present(editor, () => files.name);
  else if (mod && e.altKey && k === 'b') detachSelection();
  else if (mod && e.altKey && k === 'c') copyProperties();
  else if (mod && k === 'c') copySelection();
  else if (mod && e.altKey && k === 'v') pasteProperties();
  else if (mod && e.shiftKey && e.altKey && k === 'r') fitSelection();
  else if (mod && e.shiftKey && k === 'r') paste('replace');
  // Ctrl+V and Ctrl+Shift+V go through the paste event (it exposes the system clipboard contents: layers
  // from Figma, from another tab, images), so the browser action is not prevented. If there is no event
  // (some environments do not fire paste for the canvas), the internal copy is pasted a bit later.
  else if (mod && k === 'v') {
    pendingPaste = true;
    pasteMode = e.shiftKey ? 'over' : 'normal';
    setTimeout(() => {
      if (!pendingPaste) return;
      pendingPaste = false;
      paste(pasteMode);
    }, 50);
    return;
  }
  else if (mod && k === 'x') {
    copySelection();
    deleteSelection();
  } else if (mod && k === 'a' && e.shiftKey) selectInverse();
  else if (mod && e.altKey && k === 'a') selectSame('matching');
  else if (mod && k === 'a') selectAllSiblings();
  else if (mod && k === 'g' && e.shiftKey) ungroup();
  else if (mod && e.altKey && k === 'g') frameSelection();
  else if (mod && k === 'g') group();
  else if (mod && e.altKey && k === 'm') useAsMask();
  else if (mod && e.shiftKey && k === 'h') toggleSelection('visible');
  else if (mod && e.shiftKey && k === 'l') toggleSelection('locked');
  else if (mod && !e.shiftKey && !e.altKey && k === 'l') copyNodeLink();
  else if (mod && e.altKey && !e.shiftKey && k === 'p') {
    if (!relaunchLastPlugin()) toast('Плагины в этом сеансе ещё не запускались');
  }
  else if (mod && !e.shiftKey && k === 'r') {
    renameSelection();
  }
  else if (mod && !e.altKey && e.shiftKey && k === 's') void save(true);
  else if (mod && !e.altKey && k === 's') void save(); else if (mod && e.code === 'BracketRight') reorder(e.altKey || e.shiftKey ? Infinity : 1);
  else if (mod && e.code === 'BracketLeft') reorder(e.altKey || e.shiftKey ? -Infinity : -1);
  else if (e.shiftKey && e.code === 'Digit0') editor.zoomTo100(true);
  else if (e.shiftKey && e.code === 'Digit1') editor.fitPage(true);
  else if (e.shiftKey && e.code === 'Digit2') editor.fitRect(editor.selectionBounds(), 8, true);
  else if (k === 'delete' || k === 'backspace') {
    if (!rulers.deleteSelected()) deleteSelection();
  }
  else if (k === 'escape') {
    if (measurements.cancel() || devStatus.unfocus()) {
      // A measurement in progress was cancelled, or focus was lost.
    } else if (!comments.escape()) {
      if (editor.tool === 'comment') setTool('select');
      else editor.select([]);
    }
  }
  else if (k.startsWith('arrow')) {
    const dx = k === 'arrowleft' ? -1 : k === 'arrowright' ? 1 : 0;
    const dy = k === 'arrowup' ? -1 : k === 'arrowdown' ? 1 : 0;
    // Without a selection (and in developer mode) arrows scroll the canvas (Shift: larger steps); with a selection they move it;
    // with Ctrl they resize it.
    if (mod && editor.selection.length && !editor.devMode) resizeBy((dx || 0) * (e.shiftKey ? 10 : 1), (dy || 0) * (e.shiftKey ? 10 : 1));
    else if (!editor.selection.length || editor.devMode) {
      const z = editor.camera.zoom;
      const step = e.shiftKey ? 400 : 80;
      editor.setCamera({ ...editor.camera, x: editor.camera.x + (dx * step) / z, y: editor.camera.y + (dy * step) / z });
    } else {
      const step = e.shiftKey ? nudgeStep.big : nudgeStep.small;
      nudge(dx * step, dy * step);
    }
  } else if (!mod && e.shiftKey && k === 'v') flipSelection(1, -1);
  else if (!mod && k === 'v') setTool('select');
  else if ((!mod && k === 'f') || (!mod && !e.altKey && !e.shiftKey && k === 'a')) setTool('frame');
  else if (!mod && !e.altKey && e.shiftKey && k === 's') setTool('section');
  else if (!mod && !e.altKey && !e.shiftKey && k === 's') setTool('slice');
  else if (!mod && !e.altKey && !e.shiftKey && k === 'k') setTool('scale');
  else if (!mod && e.shiftKey && k === 'r') rulers.toggle();
  else if (!mod && k === 'r') setTool('rect');
  else if (mod && k === 'o') openFiles();
  else if (!mod && k === 'o') setTool('ellipse');
  else if (e.altKey && !mod && !e.shiftKey && k === 'l') panels.collapseLayers();
  else if (!mod && k === 'l' && !e.shiftKey) setTool('line');
  else if (!mod && !e.altKey && k === 'l' && e.shiftKey) setTool('arrow');
  else if (!mod && !e.altKey && e.shiftKey && k === 't') timeline.toggle();
  else if (mod && !e.altKey && !e.shiftKey && k === 'j') {
    e.preventDefault();
    ai.toggle();
  }
  else if (!mod && e.shiftKey && k === 'p') setTool('pencil');
  else if (!mod && !e.altKey && !e.shiftKey && k === 'b') setTool('brush');
  else if (!mod && !e.altKey && e.shiftKey && k === 'w') setTool('width');
  else if (!mod && k === 'p') setTool('pen');
  else if (!mod && e.shiftKey && k === 'a') addAutoLayout();
  else if (!mod && !e.altKey && e.shiftKey && k === 'e') panels.setTab(panels.tab === 'design' ? 'prototype' : 'design');
  else if (!mod && k === 't') setTool(editor.devMode ? 'annotate' : 'text');
  else if (!mod && !e.shiftKey && k === 'm' && editor.devMode) setTool('measure');
  else if (!mod && !e.altKey && !e.shiftKey && k === 'c') setTool(editor.tool === 'comment' ? 'select' : 'comment');
  else if (!mod && !e.altKey && e.shiftKey && k === 'c') comments.toggleShown();
  else if (!mod && k === 'enter' && e.shiftKey) selectParents();
  else if (!mod && k === 'enter' && editor.selection.length === 1 && editor.doc.type(editor.selection[0]!) === 'TEXT') textEditing.start(editor.selection[0]!);
  else if (!mod && k === 'enter') selectChildren();
  else if (!mod && !e.altKey && k === 'tab' && (e.target === document.body || tag === 'CANVAS')) selectSibling(e.shiftKey ? -1 : 1);
  else if (!mod && !e.altKey && !e.shiftKey && /^Digit\d$/.test(e.code)) opacityKey(Number(e.code.slice(5)));
  else if (!mod && e.shiftKey && k === 'h') flipSelection(-1, 1);
  else if (!mod && k === 'h') setTool('hand');
  else if (!mod && (k === '=' || k === '+')) editor.zoomCenter(1.25);
  else if (!mod && k === '-') editor.zoomCenter(0.8);
  else return;
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    tools.spaceHeld = false;
    updateChrome();
  }
});

// ---------- Files ----------

async function load(promise: Promise<Awaited<ReturnType<typeof openFile>>>, origin: { source?: string; path?: string; reuse?: boolean } = {}) {
  const status = $('status');
  status.textContent = 'Открываю…';
  try {
    // The previous file: finish writing it and capture a version.
    await files.leave();
    exitPreview(false);
    const t0 = performance.now();
    const r = await promise;
    pluginHost?.stop();
    const tDoc = performance.now();
    editor.setDocument(r.doc, undefined, r.images);
    const timings = { ...r.timings, редактор: Math.round(performance.now() - tDoc) };
    rebindPlugins();
    void files.adopt(r.name, origin);
    editor.fitPage();
    const ms = Math.round(performance.now() - t0);
    status.textContent = r.report
      ? `Импорт из Figma: ${r.report.pages} стр., ${r.report.nodes} узлов, картинок ${r.report.images.size} · ${ms} мс`
      : `Открыто за ${ms} мс`;
    for (const w of r.warnings ?? []) toast(w);
    status.title = Object.entries(timings).map(([k, v]) => `${k}: ${v} мс`).join(' · ');
    console.info('Открытие:', status.title);
    updateChrome();
    if (r.more && r.report) {
      const report = r.report;
      const first = report.nodes;
      editor.importing = backgroundImport(r.doc, r.more).then((finished) => {
        if (editor.doc !== r.doc) return;
        editor.importing = null;
        if (!finished) return;
        // Values from variables follow the layer modes (stored as is in the file).
        r.doc.transact(() => editor.components.resolveAll(), 'import');
        const ms = Math.round(performance.now() - t0);
        status.textContent = `Импорт из Figma: ${report.pages} стр., ${report.nodes} узлов (первая страница — ${first}), картинок ${report.images.size} · всё за ${ms} мс`;
        updateChrome();
      });
    }
  } catch (e) {
    status.textContent = '';
    toast(`Не удалось открыть: ${(e as Error).message}`, 'error');
    console.error(e);
  }
}

/**
 * Load the remaining pages in ~10 ms portions: the canvas and the interface stay responsive meanwhile.
 * Returns false if another document was opened during loading.
 */
function backgroundImport(doc: Document, steps: Generator<void, void, void>): Promise<boolean> {
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      if (editor.doc !== doc) {
        channel.port1.close();
        return resolve(false);
      }
      const end = performance.now() + 10;
      while (performance.now() < end) {
        if (steps.next().done) {
          channel.port1.close();
          return resolve(true);
        }
      }
      channel.port2.postMessage(0);
    };
    channel.port2.postMessage(0);
  });
}

const openInput = $<HTMLInputElement>('open-input');
openInput.addEventListener('change', () => {
  const f = openInput.files?.[0];
  if (f) void load(openFile(f), { source: `import:${f.name}` });
  openInput.value = '';
  home?.close();
});

document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  document.body.classList.add('dragover');
});
document.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
document.addEventListener('dragend', () => document.body.classList.remove('dragover'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  if (!e.dataTransfer?.types.includes('Files')) return;
  const files = [...(e.dataTransfer?.files ?? [])];
  // Images and SVG go onto the canvas at the drop point; documents are opened.
  const r = editor.canvasEl.getBoundingClientRect();
  const at = editor.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  // In developer mode files are only opened; nothing is placed on the canvas.
  const svgs = editor.devMode ? [] : files.filter(isSvg);
  const images = editor.devMode ? [] : files.filter(isImage);
  const videos = editor.devMode ? [] : files.filter(isVideo);
  const fonts = files.filter((f) => /\.(ttf|otf|woff2?)$/i.test(f.name));
  const lotties = editor.devMode ? [] : files.filter(maybeLottie);
  const models = editor.devMode ? [] : files.filter(isModelFile);
  if (models.length) void placeModels(models, at);
  for (const f of svgs) void f.text().then((text) => placeSvg(text, f.name.replace(/\.svg$/i, ''), at));
  if (fonts.length) void addFontFiles(fonts);
  if (videos.length) void placeVideos(videos, at);
  if (images.length) void placeImages(images, at);
  else if (!svgs.length && !fonts.length && !videos.length && !models.length && files[0]) {
    // .json can be either Lottie or a document: if not Lottie, open it as before.
    const open = () => void load(openFile(files[0]!), { source: `import:${files[0]!.name}` });
    if (lotties.length) void placeLotties(lotties, at).then((n) => { if (!n) open(); });
    else open();
  }
});

// Paste an image from the clipboard (screenshot, copy from a browser).
/** Ctrl+V was pressed but the paste event has not arrived yet; the mode is normal paste or paste over selection. */
let pendingPaste = false;
let pasteMode: PasteMode = 'normal';

window.addEventListener('paste', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || editor.devMode) return;
  pendingPaste = false;
  const mode = pasteMode;
  pasteMode = 'normal';
  const v = editor.viewportRect();
  const center: [number, number] = [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2];
  const html = e.clipboardData?.getData('text/html') ?? '';
  // Our own layers (from this or another MFP tab).
  if (html.includes('(mfp)')) {
    e.preventDefault();
    void pasteMfpClipboard(html, mode).then(async (ok) => { if (!ok) await paste(mode); });
    return;
  }
  // Layers copied in Figma (Ctrl+C there, Ctrl+V here).
  if (html.includes('(figma)')) {
    e.preventDefault();
    pasteFromFigma(html, center);
    return;
  }
  // SVG code from the clipboard (e.g. from another design tool or a code editor).
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    e.preventDefault();
    placeSvg(text, 'SVG', center);
    return;
  }
  const images = [...(e.clipboardData?.files ?? [])].filter(isImage);
  if (images.length) {
    e.preventDefault();
    void placeImages(images, center);
    return;
  }
  const videos = [...(e.clipboardData?.files ?? [])].filter(isVideo);
  if (videos.length) {
    e.preventDefault();
    void placeVideos(videos, center);
    return;
  }
  const lotties = [...(e.clipboardData?.files ?? [])].filter(maybeLottie);
  if (lotties.length) {
    e.preventDefault();
    void placeLotties(lotties, center);
    return;
  }
  const models = [...(e.clipboardData?.files ?? [])].filter(isModelFile);
  if (models.length) {
    e.preventDefault();
    void placeModels(models, center);
    return;
  }
  // Nothing recognizable in the system clipboard: the internal copy (if any).
  e.preventDefault();
  paste(mode);
});

/** Paste from the Figma clipboard: the same parsing as for .fig files; one undo step. */
function pasteFromFigma(html: string, [cx, cy]: [number, number]) {
  const bytes = figmaClipboardBytes(html);
  if (!bytes) return toast('Не удалось прочитать буфер Figma', 'error');
  try {
    const t0 = performance.now();
    const scene = buildScene(decodeFigKiwi(readFigKiwi(bytes)).message);
    const doc = editor.doc;
    const { roots, report } = doc.transact(() => {
      const r = sceneToCore(scene, doc, { into: editor.pageId });
      // At the center of the visible area (layers keep their coordinates from the source page).
      let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const id of r.roots) {
        const t = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
        const w = doc.get(id, 'width') ?? 0;
        const h = doc.get(id, 'height') ?? 0;
        box = [Math.min(box[0], t[2]), Math.min(box[1], t[5]), Math.max(box[2], t[2] + w), Math.max(box[3], t[5] + h)];
      }
      const dx = Math.round(cx - (box[0] + box[2]) / 2);
      const dy = Math.round(cy - (box[1] + box[3]) / 2);
      for (const id of r.roots) {
        const t = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
        doc.set(id, { transform: [t[0], t[1], t[2] + dx, t[3], t[4], t[5] + dy] });
      }
      return r;
    }, 'paste');
    // Variable values follow the modes of the new location.
    doc.amend(() => editor.components.resolveAll(), 'paste');
    editor.select(roots);
    toast(`Вставлено из Figma: ${report.nodes} слоёв за ${Math.round(performance.now() - t0)} мс${report.images.size ? ` · картинок ${report.images.size} — в буфере их нет, откройте файл .fig` : ''}`);
  } catch (err) {
    toast(`Не удалось вставить из Figma: ${(err as Error).message}`, 'error');
    console.error(err);
  }
}

function isSvg(f: File) {
  return f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);
}

function placeSvg(text: string, name: string, at: [number, number]) {
  const id = importSvg(editor, text, name, at);
  if (!id) {
    toast('В SVG не нашлось фигур', 'error');
    return;
  }
  editor.select([id]);
  // SVG animation goes onto the frame timeline: open the panel so it is visible and can be played.
  if (editor.doc.get(id, 'timeline')) {
    timeline.show();
    toast('Анимация SVG перенесена на таймлайн фрейма — пробел играет её, в показе она идёт сама');
  }
}

function isImage(f: File) {
  if (isSvg(f)) return false;
  return /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(f.type) || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name);
}

function isVideo(f: File) {
  return /^video\/(mp4|webm|quicktime)$/.test(f.type) || /\.(mp4|m4v|webm|mov)$/i.test(f.name);
}

/** A glTF 3D model file. */
function isModelFile(f: File) {
  return /\.(glb|gltf)$/i.test(f.name) || f.type === 'model/gltf-binary' || f.type === 'model/gltf+json';
}

/**
 * Insert 3D models: a rectangle with a “3D model” fill (fit) in the model's front-view
 * proportions, no larger than 400 px and the visible area. In presentation the model can be rotated.
 */
async function placeModels(files: File[], [cx, cy]: [number, number]) {
  const doc = editor.doc;
  const v = editor.viewportRect();
  const side = Math.min(400, (v[2] - v[0]) * 0.8, (v[3] - v[1]) * 0.8);
  const prepared: { name: string; hash: string; w: number; h: number }[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!isModelBytes(bytes)) {
      toast(`«${f.name}» — не модель glTF (нужен .glb или .gltf со встроенными данными)`, 'error');
      continue;
    }
    if (bytes.length > 30 * 1024 * 1024) toast(`Модель «${f.name}» большая (${Math.round(bytes.length / 1048576)} МБ): файл будет тяжёлым — сожмите её (gltf-transform, Draco или meshopt)`);
    const info = await editor.models.infoOf(bytes);
    if (!info) {
      toast(`Не удалось открыть модель «${f.name}»`, 'error');
      continue;
    }
    // Proportions: the model from the front with headroom for rotation; no narrower than 1:2.
    const aspect = Math.max(0.5, Math.min(2, info.width / Math.max(1e-6, info.height)));
    const [w, h] = aspect >= 1 ? [side, Math.round(side / aspect)] : [Math.round(side * aspect), side];
    prepared.push({ name: f.name.replace(/\.[^.]+$/, '') || '3D', hash: await editor.store.add(bytes), w, h });
  }
  if (!prepared.length) return;
  const ids: string[] = [];
  let offset = 0;
  doc.beginGroup();
  try {
    for (const p of prepared) {
      ids.push(
        doc.create('RECTANGLE', editor.pageId, {
          name: p.name,
          transform: [1, 0, Math.round(cx - p.w / 2 + offset), 0, 1, Math.round(cy - p.h / 2 + offset)],
          width: p.w,
          height: p.h,
          fills: [{ type: 'MODEL3D', scaleMode: 'FIT', modelHash: p.hash, camera: { yaw: 30, pitch: 15, zoom: 1 }, orbit: true }],
        }),
      );
      offset += 20;
    }
  } finally {
    doc.endGroup();
  }
  editor.select(ids);
}

/** A file that may be Lottie (.lottie, .json: the contents are checked). */
function maybeLottie(f: File) {
  return /\.(lottie|json)$/i.test(f.name) || f.type === 'application/zip+dotlottie';
}

/**
 * Insert Lottie: a rectangle with a Lottie fill (fit) at the animation size (no larger than the visible
 * area). Returns how many files turned out to be Lottie.
 */
async function placeLotties(files: File[], [cx, cy]: [number, number]): Promise<number> {
  const doc = editor.doc;
  const v = editor.viewportRect();
  const maxW = (v[2] - v[0]) * 0.8;
  const maxH = (v[3] - v[1]) * 0.8;
  const prepared: { name: string; hash: string; w: number; h: number }[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!isLottieBytes(bytes)) {
      if (/\.lottie$/i.test(f.name)) toast(`«${f.name}» — не анимация Lottie`, 'error');
      continue;
    }
    const clip = editor.lotties.make(bytes);
    if (!clip) {
      toast(`Не удалось прочитать анимацию «${f.name}»`, 'error');
      continue;
    }
    prepared.push({ name: f.name.replace(/\.[^.]+$/, '') || 'Lottie', hash: await editor.store.add(bytes), w: clip.width, h: clip.height });
    clip.anim.delete();
  }
  if (!prepared.length) return 0;
  const ids: string[] = [];
  let offset = 0;
  doc.beginGroup();
  try {
    for (const p of prepared) {
      const s = Math.min(1, maxW / p.w, maxH / p.h);
      const [nw, nh] = [Math.max(1, Math.round(p.w * s)), Math.max(1, Math.round(p.h * s))];
      ids.push(
        doc.create('RECTANGLE', editor.pageId, {
          name: p.name,
          transform: [1, 0, Math.round(cx - nw / 2 + offset), 0, 1, Math.round(cy - nh / 2 + offset)],
          width: nw,
          height: nh,
          fills: [{ type: 'LOTTIE', scaleMode: 'FIT', lottieHash: p.hash }],
        }),
      );
      offset += 20;
    }
  } finally {
    doc.endGroup();
  }
  editor.select(ids);
  return prepared.length;
}

/** Insert videos: a rectangle with a video fill at natural size (no larger than the visible area). */
async function placeVideos(files: File[], [cx, cy]: [number, number]) {
  const ids: string[] = [];
  const doc = editor.doc;
  const v = editor.viewportRect();
  const maxW = (v[2] - v[0]) * 0.8;
  const maxH = (v[3] - v[1]) * 0.8;
  let offset = 0;
  const prepared: { name: string; hash: string; w: number; h: number }[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const size = await videoSize(bytes);
    if (!size) {
      toast(`Не удалось прочитать видео «${f.name}» (нужны MP4 или WebM)`, 'error');
      continue;
    }
    prepared.push({ name: f.name.replace(/\.[^.]+$/, '') || 'Video', hash: await editor.store.add(bytes), w: size.width, h: size.height });
  }
  doc.beginGroup();
  try {
    for (const p of prepared) {
      const s = Math.min(1, maxW / p.w, maxH / p.h);
      const [nw, nh] = [Math.round(p.w * s), Math.round(p.h * s)];
      ids.push(
        doc.create('RECTANGLE', editor.pageId, {
          name: p.name,
          transform: [1, 0, Math.round(cx - nw / 2 + offset), 0, 1, Math.round(cy - nh / 2 + offset)],
          width: nw,
          height: nh,
          fills: [{ type: 'VIDEO', scaleMode: 'FILL', videoHash: p.hash }],
        }),
      );
      offset += 20;
    }
  } finally {
    doc.endGroup();
  }
  if (ids.length) editor.select(ids);
}

/** Insert images: a rectangle with an image fill at natural size (no larger than the visible area). */
async function placeImages(files: File[], [cx, cy]: [number, number]) {
  const ids: string[] = [];
  const doc = editor.doc;
  const v = editor.viewportRect();
  const maxW = (v[2] - v[0]) * 0.8;
  const maxH = (v[3] - v[1]) * 0.8;
  let offset = 0;
  doc.beginGroup();
  try {
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let w: number;
      let h: number;
      try {
        const bmp = await createImageBitmap(new Blob([bytes]));
        [w, h] = [bmp.width, bmp.height];
        bmp.close();
      } catch {
        toast(`Не удалось прочитать картинку «${f.name}»`, 'error');
        continue;
      }
      const hash = await editor.store.add(bytes);
      const s = Math.min(1, maxW / w, maxH / h);
      const [nw, nh] = [Math.round(w * s), Math.round(h * s)];
      ids.push(
        doc.create('RECTANGLE', editor.pageId, {
          name: f.name.replace(/\.[^.]+$/, '') || 'Image',
          transform: [1, 0, Math.round(cx - nw / 2 + offset), 0, 1, Math.round(cy - nh / 2 + offset)],
          width: nw,
          height: nh,
          fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: hash, originalWidth: w }],
        }),
      );
      offset += 20;
    }
  } finally {
    doc.endGroup();
  }
  if (ids.length) editor.select(ids);
}

/** Export: each selected layer as a separate file, with the panel's current settings. */
/** Export the selection using the layers' settings (no settings: PNG 1x). */
async function exportSelection(ids: string[]) {
  if (!ids.length) return toast('Выделите, что экспортировать');
  const status = $('status');
  status.textContent = 'Экспортирую…';
  try {
    const out = await exportSelectionFiles(editor, ids);
    const name = ids.length === 1 ? editor.doc.get(ids[0]!, 'name') || files.name : files.name;
    const where = await deliver(out, name);
    status.textContent = where ? `Экспорт: ${out.length} ${out.length === 1 ? 'файл' : 'файлов'} → ${where}` : '';
  } catch (e) {
    status.textContent = '';
    toast(`Не удалось экспортировать: ${(e as Error).message}`, 'error');
  }
}

/** The page's frames as one PDF (a page per frame); print is for printing. */
async function exportPagePdf(print?: PdfPrint) {
  const status = $('status');
  status.textContent = 'Собираю PDF…';
  try {
    const file = await exportFramesPdf(editor, `${files.name} — ${editor.doc.get(editor.pageId, 'name') ?? ''}`, print);
    if (!file) {
      status.textContent = '';
      return toast('На странице нет фреймов');
    }
    const where = await deliver([file], file.name);
    status.textContent = where ? `PDF: ${where}` : '';
  } catch (e) {
    status.textContent = '';
    toast(`Не удалось собрать PDF: ${(e as Error).message}`, 'error');
  }
}

/** Copy the selection as SVG (markup text). */
async function copyAsSvg() {
  if (!editor.selection.length) return;
  try {
    const svg = await exportSvg(editor, editor.selection, { outlineText: false });
    await navigator.clipboard.writeText(svg);
    toast('Скопировано как SVG');
  } catch (e) {
    toast(`Не удалось скопировать: ${(e as Error).message}`, 'error');
  }
}

/** Copy the styling of the selected layers as CSS. */
async function copyAsCss() {
  if (!editor.selection.length) return;
  try {
    await navigator.clipboard.writeText(editor.selection.map((id) => cssOf(editor.doc, id)).join('\n\n'));
    toast('Скопировано как CSS');
  } catch (e) {
    toast(`Не удалось скопировать: ${(e as Error).message}`, 'error');
  }
}

/** Copy the selection as PNG (a single image), to paste into a messenger or a document. */
async function copyAsPng() {
  if (!editor.selection.length) return;
  try {
    const { bytes } = await editor.exportImage(editor.selection, 1, 'PNG');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes as BlobPart], { type: 'image/png' }) })]);
    toast('Скопировано как PNG');
  } catch (e) {
    toast(`Не удалось скопировать: ${(e as Error).message}`, 'error');
  }
}

function saveBytes(bytes: Uint8Array, name: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function save(as = false) {
  const status = $('status');
  status.textContent = 'Сохраняю…';
  // Desktop: a file on disk (no path, or “as”: ask).
  if (isDesktop) {
    try {
      const ok = await files.saveToDisk(as);
      status.textContent = ok ? `Сохранено: ${files.current.path}` : '';
    } catch (e) {
      status.textContent = '';
      toast(`Не удалось сохранить: ${(e as Error).message}`, 'error');
    }
    return;
  }
  try {
    if (editor.importing) {
      status.textContent = 'Дожидаюсь загрузки всех страниц…';
      await editor.importing;
    }
    const t0 = performance.now();
    const { size, missing } = await download(editor.doc, files.name, editor.store, (p) => (status.textContent = `Сохраняю… ${Math.round(p * 100)}%`));
    status.textContent = `Сохранено: ${(size / 2 ** 20).toFixed(1)} МБ за ${Math.round(performance.now() - t0)} мс`;
    if (missing.length) toast(`Не найдено картинок: ${missing.length} — в файл они не попали`, 'error');
  } catch (e) {
    status.textContent = '';
    toast(`Не удалось сохранить: ${(e as Error).message}`, 'error');
    console.error(e);
  }
}

// ---------- Menus ----------


async function newFile(folder = '') {
  await files.leave();
  exitPreview(false);
  const n = newDocument();
  pluginHost?.stop();
  editor.setDocument(n.doc, n.page, null);
  rebindPlugins();
  files.newFile(folder);
  editor.setCamera({ x: -100, y: -100, zoom: 1 });
  updateChrome();
}

function selectAll() {
  selectAllSiblings();
}

/**
 * Context menu (right click on the canvas or on a layer). at is the point on the canvas
 * (for “Paste here” and “Select layer”); the layers menu has none.
 */
/**
 * Document length units (MFP's own): the X, Y, W, H and corner radius fields, rulers and the
 * on-canvas size in mm, cm, inches or pt; values are still stored in px. Conversion resolution:
 * 72 points per inch (1 px = 1 pt, as in print PDF) or 96 (as in CSS). One undo step.
 */
function unitsMenu(): MenuEntry[] {
  const doc = editor.doc;
  const cur = doc.get(doc.root, 'documentUnits') ?? { unit: 'px' as const, dpi: DEFAULT_DPI };
  const set = (next: { unit: LengthUnit; dpi: number }) => {
    doc.transact(() => doc.set(doc.root, { documentUnits: next.unit === 'px' && next.dpi === DEFAULT_DPI ? undefined : next }));
    editor.dirty = true;
    panels.schedule();
  };
  const units: [LengthUnit, string][] = [['px', 'Пиксели (px)'], ['mm', 'Миллиметры (мм)'], ['cm', 'Сантиметры (см)'], ['in', 'Дюймы'], ['pt', 'Пункты (pt)']];
  return [
    ...units.map(([unit, label]) => ({ label, checked: cur.unit === unit, run: () => set({ unit, dpi: cur.dpi }) })),
    'sep',
    { label: '72 точки на дюйм — печать, PDF', checked: cur.dpi === 72, disabled: cur.unit === 'px', run: () => set({ unit: cur.unit, dpi: 72 }) },
    { label: '96 точек на дюйм — как CSS', checked: cur.dpi === 96, disabled: cur.unit === 'px', run: () => set({ unit: cur.unit, dpi: 96 }) },
  ];
}

function contextMenu(at?: [number, number]): MenuEntry[] {
  const doc = editor.doc;
  const sel = editor.selection.filter((id) => doc.has(id));
  const clip = clipboard.length > 0;
  if (!sel.length) {
    return [
      { label: 'Вставить сюда', disabled: !clip || !at, run: () => at && paste('here', at) },
      { label: 'Вставить', hint: 'Ctrl+V', disabled: !clip, run: () => paste() },
      'sep',
      { label: 'Выделить всё', hint: 'Ctrl+A', run: selectAll },
      { label: 'Показать всё', hint: 'Shift+1', run: () => editor.fitPage(true) },
      { label: 'Масштаб 100%', hint: 'Shift+0', run: () => editor.zoomTo100(true) },
      { label: 'Сохранённые виды', submenu: () => savedViewsMenu(editor) },
      ...(focusMode.active ? [{ label: 'Выйти из изоляции', hint: 'Esc', run: () => focusMode.exit() }] : []),
      ...defaultTextMenu(editor, []),
      'sep',
      { label: 'Плагины', submenu: pluginItems },
    ];
  }
  const isGroup = sel.some((id) => ['GROUP', 'FRAME', 'BOOLEAN_OPERATION'].includes(doc.type(id) ?? ''));
  const hasInstance = sel.some((id) => doc.type(id) === 'INSTANCE');
  const visible = sel.some((id) => doc.get(id, 'visible') !== false);
  const locked = sel.every((id) => doc.get(id, 'locked') === true);
  const items: MenuEntry[] = [
    { label: 'Копировать', hint: 'Ctrl+C', run: copySelection },
    { label: 'Вставить сюда', disabled: !clip || !at, run: () => at && paste('here', at) },
    { label: 'Вставить с заменой', hint: 'Ctrl+Shift+R', disabled: !clip, run: () => paste('replace') },
    {
      label: 'Копировать или вставить как',
      submenu: [
        { label: 'Копировать как CSS', run: () => void copyAsCss() },
        { label: 'Копировать как SVG', run: () => void copyAsSvg() },
        { label: 'Копировать как PNG', hint: 'Ctrl+Shift+C', run: () => void copyAsPng() },
        { label: 'Копировать ссылку на слой', hint: 'Ctrl+L', run: () => copyNodeLink() },
        'sep',
        { label: 'Копировать свойства', hint: 'Ctrl+Alt+C', run: copyProperties },
        { label: 'Вставить свойства', hint: 'Ctrl+Alt+V', disabled: !propsClipboard, run: pasteProperties },
      ],
    },
  ];
  // Layers stacked under the cursor: pick any of them (from the top down to the deepest).
  if (at) {
    const stack = editor.scene
      .hitPath(at[0], at[1], 4 / editor.camera.zoom)
      .map((n) => editor.scene.id(n)!)
      .filter((id) => doc.get(id, 'locked') !== true);
    if (stack.length > 1) {
      items.push('sep', {
        label: 'Выбрать слой',
        submenu: stack.map((id) => ({ label: doc.get(id, 'name') || doc.type(id)!, checked: sel.includes(id), run: () => editor.select([id]) })),
      });
    }
  }
  items.push(
    'sep',
    { label: 'На передний план', hint: 'Ctrl+Shift+]', run: () => reorder(Infinity) },
    { label: 'Выше', hint: 'Ctrl+]', run: () => reorder(1) },
    { label: 'Ниже', hint: 'Ctrl+[', run: () => reorder(-1) },
    { label: 'На задний план', hint: 'Ctrl+Shift+[', run: () => reorder(-Infinity) },
    'sep',
    { label: 'Сгруппировать', hint: 'Ctrl+G', run: group },
    { label: 'Обернуть во фрейм', hint: 'Ctrl+Alt+G', run: frameSelection },
    { label: 'Разгруппировать', hint: 'Ctrl+Shift+G', disabled: !isGroup, run: ungroup },
    'sep',
    { label: 'Сплющить', hint: 'Ctrl+E', run: flatten },
    { label: 'Контур обводки', hint: outlineStrokeHint(), run: outlineStroke },
    { label: 'Маска', hint: 'Ctrl+Alt+M', run: useAsMask },
    'sep',
    { label: 'Добавить автораскладку', hint: 'Shift+A', run: addAutoLayout },
    hasInstance ? { label: 'Отсоединить инстанс', hint: 'Ctrl+Alt+B', run: detachSelection } : { label: 'Создать компонент', hint: 'Ctrl+Alt+K', run: createComponent },
  );
  // Dev status (frames and sections).
  const status = devStatus.menuItems(sel);
  if (status.length) items.push(...status);
  items.push(
    'sep',
    { label: 'Плагины', submenu: pluginItems },
    'sep',
    { label: visible ? 'Скрыть' : 'Показать', hint: 'Ctrl+Shift+H', run: () => toggleSelection('visible') },
    { label: locked ? 'Разблокировать' : 'Заблокировать', hint: 'Ctrl+Shift+L', run: () => toggleSelection('locked') },
    'sep',
    { label: 'Отразить по горизонтали', hint: 'Shift+H', run: () => flipSelection(-1, 1) },
    { label: 'Отразить по вертикали', hint: 'Shift+V', run: () => flipSelection(1, -1) },
  );
  const otherPages = userPages(doc).filter((p) => p !== editor.pageId);
  const cover =
    sel.length === 1 && doc.parent(sel[0]!) === editor.pageId && ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION'].includes(doc.type(sel[0]!) ?? '')
      ? doc.get(doc.root, 'thumbnailNodeId') === sel[0]
      : null;
  if (otherPages.length || cover !== null) items.push('sep');
  if (otherPages.length) items.push({ label: 'Переместить на страницу', submenu: otherPages.map((p) => ({ label: doc.get(p, 'name') || 'Страница', run: () => moveToPage(p) })) });
  // File cover: a top-level frame, component or section.
  if (cover !== null) {
    items.push({
      label: cover ? 'Обложка файла ✓ (вернуть первый фрейм)' : 'Сделать обложкой файла',
      run: () => {
        doc.transact(() => doc.set(doc.root, { thumbnailNodeId: cover ? undefined : sel[0]! }));
        void files.makeThumbnail();
        toast(cover ? 'Обложка — снова первый фрейм первой страницы' : 'Обложка файла обновится в «Файлах»');
      },
    });
  }
  items.push('sep', { label: 'Ещё', submenu: () => moreMenu(sel, at) }, { label: 'Удалить', hint: 'Delete', run: deleteSelection });
  return items;
}

/** “More” in the context menu: additional MFP features. */
function moreMenu(sel: string[], at?: [number, number]): MenuEntry[] {
  const doc = editor.doc;
  const items: MenuEntry[] = [...imagingMenuItems(sel)];
  // Several layers: the layer under the cursor is the key object for alignment (like Alt+click).
  if (at && sel.length > 1) {
    const under = editor.scene.hitPath(at[0], at[1], 4 / editor.camera.zoom).map((n) => editor.scene.id(n)!).find((id) => sel.includes(id));
    if (under) {
      const on = editor.keyObject === under;
      items.push({
        label: on ? 'Снять ключевой объект' : 'Сделать ключевым объектом',
        hint: 'Alt+щелчок',
        run: () => {
          editor.keyObject = on ? null : under;
          editor.dirty = true;
          panels.schedule();
        },
      });
    }
  }
  // An image in a single layer's fill: crop with a box, vectorize.
  if (sel.length === 1) {
    const fills = (doc.get(sel[0]!, 'fills') ?? []) as { type: string; imageHash?: string | null }[];
    const index = fills.map((p, i) => (p.type === 'IMAGE' && p.imageHash ? i : -1)).filter((i) => i >= 0).pop();
    if (index !== undefined) items.push({ label: 'Обрезать картинку', run: () => imageCrop.start({ id: sel[0]!, key: 'fills', index }) });
    if (hasImageFill(editor, sel[0]!)) items.push({ label: 'Векторизовать…', run: () => void openVectorizeDialog(editor, sel[0]!, toast) });
  }
  if (items.length) items.push('sep');
  items.push(
    { label: sel.length > 1 ? 'Переименовать слои…' : 'Переименовать', hint: 'Ctrl+R', run: renameSelection },
    labelMenu(editor, sel),
    { label: 'Повторить сеткой', run: () => repeatSelection(editor, createComponent, toast) },
    { label: 'Заполнить данными…', run: () => openDataFill(editor, toast) },
    ...(sel.length > 1 ? [{ label: 'По дуге или кругу…', run: () => openArcLayout(editor, toast) }] : []),
    orderMenu(editor, sel),
    invertMenu(editor, sel, toast),
    focusMode.active ? { label: 'Выйти из изоляции', hint: 'Esc', run: () => focusMode.exit() } : { label: 'Изолировать', run: () => focusMode.enter(sel) },
    'sep',
    { label: 'Сместить контур…', run: () => openOffsetDialog(editor, (m) => toast(m)) },
    { label: 'Упростить контур', run: () => toast(simplifySelection(editor)) },
  );
  const text = [...defaultTextMenu(editor, sel), ...textOpsMenu(editor, sel)];
  if (text.length) items.push('sep', ...text);
  return items;
}

tools.onContextMenu = (x, y, at) => showMenuAt(x, y, contextMenu(at));
panels.headerActions = { devMode: () => setDevMode(true), createComponent, menu: () => contextMenu() };
tools.duplicateForDrag = duplicateInPlace;
tools.onKeyObject = () => panels.schedule();
panels.onContextMenu = (x, y) => showMenuAt(x, y, contextMenu());

// ---------- View: interface, outlines, pixels, magnifier ----------

/** Ctrl+\ hides the whole interface, Ctrl+Shift+\ only the side panels. */
/** Pixel preview: 0 is off, 1 or 2 shows export pixels when zoomed in. */
function setPixelPreview(v: number) {
  editor.pixelPreview = v;
  editor.dirty = true;
  toast(v ? `Предпросмотр пикселей ${v}x: приблизьте — видно, какими пикселями выйдет экспорт` : 'Предпросмотр пикселей выключен');
}

function toggleUi(kind: 'hidden' | 'min') {
  const cls = kind === 'hidden' ? 'ui-hidden' : 'ui-min';
  const on = !document.body.classList.contains(cls);
  document.body.classList.remove('ui-hidden', 'ui-min');
  document.body.classList.toggle(cls, on);
}

function toggleOutline() {
  editor.outline = !editor.outline;
  // Lines are dark on a light page background and light on a dark one.
  const bg = editor.doc.get(editor.pageId, 'backgrounds')?.[0];
  const c = bg?.type === 'SOLID' ? bg.color : { r: 0.96, g: 0.96, b: 0.96 };
  editor.renderer.outlineColor = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b < 0.5 ? [255, 255, 255] : [0, 0, 0];
  toast(editor.outline ? `Режим контуров (${outlineHint()} — выключить)` : 'Режим контуров выключен');
}

function togglePixelGrid() {
  editor.pixelGrid = !editor.pixelGrid;
  editor.dirty = true;
  toast(editor.pixelGrid ? 'Пиксельная сетка: видна с 800%' : 'Пиксельная сетка скрыта');
}

function togglePixelSnap() {
  editor.pixelSnap = !editor.pixelSnap;
  toast(editor.pixelSnap ? 'Привязка к пикселям включена' : 'Привязка к пикселям выключена');
}

function setZoomHeld(on: boolean) {
  tools.zoomHeld = on;
  $('stage').classList.toggle('tool-zoom', on);
}
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyZ') setZoomHeld(false);
});
window.addEventListener('blur', () => setZoomHeld(false));

/** Ctrl+Alt+Shift+R: frames and sections without auto layout get their box resized to fit the contents. */
function fitSelection() {
  const doc = editor.doc;
  const ids = editor.selection.filter((id) => ['FRAME', 'COMPONENT', 'SECTION'].includes(doc.type(id) ?? ''));
  if (!ids.length) return toast('Выделите фрейм или секцию');
  doc.transact(() => ids.forEach((id) => resizeToFit(doc, id)));
}

/** Ctrl+R: a single layer is renamed in the layers panel, several get batch renaming. */
function renameSelection() {
  const sel = editor.selection.filter((id) => editor.doc.has(id));
  if (sel.length > 1) openBatchRename(editor, sel);
  else if (sel.length) panels.rename(sel[0]!);
}

/** Alt+letter: alignment. */
const ALIGN_KEYS: Record<string, AlignMode | undefined> = { a: 'left', d: 'right', w: 'top', s: 'bottom', h: 'hcenter', v: 'vcenter' };

/** Main menu commands (for the actions menu and custom shortcuts). */
const menuActions = async () => (await actionsFromMenu(mainMenu())).filter((a) => a.label !== 'Действия');

/** Custom shortcut: find the command by key and run it (if unavailable right now, say so). */
async function runBound(key: string) {
  const a = (await menuActions()).find((x) => actionKey(x) === key);
  if (a) a.run();
  else toast(`Команда «${key.split('|').pop()}» сейчас недоступна`);
}

/** Actions menu (Ctrl+K): main menu commands, plugins and layers of the current page; asset and plugin tabs. */
function openActionsMenu(tab: ActionsTab = 'all') {
  void openActions(
    async () => (await menuActions()).map((a) => ({ ...a, hint: hintOf(a) })),
    (q, limit) => {
      const doc = editor.doc;
      const out: Action[] = [];
      for (const id of doc.descendants(editor.pageId)) {
        const name = doc.get(id, 'name') ?? '';
        if (!name.toLowerCase().includes(q)) continue;
        out.push({
          label: name,
          path: `Слой · ${NODE_LABEL[doc.type(id)!] ?? doc.type(id)}`,
          run: () => {
            editor.select([id]);
            const b = editor.selectionBounds([id]);
            if (b) editor.fitRect([b[0] - 40, b[1] - 40, b[2] + 40, b[3] + 40]);
          },
        });
        if (out.length >= limit) break;
      }
      return out;
    },
    {
      tab,
      assets: (q) =>
        componentEntries(editor.doc)
          .filter((c) => !q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q))
          .slice(0, 80)
          .map((c) => ({
            label: c.name || 'Компонент',
            path: `${c.isSet ? `Набор · ${c.variants} вар.` : 'Компонент'} · ${c.group}`,
            run: () => {
              const id = insertComponent(editor, c.id);
              if (id) editor.select([id]);
            },
          })),
      // Internal submenus (pin, remove) are not plugin commands.
      plugins: async () => (await actionsFromMenu(await pluginItems())).filter((x) => !/^(Закрепить наверху|Удалить плагин)/.test(x.path)),
    },
  );
}

function appearanceMenu(): MenuEntry[] {
  return [
    { label: 'Новое', checked: appearance.look === 'new', run: () => appearance.setLook('new') },
    { label: 'Классическое', checked: appearance.look === 'classic', run: () => appearance.setLook('classic') },
    'sep',
    { label: 'Тёмная тема', checked: appearance.look === 'new' && appearance.theme === 'dark', disabled: appearance.look !== 'new', run: () => appearance.setTheme('dark') },
    { label: 'Светлая тема', checked: appearance.look === 'new' && appearance.theme === 'light', disabled: appearance.look !== 'new', run: () => appearance.setTheme('light') },
    { label: 'Тема как в системе', checked: appearance.look === 'new' && appearance.theme === 'system', disabled: appearance.look !== 'new', run: () => appearance.setTheme('system') },
  ];
}

/** Main menu (logo at the top left): sections with submenus, as in desktop editors. */
function mainMenu(): MenuEntry[] {
  const sel = editor.selection.length > 0;
  const doc = editor.doc;
  return [
    ...(home ? [{ label: 'Файлы…', run: () => home.open() }] : []),
    { label: 'Действия…', hint: 'Ctrl+K', run: () => openActionsMenu() },
    'sep',
    {
      label: 'Файл',
      submenu: [
        { label: 'Новый файл', run: () => void newFile() },
        { label: isDesktop ? 'Открыть…' : 'Открыть или импорт…', hint: 'Ctrl+O', run: openFiles },
        {
          label: 'Файлы проекта',
          submenu: async () => {
            const list: { name: string; size: number }[] = await fetch('/api/fixtures')
              .then((r) => r.json())
              .catch(() => []);
            if (!list.length) return [{ label: 'Нет файлов в fixtures/', disabled: true }];
            return list.map((f) => ({ label: f.name, hint: `${Math.round(f.size / 2 ** 20)} МБ`, run: () => void load(openFixture(f.name), { source: `fixture:${f.name}`, reuse: true }) }));
          },
        },
        'sep',
        ...(isDesktop
          ? [
              { label: 'Сохранить', hint: 'Ctrl+S', run: () => void save() },
              { label: 'Сохранить как…', hint: 'Ctrl+Shift+S', run: () => void save(true) },
            ]
          : [{ label: 'Скачать .mfp', hint: 'Ctrl+S', run: () => void save() }]),
        ...(versionPanel
          ? [
              { label: 'Сохранить версию…', hint: 'Ctrl+Alt+S', run: saveVersion },
              { label: 'История версий', checked: versionPanel.isOpen, run: () => void versionPanel.toggle() },
            ]
          : []),
        { label: 'Ветки…', disabled: !files.remote, run: openBranches },
        ...(teamLibs ? [{ label: 'Опубликовать библиотеку…', run: () => teamLibs.publishDialog() }] : []),
        'sep',
        { label: 'Поместить картинку…', hint: 'Ctrl+Shift+K', disabled: editor.devMode, run: () => imageInput.click() },
        { label: 'Экспорт…', hint: 'Ctrl+Shift+E', run: () => openExportDialog(editor, (ids) => void exportSelection(ids)) },
        {
          label: 'Ещё экспорт',
          submenu: [
            { label: 'Фреймы в PDF…', run: () => void exportPagePdf() },
            { label: 'PDF для печати (под обрез)…', run: () => openPrintDialog((p) => void exportPagePdf(p)) },
            { label: 'Анимация', disabled: !animRoot(), submenu: ANIM_FORMATS.map((f) => ({ label: `${f.label}…`, run: () => void exportAnim(f.format) })) },
            'sep',
            ...tokensMenu(editor),
          ],
        },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', hint: 'Ctrl+Z', disabled: editor.devMode || (!doc.canUndo), run: () => doc.undo() },
        { label: 'Повторить', hint: 'Ctrl+Shift+Z', disabled: editor.devMode || (!doc.canRedo), run: () => doc.redo() },
        'sep',
        { label: 'Копировать', hint: 'Ctrl+C', disabled: !sel, run: copySelection },
        {
          label: 'Вырезать',
          hint: 'Ctrl+X',
          disabled: editor.devMode || (!sel),
          run: () => {
            copySelection();
            deleteSelection();
          },
        },
        { label: 'Вставить', hint: 'Ctrl+V', disabled: editor.devMode, run: () => paste() },
        { label: 'Вставить поверх выделенного', hint: 'Ctrl+Shift+V', disabled: editor.devMode || (!sel), run: () => paste('over') },
        { label: 'Вставить с заменой', hint: 'Ctrl+Shift+R', disabled: editor.devMode || (!sel), run: () => paste('replace') },
        { label: 'Дублировать', hint: 'Ctrl+D', disabled: editor.devMode || (!sel), run: duplicate },
        { label: 'Удалить', hint: 'Delete', disabled: editor.devMode || (!sel), run: deleteSelection },
        'sep',
        { label: 'Копировать свойства', hint: 'Ctrl+Alt+C', disabled: !sel, run: copyProperties },
        { label: 'Вставить свойства', hint: 'Ctrl+Alt+V', disabled: editor.devMode || (!sel || !propsClipboard), run: pasteProperties },
        'sep',
        { label: 'Найти и заменить…', hint: 'Ctrl+F', run: () => openFind(editor, (m) => toast(m)) },
        { label: 'Переименовать…', hint: 'Ctrl+R', disabled: editor.devMode || (!sel), run: renameSelection },
        'sep',
        { label: 'Выделить всё', hint: 'Ctrl+A', run: selectAll },
        { label: 'Инвертировать выделение', hint: 'Ctrl+Shift+A', disabled: !sel, run: selectInverse },
        {
          label: 'Выделить похожие',
          disabled: !sel,
          submenu: [
            { label: 'Совпадающие слои', hint: 'Ctrl+Alt+A', run: () => selectSame('matching') },
            { label: 'С той же заливкой', run: () => selectSame('fill') },
            { label: 'С той же обводкой', run: () => selectSame('stroke') },
            { label: 'С теми же эффектами', run: () => selectSame('effect') },
            { label: 'С тем же шрифтом', run: () => selectSame('font') },
            { label: 'Инстансы того же компонента', run: () => selectSame('instance') },
          ],
        },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Увеличить', hint: '+', run: () => zoomBy(1.25) },
        { label: 'Уменьшить', hint: '−', run: () => zoomBy(0.8) },
        { label: 'Показать всё', hint: 'Shift+1', run: () => editor.fitPage(true) },
        { label: 'К выделению', hint: 'Shift+2', disabled: !sel, run: () => editor.fitRect(editor.selectionBounds(), 8, true) },
        { label: 'Масштаб 100%', hint: 'Shift+0', run: () => editor.zoomTo100(true) },
        { label: 'Следующий фрейм', hint: 'N', run: () => stepFrame(1) },
        { label: 'Предыдущий фрейм', hint: 'Shift+N', run: () => stepFrame(-1) },
        'sep',
        ...viewToggles(),
        'sep',
        { label: 'Скрыть интерфейс', hint: 'Ctrl+\\', run: () => toggleUi('hidden') },
        { label: 'Свернуть интерфейс', hint: 'Ctrl+Shift+\\', run: () => toggleUi('min') },
        { label: 'Режим разработчика', hint: 'Shift+D', checked: editor.devMode, run: () => setDevMode(!editor.devMode) },
        'sep',
        { label: 'Мини-карта', checked: minimap.visible, run: () => minimap.toggle() },
        { label: 'Анимация (таймлайн)', hint: 'Shift+T', checked: timeline.open, run: () => timeline.toggle() },
        { label: 'Аннотации и измерения', checked: annotations.visible, disabled: editor.devMode, run: () => annotations.toggle() },
        { label: 'Сохранённые виды', submenu: () => savedViewsMenu(editor) },
        {
          label: 'Цветовое зрение',
          submenu: (Object.keys(VISION_LABEL) as VisionMode[]).map((m) => ({ label: VISION_LABEL[m], checked: vision.mode === m, run: () => vision.set(m) })),
        },
        { label: 'Проверить дизайн…', run: () => openCheckDesigns(editor) },
        'sep',
        { label: 'Свернуть все слои', hint: 'Alt+L', run: () => panels.collapseLayers() },
        'sep',
        { label: 'Назад', hint: 'Alt+←', disabled: !navigation.canBack, run: () => navigation.back() },
        { label: 'Вперёд', hint: 'Alt+→', disabled: !navigation.canForward, run: () => navigation.forward() },
      ],
    },
    {
      label: 'Объект',
      disabled: editor.devMode,
      submenu: [
        { label: 'Сгруппировать', hint: 'Ctrl+G', disabled: !sel, run: group },
        { label: 'Разгруппировать', hint: 'Ctrl+Shift+G', disabled: !sel, run: ungroup },
        { label: 'Обернуть во фрейм', hint: 'Ctrl+Alt+G', disabled: !sel, run: frameSelection },
        { label: 'Маска', hint: 'Ctrl+Alt+M', disabled: !sel, run: useAsMask },
        { label: 'Добавить автораскладку', hint: 'Shift+A', disabled: !sel, run: addAutoLayout },
        { label: 'Убрать автораскладку', hint: 'Alt+Shift+A', disabled: !editor.selection.some((id) => doc.has(id) && isAutoLayout(doc, id)), run: removeAutoLayout },
        { label: 'Подогнать по содержимому', hint: 'Ctrl+Alt+Shift+R', disabled: !sel, run: fitSelection },
        'sep',
        { label: 'Скрыть / показать', hint: 'Ctrl+Shift+H', disabled: !sel, run: () => toggleSelection('visible') },
        { label: 'Заблокировать / разблокировать', hint: 'Ctrl+Shift+L', disabled: !sel, run: () => toggleSelection('locked') },
        'sep',
        { label: 'Создать компонент', hint: 'Ctrl+Alt+K', disabled: !sel, run: createComponent },
        { label: 'Отсоединить инстанс', hint: 'Ctrl+Alt+B', disabled: !sel, run: detachSelection },
        'sep',
        { label: 'На передний план', hint: 'Ctrl+Shift+]', disabled: !sel, run: () => reorder(Infinity) },
        { label: 'Выше', hint: 'Ctrl+]', disabled: !sel, run: () => reorder(1) },
        { label: 'Ниже', hint: 'Ctrl+[', disabled: !sel, run: () => reorder(-1) },
        { label: 'На задний план', hint: 'Ctrl+Shift+[', disabled: !sel, run: () => reorder(-Infinity) },
        'sep',
        { label: 'Повторить сеткой', disabled: !sel, run: () => repeatSelection(editor, createComponent, toast) },
        { label: 'Заполнить данными (CSV, JSON)…', disabled: !sel, run: () => openDataFill(editor, toast) },
      ],
    },
    { label: 'Текст', disabled: editor.devMode, submenu: textMenu },
    {
      label: 'Расположение',
      disabled: editor.devMode,
      submenu: [
        { label: 'По левому краю', hint: 'Alt+A', disabled: !sel, run: () => align(editor, editor.selection, 'left') },
        { label: 'По центру по горизонтали', hint: 'Alt+H', disabled: !sel, run: () => align(editor, editor.selection, 'hcenter') },
        { label: 'По правому краю', hint: 'Alt+D', disabled: !sel, run: () => align(editor, editor.selection, 'right') },
        { label: 'По верхнему краю', hint: 'Alt+W', disabled: !sel, run: () => align(editor, editor.selection, 'top') },
        { label: 'По центру по вертикали', hint: 'Alt+V', disabled: !sel, run: () => align(editor, editor.selection, 'vcenter') },
        { label: 'По нижнему краю', hint: 'Alt+S', disabled: !sel, run: () => align(editor, editor.selection, 'bottom') },
        'sep',
        { label: 'Распределить по горизонтали', hint: 'Alt+Shift+H', disabled: editor.selection.length < 3, run: () => distribute(editor, editor.selection, 'x') },
        { label: 'Распределить по вертикали', hint: 'Alt+Shift+V', disabled: editor.selection.length < 3, run: () => distribute(editor, editor.selection, 'y') },
        { label: 'Упорядочить', hint: 'Ctrl+Alt+T', disabled: editor.selection.length < 2, run: () => tidyUp(editor, editor.selection) },
        'sep',
        { label: 'По дуге или кругу…', disabled: editor.selection.length < 2, run: () => openArcLayout(editor, toast) },
      ],
    },
    {
      label: 'Вектор',
      disabled: editor.devMode,
      submenu: [
        { label: 'Объединить', hint: 'Alt+Shift+U', disabled: editor.selection.length < 2, run: () => booleanOp('UNION') },
        { label: 'Вычесть', hint: 'Alt+Shift+S', disabled: editor.selection.length < 2, run: () => booleanOp('SUBTRACT') },
        { label: 'Пересечь', hint: 'Alt+Shift+I', disabled: editor.selection.length < 2, run: () => booleanOp('INTERSECT') },
        { label: 'Исключить', hint: 'Alt+Shift+E', disabled: editor.selection.length < 2, run: () => booleanOp('EXCLUDE') },
        'sep',
        { label: 'Сплющить', hint: 'Ctrl+E', disabled: !sel, run: flatten },
        { label: 'Контур обводки', hint: outlineStrokeHint(), disabled: !sel, run: outlineStroke },
        { label: 'Сместить контур…', disabled: !sel, run: () => openOffsetDialog(editor, (m) => toast(m)) },
        { label: 'Упростить контур', disabled: !sel, run: () => toast(simplifySelection(editor)) },
        {
          label: 'Векторизовать картинку…',
          disabled: editor.selection.length !== 1,
          run: () => void openVectorizeDialog(editor, editor.selection[0]!, toast),
        },
        { label: 'Конструктор фигур', hint: 'Shift+M', disabled: !sel, run: () => { const why = shapeBuilder.start(); if (why) toast(why); } },
      ],
    },
    { label: 'Плагины', submenu: pluginItems },
    { label: 'Настройки', submenu: preferencesMenu },
    'sep',
    { label: 'Библиотеки…', hint: 'Alt+3', run: () => openLibraries(editor, teamLibs) },
    'sep',
    {
      label: 'Справка и учётная запись',
      submenu: () => [
        account.signedIn
          ? { label: `Учётная запись (${account.user!.name})`, submenu: () => accountMenu(account, { notify: (m, k) => toast(m, k), signIn: () => void signIn(account) }) }
          : { label: 'Войти…', run: () => void signIn(account) },
        'sep',
        ...helpMenu(),
      ],
    },
  ];
}

/** Help: “?” at the bottom right and the last section of the main menu. */
function helpMenu(): MenuEntry[] {
  return helpItems({
    shortcuts: toggleShortcuts,
    customKeys: () => void openKeysDialog(menuActions),
    report: () => void reportProblem(),
    updates: isDesktop ? () => void checkUpdates(false) : undefined,
  });
}

/** The main menu's “Text”: styling of the selected text layers as a whole. */
function textMenu(): MenuEntry[] {
  const sel = editor.selection.filter((id) => editor.doc.has(id));
  const texts = sel.length > 0 && sel.every((id) => editor.doc.type(id) === 'TEXT');
  const key = (k: TextKey) => () => void styleTextKey(k);
  const step = (kind: 'size' | 'weight' | 'tracking' | 'leading', more: string, less: string, hints: [string, string]): MenuEntry[] => [
    { label: more, hint: hints[0], disabled: !texts, run: key({ kind, d: 1 }) },
    { label: less, hint: hints[1], disabled: !texts, run: key({ kind, d: -1 }) },
  ];
  const own = [...defaultTextMenu(editor, sel), ...textOpsMenu(editor, sel)];
  return [
    { label: 'Жирный', hint: 'Ctrl+B', disabled: !texts, run: () => void TEXT_TOGGLES.bold() },
    { label: 'Курсив', hint: 'Ctrl+I', disabled: !texts, run: () => void TEXT_TOGGLES.italic() },
    { label: 'Подчёркнутый', hint: 'Ctrl+U', disabled: !texts, run: () => void TEXT_TOGGLES.underline() },
    { label: 'Зачёркнутый', hint: 'Ctrl+Shift+X', disabled: !texts, run: () => void TEXT_TOGGLES.strike() },
    'sep',
    { label: 'Маркированный список', hint: 'Ctrl+Shift+8', disabled: !texts, run: () => void TEXT_TOGGLES.bullets() },
    { label: 'Нумерованный список', hint: 'Ctrl+Shift+7', disabled: !texts, run: () => void TEXT_TOGGLES.ordered() },
    'sep',
    {
      label: 'Выравнивание',
      disabled: !texts,
      submenu: [
        { label: 'По левому краю', hint: 'Ctrl+Alt+L', run: key({ kind: 'align', value: 'LEFT' }) },
        { label: 'По центру', hint: 'Ctrl+Alt+T', run: key({ kind: 'align', value: 'CENTER' }) },
        { label: 'По правому краю', hint: 'Ctrl+Alt+R', run: key({ kind: 'align', value: 'RIGHT' }) },
        { label: 'По ширине', hint: 'Ctrl+Alt+J', run: key({ kind: 'align', value: 'JUSTIFIED' }) },
      ],
    },
    {
      label: 'Изменить',
      disabled: !texts,
      submenu: [
        ...step('size', 'Кегль больше', 'Кегль меньше', ['Ctrl+Shift+>', 'Ctrl+Shift+<']),
        'sep',
        ...step('weight', 'Насыщеннее', 'Тоньше', ['Ctrl+Alt+>', 'Ctrl+Alt+<']),
        'sep',
        ...step('tracking', 'Межбуквенный больше', 'Межбуквенный меньше', ['Alt+>', 'Alt+<']),
        'sep',
        ...step('leading', 'Межстрочный больше', 'Межстрочный меньше', ['Alt+Shift+>', 'Alt+Shift+<']),
      ],
    },
    ...(own.length ? (['sep', ...own] as MenuEntry[]) : []),
  ];
}

/** The main menu's “Settings”. */
function preferencesMenu(): MenuEntry[] {
  return [
    { label: 'Оформление', submenu: appearanceMenu },
    // Language names are in their own languages (not translated): “Язык / Language” can be found in any interface language.
    {
      label: 'Язык / Language',
      submenu: () => [
        { label: 'Русский', checked: lang === 'ru', run: () => setLang('ru') },
        { label: 'English', checked: lang === 'en', run: () => setLang('en') },
      ],
    },
    { label: 'Высокий контраст', checked: contrast.on, run: () => contrast.toggle() },
    'sep',
    { label: 'Привязка к пикселям', hint: "Ctrl+Shift+'", checked: editor.pixelSnap, run: togglePixelSnap },
    {
      label: 'Новые слои — над выделенным',
      checked: editor.insertAboveSelection,
      run: () => {
        editor.insertAboveSelection = !editor.insertAboveSelection;
        try {
          localStorage.setItem('mfp.insertAbove', editor.insertAboveSelection ? '1' : '0');
        } catch {
          /* will not be remembered */
        }
        toast(editor.insertAboveSelection ? 'Новые слои появятся сразу над выделенным' : 'Новые слои — поверх всех, как обычно');
      },
    },
    network.locked ? { label: 'Доступ в интернет: запрещён в организации', checked: false, disabled: true } : {
      label: 'Доступ в интернет',
      checked: network.allowed,
      run: () => {
        network.set(!network.allowed);
        toast(network.allowed ? 'Интернет разрешён: шрифты каталога, ИИ' : 'Без интернета: только этот компьютер и сервер команды, шрифты — из комплекта');
      },
    },
    ...(isDesktop
      ? [
          network.locked
            ? { label: 'Проверять обновления: запрещено в организации', checked: false, disabled: true }
            : {
                label: 'Проверять обновления',
                checked: updatesCheck.on,
                run: () => {
                  updatesCheck.set(!updatesCheck.on);
                  toast(updatesCheck.on ? 'Приложение сообщит о новой версии: при запуске — одна проверка номера версии, без ваших данных' : 'Проверка обновлений выключена');
                },
              },
        ]
      : []),
    ...(isDesktop && !company?.server ? [{ label: appMode.local ? 'Режим: на этом компьютере…' : 'Режим: с сервером команды…', run: () => void chooseAppMode({ account, signIn: () => void signIn(account), notify: (m: string, k?: 'info' | 'error') => toast(m, k) }) }] : []),
    ...(isDesktop && !company?.server ? [{ label: 'Доступ для коллег в сети…', run: () => openOfficeDialog({ account, signIn: () => signIn(account), notify: (m: string, k?: 'info' | 'error') => toast(m, k) }) }] : []),
    'sep',
    { label: 'Подключить ИИ-агента (MCP)…', run: () => openMcpDialog(account, { notify: (m, k) => toast(m, k), signIn: () => void signIn(account) }) },
    { label: 'Шаг сдвига…', hint: `${nudgeStep.small} / ${nudgeStep.big} px`, run: editNudge },
    { label: 'Старые сочетания контуров (Shift+O)', checked: oldOutlineKeys(), run: () => setOldOutlineKeys(!oldOutlineKeys()) },
    'sep',
    { label: 'Единицы измерения', submenu: unitsMenu },
  ];
}

/** “Report a problem”: save an archive with the log and diagnostics (without file contents). */
async function reportProblem() {
  const { problemReport } = await import('./diagnostics.ts');
  const img = editor.imageStats();
  const bytes = await problemReport({
    файл: { узлов: editor.doc.size, страниц: editor.doc.children(editor.doc.root).length, наСервере: !!files.remote, совместно: collab.mode },
    картинки: { декодированоМБ: Math.round(img.bytes / 2 ** 20), загружено: img.loaded },
    сохранение: { журналПравок: files.autosave.canJournal, всёЗаписано: files.autosave.saved },
  });
  const name = `mfp-отчёт-${new Date().toISOString().slice(0, 10)}.zip`;
  if (isDesktop) {
    const path = await saveDialog({ defaultPath: name, title: 'Сохранить отчёт о проблеме', ext: 'zip', label: 'Архив' });
    if (!path) return;
    await disk.writeFile(path, bytes);
    toast(`Отчёт сохранён: ${path}. Содержимого файла в нём нет — отправьте его разработчику`);
  } else {
    downloadBytes(bytes, name, 'application/zip');
    toast('Отчёт скачан. Содержимого файла в нём нет — отправьте его разработчику');
  }
}

$('menu-btn').addEventListener('click', () => showMenu($('menu-btn'), mainMenu()));

// ---------- Plugins ----------

let pluginHost: PluginHost | null = null;
/** figma.currentUser.sessionId: one per window. */
const pluginSessionId = Math.floor(Math.random() * 1e9);
function rebindPlugins() {
  pluginHost = new PluginHost(pluginCallbacks());
  widgets.rebind();
}

/** Plugin (and widget) host handlers: document, selection, camera, requests. */
function pluginCallbacks(): PluginHostCallbacks {
  return {
    doc: editor.doc,
    getPage: () => editor.pageId,
    getSelection: () => editor.selection,
    getEditorType: () => editor.devMode ? 'dev' : 'figma',
    offline: () => !network.allowed,
    getInspectContainer: () => $('right'),
    setSelection: (ids) => editor.select(ids),
    setPage: (id) => {
      if (id !== editor.pageId && editor.doc.type(id) === 'PAGE') editor.setPage(id);
    },
    // figma.viewport: center of the visible area in canvas coordinates, zoom, canvas size.
    getPlayhead: () => timeline.playhead,
    getViewport: () => {
      const c = editor.camera;
      return { x: c.x + editor.viewW / 2 / c.zoom, y: c.y + editor.viewH / 2 / c.zoom, zoom: c.zoom, width: editor.viewW, height: editor.viewH };
    },
    setViewport: (v) => {
      const c = editor.camera;
      const zoom = v.zoom ?? c.zoom;
      const cx = v.center?.x ?? c.x + editor.viewW / 2 / c.zoom;
      const cy = v.center?.y ?? c.y + editor.viewH / 2 / c.zoom;
      editor.setCamera({ zoom, x: cx - editor.viewW / 2 / zoom, y: cy - editor.viewH / 2 / zoom });
    },
    currentUser: () => {
      const u = account.user;
      return u ? { id: u.id, name: u.name, photoUrl: null, color: u.color, sessionId: pluginSessionId } : { id: null, name: collab.me.name, photoUrl: null, color: collab.me.color, sessionId: pluginSessionId };
    },
    zoomTo: (ids) => editor.fitRect(editor.selectionBounds(ids)),
    notify: (m, kind) => toast(m, kind),
    log: (level, args) => console.log(`[плагин] ${level}:`, ...args),
    loadFont: (f) => editor.fonts.ensure(f),
    request: pluginRequest,
    addImage: (hash, bytes) => editor.store.put(hash, bytes),
  };
}

// Widgets: their own sandbox, clicks on elements, a property menu on the selected one.
const widgets = new Widgets(editor, pluginRegistry, () => new PluginHost(pluginCallbacks()), $('stage'), (m, kind) => toast(m, kind));
tools.onWidgetClick = (w, path, node) => void (editor.doc.get(node, 'widgetInput') !== undefined ? widgets.editInput(w, path, node) : widgets.click(w, path));

/** Plugin requests to the editor: rendering, images, network. */
async function pluginRequest(method: string, args: unknown): Promise<unknown> {
  const doc = editor.doc;
  switch (method) {
    case 'flatten': {
      // Right away, before the plugin's edits that delete the source layers (they arrive next).
      const { ids, origin } = args as { ids: string[]; origin: [number, number] };
      let out = '';
      for (const id of ids) {
        if (!doc.has(id) || !editor.isOnPage(id)) return null;
        const svg = editor.scene.flattenSvg(id);
        const segs = svg ? parsePath(svg) : null;
        if (segs) out += pathToSvg(transformPath(segs, multiply([1, 0, -origin[0], 0, 1, -origin[1]], editor.worldMatrix(id) as Matrix)));
      }
      return out || null;
    }
    case 'imageBytes':
      return (await editor.store.readImage(String(args))) ?? null;
    case 'imageFromUrl': {
      const res = await fetch(String(args));
      if (!res.ok) throw new Error(`Не удалось загрузить картинку: HTTP ${res.status}`);
      return editor.store.add(new Uint8Array(await res.arrayBuffer()));
    }
    case 'export': {
      const { id, settings } = args as { id: string; settings: Record<string, unknown> };
      return pluginExport(id, settings);
    }
    case 'fonts': {
      // Editor families (Fontsource): main styles; the computer's own fonts as is.
      const out: { family: string; style: string }[] = [];
      for (const family of FONT_FAMILIES) for (const style of ['Regular', 'Italic', 'Medium', 'SemiBold', 'Bold', 'Bold Italic']) out.push({ family, style });
      for (const family of editor.fonts.localFamilies) for (const style of editor.fonts.localStyles(family)) out.push({ family, style });
      return out;
    }
    case 'saveVersion': {
      const { title, description } = args as { title: string; description: string };
      const v = await files.versions?.snapshot('named', title || 'Версия плагина', description || undefined, true);
      if (!v) throw new Error('История версий недоступна для этого файла');
      return v.id;
    }
  }
  throw new Error(`Неизвестный запрос ${method}`);
}

/** exportAsync: a layer on the open page exports like the panel export; from another page, via its own scene (PNG, JPG). */
async function pluginExport(id: string, s: Record<string, unknown>): Promise<Uint8Array | string> {
  const doc = editor.doc;
  if (!doc.has(id)) throw new Error(`The node (id: ${id}) does not exist`);
  const format = String(s.format ?? 'PNG') as ExportSetting['format'] | 'SVG_STRING';
  const constraint = (s.constraint as ExportSetting['constraint']) ?? { type: 'SCALE', value: 1 };
  if (!editor.isOnPage(id)) {
    if (format !== 'PNG' && format !== 'JPG') throw new Error(`exportAsync: ${format} — пока только для слоёв открытой страницы`);
    const w = doc.get(id, 'width') ?? 1;
    const h = doc.get(id, 'height') ?? 1;
    const scale = constraint.type === 'SCALE' ? constraint.value : constraint.type === 'WIDTH' ? constraint.value / Math.max(1e-6, w) : constraint.value / Math.max(1e-6, h);
    const r = await editor.renderNode(id, 0, doc, { scale, type: format === 'JPG' ? 'image/jpeg' : 'image/png' });
    if (!r) throw new Error('Нечего экспортировать');
    return new Uint8Array(await r.blob.arrayBuffer());
  }
  if (format === 'SVG_STRING') return exportSvg(editor, [id], { outlineText: s.svgOutlineText !== false, idAttribute: !!s.svgIdAttribute });
  const setting: ExportSetting = {
    format,
    suffix: '',
    constraint,
    ...(s.contentsOnly === false ? { contentsOnly: false } : {}),
    ...(s.useAbsoluteBounds ? { useAbsoluteBounds: true } : {}),
    ...(s.svgOutlineText === false ? { svgOutlineText: false } : {}),
    ...(s.svgIdAttribute ? { svgIdAttribute: true } : {}),
  };
  const [file] = await exportNode(editor, id, [setting]);
  if (!file) throw new Error('Нечего экспортировать');
  return file.bytes;
}
rebindPlugins();
// The plugin gets the editor's selection, page and camera (selectionchange, currentpagechange, figma.viewport).
editor.onSelection.push(() => pluginHost?.syncSelection());
editor.onPage.push(() => pluginHost?.syncSelection());
// A protected page is view only (switching to an own page enables editing again).
editor.onPage.push(() => {
  if (files.remote) enforceRole();
});
// Protection was set or removed (by the owner, or from the server for others): re-evaluate the mode.
editor.onDocument.push((ops) => {
  if (files.remote && ops.some((o) => o.op === 'set' && 'pageProtection' in o.props)) enforceRole();
});
editor.onCamera.push(() => pluginHost?.syncViewport());
timeline.onTime.push(() => pluginHost?.syncPlayhead());

const pluginInput = $<HTMLInputElement>('plugin-input');
const pluginUi: PluginUiDeps = {
  registry: pluginRegistry,
  host: () => pluginHost,
  addCodegen: (bundle) => addCodegen(bundle),
  pickFiles: () => pluginInput.click(),
  notify: (m, kind) => toast(m, kind),
  insertWidget: (bundle) => widgets.insert(bundle),
  generate: () => openPluginGenerator(pluginUi, () => ai.showSettings()),
};

// Section strip: File, Assistant, Assets, Tools | Variables; notifications at the bottom.
{
  const rail = $('rail');
  const left = $('left');
  const railBtn = (icon: string, label: string, title: string) => {
    const b = document.createElement('button');
    b.className = 'rail-btn';
    b.title = title;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<span class="rail-ic">${icon}</span><span>${label}</span>`;
    return b;
  };
  // “Tools”: plugins and widgets as a list in the left panel (the same actions as in the plugins menu).
  const toolsSection = document.createElement('div');
  toolsSection.className = 'section';
  toolsSection.id = 'tools-section';
  const toolsHead = document.createElement('h3');
  toolsHead.textContent = 'Инструменты';
  const toolsList = document.createElement('div');
  toolsList.className = 'tools-list';
  toolsSection.append(toolsHead, toolsList);
  left.append(toolsSection);
  const renderTools = async () => {
    const entries = await pluginMenu(pluginUi);
    toolsList.replaceChildren();
    for (const e of entries) {
      if (e === 'sep') {
        toolsList.append(Object.assign(document.createElement('div'), { className: 'tools-sep' }));
        continue;
      }
      const row = document.createElement('button');
      row.className = 'tool-row';
      const ic = document.createElement('span');
      ic.className = 'tool-ic';
      ic.innerHTML = 'icon' in e && e.icon ? e.icon : ICON.plugins;
      const name = document.createElement('span');
      name.className = 'tool-name';
      name.textContent = e.label;
      row.append(ic, name);
      if (e.hint) row.append(Object.assign(document.createElement('span'), { className: 'tool-hint', textContent: e.hint }));
      // Internal items (pin, catalog, upload…) as plain rows.
      if (e.submenu || e.label.endsWith('…')) row.classList.add('tool-action');
      if (e.submenu) {
        row.classList.add('has-sub');
        row.addEventListener('click', async () => {
          const r = row.getBoundingClientRect();
          const items = typeof e.submenu === 'function' ? await e.submenu() : e.submenu!;
          showMenuAt(r.right + 4, r.top, items);
        });
      } else if (e.run) {
        row.disabled = !!e.disabled;
        row.addEventListener('click', () => {
          e.run!();
          setTimeout(() => void renderTools(), 300);
        });
      }
      toolsList.append(row);
    }
  };
  const toolsBtn = railBtn(ICON.plugins, 'Инструменты', 'Плагины и виджеты');
  const setTools = (on: boolean) => {
    left.classList.toggle('tools-mode', on);
    toolsBtn.classList.toggle('on', on);
    if (on) {
      for (const b of rail.querySelectorAll('.rail-btn')) if (b !== toolsBtn && b !== aiBtn) b.classList.remove('on');
      void renderTools();
    }
  };
  toolsBtn.addEventListener('click', () => setTools(true));
  exitTools = () => setTools(false);
  // “File” and “Assets” (managed by AssetsPanel) leave “Tools”.
  rail.addEventListener('click', (e) => {
    const b = (e.target as Element).closest('.rail-btn');
    if (b && b !== toolsBtn && b !== aiBtn && b !== varsBtn && left.classList.contains('tools-mode')) setTools(false);
  }, true);
  const varsBtn = railBtn(ICON.variable, 'Переменные', 'Переменные и коллекции');
  varsBtn.addEventListener('click', () => openVariablesWindow(editor));
  const fileBtn = rail.querySelector('.rail-btn[aria-label="Файл"]');
  const assetsBtn = rail.querySelector('.rail-btn[aria-label="Ассеты"]');
  const sep2 = document.createElement('div');
  sep2.className = 'rail-sep';
  const bell = rail.querySelector('.rail-bell');
  rail.append(...[fileBtn, aiBtn, assetsBtn, toolsBtn, sep2, varsBtn, bell].filter((x): x is Element => !!x));
}
installImaging($('rail'), {
  editor,
  notify: toast,
  server: { base: () => account.base, token: () => account.token },
  cloud: { api: account.api.bind(account), signedIn: () => !!account.token, teams: () => account.teams, projects: () => account.projects, openFileId: () => files.remote?.id ?? null },
});
pluginInput.addEventListener('change', async () => {
  const files = pluginInput.files;
  pluginInput.value = '';
  if (!files?.length) return;
  const byName = new Map([...files].map((f) => [f.name, f] as const));
  const mf = byName.get('manifest.json');
  if (!mf) return toast('Нужен manifest.json среди выбранных файлов', 'error');
  try {
    const { manifest, warnings } = parseManifest(JSON.parse(await mf.text()));
    for (const w of warnings) toast(`Плагин: ${w}`);
    const main = byName.get(manifest.main.split('/').pop()!);
    const uiName = typeof manifest.ui === 'string' ? manifest.ui.split('/').pop()! : undefined;
    if (!main) return toast(`Не выбран файл ${manifest.main}`, 'error');
    const bundle: PluginBundle = { manifest, code: await main.text(), html: uiName ? await byName.get(uiName)?.text() : undefined };
    // Several windows (ui is an object): files by name among the selected ones.
    if (manifest.ui && typeof manifest.ui === 'object') {
      bundle.uiFiles = {};
      for (const [k, f] of Object.entries(manifest.ui)) {
        const file = byName.get(String(f).split('/').pop()!);
        if (file) bundle.uiFiles[k] = await file.text();
      }
    }
    // The plugin stays in the “Plugins” menu; a single command without parameters runs right away.
    await installBundle(pluginUi, bundle, 'local');
    const cmds = pluginCommands(manifest);
    if (!isCodegen(manifest) && cmds.length === 1 && !cmds[0]!.parameters?.length) launch(pluginUi, bundle, cmds[0]!.command);
  } catch (err) {
    toast(String((err as Error).message), 'error');
  }
});

async function pluginItems(): Promise<MenuEntry[]> {
  return pluginMenu(pluginUi);
}
$('plugins-btn').addEventListener('click', () => openActionsMenu());

// ---------- Render loop ----------

new ResizeObserver(() => editor.resize()).observe(canvas);
const sceneLoading = document.createElement('div');
sceneLoading.className = 'scene-loading';
sceneLoading.setAttribute('role', 'status');
sceneLoading.textContent = 'Подготавливаем страницу…';
sceneLoading.hidden = true;
$('stage').append(sceneLoading);
function loop() {
  sceneLoading.hidden = !editor.sceneBuilding || !!serverOpening;
  $('app').inert = editor.sceneBuilding || !!serverOpening || !!fileTabs?.fileLoading;
  $('canvas').setAttribute('aria-busy', String(editor.sceneBuilding));
  if (fileTabs?.viewActive) return;
  editor.stepCamera(performance.now());
  // Design shows a still shader frame; the prototype player advances shader time.
  if (editor.dirty) {
    editor.dirty = false;
    editor.draw();
  }
}
let lastFrameError = '';
startFrameLoop(loop, error => {
  console.error('Canvas frame failed', error);
  const message = error instanceof Error ? error.message : String(error);
  if (message !== lastFrameError) {
    lastFrameError = message;
    toast(`Ошибка отрисовки холста: ${message}. Меню → Сообщить о проблеме — сохранить журнал.`, 'error');
  }
});
updateChrome();
// Tooltips: a dark badge with the name and shortcut instead of the native title.
installTooltips();
canvas.focus();
// Connecting an AI app via OAuth (MCP): the /oauth/authorize page shows the “Access to MFP” dialog.
if (isOAuthPage()) void openOAuthConsent(account);
// Desktop app, first launch: on this computer or with a team server.
else if (isDesktop && !appMode.chosen) void chooseAppMode({ account, signIn: () => void signIn(account), notify: (m, k) => toast(m, k), first: true });
document.body.classList.toggle('app-local', appMode.local);
$('status').textContent = 'Перетащите сюда .fig или .mfp, или откройте файл в меню слева сверху (Ctrl+O). ? — все сочетания клавиш.';
$('shortcuts-btn').addEventListener('click', () => showMenu($('shortcuts-btn'), helpMenu(), 'above'));

// ---------- Drag benchmark (CPU + GPU, synchronous) ----------

function benchDrag(id: string, frames = 120) {
  const doc = editor.doc;
  const px = new Uint8Array(4);
  const gl = editor.webgl();
  const times: number[] = [];
  const start = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
  doc.beginGroup();
  editor.beginLive([id], 'translate');
  for (let i = 1; i <= frames; i++) {
    const t0 = performance.now();
    doc.set(id, { transform: [start[0], start[1], start[2] + i * 3, start[3], start[4], start[5] + i] });
    editor.dirty = false;
    editor.draw();
    gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    times.push(performance.now() - t0);
  }
  editor.endLive();
  doc.endGroup();
  doc.undo();
  times.sort((a, b) => a - b);
  const p = (q: number) => +(times[Math.floor(times.length * q)] ?? 0).toFixed(2);
  return { frames, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: +(times[times.length - 1] ?? 0).toFixed(2), over16: times.filter((t) => t > 16.7).length };
}

// For automated tests and debugging.
(window as unknown as { mfp: unknown }).mfp = {
  editor,
  tools,
  panels,
  load: (name: string) => load(openFixture(name), { source: `fixture:${name}`, reuse: true }),
  /** Open a file (as if by drag and drop): automated tests and interface screenshots. */
  open: (file: File) => load(openFile(file), { source: `import:${file.name}` }),
  files,
  home,
  versionPanel,
  /** Prototype presentation URL (selected screen), opened in a tab for automated tests. */
  playerUrl: () => playerUrl(editor, () => files.name),
  /** The “Share with colleagues on the network” dialog (desktop app; automated tests and screenshots). */
  officeDialog: () => openOfficeDialog({ account, signIn: () => signIn(account), notify: (m: string, k?: 'info' | 'error') => toast(m, k) }),
  /** Debugging: system clipboard HTML for the selection (the cross-tab copy format). */
  clipboardHtml: async () => (await clipboardHtml(editor.selection.map(snapshotSubtree), editor.selection.map((id) => editor.worldMatrix(id) as Matrix))).html,
  /** Run a plugin: name, id or sample folder; command and parameters (run event). */
  runPlugin: async (name: string, command = '', parameters?: Record<string, unknown>) => {
    const p = (await pluginRegistry.list()).find((x) => x.bundle.manifest.name === name || x.bundle.manifest.id === name || x.url?.endsWith(`/${encodeURIComponent(name)}/`));
    if (!p) throw new Error(`Нет плагина ${name}`);
    pluginHost?.run(p.bundle, { command, parameters });
  },
  pluginHost: () => pluginHost,
  vectorTool,
  shapeBuilder,
  widthTool,
  timeline,
  collab,
  voice,
  ai,
  get widgets() {
    return widgets;
  },
  benchDrag,
  get doc() {
    return editor.doc;
  },
};
