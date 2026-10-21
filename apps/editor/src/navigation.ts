// “Back / forward” navigation between places in the document — as in a browser (Alt+← / Alt+→,
// side mouse buttons). A place is a page, camera and selection. A new place is remembered on page
// change and when the camera has moved far (more than a screen, or zoom changed twofold) and
// stayed put for half a second.

import type { Editor } from './editor.ts';

interface Place {
  doc: object;
  pageId: string;
  camera: { x: number; y: number; zoom: number };
  selection: string[];
}

const SETTLE_MS = 500;
const LIMIT = 100;

export class Navigation {
  private ed: Editor;
  private places: Place[] = [];
  private index = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The camera is being moved by navigation itself — don't remember. */
  private restoring = false;
  onChange: (() => void) | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.onPage.push(() => {
      if (this.restoring) return;
      // New document — new history.
      if (this.current && this.current.doc !== ed.doc) {
        this.places = [];
        this.index = -1;
      }
      // The camera is set right after a page change — remember once it settles.
      this.schedule(true);
    });
    ed.onCamera.push(() => !this.restoring && this.schedule(false));
    this.record(true);
  }

  get canBack() {
    return this.index > 0;
  }

  get canForward() {
    return this.index < this.places.length - 1;
  }

  private get current(): Place | undefined {
    return this.places[this.index];
  }

  private snapshot(): Place {
    const ed = this.ed;
    return { doc: ed.doc, pageId: ed.pageId, camera: { ...ed.camera }, selection: [...ed.selection] };
  }

  private schedule(force: boolean) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.record(force);
    }, SETTLE_MS);
  }

  /** Whether a place is far from the current one: another page, offset beyond a screen, or twofold zoom. */
  private far(a: Place, b: Place): boolean {
    if (a.doc !== b.doc || a.pageId !== b.pageId) return true;
    const ratio = a.camera.zoom / b.camera.zoom;
    if (ratio > 2 || ratio < 0.5) return true;
    const w = this.ed.viewW / b.camera.zoom;
    const h = this.ed.viewH / b.camera.zoom;
    return Math.abs(a.camera.x - b.camera.x) > w || Math.abs(a.camera.y - b.camera.y) > h;
  }

  private record(force: boolean) {
    const place = this.snapshot();
    const cur = this.current;
    if (cur && !force && !this.far(place, cur)) {
      // Close to the current place — refine it (we return to where we ended up).
      this.places[this.index] = place;
      return;
    }
    if (cur && cur.doc === place.doc && cur.pageId === place.pageId && !this.far(place, cur)) {
      this.places[this.index] = place;
      return;
    }
    this.places.splice(this.index + 1);
    this.places.push(place);
    if (this.places.length > LIMIT) this.places.shift();
    this.index = this.places.length - 1;
    this.onChange?.();
  }

  back() {
    this.go(-1);
  }

  forward() {
    this.go(1);
  }

  private go(step: number) {
    // Unsaved move — remember it first so that “forward” returns here.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.record(false);
    }
    const target = this.places[this.index + step];
    if (!target || target.doc !== this.ed.doc) return;
    this.index += step;
    this.restoring = true;
    try {
      if (target.pageId !== this.ed.pageId && this.ed.doc.has(target.pageId)) this.ed.setPage(target.pageId);
      this.ed.setCamera(target.camera);
      this.ed.select(target.selection.filter((id) => this.ed.doc.has(id) && this.ed.isOnPage(id)));
    } finally {
      this.restoring = false;
    }
    this.onChange?.();
  }
}
