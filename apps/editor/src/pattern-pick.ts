// Picking the pattern source layer on the canvas: click picks the topmost eligible layer under the
// pointer (Ctrl — the deepest); the layer with the pattern and its ancestors can't be picked (a
// pattern inside its own source). Highlight on hover, Esc or right-click cancels.

import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';

export class PatternPick implements PointerInterceptor {
  private ed: Editor;
  private resolve: ((id: string | null) => void) | null = null;
  private forbidden = new Set<string>();

  constructor(ed: Editor) {
    this.ed = ed;
  }

  get active(): boolean {
    return !!this.resolve;
  }

  /** Start picking; targets — layers that receive the pattern. */
  start(targets: string[]): Promise<string | null> {
    this.finish(null);
    const doc = this.ed.doc;
    this.forbidden = new Set();
    for (const id of targets) for (let cur: string | null = id; cur; cur = doc.parent(cur)) this.forbidden.add(cur);
    document.addEventListener('keydown', this.onKey, true);
    return new Promise((res) => (this.resolve = res));
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.finish(null);
  };

  private finish(id: string | null) {
    const r = this.resolve;
    if (!r) return;
    this.resolve = null;
    document.removeEventListener('keydown', this.onKey, true);
    this.ed.hover = null;
    this.ed.canvasEl.style.cursor = '';
    this.ed.dirty = true;
    r(id);
  }

  /** The layer under the pointer that can become the source. */
  private candidate(e: PointerEvent, wx: number, wy: number): string | null {
    const ed = this.ed;
    const path = ed.scene.hitPath(wx, wy, 3 / ed.camera.zoom);
    const ids = path.map((n) => ed.scene.id(n)).filter((id): id is string => !!id && !this.forbidden.has(id));
    return (e.ctrlKey || e.metaKey ? ids[ids.length - 1] : ids[0]) ?? null;
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.resolve) return false;
    this.finish(e.button === 0 ? this.candidate(e, wx, wy) : null);
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.resolve) return false;
    const id = this.candidate(e, wx, wy);
    if (this.ed.hover !== id) {
      this.ed.hover = id;
      this.ed.dirty = true;
    }
    this.ed.canvasEl.style.cursor = id ? 'crosshair' : 'not-allowed';
    return true;
  }

  up(): boolean {
    return false;
  }
}
