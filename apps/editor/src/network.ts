// Working mode and internet access.
//
// Mode (desktop app): “On this computer” — no account, files on disk, no internet by default;
// “With a team server” — sign in to a server. In the browser the mode is always server.
//
// Internet access off — not a single request outside this computer and team servers: fetch and
// WebSocket to other addresses are rejected with a clear error (AI, Magnific, font catalog,
// updates). Fonts come from the bundle (FontLibrary.useBundled).
//
// A team server in a closed network (MFP_NETWORK=off) forbids the internet for its editors: the ban
// is remembered and stays in effect until the same server lifts it — the toggle in Settings is
// unavailable. The same applies to an employee app with mfp-company.json ("network": "off",
// company.ts): always.

import { isDesktop } from './platform.ts';

export type AppMode = 'local' | 'server';

const MODE_KEY = 'mfp.mode';
const NET_KEY = 'mfp.network';
const POLICY_KEY = 'mfp.network.policy';
const UPDATES_KEY = 'mfp.updates';

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // No storage — until restart.
  }
};

export const appMode = {
  /** Whether a mode is chosen (on the app's first launch — not yet). */
  get chosen(): boolean {
    return !isDesktop || read(MODE_KEY) === 'local' || read(MODE_KEY) === 'server';
  },
  get value(): AppMode {
    return isDesktop && read(MODE_KEY) !== 'server' ? 'local' : 'server';
  },
  get local(): boolean {
    return this.value === 'local';
  },
  set(mode: AppMode) {
    write(MODE_KEY, mode);
  },
};

export const network = {
  onChange: [] as (() => void)[],
  /** Internet turned off by company settings (mfp-company.json next to the program). */
  lockedByCompany: false,
  /** Internet forbidden by the team server or the company (closed network): cannot be toggled. */
  get locked(): boolean {
    return this.lockedByCompany || !!read(POLICY_KEY);
  },
  /** Whether the internet is allowed: server ban, then the user's choice; by default — no for the app in “On this computer” mode. */
  get allowed(): boolean {
    if (this.locked) return false;
    const v = read(NET_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
    return !(isDesktop && appMode.local);
  },
  set(on: boolean) {
    write(NET_KEY, on ? 'on' : 'off');
    this.changed();
  },
  /**
   * Team server policy (GET /api/auth/config → network). The ban is remembered together with the
   * address of the server that imposed it: only the same server can lift it (not a colleague's
   * office server or any other one on the network).
   */
  applyServerPolicy(net: 'on' | 'off', server: string) {
    const was = this.allowed;
    const current = read(POLICY_KEY);
    if (net === 'off') write(POLICY_KEY, server);
    else if (current && (current === server || current === 'off')) write(POLICY_KEY, null);
    if (was !== this.allowed) this.changed();
  },
  changed() {
    for (const cb of [...this.onChange]) cb();
  },
};

/**
 * Update check (desktop app): separate from internet access — even without it, the app asks the
 * MFP releases page on GitHub once at launch for the new version number (no user data).
 * On by default; always off in an organization's closed network.
 */
export const updatesCheck = {
  get on(): boolean {
    return !network.locked && read(UPDATES_KEY) !== 'off';
  },
  set(on: boolean) {
    write(UPDATES_KEY, on ? null : 'off');
  },
};

export const OFFLINE_MESSAGE = 'Нет доступа в интернет: он выключен в Настройках («Доступ в интернет»)';
const LOCKED_MESSAGE = 'Нет доступа в интернет: он запрещён в вашей организации (закрытая сеть)';
/** Why the request was not sent: turned off in Settings or forbidden by the server. */
export const offlineMessage = () => (network.locked ? LOCKED_MESSAGE : OFFLINE_MESSAGE);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The address is this computer, the page itself or a team server (own — server addresses). */
export function isLocalUrl(raw: string | URL, own: () => string[] = () => []): boolean {
  let u: URL;
  try {
    u = new URL(String(raw), location.href);
  } catch {
    return true;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return true; // data:, blob:, tauri:, ipc: etc.
  if (u.origin === location.origin) return true;
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return true;
  // A local network (office, home) is not the internet: private addresses and .local names.
  if (privateHost(host)) return true;
  return own().some((base) => {
    try {
      const b = new URL(base);
      return b.hostname.toLowerCase() === host && (b.port || defaultPort(b.protocol)) === (u.port || defaultPort(u.protocol));
    } catch {
      return false;
    }
  });
}

/** Local network address: 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10, a .local name. */
export function privateHost(host: string): boolean {
  if (host.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = host.replace(/^\[|\]$/g, '');
  return /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(v6);
}

const defaultPort = (protocol: string) => (protocol === 'https:' || protocol === 'wss:' ? '443' : '80');

/** Team servers and addresses the user entered as a server themselves — reachable even without internet. */
export const trustedServers: string[] = [];

/** Allow a server address (entered manually in the “Team server” dialog). */
export function trustServer(url: string) {
  const clean = url.trim().replace(/\/+$/, '');
  if (clean && !trustedServers.includes(clean)) trustedServers.push(clean);
}

/** Block requests to the internet while it is off (this page's fetch and WebSocket). */
export function installNetworkGuard(own: () => string[]) {
  const fetch0 = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input;
    if (!network.allowed && !isLocalUrl(url, own)) return Promise.reject(new TypeError(offlineMessage()));
    return fetch0(input, init);
  };
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (!network.allowed && !isLocalUrl(url, own)) throw new TypeError(offlineMessage());
      super(url, protocols);
    }
  } as typeof WebSocket;
}
