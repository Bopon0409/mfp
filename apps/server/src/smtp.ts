// Mail over SMTP (sign-in codes, invitations, mentions): our own client on node:net / node:tls —
// EHLO, STARTTLS (if the server supports it), AUTH PLAIN or LOGIN, the message in UTF-8 (subject — RFC 2047,
// body — base64). Port 465 — TLS right away, 587 and 25 — STARTTLS.

import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Mail, Mailer } from './util.ts';

export interface SmtpOptions {
  host: string;
  port?: number;
  /** TLS right away (port 465). */
  secure?: boolean;
  user?: string;
  pass?: string;
  /** Sender: “MFP <noreply@example.com>” or just an address. */
  from: string;
  /** Do not switch to TLS (local testing only). */
  noStarttls?: boolean;
  /** Verify the certificate (yes by default). */
  rejectUnauthorized?: boolean;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const addr = (s: string) => /<([^>]+)>/.exec(s)?.[1] ?? s.trim();
/** A header with non-ASCII — as an RFC 2047 encoded word. */
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const fromHeader = (s: string) => {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s);
  return m && m[1] ? `${word(m[1].replace(/^"|"$/g, ''))} <${m[2]}>` : s;
};

/** Server replies line by line: a multi-line reply (250-…) is collected up to the last line (250 …). */
class Reader {
  private buf = '';
  private waiting: ((r: { code: number; text: string }) => void) | null = null;
  private lines: string[] = [];
  private failed: Error | null = null;
  attach(sock: Socket | TLSSocket) {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const text = this.lines.map((l) => l.slice(4)).join('\n');
          const code = Number(line.slice(0, 3));
          this.lines = [];
          const w = this.waiting;
          this.waiting = null;
          w?.({ code, text });
        }
      }
    });
    sock.on('error', (e) => (this.failed = e));
  }
  next(): Promise<{ code: number; text: string }> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('SMTP: сервер не отвечает')), 30_000);
      this.waiting = (r) => {
        clearTimeout(t);
        resolve(r);
      };
    });
  }
}

export function smtpMailer(o: SmtpOptions): Mailer {
  const port = o.port ?? (o.secure ? 465 : 587);
  const secure = o.secure ?? port === 465;
  const tlsOpts = { servername: o.host, rejectUnauthorized: o.rejectUnauthorized ?? true };
  return {
    async send(mail: Mail) {
      let sock: Socket | TLSSocket = secure ? tlsConnect({ host: o.host, port, ...tlsOpts }) : netConnect({ host: o.host, port });
      let reader = new Reader();
      reader.attach(sock);
      const expect = async (ok: number[], what: string) => {
        const r = await reader.next();
        if (!ok.includes(r.code)) throw new Error(`SMTP ${what}: ${r.code} ${r.text}`);
        return r;
      };
      const cmd = async (line: string, ok: number[], what = line.split(' ')[0]!) => {
        sock.write(`${line}\r\n`);
        return expect(ok, what);
      };
      try {
        await expect([220], 'приветствие');
        const me = hostname() || 'localhost';
        let ehlo = await cmd(`EHLO ${me}`, [250]);
        if (!secure && !o.noStarttls && /^STARTTLS$/im.test(ehlo.text)) {
          await cmd('STARTTLS', [220]);
          const plain = sock as Socket;
          sock = tlsConnect({ socket: plain, ...tlsOpts });
          await new Promise<void>((resolve, reject) => {
            (sock as TLSSocket).once('secureConnect', () => resolve());
            sock.once('error', reject);
          });
          reader = new Reader();
          reader.attach(sock);
          ehlo = await cmd(`EHLO ${me}`, [250]);
        }
        if (o.user) {
          if (/^AUTH\b.*\bPLAIN\b/im.test(ehlo.text)) await cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass ?? ''}`, 'utf8').toString('base64')}`, [235], 'AUTH');
          else {
            await cmd('AUTH LOGIN', [334], 'AUTH');
            await cmd(b64(o.user), [334], 'AUTH');
            await cmd(b64(o.pass ?? ''), [235], 'AUTH');
          }
        }
        await cmd(`MAIL FROM:<${addr(o.from)}>`, [250], 'MAIL FROM');
        await cmd(`RCPT TO:<${addr(mail.to)}>`, [250, 251], 'RCPT TO');
        await cmd('DATA', [354]);
        const body = b64(mail.text).replace(/.{1,76}/g, '$&\r\n');
        const message = [
          `From: ${fromHeader(o.from)}`,
          `To: ${mail.to}`,
          `Subject: ${word(mail.subject)}`,
          `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
          `Message-ID: <${randomUUID()}@${addr(o.from).split('@')[1] ?? me}>`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: base64',
          '',
          body,
        ].join('\r\n');
        // A dot at the start of a line is doubled (base64 has none, but headers — just in case).
        sock.write(`${message.replace(/^\./gm, '..')}\r\n.\r\n`);
        await expect([250], 'письмо');
        await cmd('QUIT', [221, 250]).catch(() => {});
      } finally {
        sock.destroy();
      }
    },
  };
}
