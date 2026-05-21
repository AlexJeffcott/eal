import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createCliPairingsRepo } from './cli-pairings.ts';
import { createUsersRepo } from './users.ts';

function seedUser(db: DatabaseClient, displayName: string): number {
  return createUsersRepo(db).insert({ displayName }).id;
}

const deviceHashA = new Uint8Array(32).fill(1);
const deviceHashB = new Uint8Array(32).fill(2);

function inThePast(): string { return '2000-01-01 00:00:00'; }
function inTheFuture(): string { return '2999-01-01 00:00:00'; }
function now(): string { return '2026-05-19 12:00:00'; }

describe('CliPairingsRepo', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('insert persists hash + user_code + expiry; row starts unclaimed', () => {
    const repo = createCliPairingsRepo(db);
    const row = repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    expect(Array.from(row.device_code_hash)).toEqual(Array.from(deviceHashA));
    expect(row.user_code).toBe('WXYZ-1234');
    expect(row.user_id).toBeNull();
    expect(row.label).toBeNull();
    expect(row.consumed_at).toBeNull();
    expect(row.expires_at).toBe(inTheFuture());
  });

  test('user_code UNIQUE constraint rejects duplicates', () => {
    const repo = createCliPairingsRepo(db);
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    expect(() =>
      repo.insert({ deviceCodeHash: deviceHashB, userCode: 'WXYZ-1234', expiresAt: inTheFuture() }),
    ).toThrow();
  });

  test('device_code_hash PRIMARY KEY rejects duplicates', () => {
    const repo = createCliPairingsRepo(db);
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    expect(() =>
      repo.insert({ deviceCodeHash: deviceHashA, userCode: 'OTHE-R999', expiresAt: inTheFuture() }),
    ).toThrow();
  });

  test('findByUserCode returns the row or null', () => {
    const repo = createCliPairingsRepo(db);
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    expect(repo.findByUserCode('WXYZ-1234')?.user_code).toBe('WXYZ-1234');
    expect(repo.findByUserCode('MISS-0000')).toBeNull();
  });

  test('findByDeviceCodeHash returns the row or null', () => {
    const repo = createCliPairingsRepo(db);
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    expect(repo.findByDeviceCodeHash(deviceHashA)?.user_code).toBe('WXYZ-1234');
    expect(repo.findByDeviceCodeHash(deviceHashB)).toBeNull();
  });

  test('markClaimed sets user_id / label and returns true', () => {
    const repo = createCliPairingsRepo(db);
    const userId = seedUser(db, 'alex');
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    const ok = repo.markClaimed({ userCode: 'WXYZ-1234', userId, label: 'my-laptop' });
    expect(ok).toBe(true);
    const row = repo.findByUserCode('WXYZ-1234');
    expect(row?.user_id).toBe(userId);
    expect(row?.label).toBe('my-laptop');
  });

  test('markClaimed is single-shot: a second claim against the same user_code returns false', () => {
    const repo = createCliPairingsRepo(db);
    const alex = seedUser(db, 'alex');
    const leo = seedUser(db, 'leo');
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    expect(repo.markClaimed({ userCode: 'WXYZ-1234', userId: alex, label: 'a' })).toBe(true);
    expect(repo.markClaimed({ userCode: 'WXYZ-1234', userId: leo, label: 'b' })).toBe(false);
    expect(repo.findByUserCode('WXYZ-1234')?.user_id).toBe(alex);
  });

  test('markClaimed against an unknown user_code returns false', () => {
    const repo = createCliPairingsRepo(db);
    const userId = seedUser(db, 'alex');
    expect(repo.markClaimed({ userCode: 'NOPE-0000', userId, label: 'x' })).toBe(false);
  });

  test('markConsumed sets consumed_at on a claimed row and returns true', () => {
    const repo = createCliPairingsRepo(db);
    const userId = seedUser(db, 'alex');
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    repo.markClaimed({ userCode: 'WXYZ-1234', userId, label: 'l' });
    expect(repo.markConsumed({ deviceCodeHash: deviceHashA, consumedAt: now() })).toBe(true);
    expect(repo.findByDeviceCodeHash(deviceHashA)?.consumed_at).toBe(now());
  });

  test('markConsumed returns false on an unclaimed row (no user_id yet)', () => {
    const repo = createCliPairingsRepo(db);
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    expect(repo.markConsumed({ deviceCodeHash: deviceHashA, consumedAt: now() })).toBe(false);
  });

  test('markConsumed is single-shot: second consume against the same device_code returns false', () => {
    const repo = createCliPairingsRepo(db);
    const userId = seedUser(db, 'alex');
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    repo.markClaimed({ userCode: 'WXYZ-1234', userId, label: 'l' });
    expect(repo.markConsumed({ deviceCodeHash: deviceHashA, consumedAt: now() })).toBe(true);
    expect(repo.markConsumed({ deviceCodeHash: deviceHashA, consumedAt: now() })).toBe(false);
  });

  test('deleteExpired removes only rows whose expires_at < now', () => {
    const repo = createCliPairingsRepo(db);
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'AAAA-1111', expiresAt: inThePast() });
    repo.insert({ deviceCodeHash: deviceHashB, userCode: 'BBBB-2222', expiresAt: inTheFuture() });
    expect(repo.deleteExpired(now())).toBe(1);
    expect(repo.findByUserCode('AAAA-1111')).toBeNull();
    expect(repo.findByUserCode('BBBB-2222')).not.toBeNull();
  });

  test('cascading delete: removing a user clears their pairing rows', () => {
    const repo = createCliPairingsRepo(db);
    const userId = seedUser(db, 'alex');
    repo.insert({ deviceCodeHash: deviceHashA, userCode: 'WXYZ-1234', expiresAt: inTheFuture() });
    repo.markClaimed({ userCode: 'WXYZ-1234', userId, label: 'l' });
    db.exec(`DELETE FROM users WHERE id = ${userId}`);
    expect(repo.findByUserCode('WXYZ-1234')).toBeNull();
  });
});
