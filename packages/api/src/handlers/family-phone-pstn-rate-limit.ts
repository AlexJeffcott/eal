/**
 * Phase 7D — per-source-E.164 rate limit for the inbound Twilio voice
 * webhook. A misconfigured re-dialer or a hostile dialler can hammer
 * the household trunk; a sliding-window cap keeps the actual handsets
 * from ringing fifty times a minute.
 *
 * The check runs only on inbound calls (Twilio's TwiML fetch for our
 * own outbound dials carries our own number as `From`, which would
 * trivially throttle our own UI). The webhook records the attempt
 * before deciding so a burst of N+1 calls is counted as N+1, not N.
 *
 * Pure module: no env reads, no DB beyond the repo handle it's given.
 * The defaults are policy — 10 calls per 60s per remote E.164 — and
 * are overridable for tests.
 */
import type { PstnCallsRepo } from '../db/repos/family-phone-pstn-calls.ts';

export const DEFAULT_INBOUND_WINDOW_MS = 60_000;
export const DEFAULT_INBOUND_MAX_CALLS = 10;

export interface PstnInboundRateLimitDeps {
  calls: PstnCallsRepo;
  /** Sliding-window length in milliseconds. Defaults to 60s. */
  windowMs?: number;
  /** Cap on calls from one source inside the window. Defaults to 10. */
  maxCalls?: number;
  /** Clock injection point. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface PstnInboundRateLimiter {
  /**
   * Record an inbound call attempt from `source` (E.164) and return
   * whether it should be allowed. Always records — over-limit attempts
   * still count, so the limiter does not silently flatten a burst.
   */
  check(source: string): { allowed: boolean; count: number; windowMs: number; max: number };
}

const SQLITE_TS_RE = /T|\..*$|Z$/g;

/** Format a Date as the same `YYYY-MM-DD HH:MM:SS` shape SQLite's
 *  `datetime('now')` default emits, so a lexicographic comparison in
 *  the repo's `created_at >= ?` predicate is correct. */
function toSqliteTs(d: Date): string {
  return d.toISOString().replace(SQLITE_TS_RE, (m) => (m === 'T' ? ' ' : ''));
}

export function createPstnInboundRateLimiter(
  deps: PstnInboundRateLimitDeps,
): PstnInboundRateLimiter {
  const windowMs = deps.windowMs ?? DEFAULT_INBOUND_WINDOW_MS;
  const maxCalls = deps.maxCalls ?? DEFAULT_INBOUND_MAX_CALLS;
  const now = deps.now ?? ((): Date => new Date());
  return {
    check(source): { allowed: boolean; count: number; windowMs: number; max: number } {
      deps.calls.recordInbound(source);
      const cutoff = toSqliteTs(new Date(now().getTime() - windowMs));
      const count = deps.calls.countSince(source, cutoff);
      return { allowed: count <= maxCalls, count, windowMs, max: maxCalls };
    },
  };
}
