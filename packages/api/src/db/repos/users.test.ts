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

  test('insert defaults in_ivr_menu to 0', () => {
    const repo = createUsersRepo(db);
    const row = repo.insert({ displayName: 'alex' });
    expect(row.in_ivr_menu).toBe(0);
  });

  test('setInIvrMenu flips the flag and returns the patched row; listInIvrMenu filters on it', () => {
    const repo = createUsersRepo(db);
    const a = repo.insert({ displayName: 'alex' });
    const b = repo.insert({ displayName: 'sarah' });
    repo.insert({ displayName: 'leo' });
    const patched = repo.setInIvrMenu(a.id, true);
    expect(patched?.in_ivr_menu).toBe(1);
    repo.setInIvrMenu(b.id, true);
    expect(repo.listInIvrMenu().map((u) => u.display_name)).toEqual(['alex', 'sarah']);
    repo.setInIvrMenu(a.id, false);
    expect(repo.listInIvrMenu().map((u) => u.display_name)).toEqual(['sarah']);
  });

  test('setInIvrMenu on a missing id returns null without throwing', () => {
    expect(createUsersRepo(db).setInIvrMenu(999, true)).toBeNull();
  });
});
