import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createTcp } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { s3Store, signV4 } from '../src/s3.ts';
import { smtpMailer } from '../src/smtp.ts';
import { startServer } from '../src/server.ts';

describe('S3: AWS Signature V4 signing', () => {
  it('AWS reference (get-vanilla)', () => {
    const auth = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: { 'x-amz-date': '20150830T123600Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
    });
    expect(auth).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('S3 reference (GET Object with Range)', () => {
    const auth = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
    });
    expect(auth.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')).toBe(true);
  });

  it('storage: put, get, has, deleting a “folder” (S3 stub)', async () => {
    const objects = new Map<string, Buffer>();
    const seen: string[] = [];
    const fake = createHttp((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      if (!/^AWS4-HMAC-SHA256 Credential=minio\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(req.headers.authorization ?? '')) {
        res.writeHead(403).end();
        return;
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ''));
      const body: Buffer[] = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        if (req.method === 'PUT') objects.set(key, Buffer.concat(body));
        if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
          res.writeHead(200, { 'content-type': 'application/xml' }).end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
          return;
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          const v = objects.get(key);
          res.writeHead(v ? 200 : 404).end(req.method === 'GET' ? v : undefined);
          return;
        }
        if (req.method === 'DELETE') objects.delete(key);
        res.writeHead(req.method === 'DELETE' ? 204 : 200).end();
      });
    });
    await new Promise<void>((r) => fake.listen(0, r));
    try {
      const store = s3Store({ endpoint: `http://localhost:${(fake.address() as AddressInfo).port}`, bucket: 'bucket', accessKey: 'minio', secretKey: 'secret' });
      await store.put('files/A/doc.loro', new Uint8Array([1, 2, 3]));
      await store.put('files/A/attachments/x', new Uint8Array([4]));
      await store.put('files/B/doc.loro', new Uint8Array([5]));
      expect([...(await store.get('files/A/doc.loro'))!]).toEqual([1, 2, 3]);
      expect(await store.get('нет')).toBeNull();
      expect(await store.has('files/B/doc.loro')).toBe(true);
      await store.delete('files/A');
      expect([...objects.keys()]).toEqual(['files/B/doc.loro']);
      expect(seen).toContain('GET /bucket/?list-type=2&prefix=files%2FA%2F');
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });
});

describe('SMTP', () => {
  it('EHLO, AUTH PLAIN, UTF-8 email (server stub)', async () => {
    const log: string[] = [];
    let data = '';
    const fake = createTcp((sock) => {
      let inData = false;
      let buf = '';
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              sock.write('250 OK queued\r\n');
            } else data += `${line}\n`;
            continue;
          }
          log.push(line);
          if (line.startsWith('EHLO')) sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
          else if (line.startsWith('AUTH PLAIN')) sock.write('235 OK\r\n');
          else if (line === 'DATA') {
            inData = true;
            sock.write('354 go\r\n');
          } else if (line === 'QUIT') sock.end('221 bye\r\n');
          else sock.write('250 OK\r\n');
        }
      });
    });
    await new Promise<void>((r) => fake.listen(0, r));
    try {
      const mailer = smtpMailer({ host: 'localhost', port: (fake.address() as AddressInfo).port, user: 'bot@example.com', pass: 'пароль', from: 'MFP Почта <noreply@example.com>', noStarttls: true });
      await mailer.send({ to: 'anna@example.com', subject: 'MFP: код для входа 123456', text: 'Код для входа: 123456\nДействует 10 минут.' });
      expect(log).toEqual([
        expect.stringMatching(/^EHLO /),
        `AUTH PLAIN ${Buffer.from('\0bot@example.com\0пароль').toString('base64')}`,
        'MAIL FROM:<noreply@example.com>',
        'RCPT TO:<anna@example.com>',
        'DATA',
        'QUIT',
      ]);
      expect(data).toContain(`Subject: =?UTF-8?B?${Buffer.from('MFP: код для входа 123456').toString('base64')}?=`);
      expect(data).toContain(`From: =?UTF-8?B?${Buffer.from('MFP Почта').toString('base64')}?= <noreply@example.com>`);
      const body = data.split('\n\n')[1]!.replace(/\n/g, '');
      expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Код для входа: 123456\nДействует 10 минут.');
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });
});

describe('self-host: the editor from the same address', () => {
  it('files, index.html for other paths, no escaping the folder, /health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mfp-static-'));
    const web = join(dir, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>MFP</title>');
    writeFileSync(join(web, 'assets', 'main-abc.js'), 'console.log(1)');
    writeFileSync(join(dir, 'secret.txt'), 'нельзя');
    const server = await startServer({ port: 0, dir: join(dir, 'data'), pingMs: 60_000, staticDir: web });
    try {
      const base = `http://localhost:${server.port}`;
      const js = await fetch(`${base}/assets/main-abc.js`);
      expect([js.headers.get('content-type'), js.headers.get('cache-control'), await js.text()]).toEqual(['text/javascript; charset=utf-8', 'public, max-age=31536000, immutable', 'console.log(1)']);
      const page = await fetch(`${base}/projects/x`);
      expect([page.headers.get('content-type'), await page.text()]).toEqual(['text/html; charset=utf-8', '<!doctype html><title>MFP</title>']);
      expect(await (await fetch(`${base}/..%2Fsecret.txt`)).text()).not.toContain('нельзя');
      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, db: 'sqlite' });
      // The API is still the API.
      expect((await fetch(`${base}/api/me`)).status).toBe(401);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
