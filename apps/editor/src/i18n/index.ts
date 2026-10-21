// Interface language: Russian (the source: strings in the code) and English (the en.json dictionary).
//
// English is translated on the fly: at startup a Russian → English dictionary is loaded, and every
// label that appears in the document (text, title, placeholder, aria-label, native alert / confirm /
// prompt dialogs) is replaced through it. The dictionary holds exact strings and templates with
// {0}, {1}… slots (scripts/i18n-extract.ts collects them from the sources). User content is left
// alone: elements with translate="no" (layer, page and file names, comment texts), inputs and
// editable text. Where a label does not reach the document (canvas, names of new layers), the code
// calls t().

export type Lang = 'ru' | 'en';

const KEY = 'mfp.lang';
/** Language last chosen in the installer (so reinstalling with another language changes it). */
const INSTALLER_KEY = 'mfp.lang.installer';
const CYR = /[А-Яа-яЁё]/;

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Language: the user's choice; otherwise the browser or system language (Russian → Russian, anything else → English). */
function detect(): Lang {
  const v = read(KEY);
  if (v === 'ru' || v === 'en') return v;
  return /^(ru|be|uk|kk)\b/i.test(navigator.language || '') ? 'ru' : 'en';
}

export let lang: Lang = typeof navigator === 'undefined' ? 'ru' : detect();

/** Change the language (reloads the interface so labels are rebuilt). */
export function setLang(next: Lang, reload = true) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // no storage: until restart
  }
  if (reload && next !== lang) location.reload();
}

/** Whether the language was chosen explicitly (in Settings or by the installer). */
export const langChosen = () => read(KEY) === 'ru' || read(KEY) === 'en';

interface Dict {
  exact: Record<string, string>;
  patterns: Record<string, string>;
}

interface Pattern {
  ru: string;
  /** Constant pieces between the slots (one more than there are slots). */
  parts: string[];
  /** Substitutions without Russian letters (a short template like “{0} с”). */
  loose: boolean;
  /** A slot in quotes «…» is a user name (file, layer): do not translate. */
  quoted: boolean[];
  en: string;
}

let exact = new Map<string, string>();
let patterns: Pattern[] = [];
const cache = new Map<string, string>();
/** Longer ones: exact match only (long texts are in the dictionary in full). */
const MAX_PATTERN_INPUT = 2000;

/** Load the dictionary (English only). */
export function useDictionary(d: Dict) {
  exact = new Map(Object.entries(d.exact));
  patterns = Object.entries(d.patterns)
    .map(([ru, en]) => {
      const parts = ru.split(/\{\d+\}/);
      const holes = [...ru.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
      // Short constant text (“{0} с”, “{0} МБ”): substitutions without Russian letters, otherwise the template
      // would catch any phrase with the same ending.
      const loose = parts.join('').replace(/[^А-Яа-яЁё]/g, '').length < 3;
      const quoted = holes.map((_, i) => parts[i]!.endsWith('«') && parts[i + 1]!.startsWith('»'));
      return { ru, parts, loose, quoted, en: en.replace(/\{(\d+)\}/g, (_, n) => `\u0000${holes.indexOf(Number(n))}\u0000`) };
    })
    // Templates with longer constant text first: they are more precise.
    .sort((a, b) => b.parts.join('').length - a.parts.join('').length);
}

/**
 * Template match: constant pieces in order, each slot extends to the nearest following piece
 * (like a lazy “.*?”, but in linear time: no backtracking on long strings).
 */
function matchPattern(p: Pattern, s: string): string[] | null {
  const { parts } = p;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (s.length < first.length + last.length || !s.startsWith(first) || !s.endsWith(last)) return null;
  const end = s.length - last.length;
  const holes: string[] = [];
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = s.indexOf(parts[i]!, pos);
    if (at < 0 || at > end) return null;
    holes.push(s.slice(pos, at));
    pos = at + parts[i]!.length;
  }
  if (pos > end) return null;
  holes.push(s.slice(pos, end));
  if (p.loose && holes.some((x) => CYR.test(x))) return null;
  return holes;
}

/** Translate an interface string (no translation: return as is). */
export function tr(s: string): string {
  if (lang === 'ru' || !s || !CYR.test(s)) return s;
  const hit = exact.get(s);
  if (hit !== undefined) return hit;
  const cached = cache.get(s);
  if (cached !== undefined) return cached;
  let out = s;
  // Leading and trailing whitespace and newlines (markup text): translate the middle.
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  const core = exact.get(m[2]!);
  if (core !== undefined) out = m[1] + core + m[3];
  else if (s.length <= MAX_PATTERN_INPUT) {
    for (const p of patterns) {
      const holes = matchPattern(p, s);
      if (!holes) continue;
      out = p.en.replace(/\u0000(\d+)\u0000/g, (_, i) => (p.quoted[Number(i)] ? (holes[Number(i)] ?? '') : tr(holes[Number(i)] ?? '')));
      break;
    }
    if (out === s) out = fallback(s);
  }
  if (cache.size > 5000) cache.clear();
  cache.set(s, out);
  return out;
}

/**
 * A string assembled in code from ready labels: “Прямоугольник (R)” is a label plus a shortcut,
 * “Фрейм · 3 слоя” is parts joined by a separator. Pieces in quotes «…» (names) are left alone.
 */
function fallback(s: string): string {
  const key = /^([\s\S]*?[А-Яа-яЁё][\s\S]*?)(\s*\([^А-Яа-яЁё()]*\))$/.exec(s);
  if (key) {
    const head = tr(key[1]!);
    if (head !== key[1]) return head + key[2];
  }
  const parts = s.split(/( · | — | × |, |; |: )/);
  if (parts.length < 3) return s;
  return parts.map((x, i) => (i % 2 || x.includes('«') ? x : tr(x))).join('');
}

/** A label from code (canvas, names of new layers): Russian source → interface language; {0}… are substitutions. */
export function t(ru: string, ...args: (string | number)[]): string {
  const s = lang === 'ru' ? ru : (exact.get(ru) ?? patternOf(ru) ?? ru);
  return args.length ? s.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)] ?? '')) : s;
}

/** Template by its Russian key (not by the final text). */
function patternOf(ru: string): string | undefined {
  const p = patterns.find((x) => x.ru === ru);
  return p?.en.replace(/\u0000(\d+)\u0000/g, (_, i) => `{${i}}`);
}

// ---------- Document translation ----------

const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'alt'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
/** The text inside belongs to the user (code, input), but the element's own hints (title, aria-label) are interface. */
const ATTR_ONLY = new Set(['TEXTAREA', 'CODE', 'PRE']);

/**
 * Where user names and texts are shown (layers, pages, files, styles, variables, people,
 * comments): do not translate, even if a name matches an interface word (“Кнопка”, “Фрейм”).
 * In new code it is simpler to put translate="no" directly on the element.
 */
const USER = [
  '#filename', '.ui-restore > span', '.row > .name', '.frame-label', '.home-name', '.ftab-name',
  '.person-name', '.cmention-name', '.ccomment-name', '.ccomment-text', '.citem-name', '.citem-text', '.catt-name',
  '.style-name', '.var-name', '.var-name-cell', '.cmp-item-name', '.lib-update-name', '.usage-name',
  '.dv-name', '.dv-asset-name', '.dv-res-name', '.dv-ready-name', '.exposed-name', '.export-name', '.pill-name', '.def-name',
  '.cp-name', '.focus-name', '.lint-name', '.key-name', '.tl-name:not(.tl-prop)', '.pk-item-name', '.ups-file-name',
].join(', ');

/** The node is user content (do not translate). */
function userContent(el: Element | null): boolean {
  if (el?.closest(USER)) return true;
  for (let e = el; e; e = e.parentElement) {
    if (SKIP.has(e.tagName)) return true;
    if (e.getAttribute('translate') === 'no') return true;
    if ((e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

function translateText(node: Text) {
  const v = node.nodeValue;
  if (!v || !CYR.test(v) || userContent(node.parentElement)) return;
  const next = tr(v);
  if (next !== v) node.nodeValue = next;
}

function translateAttrs(el: Element) {
  // Input, code: the text inside belongs to the user, but the element's own hints are interface.
  const owner = ATTR_ONLY.has(el.tagName) && el.getAttribute('translate') !== 'no' ? el.parentElement : el;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && CYR.test(v) && !userContent(owner)) {
      const next = tr(v);
      if (next !== v) el.setAttribute(a, next);
    }
  }
  // Buttons and inputs: a button's value is its label.
  if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit') && CYR.test(el.value)) el.value = tr(el.value);
}

function translateTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    if (ATTR_ONLY.has(el.tagName)) return translateAttrs(el);
    if (SKIP.has(el.tagName) || el.getAttribute('translate') === 'no') return;
    translateAttrs(el);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    // Input: hints are translated (translateAttrs), its text is not (userContent).
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && !ATTR_ONLY.has((n as Element).tagName) && (SKIP.has((n as Element).tagName) || (n as Element).getAttribute('translate') === 'no') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text);
    else translateAttrs(n as Element);
  }
}

/** Tab title. Only if the translation differs: writing the title is another mutation, otherwise a loop. */
function translateTitle() {
  const v = document.title;
  if (!CYR.test(v)) return;
  const next = tr(v);
  if (next !== v) document.title = next;
}

/** Translate everything that appears in the document (English interface). */
export function installDomTranslation() {
  if (lang === 'ru') return;
  document.documentElement.lang = 'en';
  translateTree(document.body);
  translateTitle();
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') for (const n of r.addedNodes) translateTree(n);
      else if (r.type === 'characterData') translateText(r.target as Text);
      else if (r.type === 'attributes') translateAttrs(r.target as Element);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  new MutationObserver(translateTitle).observe(document.querySelector('title') ?? document.head, { subtree: true, childList: true, characterData: true });
  // Native browser dialogs.
  const { alert, confirm, prompt } = window;
  window.alert = (m?: unknown) => alert.call(window, typeof m === 'string' ? tr(m) : m);
  window.confirm = (m?: string) => confirm.call(window, m ? tr(m) : m);
  window.prompt = (m?: string, d?: string) => prompt.call(window, m ? tr(m) : m, d);
}

/**
 * Language chosen in the installer (desktop app): the installer writes lang.txt (“ru” or
 * “en”) next to the program. No file or not the app: null.
 */
async function installerLang(): Promise<Lang | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const { join, resourceDir } = await import('@tauri-apps/api/path');
    const raw = await invoke<ArrayBuffer | number[]>('read_file', { path: await join(await resourceDir(), 'lang.txt') });
    const v = new TextDecoder().decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw)).trim().toLowerCase();
    return v === 'ru' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

/** Prepare the language before the interface starts (entry.ts): the dictionary only for English. */
export async function initI18n() {
  // A new choice in the installer (first install or reinstall with another language) overrides
  // the earlier choice in Settings; after that, Settings decide again.
  const installed = await installerLang();
  if (installed && read(INSTALLER_KEY) !== installed) {
    try {
      localStorage.setItem(INSTALLER_KEY, installed);
      localStorage.setItem(KEY, installed);
    } catch {
      // no storage: for this launch only
    }
    lang = installed;
  }
  if (lang === 'ru') return;
  const d = (await import('./en.json')).default as Dict;
  useDictionary(d);
  installDomTranslation();
}
