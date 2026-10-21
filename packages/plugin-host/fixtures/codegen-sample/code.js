// Sample codegen plugin for MFP developer mode (API):
// on a “code for layer” request it responds with blocks { title, code, language }.

const describe = (node, depth) => {
  const out = { name: node.name, type: node.type, width: Math.round(node.width), height: Math.round(node.height) };
  if (node.type === 'TEXT') out.text = node.characters;
  if (depth < 2 && node.children && node.children.length) out.children = node.children.map((c) => describe(c, depth + 1));
  return out;
};

const componentName = (name) =>
  name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('') || 'Layer';

figma.codegen.on('generate', ({ node, language }) => {
  if (language === 'json') return [{ title: 'Layer and children', code: JSON.stringify(describe(node, 0), null, 2), language: 'JSON' }];
  const texts = node.findAll ? node.findAll((n) => n.type === 'TEXT').map((t) => t.characters) : node.type === 'TEXT' ? [node.characters] : [];
  const body = texts.map((t) => `      <p>${t}</p>`).join('\n');
  const code = `export function ${componentName(node.name)}() {\n  return (\n    <div style={{ width: ${Math.round(node.width)}, height: ${Math.round(node.height)} }}>\n${body}\n    </div>\n  );\n}`;
  return [{ title: 'Component', code, language: 'TYPESCRIPT' }];
});
