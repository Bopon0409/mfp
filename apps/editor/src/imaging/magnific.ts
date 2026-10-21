// Magnific (Creative and Precision V2 upscalers). The Magnific/Freepik API is not directly reachable from the browser (CORS),
// so requests go through the MFP server (/api/imaging/…): it only forwards them and does not store the key.

export type MagnificHost = 'magnific' | 'freepik';
export type MagnificMode = 'creative' | 'precision';

export interface ServerLink {
  base: () => string;
  token: () => string | null;
}

export interface MagnificAuth {
  key: string;
  host: MagnificHost;
  server: ServerLink;
}

/** Magnific's result limit is 25.3 MP. */
export const MAGNIFIC_MAX_PIXELS = 25.3e6;
export const MAGNIFIC_SCALES = [2, 4, 8, 16];
export const OPTIMIZED_FOR: [string, string][] = [
  ['standard', 'Обычное'],
  ['art_n_illustration', 'Арт и иллюстрации'],
  ['videogame_assets', 'Игровые ассеты'],
  ['3d_renders', '3D-рендеры'],
  ['films_n_photography', 'Фото и кино'],
  ['soft_portraits', 'Портреты, мягко'],
  ['hard_portraits', 'Портреты, чётко'],
  ['nature_n_landscapes', 'Природа и пейзажи'],
  ['science_fiction_n_horror', 'Фантастика и хоррор'],
];

const PATHS: Record<MagnificMode, string> = { creative: 'v1/ai/image-upscaler', precision: 'v1/ai/image-upscaler-precision-v2' };
const POLL_MS = 3000;
const TIMEOUT_MS = 15 * 60_000;

function headers(a: MagnificAuth, json = false): Record<string, string> {
  if (!a.key) throw new Error('Нет ключа Magnific: откройте «Подключения»');
  const h: Record<string, string> = { [a.host === 'freepik' ? 'x-freepik-api-key' : 'x-magnific-api-key']: a.key };
  const token = a.server.token();
  if (token) h.authorization = `Bearer ${token}`;
  if (json) h['content-type'] = 'application/json';
  return h;
}

async function errorOf(res: Response): Promise<Error> {
  if (res.status === 401) return new Error('Magnific: ключ не подошёл (401)');
  if (res.status === 404) return new Error('Сервер MFP не пересылает запросы в Magnific — нужна свежая версия сервера');
  let text = '';
  try {
    text = await res.text();
    const body = JSON.parse(text) as { message?: string; error?: string | { message?: string } };
    text = body.message ?? (typeof body.error === 'string' ? body.error : body.error?.message) ?? text;
  } catch {
    // not JSON
  }
  return new Error(`Magnific: ошибка ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
}

const proxy = (a: MagnificAuth, path: string) => `${a.server.base()}/api/imaging/magnific/${path}`;

/** Key check: the upscaler task list (free). */
export async function checkMagnific(a: MagnificAuth): Promise<void> {
  const res = await fetch(proxy(a, PATHS.creative), { headers: headers(a) });
  if (!res.ok) throw await errorOf(res);
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Остановлено', 'AbortError'))), { once: true });
  });

export interface MagnificOptions extends MagnificAuth {
  mode: MagnificMode;
  scale: number;
  prompt?: string;
  optimizedFor?: string;
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
}

export async function magnificUpscale(image: Blob, o: MagnificOptions): Promise<Blob> {
  const base64 = await toBase64(image);
  const body =
    o.mode === 'creative'
      ? { image: base64, scale_factor: `${o.scale}x`, optimized_for: o.optimizedFor || 'standard', ...(o.prompt ? { prompt: o.prompt } : {}) }
      : { image: base64, scale_factor: o.scale };
  o.onStatus?.('Отправляю в Magnific…');
  const start = await fetch(proxy(o, PATHS[o.mode]), { method: 'POST', headers: headers(o, true), body: JSON.stringify(body), signal: o.signal });
  if (!start.ok) throw await errorOf(start);
  const task = ((await start.json()) as { data?: { task_id?: string } }).data?.task_id;
  if (!task) throw new Error('Magnific не вернул номер задачи');

  const started = Date.now();
  for (;;) {
    await sleep(POLL_MS, o.signal);
    const res = await fetch(proxy(o, `${PATHS[o.mode]}/${encodeURIComponent(task)}`), { headers: headers(o), signal: o.signal });
    if (!res.ok) throw await errorOf(res);
    const data = ((await res.json()) as { data?: { status?: string; generated?: string[] } }).data;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (data?.status === 'COMPLETED' && data.generated?.[0]) {
      o.onStatus?.('Скачиваю результат…');
      return download(data.generated[0], o);
    }
    if (data?.status === 'FAILED') throw new Error('Magnific: задача не выполнилась');
    if (Date.now() - started > TIMEOUT_MS) throw new Error('Magnific не ответил за 15 минут');
    o.onStatus?.(`Magnific считает… ${seconds} с`);
  }
}

/** The result is on Magnific's CDN: try directly first; if CORS blocks it, go through the MFP server. */
async function download(url: string, a: MagnificOptions): Promise<Blob> {
  try {
    const direct = await fetch(url, { signal: a.signal });
    if (direct.ok) return await direct.blob();
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
  }
  const token = a.server.token();
  const res = await fetch(`${a.server.base()}/api/imaging/fetch?url=${encodeURIComponent(url)}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: a.signal });
  if (!res.ok) throw await errorOf(res);
  return res.blob();
}
