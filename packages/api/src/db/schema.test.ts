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
      'push_subscriptions',
      'sessions',
      'tasks',
      'users',
    ]);
  });

  test('tasks table has the columns documented in docs/tasks-v1.md, plus kind', () => {
    applySchema(db);
    const cols = columns(db, 'tasks').map((c) => c.name).sort();
    expect(cols).toEqual([
      'assigned_to',
      'client_id',
      'completed_at',
      'created_at',
      'created_by',
      'defer_until',
      'deleted_at',
      'due_at',
      'id',
      'kind',
      'notes',
      'parent_id',
      'position',
      'recurrence',
      'reminded_at',
      'sequential',
      'spawn_group',
      'spawned_from',
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
    // The tie holds for every live state, not only the one that used to exist:
    // a `blocked` row carrying a completion timestamp is as wrong as a `todo`
    // one, and the board can move a card into any of the three.
    for (const status of ['todo', 'doing', 'blocked']) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (title, status, completed_at, created_by, updated_by) VALUES ('t', '${status}', datetime('now'), 1, 1)`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (title, status, created_by, updated_by) VALUES ('t', '${status}', 1, 1)`,
          )
          .run(),
      ).not.toThrow();
    }
  });

  test('tasks.status is CHECK-bounded to the four workflow states', () => {
    applySchema(db);
    db.prepare("INSERT INTO users (display_name) VALUES ('alex')").run();
    // The vocabulary the widened column admits. 'open' is gone: a row still
    // carrying it would have been rewritten by the rebuild, so accepting one
    // now would let a half-migrated write back in.
    for (const status of ['open', 'started', 'waiting', '']) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (title, status, created_by, updated_by) VALUES ('t', '${status}', 1, 1)`,
          )
          .run(),
      ).toThrow();
    }
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (title, status, completed_at, created_by, updated_by) VALUES ('t', 'done', datetime('now'), 1, 1)",
        )
        .run(),
    ).not.toThrow();
  });

  test('tasks.kind defaults to task, is CHECK-bounded, and survives a repeat apply', () => {
    applySchema(db);
    db.prepare("INSERT INTO users (display_name) VALUES ('alex')").run();
    // A row written before the column existed reads as a plain task. A row
    // holding nothing stays there — only a row that already holds children is
    // levelled up, by promoteGrandfatheredContainers.
    db.prepare("INSERT INTO tasks (title, status, created_by, updated_by) VALUES ('captured', 'todo', 1, 1)").run();

    interface KindRow { kind: string }
    const before = db.prepare<KindRow, []>("SELECT kind FROM tasks WHERE title = 'captured'").get();
    expect(before?.kind).toBe('task');

    // The CHECK bounds the vocabulary. What it cannot police is the pairing
    // with the parent row — that is handlers/tasks.shared.ts:levelViolation.
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (title, status, kind, created_by, updated_by) VALUES ('x', 'todo', 'milestone', 1, 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (title, status, kind, created_by, updated_by) VALUES ('x', 'todo', 'project', 1, 1)",
        )
        .run(),
    ).not.toThrow();

    // Idempotent: a second and third apply neither re-adds the column nor
    // rewrites the rows that were already there.
    applySchema(db);
    applySchema(db);
    interface CountRow { n: number }
    const kinds = db
      .prepare<CountRow, []>("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'task'")
      .get();
    expect(kinds?.n).toBe(1);
    const after = db.prepare<KindRow, []>("SELECT kind FROM tasks WHERE title = 'captured'").get();
    expect(after?.kind).toBe('task');
  });

  /**
   * A tasks table in the shape it had before `kind` existed. `applySchema`
   * skips a `CREATE TABLE IF NOT EXISTS` for a table already present, so
   * applying over this runs the real upgrade path: ensureColumn adds the
   * column, every row defaults to 'task', and the promote pass then runs.
   */
  function seedPreKindTasks(db: DatabaseClient): void {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (display_name) VALUES ('alex');
      CREATE TABLE tasks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        title         TEXT    NOT NULL,
        notes         TEXT    NOT NULL DEFAULT '',
        status        TEXT    NOT NULL CHECK (status IN ('open','done')),
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
    `);
  }

  /** Insert one pre-migration task and return its id. */
  function seedTask(
    db: DatabaseClient,
    title: string,
    parentId: number | null,
    deletedAt: string | null = null,
  ): number {
    interface IdRow { id: number }
    const row = db
      .prepare<IdRow, [number | null, string, string | null]>(
        `INSERT INTO tasks (parent_id, title, status, deleted_at, created_by, updated_by)
         VALUES (?, ?, 'open', ?, 1, 1) RETURNING id`,
      )
      .get(parentId, title, deletedAt);
    if (row === null) throw new Error(`insert failed for ${title}`);
    return row.id;
  }

  function kindOf(db: DatabaseClient, id: number): string {
    interface KindRow { kind: string }
    const row = db.prepare<KindRow, [number]>('SELECT kind FROM tasks WHERE id = ?').get(id);
    if (row === null) throw new Error(`no task ${id}`);
    return row.kind;
  }

  test('a pre-kind tree is levelled on upgrade: root project, its parent child epic', () => {
    seedPreKindTasks(db);
    // The shape the household already has: a job, a step inside it, and a step
    // inside that. Every row would default to 'task', which no write path can
    // produce, so all three pairings would be illegal from the first boot.
    const project = seedTask(db, 'Redecorate the hall', null);
    const epic = seedTask(db, 'Choose a paint colour', project);
    const leaf = seedTask(db, 'Get tester pots', epic);
    const lonely = seedTask(db, 'Book the dentist', null);

    applySchema(db);

    expect(kindOf(db, project)).toBe('project');
    expect(kindOf(db, epic)).toBe('epic');
    // A row holding nothing keeps the default — a task under an epic is legal.
    expect(kindOf(db, leaf)).toBe('task');
    // So does a root holding nothing. Nothing is promoted for being a root.
    expect(kindOf(db, lonely)).toBe('task');
  });

  test('a trashed child still levels its parent — restore must not break it', () => {
    seedPreKindTasks(db);
    const parent = seedTask(db, 'Plan the trip', null);
    seedTask(db, 'Book flights', parent, '2026-05-20 09:00:00');

    applySchema(db);

    expect(kindOf(db, parent)).toBe('project');
  });

  test('the promote pass is idempotent and never overwrites a chosen level', () => {
    seedPreKindTasks(db);
    const project = seedTask(db, 'Redecorate the hall', null);
    const epic = seedTask(db, 'Choose a paint colour', project);
    applySchema(db);

    // Re-level by hand, past what any write path allows: the pass must leave it
    // alone on the next boot, because it only ever writes a row reading 'task'.
    db.prepare<never, [number]>("UPDATE tasks SET kind = 'project' WHERE id = ?").run(epic);
    applySchema(db);
    applySchema(db);

    expect(kindOf(db, project)).toBe('project');
    expect(kindOf(db, epic)).toBe('project');
  });

  test('a fourth level has no legal kind: it is reported, not rewritten', () => {
    seedPreKindTasks(db);
    const project = seedTask(db, 'Move house', null);
    const epic = seedTask(db, 'Pack the kitchen', project);
    const stranded = seedTask(db, 'Pack the plates', epic);
    const deepest = seedTask(db, 'Wrap each plate', stranded);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      applySchema(db);
    } finally {
      console.warn = realWarn;
    }

    expect(kindOf(db, project)).toBe('project');
    expect(kindOf(db, epic)).toBe('epic');
    // Three levels is the whole model, so this row has nowhere to go. It keeps
    // the default rather than having its tree rewritten under it.
    expect(kindOf(db, stranded)).toBe('task');
    expect(kindOf(db, deepest)).toBe('task');
    // And the operator is told, with the id, instead of finding out later.
    expect(warnings.join('\n')).toContain(String(stranded));
  });

  test('a database with nothing to promote logs nothing', () => {
    seedPreKindTasks(db);
    seedTask(db, 'Book the dentist', null);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      applySchema(db);
      applySchema(db);
    } finally {
      console.warn = realWarn;
    }

    expect(warnings).toEqual([]);
  });

  test('running applySchema twice is a no-op', () => {
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();

    const userCols = columns(db, 'users').map((c) => c.name).sort();
    expect(userCols).toEqual(['created_at', 'display_name', 'id', 'in_ivr_menu']);

    const taskCols = columns(db, 'tasks').map((c) => c.name);
    // Same set after the second apply. 22 since stage 6 added `recurrence`,
    // `spawned_from` and `spawn_group`.
    expect(taskCols.length).toBe(22);
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

  /**
   * A tasks table in the shape stage 1 left behind: `kind` present, `status`
   * still bounded to ('open','done'). This is the exact on-disk shape a real
   * install has before stage 2, so applying over it runs the real rebuild.
   */
  function seedPreStatusTasks(db: DatabaseClient): void {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (display_name) VALUES ('alex');
      CREATE TABLE tasks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        title         TEXT    NOT NULL,
        notes         TEXT    NOT NULL DEFAULT '',
        status        TEXT    NOT NULL CHECK (status IN ('open','done')),
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
      CREATE INDEX idx_tasks_parent_position ON tasks (parent_id, position);
      CREATE INDEX idx_tasks_assigned_to     ON tasks (assigned_to);
      CREATE INDEX idx_tasks_status          ON tasks (status);
      CREATE INDEX idx_tasks_defer_until     ON tasks (defer_until);
      CREATE INDEX idx_tasks_deleted_at      ON tasks (deleted_at);
      CREATE INDEX idx_tasks_kind            ON tasks (kind);
    `);
  }

  interface TaskStateRow {
    id: number;
    title: string;
    status: string;
    kind: string;
    parent_id: number | null;
    completed_at: string | null;
    deleted_at: string | null;
    position: number;
  }

  function taskStates(db: DatabaseClient): TaskStateRow[] {
    return db
      .prepare<TaskStateRow, []>(
        'SELECT id, title, status, kind, parent_id, completed_at, deleted_at, position FROM tasks ORDER BY id',
      )
      .all();
  }

  test('tasks.sequential defaults to 0, is CHECK-bounded, and survives a repeat apply', () => {
    applySchema(db);
    db.prepare("INSERT INTO users (display_name) VALUES ('alex')").run();
    // Default 0 is the whole promise of this migration: every container that
    // existed before the column is parallel, which is what it already was.
    db.prepare(
      "INSERT INTO tasks (title, status, kind, created_by, updated_by) VALUES ('kitchen', 'todo', 'project', 1, 1)",
    ).run();
    interface SeqRow { sequential: number }
    const before = db
      .prepare<SeqRow, []>("SELECT sequential FROM tasks WHERE title = 'kitchen'")
      .get();
    expect(before?.sequential).toBe(0);

    // The CHECK bounds it to a real flag. SQLite has no boolean type, so
    // without this any integer — or a string — would be storable and the SPA
    // would read a truthy 7 as "sequential".
    for (const bad of ['2', '-1', "'true'"]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (title, status, sequential, created_by, updated_by) VALUES ('x', 'todo', ${bad}, 1, 1)`,
          )
          .run(),
      ).toThrow();
    }
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (title, status, sequential, created_by, updated_by) VALUES ('x', 'todo', 1, 1, 1)",
        )
        .run(),
    ).not.toThrow();

    // A flag chosen after the migration survives every later boot.
    db.prepare("UPDATE tasks SET sequential = 1 WHERE title = 'kitchen'").run();
    applySchema(db);
    applySchema(db);
    const after = db
      .prepare<SeqRow, []>("SELECT sequential FROM tasks WHERE title = 'kitchen'")
      .get();
    expect(after?.sequential).toBe(1);
  });

  test('sequential survives an upgrade from the pre-stage-2 shape — the rebuild does not eat it', () => {
    // The trap this stage most easily falls into. `rebuildTasksStatusIfLegacy`
    // copies the table through a hand-written column list, so an ensureColumn
    // placed *before* it would have its column silently dropped on any database
    // still on the stage-1 shape — the exact database this test starts from.
    // Placed after the rebuild, the column lands on the rebuilt table and the
    // rows keep the default.
    seedPreStatusTasks(db);
    db.exec(`
      INSERT INTO tasks (id, parent_id, title, status, kind, position, created_by, updated_by)
      VALUES (1, NULL, 'project', 'open', 'project', 0, 1, 1),
             (2, 1, 'step one', 'open', 'task', 0, 1, 1);
    `);

    applySchema(db);

    const cols = columns(db, 'tasks').map((c) => c.name);
    expect(cols).toContain('sequential');
    interface SeqRow { id: number; sequential: number }
    expect(
      db.prepare<SeqRow, []>('SELECT id, sequential FROM tasks ORDER BY id').all(),
    ).toEqual([
      { id: 1, sequential: 0 },
      { id: 2, sequential: 0 },
    ]);
    // …and the migration changed no behaviour: the status rebuild still ran,
    // and the parent link the rebuild exists to protect is intact.
    interface ShapeRow { status: string; parent_id: number | null }
    expect(
      db.prepare<ShapeRow, []>('SELECT status, parent_id FROM tasks ORDER BY id').all(),
    ).toEqual([
      { status: 'todo', parent_id: null },
      { status: 'todo', parent_id: 1 },
    ]);
  });

  test('reminded_at survives an upgrade from the pre-stage-2 shape, and starts NULL', () => {
    // The stage-3 trap, one column later, and it does not get safer with
    // repetition. `rebuildTasksStatusIfLegacy` copies `tasks` through a
    // hand-written column list in both its CREATE and its INSERT…SELECT, so an
    // ensureColumn placed before it loses its column on exactly the database
    // this test starts from — no error, no log, just a column that is not
    // there and a reminder scan that throws on every tick.
    //
    // Moving the `reminded_at` ensureColumn above `rebuildTasksStatusIfLegacy`
    // in db/schema.ts fails this test at the first expect.
    seedPreStatusTasks(db);
    db.exec(`
      INSERT INTO tasks (id, parent_id, title, status, kind, due_at, position, created_by, updated_by)
      VALUES (1, NULL, 'Bins out', 'open', 'task', '2026-01-01', 0, 1, 1),
             (2, NULL, 'No deadline', 'open', 'task', NULL, 1, 1, 1);
    `);

    applySchema(db);

    expect(columns(db, 'tasks').map((c) => c.name)).toContain('reminded_at');
    interface RemindedRow { id: number; reminded_at: string | null; due_at: string | null }
    expect(
      db
        .prepare<RemindedRow, []>('SELECT id, reminded_at, due_at FROM tasks ORDER BY id')
        .all(),
    ).toEqual([
      // Every migrated row starts unreminded, including one whose deadline is
      // years past. That is the deliberate choice: the scan will fire once for
      // it on the first tick after the upgrade, rather than the migration
      // silently deciding those deadlines were already dealt with.
      { id: 1, reminded_at: null, due_at: '2026-01-01' },
      { id: 2, reminded_at: null, due_at: null },
    ]);

    // The partial index the scan reads is on the rebuilt table too, and it is
    // partial: a row with no deadline is not in it.
    interface IndexSqlRow { sql: string }
    const index = db
      .prepare<IndexSqlRow, []>(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tasks_due_reminder'",
      )
      .get();
    expect(index?.sql).toContain('reminded_at IS NULL');
  });

  test('client_id survives an upgrade from the pre-stage-2 shape, starts NULL, and is unique per creator', () => {
    // The same trap as `sequential` and `reminded_at`: the ensureColumn must
    // stay below `rebuildTasksStatusIfLegacy`, or the rebuild's hand-written
    // column list drops it on exactly this database.
    seedPreStatusTasks(db);
    db.exec(`
      INSERT INTO tasks (id, parent_id, title, status, kind, position, created_by, updated_by)
      VALUES (1, NULL, 'Bins out', 'open', 'task', 0, 1, 1),
             (2, NULL, 'Post letter', 'open', 'task', 1, 1, 1);
    `);

    applySchema(db);

    interface ClientIdRow { id: number; client_id: string | null }
    expect(
      db.prepare<ClientIdRow, []>('SELECT id, client_id FROM tasks ORDER BY id').all(),
    ).toEqual([
      // Two NULLs side by side: the index is partial, so the rows that existed
      // before the column do not collide with each other.
      { id: 1, client_id: null },
      { id: 2, client_id: null },
    ]);

    db.exec("UPDATE tasks SET client_id = 'c-1' WHERE id = 1");
    expect(() => db.exec("UPDATE tasks SET client_id = 'c-1' WHERE id = 2")).toThrow(/UNIQUE/);
  });

  test('the recurrence columns survive an upgrade from the pre-stage-2 shape and start NULL', () => {
    // The same trap again: three ensureColumns that must stay below
    // `rebuildTasksStatusIfLegacy`, or the rebuild's hand-written column list
    // drops them on exactly this database.
    seedPreStatusTasks(db);
    db.exec(`
      INSERT INTO tasks (id, parent_id, title, status, kind, position, created_by, updated_by)
      VALUES (1, NULL, 'Bins out', 'open', 'task', 0, 1, 1);
    `);

    applySchema(db);

    interface RecurrenceRow {
      recurrence: string | null;
      spawned_from: number | null;
      spawn_group: number | null;
    }
    expect(
      db
        .prepare<RecurrenceRow, []>('SELECT recurrence, spawned_from, spawn_group FROM tasks')
        .all(),
    ).toEqual([{ recurrence: null, spawned_from: null, spawn_group: null }]);
  });

  test('reminded_at set by hand survives a repeat apply', () => {
    applySchema(db);
    db.prepare("INSERT INTO users (display_name) VALUES ('alex')").run();
    db.exec(
      "INSERT INTO tasks (title, status, due_at, reminded_at, created_by, updated_by)" +
        " VALUES ('x', 'todo', '2026-01-01', '2026-01-01 09:00:00', 1, 1)",
    );
    applySchema(db);
    applySchema(db);
    interface RemindedRow { reminded_at: string | null }
    expect(
      db.prepare<RemindedRow, []>('SELECT reminded_at FROM tasks').get()?.reminded_at,
    ).toBe('2026-01-01 09:00:00');
  });

  test("the status rebuild maps 'open' to 'todo' and carries every row across", () => {
    seedPreStatusTasks(db);
    const DONE_AT = '2026-03-01 09:15:00';
    const TRASHED_AT = '2026-03-02 18:00:00';
    db.exec(`
      INSERT INTO tasks (id, parent_id, title, status, kind, completed_at, deleted_at, position, created_by, updated_by)
      VALUES
        (1, NULL, 'project',  'open', 'project', NULL,        NULL,          0, 1, 1),
        (2, 1,    'epic',     'open', 'epic',    NULL,        NULL,          0, 1, 1),
        (3, 2,    'finished', 'done', 'task',    '${DONE_AT}', NULL,          3, 1, 1),
        (4, 2,    'open leaf','open', 'task',    NULL,        NULL,          7, 1, 1),
        (5, 1,    'binned',   'done', 'task',    '${DONE_AT}', '${TRASHED_AT}', 1, 1, 1);
    `);

    applySchema(db);

    expect(taskStates(db)).toEqual([
      { id: 1, title: 'project', status: 'todo', kind: 'project', parent_id: null, completed_at: null, deleted_at: null, position: 0 },
      { id: 2, title: 'epic', status: 'todo', kind: 'epic', parent_id: 1, completed_at: null, deleted_at: null, position: 0 },
      { id: 3, title: 'finished', status: 'done', kind: 'task', parent_id: 2, completed_at: DONE_AT, deleted_at: null, position: 3 },
      { id: 4, title: 'open leaf', status: 'todo', kind: 'task', parent_id: 2, completed_at: null, deleted_at: null, position: 7 },
      { id: 5, title: 'binned', status: 'done', kind: 'task', parent_id: 1, completed_at: DONE_AT, deleted_at: TRASHED_AT, position: 1 },
    ]);
  });

  test('the status rebuild keeps the self-referencing cascade working', () => {
    // The failure this guards against is silent: a rebuild that dropped the
    // ON DELETE CASCADE would leave the children of a hard-deleted project
    // pointing at a row that no longer exists, and nothing would say so until
    // a tree walk went missing.
    seedPreStatusTasks(db);
    db.exec(`
      INSERT INTO tasks (id, parent_id, title, status, kind, position, created_by, updated_by)
      VALUES (1, NULL, 'project', 'open', 'project', 0, 1, 1),
             (2, 1, 'child', 'open', 'task', 0, 1, 1),
             (3, 2, 'grandchild', 'open', 'task', 0, 1, 1);
    `);
    applySchema(db);

    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM tasks WHERE id = 1').run();
    expect(taskStates(db)).toEqual([]);
  });

  test('the status rebuild puts every index back', () => {
    seedPreStatusTasks(db);
    applySchema(db);
    interface IndexRow { name: string }
    const indexes = db
      .prepare<IndexRow, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual([
      'idx_tasks_assigned_to',
      'idx_tasks_client_id',
      'idx_tasks_defer_until',
      'idx_tasks_deleted_at',
      // Created after the rebuild, not replayed by it: it filters on
      // `reminded_at`, whose ensureColumn also runs after the rebuild. The
      // ordering is the whole hazard — see the stage-4 test below.
      'idx_tasks_due_reminder',
      'idx_tasks_kind',
      'idx_tasks_parent_position',
      'idx_tasks_spawn_group',
      'idx_tasks_spawned_from',
      'idx_tasks_status',
    ]);
  });

  test('the status rebuild is idempotent — a second apply neither rebuilds nor rewrites', () => {
    seedPreStatusTasks(db);
    db.exec(`
      INSERT INTO tasks (id, parent_id, title, status, kind, position, created_by, updated_by)
      VALUES (1, NULL, 'x', 'open', 'task', 0, 1, 1);
    `);
    applySchema(db);
    // A lane chosen after the migration must survive the next boot. If the
    // detection were wrong the table would rebuild again — harmless here, but
    // it would also re-run the 'open' → 'todo' CASE over a column that has
    // moved on, and nothing else would notice.
    db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = 1").run();
    applySchema(db);
    applySchema(db);
    expect(taskStates(db).map((r) => r.status)).toEqual(['blocked']);
  });

  test('a fresh database is never rebuilt — the widened CHECK is there from the CREATE', () => {
    applySchema(db);
    interface SqlRow { sql: string }
    const before = db
      .prepare<SqlRow, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get();
    // A rebuilt table comes back from `ALTER TABLE … RENAME` with its name
    // quoted, so the CREATE text is how a rebuild announces itself.
    expect(before?.sql.startsWith('CREATE TABLE tasks')).toBe(true);
    expect(before?.sql).toContain("'doing'");
    applySchema(db);
    const after = db
      .prepare<SqlRow, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get();
    expect(after?.sql).toBe(before?.sql ?? '');
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
      'idx_push_subscriptions_user_id',
      'idx_sessions_expires_at',
      'idx_sessions_user_id',
      'idx_tasks_assigned_to',
      'idx_tasks_client_id',
      'idx_tasks_defer_until',
      'idx_tasks_deleted_at',
      'idx_tasks_due_reminder',
      'idx_tasks_kind',
      'idx_tasks_parent_position',
      'idx_tasks_spawn_group',
      'idx_tasks_spawned_from',
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
