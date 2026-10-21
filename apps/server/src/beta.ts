/** Explicit opt-in: a closed group, with one predetermined administrator. */
export interface BetaOptions {
  auth?: 'password';
  emails: string[];
  owner: string;
}

export function betaFromEnv(env: Record<string, string | undefined>): BetaOptions | undefined {
  if (env.MFP_BETA !== '1') return undefined;
  const password = env.MFP_AUTH === 'password';
  const owner = (env.MFP_BETA_OWNER ?? '').trim().toLowerCase();
  const emails = [...new Set((env.MFP_BETA_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!owner || (!password && !emails.includes(owner)) || emails.some(s => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) {
    throw new Error('Beta: set MFP_BETA_OWNER and include it in MFP_BETA_EMAILS (comma-separated email addresses)');
  }
  if (!password && (!env.SMTP_HOST || !env.SMTP_FROM)) throw new Error('Beta: SMTP_HOST and SMTP_FROM are required');
  const url = new URL(env.MFP_APP_URL ?? 'http://localhost');
  if (url.protocol !== 'https:') throw new Error('Beta: MFP_APP_URL must use HTTPS');
  if (env.OIDC_ISSUER || env.SCIM_TOKEN) throw new Error('Beta: use email login; OIDC/SCIM are not supported in this profile');
  return { owner, emails, ...(password ? { auth: 'password' as const } : {}) };
}
