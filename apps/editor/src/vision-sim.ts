// Color vision deficiency simulation on the canvas (own feature): protanopia,
// deuteranopia, tritanopia (Machado, Oliveira, Fernandes 2009 matrices, severity 1.0 — in linear
// RGB, as feColorMatrix computes by default) and achromatopsia (luminance per Rec. 709). A CSS
// filter on the canvas element: the design and export are unchanged, rendering is as usual. While the mode is on —
// a label above the canvas, clicking it turns the mode off.

export type VisionMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'achromatopsia';

export const VISION_LABEL: Record<VisionMode, string> = {
  none: 'Обычное зрение',
  protanopia: 'Протанопия (нет красных колбочек)',
  deuteranopia: 'Дейтеранопия (нет зелёных колбочек)',
  tritanopia: 'Тританопия (нет синих колбочек)',
  achromatopsia: 'Ахроматопсия (без цвета)',
};

/** 3×3 matrices by rows (linear RGB). */
export const VISION_MATRIX: Record<Exclude<VisionMode, 'none'>, number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
  achromatopsia: [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722],
};

/** An sRGB color (0–1) as seen in the mode — for checks and hints. */
export function simulate(mode: VisionMode, c: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  if (mode === 'none') return { ...c };
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const enc = (v: number) => {
    const x = Math.max(0, Math.min(1, v));
    return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  const m = VISION_MATRIX[mode];
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  return { r: enc(m[0]! * r + m[1]! * g + m[2]! * b), g: enc(m[3]! * r + m[4]! * g + m[5]! * b), b: enc(m[6]! * r + m[7]! * g + m[8]! * b) };
}

/** feColorMatrix (4×5) from a 3×3 matrix. */
function feValues(m: number[]): string {
  return [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0].join(' ');
}

export class VisionSim {
  mode: VisionMode = 'none';
  private target: HTMLElement;
  private badge: HTMLButtonElement;

  constructor(target: HTMLElement, stage: HTMLElement) {
    this.target = target;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    for (const [mode, m] of Object.entries(VISION_MATRIX)) {
      const filter = document.createElementNS(ns, 'filter');
      filter.id = `mfp-vision-${mode}`;
      const fe = document.createElementNS(ns, 'feColorMatrix');
      fe.setAttribute('type', 'matrix');
      fe.setAttribute('values', feValues(m));
      filter.append(fe);
      svg.append(filter);
    }
    document.body.append(svg);
    this.badge = document.createElement('button');
    this.badge.className = 'vision-badge';
    this.badge.hidden = true;
    this.badge.title = 'Симуляция цветового зрения: щелчок — выключить';
    this.badge.addEventListener('click', () => this.set('none'));
    stage.append(this.badge);
  }

  set(mode: VisionMode) {
    this.mode = mode;
    this.target.style.filter = mode === 'none' ? '' : `url(#mfp-vision-${mode})`;
    this.badge.hidden = mode === 'none';
    this.badge.textContent = `👁 ${VISION_LABEL[mode]} ✕`;
  }
}
