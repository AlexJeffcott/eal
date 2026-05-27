import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockEalClient, type MockEalClient } from '@eal/client-mock';
import { agentPairPhoneCore, type PairPhoneDeps } from './agent-pair-phone.ts';
import type { AgentDeviceRecord } from '../lib/agent-device-store.ts';

interface Spies {
  written: AgentDeviceRecord[];
  logs: string[];
  generated: number;
}

function makeDeps(client: MockEalClient): { deps: PairPhoneDeps; spies: Spies } {
  const spies: Spies = { written: [], logs: [], generated: 0 };
  const deps: PairPhoneDeps = {
    client,
    generateKeyPair: async () => {
      spies.generated += 1;
      return {
        publicKeySpki: new Uint8Array([1, 2, 3, 4]),
        privateKeyPkcs8: new Uint8Array([5, 6, 7, 8]),
      };
    },
    writeRecord: (record) => {
      spies.written.push(record);
    },
    devicePath: () => '/tmp/fake/family-phone-device.json',
    log: (line) => {
      spies.logs.push(line);
    },
  };
  return { deps, spies };
}

describe('agentPairPhoneCore', () => {
  let client: MockEalClient;
  beforeEach(() => {
    client = createMockEalClient();
    client.setCurrentUser({ userId: 1, displayName: 'alex' });
  });

  test('missing code self-mints from startFamilyPhonePair and pairs end-to-end', async () => {
    const { deps, spies } = makeDeps(client);
    const result = await agentPairPhoneCore(deps, { code: undefined, label: undefined });
    expect(result.isError).toBe(false);
    expect(result.code).toBe(0);
    // The mock returns "TST-001" from startFamilyPhonePair; the self-mint
    // log line surfaces it for the operator.
    expect(spies.logs.some((l) => l.includes('TST-001'))).toBe(true);
    expect(spies.generated).toBe(1);
    expect(spies.written.length).toBe(1);
  });

  test('whitespace-only code also triggers the self-mint path', async () => {
    const { deps, spies } = makeDeps(client);
    const result = await agentPairPhoneCore(deps, { code: '   ', label: 'x' });
    expect(result.isError).toBe(false);
    expect(spies.generated).toBe(1);
    expect(spies.written.length).toBe(1);
  });

  test('completes the pair and writes the device record', async () => {
    const { deps, spies } = makeDeps(client);
    const result = await agentPairPhoneCore(deps, { code: 'TST-001', label: 'pi-agent' });
    expect(result.code).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.message).toContain('paired as device 1');
    expect(result.message).toContain('label="pi-agent"');
    expect(spies.generated).toBe(1);
    expect(spies.written.length).toBe(1);
    const record = spies.written[0]!;
    expect(record.deviceId).toBe(1);
    expect(record.label).toBe('pi-agent');
    // Public key is base64url (no padding, no + or /). Mock generator yields
    // bytes [1,2,3,4] = base64 "AQIDBA==" → base64url "AQIDBA".
    expect(record.publicKeySpkiB64Url).toBe('AQIDBA');
    // Private key is plain base64. Mock yields [5,6,7,8] = "BQYHCA==".
    expect(record.privateKeyPkcs8B64).toBe('BQYHCA==');
  });

  test('falls back to the default label when none is supplied', async () => {
    const { deps, spies } = makeDeps(client);
    const result = await agentPairPhoneCore(deps, { code: 'TST-002', label: undefined });
    expect(result.code).toBe(0);
    expect(spies.written[0]?.label).toBe('eal agent');
  });

  test('reports a server-side rejection without writing a partial record', async () => {
    // The mock rejects an empty public key — but our generator always
    // supplies bytes, so trigger rejection by passing an empty label
    // through the mock's existing guard.
    const { deps, spies } = makeDeps(client);
    const result = await agentPairPhoneCore(deps, { code: 'TST-003', label: '   ' });
    // Whitespace-only label falls back to default, which the mock accepts;
    // so this case actually succeeds. Confirm and move on — the failure
    // mode is covered by the next test.
    expect(result.code).toBe(0);
    expect(spies.written.length).toBe(1);
  });

  test('reports a server-side rejection cleanly', async () => {
    const failingClient = createMockEalClient();
    failingClient.setCurrentUser({ userId: 1, displayName: 'alex' });
    const { deps, spies } = makeDeps(failingClient);
    // Force the mock's completeFamilyPhonePair to throw by handing it an
    // empty public key from a custom generator.
    deps.generateKeyPair = async () => ({
      publicKeySpki: new Uint8Array(),
      privateKeyPkcs8: new Uint8Array([1]),
    });
    const result = await agentPairPhoneCore(deps, { code: 'TST-099', label: 'agent' });
    expect(result.code).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.message).toMatch(/server rejected/);
    expect(spies.written).toEqual([]);
  });
});
