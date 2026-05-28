import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentDevicePath,
  deleteAgentDevice,
  readAgentDevice,
  writeAgentDevice,
  type AgentDeviceRecord,
} from './agent-device-store.ts';

describe('agent-device-store', () => {
  let dir: string;
  let path: string;
  let priorEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eal-agent-device-'));
    path = join(dir, 'family-phone-device.json');
    priorEnv = process.env['EAL_AGENT_DEVICE_PATH'];
    process.env['EAL_AGENT_DEVICE_PATH'] = path;
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env['EAL_AGENT_DEVICE_PATH'];
    else process.env['EAL_AGENT_DEVICE_PATH'] = priorEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  test('agentDevicePath honours an explicit override over the env var', () => {
    expect(agentDevicePath('/some/where/else.json')).toBe('/some/where/else.json');
    expect(agentDevicePath()).toBe(path);
  });

  test('agentDevicePath ignores an empty-string override and falls back to env', () => {
    expect(agentDevicePath('')).toBe(path);
  });

  test('agentDevicePath ignores an empty env var and falls back to the default', () => {
    process.env['EAL_AGENT_DEVICE_PATH'] = '';
    const fallback = agentDevicePath();
    expect(fallback.endsWith('.config/eal/family-phone-device.json')).toBe(true);
  });

  test('readAgentDevice returns null when the file does not exist', () => {
    expect(readAgentDevice()).toBeNull();
  });

  test('writeAgentDevice round-trips a record at mode 0600', () => {
    const record: AgentDeviceRecord = {
      deviceId: 42,
      privateKeyPkcs8B64: 'AAAA',
      publicKeySpkiB64Url: 'BBBB-CCCC',
      label: 'eal agent',
    };
    writeAgentDevice(record);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readAgentDevice()).toEqual(record);
  });

  test('readAgentDevice rejects a malformed file rather than throwing', () => {
    writeAgentDevice({
      deviceId: 1,
      privateKeyPkcs8B64: 'k',
      publicKeySpkiB64Url: 'p',
      label: 'l',
    });
    writeFileSync(path, '{ not valid json', 'utf8');
    expect(readAgentDevice()).toBeNull();
  });

  test('readAgentDevice rejects a JSON object with missing fields', () => {
    writeFileSync(path, JSON.stringify({ deviceId: 1, label: 'l' }), 'utf8');
    expect(readAgentDevice()).toBeNull();
  });

  test('readAgentDevice rejects a non-object payload', () => {
    writeFileSync(path, JSON.stringify('a string'), 'utf8');
    expect(readAgentDevice()).toBeNull();
  });

  test('readAgentDevice rejects a JSON null payload', () => {
    writeFileSync(path, JSON.stringify(null), 'utf8');
    expect(readAgentDevice()).toBeNull();
  });

  test.each([
    ['deviceId', 'not-a-number'],
    ['privateKeyPkcs8B64', 7],
    ['publicKeySpkiB64Url', false],
    ['label', null],
  ] as const)('readAgentDevice rejects a record with wrong-typed %s', (field, badValue) => {
    const good: AgentDeviceRecord = {
      deviceId: 1,
      privateKeyPkcs8B64: 'k',
      publicKeySpkiB64Url: 'p',
      label: 'l',
    };
    writeFileSync(path, JSON.stringify({ ...good, [field]: badValue }), 'utf8');
    expect(readAgentDevice()).toBeNull();
  });

  test.each(['deviceId', 'privateKeyPkcs8B64', 'publicKeySpkiB64Url', 'label'] as const)(
    'readAgentDevice rejects a record missing %s',
    (field) => {
      const good: AgentDeviceRecord = {
        deviceId: 1,
        privateKeyPkcs8B64: 'k',
        publicKeySpkiB64Url: 'p',
        label: 'l',
      };
      const { [field]: _omitted, ...partial } = good;
      writeFileSync(path, JSON.stringify(partial), 'utf8');
      expect(readAgentDevice()).toBeNull();
    },
  );

  test('writeAgentDevice creates the parent directory recursively', () => {
    const nested = join(dir, 'a', 'b', 'c', 'family-phone-device.json');
    writeAgentDevice(
      {
        deviceId: 1,
        privateKeyPkcs8B64: 'k',
        publicKeySpkiB64Url: 'p',
        label: 'l',
      },
      nested,
    );
    expect(existsSync(nested)).toBe(true);
  });

  test('deleteAgentDevice removes the file and reports success', () => {
    expect(deleteAgentDevice()).toBe(false);
    writeAgentDevice({
      deviceId: 7,
      privateKeyPkcs8B64: 'x',
      publicKeySpkiB64Url: 'y',
      label: 'l',
    });
    expect(deleteAgentDevice()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
