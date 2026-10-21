/** Capture modified wheel before overlays/panels can leave it to browser zoom. */
export function installCanvasWheel(canvas: EventTarget, root: EventTarget, handle: (event: WheelEvent) => void): () => void {
  const zoom = (event: Event) => {
    const e = event as WheelEvent;
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    handle(e);
  };
  const wheel = (event: Event) => handle(event as WheelEvent);
  root.addEventListener('wheel', zoom, { capture: true, passive: false });
  canvas.addEventListener('wheel', wheel, { passive: false });
  return () => {
    root.removeEventListener('wheel', zoom, true);
    canvas.removeEventListener('wheel', wheel);
  };
}
