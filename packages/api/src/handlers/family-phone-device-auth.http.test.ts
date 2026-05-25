import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

interface ApiResponse {
  status: number;
  body: unknown;
}

async function postJson(
  app: Awaited<ReturnType<typeof createTestApp>>,
  path: string,
  body: unknown,
): Promise<ApiResponse> {
  const res = await app.handle(
    new Request(`https://localhost:3000${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const decoded = atob(padded + '='.repeat(padLen));
  // Allocate a fresh ArrayBuffer (not ArrayBufferLike) so the result is
  // accepted by crypto.subtle's BufferSource parameters.
  const out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}

interface ChallengeEnvelope { nonce: string; expires_at: string }
interface AuthEnvelope { device_id: number; token: string; expires_at: string }
interface PairEnvelope { device_id: number }

function isChallenge(value: unknown): value is ChallengeEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('nonce' in value && 'expires_at' in value)) return false;
  return typeof value.nonce === 'string' && typeof value.expires_at === 'string';
}
function isAuth(value: unknown): value is AuthEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('device_id' in value && 'token' in value && 'expires_at' in value)) return false;
  return typeof value.device_id === 'number' && typeof value.token === 'string';
}
function isPair(value: unknown): value is PairEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('device_id' in value)) return false;
  return typeof value.device_id === 'number';
}

async function pairDeviceWithKey(
  db: DatabaseClient,
  principal: Principal,
): Promise<{ deviceId: number; privateKey: CryptoKey; publicKeySpki: Uint8Array }> {
  // 1. Trusted device calls /pair/start as the authenticated user.
  const trusted = await createTestApp(db, { principalOverride: principal });
  const startRes = await postJson(trusted, '/api/family-phone/pair/start', {
    label: "Alex's PWA",
    kind: 'pwa',
  });
  if (
    typeof startRes.body !== 'object' ||
    startRes.body === null ||
    !('user_code' in startRes.body) ||
    typeof startRes.body.user_code !== 'string'
  ) {
    throw new Error('start did not return user_code');
  }
  const userCode: string = startRes.body.user_code;

  // 2. New device generates a keypair and submits the public key.
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));

  const newDevice = await createTestApp(db, { principalOverride: null });
  const completeRes = await postJson(newDevice, '/api/family-phone/pair/complete', {
    user_code: userCode,
    public_key: toBase64Url(spki),
    alg: 'ES256',
  });
  if (!isPair(completeRes.body)) throw new Error('pair complete did not return device_id');

  return { deviceId: completeRes.body.device_id, privateKey: kp.privateKey, publicKeySpki: spki };
}

describe('family-phone device auth — challenge', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
  });

  test('the challenge route bypasses the global gate (404 not 401)', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/device/challenge', { device_id: 9999 });
    // Reaches the handler, which reports the missing device as 404. If
    // ownsAuthFor were wrong, the global gate would have returned 401 first.
    expect(res.status).toBe(404);
  });

  test('returns a base64url nonce for a paired device', async () => {
    const { deviceId } = await pairDeviceWithKey(db, alex);
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/device/challenge', { device_id: deviceId });
    expect(res.status).toBe(200);
    expect(isChallenge(res.body)).toBe(true);
    if (!isChallenge(res.body)) throw new Error('unreachable');
    expect(res.body.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(res.body.nonce).length).toBe(32);
  });
});

describe('family-phone device auth — sign challenge and authenticate', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
  });

  async function freshChallenge(deviceId: number): Promise<string> {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/device/challenge', { device_id: deviceId });
    if (!isChallenge(res.body)) throw new Error('no challenge');
    return res.body.nonce;
  }

  async function sign(privateKey: CryptoKey, nonceB64: string): Promise<string> {
    const nonce = fromBase64Url(nonceB64);
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      nonce,
    );
    return toBase64Url(new Uint8Array(sig));
  }

  test('happy path: paired device signs the nonce, receives a session token', async () => {
    const { deviceId, privateKey } = await pairDeviceWithKey(db, alex);
    const nonce = await freshChallenge(deviceId);
    const signature = await sign(privateKey, nonce);

    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/device/auth', {
      device_id: deviceId,
      nonce,
      signature,
    });
    expect(res.status).toBe(200);
    expect(isAuth(res.body)).toBe(true);
    if (!isAuth(res.body)) throw new Error('unreachable');
    expect(res.body.token.length).toBeGreaterThan(0);
    expect(res.body.device_id).toBe(deviceId);
  });

  test('replaying a consumed challenge is rejected', async () => {
    const { deviceId, privateKey } = await pairDeviceWithKey(db, alex);
    const nonce = await freshChallenge(deviceId);
    const signature = await sign(privateKey, nonce);
    const app = await createTestApp(db, { principalOverride: null });

    const first = await postJson(app, '/api/family-phone/device/auth', {
      device_id: deviceId,
      nonce,
      signature,
    });
    expect(first.status).toBe(200);

    const replay = await postJson(app, '/api/family-phone/device/auth', {
      device_id: deviceId,
      nonce,
      signature,
    });
    expect(replay.status).toBe(409);
  });

  test('signature from a different keypair is rejected', async () => {
    const { deviceId } = await pairDeviceWithKey(db, alex);
    const nonce = await freshChallenge(deviceId);

    // A fresh, unrelated keypair signing the same nonce.
    const attackerKp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const badSig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      attackerKp.privateKey,
      fromBase64Url(nonce),
    );

    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/device/auth', {
      device_id: deviceId,
      nonce,
      signature: toBase64Url(new Uint8Array(badSig)),
    });
    expect(res.status).toBe(401);
  });

  test('expired challenge is rejected with 410', async () => {
    const { deviceId, privateKey } = await pairDeviceWithKey(db, alex);
    const nonce = await freshChallenge(deviceId);
    const signature = await sign(privateKey, nonce);

    db.prepare(
      "UPDATE family_phone_challenges SET expires_at = datetime('now', '-1 minute') WHERE nonce = ?",
    ).run(fromBase64Url(nonce));

    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/device/auth', {
      device_id: deviceId,
      nonce,
      signature,
    });
    expect(res.status).toBe(410);
  });

  test('challenge bound to one device cannot be used to auth another', async () => {
    const { deviceId: deviceA, privateKey: keyA } = await pairDeviceWithKey(db, alex);
    const { deviceId: deviceB } = await pairDeviceWithKey(db, alex);
    const nonce = await freshChallenge(deviceA);
    const signature = await sign(keyA, nonce);

    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/device/auth', {
      device_id: deviceB,
      nonce,
      signature,
    });
    expect(res.status).toBe(404);
  });

  test('malformed signature is rejected with 400', async () => {
    const { deviceId } = await pairDeviceWithKey(db, alex);
    const nonce = await freshChallenge(deviceId);
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/device/auth', {
      device_id: deviceId,
      nonce,
      signature: 'this is not base64url ===',
    });
    expect(res.status).toBe(400);
  });
});
