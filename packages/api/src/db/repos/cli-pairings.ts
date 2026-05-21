import type { DatabaseClient } from '../client.ts';

export interface CliPairingRow {
  device_code_hash: Uint8Array;
  user_code: string;
  user_id: number | null;
  label: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface CliPairingsRepo {
  insert(input: {
    deviceCodeHash: Uint8Array;
    userCode: string;
    expiresAt: string;
  }): CliPairingRow;
  findByUserCode(userCode: string): CliPairingRow | null;
  findByDeviceCodeHash(deviceCodeHash: Uint8Array): CliPairingRow | null;
  /**
   * Single-shot conditional update: assigns the user/label only when the row is
   * still un-claimed. Returns true if exactly one row was updated. Two
   * simultaneous claims of the same user_code cannot both succeed.
   */
  markClaimed(input: { userCode: string; userId: number; label: string }): boolean;
  /**
   * Single-shot conditional update: flips consumed_at only when the row is
   * claimed and not already consumed. A second poll after success returns
   * expired because consumed_at is set.
   */
  markConsumed(input: { deviceCodeHash: Uint8Array; consumedAt: string }): boolean;
  deleteExpired(now: string): number;
}

export function createCliPairingsRepo(db: DatabaseClient): CliPairingsRepo {
  const insertStmt = db.prepare<CliPairingRow, [Uint8Array, string, string]>(
    `INSERT INTO cli_pair_requests (device_code_hash, user_code, expires_at)
     VALUES (?, ?, ?)
     RETURNING device_code_hash, user_code, user_id, label,
               created_at, expires_at, consumed_at`,
  );
  const findByUserCodeStmt = db.prepare<CliPairingRow, [string]>(
    `SELECT device_code_hash, user_code, user_id, label,
            created_at, expires_at, consumed_at
     FROM cli_pair_requests WHERE user_code = ?`,
  );
  const findByDeviceCodeHashStmt = db.prepare<CliPairingRow, [Uint8Array]>(
    `SELECT device_code_hash, user_code, user_id, label,
            created_at, expires_at, consumed_at
     FROM cli_pair_requests WHERE device_code_hash = ?`,
  );
  const markClaimedStmt = db.prepare<unknown, [number, string, string]>(
    `UPDATE cli_pair_requests
     SET user_id = ?, label = ?
     WHERE user_code = ? AND user_id IS NULL`,
  );
  const markConsumedStmt = db.prepare<unknown, [string, Uint8Array]>(
    `UPDATE cli_pair_requests
     SET consumed_at = ?
     WHERE device_code_hash = ?
       AND user_id IS NOT NULL
       AND consumed_at IS NULL`,
  );
  const deleteExpiredStmt = db.prepare<unknown, [string]>(
    'DELETE FROM cli_pair_requests WHERE expires_at < ?',
  );

  return {
    insert(input): CliPairingRow {
      const row = insertStmt.get(input.deviceCodeHash, input.userCode, input.expiresAt);
      if (!row) throw new Error('cli_pair_requests.insert: RETURNING gave no row');
      return row;
    },
    findByUserCode(userCode): CliPairingRow | null {
      return findByUserCodeStmt.get(userCode) ?? null;
    },
    findByDeviceCodeHash(deviceCodeHash): CliPairingRow | null {
      return findByDeviceCodeHashStmt.get(deviceCodeHash) ?? null;
    },
    markClaimed(input): boolean {
      const info = markClaimedStmt.run(input.userId, input.label, input.userCode);
      return info.changes > 0;
    },
    markConsumed(input): boolean {
      const info = markConsumedStmt.run(input.consumedAt, input.deviceCodeHash);
      return info.changes > 0;
    },
    deleteExpired(now): number {
      const info = deleteExpiredStmt.run(now);
      return info.changes;
    },
  };
}
