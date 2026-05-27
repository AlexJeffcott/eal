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
      'family_phone_push_subscriptions',
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
    expect(userCols).toEqual(['created_at', 'display_name', 'id']);

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
      'idx_family_phone_devices_user_id',
      'idx_family_phone_pair_expires_at',
      'idx_family_phone_pair_user_code',
      'idx_family_phone_push_subs_device_id',
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
});
