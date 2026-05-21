import { describe, expect, test, beforeEach } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';

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
