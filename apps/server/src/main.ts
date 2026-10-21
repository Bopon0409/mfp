// MFP server startup: npm run dev:server (port 5175) or Docker (docs/self-host.md).
//
// Environment variables:
// - PORT — port (5175); MFP_DATA — data folder (rooms): SQLite mfp.db, documents, images, rooms;
// - DATABASE_URL=postgres://… — PostgreSQL instead of SQLite;
// - S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION — documents and images in S3 / MinIO;
// - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE — mail (otherwise emails go to
//   the console and <folder>/outbox.jsonl);
// - MFP_APP_URL — editor address used in email links; MFP_STATIC — folder of the built editor
//   (self-host: the editor is served from the same address as the server);
// - MFP_WEBHOOKS_PRIVATE=1 — webhooks to addresses on the internal network (local testing);
// - Enterprise (ee/): OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_NAME, OIDC_DOMAINS,
//   MFP_PUBLIC_URL, SCIM_TOKEN, MFP_AUDIT=1.

import { enterpriseFromEnv } from '../../../ee/index.ts';
import { openPostgres } from './postgres.ts';
import { s3Store } from './s3.ts';
import { startServer } from './server.ts';
import { smtpMailer } from './smtp.ts';
import { betaFromEnv } from './beta.ts';

const env = process.env;
const beta = betaFromEnv(env);
const server = await startServer({
  beta,
  port: Number(env.PORT ?? 5175),
  host: env.HOST || undefined,
  dir: env.MFP_DATA ?? env.MFP_ROOMS ?? 'rooms',
  appUrl: env.MFP_APP_URL,
  staticDir: env.MFP_STATIC,
  db: env.DATABASE_URL ? await openPostgres(env.DATABASE_URL) : undefined,
  store: env.S3_ENDPOINT && env.S3_BUCKET ? s3Store({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, region: env.S3_REGION, accessKey: env.S3_ACCESS_KEY ?? '', secretKey: env.S3_SECRET_KEY ?? '' }) : undefined,
  mailer: env.SMTP_HOST
    ? smtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined, secure: env.SMTP_SECURE ? env.SMTP_SECURE === '1' : undefined, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM ?? `MFP <noreply@${env.SMTP_HOST}>` })
    : undefined,
  // Webhooks to internal network addresses — only when explicitly allowed (local testing).
  hooks: { allowPrivate: env.MFP_WEBHOOKS_PRIVATE === '1' },
  enterprise: enterpriseFromEnv(env),
  // Voice between participants: STUN / TURN (JSON as RTCIceServer[]); without them — local network only.
  iceServers: env.MFP_ICE_SERVERS ? (JSON.parse(env.MFP_ICE_SERVERS) as unknown[]) : undefined,
  // Closed network: this server's editors do not go online (AI, font catalog, updates).
  network: env.MFP_NETWORK === 'off' ? 'off' : 'on',
  // Login-and-password sign-in without the beta: a company server without mail or SSO.
  auth: env.MFP_AUTH === 'password' ? 'password' : 'email',
});
const parts = [env.DATABASE_URL ? 'PostgreSQL' : 'SQLite', env.S3_ENDPOINT ? 'S3' : 'диск', env.SMTP_HOST ? 'SMTP' : 'почта в журнал', env.MFP_STATIC ? 'редактор отсюда же' : null, env.MFP_NETWORK === 'off' ? 'без интернета' : null].filter(Boolean);
console.log(`MFP: сервер http://localhost:${server.port} (${parts.join(', ')}) — API /api/…, /v1/…, MCP /mcp, файлы ws://…/file/<id>, комнаты ws://…/room/<имя>`);
if (server.setupCode) console.log(`MFP: первая настройка — откройте редактор, «Войти» и введите код ${server.setupCode}: он создаёт первого администратора (код действует до перезапуска сервера).`);

// An error in an async handler must not crash the server (Node terminates the process by default).
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка', e));

// Shutdown (Ctrl+C, docker stop): first flush unsaved rooms and files.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0), error => {
    console.error('Shutdown failed: unsaved documents may remain in memory', error);
    process.exit(1);
  }));
}
