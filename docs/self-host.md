# Self-hosting MFP

The MFP server is a single Node.js process: API, collaboration (WebSocket), the built editor,
webhooks, MCP. Data lives in a database (SQLite or PostgreSQL) and storage (disk or S3).

## Quick start: Docker Compose

Requires Docker and Docker Compose. Included: the MFP server (with the editor), PostgreSQL 17, MinIO (S3).

```bash
cp .env.example .env      # change the passwords, address, email
docker compose up -d      # first run builds the image (a few minutes)
```

Open `http://localhost:8080` (or `MFP_APP_URL`). The first person to sign in becomes the server administrator.

Sign-in is by email (codes arrive by email; without SMTP they go to the log) or, if there is no email, by username
and password (`MFP_AUTH=password`). In the second case, a server without accounts prints a first-setup
code to the log (`docker compose logs mfp`): open the editor, click “Sign in”, enter the code and the administrator's
username and password. The administrator adds everyone else: account menu → “Accounts…” — username and a
temporary password (the person changes it at first sign-in); the same place lets you disable accounts, grant rights and reset passwords.
Access to a file or team can be granted by username instead of email.

- Logs: `docker compose logs -f mfp`. Without SMTP, sign-in codes are shown here.
- Updating: `git pull && docker compose up -d --build`.
- Backup: database — `docker compose exec db pg_dump -U mfp mfp > mfp.sql`; files — the `mfp` bucket
  in MinIO (`mc mirror`) and the `mfp-data` volume (rooms without accounts).
- MinIO is a separate program (AGPL license); MFP talks to it only over the S3 API. Any
  S3-compatible storage works instead (Yandex Object Storage, VK Cloud, SeaweedFS, Ceph,
  AWS S3): set `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` and remove
  the `minio` and `minio-init` services from compose.

## Without Docker

Requires Node.js 24. The server is built into a single minified module (`scripts/build-server.ts`, as in the image);
for development it can also run directly from source: `npm run dev:server`.

```bash
npm ci
npm run build -w @mfp/editor
node scripts/build-server.ts
PORT=8080 MFP_DATA=/var/lib/mfp MFP_STATIC=apps/editor/dist node apps/server/dist/main.mjs
```

Without `DATABASE_URL` the database is SQLite (`<MFP_DATA>/mfp.db`); without `S3_*` files are stored on disk (`MFP_DATA`).
This is enough for a team of up to several dozen people.

## Settings (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | port (default 5175, 8080 in Docker) |
| `MFP_DATA` | data folder |
| `MFP_STATIC` | folder of the built editor: it is served from the same address |
| `MFP_APP_URL` | editor address used in links in emails and webhooks |
| `DATABASE_URL` | `postgres://…` — PostgreSQL instead of SQLite |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | S3 storage |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | email: 465 — implicit TLS, 587 — STARTTLS |
| `MFP_WEBHOOKS_PRIVATE=1` | allow webhooks to addresses on the internal network (not allowed by default) |
| `MFP_AUTH=password` | sign-in by username and password instead of email codes (a server without SMTP and SSO); first setup uses a code from the log |
| `MFP_NETWORK=off` | closed network: editors of this server (in the browser and in the apps) do not access the internet — AI, the font catalog and updates are turned off, bundled fonts are used; users cannot turn internet access on themselves |

Behind a reverse proxy (nginx, Caddy), forward WebSocket (`/file/`, `/room/`) and the headers
`Host`, `X-Forwarded-Proto`, `X-Forwarded-For`; allow request bodies up to 256 MB (uploading large files).

## Enterprise (`ee/`)

Enterprise edition modules are enabled with environment variables (license: `ee/README.md`):

- **SSO (OpenID Connect)** — Okta, Keycloak, Entra ID (Azure AD), Google Workspace, Yandex 360:
  `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` (button label),
  `OIDC_DOMAINS` (company domains — SSO only for them), `MFP_PUBLIC_URL`. Redirect URI at the provider:
  `<MFP_PUBLIC_URL>/api/sso/callback`. Flow: authorization code + PKCE; the id_token is verified
  against the provider's keys (JWKS).
- **SCIM 2.0** — the company directory provisions and deactivates users, groups = MFP teams:
  endpoint `<MFP_PUBLIC_URL>/scim/v2`, token `SCIM_TOKEN`.
- **Audit log** — sign-in and sign-out, tokens, teams and roles, file access and links,
  deletion, branches, libraries, webhooks, SSO and SCIM: “Account” → “Audit log…”
  (server administrator), CSV export. Enabled with SSO or SCIM, or with `MFP_AUDIT=1`.

Deferred: SAML and LDAP (next after OIDC — most providers support OIDC).

## For programs

- REST API `/v1/…` (format-compatible with the Figma REST API): document JSON, nodes, node images, comments, webhooks.
  Token: “Account” → “API tokens…”, header `Authorization: Bearer mfp_…`.
- MCP over the network: `POST /mcp` (Streamable HTTP) with the same token — agents open the server's files,
  inspect, edit and comment on them.
- Webhooks and integrations (Slack, Telegram, Jira) belong to a team: “Files” → team → “Integrations…”.

## Employee apps

The MFP desktop app works with the company server automatically if the file `mfp-company.json` is
next to the program (in the installation folder, where `mfp-desktop.exe` is). The administrator places it along with
the installation (script, policy, system image):

```json
{ "server": "https://mfp.company.local", "network": "off" }
```

- `server` — the company server address: the app signs in to it right away, without the mode selection window; the mode
  cannot be changed in Settings.
- `network: "off"` — internet access is always off, even when the server is unreachable (closed network). Without this
  field, the restriction comes from a server with `MFP_NETWORK=off` on connection.

Without the file, the app asks on first launch: “On this computer” (files on disk, no
account and no internet by default) or “With a team server”.

## App updates

The desktop app checks for updates 15 seconds after launch (and via “Help → Check
for updates…”). It first asks the server it is connected to (`<server>/updates/latest.json`), then
the MFP releases page on GitHub — if internet access is allowed or “Settings → Check
for updates” is on (on by default: only the version number, no user data; always off on an organization's
closed network). Every update is signed with the MFP key, and the app verifies the
signature before installing, so updates can be distributed over plain http inside the network.

The company server distributes updates from the `updates` folder in its data (`/data/updates` in Docker):

1. Download from the latest GitHub release (https://github.com/Bopon0409/mfp/releases/latest) the
   `latest.json` file and the `MFP_<version>_x64-setup.exe` installer.
2. Put both files into `/data/updates`, for example:
   `docker compose cp latest.json mfp:/data/updates/` and `docker compose cp MFP_<version>_x64-setup.exe mfp:/data/updates/`.
3. Done: the server rewrites the links in `latest.json` to its own address, and employees' apps
   update without internet access.

Releasing a version (for developers): `npm run build -w @mfp/desktop -- --bundles nsis`, then
`node scripts/release-desktop.ts "what's new"` — a signed installer and `latest.json` in
`dist/updates-<version>/`.

## Without a dedicated server: a computer as the office server

For a small team without an administrator: in the MFP app on one computer, Settings →
“Share with colleagues on the network…” → “Start sharing”. The app starts the built-in MFP server (Node.js and
the server from the `office` folder next to the program), asks to create the owner's account on first start
and shows the address for colleagues, for example `http://192.168.1.10:8686`.

- Colleagues open the address in a browser or in their own app (Settings → “Mode” → “With a team
  server” → address) and sign in with a username; the owner creates the accounts (“Accounts…”).
- Files and the database are on this computer (the app's data folder, `office`); while it is turned off, colleagues
  cannot work. “Share when MFP starts” starts the server together with the app.
- On first start, Windows asks for permission to access the network — allow it for private networks.
- No internet needed: the app treats local network addresses (10.x, 172.16–31.x, 192.168.x, `.local` names)
  as its own even with internet access turned off.
- The server runs while the app runs and exits together with it (even on a crash).
