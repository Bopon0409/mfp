/** Drag a floating window by empty space in its header, keeping it on screen. */
export function draggableWindow(box: HTMLElement, head: HTMLElement): () => void {
  let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
  let moved = false;
  head.style.cursor = 'move'; head.style.touchAction = 'none';
  const place = (left: number, top: number) => {
    const r = box.getBoundingClientRect();
    box.style.position = 'fixed'; box.style.transform = 'none'; box.style.margin = '0';
    box.style.left = `${Math.max(0, Math.min(left, window.innerWidth - r.width))}px`;
    box.style.top = `${Math.max(0, Math.min(top, window.innerHeight - Math.min(r.height, window.innerHeight)))}px`;
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('input,button,select,textarea,a,label,[contenteditable="true"],[role="button"]')) return;
    const r = box.getBoundingClientRect();
    // Fix the current width before taking a flex-positioned dialog out of flow.
    box.style.width = `${r.width}px`;
    box.style.maxWidth = 'calc(100vw - 16px)';
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    place(r.left, r.top); moved = true;
    head.setPointerCapture(e.pointerId); e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    place(drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y);
  };
  const stop = () => {
    const id = drag?.id; drag = null;
    if (id !== undefined && head.hasPointerCapture(id)) head.releasePointerCapture(id);
  };
  const resize = () => { if (moved && box.isConnected) { const r = box.getBoundingClientRect(); place(r.left, r.top); } };
  head.addEventListener('pointerdown', down); head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', stop); head.addEventListener('pointercancel', stop); head.addEventListener('lostpointercapture', stop);
  window.addEventListener('resize', resize);
  return () => {
    stop(); window.removeEventListener('resize', resize);
    head.removeEventListener('pointerdown', down); head.removeEventListener('pointermove', move);
    head.removeEventListener('pointerup', stop); head.removeEventListener('pointercancel', stop); head.removeEventListener('lostpointercapture', stop);
  };
}
