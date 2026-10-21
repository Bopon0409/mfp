import { valueScrubber } from './value-scrub.ts';

/** Document listeners survive a variable row being rebuilt by its live preview. */
export function numberDrag(label: HTMLElement, start: () => number, apply: (v: number) => void,
  begin: () => void, end: () => void) {
  label.style.cursor = 'ew-resize';
  label.style.touchAction = 'none';
  const hint = 'тяните подпись: Shift — шаг 10, Alt — медленнее, Ctrl — быстрее';
  label.title = label.title ? `${label.title}; ${hint}` : hint.charAt(0).toUpperCase() + hint.slice(1);
  label.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('input, select, textarea, button')) return;
    const value = start();
    if (e.button !== 0 || !Number.isFinite(value)) return;
    e.preventDefault(); e.stopPropagation();
    const scrub = valueScrubber(value);
    let x = e.clientX, last = value, active = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const next = scrub(ev.clientX - x, ev); x = ev.clientX;
      if (next === last) return;
      if (!active) { begin(); active = true; }
      last = next; apply(next);
    };
    const finish = () => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', finish);
      if (active) end();
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(); };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', finish);
  });
}

/**
 * The first number in the field text (“150%”, “-0,5px”, “24”) and how to build the text with a
 * different number (the unit and the rest of the text are kept). No number — null.
 */
export function numberInText(text: string): { value: number; with: (v: number) => string } | null {
  const m = /-?\d+(?:[.,]\d+)?/.exec(text);
  if (!m) return null;
  const value = Number(m[0].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return { value, with: (v) => text.slice(0, m.index) + String(Math.round(v * 100) / 100) + text.slice(m.index + m[0].length) };
}

/**
 * Scrubbing the label of a text input (number with a unit): the field updates, commit(text)
 * applies the value; begin/end — one undo step per drag. fallback — the text to start from if the
 * field has no number (“Auto”). Pressing inside the input itself is regular typing.
 */
export function scrubTextInput(label: HTMLElement, input: HTMLInputElement, commit: (text: string) => void, begin: () => void, end: () => void, opts: { fallback?: string; min?: number; max?: number; step?: number } = {}) {
  let parsed: ReturnType<typeof numberInText> = null;
  let start = 0;
  numberDrag(
    label,
    () => {
      parsed = numberInText(input.value) ?? (opts.fallback ? numberInText(opts.fallback) : null);
      start = parsed ? parsed.value : 0;
      return parsed ? parsed.value : NaN;
    },
    (v) => {
      if (!parsed) return;
      // step — value per pixel of drag (less than one for fractional parameters).
      const stepped = Math.round((start + (v - start) * (opts.step ?? 1)) * 1000) / 1000;
      const x = Math.max(opts.min ?? -Infinity, Math.min(opts.max ?? Infinity, stepped));
      input.value = parsed.with(x);
      commit(input.value);
    },
    begin,
    end,
  );
}
