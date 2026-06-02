import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createPstnContactsRepo } from './family-phone-pstn-contacts.ts';

describe('PstnContactsRepo', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('insert round-trips every field and defaults allow flags to enabled', () => {
    const repo = createPstnContactsRepo(db);
    const row = repo.insert({
      e164: '+441234567890',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.e164).toBe('+441234567890');
    expect(row.label).toBe('Nonna');
    expect(row.allow_in).toBe(1);
    expect(row.allow_out).toBe(1);
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  test('UNIQUE on e164 rejects a second insert with the same number', () => {
    const repo = createPstnContactsRepo(db);
    repo.insert({ e164: '+441234567890', label: 'Nonna', allowIn: true, allowOut: true });
    expect(() =>
      repo.insert({ e164: '+441234567890', label: 'Duplicate', allowIn: true, allowOut: true }),
    ).toThrow();
  });

  test('update patches label + allow flags, leaves e164 and created_at intact', () => {
    const repo = createPstnContactsRepo(db);
    const original = repo.insert({
      e164: '+391234567890',
      label: 'Nonno',
      allowIn: true,
      allowOut: true,
    });
    const updated = repo.update({
      id: original.id,
      label: 'Nonno (Bologna)',
      allowIn: false,
      allowOut: true,
    });
    expect(updated).not.toBeNull();
    expect(updated?.id).toBe(original.id);
    expect(updated?.e164).toBe('+391234567890');
    expect(updated?.label).toBe('Nonno (Bologna)');
    expect(updated?.allow_in).toBe(0);
    expect(updated?.allow_out).toBe(1);
    expect(updated?.created_at).toBe(original.created_at);
  });

  test('update on a missing id returns null', () => {
    const repo = createPstnContactsRepo(db);
    expect(repo.update({ id: 9999, label: 'x', allowIn: true, allowOut: true })).toBeNull();
  });

  test('findById and findByE164 return the same row, null otherwise', () => {
    const repo = createPstnContactsRepo(db);
    const inserted = repo.insert({
      e164: '+12025550101',
      label: 'Dad',
      allowIn: true,
      allowOut: false,
    });
    expect(repo.findById(inserted.id)?.id).toBe(inserted.id);
    expect(repo.findByE164('+12025550101')?.id).toBe(inserted.id);
    expect(repo.findById(9999)).toBeNull();
    expect(repo.findByE164('+12025550999')).toBeNull();
  });

  test('listAll sorts by label then e164, surfaces every row', () => {
    const repo = createPstnContactsRepo(db);
    repo.insert({ e164: '+441234567892', label: 'Zola', allowIn: true, allowOut: true });
    repo.insert({ e164: '+441234567890', label: 'Anna', allowIn: true, allowOut: true });
    repo.insert({ e164: '+441234567891', label: 'Anna', allowIn: false, allowOut: false });
    const rows = repo.listAll();
    expect(rows.map((r) => [r.label, r.e164])).toEqual([
      ['Anna', '+441234567890'],
      ['Anna', '+441234567891'],
      ['Zola', '+441234567892'],
    ]);
  });

  test('deleteById removes the row and returns true; false on a missing id', () => {
    const repo = createPstnContactsRepo(db);
    const row = repo.insert({
      e164: '+441234567890',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
    });
    expect(repo.deleteById(row.id)).toBe(true);
    expect(repo.findById(row.id)).toBeNull();
    expect(repo.deleteById(row.id)).toBe(false);
  });

  test('intended_user_id defaults to null and round-trips on insert/update', () => {
    db.exec("INSERT INTO users (display_name) VALUES ('alex'), ('sarah')");
    const repo = createPstnContactsRepo(db);
    const defaulted = repo.insert({
      e164: '+441234567890',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
    });
    expect(defaulted.intended_user_id).toBeNull();
    const set = repo.insert({
      e164: '+391234567890',
      label: 'Nonno',
      allowIn: true,
      allowOut: true,
      intendedUserId: 1,
    });
    expect(set.intended_user_id).toBe(1);
    const updated = repo.update({
      id: set.id,
      label: 'Nonno (Bologna)',
      allowIn: true,
      allowOut: true,
      intendedUserId: 2,
    });
    expect(updated?.intended_user_id).toBe(2);
    const cleared = repo.update({
      id: set.id,
      label: 'Nonno (Bologna)',
      allowIn: true,
      allowOut: true,
      intendedUserId: null,
    });
    expect(cleared?.intended_user_id).toBeNull();
  });

  test('deleting the intended user clears intended_user_id (ON DELETE SET NULL)', () => {
    db.exec("INSERT INTO users (display_name) VALUES ('alex')");
    const repo = createPstnContactsRepo(db);
    const row = repo.insert({
      e164: '+441234567890',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
      intendedUserId: 1,
    });
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('DELETE FROM users WHERE id = 1');
    expect(repo.findById(row.id)?.intended_user_id).toBeNull();
  });

  test('CHECK rejects allow_in and allow_out values outside (0,1)', () => {
    db.exec(`INSERT INTO family_phone_pstn_contacts (e164, label, allow_in, allow_out)
             VALUES ('+441234567890', 'OK', 1, 1)`);
    expect(() =>
      db.exec(`INSERT INTO family_phone_pstn_contacts (e164, label, allow_in, allow_out)
               VALUES ('+441234567891', 'Bad', 2, 1)`),
    ).toThrow();
    expect(() =>
      db.exec(`INSERT INTO family_phone_pstn_contacts (e164, label, allow_in, allow_out)
               VALUES ('+441234567892', 'Bad', 1, 2)`),
    ).toThrow();
  });
});
