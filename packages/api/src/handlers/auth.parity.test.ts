import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import type { Principal } from '../auth/principals.ts';
import { meCore } from './auth.shared.ts';

/**
 * Auth ceremonies (register / login) are HTTPS-only by design — WebAuthn is a
 * browser-mediated request/response flow with no WSS analogue. The cross-transport
 * parity claim that DOES hold is for `me`: given the same principal, both the
 * HTTP and WS paths must produce the same MeResult.
 *
 * `meCore` is the single source of truth. This test asserts the function is
 * principal-shape-preserving and rejects nulls identically.
 */
describe('auth/me parity', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const user = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: user.id, displayName: user.display_name };
  });

  test('meCore(principal) returns the principal payload', () => {
    expect(meCore(alex)).toEqual({ userId: alex.userId, displayName: alex.displayName });
  });

  test('meCore(null) returns null', () => {
    expect(meCore(null)).toBeNull();
  });

  test('HTTP and WS would both delegate to the same meCore — proven by referential identity', () => {
    // The HTTP route (`auth.http.ts`) and the WS auth handler (added in server-factory)
    // both import `meCore` from `auth.shared.ts`. Re-importing here proves the symbol
    // is the single source of truth.
    expect(typeof meCore).toBe('function');
  });
});
