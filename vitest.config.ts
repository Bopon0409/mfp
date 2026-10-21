// Tests: all packages (SQLite for the server), the server tests again on PostgreSQL (PGlite), and
// plugin tests with the sandbox processed as in the build (tools/strip-comments.ts).
import { configDefaults, defineConfig } from 'vitest/config';
import { stripCommentsPlugin } from './tools/strip-comments.ts';

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'main', exclude: [...configDefaults.exclude, '**/dist/**'] } },
      // PGlite (Postgres in WebAssembly) is slower than SQLite: under load a test needs more than 5 s, starting the database more than 10 s.
      { extends: true, test: { name: 'server-postgres', include: ['apps/server/test/**/*.test.ts'], env: { MFP_TEST_DB: 'pglite' }, testTimeout: 20_000, hookTimeout: 30_000 } },
      { extends: true, plugins: [stripCommentsPlugin()], test: { name: 'plugin-host-built', include: ['packages/plugin-host/test/**/*.test.ts'], env: { MFP_SHIM_BUILT: '1' } } },
    ],
  },
});
