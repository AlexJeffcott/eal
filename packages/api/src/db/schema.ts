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

  // Phase 7B.4d: family_phone_devices.kind once forbade 'pstn' and required
  // a non-NULL user_id. The Twilio bridge introduces user-less PSTN device
  // rows, so the constraint widens. SQLite cannot ALTER a CHECK, so an
  // older shape needs a table rebuild — done before `app.schema` runs so
  // the fresh CREATE lands on the new shape. The same rebuild also picks
  // up the Phase 7D widening that adds the kind='household' literal.
  rebuildFamilyPhoneDevicesIfLegacy(db);

  db.exec(GLOBAL_SCHEMA);
  for (const app of API_APPS) {
    db.exec(app.schema);
  }
  // conversations.cleared_before_id was added after the table first shipped.
  ensureColumn(db, 'conversations', 'cleared_before_id', 'INTEGER NOT NULL DEFAULT 0');
  // Phase 7D: opt-in flag for the DTMF IVR menu. Default 0 so adding the
  // column doesn't surprise existing households — admin flips each
  // person on. The CHECK keeps the value to a strict 0/1.
  ensureColumn(
    db,
    'users',
    'in_ivr_menu',
    'INTEGER NOT NULL DEFAULT 0 CHECK (in_ivr_menu IN (0,1))',
  );
  // Phase 7D: known callers route to the household member they were
  // calling for. Nullable — a contact without an intended recipient
  // (or an unknown caller) still falls through to the IVR.
  ensureColumn(
    db,
    'family_phone_pstn_contacts',
    'intended_user_id',
    'INTEGER REFERENCES users(id) ON DELETE SET NULL',
  );
  // Phase 7D: the single user-less device row voicemails land in when
  // no household member was specifically being called. Idempotent —
  // the partial unique index on (label) WHERE kind='household' enforces
  // there can be at most one.
  ensureHouseholdDevice(db);
}

interface TableNameRow { name: string }

interface TableSqlRow { sql: string | null }

/**
 * Drop and rebuild family_phone_devices when the on-disk shape is the
 * pre-PSTN one. Detection: read the CREATE statement from sqlite_master
 * and check for the new 'pstn' literal in the kind CHECK. Existing rows
 * are copied across; foreign-key references survive because the index
 * targets the same column (id) and we run inside a single transaction
 * with `foreign_keys` momentarily off so the FK targets that still
 * point at the soon-to-be-dropped table aren't policed mid-flight.
 *
 * Idempotent: a database already on the new shape returns early.
 */
function rebuildFamilyPhoneDevicesIfLegacy(db: DatabaseClient): void {
  const row = db
    .prepare<TableSqlRow, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='family_phone_devices'",
    )
    .get();
  if (!row || row.sql === null) return;
  // The rebuild is needed when any literal added in a later phase is
  // missing from the on-disk CHECK. Today that's 'pstn' (7B.4d) and
  // 'household' (7D); a fresh DB built by `app.schema` already has
  // both and falls through.
  if (row.sql.includes("'pstn'") && row.sql.includes("'household'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE family_phone_devices_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        label       TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK (kind IN ('handset','pwa','agent','pstn','household')),
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        paired_at   TEXT,
        CHECK (kind IN ('pstn','household') OR user_id IS NOT NULL)
      );
      INSERT INTO family_phone_devices_new (id, user_id, label, kind, created_at, paired_at)
        SELECT id, user_id, label, kind, created_at, paired_at FROM family_phone_devices;
      DROP TABLE family_phone_devices;
      ALTER TABLE family_phone_devices_new RENAME TO family_phone_devices;
    `);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

interface CountRow { n: number }

/**
 * Insert the single kind='household' device row if it isn't already
 * there. Voicemails for the no-IVR-selection / unknown-caller path
 * land here so every paired browser can see them. Idempotent — a
 * household already provisioned returns without writing.
 */
function ensureHouseholdDevice(db: DatabaseClient): void {
  const present = db
    .prepare<CountRow, []>(
      "SELECT COUNT(*) AS n FROM family_phone_devices WHERE kind='household'",
    )
    .get();
  if ((present?.n ?? 0) > 0) return;
  db.exec(
    "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (NULL, 'Household', 'household')",
  );
}

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
