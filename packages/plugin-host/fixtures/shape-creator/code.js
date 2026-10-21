// Sample plugin in Figma format: creates a row of shapes on a command from the UI.
figma.showUI(__html__, { width: 260, height: 170, title: 'Shape Creator' });

figma.ui.onmessage = (msg) => {
  if (msg.type === 'create-shapes') {
    const nodes = [];
    for (let i = 0; i < msg.count; i++) {
      const shape = msg.shape === 'ellipse' ? figma.createEllipse() : figma.createRectangle();
      shape.x = i * 150;
      shape.y = 0;
      shape.resize(120, 120);
      shape.name = `${msg.shape === 'ellipse' ? 'Circle' : 'Square'} ${i + 1}`;
      shape.fills = [{ type: 'SOLID', color: { r: 1, g: 0.45 + i * 0.05, b: 0.1 } }];
      if (msg.shape !== 'ellipse') shape.cornerRadius = 16;
      figma.currentPage.appendChild(shape);
      nodes.push(shape);
    }
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    figma.notify(`Shapes created: ${nodes.length}`);
  }
  figma.closePlugin();
};
