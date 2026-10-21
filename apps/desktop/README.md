# MFP for Windows, macOS and Linux

A Tauri 2 window with the same editor (`apps/editor`), plus access to the disk, system fonts and
updates. The window's own commands are in `src-tauri/src/lib.rs`, calls from the editor in `apps/editor/src/platform.ts`.

## Features

- Open .mfp and .fig files from disk (also by double-clicking in Explorer, including into an already open window), save
  .mfp (Ctrl+S, Ctrl+Shift+S). The file is written both when the window closes and when idle; if the window closed
  before writing, edits are recovered from the working copy.
- System fonts — without a browser permission prompt.
- Screen-wide eyedropper — on Windows (WebView2). Not yet available on macOS and Linux.
- File tabs: Ctrl+Tab, Ctrl+W, Ctrl+T.
- Update checks: in the main menu and silently 15 s after launch.
- Language: the installer asks English / Русский and writes the choice to `lang.txt` next to the program
  (`src-tauri/windows/hooks.nsh`); the app reads it at launch.

## File access

The editor page cannot read and write arbitrary files, only (`src-tauri/src/scope.rs`):
- its own folders — Documents/MFP and the app's service folder;
- the program folder — read-only (`mfp-company.json`, `lang.txt`);
- system fonts — read-only;
- files chosen by the user: the “Open” and “Save” dialogs (shown by the shell — commands
  `pick_open`, `pick_save`), double-click in Explorer. The list of chosen files is kept in
  `granted-files.json` in the service folder, so “Recent” files open after a restart too.

File dialogs opened from the page (`dialog:allow-open`, `dialog:allow-save`) are disabled. Migration from
an old version: on first launch, while there is no list yet, “Recent” paths are allowed (only .mfp,
.fig, .sketch, .pdf files). Check: the `scope` scenario in `npm run e2e:desktop`.

No CSP is set for the window: plugin windows are iframes with their own `srcdoc` and inline scripts,
and such an iframe inherits the page's CSP. Plugins are protected by a sandbox without allow-same-origin and by the CSP of the
plugin window itself (`packages/plugin-host/src/browser/host.ts`).

## Running in development

1. Install Rust (`rustup`). Windows also needs WebView2, which is already included in Windows 10 and 11.
2. Start the editor server: `npm run dev:editor` (port 5174).
3. Open the window: `npm run dev -w @mfp/desktop`.

## Build

- `npm run build -w @mfp/desktop` — builds the editor (`vite build`) and the app with installers.
  Each system's installer is built on that system:
  - Windows — NSIS and MSI;
  - macOS — dmg;
  - Linux — AppImage and deb.
- `npm run build -w @mfp/desktop -- --no-bundle` — the program only, without installers.
- The build goes through `scripts/tauri-build.ts`: it adds rustc `--remap-path-prefix`, so the binary
  doesn't contain paths from the builder's home folder (`~/.cargo/registry/…`). Plain `npx tauri build`
  works too, but leaves those paths in.
- Dependency licenses: `node scripts/third-party.ts` (also updates `THIRD-PARTY.md`).

## Updates

- The public verification key is in `tauri.conf.json` (`plugins.updater.pubkey`). The private key
  is kept outside the repository. At build time it is passed via `TAURI_SIGNING_PRIVATE_KEY`
  (path or contents).
- Update endpoints are set by the editor (`apps/editor/src/main.ts`, `updateEndpoints`): the team's own
  server, and, when “Check for updates” is on (or on a manual check with internet access), the
  GitHub releases (`latest.json` of the latest release). That is why
  `plugins.updater.endpoints` in `tauri.conf.json` is empty.
- Release: `node scripts/release-desktop.ts "what's new"` — a signed installer and `latest.json`
  (details in `docs/self-host.md`).
- Signing the installers themselves (Authenticode on Windows, Apple notarization) requires separate
  certificates. Without it, the system shows a warning during installation.
