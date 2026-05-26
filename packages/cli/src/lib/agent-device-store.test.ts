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
