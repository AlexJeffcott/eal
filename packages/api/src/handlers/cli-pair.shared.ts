import { randomBytes } from 'node:crypto';
import { sha256 } from '../auth/hash.ts';
import { formatSqliteDateTime, parseSqliteDateTime } from '../auth/datetime.ts';
import type { SessionsRepo } from '../auth/sessions.ts';
import type { CliPairingsRepo, CliPairingRow } from '../db/repos/cli-pairings.ts';
import type { UsersRepo } from '../db/repos/users.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';

/** 10 minutes — the device_code/user_code are short-lived authorization handles. */
export const CLI_PAIR_TTL_MS = 10 * 60_000;
/** 90 days — the session the CLI ends up holding. Longer than 'spa' (30d). */
export const CLI_SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
/** CLI's poll cadence hint. The server enforces nothing — the field is advisory. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * Crockford-base32 alphabet (excludes I, L, O, U — visually ambiguous or word-forming).
 * Eight characters → 40 bits of entropy; presented as XXXX-XXXX for readability.
 */
const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_LENGTH = 8;

export function defaultRandomUserCode(): string {
  const bytes = randomBytes(USER_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    const byte = bytes[i] ?? 0;
    out += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function defaultRandomDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Tolerant user_code parser. Browser inputs come from humans — strip dashes,
 * uppercase, fold visually-ambiguous characters back to the canonical alphabet.
 * Returns null if, after folding, the code isn't 8 alphabet characters.
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
  return `${folded.slice(0, 4)}-${folded.slice(4)}`;
}

export interface CliPairDeps {
  sessions: SessionsRepo;
  pairings: CliPairingsRepo;
  users: UsersRepo;
  now: () => Date;
  randomUserCode: () => string;
  randomDeviceCode: () => string;
}

export interface StartResult {
  userCode: string;
  deviceCode: string;
  verificationUrl: string;
  pollIntervalMs: number;
  expiresAtIso: string;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'authorized'; token: string; user: { id: number; displayName: string } }
  | { status: 'expired' };

/**
 * Build the verification URL the CLI prints. The page lives under `/public/`
 * so the auth-by-default gate doesn't 401 anonymous visitors before they sign
 * in. The `?code=` query lets us pre-fill the form for users who follow the
 * link from their CLI terminal.
 */
export function buildVerificationUrl(baseUrl: string, userCode: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/public/auth/cli-pair?code=${encodeURIComponent(userCode)}`;
}

function isExpired(row: CliPairingRow, now: Date): boolean {
  return parseSqliteDateTime(row.expires_at).getTime() <= now.getTime();
}

export function startCore(
  deps: CliPairDeps,
  ctx: { baseUrl: string },
): StartResult {
  // 4 retries handle the astronomically-unlikely event of a user_code collision.
  // The alphabet is 8 × log2(32) = 40 bits, so collisions are practically
  // impossible — but the loop is bounded so we never spin forever.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const userCode = deps.randomUserCode();
    const deviceCode = deps.randomDeviceCode();
    const deviceCodeHash = sha256(deviceCode);
    const current = deps.now();
    const expiresAt = formatSqliteDateTime(new Date(current.getTime() + CLI_PAIR_TTL_MS));
    try {
      deps.pairings.insert({ deviceCodeHash, userCode, expiresAt });
      return {
        userCode,
        deviceCode,
        verificationUrl: buildVerificationUrl(ctx.baseUrl, userCode),
        pollIntervalMs: POLL_INTERVAL_MS,
        expiresAtIso: new Date(current.getTime() + CLI_PAIR_TTL_MS).toISOString(),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new AuthError(500, `cli-pair start: could not mint a unique code (${String(lastError)})`);
}

export function claimCore(
  deps: CliPairDeps,
  principal: Principal,
  input: { userCode: string; label: string },
): { ok: true } {
  if (!input.label || input.label.trim().length === 0) {
    throw new AuthError(400, 'label is required');
  }
  const normalised = normaliseUserCode(input.userCode);
  if (!normalised) {
    throw new AuthError(400, 'user_code is malformed');
  }
  const row = deps.pairings.findByUserCode(normalised);
  if (!row) {
    throw new AuthError(404, 'user_code not found');
  }
  if (isExpired(row, deps.now())) {
    throw new AuthError(410, 'user_code expired');
  }
  if (row.user_id !== null) {
    throw new AuthError(409, 'user_code already claimed');
  }
  const claimed = deps.pairings.markClaimed({
    userCode: normalised,
    userId: principal.userId,
    label: input.label.trim(),
  });
  if (!claimed) {
    // Race lost — another claim landed between our find and our update.
    throw new AuthError(409, 'user_code already claimed');
  }
  return { ok: true };
}

export function pollCore(
  deps: CliPairDeps,
  input: { deviceCode: string },
): PollResult {
  const deviceCodeHash = sha256(input.deviceCode);
  const row = deps.pairings.findByDeviceCodeHash(deviceCodeHash);
  if (!row) return { status: 'expired' };
  if (row.consumed_at !== null) return { status: 'expired' };
  const current = deps.now();
  if (isExpired(row, current)) return { status: 'expired' };
  if (row.user_id === null) return { status: 'pending' };

  // markConsumed is single-shot: if two polls race, only one flips
  // consumed_at to non-null. The loser sees the row come back consumed
  // on its next find and returns expired.
  const consumed = deps.pairings.markConsumed({
    deviceCodeHash,
    consumedAt: formatSqliteDateTime(current),
  });
  if (!consumed) return { status: 'expired' };

  const user = deps.users.findById(row.user_id);
  if (!user) {
    // Cascading delete already removed the user — treat the pair as expired
    // rather than panicking. The CLI will report 'expired' and the user
    // re-pairs.
    return { status: 'expired' };
  }

  const minted = deps.sessions.mint({
    userId: user.id,
    ttlMs: CLI_SESSION_TTL_MS,
    label: row.label ?? 'cli',
  });

  return {
    status: 'authorized',
    token: minted.token,
    user: { id: user.id, displayName: user.display_name },
  };
}
