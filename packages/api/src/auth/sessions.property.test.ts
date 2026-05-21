import { beforeEach, describe, test } from 'bun:test';
import fc from 'fast-check';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createSessionsRepo, mintTokenPlaintext } from './sessions.ts';

function seedUser(db: DatabaseClient, displayName: string): number {
  return createUsersRepo(db).insert({ displayName }).id;
}

describe('sessions (property-based)', () => {
  let db: DatabaseClient;
  let userId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    userId = seedUser(db, 'alex');
  });

  test('every minted token verifies, regardless of ttl', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_000, max: 60 * 60_000 }), (ttlMs) => {
        const repo = createSessionsRepo(db);
        const { token } = repo.mint({ userId, ttlMs });
        const verified = repo.verify(token);
        return verified !== null && verified.user_id === userId;
      }),
    );
  });

  test('revoking a freshly-minted token always invalidates it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_000, max: 60 * 60_000 }), (ttlMs) => {
        const repo = createSessionsRepo(db);
        const { token } = repo.mint({ userId, ttlMs });
        const revoked = repo.revoke(token);
        return revoked === true && repo.verify(token) === null;
      }),
    );
  });

  test('revoking an arbitrary string that is not a minted token returns false', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 60 }), (s) => {
        fc.pre(!s.startsWith('eal_v1_')); // can't accidentally collide
        const repo = createSessionsRepo(db);
        return repo.revoke(s) === false;
      }),
    );
  });

  test('mintTokenPlaintext produces unique tokens across many invocations', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 32 }), (count) => {
        const tokens = new Set<string>();
        for (let i = 0; i < count; i++) tokens.add(mintTokenPlaintext());
        return tokens.size === count;
      }),
    );
  });

  test('revokeAllForUser is idempotent — every subsequent call returns 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (sessionCount) => {
        const repo = createSessionsRepo(db);
        for (let i = 0; i < sessionCount; i++) repo.mint({ userId, ttlMs: 60_000 });
        const first = repo.revokeAllForUser(userId);
        const second = repo.revokeAllForUser(userId);
        return first === sessionCount && second === 0;
      }),
    );
  });
});
