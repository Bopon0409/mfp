// Our own color picker: saturation and brightness square, hue, opacity,
// input in Hex / RGB / HSL / HSB / OKLCH, eyedropper (EyeDropper API) and document colors.
// OKLCH mode (our own): the square is chroma × lightness at the chosen hue, outside the sRGB gamut —
// hatching, the marker doesn't go beyond the gamut edge.
// Used both for solid fills and for gradient stops (the paint editor is paint-editor.ts).

import { inSrgb, maxChroma, oklchToRgb, rgbToOklch, type Oklch } from '@mfp/core';

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

type Mode = 'HEX' | 'RGB' | 'HSL' | 'HSB' | 'OKLCH';
const MODES: Mode[] = ['HEX', 'RGB', 'HSL', 'HSB', 'OKLCH'];
/** Maximum chroma on the OKLCH square (sRGB never exceeds ~0.32). */
const C_MAX = 0.33;
const MODE_KEY = 'mfp-color-mode';
function savedMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY) as Mode | null;
    return m && MODES.includes(m) ? m : 'HEX';
  } catch {
    return 'HEX';
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function rgbToHsv({ r, g, b }: RGBA): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

function rgbToHsl({ r, g, b }: RGBA): [number, number, number] {
  const [h, , v] = rgbToHsv({ r, g, b, a: 1 });
  const min = Math.min(r, g, b);
  const l = (v + min) / 2;
  const s = v === min ? 0 : l > 0.5 ? (v - min) / (2 - v - min) : (v - min) / (v + min);
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const v = l + s * Math.min(l, 1 - l);
  return hsvToRgb(h, v ? 2 * (1 - l / v) : 0, v);
}

const hex2 = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0').toUpperCase();
export const toHex = (c: RGBA) => `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** #rgb, #rrggbb, #rrggbbaa (the hash is optional). */
export function parseHex(s: string): RGBA | null {
  let t = s.trim().replace(/^#/, '');
  if (t.length === 3) t = [...t].map((ch) => ch + ch).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t)) return null;
  const n = (i: number) => parseInt(t.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: t.length === 8 ? n(6) : 1 };
}

const css = (c: RGBA, a = c.a) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;

export interface ColorPickerHandle {
  /** Picker: insert it into the paint editor window. */
  el: HTMLElement;
  /** Set the color from outside (e.g. another gradient stop was chosen). */
  set(c: RGBA): void;
}

/**
 * Picker. onInput — every change; onStart / onEnd — start and end of a drag (the caller
 * merges the changes into one undo step). docColors — document colors for quick picking.
 */
export function colorPicker(initial: RGBA, onInput: (c: RGBA) => void, opts: { onStart?: () => void; onEnd?: () => void; docColors?: RGBA[]; alpha?: boolean } = {}): ColorPickerHandle {
  let [h, s, v] = rgbToHsv(initial);
  let a = initial.a;
  let mode: Mode = savedMode();
  // The same color in OKLCH: for gray the previous hue is kept (otherwise the slider jumps to 0).
  let ok: Oklch = rgbToOklch(initial);
  const root = document.createElement('div');
  root.className = 'cp';
  root.innerHTML = `
    <div class="cp-sv"><canvas width="232" height="160"></canvas><span class="cp-thumb"></span></div>
    <div class="cp-sliders"><button class="cp-eye" title="Пипетка: взять цвет с экрана (I)"></button><div class="cp-stack"><div class="cp-slider cp-hue"><span class="cp-knob"></span></div>
    <div class="cp-slider cp-alpha"><div class="cp-alpha-fill"></div><span class="cp-knob"></span></div></div></div>
    <div class="cp-row"><select class="cp-mode">${MODES.map((m) => `<option${m === mode ? ' selected' : ''}>${m}</option>`).join('')}</select><div class="cp-inputs"></div><input class="cp-a" title="Непрозрачность, %"></div>
    <div class="cp-doc-head">На этой странице</div><div class="cp-doc"></div>`;
  const svBox = root.querySelector('.cp-sv') as HTMLElement;
  const sv = root.querySelector('.cp-sv canvas') as HTMLCanvasElement;
  const thumb = root.querySelector('.cp-thumb') as HTMLElement;
  const hue = root.querySelector('.cp-hue') as HTMLElement;
  const alpha = root.querySelector('.cp-alpha') as HTMLElement;
  const alphaFill = root.querySelector('.cp-alpha-fill') as HTMLElement;
  const modeSel = root.querySelector('.cp-mode') as HTMLSelectElement;
  const inputs = root.querySelector('.cp-inputs') as HTMLElement;
  const aInput = root.querySelector('.cp-a') as HTMLInputElement;
  const eye = root.querySelector('.cp-eye') as HTMLButtonElement;
  // Without opacity (page background): neither slider nor field.
  if (opts.alpha === false) {
    alpha.remove();
    aInput.remove();
  }
  eye.innerHTML =
    '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5l3 3M5 19l1.5-4.5 8-8 3 3-8 8z"/><path d="M15.5 4.5l1-1a2.1 2.1 0 013 3l-1 1"/></svg>';
  const color = (): RGBA => {
    if (mode === 'OKLCH') return oklchToRgb(ok.l, ok.c, ok.h, a);
    const [r, g, b] = hsvToRgb(h, s, v);
    return { r, g, b, a };
  };
  /** Color from outside (hex, eyedropper, document colors): both representations. */
  const fromRgb = (p: { r: number; g: number; b: number }) => {
    [h, s, v] = rgbToHsv({ ...p, a: 1 });
    const o = rgbToOklch(p);
    ok = { l: o.l, c: o.c, h: o.c < 1e-4 ? ok.h : o.h };
  };
  /** After an edit in one representation — the other follows (the hue of gray is not lost). */
  const follow = () => {
    const c = color();
    if (mode === 'OKLCH') {
      const [hh, ss, vv] = rgbToHsv(c);
      [h, s, v] = [ss ? hh : h, ss, vv];
    } else {
      const o = rgbToOklch(c);
      ok = { l: o.l, c: o.c, h: o.c < 1e-4 ? ok.h : o.h };
    }
  };

  /** OKLCH square: horizontally — chroma, vertically — lightness; outside sRGB — hatching. */
  const drawOklch = () => {
    const c = sv.getContext('2d')!;
    const W = sv.width;
    const H = sv.height;
    const img = c.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const l = 1 - y / (H - 1);
      for (let x = 0; x < W; x++) {
        const ch = (x / (W - 1)) * C_MAX;
        const i = (y * W + x) * 4;
        if (inSrgb(l, ch, ok.h)) {
          const p = oklchToRgb(l, ch, ok.h);
          d[i] = p.r * 255;
          d[i + 1] = p.g * 255;
          d[i + 2] = p.b * 255;
        } else {
          const stripe = (x + y) % 8 < 4 ? 92 : 72;
          d[i] = d[i + 1] = d[i + 2] = stripe;
        }
        d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  };
  /** OKLCH hue strip (at medium lightness and the chroma that fits). */
  const hueGradient = () => {
    if (mode !== 'OKLCH') return '';
    const stops: string[] = [];
    for (let deg = 0; deg <= 360; deg += 30) {
      const p = oklchToRgb(0.72, Math.min(0.16, maxChroma(0.72, deg)), deg);
      stops.push(css({ ...p, a: 1 }));
    }
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  };

  // The square depends only on the hue (and mode) — dragging over it doesn't redraw.
  let drawn = '';
  const drawSv = () => {
    const key = mode === 'OKLCH' ? `ok:${ok.h}` : `hsv:${h}`;
    if (key === drawn) return;
    drawn = key;
    if (mode === 'OKLCH') return drawOklch();
    const c = sv.getContext('2d')!;
    const [r, g, b] = hsvToRgb(h, 1, 1);
    c.fillStyle = css({ r, g, b, a: 1 });
    c.fillRect(0, 0, sv.width, sv.height);
    const white = c.createLinearGradient(0, 0, sv.width, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = white;
    c.fillRect(0, 0, sv.width, sv.height);
    const black = c.createLinearGradient(0, 0, 0, sv.height);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    c.fillStyle = black;
    c.fillRect(0, 0, sv.width, sv.height);
  };

  const renderInputs = () => {
    const c = color();
    inputs.replaceChildren();
    const field = (value: string, title: string, apply: (raw: string) => void) => {
      const el = document.createElement('input');
      el.value = value;
      el.title = title;
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') el.blur();
      });
      el.addEventListener('change', () => apply(el.value));
      inputs.append(el);
    };
    const nums = (vals: number[], titles: string[], apply: (v: number[]) => void) =>
      vals.forEach((val, i) =>
        field(String(Math.round(val)), titles[i]!, (raw) => {
          const n = Number(raw.replace(',', '.'));
          if (!Number.isFinite(n)) return sync();
          const next = [...vals];
          next[i] = n;
          apply(next);
        }),
      );
    if (mode === 'HEX') {
      field(toHex(c), 'Hex', (raw) => {
        const p = parseHex(raw);
        if (!p) return sync();
        fromRgb(p);
        if (raw.replace(/^#/, '').length === 8) a = p.a;
        commit();
      });
    } else if (mode === 'RGB') {
      nums([c.r * 255, c.g * 255, c.b * 255], ['R', 'G', 'B'], ([r, g, b]) => {
        [h, s, v] = rgbToHsv({ r: clamp01(r! / 255), g: clamp01(g! / 255), b: clamp01(b! / 255), a: 1 });
        commit();
      });
    } else if (mode === 'HSL') {
      const [hh, ss, ll] = rgbToHsl(c);
      nums([hh, ss * 100, ll * 100], ['H', 'S, %', 'L, %'], ([x, y, z]) => {
        const [r, g, b] = hslToRgb(((x! % 360) + 360) % 360, clamp01(y! / 100), clamp01(z! / 100));
        [h, s, v] = rgbToHsv({ r, g, b, a: 1 });
        h = ((x! % 360) + 360) % 360;
        commit();
      });
    } else if (mode === 'OKLCH') {
      // L — percent, C — up to 0.4 (three digits), H — degrees.
      const fieldsOk: [number, string, number][] = [
        [ok.l * 100, 'L — светлота, %', 1],
        [ok.c, 'C — насыщенность (0…0,37)', 3],
        [ok.h, 'H — оттенок, °', 1],
      ];
      fieldsOk.forEach(([val, title, digits], i) =>
        field(`${+val.toFixed(digits)}${i === 0 ? '%' : i === 2 ? '°' : ''}`, title, (raw) => {
          const n = Number(raw.replace(',', '.').replace(/[%°\s]/g, ''));
          if (!Number.isFinite(n)) return sync();
          if (i === 0) ok.l = clamp01(n / 100);
          else if (i === 1) ok.c = Math.max(0, Math.min(0.4, n));
          else ok.h = ((n % 360) + 360) % 360;
          ok.c = Math.min(ok.c, maxChroma(ok.l, ok.h));
          commit();
        }),
      );
    } else {
      nums([h, s * 100, v * 100], ['H', 'S, %', 'B, %'], ([x, y, z]) => {
        h = ((x! % 360) + 360) % 360;
        s = clamp01(y! / 100);
        v = clamp01(z! / 100);
        commit();
      });
    }
  };

  /** Show the current color in all parts of the picker. */
  const sync = () => {
    follow();
    root.classList.toggle('oklch', mode === 'OKLCH');
    drawSv();
    const oklch = mode === 'OKLCH';
    thumb.style.left = `${(oklch ? Math.min(1, ok.c / C_MAX) : s) * 100}%`;
    thumb.style.top = `${(1 - (oklch ? ok.l : v)) * 100}%`;
    hue.style.background = hueGradient();
    (hue.querySelector('.cp-knob') as HTMLElement).style.left = `${((oklch ? ok.h : h) / 360) * 100}%`;
    (alpha.querySelector('.cp-knob') as HTMLElement).style.left = `${a * 100}%`;
    const c = color();
    alphaFill.style.background = `linear-gradient(90deg, ${css(c, 0)}, ${css(c, 1)})`;
    if (document.activeElement?.parentElement !== inputs) renderInputs();
    if (document.activeElement !== aInput) aInput.value = `${Math.round(a * 100)}%`;
  };
  const commit = () => {
    sync();
    onInput(color());
  };

  /** Drag over an element: the value is the fraction of the width (and height). */
  const drag = (el: HTMLElement, apply: (fx: number, fy: number) => void) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      opts.onStart?.();
      const at = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        apply(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height));
        commit();
      };
      at(e);
      const move = (ev: PointerEvent) => at(ev);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        opts.onEnd?.();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };
  drag(svBox, (fx, fy) => {
    if (mode === 'OKLCH') {
      // The marker stays within the sRGB gamut edge.
      ok.l = 1 - fy;
      ok.c = Math.min(fx * C_MAX, maxChroma(ok.l, ok.h));
      return;
    }
    s = fx;
    v = 1 - fy;
  });
  drag(hue, (fx) => {
    if (mode === 'OKLCH') {
      ok.h = Math.min(359.99, fx * 360);
      ok.c = Math.min(ok.c, maxChroma(ok.l, ok.h));
    } else h = Math.min(359.99, fx * 360);
  });
  drag(alpha, (fx) => (a = Math.round(fx * 100) / 100));

  modeSel.addEventListener('change', () => {
    follow();
    mode = modeSel.value as Mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Without storage — the mode lasts until the window closes.
    }
    sync();
    renderInputs();
  });
  aInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') aInput.blur();
  });
  aInput.addEventListener('change', () => {
    const n = Number(aInput.value.replace('%', '').replace(',', '.'));
    if (Number.isFinite(n)) a = clamp01(n / 100);
    commit();
  });
  // Eyedropper: a color from anywhere on the screen (Chrome, Edge, desktop).
  const EyeDropperCtor = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (!EyeDropperCtor) eye.disabled = true;
  eye.addEventListener('click', async () => {
    if (!EyeDropperCtor) return;
    try {
      const res = await new EyeDropperCtor().open();
      const p = parseHex(res.sRGBHex);
      if (!p) return;
      fromRgb(p);
      commit();
    } catch {
      // Canceled (Esc) — change nothing.
    }
  });
  // Document colors.
  const docBox = root.querySelector('.cp-doc') as HTMLElement;
  for (const c of opts.docColors ?? []) {
    const sw = document.createElement('button');
    sw.className = 'cp-swatch';
    sw.title = `#${toHex(c)}${c.a < 1 ? ` · ${Math.round(c.a * 100)}%` : ''}`;
    sw.style.setProperty('--c', css(c));
    sw.addEventListener('click', () => {
      fromRgb(c);
      a = c.a;
      commit();
    });
    docBox.append(sw);
  }
  if (!opts.docColors?.length) {
    docBox.remove();
    root.querySelector('.cp-doc-head')?.remove();
  }
  sync();
  return {
    el: root,
    set(c: RGBA) {
      fromRgb(c);
      a = c.a;
      sync();
    },
  };
}
