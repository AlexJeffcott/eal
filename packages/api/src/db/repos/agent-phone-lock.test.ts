import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createAgentActionsRepo } from './agent-actions.ts';
import { createAgentPhoneLockRepo } from './agent-phone-lock.ts';
import { createFamilyPhoneDevicesRepo } from './family-phone-devices.ts';
import { createUsersRepo } from './users.ts';

interface SeededAction {
  deviceId: number;
  actionId: number;
}

function seed(db: DatabaseClient): SeededAction {
  const userId = createUsersRepo(db).insert({ displayName: 'alex' }).id;
  const deviceId = createFamilyPhoneDevicesRepo(db).insert({
    userId,
    label: 'agent',
    kind: 'agent',
  }).id;
  const actionId = createAgentActionsRepo(db).insertPending({
    ruleId: null,
    kind: 'place_call',
    targetDeviceId: deviceId,
    trigger: 'tool',
  }).id;
  return { deviceId, actionId };
}

const FAR_FUTURE = '2099-01-01T00:00:00';
const PAST = '2000-01-01T00:00:00';

describe('AgentPhoneLockRepo', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('claim inserts a row the first time and returns it', () => {
    const { deviceId, actionId } = seed(db);
    const repo = createAgentPhoneLockRepo(db);
    const row = repo.claim({
      deviceId,
      callId: 'call-1',
      actionId,
      expiresAt: FAR_FUTURE,
    });
    expect(row?.device_id).toBe(deviceId);
    expect(row?.call_id).toBe('call-1');
    expect(row?.action_id).toBe(actionId);
  });

  test('a second claim on a locked device returns null', () => {
    const { deviceId, actionId } = seed(db);
    const repo = createAgentPhoneLockRepo(db);
    expect(
      repo.claim({ deviceId, callId: 'call-1', actionId, expiresAt: FAR_FUTURE }),
    ).not.toBeNull();
    expect(
      repo.claim({ deviceId, callId: 'call-2', actionId, expiresAt: FAR_FUTURE }),
    ).toBeNull();
  });

  test('release removes the row and lets a fresh claim succeed', () => {
    const { deviceId, actionId } = seed(db);
    const repo = createAgentPhoneLockRepo(db);
    repo.claim({ deviceId, callId: 'call-1', actionId, expiresAt: FAR_FUTURE });
    expect(repo.release(deviceId)).toBe(true);
    expect(repo.findByDevice(deviceId)).toBeNull();
    expect(
      repo.claim({ deviceId, callId: 'call-2', actionId, expiresAt: FAR_FUTURE }),
    ).not.toBeNull();
  });

  test('release returns false when nothing is locked', () => {
    const { deviceId } = seed(db);
    const repo = createAgentPhoneLockRepo(db);
    expect(repo.release(deviceId)).toBe(false);
  });

  test('sweepExpired removes stale locks but leaves fresh ones', () => {
    const { deviceId, actionId } = seed(db);
    const repo = createAgentPhoneLockRepo(db);
    repo.claim({ deviceId, callId: 'call-old', actionId, expiresAt: PAST });
    expect(repo.sweepExpired('2025-06-01T00:00:00')).toBe(1);
    expect(repo.findByDevice(deviceId)).toBeNull();

    repo.claim({ deviceId, callId: 'call-fresh', actionId, expiresAt: FAR_FUTURE });
    expect(repo.sweepExpired('2025-06-01T00:00:00')).toBe(0);
    expect(repo.findByDevice(deviceId)?.call_id).toBe('call-fresh');
  });

  test('ON DELETE CASCADE clears the lock when its device is deleted', () => {
    const { deviceId, actionId } = seed(db);
    const repo = createAgentPhoneLockRepo(db);
    repo.claim({ deviceId, callId: 'call-1', actionId, expiresAt: FAR_FUTURE });
    createFamilyPhoneDevicesRepo(db).deleteById(deviceId);
    expect(repo.findByDevice(deviceId)).toBeNull();
  });
});
