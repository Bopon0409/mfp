// Accessibility: screen reader announcements (aria-live), labels for icon buttons from their
// tooltip (title), high-contrast theme — its own button in the “View” menu or per the system setting.

let region: HTMLElement | null = null;
let timer = 0;

/** Tell the screen reader (politely: after the current phrase; frequent repeats — the last one). */
export function announce(text: string) {
  region ??= document.getElementById('announce');
  if (!region) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    // The reader won't repeat the same text twice in a row — clear it first.
    region!.textContent = '';
    requestAnimationFrame(() => (region!.textContent = text));
  }, 120);
}

/** A button without its own text (icon only): its name for the screen reader is its tooltip. */
function label(b: Element) {
  const title = b.getAttribute('title');
  if (!title || b.textContent?.trim()) return;
  if (b.getAttribute('aria-label') !== title) b.setAttribute('aria-label', title);
}

/** Icon buttons inside root get aria-label from title — both new ones and when the tooltip changes. */
export function labelIconButtons(root: HTMLElement) {
  for (const b of root.querySelectorAll('button[title]')) label(b);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target instanceof HTMLButtonElement) label(r.target);
        continue;
      }
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n instanceof HTMLButtonElement) label(n);
        else if (n.firstElementChild) for (const b of n.querySelectorAll('button[title]')) label(b);
      }
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
}

// ---------- High contrast ----------

const KEY = 'mfp-contrast';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-contrast: more)') : null;

/** User choice: 'more' — high contrast, 'normal' — regular theme, null — follow the system. */
function preference(): 'more' | 'normal' | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'more' || v === 'normal' ? v : null;
  } catch {
    return null;
  }
}

export const contrast = {
  /** Subscribers: the theme changed (the canvas redraws selection boxes). */
  onChange: [] as ((on: boolean) => void)[],
  get on(): boolean {
    const p = preference();
    return p ? p === 'more' : !!media?.matches;
  },
  /** Turn on or off (remembered; matching the system setting — back to “follow the system”). */
  set(on: boolean) {
    try {
      if (on === !!media?.matches) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, on ? 'more' : 'normal');
    } catch {
      // Without storage — only until reload.
    }
    apply(on);
  },
  toggle() {
    this.set(!this.on);
  },
  /** Apply at startup and watch the system setting. */
  init() {
    apply(this.on);
    media?.addEventListener('change', () => {
      if (!preference()) apply(!!media.matches);
    });
  },
};

function apply(on: boolean) {
  document.documentElement.toggleAttribute('data-contrast', on);
  for (const cb of contrast.onChange) cb(on);
}
