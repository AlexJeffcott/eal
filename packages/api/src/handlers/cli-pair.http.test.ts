import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createSessionsRepo } from '../auth/sessions.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

interface StartBody {
  user_code: string;
  device_code: string;
  verification_url: string;
  poll_interval_ms: number;
  expires_at: string;
}

async function postJson<T>(app: Awaited<ReturnType<typeof createTestApp>>, path: string, body: unknown, token?: string): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await app.handle(new Request(`https://localhost:3000${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (undefined as unknown as T) };
}

describe('cli-pair HTTP routes', () => {
  let db: DatabaseClient;
  let alex: Principal;
  let token: string;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const user = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: user.id, displayName: user.display_name };
    // Real SPA-style session so the request-bound principal resolver works.
    token = createSessionsRepo(db).mint({ userId: alex.userId, ttlMs: 60_000, label: 'spa' }).token;
  });

  test('start → claim → poll → token verifies', async () => {
    const app = await createTestApp(db);

    const { status: startStatus, body: start } = await postJson<StartBody>(app, '/public/auth/cli-pair/start', {});
    expect(startStatus).toBe(200);
    expect(start.user_code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(start.device_code.length).toBeGreaterThan(20);
    expect(start.verification_url).toContain('/public/auth/cli-pair?code=');

    // Poll BEFORE claim → pending.
    const pending = await postJson<{ status: string }>(app, '/public/auth/cli-pair/poll', {
      device_code: start.device_code,
    });
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('pending');

    // Claim with the SPA bearer token.
    const claim = await postJson<{ ok: boolean }>(
      app,
      '/api/v1/auth/cli-pair/claim',
      { user_code: start.user_code, label: 'my-laptop' },
      token,
    );
    expect(claim.status).toBe(200);
    expect(claim.body.ok).toBe(true);

    // Poll AFTER claim → authorized + token.
    const ready = await postJson<{ status: string; token: string; user: { id: number; display_name: string } }>(
      app,
      '/public/auth/cli-pair/poll',
      { device_code: start.device_code },
    );
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('authorized');
    expect(ready.body.user.display_name).toBe('alex');

    // Token verifies as a session for this user with the chosen label.
    const sessions = createSessionsRepo(db);
    const session = sessions.verify(ready.body.token);
    expect(session?.user_id).toBe(alex.userId);
    expect(session?.label).toBe('my-laptop');

    // Second poll → expired (one-shot).
    const second = await postJson<{ status: string }>(app, '/public/auth/cli-pair/poll', {
      device_code: start.device_code,
    });
    expect(second.body.status).toBe('expired');
  });

  test('claim is rejected without a bearer token (401)', async () => {
    const app = await createTestApp(db);
    const { body: start } = await postJson<StartBody>(app, '/public/auth/cli-pair/start', {});
    const claim = await postJson<{ error: string }>(
      app,
      '/api/v1/auth/cli-pair/claim',
      { user_code: start.user_code, label: 'l' },
    );
    expect(claim.status).toBe(401);
  });

  test('claim of unknown user_code returns 404', async () => {
    const app = await createTestApp(db);
    const claim = await postJson<{ error: string }>(
      app,
      '/api/v1/auth/cli-pair/claim',
      { user_code: 'NOPE-0000', label: 'l' },
      token,
    );
    expect(claim.status).toBe(404);
  });

  test('double-claim returns 409', async () => {
    const app = await createTestApp(db);
    const { body: start } = await postJson<StartBody>(app, '/public/auth/cli-pair/start', {});
    await postJson(app, '/api/v1/auth/cli-pair/claim', { user_code: start.user_code, label: 'l' }, token);
    const second = await postJson<{ error: string }>(
      app,
      '/api/v1/auth/cli-pair/claim',
      { user_code: start.user_code, label: 'l2' },
      token,
    );
    expect(second.status).toBe(409);
  });

  test('verification_url uses the configured origin, not the request', async () => {
    // The URL carries a single-use pairing code, so its scheme is not
    // cosmetic. Deriving it from the request printed `http://eal.fly.dev/…`
    // in production, because the platform proxy terminates TLS and forwards
    // plain HTTP. The configured origin (EAL_ORIGIN, and the WebAuthn RP)
    // is the only value a proxy cannot rewrite.
    const app = await createTestApp(db);
    const res = await app.handle(new Request('http://eal.example.com:8443/public/auth/cli-pair/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'attacker.example' },
      body: '{}',
    }));
    const body = (await res.json()) as StartBody;
    expect(body.verification_url.startsWith('https://localhost:4321/public/auth/cli-pair?code=')).toBe(true);
  });
});
