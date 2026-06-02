import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createFamilyPhoneDevicesRepo } from './family-phone-devices.ts';

describe('family_phone_devices repo — PSTN surface', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    db.prepare("INSERT INTO users (display_name) VALUES ('alex')").run();
  });

  test('upsertPstnByE164 inserts a new row with null user_id and kind=pstn', () => {
    const repo = createFamilyPhoneDevicesRepo(db);
    const row = repo.upsertPstnByE164('+12025550100');
    expect(row.kind).toBe('pstn');
    expect(row.user_id).toBeNull();
    expect(row.label).toBe('+12025550100');
    expect(row.id).toBeGreaterThan(0);
  });

  test('upsertPstnByE164 is idempotent — the second call returns the same row', () => {
    const repo = createFamilyPhoneDevicesRepo(db);
    const a = repo.upsertPstnByE164('+12025550100');
    const b = repo.upsertPstnByE164('+12025550100');
    expect(b.id).toBe(a.id);
    expect(b.created_at).toBe(a.created_at);
  });

  test('upsertPstnByE164 keeps distinct E.164s in distinct rows', () => {
    const repo = createFamilyPhoneDevicesRepo(db);
    const a = repo.upsertPstnByE164('+12025550100');
    const b = repo.upsertPstnByE164('+12025550101');
    expect(a.id).not.toBe(b.id);
  });

  test('listAllWithOwner excludes PSTN rows (they have no human owner)', () => {
    const repo = createFamilyPhoneDevicesRepo(db);
    repo.insert({ userId: 1, label: 'phone', kind: 'handset' });
    repo.upsertPstnByE164('+12025550100');
    const rows = repo.listAllWithOwner();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('handset');
  });

  test('findById round-trips a PSTN row', () => {
    const repo = createFamilyPhoneDevicesRepo(db);
    const created = repo.upsertPstnByE164('+12025550100');
    const fetched = repo.findById(created.id);
    expect(fetched).toEqual(created);
  });

  test('getHouseholdDevice returns the single user-less household row seeded by applySchema', () => {
    const repo = createFamilyPhoneDevicesRepo(db);
    const row = repo.getHouseholdDevice();
    expect(row.kind).toBe('household');
    expect(row.user_id).toBeNull();
    expect(row.label).toBe('Household');
  });

  test('listByUser returns this users handsets/pwas/agents only, ordered by id', () => {
    db.exec("INSERT INTO users (display_name) VALUES ('sarah')");
    const repo = createFamilyPhoneDevicesRepo(db);
    const a = repo.insert({ userId: 1, label: 'phone', kind: 'handset' });
    const b = repo.insert({ userId: 1, label: 'pwa', kind: 'pwa' });
    repo.insert({ userId: 2, label: 'phone', kind: 'handset' });
    repo.upsertPstnByE164('+12025550100');
    const rows = repo.listByUser(1);
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rows.every((r) => r.user_id === 1)).toBe(true);
  });

  test('listAllWithOwner also excludes the household row', () => {
    const repo = createFamilyPhoneDevicesRepo(db);
    repo.insert({ userId: 1, label: 'phone', kind: 'handset' });
    const rows = repo.listAllWithOwner();
    expect(rows.every((r) => r.kind !== 'household')).toBe(true);
    expect(rows).toHaveLength(1);
  });
});
