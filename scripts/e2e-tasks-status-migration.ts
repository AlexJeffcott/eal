#!/usr/bin/env bun
/**
 * Verification artefact for the tasks status migration — stage 2 of the
 * project/epic/task work.
 *
 * `tasks.status` widens from ('open','done') to ('todo','doing','blocked',
 * 'done'). SQLite cannot ALTER a CHECK constraint, so unlike stage 1's `kind`
 * this is a **table rebuild**: create, copy, drop, rename. `tasks.parent_id` is
 * a self-referencing foreign key with ON DELETE CASCADE, so a rebuild that
 * copies badly does not fail loudly — it silently loses the household's
 * subtasks. A green unit tier does not prove the deployed shape survives, which
 * is what this script is for.
 *
 * It runs the real upgrade, not a reconstruction of one:
 *   1. Build a database with the current schema, then rebuild `tasks` back to
 *      the pre-stage-2 shape — the old two-value CHECK, no other change.
 *   2. Write a real tree into it the way the old code would have: three levels,
 *      tasks in both old states, completed rows carrying a completed_at, rows
 *      in the trash, an assignee, a due date, chosen positions.
 *   3. Boot the real api over that file. `applySchema` runs at boot, so the
 *      rebuild happens inside the server process.
 *   4. Read every row back over real HTTP with a real session token, and check
 *      each one against what was written: status, parent, level, completed_at,
 *      position, due date, assignee, and the trash.
 *   5. Prove the new column is live both ways — the board's lane move reaches
 *      `blocked`, and a status outside the four is refused.
 *   6. Boot a second time and confirm nothing moved.
 *
 * Exits 0 on success, or 1 naming the first check that failed.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApi, type BootedApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

// The api serves a self-signed certificate in development.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

function fail(message: string): never {
  console.error(`e2e-tasks-status-migration: FAIL — ${message}`);
  process.exit(1);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

interface IdRow { id: number }

/** A response body, or a marker, so a failure message always carries one. */
async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

/**
 * Put `tasks` back in its pre-stage-2 shape: the old two-value CHECK, every
 * other column and index exactly as it is today. The inverse of
 * db/schema.ts:rebuildTasksStatusIfLegacy, and written the same way, so what
 * the server meets at boot is the shape a real 0.x install has on disk.
 */
function downgradeTasksTable(db: Database): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE tasks_legacy (
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
    DROP TABLE tasks;
    ALTER TABLE tasks_legacy RENAME TO tasks;
    CREATE INDEX idx_tasks_parent_position ON tasks (parent_id, position);
    CREATE INDEX idx_tasks_assigned_to     ON tasks (assigned_to);
    CREATE INDEX idx_tasks_status          ON tasks (status);
    CREATE INDEX idx_tasks_defer_until     ON tasks (defer_until);
    CREATE INDEX idx_tasks_deleted_at      ON tasks (deleted_at);
    CREATE INDEX idx_tasks_kind            ON tasks (kind);
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}

interface LegacyTask {
  title: string;
  parentId: number | null;
  kind: 'project' | 'epic' | 'task';
  status: 'open' | 'done';
  completedAt: string | null;
  deletedAt: string | null;
  dueAt: string | null;
  assignedTo: number | null;
  position: number;
}

/** Insert one task the way the pre-stage-2 code did, and return its id. */
function insertLegacyTask(db: Database, userId: number, task: LegacyTask): number {
  const row = db
    .prepare<
      IdRow,
      [
        number | null,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        number | null,
        number,
        number,
        number,
      ]
    >(
      `INSERT INTO tasks
         (parent_id, title, status, kind, completed_at, deleted_at, due_at,
          assigned_to, position, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      task.parentId,
      task.title,
      task.status,
      task.kind,
      task.completedAt,
      task.deletedAt,
      task.dueAt,
      task.assignedTo,
      task.position,
      userId,
      userId,
    );
  if (row === null) fail(`could not insert ${task.title}`);
  return row.id;
}

interface WireTask {
  id: number;
  title: string;
  kind: string;
  status: string;
  parentId: number | null;
  completedAt: string | null;
  deletedAt: string | null;
  dueAt: string | null;
  assignedTo: number | null;
  position: number;
}

async function listTasks(
  apiUrl: string,
  token: string,
  query: string,
): Promise<WireTask[]> {
  const res = await fetch(`${apiUrl}/api/v1/tasks${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) fail(`GET /api/v1/tasks${query} answered ${res.status}: ${await bodyText(res)}`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('tasks' in body)) {
    fail(`GET /api/v1/tasks${query} returned no \`tasks\` array`);
  }
  const { tasks } = body;
  if (!Array.isArray(tasks)) fail(`GET /api/v1/tasks${query} returned a non-array \`tasks\``);
  return tasks;
}

function find(tasks: readonly WireTask[], id: number, where: string): WireTask {
  const found = tasks.find((t) => t.id === id);
  if (found === undefined) fail(`task ${id} is missing from ${where} — the rebuild lost a row`);
  return found;
}

/**
 * Exit code for the runner. The whole script runs inside a function so the
 * `process.exit` at the bottom is the only way out: a stray handle from a
 * spawned api would otherwise keep bun alive and hang the multi tier.
 */
async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'eal-status-'));
  const dbPath = join(dir, 'legacy.db');
  let api: BootedApi | null = null;

  try {
    // ── 1. A database in the pre-stage-2 shape ────────────────────────────────
    const seeded = seedCliToken({ dbPath, displayName: 'status-migration', ttlMs: 10 * 60_000 });

    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    downgradeTasksTable(db);
    const preShape = db
      .prepare<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'",
      )
      .get();
    check(preShape !== null, 'the downgraded database has no tasks table at all');
    check(
      preShape !== null && !preShape.sql.includes("'doing'"),
      'the pre-migration database already carries the widened status CHECK',
    );

    // ── 2. The tree the household already has ─────────────────────────────────
    // Three levels, both old statuses, a completed row with its timestamp, a
    // row in the trash, an assignee, a due date, chosen positions. Every one of
    // those is something a careless copy would drop.
    const DONE_AT = '2026-03-01 09:15:00';
    const TRASHED_AT = '2026-03-02 18:00:00';
    const project = insertLegacyTask(db, seeded.userId, {
      title: 'Redecorate the hall', parentId: null, kind: 'project', status: 'open',
      completedAt: null, deletedAt: null, dueAt: null, assignedTo: null, position: 0,
    });
    const epic = insertLegacyTask(db, seeded.userId, {
      title: 'Choose a paint colour', parentId: project, kind: 'epic', status: 'open',
      completedAt: null, deletedAt: null, dueAt: null, assignedTo: null, position: 0,
    });
    const finished = insertLegacyTask(db, seeded.userId, {
      title: 'Get tester pots', parentId: epic, kind: 'task', status: 'done',
      completedAt: DONE_AT, deletedAt: null, dueAt: '2026-02-28', assignedTo: seeded.userId,
      position: 3,
    });
    const openLeaf = insertLegacyTask(db, seeded.userId, {
      title: 'Paint the ceiling', parentId: epic, kind: 'task', status: 'open',
      completedAt: null, deletedAt: null, dueAt: null, assignedTo: null, position: 7,
    });
    const trashedOpen = insertLegacyTask(db, seeded.userId, {
      title: 'Hire a scaffold', parentId: project, kind: 'task', status: 'open',
      completedAt: null, deletedAt: TRASHED_AT, dueAt: null, assignedTo: null, position: 1,
    });
    const trashedDone = insertLegacyTask(db, seeded.userId, {
      title: 'Return the wallpaper', parentId: null, kind: 'task', status: 'done',
      completedAt: DONE_AT, deletedAt: TRASHED_AT, dueAt: null, assignedTo: null, position: 9,
    });
    const loose = insertLegacyTask(db, seeded.userId, {
      title: 'Book the dentist', parentId: null, kind: 'task', status: 'open',
      completedAt: null, deletedAt: null, dueAt: null, assignedTo: null, position: 1,
    });
    const beforeCount = db
      .prepare<{ n: number }, []>('SELECT COUNT(*) AS n FROM tasks')
      .get();
    check(beforeCount?.n === 7, `expected to write 7 rows, wrote ${beforeCount?.n ?? 0}`);
    db.close();
    console.log('e2e-tasks-status-migration: wrote 7 rows under the old two-value status CHECK');

    // ── 3. Boot the real server over it ───────────────────────────────────────
    api = await bootApi({ database: dbPath });
    console.log('e2e-tasks-status-migration: api booted over the pre-migration database');

    // ── 4. Every row, read back over HTTP ─────────────────────────────────────
    const live = await listTasks(api.url, seeded.token, '');
    const trash = await listTasks(api.url, seeded.token, '?trash=1');
    check(
      live.length + trash.length === 7,
      `the rebuild changed the row count: ${live.length} live + ${trash.length} trashed, expected 7`,
    );

    // The migration itself: every 'open' became 'todo', 'done' stayed put.
    // This is the first check for a reason — remove the rebuild and it is what
    // fails, naming the state it actually found.
    for (const [id, expected] of [
      [project, 'todo'], [epic, 'todo'], [openLeaf, 'todo'], [loose, 'todo'],
      [finished, 'done'],
    ] as const) {
      const row = find(live, id, 'the live list');
      check(
        row.status === expected,
        `"${row.title}" reads status ${row.status}, expected ${expected} — the status rebuild did not run`,
      );
    }
    for (const [id, expected] of [[trashedOpen, 'todo'], [trashedDone, 'done']] as const) {
      const row = find(trash, id, 'the trash');
      check(row.status === expected, `trashed "${row.title}" reads ${row.status}, expected ${expected}`);
    }
    console.log("e2e-tasks-status-migration: every 'open' row now reads 'todo'; 'done' rows stayed done");

    // The completion timestamp is the half of the storage CHECK a rebuild can
    // quietly drop, taking the row's whole history with it.
    check(
      find(live, finished, 'the live list').completedAt === DONE_AT,
      `the completed row lost its completed_at: ${find(live, finished, 'the live list').completedAt}`,
    );
    check(
      find(trash, trashedDone, 'the trash').completedAt === DONE_AT,
      'the trashed completed row lost its completed_at',
    );
    check(
      find(live, openLeaf, 'the live list').completedAt === null,
      'an unfinished row came back with a completed_at',
    );
    console.log('e2e-tasks-status-migration: completed_at survived on both completed rows');

    // The tree. `parent_id` is the self-referencing FK the rebuild has to carry
    // across with foreign keys momentarily off; get it wrong and the household
    // loses every subtask.
    check(find(live, project, 'the live list').parentId === null, 'the project gained a parent');
    check(find(live, epic, 'the live list').parentId === project, 'the epic lost its project');
    check(find(live, finished, 'the live list').parentId === epic, 'the completed task lost its epic');
    check(find(live, openLeaf, 'the live list').parentId === epic, 'the open leaf lost its epic');
    check(find(trash, trashedOpen, 'the trash').parentId === project, 'the trashed child lost its project');
    console.log('e2e-tasks-status-migration: every parent_id survived, trashed rows included');

    // The level column stage 1 added rides through untouched, and so do the
    // fields a lane sorts and a row displays by.
    check(find(live, project, 'the live list').kind === 'project', 'the project lost its level');
    check(find(live, epic, 'the live list').kind === 'epic', 'the epic lost its level');
    check(find(live, loose, 'the live list').kind === 'task', 'a plain task changed level');
    const finishedRow = find(live, finished, 'the live list');
    check(finishedRow.position === 3, `position was rewritten: ${finishedRow.position}`);
    check(finishedRow.dueAt === '2026-02-28', `due_at was lost: ${finishedRow.dueAt}`);
    check(finishedRow.assignedTo === seeded.userId, `assigned_to was lost: ${finishedRow.assignedTo}`);
    check(
      find(trash, trashedOpen, 'the trash').deletedAt === TRASHED_AT,
      'a trashed row lost its deleted_at',
    );
    console.log('e2e-tasks-status-migration: kind, position, due_at, assigned_to and deleted_at intact');

    // ── 5. The new column is live in both directions ──────────────────────────
    const blocked = await fetch(`${api.url}/api/v1/tasks/${openLeaf}/status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${seeded.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'blocked' }),
    });
    check(
      blocked.ok,
      `moving a migrated row to blocked answered ${blocked.status}: ${await bodyText(blocked)}`,
    );
    console.log('e2e-tasks-status-migration: a migrated row moves to the blocked lane');

    const bogus = await fetch(`${api.url}/api/v1/tasks/${openLeaf}/status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${seeded.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'started' }),
    });
    check(
      bogus.status >= 400 && bogus.status < 500,
      `a status outside the four answered ${bogus.status}, expected a 4xx`,
    );
    console.log('e2e-tasks-status-migration: a state outside the four is refused');

    // The index the widened column is read through has to come back with the
    // table, or every status filter turns into a scan nobody notices.
    const reopened = new Database(dbPath, { readonly: true });
    const indexNames = reopened
      .prepare<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL",
      )
      .all()
      .map((r) => r.name)
      .sort();
    reopened.close();
    for (const expected of [
      'idx_tasks_assigned_to', 'idx_tasks_deleted_at', 'idx_tasks_defer_until',
      'idx_tasks_kind', 'idx_tasks_parent_position', 'idx_tasks_status',
    ]) {
      check(
        indexNames.includes(expected),
        `${expected} did not survive the rebuild; the table carries ${indexNames.join(', ')}`,
      );
    }
    console.log('e2e-tasks-status-migration: all six indexes came back with the table');

    // ── 6. A second boot changes nothing ──────────────────────────────────────
    await api.kill();
    api = await bootApi({ database: dbPath });
    const again = await listTasks(api.url, seeded.token, '');
    const againTrash = await listTasks(api.url, seeded.token, '?trash=1');
    check(
      again.length + againTrash.length === 7,
      `the second boot changed the row count to ${again.length + againTrash.length}`,
    );
    check(
      find(again, openLeaf, 'the second boot').status === 'blocked',
      'the second boot reset a lane that had been chosen',
    );
    check(
      find(again, finished, 'the second boot').completedAt === DONE_AT,
      'the second boot moved a completed_at',
    );
    console.log('e2e-tasks-status-migration: a second boot rebuilds nothing and moves nothing');

    console.log('e2e-tasks-status-migration: OK');
  } finally {
    if (api !== null) await api.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

process.exit(await main());
