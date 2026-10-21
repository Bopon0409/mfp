/** A failed canvas frame must not stop loading-state updates and UI recovery. */
export function startFrameLoop(frame: () => void, onError: (error: unknown) => void) {
  let stopped = false;
  let handle = 0;
  const tick = () => {
    if (stopped) return;
    // Queue first, so even the error reporter cannot kill subsequent frames.
    handle = requestAnimationFrame(tick);
    try { frame(); } catch (error) { onError(error); }
  };
  tick();
  return () => { stopped = true; cancelAnimationFrame(handle); };
}
