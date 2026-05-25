import { randomBytes } from 'node:crypto';
import { formatSqliteDateTime, parseSqliteDateTime } from '../auth/datetime.ts';
import type { DatabaseClient } from '../db/client.ts';
import type {
  FamilyPhonePairingRow,
  FamilyPhonePairingsRepo,
} from '../db/repos/family-phone-pairings.ts';
import type { FamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import type { FamilyPhoneDeviceKeysRepo } from '../db/repos/family-phone-device-keys.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';

/**
 * 60 seconds — the family-phone pair code is meant to be spoken aloud from
 * one device and typed into another, all in a single in-person interaction.
 * A short TTL keeps the attack window minimal; anyone who hears the code has
 * less than a minute to misuse it.
 */
export const FAMILY_PHONE_PAIR_TTL_MS = 60_000;

/**
 * Crockford-base32 alphabet (excludes I, L, O, U — visually ambiguous or
 * word-forming). Six characters → 30 bits of entropy; presented as XXX-XXX
 * for readability. Shorter than cli-pair's 8 chars because the TTL is much
 * tighter (60s vs 10min) — brute force is not the threat.
 */
const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_LENGTH = 6;

export function defaultRandomUserCode(): string {
  const bytes = randomBytes(USER_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    const byte = bytes[i] ?? 0;
    out += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/**
 * Tolerant parser. New-device users may type the code with or without the
 * dash; fold visually-ambiguous characters back to the canonical alphabet.
 * Returns null if, after folding, the code isn't 6 alphabet characters.
 */
export function normaliseUserCode(input: string): string | null {
  const folded = input
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .toUpperCase()
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0');
  if (folded.length !== USER_CODE_LENGTH) return null;
  for (const ch of folded) {
    if (!USER_CODE_ALPHABET.includes(ch)) return null;
  }
  return `${folded.slice(0, 3)}-${folded.slice(3)}`;
}

export type DeviceKind = 'handset' | 'pwa' | 'agent';

const ALLOWED_KINDS: ReadonlySet<DeviceKind> = new Set(['handset', 'pwa', 'agent']);

export interface FamilyPhonePairDeps {
  db: DatabaseClient;
  pairings: FamilyPhonePairingsRepo;
  devices: FamilyPhoneDevicesRepo;
  deviceKeys: FamilyPhoneDeviceKeysRepo;
  now: () => Date;
  randomUserCode: () => string;
}

export interface StartResult {
  userCode: string;
  expiresAt: string;
}

export interface CompleteResult {
  deviceId: number;
}

function isExpired(row: FamilyPhonePairingRow, now: Date): boolean {
  return parseSqliteDateTime(row.expires_at).getTime() <= now.getTime();
}

/**
 * Called by a trusted (already-authenticated) device that wants to add a new
 * device to the caller's family-phone roster. Mints a short-lived user_code
 * that the caller reads aloud to the new device.
 */
export function startCore(
  deps: FamilyPhonePairDeps,
  principal: Principal,
  input: { label: string; kind: DeviceKind },
): StartResult {
  const label = input.label.trim();
  if (label.length === 0) {
    throw new AuthError(400, 'label is required');
  }
  if (!ALLOWED_KINDS.has(input.kind)) {
    throw new AuthError(400, `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}`);
  }
  // The collision space is 32^6 = ~1B; the TTL is 60s; the active set is
  // bounded by family size. Four retries handle the practically-impossible
  // case while keeping the loop bounded.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const userCode = deps.randomUserCode();
    const current = deps.now();
    const expiresAt = formatSqliteDateTime(
      new Date(current.getTime() + FAMILY_PHONE_PAIR_TTL_MS),
    );
    try {
      deps.pairings.insert({
        userCode,
        userId: principal.userId,
        label,
        kind: input.kind,
        expiresAt,
      });
      return { userCode, expiresAt };
    } catch (err) {
      lastError = err;
    }
  }
  throw new AuthError(
    500,
    `family-phone pair start: could not mint a unique code (${String(lastError)})`,
  );
}

/**
 * Called by the new device with the user_code its user typed in and the
 * public half of a freshly-generated keypair. Consumes the pair request,
 * creates the device row, and records the public key — all atomically.
 */
export function completeCore(
  deps: FamilyPhonePairDeps,
  input: { userCode: string; publicKey: Uint8Array; alg: string },
): CompleteResult {
  if (input.publicKey.length === 0) {
    throw new AuthError(400, 'public_key is required');
  }
  if (input.alg.trim().length === 0) {
    throw new AuthError(400, 'alg is required');
  }
  const normalised = normaliseUserCode(input.userCode);
  if (!normalised) {
    throw new AuthError(400, 'user_code is malformed');
  }
  const row = deps.pairings.findByUserCode(normalised);
  if (!row) {
    throw new AuthError(404, 'user_code not found');
  }
  if (row.consumed_at !== null) {
    throw new AuthError(409, 'user_code already consumed');
  }
  const current = deps.now();
  if (isExpired(row, current)) {
    throw new AuthError(410, 'user_code expired');
  }

  // Atomic consume + device creation + key registration. If consume races
  // (another complete won), the inserts never run because markConsumed
  // returns false and we throw before reaching them.
  const txn = deps.db.transaction((): { deviceId: number } => {
    const consumed = deps.pairings.markConsumed({
      userCode: normalised,
      consumedAt: formatSqliteDateTime(current),
    });
    if (!consumed) {
      throw new AuthError(409, 'user_code already consumed');
    }
    const device = deps.devices.insert({
      userId: row.user_id,
      label: row.label,
      kind: row.kind,
      pairedAt: formatSqliteDateTime(current),
    });
    deps.deviceKeys.insert({
      deviceId: device.id,
      publicKey: input.publicKey,
      alg: input.alg,
    });
    return { deviceId: device.id };
  });
  return txn();
}
