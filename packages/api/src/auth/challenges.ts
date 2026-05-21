export type ChallengeKind = 'register' | 'authenticate';

export interface PendingChallenge {
  kind: ChallengeKind;
  /** Free-form metadata. Registration uses it for the pending display name. */
  meta?: Record<string, string> | undefined;
  expiresAt: number;
}

export interface ChallengeStore {
  set(challenge: string, entry: Omit<PendingChallenge, 'expiresAt'>, ttlMs?: number): void;
  take(challenge: string): PendingChallenge | null;
  pruneExpired(): number;
  size(): number;
}

const DEFAULT_TTL_MS = 60_000;

export interface ChallengeStoreOptions {
  /** Override `now` for deterministic tests. */
  now?: () => number;
  defaultTtlMs?: number;
}

/**
 * In-memory challenge store. The WebAuthn ceremony is single-request-scoped
 * (60 seconds end-to-end), so durability buys nothing until we multi-replica
 * the api process. A setInterval prune sweep can be wired by the caller.
 */
export function createChallengeStore(options: ChallengeStoreOptions = {}): ChallengeStore {
  const now = options.now ?? Date.now;
  const defaultTtl = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const store = new Map<string, PendingChallenge>();

  return {
    set(challenge, entry, ttlMs): void {
      store.set(challenge, {
        kind: entry.kind,
        meta: entry.meta,
        expiresAt: now() + (ttlMs ?? defaultTtl),
      });
    },
    take(challenge): PendingChallenge | null {
      const entry = store.get(challenge);
      if (!entry) return null;
      store.delete(challenge);
      if (entry.expiresAt < now()) return null;
      return entry;
    },
    pruneExpired(): number {
      const cutoff = now();
      let removed = 0;
      for (const [k, v] of store) {
        if (v.expiresAt < cutoff) {
          store.delete(k);
          removed += 1;
        }
      }
      return removed;
    },
    size(): number {
      return store.size;
    },
  };
}
