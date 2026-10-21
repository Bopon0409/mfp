import { h } from './dom.ts';

/** Counts completed image checks/uploads, not invented byte percentages. */
export function fileUpload(name: string) {
  const message = h('div', { role: 'status', 'aria-live': 'polite' }, 'Читаем локальный файл…');
  const progress = h('progress', { 'aria-label': 'Обработка изображений' });
  const dialog = h('dialog', { class: 'file-upload', 'aria-label': `Загрузка «${name}» на сервер` },
    h('div', { class: 'file-opening-card' }, h('strong', {}, `Загружаем «${name}» на сервер`), message, progress,
      h('small', {}, 'Не закрывайте вкладку до завершения. Локальный файл останется на устройстве.')));
  dialog.addEventListener('cancel', e => e.preventDefault());
  document.body.append(dialog);
  dialog.showModal();
  return {
    async status(text: string) {
      message.textContent = text;
      progress.removeAttribute('value');
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 100);
        requestAnimationFrame(() => setTimeout(() => { clearTimeout(timeout); resolve(); }, 0));
      });
    },
    images(done: number, total: number) {
      message.textContent = total ? `Изображения: ${done} из ${total} обработано` : 'В файле нет изображений';
      progress.max = Math.max(1, total); progress.value = done;
    },
    close() { if (dialog.open) dialog.close(); dialog.remove(); },
  };
}
