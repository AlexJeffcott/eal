import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createSessionsRepoFromDb } from '../db/repos/sessions.ts';
import {
  createSessionsRepo,
  mintTokenPlaintext,
} from './sessions.ts';
import { sha256 } from './hash.ts';
import { formatSqliteDateTime } from './datetime.ts';

function seedUser(db: DatabaseClient, displayName: string): number {
  return createUsersRepo(db).insert({ displayName }).id;
}

const FIXED_NOW = new Date('2026-05-19T08:00:00Z');
const ONE_SECOND_LATER = new Date(FIXED_NOW.getTime() + 1_000);
const FIVE_MINUTES_LATER = new Date(FIXED_NOW.getTime() + 5 * 60_000);
const SIX_HOURS_LATER = new Date(FIXED_NOW.getTime() + 6 * 60 * 60_000);

describe('mintTokenPlaintext', () => {
  test('returns a token with the eal_v1_ prefix', () => {
    const token = mintTokenPlaintext();
    expect(token.startsWith('eal_v1_')).toBe(true);
  });

  test('produces distinct tokens', () => {
    expect(mintTokenPlaintext()).not.toBe(mintTokenPlaintext());
  });

  test('the body is 43-char base64url (32 random bytes)', () => {
    const token = mintTokenPlaintext();
    const body = token.slice('eal_v1_'.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('SessionsRepo (high-level wrapper)', () => {
  let db: DatabaseClient;
  let userId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    userId = seedUser(db, 'alex');
  });

  test('mint persists the SHA-256 hash, not the plaintext', () => {
    const repo = createSessionsRepo(db, { now: () => FIXED_NOW });
    const { token, row } = repo.mint({ userId, ttlMs: 60_000, label: 'spa' });
    expect(token.startsWith('eal_v1_')).toBe(true);
    expect(row.user_id).toBe(userId);
    expect(row.label).toBe('spa');
    const expectedHash = sha256(token);
    expect(Array.from(row.token_hash)).toEqual(Array.from(expectedHash));

    // Plaintext is nowhere in the DB
    const low = createSessionsRepoFromDb(db);
    expect(low.findByTokenHash(new TextEncoder().encode(token))).toBeNull();
  });

  test('verify(plaintext) returns the row when valid', () => {
    const repo = createSessionsRepo(db, { now: () => FIXED_NOW });
    const { token, row } = repo.mint({ userId, ttlMs: 60_000 });
    expect(repo.verify(token)?.user_id).toBe(row.user_id);
  });

  test('verify with an unknown token returns null', () => {
    const repo = createSessionsRepo(db, { now: () => FIXED_NOW });
    expect(repo.verify('eal_v1_does-not-exist')).toBeNull();
  });

  test('verify with an expired token returns null AND does not delete the row', () => {
    const repo = createSessionsRepo(db, { now: () => FIXED_NOW });
    const { token } = repo.mint({ userId, ttlMs: 1_000 });

    const future = createSessionsRepo(db, { now: () => SIX_HOURS_LATER });
    expect(future.verify(token)).toBeNull();

    // Row still present until pruneExpired runs
    const low = createSessionsRepoFromDb(db);
    expect(low.findByTokenHash(sha256(token))).not.toBeNull();
  });

  test('verify bumps last_used_at when the previous bump is older than the coalesce window', () => {
    const repo = createSessionsRepo(db, { now: () => FIXED_NOW, coalesceMs: 60_000 });
    const { token } = repo.mint({ userId, ttlMs: 60 * 60_000 });
    const originalLastUsed = createSessionsRepoFromDb(db).findByTokenHash(sha256(token))?.last_used_at;

    // First verify within the window — NO bump.
    const within = createSessionsRepo(db, { now: () => ONE_SECOND_LATER, coalesceMs: 60_000 });
    within.verify(token);
    expect(createSessionsRepoFromDb(db).findByTokenHash(sha256(token))?.last_used_at).toBe(originalLastUsed);

    // Second verify well outside the window but still within ttl — bump.
    const outside = createSessionsRepo(db, { now: () => FIVE_MINUTES_LATER, coalesceMs: 60_000 });
    outside.verify(token);
    expect(createSessionsRepoFromDb(db).findByTokenHash(sha256(token))?.last_used_at).not.toBe(originalLastUsed);
  });

  describe('the expiry slides with use', () => {
    const DAY_MS = 24 * 60 * 60_000;
    const TTL_MS = 30 * DAY_MS;
    const at = (days: number): Date => new Date(FIXED_NOW.getTime() + days * DAY_MS);
    const expiryOf = (token: string): string | undefined =>
      createSessionsRepoFromDb(db).findByTokenHash(sha256(token))?.expires_at;

    test('a session used every day outlives the lifetime it was minted with', () => {
      const { token } = createSessionsRepo(db, { now: () => FIXED_NOW }).mint({ userId, ttlMs: TTL_MS });
      for (let day = 1; day <= 45; day++) {
        const row = createSessionsRepo(db, { now: () => at(day) }).verify(token);
        expect(row).not.toBeNull();
      }
    });

    test('a use moves the expiry to one lifetime from that use, and returns the moved row', () => {
      const { token } = createSessionsRepo(db, { now: () => FIXED_NOW }).mint({ userId, ttlMs: TTL_MS });
      const row = createSessionsRepo(db, { now: () => at(10) }).verify(token);
      const expected = formatSqliteDateTime(at(40));
      expect(expiryOf(token)).toBe(expected);
      expect(row?.expires_at).toBe(expected);
    });

    test('a session left unused still ends one lifetime after its last use', () => {
      const { token } = createSessionsRepo(db, { now: () => FIXED_NOW }).mint({ userId, ttlMs: TTL_MS });
      createSessionsRepo(db, { now: () => at(10) }).verify(token);
      expect(createSessionsRepo(db, { now: () => at(39) }).verify(token)).not.toBeNull();
    });

    test('and no later', () => {
      const { token } = createSessionsRepo(db, { now: () => FIXED_NOW }).mint({ userId, ttlMs: TTL_MS });
      createSessionsRepo(db, { now: () => at(10) }).verify(token);
      expect(createSessionsRepo(db, { now: () => at(41) }).verify(token)).toBeNull();
    });

    test('a second use inside the same day does not write the expiry again', () => {
      const { token } = createSessionsRepo(db, { now: () => FIXED_NOW }).mint({ userId, ttlMs: TTL_MS });
      createSessionsRepo(db, { now: () => at(10) }).verify(token);
      const afterFirst = expiryOf(token);
      createSessionsRepo(db, { now: () => at(10.5) }).verify(token);
      expect(expiryOf(token)).toBe(afterFirst);
    });

    test('an expired session is not revived by a use', () => {
      const { token } = createSessionsRepo(db, { now: () => FIXED_NOW }).mint({ userId, ttlMs: TTL_MS });
      const before = expiryOf(token);
      expect(createSessionsRepo(db, { now: () => at(31) }).verify(token)).toBeNull();
      expect(expiryOf(token)).toBe(before);
    });

    test('a row minted before the column gets its lifetime from its own two dates', () => {
      db.exec(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, label)
         VALUES (x'aa', ${userId}, '2026-08-20 10:00:00', '2026-09-19 10:00:00', '2026-08-20 10:00:00', 'spa')`,
      );
      applySchema(db);
      const row = db
        .prepare<{ ttl_ms: number | null }, []>("SELECT ttl_ms FROM sessions WHERE token_hash = x'aa'")
        .get();
      expect(row?.ttl_ms).toBe(TTL_MS);
    });
  });

  test('revoke(plaintext) deletes exactly one row and returns true', () => {
    const repo = createSessionsRepo(db, { now: () => FIXED_NOW });
    const { token } = repo.mint({ userId, ttlMs: 60_000 });
    expect(repo.revoke(token)).toBe(true);
    expect(repo.verify(token)).toBeNull();
  });

  test('revoke with an unknown token returns false', () => {
    const repo = createSessionsRepo(db);
    expect(repo.revoke('eal_v1_unknown')).toBe(false);
  });

  test('revokeAllForUser deletes every session for that user only', () => {
    const repo = createSessionsRepo(db, { now: () => FIXED_NOW });
    const otherUserId = seedUser(db, 'leo');
    const { token: t1 } = repo.mint({ userId, ttlMs: 60_000 });
    const { token: t2 } = repo.mint({ userId, ttlMs: 60_000 });
    const { token: t3 } = repo.mint({ userId: otherUserId, ttlMs: 60_000 });
    expect(repo.revokeAllForUser(userId)).toBe(2);
    expect(repo.verify(t1)).toBeNull();
    expect(repo.verify(t2)).toBeNull();
    expect(repo.verify(t3)?.user_id).toBe(otherUserId);
  });

  test('pruneExpired deletes only expired rows', () => {
    const repo = createSessionsRepo(db, { now: () => FIXED_NOW });
    const { token: expiringSoon } = repo.mint({ userId, ttlMs: 500 });
    const { token: longLived } = repo.mint({ userId, ttlMs: 24 * 60 * 60_000 });

    const future = createSessionsRepo(db, { now: () => SIX_HOURS_LATER });
    expect(future.pruneExpired()).toBe(1);
    expect(future.verify(expiringSoon)).toBeNull();
    expect(future.verify(longLived)?.user_id).toBe(userId);
  });
});
