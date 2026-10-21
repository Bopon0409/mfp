# MFP Enterprise (`ee/`)

MFP enterprise edition modules:

- `oidc.ts` — sign-in through the company SSO (OpenID Connect: authorization code + PKCE, id_token
  verification against JWKS);
- `scim.ts` — SCIM 2.0: users and groups (= teams) from the company directory;
- `audit.ts` — audit log and its export;
- `index.ts` — wiring into the server (`startServer({ enterprise })`, environment variables).

License: like all of MFP, GNU AGPL-3.0 (the `LICENSE` file in the root). The modules are enabled only by
settings (`OIDC_*`, `SCIM_TOKEN`, `MFP_AUDIT`); without them the server runs as the regular edition.

Setup: `docs/self-host.md`, section “Enterprise”.
