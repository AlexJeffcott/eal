import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

async function get(
  app: Awaited<ReturnType<typeof createTestApp>>,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`https://localhost:4321${path}`));
  const text = await res.text();
  return { status: res.status, body: text.length === 0 ? null : JSON.parse(text) };
}

describe('users http wire contract', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const users = createUsersRepo(db);
    const a = users.insert({ displayName: 'alex' });
    users.insert({ displayName: 'elisa' });
    alex = { userId: a.id, displayName: a.display_name };
  });

  test('GET /api/v1/users returns the household roster as {id, displayName}', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await get(app, '/api/v1/users');
    expect(res.status).toBe(200);
    if (typeof res.body !== 'object' || res.body === null || !('users' in res.body)) {
      throw new Error('expected a {users} envelope');
    }
    const users = res.body.users;
    if (!Array.isArray(users)) throw new Error('users is not an array');
    expect(users.map((u: { displayName: string }) => u.displayName)).toEqual(['alex', 'elisa']);
    expect(users.every((u: { id: unknown }) => typeof u.id === 'number')).toBe(true);
  });

  test('GET /api/v1/users is 401 without a principal', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await get(app, '/api/v1/users');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });
});
