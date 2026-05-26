import {
  createEalClient,
  type EalClient,
  type FamilyPhonePairCompleteResult,
} from '@eal/client';
import { readToken } from '../lib/token-store.ts';
import {
  agentDevicePath,
  writeAgentDevice,
  type AgentDeviceRecord,
} from '../lib/agent-device-store.ts';
import { readStringFlag } from '../lib/split-args.ts';
import { log, logError } from '../lib/process.ts';
import type { GlobalOptions } from '../types.ts';

/**
 * `eal agent pair-phone` — register the agent as a family-phone device.
 *
 * Generates an ECDSA P-256 key pair, sends the public key to the server
 * along with a user code the operator pasted from the devices panel,
 * then writes the resulting `device_id` + private key to disk so the
 * worker can authenticate as that device on every reconnect.
 *
 * The user code is minted elsewhere (`startFamilyPhonePair`, currently
 * the devices panel in the web app). This command only consumes it.
 */

const DEFAULT_LABEL = 'eal agent';

export interface PairPhoneDeps {
  client: EalClient;
  /** Generate a fresh ECDSA P-256 key pair. Returns SPKI public + PKCS8 private. */
  generateKeyPair: () => Promise<{ publicKeySpki: Uint8Array; privateKeyPkcs8: Uint8Array }>;
  writeRecord: (record: AgentDeviceRecord) => void;
  devicePath: () => string;
  log: (line: string) => void;
}

export interface PairPhoneResult {
  code: number;
  message: string;
  isError: boolean;
}

export async function agentPairPhoneCore(
  deps: PairPhoneDeps,
  input: { code: string | undefined; label: string | undefined },
): Promise<PairPhoneResult> {
  const code = input.code?.trim() ?? '';
  if (code.length === 0) {
    return {
      code: 1,
      isError: true,
      message:
        'eal agent pair-phone: --code=<user-code> is required (mint one from the devices panel)',
    };
  }
  const label = input.label?.trim() && input.label.trim().length > 0
    ? input.label.trim()
    : DEFAULT_LABEL;

  let keyPair;
  try {
    keyPair = await deps.generateKeyPair();
  } catch (err) {
    return {
      code: 1,
      isError: true,
      message: `eal agent pair-phone: could not generate keypair: ${describe(err)}`,
    };
  }

  const publicKeySpkiB64Url = toBase64Url(keyPair.publicKeySpki);
  let result: FamilyPhonePairCompleteResult;
  try {
    result = await deps.client.completeFamilyPhonePair({
      userCode: code,
      publicKey: publicKeySpkiB64Url,
      alg: 'ES256',
      label,
      kind: 'agent',
    });
  } catch (err) {
    return {
      code: 1,
      isError: true,
      message: `eal agent pair-phone: server rejected the pairing: ${describe(err)}`,
    };
  }

  const record: AgentDeviceRecord = {
    deviceId: result.deviceId,
    privateKeyPkcs8B64: toBase64(keyPair.privateKeyPkcs8),
    publicKeySpkiB64Url,
    label,
  };
  try {
    deps.writeRecord(record);
  } catch (err) {
    return {
      code: 1,
      isError: true,
      message: `eal agent pair-phone: paired but could not save device file: ${describe(err)}`,
    };
  }

  return {
    code: 0,
    isError: false,
    message:
      `eal agent pair-phone: paired as device ${result.deviceId} ` +
      `(label="${label}", stored at ${deps.devicePath()})`,
  };
}

async function generateRealKeyPair(): Promise<{
  publicKeySpki: Uint8Array;
  privateKeyPkcs8: Uint8Array;
}> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  return { publicKeySpki: spki, privateKeyPkcs8: pkcs8 };
}

function realDeps(global: GlobalOptions, token: string): PairPhoneDeps {
  const client = createEalClient(global.apiUrl, { token });
  return {
    client,
    generateKeyPair: generateRealKeyPair,
    writeRecord: (record) => writeAgentDevice(record),
    devicePath: () => agentDevicePath(),
    log,
  };
}

function emit(result: PairPhoneResult): number {
  if (result.isError) logError(result.message);
  else log(result.message);
  return result.code;
}

/** Dispatcher: `eal agent pair-phone`. */
export async function agentPairPhoneCommand(global: GlobalOptions): Promise<number> {
  const token = readToken(global.tokenPathOverride);
  if (token === null) {
    logError(
      'eal agent pair-phone: this host is not signed in — run `eal auth pair --label=<name>` first.',
    );
    return 1;
  }
  const code = readStringFlag(global.commandArgs, 'code');
  const label = readStringFlag(global.commandArgs, 'label');
  return emit(await agentPairPhoneCore(realDeps(global, token), { code, label }));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
