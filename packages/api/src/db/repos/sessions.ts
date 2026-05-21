import type { DatabaseClient } from '../client.ts';

export interface SessionRow {
  token_hash: Uint8Array;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  label: string | null;
}

export interface SessionsRepoLow {
  insert(input: {
    tokenHash: Uint8Array;
    userId: number;
    expiresAt: string;
    label?: string | null;
    /** Override `last_used_at` (defaults to sqlite's `datetime('now')`). */
    lastUsedAt?: string;
  }): SessionRow;
  findByTokenHash(tokenHash: Uint8Array): SessionRow | null;
  deleteByTokenHash(tokenHash: Uint8Array): boolean;
  deleteAllForUser(userId: number): number;
  deleteExpired(now: string): number;
  updateLastUsed(tokenHash: Uint8Array, now: string): void;
}

export function createSessionsRepoFromDb(db: DatabaseClient): SessionsRepoLow {
  const insertStmt = db.prepare<SessionRow, [Uint8Array, number, string, string | null, string | null]>(
    `INSERT INTO sessions (token_hash, user_id, expires_at, last_used_at, label)
     VALUES (?, ?, ?, coalesce(?, datetime('now')), ?)
     RETURNING token_hash, user_id, created_at, expires_at, last_used_at, label`,
  );
  const findByTokenHashStmt = db.prepare<SessionRow, [Uint8Array]>(
    `SELECT token_hash, user_id, created_at, expires_at, last_used_at, label
     FROM sessions WHERE token_hash = ?`,
  );
  const deleteByTokenHashStmt = db.prepare<unknown, [Uint8Array]>(
    'DELETE FROM sessions WHERE token_hash = ?',
  );
  const deleteAllForUserStmt = db.prepare<unknown, [number]>(
    'DELETE FROM sessions WHERE user_id = ?',
  );
  const deleteExpiredStmt = db.prepare<unknown, [string]>(
    'DELETE FROM sessions WHERE expires_at < ?',
  );
  const updateLastUsedStmt = db.prepare<unknown, [string, Uint8Array]>(
    'UPDATE sessions SET last_used_at = ? WHERE token_hash = ?',
  );

  return {
    insert(input): SessionRow {
      const row = insertStmt.get(
        input.tokenHash,
        input.userId,
        input.expiresAt,
        input.lastUsedAt ?? null,
        input.label ?? null,
      );
      if (!row) throw new Error('sessions.insert: RETURNING gave no row');
      return row;
    },
    findByTokenHash(tokenHash): SessionRow | null {
      return findByTokenHashStmt.get(tokenHash) ?? null;
    },
    deleteByTokenHash(tokenHash): boolean {
      const info = deleteByTokenHashStmt.run(tokenHash);
      return info.changes > 0;
    },
    deleteAllForUser(userId): number {
      const info = deleteAllForUserStmt.run(userId);
      return info.changes;
    },
    deleteExpired(now): number {
      const info = deleteExpiredStmt.run(now);
      return info.changes;
    },
    updateLastUsed(tokenHash, now): void {
      updateLastUsedStmt.run(now, tokenHash);
    },
  };
}
