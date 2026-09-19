#!/usr/bin/env bun
/**
 * Verification artefact for Phase 7E's webhook boundary — `docs/family-phone.md`.
 *
 * Twilio signs the URL it was configured with. The api must rebuild that same
 * URL to check `X-Twilio-Signature`, and it builds it from `EAL_ORIGIN` plus
 * the request's own path and query — never from the request's `Host` header
 * (`packages/api/src/handlers/family-phone-twilio.http.ts:97`). A reverse
 * proxy that rewrites `Host`, which is what Fly and a Tailscale Funnel both
 * do, therefore cannot break the signature.
 *
 * `OPEN_TASKS.md` recorded that as the one 7E failure the mocks could not
 * catch, knowable only from a real inbound call. It is knowable from here.
 *
 * Two modes, one command each.
 *
 * LOCAL — no arguments, and this is what `bun devctl test multi` runs. Boots
 * the real api from the real entry point with the trunk on, and sets
 * `EAL_ORIGIN` to a public name that is *not* the address the api binds. That
 * gap is the production shape: the container listens on a private port and
 * the world reaches it under another name. Six checks:
 *
 *   1. A signature over the public URL is accepted although the request
 *      arrives on a different host and port, and the TwiML that comes back
 *      names the public host in its callback URLs — not the bind address.
 *      A deployment that got this wrong would answer the first call and then
 *      strand every IVR callback on an unroutable URL.
 *   2. The same request carrying no call fields answers 400. The signature
 *      verified and the handler returned before the rate limiter and the
 *      IVR, so nothing is written. This is the shape the live mode uses, and
 *      it is proved here first.
 *   3. A signature computed over the address actually dialled is refused.
 *      This is the falsifier: rewrite `publicUrl` to read the request's own
 *      host and check 3 turns green while check 1 stays green.
 *   4. No signature header at all is refused.
 *   5. A signature made with a different auth token is refused.
 *   6. The query string is signed material — signing without it and sending
 *      it is refused, and signing with it is accepted.
 *
 * LIVE — `--target https://eal.fly.dev`, with `TWILIO_AUTH_TOKEN` in the
 * environment. Runs checks 2 and 4 against the deployment. It sends no
 * `CallSid`, `From` or `To`, so the handler returns 400 before it touches the
 * database: the probe leaves no row behind. Three statuses are distinguished
 * by name — 400 the signature verified, 403 it did not, 404 the trunk is not
 * mounted.
 *
 * Skips: a real Twilio account, a real call, and the media WebSocket.
 * `scripts/e2e-pstn-inbound.ts` owns the audio path against a mocked Twilio.
 * This script owns the signature boundary.
 */
import { bootApi, type BootedApi } from './lib/boot-api.ts';
import { computeTwilioSignature } from '../packages/api/src/twilio/signature.ts';

const VOICE_PATH = '/api/family-phone/twilio/voice';

/**
 * The public name the local api answers to. Deliberately neither the host nor
 * the port it binds — the difference between the two is this script's whole
 * subject. `.invalid` is reserved by RFC 2606, so nothing here can resolve.
 */
const PUBLIC_ORIGIN = 'https://eal-pstn-live.invalid';

const LOCAL_ACCOUNT_SID = 'AC00000000000000000000000000000002';
const LOCAL_AUTH_TOKEN = 'e2e-pstn-live-auth-token';
const LOCAL_PHONE_NUMBER = '+441234567890';
const CALLER = '+12025550111';
const CALL_SID = 'CA00000000000000000000000000000002';

/**
 * The field set that answers 400. Twilio always sends `CallSid`, `From` and
 * `To`; withholding all three reaches the field check at
 * `family-phone-twilio.http.ts:136` immediately after the signature verifies,
 * which is the last point before any write.
 */
const PROBE_FIELDS: Record<string, string> = { Probe: 'e2e-pstn-live' };

const MISSING_FIELDS_BODY = 'missing required Twilio voice fields';

interface Probe {
  status: number;
  body: string;
}

/**
 * POST a form-encoded webhook. `signOver` is the URL the signature is computed
 * against, which is not always the URL dialled — that divergence is the point.
 * Passing `signOver: null` omits the header entirely.
 *
 * The `Host` header is left alone: the request naturally arrives bearing the
 * bind address, which is already the mismatch under test, and `fetch` refuses
 * to let a caller set `Host` by hand.
 */
async function post(opts: {
  dial: string;
  signOver: string | null;
  authToken: string;
  fields: Record<string, string>;
}): Promise<Probe> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.signOver !== null) {
    headers['x-twilio-signature'] = computeTwilioSignature(
      opts.authToken,
      opts.signOver,
      opts.fields,
    );
  }
  const res = await fetch(opts.dial, {
    method: 'POST',
    headers,
    body: new URLSearchParams(opts.fields).toString(),
  });
  return { status: res.status, body: await res.text() };
}

function assertStatus(probe: Probe, expected: number, what: string): void {
  if (probe.status !== expected) {
    throw new Error(
      `${what}: expected ${expected}, got ${probe.status} — ${probe.body.slice(0, 200)}`,
    );
  }
}

function assertContains(haystack: string, needle: string, what: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${what}: expected the body to contain ${JSON.stringify(needle)}`);
  }
}

function assertOmits(haystack: string, needle: string, what: string): void {
  if (haystack.includes(needle)) {
    throw new Error(`${what}: the body must not contain ${JSON.stringify(needle)}`);
  }
}

function parseTarget(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--target=')) return arg.slice('--target='.length);
    if (arg === '--target') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('--target needs a URL, for example --target https://eal.fly.dev');
      }
      return next;
    }
  }
  return null;
}

// ─── Local mode ────────────────────────────────────────────────────────────

async function runLocal(): Promise<void> {
  let api: BootedApi | null = null;
  try {
    api = await bootApi({
      env: {
        // Plain HTTP, exactly as the Fly container runs: the platform proxy
        // terminates TLS and speaks HTTP inwards (`fly.toml` SKIP_TLS=1).
        SKIP_TLS: '1',
        TWILIO_ENABLED: 'true',
        TWILIO_ACCOUNT_SID: LOCAL_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: LOCAL_AUTH_TOKEN,
        TWILIO_PHONE_NUMBER: LOCAL_PHONE_NUMBER,
        // The whole point: boot-api would otherwise pin EAL_ORIGIN to the
        // bind address, and every signature would match for the wrong reason.
        EAL_ORIGIN: PUBLIC_ORIGIN,
      },
    });
    const bindHost = new URL(api.url).host;
    const publicHost = new URL(PUBLIC_ORIGIN).host;
    console.log(`e2e-pstn-live: api bound at ${bindHost}, public name ${publicHost}`);

    const dialled = `${api.url}${VOICE_PATH}`;
    const publicUrl = `${PUBLIC_ORIGIN}${VOICE_PATH}`;

    // ─── 1. The signed public URL is accepted, and the TwiML points home ───
    const callFields: Record<string, string> = {
      CallSid: CALL_SID,
      From: CALLER,
      To: LOCAL_PHONE_NUMBER,
      AccountSid: LOCAL_ACCOUNT_SID,
    };
    const accepted = await post({
      dial: dialled,
      signOver: publicUrl,
      authToken: LOCAL_AUTH_TOKEN,
      fields: callFields,
    });
    assertStatus(accepted, 200, 'signed over the public URL');
    assertContains(accepted.body, '<Response', 'signed over the public URL: TwiML root');
    assertContains(accepted.body, `https://${publicHost}/`, 'TwiML callback host');
    assertOmits(accepted.body, bindHost, 'TwiML callback host');
    console.log(
      'e2e-pstn-live: 1. a signature over the public URL is accepted on another host (200),',
      'and the TwiML calls back to the public host',
    );

    // ─── 2. The no-fields probe: verified, and nothing written ─────────────
    const probe = await post({
      dial: dialled,
      signOver: publicUrl,
      authToken: LOCAL_AUTH_TOKEN,
      fields: PROBE_FIELDS,
    });
    assertStatus(probe, 400, 'probe without call fields');
    assertContains(probe.body, MISSING_FIELDS_BODY, 'probe without call fields');
    console.log(
      'e2e-pstn-live: 2. the same signature with no call fields reaches the field check (400)',
    );

    // ─── 3. Signing the dialled address is refused — the falsifier ─────────
    // `publicUrl()` forces the https scheme, so the naive reconstruction this
    // guards against would be `https://<bind host>` even over plain HTTP.
    const naive = await post({
      dial: dialled,
      signOver: `https://${bindHost}${VOICE_PATH}`,
      authToken: LOCAL_AUTH_TOKEN,
      fields: callFields,
    });
    assertStatus(naive, 403, 'signed over the dialled address');
    console.log(
      'e2e-pstn-live: 3. a signature over the dialled address is refused (403)',
      '— the api does not read the Host header',
    );

    // ─── 4. No signature at all ────────────────────────────────────────────
    const unsigned = await post({
      dial: dialled,
      signOver: null,
      authToken: LOCAL_AUTH_TOKEN,
      fields: callFields,
    });
    assertStatus(unsigned, 403, 'no signature header');
    console.log('e2e-pstn-live: 4. an unsigned request is refused (403)');

    // ─── 5. A signature under the wrong token ──────────────────────────────
    const wrongToken = await post({
      dial: dialled,
      signOver: publicUrl,
      authToken: `${LOCAL_AUTH_TOKEN}-rotated`,
      fields: callFields,
    });
    assertStatus(wrongToken, 403, 'signature under a different auth token');
    console.log('e2e-pstn-live: 5. a signature under a different auth token is refused (403)');

    // ─── 6. The query string is signed material ────────────────────────────
    // Twilio's configured URL may carry one — the handler reads `direction`
    // and `handset` from it — so it has to be inside the hash on both sides.
    const query = '?direction=outbound&handset=1';
    const withQuery = await post({
      dial: `${dialled}${query}`,
      signOver: `${publicUrl}${query}`,
      authToken: LOCAL_AUTH_TOKEN,
      fields: PROBE_FIELDS,
    });
    assertStatus(withQuery, 400, 'query signed and sent');
    assertContains(withQuery.body, MISSING_FIELDS_BODY, 'query signed and sent');

    const queryDropped = await post({
      dial: `${dialled}${query}`,
      signOver: publicUrl,
      authToken: LOCAL_AUTH_TOKEN,
      fields: PROBE_FIELDS,
    });
    assertStatus(queryDropped, 403, 'query sent but not signed');
    console.log(
      'e2e-pstn-live: 6. the query string is signed material — signed and sent (400),',
      'sent unsigned (403)',
    );
  } finally {
    await api?.kill();
  }
}

// ─── Live mode ─────────────────────────────────────────────────────────────

async function runLive(target: string): Promise<void> {
  const authToken = process.env['TWILIO_AUTH_TOKEN'];
  if (authToken === undefined || authToken === '') {
    throw new Error(
      '--target needs TWILIO_AUTH_TOKEN in the environment: it is the key the deployment ' +
        'verifies X-Twilio-Signature with, so this script cannot produce a valid signature ' +
        'without it. Read it from the Twilio console, or from .env.',
    );
  }
  const origin = new URL(target).origin;
  const url = `${origin}${VOICE_PATH}`;
  console.log(`e2e-pstn-live: probing ${url}`);

  // The signed probe. No CallSid/From/To, so a verified signature stops at the
  // field check and the deployment's database is untouched.
  const probe = await post({
    dial: url,
    signOver: url,
    authToken,
    fields: PROBE_FIELDS,
  });

  if (probe.status === 404) {
    throw new Error(
      `${url} answered 404. The trunk is not mounted: the deployment needs ` +
        'TWILIO_ENABLED="true" in fly.toml [env] and the three TWILIO_* secrets set, ' +
        'then a redeploy.',
    );
  }
  if (probe.status === 403) {
    throw new Error(
      `${url} answered 403 to a correctly signed probe. Either EAL_ORIGIN on the ` +
        `deployment is not exactly ${origin} — it is the string the api rebuilds the ` +
        'signed URL from — or TWILIO_AUTH_TOKEN here differs from the deployed secret.',
    );
  }
  assertStatus(probe, 400, 'signed probe against the deployment');
  assertContains(probe.body, MISSING_FIELDS_BODY, 'signed probe against the deployment');
  console.log(
    `e2e-pstn-live: the deployment verified a signature over ${origin} and reached the`,
    'field check (400) — the proxy does not break X-Twilio-Signature',
  );

  const unsigned = await post({ dial: url, signOver: null, authToken, fields: PROBE_FIELDS });
  assertStatus(unsigned, 403, 'unsigned probe against the deployment');
  console.log('e2e-pstn-live: the deployment refuses an unsigned webhook (403)');
}

async function main(): Promise<number> {
  try {
    const target = parseTarget(process.argv.slice(2));
    if (target === null) {
      await runLocal();
    } else {
      await runLive(target);
    }
    console.log('e2e-pstn-live: OK');
    return 0;
  } catch (err) {
    console.error('e2e-pstn-live: FAIL', err);
    return 1;
  }
}

process.exit(await main());
