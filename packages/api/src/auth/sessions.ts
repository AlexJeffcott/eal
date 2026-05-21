import { randomBytes } from 'node:crypto';
import type { DatabaseClient } from '../db/client.ts';
import { createSessionsRepoFromDb, type SessionRow } from '../db/repos/sessions.ts';
import { sha256 } from './hash.ts';
import { formatSqliteDateTime, parseSqliteDateTime } from './datetime.ts';

const LAST_USED_COALESCE_MS = 60_000;
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
      const row = repo.insert({ tokenHash, userId, expiresAt, label: label ?? null, lastUsedAt });
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
      if (current.getTime() - lastUsedAt.getTime() > coalesceMs) {
        repo.updateLastUsed(tokenHash, formatSqliteDateTime(current));
      }
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
