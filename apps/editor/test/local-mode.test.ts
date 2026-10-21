import { describe, expect, it } from 'vitest';
import { nearestWeight } from '@mfp/renderer';
import { parseCompanyConfig } from '../src/company.ts';

describe('bundled fonts', () => {
  it('nearest weight: exact, nearest, on a tie — the heavier one', () => {
    expect(nearestWeight([400, 500, 600, 700], 600)).toBe(600);
    expect(nearestWeight([400, 700], 300)).toBe(400);
    expect(nearestWeight([400, 700], 800)).toBe(700);
    expect(nearestWeight([400, 600], 500)).toBe(600);
    expect(nearestWeight([], 400)).toBeNull();
  });
});

describe('offline: what counts as an own address', () => {
  it('this page, this computer and team servers are own; everything else is the internet', async () => {
    (globalThis as { location?: unknown }).location ??= new URL('https://mfp.example/app/');
    const { isLocalUrl } = await import('../src/network.ts');
    const own = () => ['https://design.company.ru:8443'];
    expect(isLocalUrl('/fonts/inter@latest/latin-400-normal.ttf', own)).toBe(true);
    expect(isLocalUrl('http://localhost:5175/api/me', own)).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:11434/api/chat', own)).toBe(true);
    expect(isLocalUrl('http://ipc.localhost/plugin', own)).toBe(true);
    expect(isLocalUrl('blob:https://mfp.example/1', own)).toBe(true);
    expect(isLocalUrl('https://design.company.ru:8443/mcp', own)).toBe(true);
    expect(isLocalUrl('wss://design.company.ru:8443/file/1', own)).toBe(true);
    expect(isLocalUrl('https://design.company.ru/other', own)).toBe(false);
    expect(isLocalUrl('https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.ttf', own)).toBe(false);
    expect(isLocalUrl('https://api.anthropic.com/v1/messages', own)).toBe(false);
    // A local network isn't the internet: a colleague's computer with open access, a server in the office.
    expect(isLocalUrl('http://192.168.1.10:8686/api/auth/config', own)).toBe(true);
    expect(isLocalUrl('http://10.0.0.5/health', own)).toBe(true);
    expect(isLocalUrl('http://172.20.1.1/', own)).toBe(true);
    expect(isLocalUrl('http://mfp-office.local:8686/', own)).toBe(true);
    expect(isLocalUrl('http://172.32.0.1/', own)).toBe(false);
    expect(isLocalUrl('http://8.8.8.8/', own)).toBe(false);
  });
});

describe('company settings (mfp-company.json)', () => {
  it('takes only recognized fields', () => {
    expect(parseCompanyConfig('{"server":"https://mfp.corp.local/","network":"off","extra":1}')).toEqual({ server: 'https://mfp.corp.local', network: 'off' });
    expect(parseCompanyConfig('{"server":"ftp://x","network":"on"}')).toEqual({});
    expect(() => parseCompanyConfig('не json')).toThrow();
  });
});

describe('company settings: invalid values', () => {
  it('a non-object and an invalid address — as if the fields were absent', () => {
    expect(parseCompanyConfig('null')).toEqual({});
    expect(parseCompanyConfig('[1,2]')).toEqual({});
    expect(parseCompanyConfig('"https://x"')).toEqual({});
    expect(parseCompanyConfig('{"server":"https://"}')).toEqual({});
    expect(parseCompanyConfig('{"server":"javascript:alert(1)"}')).toEqual({});
    expect(parseCompanyConfig('{"server":"http://10.0.0.5:8686/mfp/"}')).toEqual({ server: 'http://10.0.0.5:8686/mfp' });
  });
});

describe('internet ban by the team server', () => {
  it('only the same server can lift the ban', async () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    (globalThis as { location?: unknown }).location ??= new URL('https://mfp.example/app/');
    const { network } = await import('../src/network.ts');
    network.set(true);
    expect(network.allowed).toBe(true);
    network.applyServerPolicy('off', 'https://corp.local');
    expect(network.locked).toBe(true);
    expect(network.allowed).toBe(false);
    // Another server (e.g. a colleague's office server) doesn't lift the restriction.
    network.applyServerPolicy('on', 'http://192.168.1.10:8686');
    expect(network.locked).toBe(true);
    network.applyServerPolicy('on', 'https://corp.local');
    expect(network.locked).toBe(false);
    expect(network.allowed).toBe(true);
  });
});
