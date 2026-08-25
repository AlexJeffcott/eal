import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Registration gate.
 *
 * eal is deployed on a public origin. Without a gate, anyone who finds the
 * hostname can register a passkey and — because `authorize()` grants every
 * household member every action on every task — read and write the whole task
 * list. This module holds the policy; `registerOptionsCore` enforces it.
 *
 * Fail closed: with no `EAL_INVITE_CODE` configured, registration is refused
 * outright. There is no default code and no open mode. Login is unaffected —
 * credentials already registered keep working whatever this reads.
 */

/** Shortest invite code the boot will accept. A code guessed is an account. */
export const MIN_INVITE_CODE_LENGTH = 16;

export interface RegistrationConfig {
  /** The code a registrant must present. `null` closes registration. */
  inviteCode: string | null;
}

/**
 * Read the gate's config from an environment. Throws when the code is present
 * but too short — a half-strength secret is worse than a closed door, because
 * it reads as protection.
 */
export function loadRegistrationConfig(env: NodeJS.ProcessEnv): RegistrationConfig {
  const raw = env['EAL_INVITE_CODE']?.trim() ?? '';
  if (raw === '') return { inviteCode: null };
  if (raw.length < MIN_INVITE_CODE_LENGTH) {
    throw new Error(
      `EAL_API: EAL_INVITE_CODE is ${raw.length} characters — the minimum is ` +
        `${MIN_INVITE_CODE_LENGTH}. A short code is guessable, and a guessed code ` +
        'mints an account that can read and write every task.',
    );
  }
  return { inviteCode: raw };
}

/**
 * Compare a presented code against the configured one in constant time.
 *
 * Both sides are hashed first. `timingSafeEqual` throws on unequal lengths, and
 * the length of the real code is itself worth hiding, so comparing two 32-byte
 * digests keeps the work independent of the input.
 */
export function inviteCodeMatches(expected: string, presented: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Failures allowed inside one window before the gate refuses everyone. */
export const DEFAULT_MAX_FAILURES = 10;
/** Sliding-window length for the failure count. */
export const DEFAULT_FAILURE_WINDOW_MS = 10 * 60_000;

export interface RegistrationThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  /** Clock injection point. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RegistrationThrottleState {
  allowed: boolean;
  failures: number;
  /** Seconds until the oldest failure leaves the window. 0 when allowed. */
  retryAfterSec: number;
}

export interface RegistrationThrottle {
  /** Read the gate without recording anything. */
  check(): RegistrationThrottleState;
  /** Record one wrong code. */
  recordFailure(): void;
}

/**
 * A sliding-window cap on **failed** invite-code attempts.
 *
 * The count is global, not per source address. Behind a proxy the client
 * address is a forwarded header, which a caller can set to anything, so a
 * per-address cap is evaded by rotating the header. A global cap cannot be.
 * The cost is that a prober can lock the household out of *registering* for
 * one window — a rare operation, and login is never affected.
 */
export function createRegistrationThrottle(
  options: RegistrationThrottleOptions = {},
): RegistrationThrottle {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = options.windowMs ?? DEFAULT_FAILURE_WINDOW_MS;
  const now = options.now ?? ((): number => Date.now());
  let failures: number[] = [];

  function prune(at: number): void {
    const cutoff = at - windowMs;
    failures = failures.filter((t) => t > cutoff);
  }

  return {
    check(): RegistrationThrottleState {
      const at = now();
      prune(at);
      if (failures.length < maxFailures) {
        return { allowed: true, failures: failures.length, retryAfterSec: 0 };
      }
      const oldest = failures[0] ?? at;
      const waitMs = Math.max(0, oldest + windowMs - at);
      return {
        allowed: false,
        failures: failures.length,
        retryAfterSec: Math.ceil(waitMs / 1000),
      };
    },
    recordFailure(): void {
      const at = now();
      prune(at);
      failures.push(at);
    },
  };
}
