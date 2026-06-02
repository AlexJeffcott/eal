/**
 * Phase 7D — per-CallSid record of "did any handset actually answer
 * this PSTN call?" The bridge writes the outcome when its stream
 * terminates; the `<Connect action>` callback reads it to decide
 * whether Twilio should proceed to a `<Record>` (unanswered) or just
 * end the call (answered).
 *
 * In-memory: a single-machine deploy is the only target today, and
 * each entry is short-lived (the action callback fires within seconds
 * of the bridge closing). Entries are pruned by an idle TTL so a
 * crashed bridge never leaks the map.
 *
 * For voicemail routing, the entry also carries the inbox the
 * voicemail should land in if the call was unanswered:
 *   - `userDeviceIds` — fan out a row per device the chosen recipient
 *     owns (set when known caller / IVR routed to that user)
 *   - `householdDeviceId` — single row for the unrouted fallback
 */
export type PstnCallOutcome = 'answered' | 'unanswered';

export interface PstnCallRecord {
  outcome: PstnCallOutcome;
  fromE164: string;
  /** Where the voicemail row(s) should land if the call was unanswered. */
  voicemailTarget:
    | { kind: 'household'; householdDeviceId: number }
    | { kind: 'user'; userId: number; deviceIds: number[] };
  recordedAt: number;
}

export interface PstnCallOutcomes {
  /** Stash the voicemail target up front, before the call connects. */
  prime(callSid: string, target: PstnCallRecord['voicemailTarget'], fromE164: string): void;
  /** Record whether any handset answered before the stream terminated. */
  setOutcome(callSid: string, outcome: PstnCallOutcome): void;
  /** Read whatever's known about this CallSid; null if nothing was primed. */
  get(callSid: string): PstnCallRecord | null;
  /** Forget a CallSid (the recording webhook calls this after persistence). */
  drop(callSid: string): void;
}

const DEFAULT_TTL_MS = 10 * 60_000;

export function createPstnCallOutcomes(opts: { ttlMs?: number; now?: () => number } = {}): PstnCallOutcomes {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? ((): number => Date.now());
  const records = new Map<string, PstnCallRecord>();

  function prune(): void {
    const cutoff = now() - ttl;
    for (const [sid, rec] of records) {
      if (rec.recordedAt < cutoff) records.delete(sid);
    }
  }

  return {
    prime(callSid, target, fromE164): void {
      prune();
      records.set(callSid, {
        outcome: 'unanswered',
        fromE164,
        voicemailTarget: target,
        recordedAt: now(),
      });
    },
    setOutcome(callSid, outcome): void {
      const existing = records.get(callSid);
      if (!existing) return;
      records.set(callSid, { ...existing, outcome, recordedAt: now() });
    },
    get(callSid): PstnCallRecord | null {
      const r = records.get(callSid);
      return r ?? null;
    },
    drop(callSid): void {
      records.delete(callSid);
    },
  };
}
