# MFP development

## Structure

```
packages/core         document model: nodes, operations, undo and redo
packages/io-figma     .fig reading (ZIP + fig-kiwi), scene, conversion to the model, .mfp format
packages/renderer     CanvasKit (Skia) renderer: tiles, text, fonts, images
packages/layout       auto layout on Taffy
packages/editing      UI-independent editing rules: auto layout, groups, components
packages/plugin-host  Figma-format plugins (QuickJS)
packages/sync         bridge between the document and the Loro CRDT
apps/editor           editor (http://localhost:5174)
apps/viewer           viewer with benchmarks (http://localhost:5173)
apps/cli              command line and MCP server for agents
apps/server           collaboration server (files, Loro over WebSocket, API, MCP, updates)
apps/desktop          desktop app (Tauri): disk, system fonts, office server
ee/                   SSO sign-in, SCIM, audit log
scripts/              release builds, app checks, performance budgets
fixtures/             test .fig files (not committed to git)
```

## Commands

```bash
npm install
npm run dev:editor        # editor
npm run dev:viewer        # viewer
npm run dev:server        # server (port 5175)
npm run mfp -- render fixtures/file.fig --node "Frame name" -o out.png
npm run perf              # performance budgets on fixtures
npm test
npm run typecheck
npm run e2e:desktop       # checks of the built app (Windows)
```

Requires Node.js 24+.
