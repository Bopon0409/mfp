// MCP tools for development (developer mode): the agent receives the design together with code — layer
// styling, CSS and platform code, variables with code names and per-mode values,
// components with their code (code connections), annotations and status; it sets statuses, writes
// annotations and code connections; builds a layer tree from a description (code → canvas).

import {
  ANNOTATION_PROPERTY_LABELS,
  annotationCategories,
  categoryOf,
  codeConnectHolder,
  codeConnectOf,
  componentSetOf,
  instancePropertyValues,
  localCollections,
  propertyDefinitions,
  renderCodeConnect,
  resolveVariable,
  variablesIn,
  type AnnotationPropertyType,
  type CodeConnect,
  type Document,
  type NodeType,
  type Props,
} from '@mfp/core';
import { CODE_LANGUAGES, generateCode, inspectNode, instantiate, styleTokens, type CodeLanguage, type NodeStyle } from '@mfp/editing';
import type { Session } from './session.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<Content[]>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const LANGS = CODE_LANGUAGES.map((l) => l.id);

/** Layer styling without empty values: for the agent response. */
function compact(s: NodeStyle): Record<string, unknown> {
  return simplify(s) as Record<string, unknown>;
}

/**
 * Shorter for the agent: a number without a wrapper (bound to a variable — name and code syntax),
 * color — HEX and opacity, without empty and zero effects.
 */
function simplify(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(simplify);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const token = o.token as { name: string; web: string } | undefined;
  const keys = Object.keys(o);
  if ('value' in o && keys.every((k) => k === 'value' || k === 'token' || k === 'unit')) return token ? { value: o.value, ...(o.unit ? { unit: o.unit } : {}), variable: token.name, code: token.web } : o.unit ? { value: o.value, unit: o.unit } : o.value;
  if (typeof o.r === 'number' && typeof o.g === 'number' && typeof o.b === 'number' && typeof o.a === 'number') {
    const hex = '#' + [o.r, o.g, o.b].map((x) => Math.round(Math.max(0, Math.min(1, x as number)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    return { hex, ...((o.a as number) < 1 ? { alpha: Math.round((o.a as number) * 100) / 100 } : {}), ...(token ? { variable: token.name, code: token.web } : {}) };
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const x = simplify(o[k]);
    if (x === null || x === undefined || x === false || (Array.isArray(x) && !x.length) || (typeof x === 'object' && !Array.isArray(x) && !Object.keys(x as object).length)) continue;
    if ((k === 'blur' || k === 'backdropBlur' || k === 'rotation') && x === 0) continue;
    if (k === 'visible' && x === true) continue;
    out[k] = x;
  }
  return out;
}

/** Collection modes by name (“Theme”: “Dark”) → id for resolveVariable. */
function modesByName(doc: Document, names: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!names) return undefined;
  const out: Record<string, string> = {};
  for (const c of localCollections(doc)) {
    const want = names[doc.get(c, 'name') ?? ''];
    const mode = want && (doc.get(c, 'modes') ?? []).find((m) => m.name === want || m.modeId === want);
    if (mode) out[c] = mode.modeId;
  }
  return out;
}

/** Variable: name, collection, type, per-mode values (aliases resolved), code names. */
function variableInfo(doc: Document, id: string) {
  const coll = doc.parent(id)!;
  const values: Record<string, unknown> = {};
  for (const m of doc.get(coll, 'modes') ?? []) values[m.name] = resolveVariable(doc, id, null, 0, { [coll]: m.modeId });
  return { id, name: doc.get(id, 'name'), collection: doc.get(coll, 'name'), type: doc.get(id, 'resolvedType'), values, codeSyntax: doc.get(id, 'codeSyntax') ?? {}, description: doc.get(id, 'description') || undefined };
}

export function devTools(need: () => Session, text: (v: unknown) => Content[], nodeArg: (s: Session, v: unknown) => string): Tool[] {
  return [
    {
      name: 'get_code',
      description: `Код слоя: ${LANGS.join(', ')} (CSS — оформление слоя; остальные — со вложенными слоями). Переменные — их именами (codeSyntax переменной, если задан). unit — px или rem (веб).`,
      inputSchema: obj(
        {
          id: { type: 'string' },
          language: { type: 'string', enum: LANGS },
          unit: { type: 'string', enum: ['px', 'rem'] },
          nested: { type: 'boolean', description: 'С вложенными слоями (у CSS — по умолчанию нет)' },
          modes: { type: 'object', description: 'Режимы коллекций для значений: { "Тема": "Dark" }' },
        },
        ['id'],
      ),
      run: async (a) => {
        const s = need();
        const id = nodeArg(s, a.id);
        // Unknown language — an error with the list, not silent CSS: the agent will know what to ask for.
        if (a.language !== undefined && !LANGS.includes(a.language as CodeLanguage)) throw new Error(`Нет языка «${String(a.language)}». Есть: ${LANGS.join(', ')}`);
        const language = (a.language ?? 'css') as CodeLanguage;
        return text(generateCode(s.doc, id, { language, unit: a.unit === 'rem' ? 'rem' : 'px', nested: typeof a.nested === 'boolean' ? a.nested : undefined, modes: modesByName(s.doc, a.modes as Record<string, string> | undefined) }));
      },
    },
    {
      name: 'get_design_context',
      description:
        'Всё для разработки слоя: оформление (размеры и режимы размера, auto layout, цвета, текст, эффекты), CSS, дерево детей, ' +
        'компоненты внутри (свойства инстансов и их код по связи с кодом), переменные (значения по режимам и имена для кода), ' +
        'аннотации и статус «готово к разработке».',
      inputSchema: obj({ id: { type: 'string' }, depth: { type: 'number', description: 'Глубина дерева детей (по умолчанию 3)' }, modes: { type: 'object' } }, ['id']),
      run: async (a) => {
        const s = need();
        const doc = s.doc;
        const id = nodeArg(s, a.id);
        const modes = modesByName(doc, a.modes as Record<string, string> | undefined);
        const depth = Math.max(0, Math.min(8, Number(a.depth ?? 3)));
        const tokens = new Map<string, ReturnType<typeof variableInfo>>();
        const components: Record<string, unknown>[] = [];
        const annotations: Record<string, unknown>[] = [];
        let count = 0;
        const walk = (nid: string, d: number): Record<string, unknown> => {
          count++;
          const st = inspectNode(doc, nid, { modes });
          for (const t of styleTokens(st)) if (!tokens.has(t.id)) tokens.set(t.id, variableInfo(doc, t.id));
          for (const ann of doc.get(nid, 'annotations') ?? []) {
            annotations.push({
              node: nid,
              nodeName: doc.get(nid, 'name'),
              category: categoryOf(doc, ann.categoryId)?.label,
              text: ann.labelMarkdown ?? '',
              properties: (ann.properties ?? []).map((p) => ANNOTATION_PROPERTY_LABELS[p.type]),
            });
          }
          const node: Record<string, unknown> = { id: nid, name: st.name, type: st.type, width: st.width.value, height: st.height.value, sizing: st.sizing };
          if (st.text) node.text = st.text.characters.slice(0, 400);
          if (st.type === 'INSTANCE') {
            const links = codeConnectOf(doc, nid).map((l) => ({ language: l.language, source: l.source, code: renderCodeConnect(doc, nid, l) }));
            const comp = doc.get(nid, 'componentId')!;
            const props = Object.fromEntries(Object.entries(instancePropertyValues(doc, nid)).map(([k, v]) => [k.split('#')[0], v]));
            components.push({ id: nid, name: st.name, component: st.component, componentId: comp, properties: props, ...(links.length ? { code: links } : {}) });
            node.component = st.component;
            // Do not descend into an instance with code: for the developer it is a ready-made component.
            if (links.length) return node;
          }
          if (d < depth && count < 400) {
            const kids = doc.children(nid).filter((c) => doc.get(c, 'visible') !== false);
            if (kids.length) node.children = kids.map((c) => walk(c, d + 1));
          }
          return node;
        };
        const tree = walk(id, 0);
        const status = doc.get(id, 'devStatus');
        return text({
          node: compact(inspectNode(doc, id, { modes })),
          ...(status ? { status } : {}),
          css: generateCode(doc, id, { language: 'css', modes }),
          tree,
          ...(components.length ? { components } : {}),
          ...(tokens.size ? { variables: [...tokens.values()] } : {}),
          ...(annotations.length ? { annotations } : {}),
        });
      },
    },
    {
      name: 'get_variables',
      description: 'Переменные документа: коллекции, режимы, значения по режимам (ссылки раскрыты), имена для кода (codeSyntax).',
      inputSchema: obj({ collection: { type: 'string', description: 'Имя коллекции (без — все)' } }),
      run: async (a) => {
        const doc = need().doc;
        const out = localCollections(doc)
          .filter((c) => !a.collection || doc.get(c, 'name') === a.collection)
          .map((c) => ({ id: c, name: doc.get(c, 'name'), modes: (doc.get(c, 'modes') ?? []).map((m) => m.name), variables: variablesIn(doc, c).map((v) => variableInfo(doc, v)) }));
        return text(out);
      },
    },
    {
      name: 'get_components',
      description: 'Компоненты и наборы вариантов: свойства (варианты, тексты, логические, замены) и связь с кодом.',
      inputSchema: obj({ name: { type: 'string', description: 'Часть имени' }, limit: { type: 'number' } }),
      run: async (a) => {
        const doc = need().doc;
        const out: Record<string, unknown>[] = [];
        const q = String(a.name ?? '').toLowerCase();
        for (const id of doc.descendants(doc.root)) {
          const t = doc.type(id);
          if (t !== 'COMPONENT_SET' && !(t === 'COMPONENT' && !componentSetOf(doc, id))) continue;
          const name = doc.get(id, 'name') ?? '';
          if (q && !name.toLowerCase().includes(q)) continue;
          const defs = propertyDefinitions(doc, id);
          out.push({
            id,
            name,
            type: t,
            description: doc.get(id, 'description') || undefined,
            properties: Object.fromEntries(Object.entries(defs).map(([k, d]) => [k.split('#')[0], { type: d.type, default: d.defaultValue, ...(d.variantOptions ? { options: d.variantOptions } : {}) }])),
            code: doc.get(id, 'codeConnect') ?? [],
          });
          if (out.length >= Number(a.limit ?? 200)) break;
        }
        return text(out);
      },
    },
    {
      name: 'set_code_connect',
      description: 'Связать компонент (или набор вариантов) с кодом: шаблон на языке language ({{Свойство}} — значение у инстанса, {{name}} — имя слоя) и где он в коде (source). Пустой template — убрать язык.',
      inputSchema: obj({ id: { type: 'string', description: 'Компонент, набор или инстанс' }, language: { type: 'string' }, template: { type: 'string' }, source: { type: 'string' } }, ['id', 'language', 'template']),
      run: async (a) => {
        const s = need();
        const holder = codeConnectHolder(s.doc, nodeArg(s, a.id));
        if (!holder) throw new Error('Это не компонент и не инстанс');
        const language = String(a.language);
        const list: CodeConnect[] = (s.doc.get(holder, 'codeConnect') ?? []).filter((c) => c.language !== language);
        if (String(a.template).trim()) list.push({ language, template: String(a.template), ...(a.source ? { source: String(a.source) } : {}) });
        await s.edit(() => s.doc.set(holder, { codeConnect: list.length ? list : undefined }));
        return text(list);
      },
    },
    {
      name: 'set_dev_status',
      description: 'Статус фрейма или секции: ready (готово к разработке), completed (сделано) или none.',
      inputSchema: obj({ id: { type: 'string' }, status: { type: 'string', enum: ['ready', 'completed', 'none'] }, description: { type: 'string' } }, ['id', 'status']),
      run: async (a) => {
        const s = need();
        const id = nodeArg(s, a.id);
        const type = a.status === 'ready' ? 'READY_FOR_DEV' : a.status === 'completed' ? 'COMPLETED' : null;
        await s.edit(() => s.doc.set(id, { devStatus: type ? { type, updated: Date.now(), ...(a.description ? { description: String(a.description) } : {}) } : null }));
        return text(s.doc.get(id, 'devStatus') ?? 'Статус снят');
      },
    },
    {
      name: 'add_annotation',
      description: `Аннотация к слою: текст (Markdown), категория (${annotationCategoryHint()}), закреплённые свойства (${Object.keys(ANNOTATION_PROPERTY_LABELS).slice(0, 12).join(', ')}…).`,
      inputSchema: obj({ id: { type: 'string' }, text: { type: 'string' }, category: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } } }, ['id', 'text']),
      run: async (a) => {
        const s = need();
        const id = nodeArg(s, a.id);
        const cats = annotationCategories(s.doc);
        const want = String(a.category ?? '').toLowerCase();
        const cat = cats.find((c) => c.id === a.category || c.label.toLowerCase() === want);
        const props = ((a.properties as string[] | undefined) ?? []).filter((p): p is AnnotationPropertyType => p in ANNOTATION_PROPERTY_LABELS).map((type) => ({ type }));
        const list = [...(s.doc.get(id, 'annotations') ?? []), { labelMarkdown: String(a.text), ...(props.length ? { properties: props } : {}), ...(cat ? { categoryId: cat.id } : {}) }];
        await s.edit(() => s.doc.set(id, { annotations: list }));
        return text(list);
      },
    },
    {
      name: 'create_tree',
      description:
        'Создать дерево слоёв одним вызовом (код → холст): { type, props, children, componentId? } — type как в create_node, ' +
        'componentId — инстанс этого компонента. Удобно переносить вёрстку: div с flex — FRAME с layoutMode и отступами, текст — TEXT.',
      inputSchema: obj({ parent: { type: 'string' }, tree: { type: 'object' }, index: { type: 'number' } }, ['parent', 'tree']),
      run: async (a) => {
        const s = need();
        const parent = nodeArg(s, a.parent);
        type Spec = { type?: string; props?: Props; children?: Spec[]; componentId?: string };
        const made: Record<string, unknown>[] = [];
        let count = 0;
        const build = (spec: Spec, into: string, index?: number): string => {
          if (++count > 2000) throw new Error('Слишком большое дерево (больше 2000 слоёв)');
          let id: string;
          if (spec.componentId) {
            if (s.doc.type(spec.componentId) !== 'COMPONENT') throw new Error(`${spec.componentId} — не компонент`);
            const t = (spec.props?.transform ?? [1, 0, 0, 0, 1, 0]) as Props['transform'];
            id = instantiate(s.doc, spec.componentId, into, t, index);
            const rest = { ...(spec.props ?? {}) } as Record<string, unknown>;
            delete rest.transform;
            if (Object.keys(rest).length) s.doc.set(id, rest as Props);
          } else {
            const type = String(spec.type ?? 'FRAME').toUpperCase() as NodeType;
            if (!['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'VECTOR', 'LINE', 'POLYGON', 'STAR', 'GROUP', 'COMPONENT', 'SECTION'].includes(type)) throw new Error(`Тип ${type} не создать`);
            id = s.doc.create(type, into, spec.props ?? {}, index);
          }
          made.push({ id, name: s.doc.get(id, 'name'), type: s.doc.type(id) });
          for (const c of spec.children ?? []) build(c, id);
          return id;
        };
        const root = await s.edit(() => build(a.tree as Spec, parent, a.index === undefined ? undefined : Number(a.index)));
        return text({ root, created: made.length, tree: s.tree(root, 3) });
      },
    },
  ];
}

function annotationCategoryHint(): string {
  return 'Разработка, Взаимодействие, Доступность, Контент, Поведение или своя';
}
