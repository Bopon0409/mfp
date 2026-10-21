// Device frames in prototype presentation — our own drawings (body, camera cutout, buttons): phone,
// Android, tablet, laptop, monitor, watch. The look comes from the page's device preset (name and
// size), body dimensions are fractions of the screen; landscape orientation puts the cutout at the side.

import type { Canvas, CanvasKit, Paint } from 'canvaskit-wasm';
import type { PrototypeDevice } from '@mfp/core';

export type DeviceKind = 'phone' | 'android' | 'tablet' | 'laptop' | 'desktop' | 'watch';

/** Device type (null — no frame: “Fit to window”, “Fit to screen”, custom size). */
export function deviceKind(dev: PrototypeDevice | undefined): DeviceKind | null {
  if (!dev || dev.type !== 'PRESET' || !dev.size) return null;
  const id = (dev.presetIdentifier ?? '').toLowerCase();
  const short = Math.min(dev.size.width, dev.size.height);
  if (/watch|часы/.test(id) || short <= 250) return 'watch';
  if (/macbook|laptop|ноутбук|notebook|surface laptop/.test(id)) return 'laptop';
  if (/desktop|imac|monitor|монитор|display|компьютер|tv/.test(id) || short > 1100) return 'desktop';
  if (/ipad|tab|планшет|tablet/.test(id) || short >= 600) return 'tablet';
  if (/android|pixel|galaxy|samsung|xiaomi|oneplus|honor|huawei/.test(id)) return 'android';
  return 'phone';
}

export interface FrameGeometry {
  /** Body margins around the screen: left, top, right, bottom (screen units). */
  insets: [number, number, number, number];
  /** Screen corner radius. */
  radius: number;
}

/** Body margins and screen corner radius. */
export function frameGeometry(kind: DeviceKind, vw: number, vh: number): FrameGeometry {
  const s = Math.min(vw, vh);
  switch (kind) {
    case 'phone':
    case 'android': {
      const b = s * 0.045;
      return { insets: [b, b, b, b], radius: s * (kind === 'phone' ? 0.135 : 0.08) };
    }
    case 'tablet': {
      const b = s * 0.04;
      return { insets: [b, b, b, b], radius: s * 0.03 };
    }
    case 'watch': {
      const b = s * 0.07;
      return { insets: [b, b * 1.5, b * 1.6, b * 1.5], radius: s * 0.24 };
    }
    case 'laptop': {
      // Lid with a screen bezel and a base wider than the lid.
      const side = vw * 0.022;
      return { insets: [side + vw * 0.06, vw * 0.03, side + vw * 0.06, vw * 0.03 + vw * 0.028], radius: vw * 0.004 };
    }
    case 'desktop': {
      // Bezel, the monitor's bottom strip and the stand.
      const b = vw * 0.012;
      return { insets: [b, b, b, b + vw * 0.045 + vw * 0.13], radius: 0 };
    }
  }
}

/** Rounded rectangle. */
function rrect(ck: CanvasKit, x: number, y: number, w: number, h: number, r: number) {
  return ck.RRectXY(ck.XYWHRect(x, y, w, h), r, r);
}

/** Body under the screen (drawn before the screen); the screen is the rectangle 0…vw × 0…vh. */
export function drawFrameBody(ck: CanvasKit, canvas: Canvas, kind: DeviceKind, vw: number, vh: number) {
  const g = frameGeometry(kind, vw, vh);
  const [l, t, r, b] = g.insets;
  const s = Math.min(vw, vh);
  const fill = new ck.Paint();
  fill.setAntiAlias(true);
  const rim = new ck.Paint();
  rim.setAntiAlias(true);
  rim.setStyle(ck.PaintStyle.Stroke);
  rim.setStrokeWidth(Math.max(1, s * 0.004));
  rim.setColor(ck.Color(70, 70, 76, 1));
  const shadow = new ck.Paint();
  shadow.setAntiAlias(true);
  shadow.setColor(ck.Color(0, 0, 0, 0.35));
  shadow.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, s * 0.02, true));
  const button = (x: number, y: number, w: number, h: number) => canvas.drawRRect(rrect(ck, x, y, w, h, Math.min(w, h) / 2), fill);
  const portrait = vh >= vw;
  switch (kind) {
    case 'phone':
    case 'android':
    case 'tablet':
    case 'watch': {
      const body = rrect(ck, -l, -t, vw + l + r, vh + t + b, g.radius + Math.max(l, t));
      canvas.drawRRect(body, shadow);
      fill.setColor(ck.Color(28, 28, 30, 1));
      // Side buttons (on a phone in portrait), the crown on a watch.
      if (kind === 'phone' || kind === 'android') {
        const bw = s * 0.012;
        if (portrait) {
          button(-l - bw * 0.6, vh * 0.17, bw, vh * 0.06);
          button(-l - bw * 0.6, vh * 0.25, bw, vh * 0.06);
          button(vw + r - bw * 0.4, vh * 0.22, bw, vh * 0.09);
        } else {
          button(vw * 0.17, -t - bw * 0.6, vw * 0.06, bw);
          button(vw * 0.25, -t - bw * 0.6, vw * 0.06, bw);
          button(vw * 0.22, vh + b - bw * 0.4, vw * 0.09, bw);
        }
      }
      if (kind === 'watch') button(vw + r - s * 0.03, vh * 0.3, s * 0.07, vh * 0.18);
      canvas.drawRRect(body, fill);
      canvas.drawRRect(body, rim);
      // The tablet camera sits in the bezel.
      if (kind === 'tablet') {
        fill.setColor(ck.Color(55, 55, 60, 1));
        if (portrait) canvas.drawCircle(vw / 2, -t / 2, Math.max(1.5, s * 0.006), fill);
        else canvas.drawCircle(-l / 2, vh / 2, Math.max(1.5, s * 0.006), fill);
      }
      break;
    }
    case 'laptop': {
      const side = vw * 0.022;
      const lidL = -side;
      const lidW = vw + side * 2;
      const lidH = vh + t + vw * 0.03;
      canvas.drawRRect(rrect(ck, lidL, -t, lidW, lidH, vw * 0.012), shadow);
      fill.setColor(ck.Color(18, 18, 20, 1));
      canvas.drawRRect(rrect(ck, lidL, -t, lidW, lidH, vw * 0.012), fill);
      canvas.drawRRect(rrect(ck, lidL, -t, lidW, lidH, vw * 0.012), rim);
      fill.setColor(ck.Color(55, 55, 60, 1));
      canvas.drawCircle(vw / 2, -t / 2, Math.max(1.5, vw * 0.0025), fill);
      // Base: wider than the lid, with a notch in the middle.
      const baseY = vh + vw * 0.03;
      const baseH = vw * 0.028;
      fill.setColor(ck.Color(196, 198, 204, 1));
      canvas.drawRRect(rrect(ck, -l, baseY, vw + l + r, baseH, baseH * 0.45), fill);
      fill.setColor(ck.Color(160, 162, 168, 1));
      canvas.drawRRect(rrect(ck, vw / 2 - vw * 0.08, baseY, vw * 0.16, baseH * 0.35, baseH * 0.2), fill);
      break;
    }
    case 'desktop': {
      const bz = vw * 0.012;
      const chin = vw * 0.045;
      const stand = vw * 0.13;
      fill.setColor(ck.Color(196, 198, 204, 1));
      // Stand: post and base.
      canvas.drawRect(ck.XYWHRect(vw / 2 - vw * 0.06, vh + bz + chin, vw * 0.12, stand * 0.85), fill);
      canvas.drawRRect(rrect(ck, vw / 2 - vw * 0.15, vh + bz + chin + stand * 0.82, vw * 0.3, stand * 0.18, stand * 0.05), fill);
      canvas.drawRRect(rrect(ck, -bz, -bz, vw + bz * 2, vh + bz * 2 + chin, vw * 0.008), shadow);
      canvas.drawRRect(rrect(ck, -bz, -bz, vw + bz * 2, vh + bz * 2 + chin, vw * 0.008), fill);
      fill.setColor(ck.Color(18, 18, 20, 1));
      canvas.drawRRect(rrect(ck, -bz, -bz, vw + bz * 2, vh + bz * 2, vw * 0.006), fill);
      break;
    }
  }
  fill.delete();
  rim.delete();
  shadow.delete();
}

/** Camera cutout over the screen (drawn after the content). */
export function drawFrameOverlay(ck: CanvasKit, canvas: Canvas, kind: DeviceKind, vw: number, vh: number) {
  if (kind !== 'phone' && kind !== 'android') return;
  const s = Math.min(vw, vh);
  const p: Paint = new ck.Paint();
  p.setAntiAlias(true);
  p.setColor(ck.BLACK);
  const portrait = vh >= vw;
  if (kind === 'phone') {
    // The camera “island”: at the top (portrait), on the left (landscape — rotated counterclockwise).
    const long = s * 0.32;
    const thick = s * 0.095;
    const gap = s * 0.028;
    if (portrait) canvas.drawRRect(rrect(ck, (vw - long) / 2, gap, long, thick, thick / 2), p);
    else canvas.drawRRect(rrect(ck, gap, (vh - long) / 2, thick, long, thick / 2), p);
  } else {
    const r = s * 0.022;
    if (portrait) canvas.drawCircle(vw / 2, s * 0.045, r, p);
    else canvas.drawCircle(s * 0.045, vh / 2, r, p);
  }
  p.delete();
}
