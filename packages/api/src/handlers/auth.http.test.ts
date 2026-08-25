import { describe, expect, test, beforeEach } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';

function readErrorField(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  if (!('error' in parsed)) return undefined;
  const value: unknown = parsed.error;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Wire contract for the http auth endpoints. The web client's `extractServerError`
 * + `friendlySignInError` chain depends on three things being true of the
 * response when login verification fails server-side:
 *
 *   1. HTTP status is NOT 2xx (so postJson treats it as an error).
 *   2. The body parses as JSON.
 *   3. The body has a top-level `error` field with the raw failure string.
 *
 * The mappers in actions/registry.ts substring-match on that raw string. If any
 * of the three drifts (e.g. someone reshapes the envelope to `{ message: ... }`,
 * swaps to text/plain, or swallows the message), the UI silently loses every
 * friendly error and starts showing fallthrough text. These tests fail loudly
 * in that case.
 */

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

async function postJson(
  app: Awaited<ReturnType<typeof createTestApp>>,
  path: string,
  body: unknown,
): Promise<{ status: number; contentType: string | null; text: string }> {
  const response = await app.handle(
    new Request(`https://localhost:3000${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: await response.text(),
  };
}

describe('auth http error envelope (wire contract)', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('login/verify with an unknown credential returns 500 + {error} envelope', async () => {
    const app = await createTestApp(db);

    // 1. Start a login so the api stores a pending challenge — otherwise we
    //    hit the "no pending authentication challenge" branch instead of the
    //    "credential not found" branch we want to lock down.
    const optionsRes = await postJson(app, '/public/auth/login/options', {});
    expect(optionsRes.status).toBe(200);
    const optionsBody: { options: PublicKeyCredentialRequestOptionsJSON } = JSON.parse(optionsRes.text);
    const challenge = optionsBody.options.challenge;

    // 2. Submit a syntactically-valid AuthenticationResponseJSON whose
    //    credential id is NOT in the db. webauthn.ts:228 throws
    //    'webauthn: credential not found' — the http layer wraps it in 500.
    const verifyRes = await postJson(app, '/public/auth/login/verify', {
      response: {
        id: b64url('unknown-credential'),
        response: {
          clientDataJSON: b64url(
            JSON.stringify({
              type: 'webauthn.get',
              challenge,
              origin: 'https://localhost:3000',
            }),
          ),
          userHandle: b64url('anything'),
        },
      },
    });

    expect(verifyRes.status).toBe(500);
    expect(verifyRes.contentType ?? '').toContain('application/json');

    const err = readErrorField(JSON.parse(verifyRes.text));
    // Envelope shape: an object with a string `error` field. This is the
    // exact contract `extractServerError` and the friendly mappers depend on.
    expect(err).toBeDefined();
    // The exact substring the web mapper keys on.
    expect(err).toContain('credential not found');
  });

  test('login/verify before login/options returns the no-challenge error in the same envelope', async () => {
    const app = await createTestApp(db);
    // No prior /login/options call, so no pending challenge.
    const res = await postJson(app, '/public/auth/login/verify', {
      response: {
        id: b64url('whatever'),
        response: {
          clientDataJSON: b64url(
            JSON.stringify({
              type: 'webauthn.get',
              challenge: 'fabricated',
              origin: 'https://localhost:3000',
            }),
          ),
          userHandle: b64url('anything'),
        },
      },
    });
    expect(res.status).toBe(500);
    expect(res.contentType ?? '').toContain('application/json');
    const err = readErrorField(JSON.parse(res.text));
    expect(err).toBeDefined();
    // The other phrase the sign-in mapper keys on.
    expect(err).toContain('no pending authentication challenge');
  });
});

/**
 * The registration gate (packages/api/src/auth/registration.ts) at the wire.
 *
 * eal is deployed on a public origin, and `authorize()` grants every
 * signed-in principal every action on every task. Registration is therefore
 * the whole perimeter: these tests hold the door shut.
 */
describe('registration gate (wire contract)', () => {
  let db: DatabaseClient;
  const CODE = 'test-invite-code-0123456789';

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('with no invite code configured, register/options is 403 and says so', async () => {
    const app = await createTestApp(db, { env: {} });
    const res = await postJson(app, '/public/auth/register/options', { displayName: 'pat' });
    expect(res.status).toBe(403);
    expect(res.contentType ?? '').toContain('application/json');
    expect(readErrorField(JSON.parse(res.text))).toBe('registration is closed');
  });

  test('a wrong invite code is 403 with the phrase the web mapper keys on', async () => {
    const app = await createTestApp(db, { env: { EAL_INVITE_CODE: CODE } });
    const res = await postJson(app, '/public/auth/register/options', {
      displayName: 'pat',
      inviteCode: 'not-the-code-0123456789',
    });
    expect(res.status).toBe(403);
    expect(readErrorField(JSON.parse(res.text))).toBe('invalid invite code');
  });

  test('an omitted invite code is treated as a wrong one, not a 422', async () => {
    const app = await createTestApp(db, { env: { EAL_INVITE_CODE: CODE } });
    const res = await postJson(app, '/public/auth/register/options', { displayName: 'pat' });
    expect(res.status).toBe(403);
    expect(readErrorField(JSON.parse(res.text))).toBe('invalid invite code');
  });

  test('the gate runs before display-name validation — a probe learns nothing', async () => {
    const app = await createTestApp(db, { env: { EAL_INVITE_CODE: CODE } });
    const res = await postJson(app, '/public/auth/register/options', { displayName: '' });
    expect(res.status).toBe(403);
    expect(readErrorField(JSON.parse(res.text))).toBe('invalid invite code');
  });

  test('the right invite code opens the ceremony and issues a challenge', async () => {
    const app = await createTestApp(db, { env: { EAL_INVITE_CODE: CODE } });
    const res = await postJson(app, '/public/auth/register/options', {
      displayName: 'pat',
      inviteCode: CODE,
    });
    expect(res.status).toBe(200);
    const body: { options: { challenge: string } } = JSON.parse(res.text);
    expect(typeof body.options.challenge).toBe('string');
    expect(body.options.challenge.length).toBeGreaterThan(0);
  });

  test('a valid code still rejects an empty display name, with 400', async () => {
    const app = await createTestApp(db, { env: { EAL_INVITE_CODE: CODE } });
    const res = await postJson(app, '/public/auth/register/options', {
      displayName: '   ',
      inviteCode: CODE,
    });
    expect(res.status).toBe(400);
    expect(readErrorField(JSON.parse(res.text))).toBe('displayName is required');
  });

  test('ten wrong codes fill the window, and the eleventh attempt is 429', async () => {
    const app = await createTestApp(db, { env: { EAL_INVITE_CODE: CODE } });
    for (let i = 0; i < 10; i += 1) {
      const res = await postJson(app, '/public/auth/register/options', {
        displayName: 'pat',
        inviteCode: `wrong-${i}`,
      });
      expect(res.status).toBe(403);
    }
    const tripped = await postJson(app, '/public/auth/register/options', {
      displayName: 'pat',
      inviteCode: 'wrong-again',
    });
    expect(tripped.status).toBe(429);
    expect(readErrorField(JSON.parse(tripped.text)) ?? '').toContain(
      'too many registration attempts',
    );
    // And the real code is refused too while the window is full — the cap is
    // global on purpose, because a per-address cap is evaded behind a proxy.
    const withRealCode = await postJson(app, '/public/auth/register/options', {
      displayName: 'pat',
      inviteCode: CODE,
    });
    expect(withRealCode.status).toBe(429);
  });

  test('register/verify alone cannot mint a session — options holds the only challenge', async () => {
    const app = await createTestApp(db, { env: {} });
    const res = await postJson(app, '/public/auth/register/verify', {
      response: {
        id: b64url('fabricated'),
        response: {
          clientDataJSON: b64url(
            JSON.stringify({
              type: 'webauthn.create',
              challenge: 'fabricated',
              origin: 'https://localhost:3000',
            }),
          ),
        },
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain('"token"');
  });

  test('login is unaffected by the gate being closed', async () => {
    const app = await createTestApp(db, { env: {} });
    const res = await postJson(app, '/public/auth/login/options', {});
    expect(res.status).toBe(200);
  });
});
