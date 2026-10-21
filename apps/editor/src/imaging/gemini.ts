// Nano Banana: Gemini models with image output. Google accepts requests directly from the browser (CORS),
// so the user's key goes only to Google.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'];
export const IMAGE_SIZES = ['1K', '2K', '4K'];

async function apiError(res: Response): Promise<Error> {
  let message = `Google AI: ошибка ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) message = `Google AI: ${body.error.message}`;
  } catch {
    // body is not JSON
  }
  return new Error(message);
}

/** Models with image output (Nano Banana) available to this key. */
export async function listImageModels(key: string): Promise<string[]> {
  if (!key) throw new Error('Введите ключ Google AI');
  const res = await fetch(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw await apiError(res);
  const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
  return (body.models ?? [])
    .filter((m) => /image|banana/i.test(m.name) && !/imagen|embedding/i.test(m.name) && (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .sort((a, b) => b.localeCompare(a));
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface GenerateOptions {
  key: string;
  model: string;
  prompt: string;
  /** Samples: an image to edit or style references. */
  references?: Blob[];
  aspectRatio?: string;
  imageSize?: string;
  signal?: AbortSignal;
}

type Part = { text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } };

/** One image from text (and samples). If the model does not support size, retry without it. */
export async function generateImage(o: GenerateOptions): Promise<Blob> {
  if (!o.key) throw new Error('Нет ключа Google AI: откройте «Подключения»');
  if (!o.prompt.trim()) throw new Error('Пустой запрос');
  const parts: unknown[] = [];
  for (const ref of o.references ?? []) parts.push({ inline_data: { mime_type: ref.type || 'image/png', data: await toBase64(ref) } });
  parts.push({ text: o.prompt });

  const attempt = async (imageConfig: Record<string, string> | null) => {
    const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] };
    if (imageConfig) generationConfig.imageConfig = imageConfig;
    return fetch(`${BASE}/models/${encodeURIComponent(o.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': o.key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
      signal: o.signal,
    });
  };

  const config: Record<string, string> = {};
  if (o.aspectRatio) config.aspectRatio = o.aspectRatio;
  if (o.imageSize) config.imageSize = o.imageSize;
  let res = await attempt(Object.keys(config).length ? config : null);
  // Older models do not know imageSize (or the whole imageConfig); try something simpler rather than fail.
  if (res.status === 400 && o.imageSize) res = await attempt(o.aspectRatio ? { aspectRatio: o.aspectRatio } : null);
  if (res.status === 400 && o.aspectRatio) res = await attempt(null);
  if (!res.ok) throw await apiError(res);

  const body = (await res.json()) as {
    candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  const candidate = body.candidates?.[0];
  for (const part of candidate?.content?.parts ?? []) {
    if (part.thought) continue;
    const data = part.inlineData?.data ?? part.inline_data?.data;
    const mime = part.inlineData?.mimeType ?? part.inline_data?.mime_type ?? 'image/png';
    if (data) return new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mime });
  }
  const text = (candidate?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join(' ').trim();
  const reason = body.promptFeedback?.blockReason ?? candidate?.finishReason;
  throw new Error(`Google AI не вернул картинку${reason ? ` (${reason})` : ''}${text ? `: ${text.slice(0, 200)}` : ''}`);
}
