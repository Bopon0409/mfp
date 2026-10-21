// Vite plugin for development: serves test .fig files from fixtures/ (with Range requests)
// and sample plugins from packages/plugin-host/fixtures/. Local development only.

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'fixtures');
const PLUGINS = join(ROOT, 'packages/plugin-host/fixtures');

export function devFiles(): Plugin {
  return {
    name: 'mfp-dev-files',
    configureServer(server) {
      server.middlewares.use('/api/fixtures', (_req, res) => {
        const files = readdirSync(FIXTURES)
          .filter((f) => f.toLowerCase().endsWith('.fig'))
          .map((name) => ({ name, size: statSync(join(FIXTURES, name)).size }));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(files));
      });
      server.middlewares.use('/api/plugins', (_req, res) => {
        const list = readdirSync(PLUGINS, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(list));
      });
      server.middlewares.use('/plugins/', (req, res, next) => {
        const parts = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')
          .split('/')
          .filter(Boolean);
        if (parts.length !== 2 || parts.some((p) => p.includes('..'))) return next();
        const path = join(PLUGINS, parts[0]!, parts[1]!);
        try {
          statSync(path);
        } catch {
          return next();
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        createReadStream(path).pipe(res);
      });
      // HEAD and Range: only the needed parts of large files are read.
      server.middlewares.use('/fixtures/', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0] ?? '');
        if (!name.toLowerCase().endsWith('.fig') || name.includes('..') || name.includes('/')) return next();
        const path = join(FIXTURES, name);
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          return next();
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${size}`);
            return res.end();
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', end - start + 1);
          if (req.method === 'HEAD') return res.end();
          createReadStream(path, { start, end }).pipe(res);
          return;
        }
        res.setHeader('Content-Length', size);
        if (req.method === 'HEAD') return res.end();
        createReadStream(path).pipe(res);
      });
    },
  };
}
