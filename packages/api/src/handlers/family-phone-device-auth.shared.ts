import { randomBytes } from 'node:crypto';
import { formatSqliteDateTime, parseSqliteDateTime } from '../auth/datetime.ts';
import { sha256 } from '../auth/hash.ts';
import type { FamilyPhoneChallengesRepo } from '../db/repos/family-phone-challenges.ts';
import type { FamilyPhoneDeviceKeysRepo } from '../db/repos/family-phone-device-keys.ts';
import type { FamilyPhoneDeviceSessionsRepo } from '../db/repos/family-phone-device-sessions.ts';
import { AuthError } from './auth.shared.ts';

/**
 * 60 seconds — long enough for a real round-trip + sign, short enough that
 * a stolen nonce is useless almost immediately. Each nonce is single-use
 * regardless.
 */
export const CHALLENGE_TTL_MS = 60_000;
/**
 * 1 hour — the device's session token. The device renews by asking for a
 * fresh challenge and signing it. A stolen bearer token expires within
 * sixty minutes, much faster than the WebAuthn user sessions which are 30+
 * days.
 */
export const DEVICE_SESSION_TTL_MS = 60 * 60_000;

const NONCE_LENGTH_BYTES = 32;
const TOKEN_LENGTH_BYTES = 32;

export function defaultRandomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(NONCE_LENGTH_BYTES));
}

export function defaultRandomToken(): string {
  return randomBytes(TOKEN_LENGTH_BYTES).toString('base64url');
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    return Uint8Array.from(atob(padded + '='.repeat(padLen)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface FamilyPhoneDeviceAuthDeps {
  challenges: FamilyPhoneChallengesRepo;
  deviceKeys: FamilyPhoneDeviceKeysRepo;
  sessions: FamilyPhoneDeviceSessionsRepo;
  now: () => Date;
  randomNonce: () => Uint8Array;
  randomToken: () => string;
}

export interface ChallengeResult {
  nonce: string; // base64url
  expiresAt: string;
}

export interface AuthResult {
  deviceId: number;
  token: string;
  expiresAt: string;
}

/**
 * Issue a challenge for a device. The device must exist in
 * family_phone_device_keys (a paired device with a registered key). We do
 * not reveal whether a device_id exists by returning different errors —
 * unknown device_ids return the same 404 as un-paired ones.
 */
export function challengeCore(
  deps: FamilyPhoneDeviceAuthDeps,
  input: { deviceId: number },
): ChallengeResult {
  if (!Number.isInteger(input.deviceId) || input.deviceId <= 0) {
    throw new AuthError(400, 'device_id must be a positive integer');
  }
  const key = deps.deviceKeys.findByDeviceId(input.deviceId);
  if (!key) {
    throw new AuthError(404, 'device_id not found');
  }
  const nonce = deps.randomNonce();
  const current = deps.now();
  const expiresAt = formatSqliteDateTime(new Date(current.getTime() + CHALLENGE_TTL_MS));
  deps.challenges.insert({ deviceId: input.deviceId, nonce, expiresAt });
  return { nonce: encodeBase64Url(nonce), expiresAt };
}

/**
 * Verify a signature over a previously-issued nonce. On success, consumes
 * the nonce (single-shot) and mints a 1-hour device session whose hashed
 * token is stored server-side. The plaintext token is returned to the
 * device exactly once; the device sends it as a bearer for subsequent
 * requests until it expires, then re-runs the challenge/auth dance.
 */
export async function authCore(
  deps: FamilyPhoneDeviceAuthDeps,
  input: { deviceId: number; nonce: string; signature: string },
): Promise<AuthResult> {
  if (!Number.isInteger(input.deviceId) || input.deviceId <= 0) {
    throw new AuthError(400, 'device_id must be a positive integer');
  }
  const nonceBytes = decodeBase64Url(input.nonce);
  if (!nonceBytes) {
    throw new AuthError(400, 'nonce must be base64url-encoded');
  }
  const signatureBytes = decodeBase64Url(input.signature);
  if (!signatureBytes) {
    throw new AuthError(400, 'signature must be base64url-encoded');
  }

  const challenge = deps.challenges.findByNonce(nonceBytes);
  if (!challenge || challenge.device_id !== input.deviceId) {
    throw new AuthError(404, 'challenge not found for device');
  }
  if (challenge.consumed_at !== null) {
    throw new AuthError(409, 'challenge already consumed');
  }
  const current = deps.now();
  if (parseSqliteDateTime(challenge.expires_at).getTime() <= current.getTime()) {
    throw new AuthError(410, 'challenge expired');
  }

  const key = deps.deviceKeys.findByDeviceId(input.deviceId);
  if (!key) {
    throw new AuthError(404, 'device_id not found');
  }
  if (key.alg !== 'ES256') {
    // Only P-256 ECDSA is supported today. Future algs (Ed25519, ES384)
    // add a branch here; the device's stored alg drives the verification
    // parameters, never the request body.
    throw new AuthError(400, `unsupported signing algorithm '${key.alg}'`);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    new Uint8Array(key.public_key),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new Uint8Array(signatureBytes),
    new Uint8Array(nonceBytes),
  );
  if (!valid) {
    throw new AuthError(401, 'signature does not verify');
  }

  // Single-shot consume. If a racing /device/auth call won, this returns
  // false and we reject — the loser cannot mint a session against the
  // already-consumed nonce.
  const consumed = deps.challenges.markConsumed({
    nonce: nonceBytes,
    consumedAt: formatSqliteDateTime(current),
  });
  if (!consumed) {
    throw new AuthError(409, 'challenge already consumed');
  }

  const token = deps.randomToken();
  const expiresAt = formatSqliteDateTime(
    new Date(current.getTime() + DEVICE_SESSION_TTL_MS),
  );
  deps.sessions.insert({
    tokenHash: sha256(token),
    deviceId: input.deviceId,
    expiresAt,
  });

  return { deviceId: input.deviceId, token, expiresAt };
}
