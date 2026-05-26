import type { DatabaseClient } from './client.ts';
import { API_APPS } from '../apps/registry.ts';

/**
 * Global schema — the tables every eal install has regardless of which apps
 * are present: identity (users, credentials, sessions, cli-pairing) and the
 * assistant (messages, conversations). App-owned tables are appended by
 * `applySchema` from each app's own `schema` fragment.
 */
const GLOBAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id BLOB NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credentials_user_id ON credentials(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash BLOB PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS cli_pair_requests (
  device_code_hash BLOB PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cli_pair_user_code ON cli_pair_requests(user_code);
CREATE INDEX IF NOT EXISTS idx_cli_pair_expires_at ON cli_pair_requests(expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT    NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT    NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_created_by ON messages (created_by, id);

CREATE TABLE IF NOT EXISTS conversations (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  claude_session_id  TEXT,
  cleared_before_id  INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

interface PragmaColumnRow {
  name: string;
}

/**
 * Idempotently add a column to an existing table. `CREATE TABLE IF NOT EXISTS`
 * never alters a table that already exists, so a column added to a shipped
 * table needs this guarded `ALTER`. Skipped when the column is already there,
 * which keeps `applySchema` a no-op on repeat runs.
 */
function ensureColumn(db: DatabaseClient, table: string, column: string, decl: string): void {
  const columns = db.prepare<PragmaColumnRow, []>(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/** Apply the global schema, then every installed app's schema fragment. */
export function applySchema(db: DatabaseClient): void {
  // The family_phone_pair_requests table once carried `label` and `kind`
  // columns chosen at code-mint time. Those moved to /pair/complete so the
  // joining device supplies its own identity. The next app.schema run
  // creates the table in its new shape; the column check below catches a
  // pre-migration database and drops the stale table first.
  pruneLegacyPairColumns(db);

  db.exec(GLOBAL_SCHEMA);
  for (const app of API_APPS) {
    db.exec(app.schema);
  }
  // conversations.cleared_before_id was added after the table first shipped.
  ensureColumn(db, 'conversations', 'cleared_before_id', 'INTEGER NOT NULL DEFAULT 0');
}

interface TableNameRow { name: string }

function pruneLegacyPairColumns(db: DatabaseClient): void {
  const exists = db
    .prepare<TableNameRow, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='family_phone_pair_requests'",
    )
    .get();
  if (!exists) return;
  const cols = db
    .prepare<PragmaColumnRow, []>('PRAGMA table_info(family_phone_pair_requests)')
    .all();
  const hasLegacy = cols.some((c) => c.name === 'label' || c.name === 'kind');
  if (hasLegacy) {
    db.exec('DROP TABLE family_phone_pair_requests');
  }
}
