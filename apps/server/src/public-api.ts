// Public API for programs (personal token: Authorization: Bearer mfp_…):
// - REST v1 — format-compatible with the Figma REST API: JSON document (/v1/files/:id, ?depth, ?ids), nodes,
//   node images (PNG, server-side render), comments, teams and projects; webhooks — hooks.ts;
// - MCP over the network (Streamable HTTP, POST /mcp): agents open server files and work with them
//   using the same tools as the command-line MCP (tree, properties, editing, render, code),
//   plus server files and comments. Agent edits behave like participant edits: visible to everyone at once.

import { Document, pageOf, placePoint, userPages } from '@mfp/core';
import { LoroBridge } from '@mfp/sync';
import { documentTools, mcpRpc, obj, textContent, type Tool } from '@mfp/cli/src/mcp.ts';
import { Session } from '@mfp/cli/src/session.ts';
import { atLeast, fileRole, needFile, needTeam, type FileRole, type FileRow } from './access.ts';
import type { ApiDeps } from './api.ts';
import { mcpChallenge } from './oauth.ts';
import type { Ctx, Router } from './router.ts';
import { fail, newSecret, readBody, sendBytes } from './util.ts';

/** Heavy derived data — not included in the document JSON. */
const SKIP = new Set(['textGlyphs', 'vectorPaths', 'strokePaths', 'centerPaths', 'geometrySize']);

function nodeJson(doc: Document, id: string, depth: number): Record<string, unknown> {
  const n = doc.node(id)!;
  const out: Record<string, unknown> = { id, type: n.type };
  for (const [k, v] of Object.entries(n.props)) if (!SKIP.has(k) && v !== undefined) out[k] = v;
  const kids = doc.children(id);
  if (kids.length) {
    if (depth > 0) out.children = kids.map((c) => nodeJson(doc, c, depth - 1));
    else out.childCount = kids.length;
  }
  return out;
}

export function registerPublicApi(r: Router, d: ApiDeps): { close(): void } {
  const { db } = d;

  /** File document (from memory or storage). */
  const loadDoc = async (fileId: string) => {
    const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
    const bridge = new LoroBridge(doc);
    bridge.importUpdate(await d.live.snapshot(fileId));
    bridge.dispose();
    doc.clearHistory();
    return doc;
  };
  const images = {
    readImage: async (hash: string) => (/^[0-9a-f]{40}$/.test(hash) ? ((await d.store.get(`images/${hash}`)) ?? undefined) : undefined),
  };
  const origin = (c: Ctx) => `${(c.req.headers['x-forwarded-proto'] as string) ?? 'http'}://${c.req.headers.host ?? 'localhost'}`;
  const file = async (c: Ctx, need: FileRole = 'view') => needFile(db, c.params.id!, c.need().user.id, need);

  // ---------- REST v1 ----------

  r.add('GET', '/v1/me', async (c) => {
    const u = c.need().user;
    return { id: u.id, email: u.email, handle: u.name, color: u.color };
  });

  r.add('GET', '/v1/files/:id', async (c) => {
    const { file: f, role } = await file(c);
    const doc = await loadDoc(f.id);
    const depth = c.query.has('depth') ? Math.max(0, Number(c.query.get('depth'))) : Infinity;
    const ids = (c.query.get('ids') ?? '').split(',').filter((x) => x && doc.has(x));
    return {
      name: f.name,
      role,
      lastModified: new Date(f.modified).toISOString(),
      document: ids.length ? { id: doc.root, type: 'DOCUMENT', children: ids.map((id) => nodeJson(doc, id, depth)) } : nodeJson(doc, doc.root, depth),
    };
  });

  r.add('GET', '/v1/files/:id/nodes', async (c) => {
    const { file: f } = await file(c);
    const doc = await loadDoc(f.id);
    const depth = c.query.has('depth') ? Math.max(0, Number(c.query.get('depth'))) : Infinity;
    const nodes: Record<string, unknown> = {};
    for (const id of (c.query.get('ids') ?? '').split(',').filter(Boolean)) nodes[id] = doc.has(id) ? { document: nodeJson(doc, id, depth) } : null;
    return { name: f.name, lastModified: new Date(f.modified).toISOString(), nodes };
  });

  /** Node images: PNG addresses (requested with the same token). */
  r.add('GET', '/v1/images/:id', async (c) => {
    const { file: f } = await file(c);
    const scale = Math.min(4, Math.max(0.1, Number(c.query.get('scale') ?? 1)));
    const out: Record<string, string> = {};
    for (const id of (c.query.get('ids') ?? '').split(',').filter(Boolean)) out[id] = `${origin(c)}/v1/images/${f.id}/${encodeURIComponent(id)}.png?scale=${scale}`;
    return { images: out };
  });

  r.add('GET', '/v1/images/:id/:node', async (c) => {
    const { file: f } = await file(c);
    const node = c.params.node!.replace(/\.png$/, '');
    const doc = await loadDoc(f.id);
    if (!doc.has(node)) fail(404, 'Нет такого узла');
    const scale = Math.min(4, Math.max(0.1, Number(c.query.get('scale') ?? 1)));
    const png = await Session.fromDocument(doc, images, f.name).render(node, scale);
    sendBytes(c.res, png.png, 'image/png', 'private, max-age=60');
  });

  r.add('GET', '/v1/files/:id/comments', async (c) => {
    const { file: f } = await file(c);
    return {
      comments: (await d.comments!.list(f.id)).map((x) => ({
        id: x.id,
        message: x.text,
        user: { id: x.author.id, handle: x.author.name },
        created_at: new Date(x.created).toISOString(),
        resolved_at: x.resolved ? new Date(x.resolved).toISOString() : null,
        parent_id: x.thread ?? '',
        client_meta: x.place ? { node_id: x.place.anchor ?? null, node_offset: { x: x.place.at[0], y: x.place.at[1] } } : null,
        reactions: x.reactions,
      })),
    };
  });

  /** Comment: {message, comment_id? (reply), client_meta?: {node_id, node_offset: {x, y}} | {x, y}}. */
  r.add('POST', '/v1/files/:id/comments', async (c) => {
    const p = c.need();
    const { file: f } = await file(c, 'comment');
    const b = JSON.parse(new TextDecoder().decode(await readBody(c.req, 1 << 20)) || '{}') as {
      message?: string;
      comment_id?: string;
      client_meta?: { node_id?: string; node_offset?: { x: number; y: number }; x?: number; y?: number };
    };
    let place: unknown = null;
    if (!b.comment_id) {
      const doc = await loadDoc(f.id);
      const meta = b.client_meta ?? {};
      if (meta.node_id) {
        if (!doc.has(meta.node_id)) fail(400, 'Нет такого узла');
        const page = pageOf(doc, meta.node_id)!;
        const at: [number, number] = [meta.node_offset?.x ?? 0, meta.node_offset?.y ?? 0];
        place = { page, anchor: meta.node_id, at, pageAt: placePoint(doc, { page, anchor: meta.node_id, at }) };
      } else {
        const page = userPages(doc)[0];
        if (!page) fail(400, 'В файле нет страниц');
        place = { page, anchor: null, at: [meta.x ?? 0, meta.y ?? 0] };
      }
    }
    const v = await d.comments!.create(f, p.user, { text: b.message ?? '', thread: b.comment_id ?? null, place });
    return { id: v.id, message: v.text, created_at: new Date(v.created).toISOString(), parent_id: v.thread ?? '' };
  });

  r.add('GET', '/v1/teams/:id/projects', async (c) => {
    await needTeam(db, c.params.id!, c.need().user.id, 'viewer');
    const team = await db.get<{ name: string }>(`SELECT name FROM teams WHERE id = ?`, [c.params.id]);
    return { name: team?.name ?? '', projects: await db.all(`SELECT id, name FROM projects WHERE team_id = ? ORDER BY name`, [c.params.id]) };
  });

  r.add('GET', '/v1/projects/:id/files', async (c) => {
    const p = c.need();
    const pr = await db.get<{ id: string; team_id: string; name: string }>(`SELECT * FROM projects WHERE id = ?`, [c.params.id]);
    if (!pr) fail(404, 'Нет такого проекта');
    await needTeam(db, pr!.team_id, p.user.id, 'viewer');
    const files = await db.all<FileRow>(`SELECT * FROM files WHERE project_id = ? AND trashed IS NULL AND parent_id IS NULL ORDER BY modified DESC`, [pr!.id]);
    return { name: pr!.name, files: files.map((f) => ({ key: f.id, name: f.name, last_modified: new Date(f.modified).toISOString(), thumbnail_url: f.thumb ? `${origin(c)}/api/files/${f.id}/thumb` : null })) };
  });

  // ---------- MCP over the network ----------

  interface McpState {
    id: string;
    userId: string;
    last: number;
    file: { id: string; name: string } | null;
    session: Session | null;
    leave: (() => void) | null;
    queue: Promise<unknown>;
  }
  const states = new Map<string, McpState>();
  const closeFile = (st: McpState) => {
    st.leave?.();
    st.leave = null;
    st.session = null;
    st.file = null;
  };
  const closeState = (st: McpState) => {
    closeFile(st);
    states.delete(st.id);
  };
  const sweep = setInterval(() => {
    for (const st of states.values()) if (Date.now() - st.last > 30 * 60_000) closeState(st);
  }, 60_000);
  sweep.unref();

  const readOnlyText = 'Только просмотр: у вас нет права на правку этого файла';
  const tools = (st: McpState): Tool[] => {
    const need = () => {
      if (!st.session) throw new Error('Файл не открыт: сначала list_files и open_file');
      return st.session;
    };
    return [
      {
        name: 'list_files',
        description: 'Файлы на сервере, доступные вам: id, имя, команда и проект, роль. scope: recent (по умолчанию), drafts, shared.',
        inputSchema: obj({ scope: { type: 'string' }, query: { type: 'string', description: 'Часть имени' } }),
        run: async (a) => {
          const scope = String(a.scope ?? 'recent');
          const uid = st.userId;
          const rows =
            scope === 'drafts'
              ? await db.all<FileRow>(`SELECT * FROM files WHERE owner_id = ? AND project_id IS NULL AND trashed IS NULL AND parent_id IS NULL ORDER BY modified DESC LIMIT 100`, [uid])
              : scope === 'shared'
                ? await db.all<FileRow>(`SELECT f.* FROM files f JOIN file_access a ON a.file_id = f.id WHERE a.user_id = ? AND f.trashed IS NULL ORDER BY f.modified DESC LIMIT 100`, [uid])
                : await db.all<FileRow>(
                    `SELECT DISTINCT f.* FROM files f
                     LEFT JOIN projects pr ON pr.id = f.project_id
                     LEFT JOIN team_members m ON m.team_id = pr.team_id AND m.user_id = ?
                     LEFT JOIN file_access a ON a.file_id = f.id AND a.user_id = ?
                     WHERE f.trashed IS NULL AND f.parent_id IS NULL AND (f.owner_id = ? OR m.user_id IS NOT NULL OR a.user_id IS NOT NULL)
                     ORDER BY f.modified DESC LIMIT 100`,
                    [uid, uid, uid],
                  );
          const q = String(a.query ?? '').toLowerCase();
          const out = [];
          for (const f of rows) {
            if (q && !f.name.toLowerCase().includes(q)) continue;
            const project = f.project_id ? await db.get<{ name: string; team: string }>(`SELECT pr.name, t.name AS team FROM projects pr JOIN teams t ON t.id = pr.team_id WHERE pr.id = ?`, [f.project_id]) : null;
            out.push({ id: f.id, name: f.name, where: project ? `${project.team} / ${project.name}` : 'Черновики', role: await fileRole(db, f, uid), modified: new Date(f.modified).toISOString() });
          }
          return textContent(out);
        },
      },
      {
        name: 'open_file',
        description: 'Открыть файл сервера по id (из list_files). Правки — сразу у всех, кто открыл файл (нужно право на правку).',
        inputSchema: obj({ file_id: { type: 'string' } }, ['file_id']),
        run: async (a) => {
          const { file: f, role } = await needFile(db, String(a.file_id ?? ''), st.userId, 'view');
          closeFile(st);
          const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
          const bridge = new LoroBridge(doc);
          const part = await d.live.participant(f.id, (u) => bridge.importUpdate(u));
          bridge.importUpdate(part.snapshot);
          doc.clearHistory();
          // Own edits go to the file and to all participants.
          const off = bridge.loro.subscribeLocalUpdates((u: Uint8Array) => part.submit(u));
          st.session = Session.fromDocument(doc, images, f.name);
          st.session.readOnly = atLeast(role, 'edit') ? null : readOnlyText;
          st.file = { id: f.id, name: f.name };
          st.leave = () => {
            off();
            bridge.dispose();
            part.leave();
          };
          return textContent({ ...st.session.info(), file: f.name, role });
        },
      },
      {
        name: 'get_comments',
        description: 'Комментарии открытого файла: треды с ответами, автор, текст, к какому слою привязан, решён ли.',
        inputSchema: obj({}),
        run: async () => {
          need();
          const list = await d.comments!.list(st.file!.id);
          return textContent(
            list
              .filter((x) => !x.thread)
              .map((t) => ({
                id: t.id,
                author: t.author.name,
                text: t.text,
                node: t.place?.anchor ?? null,
                resolved: !!t.resolved,
                replies: list.filter((x) => x.thread === t.id).map((x) => ({ author: x.author.name, text: x.text })),
              })),
          );
        },
      },
      {
        name: 'add_comment',
        description: 'Оставить комментарий в открытом файле: к слою (node_id, x и y — точка в его координатах) или ответом в тред (thread_id).',
        inputSchema: obj({ text: { type: 'string' }, node_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, thread_id: { type: 'string' } }, ['text']),
        run: async (a) => {
          const s = need();
          const f = (await needFile(db, st.file!.id, st.userId, 'comment')).file;
          const user = (await d.auth.byId(st.userId))!;
          let place: unknown = null;
          if (!a.thread_id) {
            const node = typeof a.node_id === 'string' && s.doc.has(a.node_id) ? a.node_id : null;
            const page = node ? pageOf(s.doc, node)! : userPages(s.doc)[0]!;
            const at: [number, number] = [Number(a.x ?? 0), Number(a.y ?? 0)];
            place = { page, anchor: node, at, pageAt: node ? placePoint(s.doc, { page, anchor: node, at }) : at };
          }
          const v = await d.comments!.create(f, user, { text: String(a.text ?? ''), thread: typeof a.thread_id === 'string' ? a.thread_id : null, place });
          return textContent({ id: v.id, thread: v.thread ?? v.id });
        },
      },
      ...documentTools(need),
    ];
  };

  const instructions =
    'MFP — редактор дизайна (открывает и файлы .fig), файлы на сервере команды. list_files — что доступно, open_file — открыть ' +
    '(правки сразу видят все участники файла), get_tree и render_png — посмотреть, set_properties / create_node / create_tree — ' +
    'править, get_design_context и get_code — для вёрстки, get_comments и add_comment — обсуждение.';

  r.add('POST', '/mcp', async (c) => {
    const p = c.principal;
    if (!p) {
      c.res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': mcpChallenge(c.req) });
      c.res.end(JSON.stringify({ error: 'Нужен токен: Authorization: Bearer mfp_… (Файлы → учётная запись → Токены API)' }));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await readBody(c.req, 8 << 20)));
    } catch {
      fail(400, 'Нужен JSON-RPC');
    }
    const msgs = (Array.isArray(parsed) ? parsed : [parsed]) as { id?: number | string; method?: string; params?: Record<string, unknown> }[];
    const sid = c.req.headers['mcp-session-id'] as string | undefined;
    let st = sid ? states.get(sid) : undefined;
    if (sid && (!st || st.userId !== p.user.id)) fail(404, 'Сессия MCP не найдена — начните заново (initialize)');
    if (!st) {
      if (!msgs.some((m) => m.method === 'initialize')) fail(400, 'Нет сессии MCP: сначала initialize');
      st = { id: newSecret(), userId: p.user.id, last: Date.now(), file: null, session: null, leave: null, queue: Promise.resolve() };
      states.set(st.id, st);
    }
    st.last = Date.now();
    const state = st;
    const rpc = mcpRpc(() => tools(state), { instructions, name: 'mfp-server' });
    // Re-check permissions before each tool (file access may have changed).
    const handle = async (m: (typeof msgs)[number]) => {
      if (m.method === 'tools/call' && state.file) {
        const f = await db.get<FileRow>(`SELECT * FROM files WHERE id = ?`, [state.file.id]);
        const role = f && !f.trashed ? await fileRole(db, f, state.userId) : 'none';
        if (role === 'none') closeFile(state);
        else if (state.session) state.session.readOnly = atLeast(role, 'edit') ? null : readOnlyText;
      }
      return rpc(m);
    };
    // Sequentially within a session: edits do not interleave.
    const run = state.queue.then(async () => {
      const out: unknown[] = [];
      for (const m of msgs) {
        const r = await handle(m);
        if (r) out.push(r);
      }
      return out;
    });
    state.queue = run.catch(() => {});
    const responses = await run;
    c.res.setHeader('mcp-session-id', state.id);
    if (!responses.length) {
      c.res.writeHead(202).end();
      return;
    }
    c.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    c.res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
  });

  r.add('DELETE', '/mcp', async (c) => {
    const sid = c.req.headers['mcp-session-id'] as string | undefined;
    const st = sid ? states.get(sid) : undefined;
    if (st && st.userId === c.need().user.id) closeState(st);
  });

  return {
    close() {
      clearInterval(sweep);
      for (const st of [...states.values()]) closeState(st);
    },
  };
}
