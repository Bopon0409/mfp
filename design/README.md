# MFP interface design — the new look

**`interface.mfp`** is the design of MFP's own interface. It was made in MFP itself and opens in the
editor like any other file.

## What's in the file

| Page | Contents |
|---|---|
| Cover | Six design principles and a color strip; where the interface grows |
| Foundations | An OKLCH palette, theme roles in two modes, text styles, a 4 px grid, corner radii |
| Components | Icons — vectors from the app's icon set. Button, icon button, field, tab, layer row, section header, tool, menu item, checkbox — with variants and bound to variables |
| Screens | Editor, files, menu and the actions window (Ctrl+K), each in the dark and the light theme |

The light screens are the same mockups with the “Light” variable mode. Components don't know which
theme they are in.

Images of the pages are in [`previews/`](previews). There are also screenshots of the real app with
this design: “App — dark”, “App — light” and, for comparison, “App — classic”.

## Variables are the source of the app's colors

- **“Palette”** — 37 colors in OKLCH. The OKLCH notation is stored in the variable description.
- **“Theme”** — roles (`--bg`, `--panel`, `--accent`…) with the “Dark” and “Light” modes.
- **“Sizes”** — corner radii, spacing, heights, panel widths.

The app takes its colors from these variables:

```bash
npm run design:tokens
```

The command reads `interface.mfp` and writes `apps/editor/src/ui/tokens.css` (the “Variables to CSS”
export). To change a color in the app, edit the variable in the file, save it here as `.mfp` and run
the command.

## How the file is built

The builder `tools/build-interface.js` runs inside an editor page and uses the app's own features:
- variables and modes;
- text and shadow styles;
- SVG import — icons;
- components and variants;
- auto layout;
- saving `.mfp`.

The build takes about 5 seconds. The page images in `previews/` are rendered from the file with the
CLI (`mfp render design/interface.mfp --node <id>`).

## Logo

[`logo/mfp-logo.png`](logo/mfp-logo.png) is the source of the MFP logo. The app icon, the in-app
mark and the images in `docs/brand/` are made from it.

## The look in the app

- **A layer over the classic styles.** The new look is `apps/editor/src/ui/new.css` on top of the
  `index.html` styles. Both looks share markup and code, so they have the same features.
- **Switching:** Settings → Appearance → New / Classic. The theme of the new look is there too: dark,
  light or as in the system. The choice is remembered.
- **High contrast** always uses the classic contrast colors.
- **The selection color on the canvas** comes from the look's accent: boxes, handles, vectors,
  gradients, prototype connections.

**Going back to the classic look** — three ways, from light to thorough:
1. **Settings → Appearance → Classic.** Applies at once, without a restart; the choice is remembered.
2. **Classic by default for everyone.** In `apps/editor/index.html`:
   `<meta name="mfp-ui-default" content="classic">`. Whoever already picked a look in the menu keeps it.
3. **Remove the new look from the code.** Delete the three imports of `ui/tokens.css` and `ui/new.css`
   (`main.ts`, `player/main.ts`). Without these styles the app looks classic, and so does the selection
   color on the canvas; the rest of the code doesn't depend on them.
