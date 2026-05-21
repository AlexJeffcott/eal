import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createUsersRepo } from './users.ts';

describe('UsersRepo', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('insert returns a row with id, display_name, created_at', () => {
    const repo = createUsersRepo(db);
    const row = repo.insert({ displayName: 'alex' });
    expect(row.id).toBe(1);
    expect(row.display_name).toBe('alex');
    expect(typeof row.created_at).toBe('string');
    expect(row.created_at.length).toBeGreaterThan(0);
  });

  test('display_name UNIQUE constraint rejects duplicates', () => {
    const repo = createUsersRepo(db);
    repo.insert({ displayName: 'leo' });
    expect(() => repo.insert({ displayName: 'leo' })).toThrow();
  });

  test('findById returns the row or null', () => {
    const repo = createUsersRepo(db);
    const inserted = repo.insert({ displayName: 'elisa' });
    expect(repo.findById(inserted.id)?.display_name).toBe('elisa');
    expect(repo.findById(999)).toBeNull();
  });

  test('findByDisplayName returns the row or null', () => {
    const repo = createUsersRepo(db);
    repo.insert({ displayName: 'alex' });
    expect(repo.findByDisplayName('alex')?.display_name).toBe('alex');
    expect(repo.findByDisplayName('nobody')).toBeNull();
  });

  test('listAll returns every member ordered by display name', () => {
    const repo = createUsersRepo(db);
    repo.insert({ displayName: 'leo' });
    repo.insert({ displayName: 'alex' });
    repo.insert({ displayName: 'elisa' });
    expect(repo.listAll().map((u) => u.display_name)).toEqual(['alex', 'elisa', 'leo']);
  });

  test('listAll is empty on a fresh database', () => {
    expect(createUsersRepo(db).listAll()).toEqual([]);
  });
});
