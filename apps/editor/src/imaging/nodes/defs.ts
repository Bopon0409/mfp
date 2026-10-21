// Built-in nodes. Heavy work goes through ctx.services, so the definitions do not pull in the GPU or the network.

import { UPSCALE_MODELS } from '../engine.ts';
import { ASPECT_RATIOS, IMAGE_SIZES } from '../gemini.ts';
import { MAGNIFIC_SCALES } from '../magnific.ts';
import type { NodeDef, Value } from './runner.ts';
import { t } from '../../i18n/index.ts';

const image = async (blob: Blob, ctx: { services: { sizeOf(b: Blob): Promise<{ width: number; height: number }> } }): Promise<Value> => ({ type: 'image', blob, ...(await ctx.services.sizeOf(blob)) });
const text = (t: string): Value => ({ type: 'text', text: t });
const needImage = (v: Value | undefined) => {
  if (v?.type !== 'image') throw new Error('Нет картинки на входе');
  return v;
};

export const BUILTINS: NodeDef[] = [
  {
    type: 'prompts',
    title: 'Запросы',
    category: 'input',
    description: 'Источник пакета: по одному запросу на строку, «имя | запрос» задаёт имя',
    inputs: [],
    outputs: [
      { id: 'prompt', name: 'Запрос', type: 'text' },
      { id: 'name', name: 'Имя', type: 'text' },
    ],
    params: [{ id: 'lines', name: 'Запросы', kind: 'textarea', default: '', rows: 6, hint: 'По одному на строку:\nмеч | steel sword with runes\nзелье здоровья' }],
    source: 'prompts',
    run: async (ctx) => ({ prompt: text(ctx.item.prompt ?? ''), name: text(ctx.item.name) }),
  },
  {
    type: 'images',
    title: 'Картинки',
    category: 'input',
    description: 'Источник пакета: файлы, выделенные слои или картинки из проектов',
    inputs: [],
    outputs: [
      { id: 'image', name: 'Картинка', type: 'image' },
      { id: 'name', name: 'Имя', type: 'text' },
    ],
    params: [],
    source: 'images',
    run: async (ctx) => {
      if (!ctx.item.image) throw new Error('Нет картинки');
      return { image: await image(ctx.item.image, ctx), name: text(ctx.item.name) };
    },
  },
  {
    type: 'text',
    title: 'Текст',
    category: 'text',
    description: 'Постоянный текст',
    inputs: [],
    outputs: [{ id: 'text', name: 'Текст', type: 'text' }],
    params: [{ id: 'value', name: 'Текст', kind: 'textarea', default: '' }],
    run: async (_ctx, _in, p) => ({ text: text(String(p.value ?? '')) }),
  },
  {
    type: 'template',
    title: 'Шаблон',
    category: 'text',
    description: 'Подставить текст в шаблон: {text}',
    inputs: [{ id: 'text', name: 'Текст', type: 'text', optional: true }],
    outputs: [{ id: 'text', name: 'Текст', type: 'text' }],
    params: [{ id: 'template', name: 'Шаблон', kind: 'textarea', default: '{text}, game UI icon, centered, plain background' }],
    run: async (_ctx, input, p) => ({ text: text(String(p.template ?? '').replaceAll('{text}', input.text?.type === 'text' ? input.text.text : '')) }),
  },
  {
    type: 'generate',
    title: 'Создать',
    category: 'generate',
    description: 'Картинка по запросу: Nano Banana или SD-Turbo на видеокарте',
    inputs: [
      { id: 'prompt', name: 'Запрос', type: 'text' },
      { id: 'reference', name: 'Образец', type: 'image', optional: true },
    ],
    outputs: [{ id: 'image', name: 'Картинка', type: 'image' }],
    params: [
      { id: 'engine', name: 'Где', kind: 'select', default: 'auto', options: [['auto', 'Авто'], ['local', 'Видеокарта'], ['nano', 'Nano Banana']], hint: 'Авто — Nano Banana при ключе, иначе видеокарта' },
      { id: 'template', name: 'Шаблон', kind: 'textarea', default: '{prompt}', rows: 3, hint: '{prompt} — текст со входа' },
      { id: 'steps', name: 'Шаги', kind: 'select', default: 2, options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], when: (p) => p.engine !== 'nano' },
      { id: 'aspectRatio', name: 'Формат', kind: 'select', default: '1:1', options: ASPECT_RATIOS.map((r) => [r, r]), when: (p) => p.engine !== 'local' },
      { id: 'imageSize', name: 'Размер', kind: 'select', default: '1K', options: IMAGE_SIZES.map((r) => [r, r]), when: (p) => p.engine !== 'local' },
    ],
    run: async (ctx, input, p) => {
      const raw = input.prompt?.type === 'text' ? input.prompt.text : '';
      const template = String(p.template ?? '{prompt}');
      const prompt = template.includes('{prompt}') ? template.replaceAll('{prompt}', raw) : `${raw} ${template}`.trim();
      const blob = await ctx.services.generate(
        {
          engine: p.engine as 'auto' | 'local' | 'nano',
          prompt,
          reference: input.reference?.type === 'image' ? input.reference.blob : undefined,
          steps: Number(p.steps) || 2,
          aspectRatio: String(p.aspectRatio),
          imageSize: String(p.imageSize),
        },
        ctx,
      );
      return { image: await image(blob, ctx) };
    },
  },
  {
    type: 'upscale',
    title: 'Увеличить',
    category: 'process',
    description: 'Real-ESRGAN на видеокарте или Magnific',
    inputs: [{ id: 'image', name: 'Картинка', type: 'image' }],
    outputs: [{ id: 'image', name: 'Картинка', type: 'image' }],
    params: [
      { id: 'engine', name: 'Где', kind: 'select', default: 'auto', options: [['auto', 'Авто'], ['local', 'Видеокарта'], ['magnific', 'Magnific']], hint: 'Авто — Magnific при ключе, иначе видеокарта' },
      { id: 'model', name: 'Модель', kind: 'select', default: UPSCALE_MODELS[0]!.id, options: UPSCALE_MODELS.map((m) => [m.id, m.name]), when: (p) => p.engine !== 'magnific' },
      { id: 'mode', name: 'Magnific', kind: 'select', default: 'creative', options: [['creative', 'Creative'], ['precision', 'Precision V2']], when: (p) => p.engine !== 'local' },
      { id: 'scale', name: 'Масштаб', kind: 'select', default: 2, options: [...new Set([2, 3, 4, ...MAGNIFIC_SCALES])].map((x) => [String(x), `×${x}`]) },
    ],
    run: async (ctx, input, p) => {
      const src = needImage(input.image);
      const blob = await ctx.services.upscale(src.blob, { engine: p.engine as 'auto' | 'local' | 'magnific', model: String(p.model), scale: Number(p.scale) || 2, mode: p.mode as 'creative' | 'precision' }, ctx);
      return { image: await image(blob, ctx) };
    },
  },
  {
    type: 'remove-bg',
    title: 'Убрать фон',
    category: 'process',
    description: 'BiRefNet на видеокарте',
    inputs: [{ id: 'image', name: 'Картинка', type: 'image' }],
    outputs: [{ id: 'image', name: 'Картинка', type: 'image' }],
    params: [{ id: 'trim', name: 'Обрезать по объекту', kind: 'check', default: true }],
    run: async (ctx, input, p) => ({ image: await image(await ctx.services.removeBackground(needImage(input.image).blob, !!p.trim, ctx), ctx) }),
  },
  {
    type: 'fit',
    title: 'Вписать в размер',
    category: 'process',
    description: 'Картинка нужного размера с прозрачными полями',
    inputs: [{ id: 'image', name: 'Картинка', type: 'image' }],
    outputs: [{ id: 'image', name: 'Картинка', type: 'image' }],
    params: [
      { id: 'width', name: 'Ширина', kind: 'number', default: 200, min: 1, max: 8192 },
      { id: 'height', name: 'Высота', kind: 'number', default: 200, min: 1, max: 8192 },
      { id: 'padding', name: 'Поля, %', kind: 'number', default: 6, min: 0, max: 30 },
    ],
    run: async (ctx, input, p) => {
      const w = Math.max(1, Math.min(8192, Math.round(Number(p.width) || 200)));
      const h = Math.max(1, Math.min(8192, Math.round(Number(p.height) || 200)));
      const blob = await ctx.services.fit(needImage(input.image).blob, w, h, Math.max(0, Math.min(30, Number(p.padding) || 0)) / 100);
      return { image: { type: 'image', blob, width: w, height: h } };
    },
  },
  {
    type: 'page',
    title: 'На страницу',
    category: 'output',
    description: 'Фрейм с картинкой и экспортом PNG на странице текущего файла',
    inputs: [
      { id: 'image', name: 'Картинка', type: 'image' },
      { id: 'name', name: 'Имя', type: 'text', optional: true },
    ],
    outputs: [],
    params: [
      { id: 'page', name: 'Страница', kind: 'text', default: t('Иконки') },
      { id: 'suffix', name: 'К имени', kind: 'text', default: '', hint: 'например /200' },
    ],
    output: true,
    run: async (ctx, input, p) => {
      const src = needImage(input.image);
      const base = input.name?.type === 'text' && input.name.text ? input.name.text : ctx.item.name;
      ctx.emit({ page: String(p.page || t('Иконки')), name: `${base}${String(p.suffix ?? '')}`, blob: src.blob, width: src.width, height: src.height });
      return {};
    },
  },
  {
    type: 'replace',
    title: 'Заменить в документе',
    category: 'output',
    description: 'Новая картинка — в тот же слой, откуда взята (выделение или «Из проекта»); в открытом файле — с Ctrl+Z',
    inputs: [{ id: 'image', name: 'Картинка', type: 'image' }],
    outputs: [],
    params: [
      {
        id: 'layer',
        name: 'Размер слоя',
        kind: 'select',
        default: 'keep',
        options: [
          ['keep', 'Как был'],
          ['image', 'По картинке'],
        ],
        hint: 'По картинке — слой примет её размер: иконка «меч/200» после «Вписать 256» станет «меч/256» 256×256',
      },
    ],
    output: true,
    run: async (ctx, input, p) => {
      const src = needImage(input.image);
      if (!ctx.item.origin) throw new Error('«Заменить в документе» меняет картинки, взятые из документа: в «Картинках» — «Из выделения» или «Из проекта»');
      if (!ctx.replace) throw new Error('Замена в документе здесь недоступна');
      ctx.replace({ origin: ctx.item.origin, blob: src.blob, width: src.width, height: src.height, resize: p.layer === 'image' });
      return {};
    },
  },
];

export const BUILTIN_MAP = new Map(BUILTINS.map((d) => [d.type, d]));

export const CATEGORY_NAMES: Record<NodeDef['category'], string> = {
  input: 'Вход',
  text: 'Текст',
  generate: 'Создание',
  process: 'Обработка',
  output: 'Вывод',
  custom: 'Мои ноды',
};
