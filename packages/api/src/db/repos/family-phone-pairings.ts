import type { DatabaseClient } from '../client.ts';

export interface FamilyPhonePairingRow {
  id: number;
  user_code: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface FamilyPhonePairingsRepo {
  insert(input: { userCode: string; userId: number; expiresAt: string }): FamilyPhonePairingRow;
  findByUserCode(userCode: string): FamilyPhonePairingRow | null;
  /**
   * Single-shot conditional update — flips consumed_at only when the row is
   * still un-consumed. Two simultaneous completes of the same user_code
   * cannot both succeed; the loser sees the row return null on its next find.
   */
  markConsumed(input: { userCode: string; consumedAt: string }): boolean;
  deleteExpired(now: string): number;
}

export function createFamilyPhonePairingsRepo(db: DatabaseClient): FamilyPhonePairingsRepo {
  const insertStmt = db.prepare<FamilyPhonePairingRow, [string, number, string]>(
    `INSERT INTO family_phone_pair_requests (user_code, user_id, expires_at)
     VALUES (?, ?, ?)
     RETURNING id, user_code, user_id, created_at, expires_at, consumed_at`,
  );
  const findByUserCodeStmt = db.prepare<FamilyPhonePairingRow, [string]>(
    `SELECT id, user_code, user_id, created_at, expires_at, consumed_at
     FROM family_phone_pair_requests WHERE user_code = ?`,
  );
  const markConsumedStmt = db.prepare<unknown, [string, string]>(
    `UPDATE family_phone_pair_requests
     SET consumed_at = ?
     WHERE user_code = ? AND consumed_at IS NULL`,
  );
  const deleteExpiredStmt = db.prepare<unknown, [string]>(
    'DELETE FROM family_phone_pair_requests WHERE expires_at < ?',
  );

  return {
    insert(input): FamilyPhonePairingRow {
      const row = insertStmt.get(input.userCode, input.userId, input.expiresAt);
      if (!row) throw new Error('family_phone_pair_requests.insert: RETURNING gave no row');
      return row;
    },
    findByUserCode(userCode): FamilyPhonePairingRow | null {
      return findByUserCodeStmt.get(userCode) ?? null;
    },
    markConsumed(input): boolean {
      const info = markConsumedStmt.run(input.consumedAt, input.userCode);
      return info.changes > 0;
    },
    deleteExpired(now): number {
      const info = deleteExpiredStmt.run(now);
      return info.changes;
    },
  };
}
