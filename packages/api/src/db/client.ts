import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export type DatabaseClient = Database;

export function ensureParentDirectory(path: string): void {
  if (path === ':memory:' || path.startsWith(':')) return;
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function createDb(path: string): DatabaseClient {
  ensureParentDirectory(path);
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}
