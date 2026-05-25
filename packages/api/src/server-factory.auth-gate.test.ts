import { Elysia } from 'elysia';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from './db/client.ts';
import { applySchema } from './db/schema.ts';
import { createTestApp } from './test-helpers/create-test-app.ts';
import type { ApiApp } from './apps/types.ts';

/**
 * Wire-contract test for the global auth gate's `ownsAuthFor` opt-out
 * (server-factory.ts: onBeforeHandle). An app may claim a route prefix and
 * take over authentication entirely; the gate must skip its default 401 for
 * those routes and trust the app's handler to enforce auth on its own.
 *
 * Three properties matter:
 *   1. A route the app claims passes through the gate even when the request
 *      carries no credentials (the app handler runs and decides).
 *   2. A route the app does NOT claim still gets the global 401 when
 *      unauthenticated, even if it's served by the same app.
 *   3. The app handler is free to issue its own 401 on a claimed route; the
 *      framework does not double-gate.
 */

const testApp: ApiApp = {
  id: 'gate-test',
  schema: '',
  ownsAuthFor: (_method, pathname) => pathname.startsWith('/api/gate-test/own/'),
  routes: () =>
    new Elysia({ prefix: '/api/gate-test' })
      .get('/own/public', () => ({ ok: true, gated: false }))
      .get('/own/private', ({ set }) => {
        set.status = 401;
        return { error: 'app-level: missing device signature' };
      })
      .get('/normal', () => ({ ok: true, gated: true })),
};

async function fetchJson(
  app: Awaited<ReturnType<typeof createTestApp>>,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`https://localhost:3000${path}`));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

describe('server-factory auth gate — ownsAuthFor opt-out', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('a claimed route bypasses the global 401 even when unauthenticated', async () => {
    const app = await createTestApp(db, { principalOverride: null, apps: [testApp] });
    const res = await fetchJson(app, '/api/gate-test/own/public');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gated: false });
  });

  test('a claimed route may still issue its own 401', async () => {
    const app = await createTestApp(db, { principalOverride: null, apps: [testApp] });
    const res = await fetchJson(app, '/api/gate-test/own/private');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'app-level: missing device signature' });
  });

  test('an unclaimed route on the same app still gets the global 401', async () => {
    const app = await createTestApp(db, { principalOverride: null, apps: [testApp] });
    const res = await fetchJson(app, '/api/gate-test/normal');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated' });
  });
});
