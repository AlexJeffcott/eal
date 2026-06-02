import type { DatabaseClient } from '../client.ts';

/**
 * One row per inbound PSTN call attempt the voice webhook saw. The
 * rate limiter writes a row before deciding whether to allow the call
 * through to the bridge or hand Twilio a `<Reject>` — counting rows
 * within a sliding window from the same source E.164 is the gate.
 *
 * Append-only by design: deciding the limit is a count, not an upsert,
 * and an old row never needs to be revised. A cleanup pass (out of
 * scope here) can prune anything older than the window when the table
 * grows large enough to matter for disk.
 */
export interface PstnCallRow {
  id: number;
  source_e164: string;
  created_at: string;
}

export interface PstnCallsRepo {
  /** Record one inbound call attempt. Returns the inserted row. */
  recordInbound(sourceE164: string): PstnCallRow;
  /**
   * Count rows from this source whose created_at is >= sinceIso. SQLite
   * compares TEXT timestamps lexicographically, which is correct as
   * long as both ends are the same `YYYY-MM-DD HH:MM:SS` shape the
   * `datetime('now')` default emits.
   */
  countSince(sourceE164: string, sinceIso: string): number;
}

interface CountRow {
  n: number;
}

export function createPstnCallsRepo(db: DatabaseClient): PstnCallsRepo {
  const insertStmt = db.prepare<PstnCallRow, [string]>(
    `INSERT INTO family_phone_pstn_calls (source_e164)
     VALUES (?)
     RETURNING id, source_e164, created_at`,
  );
  const countStmt = db.prepare<CountRow, [string, string]>(
    `SELECT COUNT(*) AS n
       FROM family_phone_pstn_calls
      WHERE source_e164 = ?
        AND created_at >= ?`,
  );
  return {
    recordInbound(sourceE164): PstnCallRow {
      const row = insertStmt.get(sourceE164);
      if (!row) throw new Error('family_phone_pstn_calls.recordInbound: RETURNING gave no row');
      return row;
    },
    countSince(sourceE164, sinceIso): number {
      const row = countStmt.get(sourceE164, sinceIso);
      return row?.n ?? 0;
    },
  };
}
