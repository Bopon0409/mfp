// Font list with previews: search by name, each family rendered in its own
// font. Catalog fonts load when their row becomes visible; local fonts (from the computer) the browser
// renders by family name. Arrows, Enter to choose, Esc to close.

import type { FontLibrary } from '@mfp/renderer';

let open: { close(): void } | null = null;

export function openFontPicker(anchor: HTMLElement, opts: { families: string[]; current: string | null; fonts: FontLibrary; onPick(family: string): void }) {
  open?.close();
  const box = document.createElement('div');
  box.className = 'font-picker';
  const search = Object.assign(document.createElement('input'), { placeholder: 'Поиск шрифта', value: '' });
  const list = document.createElement('div');
  list.className = 'fp-list';
  box.append(search, list);
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 268))}px`;
  box.style.top = `${Math.min(r.bottom + 4, innerHeight - 320)}px`;
  let active = 0;
  let items: HTMLElement[] = [];
  // Load the visible catalog font rows (once loaded, the browser repaints them itself).
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const family = (e.target as HTMLElement).dataset.family!;
      void opts.fonts.ensure({ family, style: 'Regular' });
      seen.unobserve(e.target);
    }
  });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const found = opts.families.filter((f) => f.toLowerCase().includes(q));
    if (q && !found.some((f) => f.toLowerCase() === q)) found.push(search.value.trim());
    list.replaceChildren();
    items = found.map((family, i) => {
      const row = document.createElement('div');
      row.className = `fp-item${family === opts.current ? ' current' : ''}`;
      row.dataset.family = family;
      row.textContent = family;
      // Font subsets are registered under aliases; Latin under its own name.
      row.style.fontFamily = `${JSON.stringify(family)}, ${JSON.stringify(`${family} [cyrillic]`)}, sans-serif`;
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pick(family);
      });
      row.addEventListener('pointerenter', () => setActive(i));
      list.append(row);
      seen.observe(row);
      return row;
    });
    setActive(Math.max(0, found.indexOf(opts.current ?? '')));
  };
  const setActive = (i: number) => {
    items[active]?.classList.remove('active');
    active = Math.max(0, Math.min(items.length - 1, i));
    items[active]?.classList.add('active');
  };
  const pick = (family: string) => {
    close();
    opts.onPick(family);
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
      items[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const f = items[active]?.dataset.family;
      if (f) pick(f);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  const onDown = (e: PointerEvent) => {
    if (!box.contains(e.target as Node) && e.target !== anchor) close();
  };
  document.addEventListener('pointerdown', onDown, true);
  const close = () => {
    seen.disconnect();
    document.removeEventListener('pointerdown', onDown, true);
    box.remove();
    if (open === handle) open = null;
  };
  const handle = { close };
  open = handle;
  render();
  items[active]?.scrollIntoView({ block: 'center' });
  search.focus();
}
