import { h } from './dom.ts';

/** Visible before network/WASM work starts; no invented percentages. */
export function fileOpening(name?: string) {
  const message = h('div', { role: 'status', 'aria-live': 'polite' }, 'Подготавливаем открытие…');
  const box = h('div', { class: 'file-opening' }, h('div', { class: 'file-opening-card' },
    h('strong', {}, name ? `Открываем «${name}»` : 'Открываем файл'), message,
    h('div', { class: 'file-opening-track', 'aria-hidden': 'true' }),
    h('small', {}, 'Изображения появятся по мере загрузки.')));
  document.body.append(box);
  const started = performance.now();
  return {
    status(text: string) { message.textContent = text; },
    painted: () => new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 100);
      requestAnimationFrame(() => setTimeout(() => { clearTimeout(timeout); resolve(); }, 0));
    }),
    close() { box.remove(); performance.measure('mfp:file-open', { start: started, end: performance.now() }); },
  };
}
