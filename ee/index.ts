// Modules for companies (the ee/ folder, licensed like the rest of MFP, GNU AGPL-3.0; see ee/README.md):
// SSO sign-in (OIDC), SCIM 2.0, audit log. Enabled by server settings (environment
// variables, apps/server/src/main.ts) — without them the server works as the regular edition.

import type { ApiDeps } from '../apps/server/src/api.ts';
import type { Router } from '../apps/server/src/router.ts';
import { AuditLog, registerAudit } from './audit.ts';
import { registerOidc, type OidcOptions } from './oidc.ts';
import { registerScim } from './scim.ts';

export interface EnterpriseOptions {
  /** Audit log (enabled by default). */
  audit?: boolean;
  oidc?: OidcOptions;
  /** Directory token for SCIM 2.0 (absent — SCIM is off). */
  scimToken?: string;
}

/** Hook-up for startServer({ enterprise }). */
export function enterprise(o: EnterpriseOptions) {
  return async (r: Router, d: ApiDeps) => {
    let audit: AuditLog | undefined;
    if (o.audit !== false) {
      audit = new AuditLog(d);
      await audit.init();
      registerAudit(r, d, audit);
    }
    if (o.oidc) registerOidc(r, d, o.oidc, audit);
    if (o.scimToken) registerScim(r, d, o.scimToken, audit);
  };
}

/** From environment variables: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_NAME, OIDC_DOMAINS, MFP_PUBLIC_URL, SCIM_TOKEN, MFP_AUDIT. */
export function enterpriseFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const oidc = env.OIDC_ISSUER && env.OIDC_CLIENT_ID
    ? {
        issuer: env.OIDC_ISSUER,
        clientId: env.OIDC_CLIENT_ID,
        clientSecret: env.OIDC_CLIENT_SECRET,
        name: env.OIDC_NAME,
        domains: env.OIDC_DOMAINS?.split(',').map((x) => x.trim()).filter(Boolean),
        publicUrl: env.MFP_PUBLIC_URL,
      }
    : undefined;
  if (!oidc && !env.SCIM_TOKEN && env.MFP_AUDIT !== '1') return undefined;
  return enterprise({ oidc, scimToken: env.SCIM_TOKEN, audit: env.MFP_AUDIT !== '0' });
}
