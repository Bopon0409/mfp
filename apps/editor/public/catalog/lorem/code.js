// Placeholder text: fill the selected texts (or a new text in the center of the screen) with placeholder paragraphs.
// Parameters — language and number of paragraphs (quick action); from the menu — one paragraph in Russian.
// MIT, MFP.

const TEXT = {
  ru: 'Съешь же ещё этих мягких французских булок, да выпей чаю. Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства. Эх, чужак, общий съём цен шляп (юфть) — вдрызг!',
  en: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
};
const LANGS = [
  { name: 'Russian', data: 'ru' },
  { name: 'English', data: 'en' },
];

figma.parameters.on('input', ({ key, query, result }) => {
  const q = query.toLowerCase();
  if (key === 'lang') result.setSuggestions(LANGS.filter((l) => l.name.toLowerCase().startsWith(q)));
  else if (query && !/^\d+$/.test(query)) result.setError('A number is needed');
  else result.setSuggestions(['1', '2', '3', '5'].filter((n) => n.startsWith(query)));
});

figma.on('run', async ({ parameters }) => {
  const lang = (parameters && parameters.lang) || 'ru';
  const count = Math.max(1, Math.min(20, Number((parameters && parameters.paragraphs) || 1)));
  const text = Array.from({ length: count }, () => TEXT[lang] || TEXT.ru).join('\n\n');
  let nodes = figma.currentPage.selection.filter((n) => n.type === 'TEXT');
  if (!nodes.length) {
    const t = figma.createText();
    await figma.loadFontAsync(t.fontName);
    t.textAutoResize = 'HEIGHT';
    t.resize(360, 100);
    const c = figma.viewport.center;
    t.x = Math.round(c.x - 180);
    t.y = Math.round(c.y - 50);
    nodes = [t];
  }
  for (const n of nodes) {
    const fonts = n.characters.length ? n.getRangeAllFontNames(0, n.characters.length) : [n.fontName];
    for (const f of fonts) await figma.loadFontAsync(f);
    n.characters = text;
  }
  figma.currentPage.selection = nodes;
  figma.closePlugin();
});
