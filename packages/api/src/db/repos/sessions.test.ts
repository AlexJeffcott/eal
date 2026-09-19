import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createSessionsRepoFromDb } from './sessions.ts';
import { createUsersRepo } from './users.ts';

function seedUser(db: DatabaseClient, displayName: string): number {
  return createUsersRepo(db).insert({ displayName }).id;
}

function inThePast(): string {
  return '2000-01-01 00:00:00';
}
function inTheFuture(): string {
  return '2999-01-01 00:00:00';
}
function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

const hashA = new Uint8Array(32).fill(1);
const hashB = new Uint8Array(32).fill(2);
const hashC = new Uint8Array(32).fill(3);

describe('SessionsRepoLow', () => {
  let db: DatabaseClient;
  let userId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    userId = seedUser(db, 'alex');
  });

  test('insert persists hash + user + expiry', () => {
    const repo = createSessionsRepoFromDb(db);
    const row = repo.insert({ tokenHash: hashA, userId, expiresAt: inTheFuture(), ttlMs: 60_000, label: 'spa' });
    expect(Array.from(row.token_hash)).toEqual(Array.from(hashA));
    expect(row.user_id).toBe(userId);
    expect(row.expires_at).toBe(inTheFuture());
    expect(row.label).toBe('spa');
  });

  test('insert with no label stores NULL', () => {
    const repo = createSessionsRepoFromDb(db);
    const row = repo.insert({ tokenHash: hashA, userId, expiresAt: inTheFuture() , ttlMs: 60_000});
    expect(row.label).toBeNull();
  });

  test('findByTokenHash returns the row or null', () => {
    const repo = createSessionsRepoFromDb(db);
    repo.insert({ tokenHash: hashA, userId, expiresAt: inTheFuture() , ttlMs: 60_000});
    expect(repo.findByTokenHash(hashA)?.user_id).toBe(userId);
    expect(repo.findByTokenHash(hashB)).toBeNull();
  });

  test('deleteByTokenHash returns true for a hit, false for a miss', () => {
    const repo = createSessionsRepoFromDb(db);
    repo.insert({ tokenHash: hashA, userId, expiresAt: inTheFuture() , ttlMs: 60_000});
    expect(repo.deleteByTokenHash(hashA)).toBe(true);
    expect(repo.findByTokenHash(hashA)).toBeNull();
    expect(repo.deleteByTokenHash(hashA)).toBe(false);
  });

  test('deleteAllForUser removes only that user’s rows and returns the count', () => {
    const repo = createSessionsRepoFromDb(db);
    const otherUserId = seedUser(db, 'leo');
    repo.insert({ tokenHash: hashA, userId, expiresAt: inTheFuture() , ttlMs: 60_000});
    repo.insert({ tokenHash: hashB, userId, expiresAt: inTheFuture() , ttlMs: 60_000});
    repo.insert({ tokenHash: hashC, userId: otherUserId, expiresAt: inTheFuture() , ttlMs: 60_000});
    expect(repo.deleteAllForUser(userId)).toBe(2);
    expect(repo.findByTokenHash(hashA)).toBeNull();
    expect(repo.findByTokenHash(hashB)).toBeNull();
    expect(repo.findByTokenHash(hashC)?.user_id).toBe(otherUserId);
  });

  test('deleteExpired removes only rows whose expires_at < now', () => {
    const repo = createSessionsRepoFromDb(db);
    repo.insert({ tokenHash: hashA, userId, expiresAt: inThePast() , ttlMs: 60_000});
    repo.insert({ tokenHash: hashB, userId, expiresAt: inTheFuture() , ttlMs: 60_000});
    expect(repo.deleteExpired(now())).toBe(1);
    expect(repo.findByTokenHash(hashA)).toBeNull();
    expect(repo.findByTokenHash(hashB)).not.toBeNull();
  });

  test('updateLastUsed bumps the timestamp', () => {
    const repo = createSessionsRepoFromDb(db);
    repo.insert({ tokenHash: hashA, userId, expiresAt: inTheFuture() , ttlMs: 60_000});
    const stamp = '2099-12-31 23:59:59';
    repo.updateLastUsed(hashA, stamp);
    expect(repo.findByTokenHash(hashA)?.last_used_at).toBe(stamp);
  });
});
