**English** · [Русский](README.ru.md)

<p align="center"><img src="docs/brand/mfp-logo.png" alt="MFP" width="360"></p>

# MFP — Make · Frame · Prototype

**A free interface design tool for individuals, teams and entire companies.**
Mockups, prototypes, animation, developer handoff and real-time collaboration — in the browser or
in the desktop app, online or fully offline.

The interface is available in English and Russian: pick a language during installation and switch
it any time in the app (Settings → “Язык / Language”).

MFP is free for everyone — individuals, students, freelancers and companies of any size. No
subscriptions, no feature limits, no ads. The code is open source ([GNU AGPL-3.0](LICENSE)). The
project is funded by donations: if MFP is useful to you, please consider
[supporting it](#support-the-project).

---

## What MFP can do

### Design
- Frames, shapes, vector networks and the pen tool, boolean operations, shape builder,
  variable-width strokes, text on a path.
- Auto layout — rows, columns, wrapping and grid; constraints, layout grids, guides.
- Components, variants and properties; team libraries with selective updates.
- Variables with modes (for example, light and dark themes); color, text and effect styles.
- Text with OpenType features, auto-sizing and styles; your system fonts plus 21 bundled fonts
  with Cyrillic support — all available offline.
- Effects: shadows, blur (including progressive blur), noise, texture, glass, shader fills.
- Images with adjustments and cropping, video fills, Lottie animations, 3D models (glTF / GLB).

### Prototyping and animation
- Screen-to-screen interactions, overlays, scrolling, variables and conditions in prototypes.
- Animation timeline: keyframes, easing curves, looping, path trimming.
- Prototype presentation in device frames; view-only links for colleagues and clients.

### For developers
- Developer mode: sizes, spacing, and code in CSS, Tailwind, SwiftUI, UIKit, Jetpack Compose and
  Android XML; asset export.
- Export to PNG, JPG, WebP, AVIF, SVG and PDF (including CMYK for print).
- REST API, webhooks, integrations with Slack, Telegram and Jira.
- Connect AI agents over MCP (Claude, ChatGPT, Cursor and others).

### Compatibility
- Opens `.fig`, `.sketch`, `.pdf` and SVG files; paste layers from the clipboard of other editors.
- Plugins and widgets in the Figma format — from the catalog, your own folders or open-source
  packages.
- Its own `.mfp` format — the whole file lives on your disk.

### Beyond the usual
- Canvas minimap, page folders, color-coded layers, saved views, isolation mode.
- Fill designs with data from CSV or JSON, arrange objects along an arc, choose units (px, mm,
  pt…).
- Accessibility checks: color vision deficiency simulation.
- AI assistant with your own API key (or a model running on your own computer — Ollama,
  LM Studio).
- Image enhancement: upscale images and video to 4K / 8K right on your GPU.

---

## How to work: solo, as a team, as a company

| Mode | Who it's for | Where files live | Internet |
|---|---|---|---|
| **On this computer** | one person | on your disk (Documents/MFP) | not required |
| **Share with colleagues on the network** | a small team in an office or at home | on the computer that shares access | not required |
| **Company server** | a company with an administrator | on the company's server (Docker) | can be fully blocked |

### Solo
Install the app and choose “On this computer”. No account, no internet: your files stay on your
disk, along with autosave and version history. You can enable internet access in Settings when you
need AI, the font catalog or updates.

### A small team without an administrator
One person opens “Settings → Share with colleagues on the network” in the app, and their computer
becomes the server. Colleagues on the same network connect from the app or simply from a browser
using the address shown, edit the same files at the same time, see each other's cursors and leave
comments. The owner creates accounts for everyone.

### A company
The MFP server ships as a single Docker image: your own database and storage; sign-in by email,
by username and password, or through your company's SSO (OIDC, SCIM); an audit log. Internet
access can be blocked completely — MFP then runs on a closed network, and the company server
distributes app updates itself. Details: [docs/self-host.md](docs/self-host.md).

### MFP Cloud — not yet
There are no MFP cloud servers for now: your files live on your computer, on a colleague's computer
or on your company's server. If the community grows large, we will launch our own MFP cloud so you
can work right in the browser without a server of your own.

### Collaboration (in every mode with a server)
Real-time co-editing, comments and mentions, file branches, shared libraries, version history,
file permissions, teams and projects, view-only links.

---

## Download

- **Windows 10 / 11 (64-bit)** — the installer is in [Releases](https://github.com/Bopon0409/mfp/releases).
- **macOS and Linux** — coming soon.

The app checks for updates on its own and offers to install new versions — even when internet
access is turned off for everything else (the “Check for updates” option in Settings; the app only
asks for the latest version number). Every update is signed with the project's key, so it cannot be
tampered with.

The app is not yet signed with a publisher certificate, so Windows may warn about an “unknown
publisher”: click “More info” → “Run anyway”.

---

## Support the project

MFP is free and will stay free. Donations go toward developing MFP — and, if the community grows
large, toward our own MFP cloud servers.

| Network | Address |
|---|---|
| [USDT (TRC-20)] | `TU6UR3GydSrmK3mG7Wiote3Vn8jY1zKSYg` |
| [Bitcoin (BTC)] | `bc1q9qtz7rp2shtj5ufweyp8dcz60g2md8qcrue3mc` |
| [EVM networks] | `0x5F6D23d04F69F8DD356505aa699FCb774A27FF72` |

Thank you to everyone who helps!

---

## Privacy

- In “On this computer” mode, MFP sends nothing to the internet: your files, fonts and tools stay
  with you.
- API keys for AI services are stored only on your side and go directly to the service you choose.
- On a company or colleague's server, files are kept by the owner of that server.

---

## Open source

MFP is an open-source project licensed under the [GNU AGPL-3.0](LICENSE): use it, study it, change
it and share it. If you distribute a modified MFP or run it as a service for other people, the
source code of your changes must also be made available under the same license.

Bugs and suggestions go to [Issues](https://github.com/Bopon0409/mfp/issues), fixes to pull
requests. How the project is organized and how to build it:
[docs/development.md](docs/development.md).

The software is provided “as is”, without warranty — keep backups of important files. Third-party
components and fonts are distributed under their own licenses — see [THIRD-PARTY.md](THIRD-PARTY.md).

Figma is a trademark of Figma, Inc. MFP is an independent product, not affiliated with or endorsed
by Figma, Inc.; references to Figma indicate file and plugin compatibility only.
