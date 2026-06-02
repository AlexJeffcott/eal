import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from './client.ts';
import { applySchema } from './schema.ts';

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function columns(db: DatabaseClient, table: string): PragmaColumn[] {
  return db.prepare<PragmaColumn, []>(`PRAGMA table_info(${table})`).all();
}

describe('applySchema', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  test('creates every required table on a fresh DB', () => {
    applySchema(db);
    interface TableNameRow { name: string }
    const tables = db
      .prepare<TableNameRow, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([
      'agent_actions',
      'agent_phone_lock',
      'agent_rules',
      'cli_pair_requests',
      'conversations',
      'credentials',
      'family_phone_challenges',
      'family_phone_device_keys',
      'family_phone_device_sessions',
      'family_phone_devices',
      'family_phone_pair_requests',
      'family_phone_pstn_calls',
      'family_phone_pstn_contacts',
      'family_phone_push_subscriptions',
      'family_phone_voice_messages',
      'messages',
      'sessions',
      'tasks',
      'users',
    ]);
  });

  test('tasks table has the columns documented in docs/tasks-v1.md', () => {
    applySchema(db);
    const cols = columns(db, 'tasks').map((c) => c.name).sort();
    expect(cols).toEqual([
      'assigned_to',
      'completed_at',
      'created_at',
      'created_by',
      'defer_until',
      'deleted_at',
      'due_at',
      'id',
      'notes',
      'parent_id',
      'position',
      'status',
      'title',
      'updated_at',
      'updated_by',
    ]);
  });

  test('conversations table carries the session id and the clear marker', () => {
    applySchema(db);
    const cols = columns(db, 'conversations').map((c) => c.name).sort();
    expect(cols).toEqual(['claude_session_id', 'cleared_before_id', 'updated_at', 'user_id']);
  });

  test('tasks CHECK constraint rejects status/completed_at disagreement', () => {
    applySchema(db);
    db.prepare("INSERT INTO users (display_name) VALUES ('alex')").run();
    expect(() =>
      db
        .prepare("INSERT INTO tasks (title, status, created_by, updated_by) VALUES ('t', 'done', 1, 1)")
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (title, status, completed_at, created_by, updated_by) VALUES ('t', 'open', datetime('now'), 1, 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO tasks (title, status, created_by, updated_by) VALUES ('t', 'open', 1, 1)")
        .run(),
    ).not.toThrow();
  });

  test('running applySchema twice is a no-op', () => {
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();

    const userCols = columns(db, 'users').map((c) => c.name).sort();
    expect(userCols).toEqual(['created_at', 'display_name', 'id', 'in_ivr_menu']);

    const taskCols = columns(db, 'tasks').map((c) => c.name);
    // Same set after the second apply.
    expect(taskCols.length).toBe(15);
  });

  test('schema preserves rows across repeat applySchema calls', () => {
    applySchema(db);
    db.prepare('INSERT INTO users (display_name) VALUES (?)').run('alex');
    applySchema(db);
    applySchema(db);

    interface UserCountRow { count: number }
    const rowCount = db.prepare<UserCountRow, []>('SELECT count(*) AS count FROM users').get();
    expect(rowCount?.count).toBe(1);
  });

  test('rebuilds a pre-PSTN family_phone_devices table and preserves rows', () => {
    // Hand-craft the legacy shape: no 'pstn' in the CHECK and a NOT NULL
    // user_id. applySchema must rebuild it into the new shape and
    // carry every existing row across.
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE family_phone_devices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label       TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK (kind IN ('handset','pwa','agent')),
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        paired_at   TEXT
      );
      INSERT INTO users (display_name) VALUES ('alex');
      INSERT INTO family_phone_devices (user_id, label, kind) VALUES (1, 'phone', 'handset');
    `);
    applySchema(db);

    interface DeviceRow {
      id: number;
      user_id: number | null;
      label: string;
      kind: string;
    }
    const rows = db
      .prepare<DeviceRow, []>(
        "SELECT id, user_id, label, kind FROM family_phone_devices WHERE kind <> 'household' ORDER BY id",
      )
      .all();
    expect(rows).toEqual([{ id: 1, user_id: 1, label: 'phone', kind: 'handset' }]);

    // New shape accepts a kind='pstn' row with a null user_id.
    expect(() =>
      db
        .prepare(
          "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (NULL, '+12025550100', 'pstn')",
        )
        .run(),
    ).not.toThrow();

    // The CHECK still rejects a non-PSTN row with a null user_id.
    expect(() =>
      db
        .prepare(
          "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (NULL, 'orphan', 'handset')",
        )
        .run(),
    ).toThrow();
  });

  test('indexes survive repeated applySchema calls without duplication', () => {
    applySchema(db);
    applySchema(db);
    interface IndexRow { name: string }
    const indexes = db
      .prepare<IndexRow, []>("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual([
      'idx_agent_actions_pending',
      'idx_agent_actions_rule_id',
      'idx_agent_rules_due',
      'idx_cli_pair_expires_at',
      'idx_cli_pair_user_code',
      'idx_credentials_user_id',
      'idx_family_phone_challenges_device_id',
      'idx_family_phone_challenges_expires_at',
      'idx_family_phone_device_sessions_device_id',
      'idx_family_phone_device_sessions_expires_at',
      'idx_family_phone_devices_household_singleton',
      'idx_family_phone_devices_pstn_label',
      'idx_family_phone_devices_user_id',
      'idx_family_phone_pair_expires_at',
      'idx_family_phone_pair_user_code',
      'idx_family_phone_pstn_calls_source_created',
      'idx_family_phone_pstn_contacts_label',
      'idx_family_phone_push_subs_device_id',
      'idx_family_phone_voice_messages_to_read',
      'idx_messages_created_by',
      'idx_sessions_expires_at',
      'idx_sessions_user_id',
      'idx_tasks_assigned_to',
      'idx_tasks_defer_until',
      'idx_tasks_deleted_at',
      'idx_tasks_parent_position',
      'idx_tasks_status',
    ]);
  });

  test('applySchema seeds exactly one kind=household device row, idempotently', () => {
    applySchema(db);
    applySchema(db);
    const rows = db
      .prepare<{ id: number; label: string; user_id: number | null }, []>(
        "SELECT id, label, user_id FROM family_phone_devices WHERE kind='household'",
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.user_id).toBeNull();
  });

  test('applySchema adds users.in_ivr_menu (default 0) and pstn_contacts.intended_user_id', () => {
    applySchema(db);
    interface ColRow { name: string; dflt_value: string | null }
    const userCols = db
      .prepare<ColRow, []>('PRAGMA table_info(users)')
      .all();
    const ivr = userCols.find((c) => c.name === 'in_ivr_menu');
    expect(ivr).toBeTruthy();
    expect(ivr?.dflt_value).toBe('0');
    const contactCols = db
      .prepare<ColRow, []>('PRAGMA table_info(family_phone_pstn_contacts)')
      .all();
    expect(contactCols.find((c) => c.name === 'intended_user_id')).toBeTruthy();
  });
});
