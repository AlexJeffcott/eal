#!/usr/bin/env bun
/**
 * Verification artefact for the registration gate — Plan 01,
 * `docs/plans/01-close-registration.md`.
 *
 * eal is deployed on a public origin, and `authorize()` grants every signed-in
 * principal every action on every task. Registration is therefore the whole
 * perimeter. The unit tier proves the gate's logic; this script proves the
 * deployed shape: a real server process, booted from the real entry point,
 * answering over real HTTPS.
 *
 * Four checks, in the order a stranger would meet them:
 *   1. No `EAL_INVITE_CODE` in the environment → 403 "registration is closed".
 *   2. A code configured, none presented      → 403 "invalid invite code".
 *   3. A code configured, wrong one presented → 403 "invalid invite code".
 *   4. The right code                         → 200 with a WebAuthn challenge.
 *
 * It does not complete a passkey ceremony — `scripts/e2e-passkey-multi.ts` and
 * the Playwright tier already drive the real authenticator. This script owns
 * the door, not what is behind it.
 */
import { bootApi, E2E_INVITE_CODE, type BootedApi } from './lib/boot-api.ts';

// The api serves a self-signed certificate in development.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

interface RegisterAttempt {
  status: number;
  error: string | null;
  challenge: string | null;
}

async function attemptRegistration(
  apiUrl: string,
  body: Record<string, string>,
): Promise<RegisterAttempt> {
  const res = await fetch(`${apiUrl}/public/auth/register/options`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let error: string | null = null;
  let challenge: string | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      if ('error' in parsed && typeof parsed.error === 'string') error = parsed.error;
      if ('options' in parsed && typeof parsed.options === 'object' && parsed.options !== null) {
        const options: Record<string, unknown> = { ...parsed.options };
        if (typeof options['challenge'] === 'string') challenge = options['challenge'];
      }
    }
  } catch {
    error = `non-JSON body: ${text.slice(0, 120)}`;
  }
  return { status: res.status, error, challenge };
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<number> {
  let closed: BootedApi | null = null;
  let open: BootedApi | null = null;
  try {
    // ─── 1. No code configured: the door is shut ────────────────────────────
    // bootApi sets E2E_INVITE_CODE by default, so this override is the whole
    // point of the check — it reproduces a deployment that forgot the secret.
    closed = await bootApi({ env: { EAL_INVITE_CODE: '' } });
    const shut = await attemptRegistration(closed.url, { displayName: 'stranger' });
    assertEqual(shut.status, 403, 'unconfigured instance: status');
    assertEqual(shut.error, 'registration is closed', 'unconfigured instance: error');
    console.log('e2e-registration-closed: an unconfigured instance refuses registration (403)');
    await closed.kill();
    closed = null;

    // ─── 2-4. Code configured ───────────────────────────────────────────────
    open = await bootApi();

    const omitted = await attemptRegistration(open.url, { displayName: 'stranger' });
    assertEqual(omitted.status, 403, 'no code presented: status');
    assertEqual(omitted.error, 'invalid invite code', 'no code presented: error');
    console.log('e2e-registration-closed: an omitted code is refused (403)');

    const wrong = await attemptRegistration(open.url, {
      displayName: 'stranger',
      inviteCode: `${E2E_INVITE_CODE}-not-quite`,
    });
    assertEqual(wrong.status, 403, 'wrong code: status');
    assertEqual(wrong.error, 'invalid invite code', 'wrong code: error');
    console.log('e2e-registration-closed: a wrong code is refused (403)');

    const right = await attemptRegistration(open.url, {
      displayName: 'invited',
      inviteCode: E2E_INVITE_CODE,
    });
    assertEqual(right.status, 200, 'right code: status');
    if (right.challenge === null || right.challenge.length === 0) {
      throw new Error('right code: expected a WebAuthn challenge in the response');
    }
    console.log('e2e-registration-closed: the right code opens the ceremony (200, challenge issued)');

    console.log('e2e-registration-closed: OK');
    return 0;
  } catch (err) {
    console.error('e2e-registration-closed: FAIL', err);
    return 1;
  } finally {
    await closed?.kill();
    await open?.kill();
  }
}

process.exit(await main());
