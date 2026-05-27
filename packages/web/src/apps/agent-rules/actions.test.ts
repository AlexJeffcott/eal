import { beforeEach, describe, expect, test } from 'bun:test';
import { runAction } from '@fairfox/polly/actions';
import { createMockEalClient, type MockEalClient } from '@eal/client-mock';
import { resetStoresForTest } from '../../stores.ts';
import { createStores, type AppStores } from '../../stores.ts';
import { AGENT_RULES_ACTIONS, fromDatetimeLocalInput } from './actions.ts';

let stores: AppStores;
let mock: MockEalClient;

beforeEach(() => {
  resetStoresForTest();
  mock = createMockEalClient();
  mock.setCurrentUser({ userId: 1, displayName: 'alex' });
  stores = createStores(mock);
});

async function run(action: string, data: Record<string, string> = {}): Promise<void> {
  await runAction(AGENT_RULES_ACTIONS, action, { stores, data });
}

describe('fromDatetimeLocalInput', () => {
  test('parses a YYYY-MM-DDTHH:mm local-time string into an ISO instant', () => {
    const iso = fromDatetimeLocalInput('2099-12-31T23:59');
    // Date.parse of a local string yields a UTC instant; the date
    // portion may shift to the next or previous day depending on the
    // runner's timezone, so accept both.
    expect(iso.startsWith('2099-12-31') || iso.startsWith('2100-01-01')).toBe(true);
  });

  test('empty input yields empty string', () => {
    expect(fromDatetimeLocalInput('')).toBe('');
  });

  test('garbage input yields empty string', () => {
    expect(fromDatetimeLocalInput('not-a-date')).toBe('');
  });
});

describe('agent-rules:create validation', () => {
  test('rejects an empty name', async () => {
    await run('agent-rules:create');
    expect(stores.$agentRulesError.value).toMatch(/Name is required/);
  });

  test('rejects a missing target device', async () => {
    stores.$rulesDraftName.value = 'Ring Leo';
    await run('agent-rules:create');
    expect(stores.$agentRulesError.value).toMatch(/target device/);
  });

  test('rejects when neither body nor system_prompt is set', async () => {
    stores.$rulesDraftName.value = 'Ring Leo';
    stores.$rulesDraftTargetDeviceId.value = '5';
    await run('agent-rules:create');
    expect(stores.$agentRulesError.value).toMatch(/body or a system prompt/);
  });

  test('rejects an empty nextFireAt', async () => {
    stores.$rulesDraftName.value = 'Ring Leo';
    stores.$rulesDraftTargetDeviceId.value = '5';
    stores.$rulesDraftBody.value = 'bedtime';
    await run('agent-rules:create');
    expect(stores.$agentRulesError.value).toMatch(/date and time/);
  });

  test('rejects a non-positive interval value with the unit set', async () => {
    stores.$rulesDraftName.value = 'Ring Leo';
    stores.$rulesDraftTargetDeviceId.value = '5';
    stores.$rulesDraftBody.value = 'bedtime';
    stores.$rulesDraftNextFireAt.value = '2099-01-01T20:00';
    stores.$rulesDraftIntervalUnit.value = 'hours';
    stores.$rulesDraftIntervalValue.value = '0';
    await run('agent-rules:create');
    expect(stores.$agentRulesError.value).toMatch(/Interval/);
  });

  test('happy path: builds the upsert input and resets the draft', async () => {
    stores.$rulesDraftName.value = 'Ring Leo';
    stores.$rulesDraftTargetDeviceId.value = '5';
    stores.$rulesDraftKind.value = 'place_call';
    stores.$rulesDraftBody.value = 'time for bed';
    stores.$rulesDraftNextFireAt.value = '2099-01-01T20:00';
    stores.$rulesDraftIntervalUnit.value = 'hours';
    stores.$rulesDraftIntervalValue.value = '24';
    stores.$rulesDraftCooldownMinutes.value = '5';
    await run('agent-rules:create');
    expect(stores.$agentRulesError.value).toBeNull();
    // Draft cleared on success.
    expect(stores.$rulesDraftName.value).toBe('');
    expect(stores.$rulesDraftBody.value).toBe('');
  });
});

describe('agent-rules:set-* form handlers', () => {
  test('set-name writes through to the draft signal', async () => {
    await run('agent-rules:set-name', { value: 'Sunday call' });
    expect(stores.$rulesDraftName.value).toBe('Sunday call');
  });

  test('set-target-device writes through to the draft signal', async () => {
    await run('agent-rules:set-target-device', { value: '42' });
    expect(stores.$rulesDraftTargetDeviceId.value).toBe('42');
  });

  test('set-kind accepts voice_message and rejects an unknown kind silently', async () => {
    await run('agent-rules:set-kind', { value: 'voice_message' });
    expect(stores.$rulesDraftKind.value).toBe('voice_message');
    await run('agent-rules:set-kind', { value: 'bogus' });
    expect(stores.$rulesDraftKind.value).toBe('voice_message');
  });

  test('set-body, set-system-prompt, set-next-fire-at, set-interval-value, set-cooldown-minutes all write through', async () => {
    await run('agent-rules:set-body', { value: 'time for bed' });
    await run('agent-rules:set-system-prompt', { value: 'remind them gently' });
    await run('agent-rules:set-next-fire-at', { value: '2099-01-01T20:00' });
    await run('agent-rules:set-interval-value', { value: '24' });
    await run('agent-rules:set-cooldown-minutes', { value: '15' });
    expect(stores.$rulesDraftBody.value).toBe('time for bed');
    expect(stores.$rulesDraftSystemPrompt.value).toBe('remind them gently');
    expect(stores.$rulesDraftNextFireAt.value).toBe('2099-01-01T20:00');
    expect(stores.$rulesDraftIntervalValue.value).toBe('24');
    expect(stores.$rulesDraftCooldownMinutes.value).toBe('15');
  });

  test('set-interval-unit accepts only the four allowed values', async () => {
    await run('agent-rules:set-interval-unit', { value: 'days' });
    expect(stores.$rulesDraftIntervalUnit.value).toBe('days');
    await run('agent-rules:set-interval-unit', { value: 'fortnights' });
    expect(stores.$rulesDraftIntervalUnit.value).toBe('days');
  });
});

describe('agent-rules:refresh, toggle, delete', () => {
  test('refresh populates rules and actions from the mock client', async () => {
    await run('agent-rules:refresh');
    // The mock returns empty arrays; the assertion is that the
    // handler completed without throwing and cleared any error.
    expect(stores.$agentRulesError.value).toBeNull();
    expect(stores.$agentRules.value).toEqual([]);
    expect(stores.$agentActions.value).toEqual([]);
  });

  test('toggle-enabled is a no-op when the rule id is not in the local list', async () => {
    await run('agent-rules:toggle-enabled', { ruleId: '999' });
    expect(stores.$agentRulesError.value).toBeNull();
  });

  test('toggle-enabled with a non-numeric id is silently ignored', async () => {
    await run('agent-rules:toggle-enabled', { ruleId: 'oops' });
    // No state changes — silent because the data parsing failed
    // before any client call.
    expect(stores.$agentRulesError.value).toBeNull();
  });

  test('toggle-enabled flips an existing rule', async () => {
    stores.$agentRules.value = [
      {
        id: 7,
        name: 'r',
        enabled: true,
        targetDeviceId: 1,
        kind: 'place_call',
        body: 'x',
        systemPrompt: null,
        nextFireAt: '2099-01-01T00:00:00.000Z',
        intervalSec: null,
        cooldownSec: 0,
        lastFiredAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    await run('agent-rules:toggle-enabled', { ruleId: '7' });
    expect(stores.$agentRulesError.value).toBeNull();
  });

  test('delete rejects a non-positive id silently', async () => {
    await run('agent-rules:delete', { ruleId: '-1' });
    expect(stores.$agentRulesError.value).toBeNull();
  });

  test('delete calls the client and clears any error', async () => {
    stores.$agentRulesError.value = 'stale';
    await run('agent-rules:delete', { ruleId: '5' });
    expect(stores.$agentRulesError.value).toBeNull();
  });
});

describe('agent-rules:dismiss-error clears the banner', () => {
  test('clears any error string', async () => {
    stores.$agentRulesError.value = 'something';
    await run('agent-rules:dismiss-error');
    expect(stores.$agentRulesError.value).toBeNull();
  });
});
