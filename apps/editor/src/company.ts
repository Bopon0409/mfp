// Company settings for the employee app: the mfp-company.json file next to the program (placed by
// the administrator at deployment, together with the installer or a policy):
//
//   { "server": "https://mfp.company.local", "network": "off" }
//
// server — the app works with the company server right away (no mode selection window, the mode doesn't change);
// network: "off" — internet is always off, even if the server is unavailable (closed network).

import { disk, isDesktop } from './platform.ts';

export const COMPANY_FILE = 'mfp-company.json';

export interface CompanyConfig {
  server?: string;
  network?: 'off';
}

/** File parsing: only known fields; server address — http(s) without a trailing “/”. */
export function parseCompanyConfig(text: string): CompanyConfig {
  const raw: unknown = JSON.parse(text);
  const out: CompanyConfig = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const { server, network } = raw as Record<string, unknown>;
  if (typeof server === 'string') {
    try {
      const url = new URL(server.trim());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) out.server = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
      // Invalid address — as if there is none.
    }
  }
  if (network === 'off') out.network = 'off';
  return out;
}

/** Company settings file next to the program; no file or not the app — null. */
export async function readCompanyConfig(): Promise<CompanyConfig | null> {
  if (!isDesktop) return null;
  try {
    const { join, resourceDir } = await import('@tauri-apps/api/path');
    const path = await join(await resourceDir(), COMPANY_FILE);
    if (!(await disk.stat(path))) return null;
    return parseCompanyConfig(new TextDecoder().decode(await disk.readFile(path)));
  } catch (e) {
    console.warn(`${COMPANY_FILE} не прочитан`, e);
    return null;
  }
}
