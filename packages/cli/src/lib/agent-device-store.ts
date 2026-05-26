/**
 * On-disk record of the agent's family-phone device identity.
 *
 * The agent worker holds an ECDSA P-256 key pair so it can authenticate
 * to the family-phone WS as a device of kind `'agent'`. Pairing happens
 * once via `eal agent pair-phone`; from then on this file is the
 * worker's identity on the call network.
 *
 * Mirrors `token-store.ts`: same path convention, same 0600 mode, same
 * `EAL_AGENT_DEVICE_PATH` env override so tests can point elsewhere.
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  chmodSync,
} from 'node:fs';

export interface AgentDeviceRecord {
  deviceId: number;
  /** PKCS8-encoded ECDSA P-256 private key, base64 (not url-safe). */
  privateKeyPkcs8B64: string;
  /** SPKI-encoded ECDSA P-256 public key, base64url — what the server stored. */
  publicKeySpkiB64Url: string;
  /** Human-readable label this device was paired under. */
  label: string;
}

export function agentDevicePath(override?: string | undefined): string {
  if (override && override.length > 0) return override;
  const env = process.env['EAL_AGENT_DEVICE_PATH'];
  if (env && env.length > 0) return env;
  return join(homedir(), '.config', 'eal', 'family-phone-device.json');
}

export function readAgentDevice(override?: string | undefined): AgentDeviceRecord | null {
  const path = agentDevicePath(override);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isAgentDeviceRecord(parsed)) return null;
  return parsed;
}

export function writeAgentDevice(
  record: AgentDeviceRecord,
  override?: string | undefined,
): void {
  const path = agentDevicePath(override);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX permissions.
  }
}

export function deleteAgentDevice(override?: string | undefined): boolean {
  const path = agentDevicePath(override);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function isAgentDeviceRecord(value: unknown): value is AgentDeviceRecord {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'deviceId' in value &&
    typeof value.deviceId === 'number' &&
    'privateKeyPkcs8B64' in value &&
    typeof value.privateKeyPkcs8B64 === 'string' &&
    'publicKeySpkiB64Url' in value &&
    typeof value.publicKeySpkiB64Url === 'string' &&
    'label' in value &&
    typeof value.label === 'string'
  );
}
