import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createFamilyPhoneDevicesRepo } from './family-phone-devices.ts';
import { createUsersRepo } from './users.ts';
import { createFamilyPhonePushSubscriptionsRepo } from './family-phone-push-subscriptions.ts';

function seedDevice(db: DatabaseClient, displayName: string, label: string): number {
  const userId = createUsersRepo(db).insert({ displayName }).id;
  const devices = createFamilyPhoneDevicesRepo(db);
  return devices.insert({ userId, label, kind: 'pwa' }).id;
}

describe('FamilyPhonePushSubscriptionsRepo', () => {
  let db: DatabaseClient;
  let deviceA: number;
  let deviceB: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    deviceA = seedDevice(db, 'alex', 'phone');
    deviceB = seedDevice(db, 'leo', 'phone');
  });

  test('upsert inserts a fresh row and returns it', () => {
    const repo = createFamilyPhonePushSubscriptionsRepo(db);
    const row = repo.upsert({
      deviceId: deviceA,
      endpoint: 'https://fcm.example/abc',
      p256dh: 'p-a',
      auth: 'a-a',
    });
    expect(row.device_id).toBe(deviceA);
    expect(row.endpoint).toBe('https://fcm.example/abc');
    expect(row.p256dh).toBe('p-a');
    expect(row.auth).toBe('a-a');
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  test('upsert with the same endpoint refreshes the keys in place', () => {
    const repo = createFamilyPhonePushSubscriptionsRepo(db);
    const first = repo.upsert({
      deviceId: deviceA,
      endpoint: 'https://fcm.example/abc',
      p256dh: 'p-1',
      auth: 'a-1',
    });
    const second = repo.upsert({
      deviceId: deviceA,
      endpoint: 'https://fcm.example/abc',
      p256dh: 'p-2',
      auth: 'a-2',
    });
    expect(second.id).toBe(first.id);
    expect(second.p256dh).toBe('p-2');
    expect(second.auth).toBe('a-2');
    expect(repo.listByDevice(deviceA)).toHaveLength(1);
  });

  test('listByDevice returns only that device, ordered by id', () => {
    const repo = createFamilyPhonePushSubscriptionsRepo(db);
    repo.upsert({ deviceId: deviceA, endpoint: 'https://e/1', p256dh: 'p1', auth: 'a1' });
    repo.upsert({ deviceId: deviceB, endpoint: 'https://e/2', p256dh: 'p2', auth: 'a2' });
    repo.upsert({ deviceId: deviceA, endpoint: 'https://e/3', p256dh: 'p3', auth: 'a3' });
    const aRows = repo.listByDevice(deviceA);
    expect(aRows).toHaveLength(2);
    expect(aRows.map((r) => r.endpoint)).toEqual(['https://e/1', 'https://e/3']);
    const bRows = repo.listByDevice(deviceB);
    expect(bRows.map((r) => r.endpoint)).toEqual(['https://e/2']);
  });

  test('deleteByEndpoint removes a single row and returns true', () => {
    const repo = createFamilyPhonePushSubscriptionsRepo(db);
    repo.upsert({ deviceId: deviceA, endpoint: 'https://e/1', p256dh: 'p1', auth: 'a1' });
    repo.upsert({ deviceId: deviceA, endpoint: 'https://e/2', p256dh: 'p2', auth: 'a2' });
    expect(repo.deleteByEndpoint('https://e/1')).toBe(true);
    expect(repo.listByDevice(deviceA).map((r) => r.endpoint)).toEqual(['https://e/2']);
  });

  test('deleteByEndpoint returns false when nothing matched', () => {
    const repo = createFamilyPhonePushSubscriptionsRepo(db);
    expect(repo.deleteByEndpoint('https://e/missing')).toBe(false);
  });

  test('deleteByDevice removes every row for that device', () => {
    const repo = createFamilyPhonePushSubscriptionsRepo(db);
    repo.upsert({ deviceId: deviceA, endpoint: 'https://e/1', p256dh: 'p1', auth: 'a1' });
    repo.upsert({ deviceId: deviceA, endpoint: 'https://e/2', p256dh: 'p2', auth: 'a2' });
    repo.upsert({ deviceId: deviceB, endpoint: 'https://e/3', p256dh: 'p3', auth: 'a3' });
    expect(repo.deleteByDevice(deviceA)).toBe(2);
    expect(repo.listByDevice(deviceA)).toEqual([]);
    expect(repo.listByDevice(deviceB)).toHaveLength(1);
  });

  test('ON DELETE CASCADE clears subscriptions when the device row is deleted', () => {
    const repo = createFamilyPhonePushSubscriptionsRepo(db);
    repo.upsert({ deviceId: deviceA, endpoint: 'https://e/1', p256dh: 'p1', auth: 'a1' });
    createFamilyPhoneDevicesRepo(db).deleteById(deviceA);
    expect(repo.listByDevice(deviceA)).toEqual([]);
  });
});
