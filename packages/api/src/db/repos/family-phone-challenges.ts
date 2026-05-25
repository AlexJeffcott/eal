import type { DatabaseClient } from '../client.ts';

export interface FamilyPhoneChallengeRow {
  id: number;
  device_id: number;
  nonce: Uint8Array;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface FamilyPhoneChallengesRepo {
  insert(input: {
    deviceId: number;
    nonce: Uint8Array;
    expiresAt: string;
  }): FamilyPhoneChallengeRow;
  findByNonce(nonce: Uint8Array): FamilyPhoneChallengeRow | null;
  /**
   * Single-shot consumption: flips consumed_at only when still null. Two
   * simultaneous /device/auth calls with the same nonce can't both win.
   */
  markConsumed(input: { nonce: Uint8Array; consumedAt: string }): boolean;
  deleteExpired(now: string): number;
}

export function createFamilyPhoneChallengesRepo(
  db: DatabaseClient,
): FamilyPhoneChallengesRepo {
  const insertStmt = db.prepare<FamilyPhoneChallengeRow, [number, Uint8Array, string]>(
    `INSERT INTO family_phone_challenges (device_id, nonce, expires_at)
     VALUES (?, ?, ?)
     RETURNING id, device_id, nonce, created_at, expires_at, consumed_at`,
  );
  const findByNonceStmt = db.prepare<FamilyPhoneChallengeRow, [Uint8Array]>(
    `SELECT id, device_id, nonce, created_at, expires_at, consumed_at
     FROM family_phone_challenges WHERE nonce = ?`,
  );
  const markConsumedStmt = db.prepare<unknown, [string, Uint8Array]>(
    `UPDATE family_phone_challenges
     SET consumed_at = ?
     WHERE nonce = ? AND consumed_at IS NULL`,
  );
  const deleteExpiredStmt = db.prepare<unknown, [string]>(
    'DELETE FROM family_phone_challenges WHERE expires_at < ?',
  );

  return {
    insert(input): FamilyPhoneChallengeRow {
      const row = insertStmt.get(input.deviceId, input.nonce, input.expiresAt);
      if (!row) throw new Error('family_phone_challenges.insert: RETURNING gave no row');
      return row;
    },
    findByNonce(nonce): FamilyPhoneChallengeRow | null {
      return findByNonceStmt.get(nonce) ?? null;
    },
    markConsumed(input): boolean {
      const info = markConsumedStmt.run(input.consumedAt, input.nonce);
      return info.changes > 0;
    },
    deleteExpired(now): number {
      const info = deleteExpiredStmt.run(now);
      return info.changes;
    },
  };
}
