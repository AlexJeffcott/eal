import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Direct sqlite seed: opens the file-backed test DB, ensures a user exists,
 * mints a long-lived session token via the same code path the api uses.
 * Returns the plaintext token so the multi-process script can paste it
 * into the CLI's token file.
 *
 * This file lives under `scripts/` (not under any package) because it's a
 * test harness helper that exists to bridge the multi-process tier with
 * the api's data store; production code should never call it.
 */
import { createSessionsRepo } from '../../packages/api/src/auth/sessions.ts';
import { createUsersRepo } from '../../packages/api/src/db/repos/users.ts';
import { applySchema } from '../../packages/api/src/db/schema.ts';

const ONE_HOUR_MS = 60 * 60_000;

export interface SeedResult {
  userId: number;
  displayName: string;
  token: string;
}

export function seedCliToken(opts: { dbPath: string; displayName: string; ttlMs?: number; label?: string }): SeedResult {
  const absPath = resolve(opts.dbPath);
  if (!existsSync(absPath)) {
    mkdirSync(resolve(absPath, '..'), { recursive: true });
  }
  const db = new Database(absPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  applySchema(db);

  const usersRepo = createUsersRepo(db);
  const existing = usersRepo.findByDisplayName(opts.displayName);
  const user = existing ?? usersRepo.insert({ displayName: opts.displayName });

  const sessions = createSessionsRepo(db);
  const { token } = sessions.mint({
    userId: user.id,
    ttlMs: opts.ttlMs ?? ONE_HOUR_MS,
    label: opts.label ?? 'cli-e2e',
  });

  db.close();

  return { userId: user.id, displayName: user.display_name, token };
}
