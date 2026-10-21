// Plugin network access per manifest.networkAccess: allowedDomains (and devAllowedDomains for
// in-development plugins) restrict fetch from plugin code and the plugin window's requests (CSP).
// Entries: "*" — everything, "none" — nothing, "example.com", "*.example.com", "https://example.com/api/".
// Without networkAccess — no restrictions (old plugins).

import type { PluginManifest } from './manifest.ts';

/** Allowed addresses; null — no restrictions. */
export function allowedDomains(m: PluginManifest): string[] | null {
  const na = m.networkAccess;
  if (!na || !Array.isArray(na.allowedDomains)) return null;
  const list = [...na.allowedDomains, ...(Array.isArray(na.devAllowedDomains) ? na.devAllowedDomains : [])].map((d) => String(d).trim()).filter(Boolean);
  if (list.includes('*')) return null;
  return list.filter((d) => d !== 'none');
}

interface Rule {
  schemes: string[] | null;
  host: string;
  wildcard: boolean;
  port: string | null;
  path: string;
}

function parseRule(entry: string): Rule | null {
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?(\/.*)?$/i.exec(entry);
  if (!m) return null;
  return { schemes: m[1] ? [m[1].toLowerCase()] : null, wildcard: !!m[2], host: m[3]!.toLowerCase(), port: m[4] ?? null, path: m[5] ?? '' };
}

/** Whether the plugin may access the address. data: and blob: are always allowed. */
export function urlAllowed(url: string, domains: string[] | null): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'wss:' && u.protocol !== 'ws:') return false;
  if (domains === null) return true;
  const scheme = u.protocol.slice(0, -1);
  const host = u.hostname.toLowerCase();
  for (const entry of domains) {
    const r = parseRule(entry);
    if (!r) continue;
    if (r.schemes ? !r.schemes.includes(scheme) : scheme !== 'https' && scheme !== 'http' && scheme !== 'wss' && scheme !== 'ws') continue;
    if (r.wildcard ? !host.endsWith(`.${r.host}`) : host !== r.host) continue;
    if (r.port && r.port !== '*' && r.port !== u.port) continue;
    if (r.path && !u.pathname.startsWith(r.path)) continue;
    return true;
  }
  return false;
}

/** CSP source for an entry: without a scheme — https and http (the plugin window has no scheme of its own). */
function cspSources(entry: string): string[] {
  const r = parseRule(entry);
  if (!r) return [];
  const host = `${r.wildcard ? '*.' : ''}${r.host}${r.port ? `:${r.port}` : ''}${r.path}`;
  return (r.schemes ?? ['https', 'http']).map((s) => `${s}://${host}`);
}

/** Plugin window CSP; null — no restrictions. */
export function uiCsp(domains: string[] | null): string | null {
  if (domains === null) return null;
  const src = [...new Set(domains.flatMap(cspSources))].join(' ');
  const net = `${src} data: blob:`.trim();
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${net}`,
    `style-src 'unsafe-inline' ${net}`,
    `img-src ${net}`,
    `font-src ${net}`,
    `media-src ${net}`,
    `connect-src ${src || "'none'"}`,
    `frame-src ${src || "'none'"}`,
    `worker-src ${net}`,
    "form-action 'none'",
  ].join('; ');
}
