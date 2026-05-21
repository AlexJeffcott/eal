import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createSessionsRepo } from './sessions.ts';
import { getPrincipal } from './principals.ts';

function reqWith(headers: Record<string, string> = {}): Request {
  return new Request('https://example.invalid/test', { headers });
}

describe('getPrincipal', () => {
  let db: DatabaseClient;
  let token: string;
  let userId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    userId = createUsersRepo(db).insert({ displayName: 'alex' }).id;
    const minted = createSessionsRepo(db).mint({ userId, ttlMs: 60_000 });
    token = minted.token;
  });

  test('missing Authorization header → null', () => {
    expect(getPrincipal(reqWith(), db)).toBeNull();
  });

  test('valid Bearer token → Principal', () => {
    const p = getPrincipal(reqWith({ authorization: `Bearer ${token}` }), db);
    expect(p?.userId).toBe(userId);
    expect(p?.displayName).toBe('alex');
  });

  test('Bearer with unknown token → null', () => {
    expect(getPrincipal(reqWith({ authorization: 'Bearer eal_v1_unknown' }), db)).toBeNull();
  });

  test('Bearer with expired token → null', () => {
    const shortLived = createSessionsRepo(db).mint({ userId, ttlMs: 1 }).token;
    const future = createSessionsRepo(db, { now: () => new Date(Date.now() + 60_000) });
    // Use the future-time verifier directly to assert expiry behaviour,
    // then confirm getPrincipal returns null through the real `now`.
    expect(future.verify(shortLived)).toBeNull();
    // For getPrincipal we cannot inject `now`, but a 1ms token expires immediately.
    expect(getPrincipal(reqWith({ authorization: `Bearer ${shortLived}` }), db)).toBeNull();
  });

  test('non-Bearer schemes → null', () => {
    expect(getPrincipal(reqWith({ authorization: 'Basic dXNlcjpwYXNz' }), db)).toBeNull();
    expect(getPrincipal(reqWith({ authorization: token }), db)).toBeNull();
  });

  test('empty Bearer token → null', () => {
    expect(getPrincipal(reqWith({ authorization: 'Bearer ' }), db)).toBeNull();
  });

  test('case-insensitive Bearer scheme', () => {
    expect(getPrincipal(reqWith({ authorization: `bearer ${token}` }), db)?.userId).toBe(userId);
    expect(getPrincipal(reqWith({ authorization: `BEARER ${token}` }), db)?.userId).toBe(userId);
  });
});
