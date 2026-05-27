import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createAgentRulesRepo } from './agent-rules.ts';
import { createFamilyPhoneDevicesRepo } from './family-phone-devices.ts';
import { createUsersRepo } from './users.ts';

function seedAgentDevice(db: DatabaseClient): number {
  const userId = createUsersRepo(db).insert({ displayName: 'alex' }).id;
  return createFamilyPhoneDevicesRepo(db).insert({
    userId,
    label: 'leo handset',
    kind: 'handset',
  }).id;
}

const FAR_FUTURE = '2099-01-01T00:00:00';
const PAST = '2000-01-01T00:00:00';

describe('AgentRulesRepo', () => {
  let db: DatabaseClient;
  let deviceId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    deviceId = seedAgentDevice(db);
  });

  test('insert round-trips every field, defaulting last_fired_at to null', () => {
    const repo = createAgentRulesRepo(db);
    const row = repo.insert({
      name: 'ring leo at bedtime',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'Time for bed',
      systemPrompt: null,
      nextFireAt: FAR_FUTURE,
      intervalSec: 86_400,
      cooldownSec: 0,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.name).toBe('ring leo at bedtime');
    expect(row.enabled).toBe(1);
    expect(row.target_device_id).toBe(deviceId);
    expect(row.kind).toBe('place_call');
    expect(row.body).toBe('Time for bed');
    expect(row.system_prompt).toBeNull();
    expect(row.next_fire_at).toBe(FAR_FUTURE);
    expect(row.interval_sec).toBe(86_400);
    expect(row.cooldown_sec).toBe(0);
    expect(row.last_fired_at).toBeNull();
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  test('CHECK rejects a row with neither body nor system_prompt', () => {
    const repo = createAgentRulesRepo(db);
    expect(() =>
      repo.insert({
        name: 'broken',
        enabled: true,
        targetDeviceId: deviceId,
        kind: 'place_call',
        body: null,
        systemPrompt: null,
        nextFireAt: FAR_FUTURE,
        intervalSec: null,
        cooldownSec: 0,
      }),
    ).toThrow();
  });

  test('update replaces every settable field', () => {
    const repo = createAgentRulesRepo(db);
    const created = repo.insert({
      name: 'initial',
      enabled: false,
      targetDeviceId: deviceId,
      kind: 'voice_message',
      body: 'old body',
      systemPrompt: null,
      nextFireAt: FAR_FUTURE,
      intervalSec: null,
      cooldownSec: 0,
    });
    const updated = repo.update({
      id: created.id,
      name: 'renamed',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: null,
      systemPrompt: 'new prompt',
      nextFireAt: '2030-06-01T00:00:00',
      intervalSec: 60,
      cooldownSec: 30,
    });
    expect(updated).not.toBeNull();
    expect(updated?.name).toBe('renamed');
    expect(updated?.enabled).toBe(1);
    expect(updated?.kind).toBe('place_call');
    expect(updated?.body).toBeNull();
    expect(updated?.system_prompt).toBe('new prompt');
    expect(updated?.next_fire_at).toBe('2030-06-01T00:00:00');
    expect(updated?.interval_sec).toBe(60);
    expect(updated?.cooldown_sec).toBe(30);
  });

  test('update returns null when the id is unknown', () => {
    const repo = createAgentRulesRepo(db);
    expect(
      repo.update({
        id: 999,
        name: 'ghost',
        enabled: true,
        targetDeviceId: deviceId,
        kind: 'place_call',
        body: 'x',
        systemPrompt: null,
        nextFireAt: FAR_FUTURE,
        intervalSec: null,
        cooldownSec: 0,
      }),
    ).toBeNull();
  });

  test('listDue returns enabled rules with next_fire_at in the past', () => {
    const repo = createAgentRulesRepo(db);
    const due = repo.insert({
      name: 'due',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'x',
      systemPrompt: null,
      nextFireAt: PAST,
      intervalSec: null,
      cooldownSec: 0,
    });
    repo.insert({
      name: 'future',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'x',
      systemPrompt: null,
      nextFireAt: FAR_FUTURE,
      intervalSec: null,
      cooldownSec: 0,
    });
    repo.insert({
      name: 'disabled',
      enabled: false,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'x',
      systemPrompt: null,
      nextFireAt: PAST,
      intervalSec: null,
      cooldownSec: 0,
    });
    const dueRows = repo.listDue('2025-01-01T00:00:00');
    expect(dueRows.map((r) => r.id)).toEqual([due.id]);
  });

  test('listDue respects cooldown_sec since last_fired_at', () => {
    const repo = createAgentRulesRepo(db);
    const r = repo.insert({
      name: 'cooling',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'x',
      systemPrompt: null,
      nextFireAt: PAST,
      intervalSec: null,
      cooldownSec: 3600,
    });
    repo.markFired({ id: r.id, firedAt: '2025-01-01T11:30:00', nextFireAt: null });
    expect(repo.listDue('2025-01-01T12:00:00').map((x) => x.id)).toEqual([]);
    expect(repo.listDue('2025-01-01T12:30:00').map((x) => x.id)).toEqual([r.id]);
  });

  test('markFired updates last_fired_at and conditionally next_fire_at', () => {
    const repo = createAgentRulesRepo(db);
    const r = repo.insert({
      name: 'recurring',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'voice_message',
      body: 'hi',
      systemPrompt: null,
      nextFireAt: PAST,
      intervalSec: 60,
      cooldownSec: 0,
    });
    const advanced = repo.markFired({
      id: r.id,
      firedAt: '2025-01-01T10:00:00',
      nextFireAt: '2025-01-01T10:01:00',
    });
    expect(advanced?.last_fired_at).toBe('2025-01-01T10:00:00');
    expect(advanced?.next_fire_at).toBe('2025-01-01T10:01:00');

    const oneShot = repo.markFired({
      id: r.id,
      firedAt: '2025-01-01T11:00:00',
      nextFireAt: null,
    });
    expect(oneShot?.last_fired_at).toBe('2025-01-01T11:00:00');
    expect(oneShot?.next_fire_at).toBe('2025-01-01T10:01:00');
  });

  test('deleteById removes the row and returns true; missing id returns false', () => {
    const repo = createAgentRulesRepo(db);
    const r = repo.insert({
      name: 'doomed',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'x',
      systemPrompt: null,
      nextFireAt: FAR_FUTURE,
      intervalSec: null,
      cooldownSec: 0,
    });
    expect(repo.deleteById(r.id)).toBe(true);
    expect(repo.findById(r.id)).toBeNull();
    expect(repo.deleteById(r.id)).toBe(false);
  });

  test('ON DELETE CASCADE removes rules when the target device is deleted', () => {
    const repo = createAgentRulesRepo(db);
    repo.insert({
      name: 'orphan-candidate',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'x',
      systemPrompt: null,
      nextFireAt: FAR_FUTURE,
      intervalSec: null,
      cooldownSec: 0,
    });
    createFamilyPhoneDevicesRepo(db).deleteById(deviceId);
    expect(repo.listAll()).toEqual([]);
  });
});
