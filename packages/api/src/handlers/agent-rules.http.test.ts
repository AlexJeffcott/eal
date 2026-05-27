import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

interface RuleRecord {
  id: number;
  name: string;
  enabled: boolean;
  targetDeviceId: number;
  kind: 'place_call' | 'voice_message';
  body: string | null;
  systemPrompt: string | null;
  nextFireAt: string;
  intervalSec: number | null;
  cooldownSec: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function isRuleRecord(value: unknown): value is RuleRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value && 'name' in value && 'enabled' in value && 'kind' in value)) {
    return false;
  }
  return (
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean' &&
    (value.kind === 'place_call' || value.kind === 'voice_message')
  );
}

function isRuleResponse(value: unknown): value is { rule: RuleRecord } {
  if (typeof value !== 'object' || value === null || !('rule' in value)) return false;
  return isRuleRecord(value.rule);
}

function isRulesResponse(value: unknown): value is { rules: RuleRecord[] } {
  if (typeof value !== 'object' || value === null || !('rules' in value)) return false;
  if (!Array.isArray(value.rules)) return false;
  return value.rules.every(isRuleRecord);
}

function isErrorResponse(value: unknown): value is { error: string } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  return typeof value.error === 'string';
}

function isDeleteResponse(value: unknown): value is { deleted: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'deleted' in value &&
    value.deleted === true
  );
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

function expectRule(value: unknown): RuleRecord {
  if (!isRuleResponse(value)) throw new Error(`expected { rule }, got ${JSON.stringify(value)}`);
  return value.rule;
}

function expectError(value: unknown): string {
  if (!isErrorResponse(value)) throw new Error(`expected { error }, got ${JSON.stringify(value)}`);
  return value.error;
}

describe('agent rules http wire contract', () => {
  let db: DatabaseClient;
  let alex: Principal;
  let deviceId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
    deviceId = createFamilyPhoneDevicesRepo(db).insert({
      userId: u.id,
      label: 'leo handset',
      kind: 'handset',
    }).id;
  });

  test('GET /api/agent/rules rejects unauthenticated requests with 401', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await fetchJson(app, 'GET', '/api/agent/rules');
    expect(res.status).toBe(401);
  });

  test('GET /api/agent/rules returns an empty list when none exist', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'GET', '/api/agent/rules');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rules: [] });
  });

  test('POST /api/agent/rules creates a rule and returns it in camelCase', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/rules', {
      name: 'ring leo at bedtime',
      enabled: true,
      target_device_id: deviceId,
      kind: 'place_call',
      body: 'time for bed',
      next_fire_at: '2099-01-01T20:00:00',
      interval_sec: 86_400,
      cooldown_sec: 0,
    });
    expect(res.status).toBe(200);
    const rule = expectRule(res.body);
    expect(rule.name).toBe('ring leo at bedtime');
    expect(rule.enabled).toBe(true);
    expect(rule.targetDeviceId).toBe(deviceId);
    expect(rule.kind).toBe('place_call');
    expect(rule.body).toBe('time for bed');
    expect(rule.systemPrompt).toBeNull();
    expect(rule.intervalSec).toBe(86_400);
  });

  test('POST /api/agent/rules with neither body nor system_prompt returns 400', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/rules', {
      name: 'broken',
      enabled: true,
      target_device_id: deviceId,
      kind: 'place_call',
      next_fire_at: '2099-01-01T00:00:00',
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/body or system_prompt/);
  });

  test('POST /api/agent/rules with unknown target device returns 400', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/rules', {
      name: 'broken',
      enabled: true,
      target_device_id: 9999,
      kind: 'place_call',
      body: 'x',
      next_fire_at: '2099-01-01T00:00:00',
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/unknown target_device_id/);
  });

  test('POST /api/agent/rules with kind="bogus" returns 400', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/rules', {
      name: 'broken',
      enabled: true,
      target_device_id: deviceId,
      kind: 'bogus',
      body: 'x',
      next_fire_at: '2099-01-01T00:00:00',
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/place_call/);
  });

  test('POST /api/agent/rules with non-positive interval_sec returns 400', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/rules', {
      name: 'broken',
      enabled: true,
      target_device_id: deviceId,
      kind: 'voice_message',
      body: 'x',
      next_fire_at: '2099-01-01T00:00:00',
      interval_sec: 0,
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/interval_sec/);
  });

  test('POST /api/agent/rules with id updates the existing rule', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/agent/rules', {
      name: 'first',
      enabled: false,
      target_device_id: deviceId,
      kind: 'voice_message',
      body: 'hi',
      next_fire_at: '2099-01-01T00:00:00',
    });
    const id = expectRule(created.body).id;
    const updated = await fetchJson(app, 'POST', '/api/agent/rules', {
      id,
      name: 'second',
      enabled: true,
      target_device_id: deviceId,
      kind: 'place_call',
      system_prompt: 'remind them',
      next_fire_at: '2099-02-01T00:00:00',
    });
    expect(updated.status).toBe(200);
    const rule = expectRule(updated.body);
    expect(rule.id).toBe(id);
    expect(rule.name).toBe('second');
    expect(rule.enabled).toBe(true);
    expect(rule.kind).toBe('place_call');
    expect(rule.body).toBeNull();
    expect(rule.systemPrompt).toBe('remind them');
  });

  test('POST /api/agent/rules with unknown id returns 404', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/agent/rules', {
      id: 9999,
      name: 'ghost',
      enabled: true,
      target_device_id: deviceId,
      kind: 'place_call',
      body: 'x',
      next_fire_at: '2099-01-01T00:00:00',
    });
    expect(res.status).toBe(404);
  });

  test('GET then DELETE round-trip returns deleted=true and clears the list', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/agent/rules', {
      name: 'doomed',
      enabled: true,
      target_device_id: deviceId,
      kind: 'place_call',
      body: 'x',
      next_fire_at: '2099-01-01T00:00:00',
    });
    const id = expectRule(created.body).id;

    const list = await fetchJson(app, 'GET', '/api/agent/rules');
    if (!isRulesResponse(list.body)) throw new Error('expected { rules }');
    expect(list.body.rules).toHaveLength(1);

    const del = await fetchJson(app, 'DELETE', `/api/agent/rules/${id}`);
    expect(del.status).toBe(200);
    expect(isDeleteResponse(del.body)).toBe(true);

    const empty = await fetchJson(app, 'GET', '/api/agent/rules');
    if (!isRulesResponse(empty.body)) throw new Error('expected { rules }');
    expect(empty.body.rules).toEqual([]);
  });

  test('DELETE with an unknown id returns 404', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'DELETE', '/api/agent/rules/9999');
    expect(res.status).toBe(404);
  });
});
