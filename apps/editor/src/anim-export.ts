// Frame animation export: Lottie (vector, keyframes), GIF and MP4 or WebM video (frames rendered the same way as
// the canvas: the pose at the frame's moment via document preview, a snapshot of the frame's bounds). Default size:
// GIF no more than 640 px per side (files are big anyway), video — twice that, up to 1920 px.

import { framePose, timelineDuration, timelinePlayback } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { ExportFile } from './export.ts';
import { encodeGif, type GifFrame } from './gif.ts';
import { exportLottie } from './lottie-export.ts';
import { canEncodeVideo, encodeWebm } from './webm.ts';
import { encodeMp4 } from './mp4.ts';
import { t } from './i18n/index.ts';

export type AnimFormat = 'lottie' | 'gif' | 'mp4' | 'webm';

export const ANIM_FORMATS: { format: AnimFormat; label: string }[] = [
  { format: 'lottie', label: 'Lottie (JSON)' },
  { format: 'gif', label: 'GIF' },
  { format: 'mp4', label: 'Видео MP4' },
  { format: 'webm', label: 'Видео WebM' },
];

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || t('Анимация');

/** Animation file of the root frame; progress — fraction of finished frames (0…1). */
export async function exportAnimation(ed: Editor, root: string, format: AnimFormat, progress?: (part: number) => void): Promise<{ file: ExportFile; warnings: string[] }> {
  const doc = ed.doc;
  const name = safe(doc.get(root, 'name') ?? t('Анимация'));
  if (format === 'lottie') {
    const r = await exportLottie(ed, root);
    // Per-range text animation cannot be expressed as vectors in Lottie — it exists only in GIF and video.
    const textAnim = [...ed.doc.descendants(root)].some((id) => ed.doc.get(id, 'textAnimation'));
    // 3D rotation cannot be expressed in Lottie (2D layers) either.
    const in3d = [root, ...ed.doc.descendants(root)].some((id) => {
      const p = ed.doc.props(id);
      return !!(p.rotateX || p.rotateY || p.translateZ) || (p.animation ?? []).some((t) => t.property === 'rotateX' || t.property === 'rotateY');
    });
    const warnings = [...r.warnings];
    if (timelinePlayback(doc.get(root, 'timeline')) === 'PING_PONG') warnings.push('«Туда-обратно» в Lottie не входит — файл играет вперёд по кругу (в GIF, MP4 и WebM — весь цикл туда и обратно)');
    if (textAnim) warnings.push('Анимация текста в Lottie не входит — она есть в GIF, MP4 и WebM');
    if (in3d) warnings.push('3D-поворот в Lottie не входит (слои там плоские) — он есть в GIF, MP4 и WebM');
    return {
      file: { name: `${name}.json`, bytes: new TextEncoder().encode(r.json), mime: 'application/json' },
      warnings,
    };
  }
  const box = ed.selectionBounds([root]);
  if (!box) throw new Error('Фрейм не на открытой странице');
  const duration = timelineDuration(doc, root);
  const playback = timelinePlayback(doc.get(root, 'timeline'));
  const loop = playback !== 'ONCE';
  // File loop: ping-pong is twice as long (forward and backward).
  const cycle = playback === 'PING_PONG' ? 2 * duration : duration;
  const side = Math.max(box[2] - box[0], box[3] - box[1], 1);
  if (format === 'gif') {
    const fps = 25;
    const scale = Math.min(1, 640 / side);
    // Looping — without the last frame (it equals the first); once — up to the end inclusive.
    const n = Math.max(1, Math.round(cycle * fps)) + (loop ? 0 : 1);
    const frames: GifFrame[] = [];
    let size = { width: 1, height: 1 };
    for (let i = 0; i < n; i++) {
      const f = await frameAt(ed, root, Math.min(cycle, i / fps), scale, box, i === 0);
      size = f;
      frames.push({ rgba: f.rgba, delay: 100 / fps });
      progress?.((i + 1) / n);
    }
    return { file: { name: `${name}.gif`, bytes: encodeGif(frames, size.width, size.height, loop), mime: 'image/gif' }, warnings: [] };
  }
  if (!canEncodeVideo()) throw new Error('Сжатие видео недоступно в этом браузере');
  const fps = 30;
  const scale = Math.min(2, 1920 / side);
  const n = Math.max(1, Math.round(cycle * fps)) + (loop ? 0 : 1);
  const first = await frameAt(ed, root, 0, scale, box, true);
  const bytes = await (format === 'mp4' ? encodeMp4 : encodeWebm)(
    n,
    first.width,
    first.height,
    fps,
    async (i) => onWhite(i === 0 ? first.rgba : (await frameAt(ed, root, Math.min(cycle, i / fps), scale, box, false)).rgba),
    (i) => progress?.((i + 1) / n),
  );
  return { file: { name: `${name}.${format}`, bytes, mime: format === 'mp4' ? 'video/mp4' : 'video/webm' }, warnings: [] };
}

/** Snapshot of the frame bounds at moment t (pose via preview, rolled back immediately). */
async function frameAt(ed: Editor, root: string, t: number, scale: number, region: [number, number, number, number], warm: boolean) {
  const doc = ed.doc;
  const pose = framePose(doc, root, t);
  const revert = pose.size
    ? doc.preview(() => {
        for (const [id, p] of pose) doc.set(id, p);
      })
    : null;
  try {
    const r = await ed.exportImage([root], scale, 'RGBA', { region, warm, lottieTime: t });
    return { rgba: r.bytes, width: r.width, height: r.height };
  } finally {
    revert?.();
  }
}

/** Video without transparency: on white. */
function onWhite(rgba: Uint8Array): Uint8Array {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a === 255) continue;
    const k = a / 255;
    rgba[i] = Math.round(rgba[i]! * k + 255 * (1 - k));
    rgba[i + 1] = Math.round(rgba[i + 1]! * k + 255 * (1 - k));
    rgba[i + 2] = Math.round(rgba[i + 2]! * k + 255 * (1 - k));
    rgba[i + 3] = 255;
  }
  return rgba;
}
