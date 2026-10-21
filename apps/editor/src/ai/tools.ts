// Assistant tools over the open document: tree and selection, layer properties, edits
// (properties, names, texts, deletion), creating a layer tree (including instances of the file's
// components), file components and variables, layer snapshot (the model sees the result).
// Position in edits can be given as x / y (and rotation) — converted into the transform matrix.

import { defaultMode, instantiate, localCollections, rotationOf, userPages, variablesIn, withRotation, type Matrix, type NodeType, type Props } from '@mfp/core';
import type { Editor } from '../editor.ts';
import type { ToolContent, ToolSpec } from './providers.ts';

export interface Tool extends ToolSpec {
  run(args: Record<string, unknown>): Promise<ToolContent[]>;
  /** Changes the document (the others only read). */
  edits?: boolean;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const text = (v: unknown): ToolContent[] => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Properties the assistant does not touch (geometry, internal). */
const HIDDEN = new Set(['vectorNetwork', 'vectorPaths', 'strokePaths', 'centerPaths', 'textGlyphs', 'geometrySize', 'internal', 'derivedSymbolData', 'componentPropertyReferences']);

const CREATABLE = new Set<NodeType>(['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'LINE', 'POLYGON', 'STAR', 'GROUP', 'COMPONENT', 'SECTION']);

export function editorTools(ed: Editor): Tool[] {
  const doc = () => ed.doc;
  const need = (id: unknown): string => {
    const s = String(id ?? '');
    if (!doc().has(s)) throw new Error(`Нет слоя ${s}`);
    return s;
  };
  /** x, y, rotation → transform (on top of the current matrix). */
  const placement = (id: string | null, props: Record<string, unknown>): Props => {
    const p = { ...props } as Record<string, unknown>;
    for (const k of Object.keys(p)) if (HIDDEN.has(k)) delete p[k];
    if ('x' in p || 'y' in p || 'rotation' in p) {
      let m = ((p.transform as Matrix | undefined) ?? (id ? doc().get(id, 'transform') : undefined) ?? [1, 0, 0, 0, 1, 0]) as Matrix;
      if (typeof p.rotation === 'number') m = withRotation(m, p.rotation);
      m = [m[0], m[1], typeof p.x === 'number' ? p.x : m[2], m[3], m[4], typeof p.y === 'number' ? p.y : m[5]];
      p.transform = m;
      delete p.x;
      delete p.y;
      delete p.rotation;
    }
    return p as Props;
  };
  const summary = (id: string) => {
    const d = doc();
    const m = (d.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
    const s: Record<string, unknown> = { id, type: d.type(id), name: d.get(id, 'name') ?? '', x: r1(m[2]), y: r1(m[5]), width: r1(d.get(id, 'width') ?? 0), height: r1(d.get(id, 'height') ?? 0) };
    const rot = rotationOf(m);
    if (Math.abs(rot) > 0.01) s.rotation = r1(rot);
    const t = d.get(id, 'characters');
    if (t) s.characters = t.length > 200 ? `${t.slice(0, 200)}…` : t;
    if (d.get(id, 'visible') === false) s.visible = false;
    const main = d.type(id) === 'INSTANCE' ? d.get(id, 'componentId') : undefined;
    if (main) s.componentId = main;
    if (d.get(id, 'layoutMode') && d.get(id, 'layoutMode') !== 'NONE') s.layoutMode = d.get(id, 'layoutMode');
    return s;
  };
  const tree = (id: string, depth: number, budget: { n: number }): Record<string, unknown> => {
    const s = summary(id);
    const kids = doc().children(id);
    if (kids.length) {
      if (depth <= 0 || budget.n <= 0) s.children = `${kids.length} слоёв (глубже — get_tree с id)`;
      else {
        s.children = kids.slice(0, 200).map((k) => {
          budget.n--;
          return tree(k, depth - 1, budget);
        });
        if (kids.length > 200) (s.children as unknown[]).push(`ещё ${kids.length - 200}`);
      }
    }
    return s;
  };

  return [
    {
      name: 'get_selection',
      description: 'Выделенные слои (id, тип, имя, положение, размер, текст). Если ничего не выделено — фреймы открытой страницы.',
      input_schema: obj({}),
      run: async () => {
        const d = doc();
        const sel = ed.selection.filter((id) => d.has(id));
        return text({ page: { id: ed.pageId, name: d.get(ed.pageId, 'name') }, selection: sel.map(summary), ...(sel.length ? {} : { frames: d.children(ed.pageId).slice(0, 100).map(summary) }) });
      },
    },
    {
      name: 'get_tree',
      description: 'Дерево слоёв: слой id (по умолчанию открытая страница) на глубину depth (по умолчанию 3). Координаты x, y — относительно родителя.',
      input_schema: obj({ id: { type: 'string' }, depth: { type: 'number' } }),
      run: async (a) => text(tree(a.id ? need(a.id) : ed.pageId, Math.min(8, Number(a.depth ?? 3)), { n: 1500 })),
    },
    {
      name: 'get_node',
      description: 'Все свойства слоя (как в Plugin API Figma: fills, strokes, effects, cornerRadius, auto layout, текстовые свойства…), без геометрии контуров.',
      input_schema: obj({ id: { type: 'string' } }, ['id']),
      run: async (a) => {
        const id = need(a.id);
        const p = { ...doc().props(id) } as Record<string, unknown>;
        for (const k of Object.keys(p)) if (HIDDEN.has(k)) delete p[k];
        return text({ ...summary(id), props: p, children: doc().children(id).length });
      },
    },
    {
      name: 'set_properties',
      description:
        'Поменять свойства слоёв: [{ id, props }]. props — как в Plugin API Figma: fills [{ type: "SOLID", color: { r, g, b } }] (0…1, opacity — отдельно), ' +
        'strokes, strokeWeight, cornerRadius, opacity, width, height, x, y, rotation, visible, effects, layoutMode ("HORIZONTAL" / "VERTICAL"), itemSpacing, paddingLeft…, ' +
        'primaryAxisAlignItems, counterAxisAlignItems, layoutSizingHorizontal ("FIXED" / "HUG" / "FILL"), fontSize, fontName { family, style }, textAlignHorizontal.',
      input_schema: obj({ changes: { type: 'array', items: obj({ id: { type: 'string' }, props: { type: 'object' } }, ['id', 'props']) } }, ['changes']),
      edits: true,
      run: async (a) => {
        const changes = (a.changes as { id: string; props: Record<string, unknown> }[]) ?? [];
        for (const c of changes) doc().set(need(c.id), placement(c.id, c.props ?? {}));
        return text({ changed: changes.length, nodes: changes.map((c) => summary(c.id)) });
      },
    },
    {
      name: 'rename',
      description: 'Переименовать слои: [{ id, name }].',
      input_schema: obj({ changes: { type: 'array', items: obj({ id: { type: 'string' }, name: { type: 'string' } }, ['id', 'name']) } }, ['changes']),
      edits: true,
      run: async (a) => {
        const changes = (a.changes as { id: string; name: string }[]) ?? [];
        for (const c of changes) doc().set(need(c.id), { name: String(c.name).slice(0, 200) });
        return text({ renamed: changes.length });
      },
    },
    {
      name: 'set_text',
      description: 'Заменить текст текстовых слоёв: [{ id, characters }] (заполнение данными: имена, цены, даты, описания).',
      input_schema: obj({ changes: { type: 'array', items: obj({ id: { type: 'string' }, characters: { type: 'string' } }, ['id', 'characters']) } }, ['changes']),
      edits: true,
      run: async (a) => {
        const changes = (a.changes as { id: string; characters: string }[]) ?? [];
        for (const c of changes) {
          const id = need(c.id);
          if (doc().type(id) !== 'TEXT') throw new Error(`${id} — не текст`);
          doc().set(id, { characters: String(c.characters) });
        }
        return text({ changed: changes.length });
      },
    },
    {
      name: 'create_tree',
      description:
        'Создать дерево слоёв одним вызовом: { type, props, children, componentId? } в родителе parent (id; по умолчанию — открытая страница). ' +
        'type: FRAME, RECTANGLE, ELLIPSE, TEXT, LINE, POLYGON, STAR, GROUP, COMPONENT, SECTION; componentId — инстанс своего компонента (см. list_components). ' +
        'Экраны — FRAME с fills и размером; списки и кнопки — FRAME с layoutMode, itemSpacing и отступами; текст — TEXT с characters, fontSize, fontName.',
      input_schema: obj({ parent: { type: 'string' }, tree: { type: 'object' }, index: { type: 'number' } }, ['tree']),
      edits: true,
      run: async (a) => {
        const d = doc();
        const parent = a.parent ? need(a.parent) : ed.pageId;
        type Spec = { type?: string; props?: Record<string, unknown>; children?: Spec[]; componentId?: string };
        let count = 0;
        const build = (spec: Spec, into: string, index?: number): string => {
          if (++count > 1500) throw new Error('Слишком большое дерево (больше 1500 слоёв)');
          let id: string;
          if (spec.componentId) {
            if (d.type(spec.componentId) !== 'COMPONENT') throw new Error(`${spec.componentId} — не компонент`);
            const props = placement(null, spec.props ?? {});
            id = instantiate(d, spec.componentId, into, props.transform ?? [1, 0, 0, 0, 1, 0], index);
            const rest = { ...props } as Record<string, unknown>;
            delete rest.transform;
            if (Object.keys(rest).length) d.set(id, rest as Props);
          } else {
            const type = String(spec.type ?? 'FRAME').toUpperCase() as NodeType;
            if (!CREATABLE.has(type)) throw new Error(`Тип ${type} не создать`);
            id = d.create(type, into, placement(null, spec.props ?? {}), index);
          }
          for (const c of spec.children ?? []) build(c, id);
          return id;
        };
        const root = build(a.tree as Spec, parent, a.index === undefined ? undefined : Number(a.index));
        return text({ root, created: count, tree: tree(root, 2, { n: 200 }) });
      },
    },
    {
      name: 'delete_nodes',
      description: 'Удалить слои по id.',
      input_schema: obj({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
      edits: true,
      run: async (a) => {
        const ids = ((a.ids as string[]) ?? []).filter((id) => doc().has(id));
        for (const id of ids) doc().delete(id);
        return text({ deleted: ids.length });
      },
    },
    {
      name: 'select',
      description: 'Выделить слои и показать их на холсте (пользователь увидит результат).',
      input_schema: obj({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
      run: async (a) => {
        const ids = ((a.ids as string[]) ?? []).filter((id) => doc().has(id));
        ed.select(ids);
        const b = ed.selectionBounds(ids);
        if (b) ed.fitRect(b, 40, true);
        return text({ selected: ids.length });
      },
    },
    {
      name: 'list_components',
      description: 'Компоненты файла (дизайн-система): id, имя, размер, наборы вариантов, свойства компонентов — для сборки экранов инстансами (create_tree с componentId).',
      input_schema: obj({}),
      run: async () => {
        const d = doc();
        const out: Record<string, unknown>[] = [];
        const walk = (id: string, page: string) => {
          for (const c of d.children(id)) {
            const t = d.type(c);
            if (t === 'COMPONENT') {
              const set = d.type(id) === 'COMPONENT_SET' ? { set: d.get(id, 'name') } : {};
              out.push({ id: c, name: d.get(c, 'name'), width: r1(d.get(c, 'width') ?? 0), height: r1(d.get(c, 'height') ?? 0), page: d.get(page, 'name'), ...set, ...(d.get(c, 'description') ? { description: d.get(c, 'description') } : {}) });
            } else if (t === 'FRAME' || t === 'SECTION' || t === 'COMPONENT_SET' || t === 'GROUP') walk(c, page);
            if (out.length >= 300) return;
          }
        };
        for (const p of userPages(d)) walk(p, p);
        return text(out.length ? out : 'В файле нет своих компонентов');
      },
    },
    {
      name: 'get_variables',
      description: 'Переменные файла (цвета, числа, строки) по коллекциям: имя, тип, значение в режиме по умолчанию.',
      input_schema: obj({}),
      run: async () => {
        const d = doc();
        const out = localCollections(d).map((c) => {
          const mode = defaultMode(d, c);
          return {
            collection: d.get(c, 'name'),
            variables: variablesIn(d, c)
              .slice(0, 300)
              .map((v) => ({ id: v, name: d.get(v, 'name'), type: d.get(v, 'resolvedType'), value: d.get(v, 'valuesByMode')?.[mode] })),
          };
        });
        return text(out.length ? out : 'В файле нет переменных');
      },
    },
    {
      name: 'screenshot',
      description: 'Снимок слоя (PNG): посмотреть, как выглядит результат. Сторона до 1024 px.',
      input_schema: obj({ id: { type: 'string' } }, ['id']),
      run: async (a) => {
        const id = need(a.id);
        const r = await ed.renderNode(id, 1024);
        if (!r) throw new Error('Слой не нарисовать');
        const bytes = new Uint8Array(await r.blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: btoa(s) } }];
      },
    },
  ];
}
