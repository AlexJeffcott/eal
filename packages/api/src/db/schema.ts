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
  label TEXT,
  ttl_ms INTEGER
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
  // sessions.ttl_ms: the lifetime a session was minted with, so `verify` can
  // move `expires_at` forward by that much on use. Before this column a
  // session ended a fixed 30 days after sign-in however often it was used. A
  // row minted before the column has never been moved, so its lifetime is
  // still `expires_at - created_at`, to the second.
  ensureColumn(db, 'sessions', 'ttl_ms', 'INTEGER');
  db.exec(
    `UPDATE sessions
        SET ttl_ms = CAST(round((julianday(expires_at) - julianday(created_at)) * 86400) AS INTEGER) * 1000
      WHERE ttl_ms IS NULL`,
  );
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
  // Tasks stage 1: the three fixed levels — project → epic → task — stored as
  // a column rather than a separate `projects` table. Capture is "write it
  // down, discover later it is a project", and with a column that promotion is
  // one UPDATE: the row keeps its id, so assistant references and the
  // `task:*` broadcasts the SPA reconciles against stay valid. Every existing
  // row defaults to 'task'; the promote pass below then gives the rows that
  // already hold children the level their position requires, because 'task'
  // is a level that may not hold any.
  //
  // The CHECK rides on the ALTER — SQLite accepts one there, as the
  // users.in_ivr_menu call above already proves. What it cannot express is the
  // rule binding a row to its parent, which has to read the *parent* row's
  // kind; that lives in handlers/tasks.shared.ts:levelViolation.
  ensureColumn(
    db,
    'tasks',
    'kind',
    "TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('project','epic','task'))",
  );
  // Not part of the tasks app's own schema fragment: the column it indexes is
  // added by the ensureColumn above, which runs after every app fragment.
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks (kind)');
  // Tasks stage 2: `status` widens from ('open','done') to the four workflow
  // states. Unlike `kind`, this cannot ride in on ensureColumn — SQLite has no
  // way to ALTER a CHECK constraint — so the table is rebuilt. Runs after every
  // ensureColumn above so the column set it copies is already the final one.
  rebuildTasksStatusIfLegacy(db);
  // Tasks stage 3: does a container hand out its work one step at a time, or
  // all at once? Default 0 — parallel — so every container that existed before
  // this column behaves exactly as it did, and the Available view is the only
  // thing the migration changes (namely: nothing, until someone flips a flag).
  //
  // **This ensureColumn must stay AFTER rebuildTasksStatusIfLegacy.** That
  // rebuild copies the table through a hand-written column list
  // (`CREATE TABLE tasks_stage2` / `INSERT … SELECT` above), so a column added
  // before it would be silently dropped on any database still on the stage-1
  // shape. Placed here it cannot be: a database that has `sequential` also has
  // the 'doing' literal the rebuild detects on, so the rebuild has already
  // returned early by the time this line can matter.
  // schema.test.ts drives that exact upgrade and asserts the column survives.
  ensureColumn(
    db,
    'tasks',
    'sequential',
    'INTEGER NOT NULL DEFAULT 0 CHECK (sequential IN (0,1))',
  );
  // Tasks stage 4: when did the reminder for this row's *current* `due_at` go
  // out? NULL means "not yet"; a timestamp means the scan has been round this
  // deadline already. That is the whole of what makes the 60-second tick
  // idempotent across a restart — the api process can die mid-scan, or be
  // redeployed six times an hour, and no deadline rings twice.
  //
  // Cleared whenever `due_at` is written to a different value
  // (db/repos/tasks.ts:update), so moving or clearing a deadline re-arms the
  // reminder and re-writing the same date does not.
  //
  // **This ensureColumn must stay AFTER rebuildTasksStatusIfLegacy**, for the
  // same reason `sequential` above must: the rebuild copies the table through a
  // hand-written column list, so a column added before it is silently dropped
  // on any database still on the stage-1 shape. schema.test.ts drives that
  // upgrade and asserts this column survives; so does
  // scripts/e2e-task-reminder.ts, over a real file-backed database.
  ensureColumn(db, 'tasks', 'reminded_at', 'TEXT');
  // Partial index over exactly the rows the tick can still fire: a deadline
  // that exists, has not been reminded, and is not in the trash. Stamping a row
  // removes it from the index, so the index shrinks as the day is worked
  // through rather than growing with the table. Not part of the tasks app's
  // schema fragment because the column it filters on is added by the
  // ensureColumn immediately above, which runs after every app fragment.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_due_reminder ON tasks (due_at)
       WHERE reminded_at IS NULL AND deleted_at IS NULL AND due_at IS NOT NULL`,
  );
  // Tasks stage 5: the id a device gives a capture before the server has one.
  // The SPA's outbox (web/src/apps/tasks/outbox.ts) sends a create again
  // whenever it cannot tell whether the last one arrived, and this is what
  // makes the second one find the first: handlers/tasks.shared.ts:createTaskOnce.
  // NULL for every row that existed before the column, and for every row not
  // captured through an outbox.
  //
  // **This ensureColumn must stay AFTER rebuildTasksStatusIfLegacy**, for the
  // same reason `sequential` and `reminded_at` above must.
  // scripts/e2e-offline-capture.ts drives it over a real pre-migration file.
  ensureColumn(db, 'tasks', 'client_id', 'TEXT');
  // Unique per creator, not globally: the id is minted on a device, and one
  // member must not be able to make another member's create fail by guessing
  // or replaying an id. Partial, because every other row holds NULL.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_id ON tasks (created_by, client_id)
       WHERE client_id IS NOT NULL`,
  );
  // Tasks stage 6: recurring tasks — docs/plans/05-recurring-tasks.md. Three
  // nullable columns, NULL on every row that existed before them, so the
  // migration changes nothing until someone sets a rule.
  //
  //   recurrence    the rule, as the canonical JSON `@eal/shared`
  //                 serialiseRecurrence writes. It sits on the ONE live row of
  //                 a series: completing that row moves it to the successor.
  //   spawned_from  lineage, and permanent: the id of the completed row this
  //                 one succeeded. It is how a recurring container knows a done
  //                 child has already been succeeded and must not be copied
  //                 into the next occurrence a second time.
  //   spawn_group   the accidental tick. Every row of a freshly spawned
  //                 successor tree holds the completed row's id here, and ANY
  //                 write to ANY of them clears it on all of them
  //                 (db/repos/tasks.ts:touchSpawnGroup). So "is the successor
  //                 untouched?" is "does a row still hold this id?", and
  //                 reopening the completed row may take the successor back
  //                 only then. A comparison of `updated_at` with `created_at`
  //                 cannot answer that: both are whole seconds, and an edit in
  //                 the second a row was made would read as no edit at all.
  //
  // No foreign key on either id: the only rows ever hard-deleted are an
  // untouched successor tree, and nothing can point at one — a row is only
  // pointed at once it has been completed, which is a touch.
  //
  // **These must stay AFTER rebuildTasksStatusIfLegacy**, for the same reason
  // `sequential`, `reminded_at` and `client_id` above must.
  // scripts/e2e-tasks-recurrence-migration.ts drives it over a real
  // pre-migration file.
  ensureColumn(db, 'tasks', 'recurrence', 'TEXT');
  ensureColumn(db, 'tasks', 'spawned_from', 'INTEGER');
  ensureColumn(db, 'tasks', 'spawn_group', 'INTEGER');
  // Both lookups are by one of these ids, and nearly every row holds NULL.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_spawn_group ON tasks (spawn_group)
       WHERE spawn_group IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_spawned_from ON tasks (spawned_from)
       WHERE spawned_from IS NOT NULL`,
  );
  promoteGrandfatheredContainers(db);
  // Phase 7D: the single user-less device row voicemails land in when
  // no household member was specifically being called. Idempotent —
  // the partial unique index on (label) WHERE kind='household' enforces
  // there can be at most one.
  ensureHouseholdDevice(db);
}

interface TaskDepthRow { id: number; depth: number }

/**
 * Give every task that already holds children the level its position requires.
 *
 * The `kind` column defaults every existing row to 'task', and a task may not
 * hold children (handlers/tasks.shared.ts:levelViolation). So the moment the
 * column lands, every parent/child pair written before it is a pairing the
 * rules refuse: the rows still read and list, but any later re-parent or level
 * change of either one is rejected with a 400. This pass resolves that from
 * the tree itself — a root holding children is a project, a project's child
 * holding children is an epic — so no one has to hand-promote rows to move
 * them again.
 *
 * It only ever writes a row whose kind is still 'task', so a level chosen
 * deliberately is never overwritten. That restriction costs nothing: no write
 * path can produce a 'task' holding children, which is why every row this pass
 * finds came from the column default.
 *
 * Idempotent. A second run finds no candidates and issues no UPDATE — the rows
 * it would look for are exactly the ones the first run resolved.
 *
 * A child counts whether or not it is in the trash. `restore` returns a row to
 * the parent it had, so a parent legalised against its live children only would
 * become illegal again the moment a trashed child came back.
 */
function promoteGrandfatheredContainers(db: DatabaseClient): void {
  // Depth from the root, for containers only. The recursion is bounded at 32
  // as every recursive query here is (docs/tasks-v1.md); a stored cycle is
  // never reached from the roots anchor, so those rows are left untouched.
  const depths = `
    WITH RECURSIVE tree(id, depth) AS (
      SELECT id, 0 FROM tasks WHERE parent_id IS NULL
      UNION ALL
      SELECT t.id, tree.depth + 1
        FROM tasks t JOIN tree ON t.parent_id = tree.id
       WHERE tree.depth < 32
    )
    SELECT tree.id AS id, tree.depth AS depth
      FROM tree
      JOIN tasks ON tasks.id = tree.id
     WHERE tasks.kind = 'task'
       AND EXISTS (SELECT 1 FROM tasks child WHERE child.parent_id = tree.id)`;

  const candidates = db.prepare<TaskDepthRow, []>(depths).all();
  if (candidates.length === 0) return;

  const promote = db.prepare<never, [string, number]>('UPDATE tasks SET kind = ? WHERE id = ?');
  const stranded: number[] = [];
  for (const row of candidates) {
    if (row.depth === 0) promote.run('project', row.id);
    else if (row.depth === 1) promote.run('epic', row.id);
    else stranded.push(row.id);
  }

  // Three levels is the whole model, so a container sitting under an epic has
  // no legal level to take: its parent is already the deepest container the
  // rules allow. Those rows keep the default and stay readable; only a move of
  // one is refused, and the 400 says why. Rewriting the tree to fit would
  // change data nobody asked to change, so this reports instead.
  if (stranded.length > 0) {
    console.warn(
      `[schema] ${stranded.length} task(s) hold children below the epic level and cannot take one: ` +
        `${stranded.join(', ')}. They read and list normally; re-parenting or re-levelling one is ` +
        'refused until its tree is three levels or fewer.',
    );
  }
}

interface TableNameRow { name: string }

interface TableSqlRow { sql: string | null }

/**
 * Widen `tasks.status` from ('open','done') to ('todo','doing','blocked','done').
 *
 * SQLite cannot ALTER a CHECK constraint, so this is a table rebuild — the same
 * shape as rebuildFamilyPhoneDevicesIfLegacy below, and for the same reason.
 * Detection reads the CREATE statement out of sqlite_master and looks for the
 * new 'doing' literal: a database built by the app's own schema fragment
 * already has it and falls straight through, so this is idempotent.
 *
 * `tasks.parent_id` is a self-referencing foreign key with ON DELETE CASCADE,
 * which makes getting this wrong destructive: a copy that lost parent_id would
 * orphan every subtask, and a DROP with foreign keys live would cascade the
 * children away. So: foreign keys off, one transaction, every row copied with
 * its parent, `PRAGMA foreign_key_check` before the commit rather than after.
 * The `finally` restores the pragma whether the rebuild committed or threw.
 *
 * Indexes are replayed from their own CREATE statements rather than re-typed
 * here. Six index definitions live across two files (the tasks app's schema
 * fragment and the `kind` index above); reading them back out of sqlite_master
 * means a seventh added later is carried across without touching this function.
 *
 * Data migration: 'open' → 'todo', everything else copied as it stands. There
 * is no fallback for an unrecognised status — the new CHECK rejects it and the
 * transaction rolls back, which is the loud failure such a row deserves.
 */
function rebuildTasksStatusIfLegacy(db: DatabaseClient): void {
  const table = db
    .prepare<TableSqlRow, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
    .get();
  if (!table || table.sql === null) return;
  if (table.sql.includes("'doing'")) return;

  const indexes = db
    .prepare<TableSqlRow, []>(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL",
    )
    .all();

  // The pragma is a no-op inside a transaction, so it has to be set around one.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_stage2 (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
          title         TEXT    NOT NULL,
          notes         TEXT    NOT NULL DEFAULT '',
          status        TEXT    NOT NULL CHECK (status IN ('todo','doing','blocked','done')),
          kind          TEXT    NOT NULL DEFAULT 'task' CHECK (kind IN ('project','epic','task')),
          defer_until   TEXT,
          due_at        TEXT,
          created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
          completed_at  TEXT,
          deleted_at    TEXT,
          position      INTEGER NOT NULL DEFAULT 0,
          CHECK ((status = 'done') = (completed_at IS NOT NULL))
        );
        INSERT INTO tasks_stage2
          (id, parent_id, title, notes, status, kind, defer_until, due_at, created_by,
           assigned_to, updated_by, created_at, updated_at, completed_at, deleted_at, position)
          SELECT id, parent_id, title, notes,
                 CASE status WHEN 'open' THEN 'todo' ELSE status END,
                 kind, defer_until, due_at, created_by,
                 assigned_to, updated_by, created_at, updated_at, completed_at, deleted_at, position
            FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_stage2 RENAME TO tasks;
      `);
      for (const index of indexes) {
        // Stryker disable next-line all -- defensive: the query already filters
        // `sql IS NOT NULL`, so this narrowing is unreachable. Kept because the
        // column's type is nullable and dropping the guard would need a cast.
        if (index.sql === null) continue;
        db.exec(index.sql);
      }
      // Belt and braces on the one relationship a bad copy would break. Runs
      // inside the transaction so a violation rolls the whole rebuild back
      // rather than leaving a half-migrated table on disk.
      const orphans = db.prepare<{ rowid: number }, []>('PRAGMA foreign_key_check(tasks)').all();
      if (orphans.length > 0) {
        throw new Error(
          `[schema] tasks status rebuild left ${orphans.length} broken foreign key reference(s); rolled back`,
        );
      }
    })();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

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
