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

interface StartEnvelope {
  user_code: string;
  expires_at: string;
}

function isStartEnvelope(value: unknown): value is StartEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('user_code' in value && 'expires_at' in value)) return false;
  return typeof value.user_code === 'string' && typeof value.expires_at === 'string';
}

interface CompleteEnvelope {
  device_id: number;
}

function isCompleteEnvelope(value: unknown): value is CompleteEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('device_id' in value)) return false;
  return typeof value.device_id === 'number';
}

function fakePublicKey(): string {
  // 33 bytes — the shape of a P-256 compressed point. The pair-complete
  // handler stores whatever it gets and the wire layer only checks
  // length > 0; real key validation arrives with the challenge/response
  // signature checks in Phase D.
  const bytes = new Uint8Array(33);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i + 1;
  return Buffer.from(bytes).toString('base64url');
}

describe('family-phone pair — start (authenticated)', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
  });

  test('POST /api/family-phone/pair/start: returns a user_code envelope', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await postJson(app, '/api/family-phone/pair/start', {});
    expect(res.status).toBe(200);
    expect(isStartEnvelope(res.body)).toBe(true);
    if (!isStartEnvelope(res.body)) throw new Error('unreachable');
    expect(res.body.user_code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
  });

  test('POST /api/family-phone/pair/start: 401 when unauthenticated', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/pair/start', {});
    expect(res.status).toBe(401);
  });
});

describe('family-phone pair — complete (app-authenticated)', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
  });

  async function mintCode(): Promise<string> {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await postJson(app, '/api/family-phone/pair/start', {});
    if (!isStartEnvelope(res.body)) throw new Error('start did not return user_code');
    return res.body.user_code;
  }

  const COMPLETE_BASE = { label: "Alex's PWA", kind: 'pwa' as const };

  test('happy path: complete consumes code, returns device_id, persists key', async () => {
    const code = await mintCode();
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/pair/complete', {
      user_code: code,
      public_key: fakePublicKey(),
      alg: 'ES256', ...COMPLETE_BASE,
    });
    expect(res.status).toBe(200);
    expect(isCompleteEnvelope(res.body)).toBe(true);
    if (!isCompleteEnvelope(res.body)) throw new Error('unreachable');

    interface DeviceRow {
      id: number;
      user_id: number;
      paired_at: string | null;
    }
    const device = db
      .prepare<DeviceRow, [number]>(
        'SELECT id, user_id, paired_at FROM family_phone_devices WHERE id = ?',
      )
      .get(res.body.device_id);
    expect(device).not.toBeNull();
    expect(device?.user_id).toBe(alex.userId);
    expect(device?.paired_at).not.toBeNull();

    interface KeyRow { device_id: number; alg: string }
    const key = db
      .prepare<KeyRow, [number]>(
        'SELECT device_id, alg FROM family_phone_device_keys WHERE device_id = ?',
      )
      .get(res.body.device_id);
    expect(key?.alg).toBe('ES256');
  });

  test('the complete route bypasses the global user-principal gate', async () => {
    // If the gate ran, this would 401 before reaching the handler. The
    // request is anonymous yet the handler runs and returns its own 404 for
    // the missing code — proving the ownsAuthFor opt-out is in effect.
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/pair/complete', {
      user_code: 'XXX-XXX',
      public_key: fakePublicKey(),
      alg: 'ES256', ...COMPLETE_BASE,
    });
    expect(res.status).toBe(404);
  });

  test('double consume of the same code is rejected', async () => {
    const code = await mintCode();
    const app = await createTestApp(db, { principalOverride: null });
    const first = await postJson(app, '/api/family-phone/pair/complete', {
      user_code: code,
      public_key: fakePublicKey(),
      alg: 'ES256', ...COMPLETE_BASE,
    });
    expect(first.status).toBe(200);
    const second = await postJson(app, '/api/family-phone/pair/complete', {
      user_code: code,
      public_key: fakePublicKey(),
      alg: 'ES256', ...COMPLETE_BASE,
    });
    expect(second.status).toBe(409);
  });

  test('expired code is rejected with 410', async () => {
    const code = await mintCode();
    // Force the pair row's expiry into the past — simulates 60s elapsed.
    db.prepare(
      "UPDATE family_phone_pair_requests SET expires_at = datetime('now', '-1 minute') WHERE user_code = ?",
    ).run(code);
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/pair/complete', {
      user_code: code,
      public_key: fakePublicKey(),
      alg: 'ES256', ...COMPLETE_BASE,
    });
    expect(res.status).toBe(410);
  });

  test('malformed user_code is rejected with 400', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/pair/complete', {
      user_code: 'nope',
      public_key: fakePublicKey(),
      alg: 'ES256', ...COMPLETE_BASE,
    });
    expect(res.status).toBe(400);
  });

  test('empty public_key is rejected with 400', async () => {
    const code = await mintCode();
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/pair/complete', {
      user_code: code,
      public_key: '',
      alg: 'ES256', ...COMPLETE_BASE,
    });
    expect(res.status).toBe(400);
  });

  test('tolerant code parsing: dash, lowercase, ambiguous chars folded', async () => {
    const code = await mintCode();
    // Strip the dash and lowercase — normaliseUserCode should accept this.
    const munged = code.replace('-', '').toLowerCase();
    const app = await createTestApp(db, { principalOverride: null });
    const res = await postJson(app, '/api/family-phone/pair/complete', {
      user_code: munged,
      public_key: fakePublicKey(),
      alg: 'ES256', ...COMPLETE_BASE,
    });
    expect(res.status).toBe(200);
  });
});
