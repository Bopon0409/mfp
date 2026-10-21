// Fit an image into a W×H box with transparent margins (icons of the required sizes).
// Downscaling goes in 2× steps: one big canvas step produces jaggies and garbage.

export async function fitInto(source: Blob, width: number, height: number, padding: number): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const boxW = Math.max(1, width * (1 - 2 * padding));
  const boxH = Math.max(1, height * (1 - 2 * padding));
  const k = Math.min(boxW / bitmap.width, boxH / bitmap.height);
  const tw = Math.max(1, Math.round(bitmap.width * k));
  const th = Math.max(1, Math.round(bitmap.height * k));

  let current: CanvasImageSource = bitmap;
  let cw = bitmap.width;
  let ch = bitmap.height;
  while (cw / 2 >= tw && ch / 2 >= th) {
    const nw = Math.round(cw / 2);
    const nh = Math.round(ch / 2);
    const step = new OffscreenCanvas(nw, nh);
    const ctx = step.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, nw, nh);
    current = step;
    cw = nw;
    ch = nh;
  }
  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, Math.round((width - tw) / 2), Math.round((height - th) / 2), tw, th);
  bitmap.close();
  return out.convertToBlob({ type: 'image/png' });
}
