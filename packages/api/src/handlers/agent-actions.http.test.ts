import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { createAgentPhoneLockRepo } from '../db/repos/agent-phone-lock.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

interface ActionRecord {
  id: number;
  ruleId: number | null;
  kind: 'place_call' | 'voice_message';
  targetDeviceId: number;
  trigger: 'scheduled' | 'tool';
  result: 'pending' | 'answered' | 'unanswered' | 'rejected' | 'failed' | 'sent';
  callId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

function isActionRecord(value: unknown): value is ActionRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value && 'kind' in value && 'result' in value && 'trigger' in value)) {
    return false;
  }
  return (
    typeof value.id === 'number' &&
    (value.kind === 'place_call' || value.kind === 'voice_message') &&
    typeof value.result === 'string' &&
    (value.trigger === 'scheduled' || value.trigger === 'tool')
  );
}

function isActionResponse(value: unknown): value is { action: ActionRecord } {
  if (typeof value !== 'object' || value === null || !('action' in value)) return false;
  return isActionRecord(value.action);
}

function isActionsResponse(value: unknown): value is { actions: ActionRecord[] } {
  if (typeof value !== 'object' || value === null || !('actions' in value)) return false;
  if (!Array.isArray(value.actions)) return false;
  return value.actions.every(isActionRecord);
}

function isErrorResponse(value: unknown): value is { error: string } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  return typeof value.error === 'string';
}

function expectAction(value: unknown): ActionRecord {
  if (!isActionResponse(value)) {
    throw new Error(`expected { action }, got ${JSON.stringify(value)}`);
  }
  return value.action;
}

function expectError(value: unknown): string {
  if (!isErrorResponse(value)) {
    throw new Error(`expected { error }, got ${JSON.stringify(value)}`);
  }
  return value.error;
}

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

async function fetchJson(
  app: TestApp,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await app.handle(new Request(`https://localhost:3000${path}`, init));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

describe('agent actions http wire contract', () => {
  let db: DatabaseClient;
  let alex: Principal;
  let agentDeviceId: number;
  let targetDeviceId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
    const devices = createFamilyPhoneDevicesRepo(db);
    agentDeviceId = devices.insert({
      userId: u.id,
      label: 'agent',
      kind: 'agent',
    }).id;
    targetDeviceId = devices.insert({
      userId: u.id,
      label: 'leo handset',
      kind: 'handset',
    }).id;
  });

  test('POST /actions/place-call without auth returns 401', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'tool',
    });
    expect(res.status).toBe(401);
  });

  test('POST /actions/place-call returns 409 when no agent device is paired', async () => {
    // Remove the agent device the beforeEach created.
    createFamilyPhoneDevicesRepo(db).deleteById(agentDeviceId);
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'tool',
    });
    expect(res.status).toBe(409);
    expect(expectError(res.body)).toMatch(/no agent device/);
  });

  test('POST /actions/place-call inserts a pending action and claims the lock', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'tool',
    });
    expect(res.status).toBe(200);
    const action = expectAction(res.body);
    expect(action.result).toBe('pending');
    expect(action.targetDeviceId).toBe(targetDeviceId);
    expect(action.trigger).toBe('tool');
    expect(action.callId).toBeNull();

    const lock = createAgentPhoneLockRepo(db).findByDevice(agentDeviceId);
    expect(lock).not.toBeNull();
    expect(lock?.action_id).toBe(action.id);
  });

  test('POST /actions/place-call returns 409 when the lock is already held', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const first = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'tool',
    });
    expect(first.status).toBe(200);

    const second = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'tool',
    });
    expect(second.status).toBe(409);
    expect(expectError(second.body)).toMatch(/already on a call/);
  });

  test('POST /actions/place-call rejects an unknown target_device_id', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: 9999,
      trigger: 'tool',
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/unknown target_device_id/);
  });

  test('POST /actions/place-call rejects an unknown trigger', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'manual',
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/trigger/);
  });

  test('POST /actions/:id/attach-call sets the call_id on a pending action', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'tool',
    });
    const action = expectAction(created.body);
    const attached = await fetchJson(
      app,
      'POST',
      `/api/agent/actions/${action.id}/attach-call`,
      { call_id: 'aabbccdd11223344' },
    );
    expect(attached.status).toBe(200);
    expect(expectAction(attached.body).callId).toBe('aabbccdd11223344');
  });

  test('POST /actions/:id/finish moves to a terminal result and releases the lock', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'scheduled',
    });
    const action = expectAction(created.body);

    expect(createAgentPhoneLockRepo(db).findByDevice(agentDeviceId)).not.toBeNull();

    const finished = await fetchJson(
      app,
      'POST',
      `/api/agent/actions/${action.id}/finish`,
      { result: 'answered', call_id: 'aabbccdd11223344' },
    );
    expect(finished.status).toBe(200);
    expect(expectAction(finished.body).result).toBe('answered');
    expect(createAgentPhoneLockRepo(db).findByDevice(agentDeviceId)).toBeNull();
  });

  test('POST /actions/:id/finish rejects a "pending" result', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'tool',
    });
    const action = expectAction(created.body);
    const bogus = await fetchJson(
      app,
      'POST',
      `/api/agent/actions/${action.id}/finish`,
      { result: 'pending' },
    );
    expect(bogus.status).toBe(400);
    expect(expectError(bogus.body)).toMatch(/pending/);
  });

  test('POST /actions/:id/finish returns 404 when the action is already finished', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
      target_device_id: targetDeviceId,
      trigger: 'tool',
    });
    const action = expectAction(created.body);
    await fetchJson(app, 'POST', `/api/agent/actions/${action.id}/finish`, {
      result: 'answered',
    });
    const second = await fetchJson(
      app,
      'POST',
      `/api/agent/actions/${action.id}/finish`,
      { result: 'failed', error: 'late' },
    );
    expect(second.status).toBe(404);
  });

  test('GET /actions returns the most-recent actions, with rule filter', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    // Create three sequential actions, finishing each one so the lock
    // clears between calls.
    for (let i = 0; i < 3; i++) {
      const created = await fetchJson(app, 'POST', '/api/agent/actions/place-call', {
        target_device_id: targetDeviceId,
        trigger: i === 1 ? 'scheduled' : 'tool',
      });
      const id = expectAction(created.body).id;
      await fetchJson(app, 'POST', `/api/agent/actions/${id}/finish`, {
        result: 'answered',
      });
    }
    const list = await fetchJson(app, 'GET', '/api/agent/actions?limit=10');
    if (!isActionsResponse(list.body)) throw new Error('expected { actions }');
    expect(list.body.actions).toHaveLength(3);
    // Most recent first.
    expect(list.body.actions[0]?.id).toBeGreaterThan(list.body.actions[2]?.id ?? 0);
  });

  test('GET /actions rejects an absurd limit', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'GET', '/api/agent/actions?limit=99999');
    expect(res.status).toBe(400);
  });
});
