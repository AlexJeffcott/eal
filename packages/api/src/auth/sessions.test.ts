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
