// Storage in an S3-compatible service (MinIO, Yandex Object Storage, AWS S3…): request signing
// with AWS Signature V4 is our own (node:crypto), no SDK. Keys are the same as in fsStore (files/<id>/doc.loro,
// images/<sha1>…); delete takes a key or a “folder” (everything with the prefix “key/”).

import { createHash, createHmac } from 'node:crypto';
import type { BlobStore } from './util.ts';

export interface S3Options {
  /** Service address: https://storage.yandexcloud.net, http://minio:9000 … */
  endpoint: string;
  bucket: string;
  region?: string;
  accessKey: string;
  secretKey: string;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986: everything except A-Z a-z 0-9 - _ . ~ (encodeURIComponent also leaves !'()*). */
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Authorization header per AWS Signature V4. Signs host and all passed headers
 * (x-amz-date must be among them).
 */
export function signV4(r: { method: string; url: URL; headers: Record<string, string>; payloadHash: string; accessKey: string; secretKey: string; region: string; service: string }): string {
  const amzDate = r.headers['x-amz-date']!;
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: r.url.host };
  for (const [k, v] of Object.entries(r.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const canonicalUri = r.url.pathname.split('/').map((s) => uriEncode(decodeURIComponent(s))).join('/') || '/';
  const query = [...r.url.searchParams].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonical = [r.method, canonicalUri, query.map(([k, v]) => `${k}=${v}`).join('&'), names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), r.payloadHash].join('\n');
  const scope = `${date}/${r.region}/${r.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${r.secretKey}`, date), r.region), r.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${r.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

export function s3Store(o: S3Options): BlobStore {
  const region = o.region ?? 'us-east-1';
  const base = o.endpoint.replace(/\/+$/, '');
  /** Request to the bucket (path-style address: endpoint/bucket/key, as MinIO uses by default). */
  const request = async (method: string, key: string, body?: Uint8Array, query: Record<string, string> = {}) => {
    const url = new URL(`${base}/${o.bucket}/${key.split('/').map(uriEncode).join('/')}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const payloadHash = sha256(body ?? '');
    const headers: Record<string, string> = { 'x-amz-date': new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), 'x-amz-content-sha256': payloadHash };
    headers.authorization = signV4({ method, url, headers, payloadHash, accessKey: o.accessKey, secretKey: o.secretKey, region, service: 's3' });
    return fetch(url, { method, headers, body: body as BodyInit | undefined, signal: AbortSignal.timeout(60_000) });
  };
  const fail = async (res: Response, what: string) => {
    throw new Error(`S3 ${what}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  };
  return {
    async get(key) {
      const res = await request('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, `GET ${key}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async put(key, bytes) {
      const res = await request('PUT', key, bytes);
      if (!res.ok) await fail(res, `PUT ${key}`);
    },
    async has(key) {
      const res = await request('HEAD', key);
      return res.ok;
    },
    async delete(key) {
      const res = await request('DELETE', key);
      if (!res.ok && res.status !== 404) await fail(res, `DELETE ${key}`);
      // “Folder”: everything with the prefix key/ (listed 1000 at a time).
      for (let token: string | null = null, guard = 0; guard < 100; guard++) {
        const q: Record<string, string> = { 'list-type': '2', prefix: `${key}/` };
        if (token) q['continuation-token'] = token;
        const list = await request('GET', '', undefined, q);
        if (!list.ok) await fail(list, 'LIST');
        const xml = await list.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          const k = m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
          const del = await request('DELETE', k);
          if (!del.ok && del.status !== 404) await fail(del, `DELETE ${k}`);
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null) : null;
        if (!token) break;
      }
    },
  };
}
