// Interface appearance: new (design/interface.mfp → ui/new.css) or classic; the new one has
// dark, light or system theme. Features are the same in both appearances: markup and code
// are shared, only styles differ. The choice is in localStorage; index.html applies it before the first paint.

import { parseCssColor } from '@mfp/core';

export type Look = 'new' | 'classic';
export type Theme = 'dark' | 'light' | 'system';

const LOOK_KEY = 'mfp-ui';
const THEME_KEY = 'mfp-theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage — until reload.
  }
};

/** Selection color on the canvas (boxes, handles): 0…1. Classic appearance — MFP's own blue. */
export const canvasAccent = { r: 0.302, g: 0.482, b: 0.992, version: 0 };

export const appearance = {
  /** Subscribers: appearance or theme changed (the canvas recolors the selection). */
  onChange: [] as (() => void)[],
  /** The user's choice, otherwise the default from index.html (meta mfp-ui-default). */
  get look(): Look {
    const saved = read(LOOK_KEY);
    if (saved === 'classic' || saved === 'new') return saved;
    return document.querySelector<HTMLMetaElement>('meta[name="mfp-ui-default"]')?.content === 'classic' ? 'classic' : 'new';
  },
  get theme(): Theme {
    const t = read(THEME_KEY);
    return t === 'light' || t === 'system' ? t : 'dark';
  },
  /** Effective light theme: only for the new appearance. */
  get light(): boolean {
    return this.look === 'new' && (this.theme === 'light' || (this.theme === 'system' && !!media?.matches));
  },
  setLook(look: Look) {
    write(LOOK_KEY, look);
    apply();
  },
  setTheme(theme: Theme) {
    write(THEME_KEY, theme);
    apply();
  },
  /** Apply at startup and watch the system theme. */
  init() {
    apply();
    media?.addEventListener('change', () => {
      if (this.theme === 'system') apply();
    });
  },
  /** Recompute the canvas selection color (also after a high-contrast change). */
  refresh() {
    apply();
  },
};

function apply() {
  const el = document.documentElement;
  el.dataset.ui = appearance.look;
  if (appearance.light) el.dataset.theme = 'light';
  else delete el.dataset.theme;
  // Canvas accent comes from the new appearance's variables; classic and high contrast keep the old one.
  const css = appearance.look === 'new' && !el.hasAttribute('data-contrast') ? parseCssColor(getComputedStyle(el).getPropertyValue('--accent')) : null;
  const next = css ?? { r: 0.302, g: 0.482, b: 0.992 };
  if (next.r !== canvasAccent.r || next.g !== canvasAccent.g || next.b !== canvasAccent.b) {
    Object.assign(canvasAccent, { r: next.r, g: next.g, b: next.b, version: canvasAccent.version + 1 });
  }
  for (const cb of appearance.onChange) cb();
}
