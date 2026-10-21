// MCP server (stdio, JSON-RPC 2.0 line by line): agents — Claude among them — read and edit
// MFP documents (.mfp, and .fig via import). Edits follow the same rules as in the
// editor: text size, auto layout, group bounds, component copies; undo via the undo tool.
// Log goes to stderr (stdout is the protocol channel).
//
// Document tools (documentTools) and JSON-RPC parsing (mcpRpc) are shared: the server's network
// MCP (apps/server/src/public-api.ts) serves the same ones for files on the server.

import { createInterface } from 'node:readline';
import { userPages, type NodeType, type Props } from '@mfp/core';
import { instantiate } from '@mfp/editing';
import { Session } from './session.ts';
import { devTools } from './dev-tools.ts';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<Content[]>;
}

export const PROPS_HINT =
  'Имена и значения свойств — как в API плагинов Figma: name, visible, opacity, transform [a, b, x, c, d, y] ' +
  '(положение относительно родителя: x — третье число, y — шестое), width, height, fills / strokes ' +
  '([{ "type": "SOLID", "color": { "r": 0..1, "g": 0..1, "b": 0..1 }, "opacity": 0..1 }]), strokeWeight, strokeAlign, ' +
  'cornerRadius, effects, characters, fontSize, fontName { family, style }, textAlignHorizontal, lineHeight, letterSpacing, ' +
  'layoutMode (NONE | HORIZONTAL | VERTICAL), itemSpacing, paddingLeft/Right/Top/Bottom, primaryAxisAlignItems, ' +
  'counterAxisAlignItems, primaryAxisSizingMode / counterAxisSizingMode (FIXED | AUTO), layoutGrow, layoutAlign.';

export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

export const textContent = (v: unknown): Content[] => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }];

/** Tools of the open document: summary, tree, search, edit, render, undo; development. */
export function documentTools(need: () => Session): Tool[] {
  const text = textContent;
  const nodeArg = (s: Session, v: unknown) => {
    const id = String(v ?? '');
    if (!s.doc.has(id)) throw new Error(`Нет узла ${id}`);
    return id;
  };
  return [
    {
      name: 'info',
      description: 'Сводка: страницы (id, имя, число узлов), число картинок.',
      inputSchema: obj({}),
      run: async () => text(need().info()),
    },
    {
      name: 'get_tree',
      description: 'Дерево слоёв: id, тип, имя, x, y, w, h (у текста — начало текста). Без id — первая страница.',
      inputSchema: obj({ id: { type: 'string' }, depth: { type: 'number', description: 'Глубина (по умолчанию 2)' } }),
      run: async (a) => {
        const s = need();
        const id = a.id ? nodeArg(s, a.id) : userPages(s.doc)[0]!;
        return text(s.tree(id, Number(a.depth ?? 2)));
      },
    },
    {
      name: 'get_node',
      description: 'Все свойства узла (без объёмной геометрии). depth > 0 — с детьми.',
      inputSchema: obj({ id: { type: 'string' }, depth: { type: 'number' } }, ['id']),
      run: async (a) => {
        const s = need();
        return text(s.describe(nodeArg(s, a.id), Number(a.depth ?? 0)));
      },
    },
    {
      name: 'find_nodes',
      description: 'Поиск узлов по части имени, типу (FRAME, TEXT, INSTANCE, …) и тексту.',
      inputSchema: obj({
        name: { type: 'string' },
        type: { type: 'string' },
        text: { type: 'string' },
        within: { type: 'string', description: 'Искать внутри узла (id)' },
        limit: { type: 'number' },
      }),
      run: async (a) => text(need().find(a as Parameters<Session['find']>[0])),
    },
    {
      name: 'set_properties',
      description: `Изменить свойства узла (один шаг отмены). ${PROPS_HINT}`,
      inputSchema: obj({ id: { type: 'string' }, props: { type: 'object' } }, ['id', 'props']),
      run: async (a) => {
        const s = need();
        const id = nodeArg(s, a.id);
        await s.edit(() => s.doc.set(id, a.props as Props));
        return text(s.describe(id));
      },
    },
    {
      name: 'create_node',
      description: `Создать узел: type — FRAME, RECTANGLE, ELLIPSE, TEXT, VECTOR, LINE, POLYGON, STAR, GROUP, COMPONENT, PAGE; parent — id родителя (страницы или фрейма). ${PROPS_HINT}`,
      inputSchema: obj({ type: { type: 'string' }, parent: { type: 'string' }, props: { type: 'object' }, index: { type: 'number' } }, ['type', 'parent']),
      run: async (a) => {
        const s = need();
        const parent = a.parent === 'root' ? s.doc.root : nodeArg(s, a.parent);
        const id = await s.edit(() => s.doc.create(String(a.type) as NodeType, parent, (a.props ?? {}) as Props, a.index === undefined ? undefined : Number(a.index)));
        return text(s.describe(id));
      },
    },
    {
      name: 'create_instance',
      description: 'Создать инстанс компонента (COMPONENT) в parent на месте x, y.',
      inputSchema: obj({ componentId: { type: 'string' }, parent: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, ['componentId', 'parent']),
      run: async (a) => {
        const s = need();
        const comp = nodeArg(s, a.componentId);
        if (s.doc.type(comp) !== 'COMPONENT') throw new Error('componentId — не компонент');
        const id = await s.edit(() => instantiate(s.doc, comp, nodeArg(s, a.parent), [1, 0, Number(a.x ?? 0), 0, 1, Number(a.y ?? 0)]));
        return text(s.tree(id, 1));
      },
    },
    {
      name: 'delete_node',
      description: 'Удалить узел (с детьми).',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
      run: async (a) => {
        const s = need();
        const id = nodeArg(s, a.id);
        await s.edit(() => s.doc.delete(id));
        return text('Удалён');
      },
    },
    {
      name: 'move_node',
      description: 'Перенести узел в другого родителя (или на другое место среди соседей).',
      inputSchema: obj({ id: { type: 'string' }, parent: { type: 'string' }, index: { type: 'number' } }, ['id', 'parent']),
      run: async (a) => {
        const s = need();
        const id = nodeArg(s, a.id);
        const parent = nodeArg(s, a.parent);
        await s.edit(() => s.doc.move(id, parent, a.index === undefined ? undefined : Number(a.index)));
        return text(s.tree(id, 0));
      },
    },
    {
      name: 'render_png',
      description: 'Нарисовать узел (или страницу) в PNG — посмотреть результат. scale — масштаб (по умолчанию 1).',
      inputSchema: obj({ id: { type: 'string', description: 'Узел или страница; без id — первая страница' }, scale: { type: 'number' } }),
      run: async (a) => {
        const s = need();
        const id = a.id ? nodeArg(s, a.id) : userPages(s.doc)[0]!;
        const r = await s.render(id, Number(a.scale ?? 1));
        return [
          { type: 'image', data: Buffer.from(r.png).toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: `${r.width}×${r.height}` },
        ];
      },
    },
    {
      name: 'undo',
      description: 'Отменить последнюю правку.',
      inputSchema: obj({}),
      run: async () => {
        const s = need();
        if (s.readOnly) throw new Error(s.readOnly);
        return text(s.doc.undo() ? 'Отменено' : 'Нечего отменять');
      },
    },
    {
      name: 'redo',
      description: 'Повторить отменённую правку.',
      inputSchema: obj({}),
      run: async () => {
        const s = need();
        if (s.readOnly) throw new Error(s.readOnly);
        return text(s.doc.redo() ? 'Повторено' : 'Нечего повторять');
      },
    },
    // Development: code, design context, variables, components, statuses, annotations, tree from a description.
    ...devTools(need, text, nodeArg),
  ];
}

type RpcMessage = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };

/** JSON-RPC MCP: initialize, ping, tools/list, tools/call. Notification (no id) — null. */
export function mcpRpc(tools: () => Tool[], info: { instructions: string; name?: string }) {
  const text = textContent;
  return async (msg: RpcMessage): Promise<unknown | null> => {
    const { id, method, params } = msg;
    if (id === undefined || !method) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: info.name ?? 'mfp', version: '0.1.0' },
            instructions: info.instructions,
          });
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const tool = tools().find((t) => t.name === params?.name);
          if (!tool) return err(-32602, `Нет инструмента ${String(params?.name)}`);
          try {
            return ok({ content: await tool.run((params?.arguments as Record<string, unknown>) ?? {}) });
          } catch (e) {
            return ok({ content: text(`Ошибка: ${(e as Error).message}`), isError: true });
          }
        }
        default:
          return err(-32601, `Нет метода ${method}`);
      }
    } catch (e) {
      return err(-32603, (e as Error).message);
    }
  };
}

export async function serveMcp(initialPath?: string) {
  let session: Session | null = initialPath ? await Session.open(initialPath) : null;
  const need = () => {
    if (!session) throw new Error('Документ не открыт: сначала open_file или new_file');
    return session;
  };
  const text = textContent;

  const tools: Tool[] = [
    {
      name: 'open_file',
      description: 'Открыть документ .mfp или импортировать .fig (Figma). Возвращает страницы.',
      inputSchema: obj({ path: { type: 'string', description: 'Путь к файлу' } }, ['path']),
      run: async (a) => {
        session = await Session.open(String(a.path));
        return text(session.info());
      },
    },
    {
      name: 'new_file',
      description: 'Создать пустой документ (сохраняется в path через save).',
      inputSchema: obj({ path: { type: 'string', description: 'Куда сохранять (.mfp)' } }, ['path']),
      run: async (a) => {
        session = Session.create(String(a.path));
        return text(session.info());
      },
    },
    ...documentTools(need),
    {
      name: 'save',
      description: 'Сохранить документ в .mfp (с картинками). Без path — рядом с открытым файлом.',
      inputSchema: obj({ path: { type: 'string' } }),
      run: async (a) => text(await need().save(a.path ? String(a.path) : undefined)),
    },
  ];

  const rpc = mcpRpc(() => tools, {
    instructions:
      'MFP — редактор дизайна (открывает и файлы .fig). Откройте документ (open_file), посмотрите дерево (get_tree) и картинку (render_png), ' +
      'правьте узлы (set_properties, create_node, create_tree). Для вёрстки — get_design_context (оформление, код, переменные, ' +
      'компоненты с их кодом, аннотации) и get_code. Каждая правка — шаг отмены (undo). Сохранение — save.',
  });
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  let queue = Promise.resolve();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Parameters<typeof rpc>[0];
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // One at a time: document edits must not interleave.
    queue = queue.then(async () => {
      const r = await rpc(msg);
      if (r) send(r);
    });
  });
  console.error(`MFP MCP: готов${session ? ` (${session.path})` : ''}`);
}
