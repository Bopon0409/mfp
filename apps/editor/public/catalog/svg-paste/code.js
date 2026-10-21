// SVG from code: paste SVG as layers (figma.createNodeFromSvg) in the center of the screen.
// MIT, MFP.

figma.showUI(__html__, { width: 360, height: 300, title: 'SVG from code' });

figma.ui.onmessage = (msg) => {
  if (msg.type === 'close') return figma.closePlugin();
  if (msg.type !== 'insert') return;
  try {
    const frame = figma.createNodeFromSvg(msg.svg);
    const c = figma.viewport.center;
    frame.x = Math.round(c.x - frame.width / 2);
    frame.y = Math.round(c.y - frame.height / 2);
    if (msg.name) frame.name = msg.name;
    figma.currentPage.selection = [frame];
    figma.notify(`Layers pasted: ${frame.findAll().length}`);
  } catch (e) {
    figma.notify(`Could not parse the SVG: ${e.message}`, { error: true });
  }
};
