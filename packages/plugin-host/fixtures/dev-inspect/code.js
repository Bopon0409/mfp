figma.showUI(__html__);
function report() {
  const n = figma.currentPage.selection[0] || figma.currentPage.children[0];
  let blocked = false;
  try { figma.createRectangle(); } catch (e) { blocked = String(e.message).includes('read-only'); }
  if (n) n.setPluginData('checked', 'yes');
  figma.ui.postMessage({
    mode: figma.editorType + '/' + figma.mode,
    name: n ? n.name : 'No layers',
    blocked,
    metadata: n ? n.getPluginData('checked') === 'yes' : null,
    count: figma.currentPage.children.length,
  });
}
figma.ui.onmessage = report;
figma.on('selectionchange', report);
