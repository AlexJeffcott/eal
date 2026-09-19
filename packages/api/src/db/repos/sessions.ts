import type { DatabaseClient } from '../client.ts';

export interface SessionRow {
  token_hash: Uint8Array;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  label: string | null;
  /** The lifetime the session was minted with. NULL only on a row no migration has reached. */
  ttl_ms: number | null;
}

export interface SessionsRepoLow {
  insert(input: {
    tokenHash: Uint8Array;
    userId: number;
    expiresAt: string;
    ttlMs: number;
    label?: string | null;
    /** Override `last_used_at` (defaults to sqlite's `datetime('now')`). */
    lastUsedAt?: string;
  }): SessionRow;
  findByTokenHash(tokenHash: Uint8Array): SessionRow | null;
  deleteByTokenHash(tokenHash: Uint8Array): boolean;
  deleteAllForUser(userId: number): number;
  deleteExpired(now: string): number;
  updateLastUsed(tokenHash: Uint8Array, now: string): void;
  /** Record a use and move the expiry in one statement. */
  updateLastUsedAndExpiry(tokenHash: Uint8Array, now: string, expiresAt: string): void;
}

export function createSessionsRepoFromDb(db: DatabaseClient): SessionsRepoLow {
  const insertStmt = db.prepare<SessionRow, [Uint8Array, number, string, string | null, string | null, number]>(
    `INSERT INTO sessions (token_hash, user_id, expires_at, last_used_at, label, ttl_ms)
     VALUES (?, ?, ?, coalesce(?, datetime('now')), ?, ?)
     RETURNING token_hash, user_id, created_at, expires_at, last_used_at, label, ttl_ms`,
  );
  const findByTokenHashStmt = db.prepare<SessionRow, [Uint8Array]>(
    `SELECT token_hash, user_id, created_at, expires_at, last_used_at, label, ttl_ms
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

  const updateLastUsedAndExpiryStmt = db.prepare<unknown, [string, string, Uint8Array]>(
    'UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?',
  );

  return {
    insert(input): SessionRow {
      const row = insertStmt.get(
        input.tokenHash,
        input.userId,
        input.expiresAt,
        input.lastUsedAt ?? null,
        input.label ?? null,
        input.ttlMs,
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
    updateLastUsedAndExpiry(tokenHash, now, expiresAt): void {
      updateLastUsedAndExpiryStmt.run(now, expiresAt, tokenHash);
    },
  };
}
