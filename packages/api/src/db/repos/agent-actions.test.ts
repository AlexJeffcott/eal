import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createAgentActionsRepo } from './agent-actions.ts';
import { createAgentRulesRepo } from './agent-rules.ts';
import { createFamilyPhoneDevicesRepo } from './family-phone-devices.ts';
import { createUsersRepo } from './users.ts';

function seedDevice(db: DatabaseClient): number {
  const userId = createUsersRepo(db).insert({ displayName: 'alex' }).id;
  return createFamilyPhoneDevicesRepo(db).insert({
    userId,
    label: 'leo handset',
    kind: 'handset',
  }).id;
}

describe('AgentActionsRepo', () => {
  let db: DatabaseClient;
  let deviceId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    deviceId = seedDevice(db);
  });

  test('insertPending starts in result=pending with no call_id', () => {
    const repo = createAgentActionsRepo(db);
    const row = repo.insertPending({
      ruleId: null,
      kind: 'place_call',
      targetDeviceId: deviceId,
      trigger: 'tool',
    });
    expect(row.result).toBe('pending');
    expect(row.call_id).toBeNull();
    expect(row.error).toBeNull();
    expect(row.finished_at).toBeNull();
  });

  test('attachCall sets the call_id on a pending action only', () => {
    const repo = createAgentActionsRepo(db);
    const action = repo.insertPending({
      ruleId: null,
      kind: 'place_call',
      targetDeviceId: deviceId,
      trigger: 'scheduled',
    });
    const attached = repo.attachCall(action.id, 'aabbccdd11223344');
    expect(attached?.call_id).toBe('aabbccdd11223344');

    // After the action finishes, attachCall is a no-op (the row matches
    // `result='pending'`).
    repo.finish({ id: action.id, result: 'answered', callId: null, error: null });
    expect(repo.attachCall(action.id, 'newer-call-id')).toBeNull();
  });

  test('finish moves the action to a terminal result and stamps finished_at', () => {
    const repo = createAgentActionsRepo(db);
    const action = repo.insertPending({
      ruleId: null,
      kind: 'place_call',
      targetDeviceId: deviceId,
      trigger: 'scheduled',
    });
    repo.attachCall(action.id, 'aabbccdd11223344');
    const finished = repo.finish({
      id: action.id,
      result: 'unanswered',
      callId: null,
      error: null,
    });
    expect(finished?.result).toBe('unanswered');
    expect(finished?.call_id).toBe('aabbccdd11223344');
    expect(finished?.finished_at).toBeTruthy();
  });

  test('finish returns null when the action is no longer pending', () => {
    const repo = createAgentActionsRepo(db);
    const action = repo.insertPending({
      ruleId: null,
      kind: 'voice_message',
      targetDeviceId: deviceId,
      trigger: 'tool',
    });
    repo.finish({ id: action.id, result: 'sent', callId: null, error: null });
    expect(
      repo.finish({ id: action.id, result: 'failed', callId: null, error: 'late' }),
    ).toBeNull();
  });

  test('finish can stamp an error string on failure', () => {
    const repo = createAgentActionsRepo(db);
    const action = repo.insertPending({
      ruleId: null,
      kind: 'place_call',
      targetDeviceId: deviceId,
      trigger: 'tool',
    });
    const finished = repo.finish({
      id: action.id,
      result: 'failed',
      callId: null,
      error: 'agent-offline',
    });
    expect(finished?.result).toBe('failed');
    expect(finished?.error).toBe('agent-offline');
  });

  test('findPendingByCallId returns the pending action that owns the call', () => {
    const repo = createAgentActionsRepo(db);
    const action = repo.insertPending({
      ruleId: null,
      kind: 'place_call',
      targetDeviceId: deviceId,
      trigger: 'scheduled',
    });
    repo.attachCall(action.id, 'callid-zzz');
    expect(repo.findPendingByCallId('callid-zzz')?.id).toBe(action.id);

    repo.finish({ id: action.id, result: 'answered', callId: null, error: null });
    expect(repo.findPendingByCallId('callid-zzz')).toBeNull();
  });

  test('listRecent returns rows most-recent first, optionally filtered by rule', () => {
    const rulesRepo = createAgentRulesRepo(db);
    const ruleA = rulesRepo.insert({
      name: 'r1',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'x',
      systemPrompt: null,
      nextFireAt: '2099-01-01T00:00:00',
      intervalSec: null,
      cooldownSec: 0,
    });
    const repo = createAgentActionsRepo(db);
    const a1 = repo.insertPending({
      ruleId: ruleA.id,
      kind: 'place_call',
      targetDeviceId: deviceId,
      trigger: 'scheduled',
    });
    const a2 = repo.insertPending({
      ruleId: null,
      kind: 'voice_message',
      targetDeviceId: deviceId,
      trigger: 'tool',
    });
    const a3 = repo.insertPending({
      ruleId: ruleA.id,
      kind: 'place_call',
      targetDeviceId: deviceId,
      trigger: 'scheduled',
    });

    expect(repo.listRecent(10).map((r) => r.id)).toEqual([a3.id, a2.id, a1.id]);
    expect(repo.listRecent(10, ruleA.id).map((r) => r.id)).toEqual([a3.id, a1.id]);
    expect(repo.listRecent(1).map((r) => r.id)).toEqual([a3.id]);
  });

  test('ON DELETE SET NULL preserves the action when its rule is deleted', () => {
    const rulesRepo = createAgentRulesRepo(db);
    const rule = rulesRepo.insert({
      name: 'r',
      enabled: true,
      targetDeviceId: deviceId,
      kind: 'place_call',
      body: 'x',
      systemPrompt: null,
      nextFireAt: '2099-01-01T00:00:00',
      intervalSec: null,
      cooldownSec: 0,
    });
    const repo = createAgentActionsRepo(db);
    const action = repo.insertPending({
      ruleId: rule.id,
      kind: 'place_call',
      targetDeviceId: deviceId,
      trigger: 'scheduled',
    });
    rulesRepo.deleteById(rule.id);
    expect(repo.findById(action.id)?.rule_id).toBeNull();
  });
});
