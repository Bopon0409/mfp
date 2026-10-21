// Export PNG: preview of the selected layer (exportAsync) at 1x, 2x or 3x; the window saves the file.
// MIT, MFP.

figma.showUI(__html__, { width: 320, height: 400, title: 'Export PNG' });

let scale = 2;
let seq = 0;

async function preview() {
  const my = ++seq;
  const node = figma.currentPage.selection[0];
  if (!node) return figma.ui.postMessage({ type: 'empty' });
  figma.ui.postMessage({ type: 'busy', name: node.name });
  try {
    const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
    if (my !== seq) return;
    figma.ui.postMessage({ type: 'image', name: node.name, scale, data: figma.base64Encode(bytes), size: bytes.length });
  } catch (e) {
    if (my === seq) figma.ui.postMessage({ type: 'error', message: e.message });
  }
}

figma.on('selectionchange', preview);
figma.ui.onmessage = (msg) => {
  if (msg.type === 'scale') {
    scale = msg.value;
    preview();
  }
};
preview();
