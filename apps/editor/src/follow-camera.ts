type Camera = { x: number; y: number; zoom: number };

/** Retargetable damping: network packets update the goal, never restart a flight. */
export class FollowCamera {
  private target: Camera | null = null;
  private frame = 0;
  private at = 0;
  private read: () => Camera;
  private size: () => [number, number];
  private apply: (camera: Camera) => void;

  constructor(
    read: () => Camera,
    size: () => [number, number],
    apply: (camera: Camera) => void,
  ) { this.read = read; this.size = size; this.apply = apply; }

  move(target: Camera, immediate = false) {
    if (![target.x, target.y, target.zoom].every(Number.isFinite) || target.zoom <= 0) return;
    if (immediate) {
      this.stop();
      this.apply(target);
      return;
    }
    this.target = target;
    if (!this.frame) {
      this.at = performance.now();
      this.frame = requestAnimationFrame(this.step);
    }
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.target = null;
  }

  private step = (now: number) => {
    this.frame = 0;
    const to = this.target;
    if (!to) return;
    const from = this.read();
    const [w, h] = this.size().map(v => v / 2) as [number, number];
    const k = 1 - Math.exp(-Math.max(0, now - this.at) / 65);
    this.at = now;
    const dx = to.x + w / to.zoom - (from.x + w / from.zoom);
    const dy = to.y + h / to.zoom - (from.y + h / from.zoom);
    const logZoom = Math.log(to.zoom / from.zoom);
    const done = Math.hypot(dx, dy) * to.zoom < 0.25 && Math.abs(logZoom) < 0.0005;
    const zoom = from.zoom * Math.exp(logZoom * k);
    if (done) this.target = null;
    this.apply(done ? to : {
      zoom,
      x: from.x + w / from.zoom + dx * k - w / zoom,
      y: from.y + h / from.zoom + dy * k - h / zoom,
    });
    if (this.target) this.frame = requestAnimationFrame(this.step);
  };
}
