#!/usr/bin/env bun
/**
 * Verification artefact for stage 4 — due-date reminders.
 *
 * A green unit tier proves the scan's logic against a fake sender. It does not
 * prove that a deadline written over HTTP reaches a push vendor, because
 * everything between those two points is exactly what a unit test replaces: the
 * boot path that decides whether the scan starts at all, the VAPID identity, the
 * RFC 8291 encryption, and the TLS request web-push actually makes.
 *
 * So this script stands the whole path up:
 *
 *   1. A local HTTPS server impersonating a browser push vendor, holding a real
 *      P-256 keypair and auth secret of its own — the "browser" side of the
 *      subscription.
 *   2. A real api process, booted with a freshly generated VAPID keypair and
 *      the reminder scan running on a short cadence.
 *   3. That subscription filed over real HTTP through POST /api/v1/push/subscribe.
 *   4. A task created over real HTTP, due two seconds out.
 *
 * Then it asserts what the plan asks for:
 *
 *   - exactly one request reaches the vendor;
 *   - its body carries the task's title — which is only knowable by decrypting
 *     it with the subscription's private key, so the payload is proved to be
 *     both correctly encrypted and correctly addressed;
 *   - the next tick sends nothing, which is the `reminded_at` stamp doing the
 *     one job it exists for;
 *   - and, past the plan: a subscription the vendor calls gone is deleted, and
 *     moving a deadline re-arms it.
 *
 * The push body is aes128gcm (RFC 8188) over an ECDH shared secret (RFC 8291).
 * `decryptWebPush` below implements the reader's half with node:crypto and no
 * new dependency — see the comments there.
 *
 * Exits 0 on success, or 1 naming the first check that failed.
 */
import { Database } from 'bun:sqlite';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pollUntil } from '../packages/shared/src/timers.ts';
import { bootApi, type BootedApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
// The api serves a self-signed certificate in development, and so does the fake
// vendor below — it reuses the same pair, which every multi-tier script already
// requires on disk (`bun devctl ssl`).
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
const CERT = Bun.file(resolve(ROOT, 'packages/api/certs/cert.pem'));
const KEY = Bun.file(resolve(ROOT, 'packages/api/certs/key.pem'));

/** The scan's cadence for this run. Fast enough to watch several passes. */
const TICK_MS = 400;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * A VAPID keypair, in the base64url form web-push reads out of the environment:
 * the uncompressed P-256 point (65 bytes, leading 0x04) and the 32-byte private
 * scalar.
 *
 * Generated here rather than through `webpush.generateVAPIDKeys()` because
 * `web-push` is a dependency of packages/api and does not resolve from
 * `scripts/`. Adding it to the root just to mint two keys would put a
 * production dependency in the harness's path; six lines of node:crypto is the
 * smaller price, and this is the same curve and encoding the vendor requires.
 */
function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // getPrivateKey can come back shorter than 32 bytes when the scalar has
  // leading zeros; web-push decodes it as a fixed-width big-endian integer, so
  // it has to be left-padded rather than handed over short.
  const privateKey = Buffer.alloc(32);
  const raw = ecdh.getPrivateKey();
  raw.copy(privateKey, 32 - raw.length);
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(privateKey) };
}

/** Read a string field off an unknown JSON value, or null. No casts. */
function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!(key in value)) return null;
  const found = Reflect.get(value, key);
  return typeof found === 'string' ? found : null;
}

/**
 * Throws rather than calling `process.exit`, so the `finally` still runs and
 * both the spawned api and the vendor server are shut down. An exiting process
 * skips it, and an orphan keeps the tier's stdout pipe open — which is the "a
 * script leaving a handle open hangs the whole tier" failure, arriving only
 * when something has already gone wrong.
 */
class CheckFailed extends Error {}

function fail(message: string): never {
  throw new CheckFailed(message);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function b64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF with a one-byte counter, which is all RFC 8188 ever needs. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/** The receiving browser: an ECDH keypair and an auth secret, as the vendor mints. */
interface Subscriber {
  ecdh: ReturnType<typeof createECDH>;
  publicKey: Buffer;
  authSecret: Buffer;
}

function newSubscriber(): Subscriber {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, publicKey: ecdh.getPublicKey(), authSecret: randomBytes(16) };
}

/**
 * Decrypt one aes128gcm Web Push body — the browser's half of RFC 8291.
 *
 * The body is `salt(16) | rs(4) | idlen(1) | keyid(idlen) | ciphertext`, where
 * the key id is the sender's ephemeral P-256 public key. From that and the
 * subscription's own private key:
 *
 *   shared  = ECDH(receiver private, sender public)
 *   PRK_key = HMAC(auth secret, shared)
 *   IKM     = HMAC(PRK_key, "WebPush: info\0" | receiver public | sender public | 0x01)
 *   CEK     = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)
 *   nonce   = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)
 *
 * The plaintext ends with a padding delimiter (0x02 on the last record) and any
 * zero padding after it, which is stripped below. A single record is all
 * web-push ever emits for a payload this size.
 *
 * Doing this rather than trusting a header is the point: an AES-GCM tag that
 * verifies proves the payload was encrypted to *this* subscription's keys by a
 * sender holding the matching VAPID identity. Nothing weaker would.
 */
function decryptWebPush(body: Buffer, subscriber: Subscriber): string {
  if (body.length < 22) fail(`push body is ${body.length} bytes — too short to be aes128gcm`);
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublicKey = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);

  const shared = subscriber.ecdh.computeSecret(senderPublicKey);
  const prkKey = hmac(subscriber.authSecret, shared);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    subscriber.publicKey,
    senderPublicKey,
  ]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);

  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  return plain.subarray(0, Math.max(0, end - 1)).toString('utf8');
}

interface VendorRequest {
  path: string;
  ttl: string | null;
  contentEncoding: string | null;
  hasVapidAuthorization: boolean;
  body: Buffer;
}

interface FakeVendor {
  origin: string;
  received: VendorRequest[];
  /** Paths the vendor should answer 410 Gone to, as a dead subscription does. */
  gone: Set<string>;
  stop(): void;
}

/**
 * A local HTTPS server standing in for FCM / Mozilla autopush. HTTPS, not HTTP:
 * web-push dials the endpoint's scheme and refuses to speak plaintext, so an
 * http:// endpoint fails the TLS handshake rather than testing anything.
 */
function startFakeVendor(): FakeVendor {
  const received: VendorRequest[] = [];
  const gone = new Set<string>();
  const server = Bun.serve({
    port: 0,
    tls: { cert: CERT, key: KEY },
    async fetch(request) {
      const url = new URL(request.url);
      const body = Buffer.from(await request.arrayBuffer());
      if (gone.has(url.pathname)) {
        return new Response('subscription gone', { status: 410 });
      }
      received.push({
        path: url.pathname,
        ttl: request.headers.get('ttl'),
        contentEncoding: request.headers.get('content-encoding'),
        hasVapidAuthorization: (request.headers.get('authorization') ?? '').startsWith('vapid'),
        body,
      });
      // 201 Created is what a real vendor answers an accepted push with.
      return new Response('', { status: 201 });
    },
  });
  return {
    origin: `https://localhost:${server.port}`,
    received,
    gone,
    stop: () => server.stop(true),
  };
}

/**
 * Fail with the server's own words when a call did not succeed, and otherwise
 * hand the response back unread. Reading the body eagerly to build a failure
 * message consumes it, so an `ok` response would then have nothing left to
 * parse — which is a check that breaks the thing it was meant to describe.
 */
async function requireOk(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  let body = '<no body>';
  try {
    body = await res.text();
  } catch {
    // Nothing to add; the status is the message.
  }
  fail(`${what} answered ${res.status}: ${body}`);
}

interface TaskResponse {
  task: { id: number; title: string; dueAt: string | null };
}

/** Capture a task whose deadline has already passed by the time it is stored. */
async function createDueNow(
  apiUrl: string,
  headers: Record<string, string>,
  title: string,
): Promise<void> {
  await requireOk(
    await fetch(`${apiUrl}/api/v1/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, due_at: new Date().toISOString() }),
    }),
    `POST /api/v1/tasks (${title})`,
  );
}

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'eal-reminder-'));
  const dbPath = join(dir, 'reminders.db');
  let api: BootedApi | null = null;
  const vendor = startFakeVendor();

  try {
    const seeded = seedCliToken({ dbPath, displayName: 'reminder-e2e', ttlMs: 10 * 60_000 });
    const authed = {
      authorization: `Bearer ${seeded.token}`,
      'content-type': 'application/json',
    };

    // ── 1. A real VAPID identity, and a real api running the scan ─────────────
    const vapid = generateVapidKeys();
    api = await bootApi({
      database: dbPath,
      env: {
        EAL_VAPID_PUBLIC_KEY: vapid.publicKey,
        EAL_VAPID_PRIVATE_KEY: vapid.privateKey,
        EAL_VAPID_SUBJECT: 'mailto:eal@example.com',
        EAL_REMINDER_TICK_MS: String(TICK_MS),
      },
    });
    console.log('e2e-task-reminder: api booted with a VAPID keypair and the scan running');

    // The public key the SPA would fetch to bind a subscription. If this 503s,
    // the keys never reached the process and everything below would pass for
    // the wrong reason.
    const keyRes = await requireOk(
      await fetch(`${api.url}/public/push/vapid-public-key`),
      'GET /public/push/vapid-public-key',
    );
    const keyBody: unknown = await keyRes.json();
    check(
      readString(keyBody, 'publicKey') === vapid.publicKey,
      'the api served a different VAPID public key than it was configured with',
    );

    // ── 2. A subscription, filed the way the browser files it ─────────────────
    const subscriber = newSubscriber();
    const endpointPath = `/push/${b64url(randomBytes(12))}`;
    const endpoint = `${vendor.origin}${endpointPath}`;
    await requireOk(
      await fetch(`${api.url}/api/v1/push/subscribe`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({
          endpoint,
          p256dh: b64url(subscriber.publicKey),
          auth: b64url(subscriber.authSecret),
        }),
      }),
      'POST /api/v1/push/subscribe',
    );
    console.log('e2e-task-reminder: a browser subscription is on file for the signed-in person');

    // ── 3. A task due in two seconds ──────────────────────────────────────────
    const title = `Take the bins out ${Date.now()}`;
    const dueAt = new Date(Date.now() + 2_000).toISOString();
    const created = await requireOk(
      await fetch(`${api.url}/api/v1/tasks`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ title, due_at: dueAt }),
      }),
      'POST /api/v1/tasks',
    );
    const task: TaskResponse = await created.json();
    console.log(`e2e-task-reminder: task ${task.task.id} is due at ${dueAt}`);

    // Nothing yet: a deadline two seconds out must not fire on the pass that
    // happens before it. Without this the "exactly one" check below could pass
    // on a scan that ignored `due_at` entirely and pushed everything.
    check(
      vendor.received.length === 0,
      `the vendor was called ${vendor.received.length} time(s) before the deadline passed`,
    );

    // ── 4. Exactly one request, carrying the title ────────────────────────────
    await pollUntil(() => vendor.received.length > 0, {
      intervalMs: 100,
      timeoutMs: 15_000,
      label: 'the push vendor to be called',
    });
    const first = vendor.received[0];
    if (first === undefined) fail('the vendor recorded a call with no request');

    check(
      first.path === endpointPath,
      `the push went to ${first.path}, not the subscription's endpoint ${endpointPath}`,
    );
    check(
      first.contentEncoding === 'aes128gcm',
      `the push body is encoded ${String(first.contentEncoding)}, expected aes128gcm`,
    );
    check(
      first.hasVapidAuthorization,
      'the push carried no VAPID Authorization header — the vendor would reject it',
    );
    check(first.ttl === '3600', `the push TTL is ${String(first.ttl)}, expected 3600`);

    const plaintext = decryptWebPush(first.body, subscriber);
    const payload: unknown = JSON.parse(plaintext);
    check(
      readString(payload, 'title') === title,
      `the push body carries title ${JSON.stringify(readString(payload, 'title'))}, ` +
        `expected ${JSON.stringify(title)} — decrypted body was ${plaintext}`,
    );
    check(
      readString(payload, 'kind') === 'task' &&
        readString(payload, 'url') === '/tasks' &&
        readString(payload, 'body') === 'Due now',
      `the push body is not the shape the service worker parses: ${plaintext}`,
    );
    check(
      readString(payload, 'tag') === `task:${task.task.id}`,
      `the push tag is ${JSON.stringify(readString(payload, 'tag'))}, expected task:${task.task.id}`,
    );
    console.log(
      'e2e-task-reminder: exactly one push arrived, encrypted to the subscription and carrying the title',
    );

    // ── 5. The next ticks send nothing ────────────────────────────────────────
    //
    // Proved by a signal, not by sleeping. Two further tasks, each due at once,
    // are created and waited for: every push that arrives is evidence that
    // another scan has run, and the first deadline — still in the past, still
    // unfinished — must not appear in any of them. A fixed sleep here would
    // prove less and flake more, which is why `delay` is not what this uses.
    const secondTitle = `Water the plants ${Date.now()}`;
    await createDueNow(api.url, authed, secondTitle);
    await pollUntil(() => vendor.received.length >= 2, {
      intervalMs: 50,
      timeoutMs: 15_000,
      label: 'a second push, for the second task',
    });

    const thirdTitle = `Post the letter ${Date.now()}`;
    await createDueNow(api.url, authed, thirdTitle);
    await pollUntil(() => vendor.received.length >= 3, {
      intervalMs: 50,
      timeoutMs: 15_000,
      label: 'a third push, for the third task',
    });

    const titlesSoFar = vendor.received.map((r) => readString(JSON.parse(decryptWebPush(r.body, subscriber)), 'title'));
    check(
      vendor.received.length === 3,
      `the vendor was called ${vendor.received.length} times for 3 deadlines. Titles: ` +
        `${JSON.stringify(titlesSoFar)} — the reminded_at stamp is not holding, so every ` +
        'tick re-sends a deadline that has already been announced',
    );
    check(
      titlesSoFar.filter((t) => t === title).length === 1,
      `the first deadline was announced ${titlesSoFar.filter((t) => t === title).length} times ` +
        `across ${vendor.received.length} pushes: ${JSON.stringify(titlesSoFar)}`,
    );
    check(
      titlesSoFar.includes(secondTitle) && titlesSoFar.includes(thirdTitle),
      `the later deadlines did not both arrive: ${JSON.stringify(titlesSoFar)}`,
    );
    console.log(
      'e2e-task-reminder: two further scans ran and neither re-sent the first deadline — the stamp is idempotent',
    );

    // The stamp is on the row, and it is the only thing that changed.
    const afterSend = new Database(dbPath, { readonly: true });
    interface StampRow { reminded_at: string | null; due_at: string | null }
    const stamped = afterSend
      .prepare<StampRow, [number]>('SELECT reminded_at, due_at FROM tasks WHERE id = ?')
      .get(task.task.id);
    afterSend.close();
    check(
      stamped !== null && stamped.reminded_at !== null,
      'the task was pushed but reminded_at was never stamped — the next restart would push it again',
    );

    // ── 6. Moving the deadline re-arms it ─────────────────────────────────────
    const before = vendor.received.length;
    await requireOk(
      await fetch(`${api.url}/api/v1/tasks/${task.task.id}`, {
        method: 'PATCH',
        headers: authed,
        body: JSON.stringify({ due_at: new Date().toISOString() }),
      }),
      'PATCH due_at',
    );
    await pollUntil(() => vendor.received.length > before, {
      intervalMs: 50,
      timeoutMs: 15_000,
      label: 'a fresh push after the deadline moved',
    });
    const afterMove = vendor.received
      .slice(before)
      .map((r) => readString(JSON.parse(decryptWebPush(r.body, subscriber)), 'title'));
    check(
      afterMove.length === 1 && afterMove[0] === title,
      `moving the deadline produced ${JSON.stringify(afterMove)}, expected exactly one push for ` +
        JSON.stringify(title),
    );
    console.log('e2e-task-reminder: moving the deadline re-armed the reminder, once');

    // ── 7. A subscription the vendor calls gone is deleted ────────────────────
    vendor.gone.add(endpointPath);
    await createDueNow(api.url, authed, `Nobody home ${Date.now()}`);
    await pollUntil(
      () => {
        const db = new Database(dbPath, { readonly: true });
        interface CountRow { n: number }
        const row = db
          .prepare<CountRow, []>('SELECT COUNT(*) AS n FROM push_subscriptions')
          .get();
        db.close();
        return row !== null && row.n === 0;
      },
      {
        intervalMs: 100,
        timeoutMs: 15_000,
        label: 'the dead subscription to be dropped after a 410',
      },
    );
    console.log('e2e-task-reminder: a 410 from the vendor deleted the subscription rather than retrying it');

    console.log('e2e-task-reminder: OK');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`e2e-task-reminder: FAIL — ${message}`);
    return 1;
  } finally {
    if (api !== null) await api.kill();
    vendor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

process.exit(await main());
