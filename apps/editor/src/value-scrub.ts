type Modifiers = { shiftKey: boolean; altKey: boolean; ctrlKey: boolean };

/** Measure only this gesture, not movement since the browser's previous mouse event. */
export function scrubPointerDelta(start: { pointerId: number; clientX: number }) {
  let x = start.clientX;
  return (event: { pointerId: number; clientX: number }) => {
    if (event.pointerId !== start.pointerId) return 0;
    const dx = event.clientX - x;
    x = event.clientX;
    return dx;
  };
}

/** Keep fractional movement, but rebase when modifiers change to avoid jumps. */
export function valueScrubber(start: number) {
  let value = start, base = start, distance = 0, mode = '';
  return (dx: number, keys: Modifiers) => {
    const nextMode = `${keys.shiftKey}:${keys.altKey}:${keys.ctrlKey}`;
    if (nextMode !== mode) { base = value; distance = 0; mode = nextMode; }
    const step = keys.shiftKey ? 10 : keys.altKey ? 0.1 : 1;
    const speed = (keys.ctrlKey ? 10 : 1) * (keys.altKey && keys.shiftKey ? 0.1 : 1);
    distance += dx * speed;
    value = Math.round((base + Math.round(distance) * step) * 1e6) / 1e6;
    return value;
  };
}
