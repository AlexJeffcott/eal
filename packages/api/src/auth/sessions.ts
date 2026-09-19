import { randomBytes } from 'node:crypto';
import type { DatabaseClient } from '../db/client.ts';
import { createSessionsRepoFromDb, type SessionRow } from '../db/repos/sessions.ts';
import { sha256 } from './hash.ts';
import { formatSqliteDateTime, parseSqliteDateTime } from './datetime.ts';

const LAST_USED_COALESCE_MS = 60_000;
/**
 * How much lifetime a session must have used up before a use moves its expiry
 * forward again. A day: a session used daily never ends, and the expiry is
 * written at most once a day rather than on every request.
 */
const SLIDE_STEP_MS = 24 * 60 * 60_000;
const TOKEN_PREFIX = 'eal_v1_';

export interface MintedSession {
  /** Plaintext token. Returned exactly once. Never persisted. */
  token: string;
  row: SessionRow;
}

export interface SessionsRepo {
  mint(input: { userId: number; ttlMs: number; label?: string }): MintedSession;
  verify(token: string): SessionRow | null;
  revoke(token: string): boolean;
  revokeAllForUser(userId: number): number;
  pruneExpired(): number;
}

export function mintTokenPlaintext(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export interface SessionsRepoOptions {
  /** Override `now` for deterministic tests. */
  now?: () => Date;
  /** Override the coalescing window (default 60s). */
  coalesceMs?: number;
}

export function createSessionsRepo(
  db: DatabaseClient,
  options: SessionsRepoOptions = {},
): SessionsRepo {
  const repo = createSessionsRepoFromDb(db);
  const now = options.now ?? (() => new Date());
  const coalesceMs = options.coalesceMs ?? LAST_USED_COALESCE_MS;

  return {
    mint({ userId, ttlMs, label }): MintedSession {
      const token = mintTokenPlaintext();
      const tokenHash = sha256(token);
      const current = now();
      const expiresAt = formatSqliteDateTime(new Date(current.getTime() + ttlMs));
      const lastUsedAt = formatSqliteDateTime(current);
      const row = repo.insert({ tokenHash, userId, expiresAt, ttlMs, label: label ?? null, lastUsedAt });
      return { token, row };
    },

    verify(token): SessionRow | null {
      const tokenHash = sha256(token);
      const row = repo.findByTokenHash(tokenHash);
      if (!row) return null;
      const current = now();
      const expiresAt = parseSqliteDateTime(row.expires_at);
      if (expiresAt.getTime() <= current.getTime()) return null;

      const lastUsedAt = parseSqliteDateTime(row.last_used_at);
      if (current.getTime() - lastUsedAt.getTime() <= coalesceMs) return row;

      // The expiry slides: a use moves it to `ttl_ms` from now, so a session
      // ends that long after its LAST use, not after sign-in. A lost device
      // still ends by itself; a device in daily use never signs its owner out.
      const remainingMs = expiresAt.getTime() - current.getTime();
      const usedAt = formatSqliteDateTime(current);
      if (row.ttl_ms !== null && remainingMs < row.ttl_ms - SLIDE_STEP_MS) {
        const slidTo = formatSqliteDateTime(new Date(current.getTime() + row.ttl_ms));
        repo.updateLastUsedAndExpiry(tokenHash, usedAt, slidTo);
        return { ...row, last_used_at: usedAt, expires_at: slidTo };
      }
      repo.updateLastUsed(tokenHash, usedAt);
      return row;
    },

    revoke(token): boolean {
      return repo.deleteByTokenHash(sha256(token));
    },

    revokeAllForUser(userId): number {
      return repo.deleteAllForUser(userId);
    },

    pruneExpired(): number {
      return repo.deleteExpired(formatSqliteDateTime(now()));
    },
  };
}
