import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createCredentialsRepo } from './credentials.ts';
import { createUsersRepo } from './users.ts';

function seedUser(db: DatabaseClient, displayName: string): number {
  return createUsersRepo(db).insert({ displayName }).id;
}

const credId = new Uint8Array([1, 2, 3, 4, 5]);
const pubKey = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);

describe('CredentialsRepo', () => {
  let db: DatabaseClient;
  let userId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    userId = seedUser(db, 'alex');
  });

  test('insert persists bytes verbatim (BLOB round-trip)', () => {
    const repo = createCredentialsRepo(db);
    const row = repo.insert({
      userId,
      credentialId: credId,
      publicKey: pubKey,
      counter: 0,
      transports: ['internal'],
    });
    expect(row.user_id).toBe(userId);
    expect(Array.from(row.credential_id)).toEqual(Array.from(credId));
    expect(Array.from(row.public_key)).toEqual(Array.from(pubKey));
    expect(row.counter).toBe(0);
    expect(row.transports).toBe('internal');
  });

  test('insert with no transports stores NULL', () => {
    const repo = createCredentialsRepo(db);
    const row = repo.insert({ userId, credentialId: credId, publicKey: pubKey, counter: 0 });
    expect(row.transports).toBeNull();
  });

  test('insert with empty transports stores NULL', () => {
    const repo = createCredentialsRepo(db);
    const row = repo.insert({ userId, credentialId: credId, publicKey: pubKey, counter: 0, transports: [] });
    expect(row.transports).toBeNull();
  });

  test('credential_id UNIQUE constraint rejects duplicates', () => {
    const repo = createCredentialsRepo(db);
    repo.insert({ userId, credentialId: credId, publicKey: pubKey, counter: 0 });
    expect(() => repo.insert({ userId, credentialId: credId, publicKey: pubKey, counter: 0 })).toThrow();
  });

  test('findByCredentialId returns the row or null', () => {
    const repo = createCredentialsRepo(db);
    repo.insert({ userId, credentialId: credId, publicKey: pubKey, counter: 0 });
    expect(repo.findByCredentialId(credId)?.user_id).toBe(userId);
    expect(repo.findByCredentialId(new Uint8Array([0]))).toBeNull();
  });

  test('findByUserId returns all rows for that user', () => {
    const repo = createCredentialsRepo(db);
    repo.insert({ userId, credentialId: new Uint8Array([1]), publicKey: pubKey, counter: 0 });
    repo.insert({ userId, credentialId: new Uint8Array([2]), publicKey: pubKey, counter: 0 });
    const otherUserId = seedUser(db, 'leo');
    repo.insert({ userId: otherUserId, credentialId: new Uint8Array([3]), publicKey: pubKey, counter: 0 });
    const rows = repo.findByUserId(userId);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.user_id === userId)).toBe(true);
  });

  test('updateCounter increments stored counter', () => {
    const repo = createCredentialsRepo(db);
    repo.insert({ userId, credentialId: credId, publicKey: pubKey, counter: 0 });
    repo.updateCounter(credId, 5);
    expect(repo.findByCredentialId(credId)?.counter).toBe(5);
  });
});
