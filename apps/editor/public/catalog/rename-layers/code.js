// Rename layers: find and replace in names (quick action with parameters).
// MIT, MFP.

/** Layers: the selection with all its contents or the whole page. */
function scope() {
  const sel = figma.currentPage.selection;
  if (!sel.length) return figma.currentPage.findAll();
  const out = [];
  for (const n of sel) {
    out.push(n);
    if ('findAll' in n) out.push(...n.findAll());
  }
  return out;
}

figma.parameters.on('input', ({ key, query, result }) => {
  if (key === 'find') {
    const q = query.toLowerCase();
    const names = [...new Set(scope().map((n) => n.name))].filter((n) => n.toLowerCase().includes(q)).slice(0, 50);
    result.setSuggestions(names.length ? names : query ? [query] : []);
    return;
  }
  result.setSuggestions(query ? [query] : []);
});

figma.on('run', ({ parameters }) => {
  if (!parameters || !parameters.find) {
    figma.closePlugin('Run it from the actions menu (Ctrl+K) and enter what to find');
    return;
  }
  const find = String(parameters.find);
  const replace = String(parameters.replace ?? '');
  let count = 0;
  for (const node of scope()) {
    if (!node.name.includes(find)) continue;
    node.name = node.name.split(find).join(replace);
    count++;
  }
  figma.closePlugin(count ? `Layers renamed: ${count}` : `“${find}” not found`);
});
