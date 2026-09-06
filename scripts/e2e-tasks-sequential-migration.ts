#!/usr/bin/env bun
/**
 * Verification artefact for stage 3 — `tasks.sequential`, and the answer it
 * makes possible.
 *
 * Two things are proved here that no unit test can, and one hazard is proved
 * closed.
 *
 * **The hazard.** `sequential` is added by `ensureColumn`, which is an
 * `ALTER TABLE`. `rebuildTasksStatusIfLegacy` in the same file rebuilds `tasks`
 * through a **hand-written column list** in both its `CREATE TABLE` and its
 * `INSERT … SELECT` (db/schema.ts). An `ensureColumn` placed before that call
 * would have its column silently dropped on any database still on the
 * pre-stage-2 shape — no error, no log, just a column that is not there. This
 * script starts from exactly that shape: `status` still bounded to
 * ('open','done'), `kind` present, no `sequential`. Both migrations therefore
 * run in one boot, in the real server process, and both are checked.
 *
 * **The feature, through the assistant's own entry point.** The browser half is
 * `packages/e2e-tests/tests/tasks.spec.ts`; this is the other half. It drives
 * the real `next_actions` MCP tool over a real `EalClient` against the booted
 * api, so what is exercised is the documented path — HTTP, the wire shape, and
 * the shared rule in @eal/client — not a hand-wired construction.
 *
 * Steps:
 *   1. Build a database with the current schema, then put `tasks` back in its
 *      pre-stage-2 shape.
 *   2. Write a real project of three steps into it, the way the old code would.
 *   3. Boot the real api over the file. `applySchema` runs at boot.
 *   4. Check the column landed, defaulted to 0 on every row, and that the
 *      status rebuild also ran — the ordering is right in both directions.
 *   5. Mark the project sequential over real HTTP and ask `next_actions` what
 *      to do: exactly the first step. Complete it; the answer moves on.
 *   6. Boot a second time and confirm the flag survived.
 *
 * Exits 0 on success, or 1 naming the first check that failed.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEalClient } from '../packages/client/src/index.ts';
import { tasksMcpApp } from '../packages/cli/src/apps/tasks.ts';
import { bootApi, type BootedApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

// The api serves a self-signed certificate in development.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

/**
 * Throws rather than calling `process.exit`, so the `finally` below still runs
 * and the spawned api is killed. An exiting process skips it, and the orphaned
 * server keeps the tier's stdout pipe open — which is the "a script leaving a
 * handle open hangs the whole tier" failure, arriving only when something has
 * already gone wrong.
 */
class CheckFailed extends Error {}

function fail(message: string): never {
  throw new CheckFailed(message);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

interface IdRow { id: number }

async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

/**
 * Put `tasks` back in its pre-stage-2 shape — the same downgrade
 * `e2e-tasks-status-migration.ts` performs, because that is the on-disk shape a
 * real 0.x install still has and the one where the ordering hazard bites. No
 * `sequential`, and the two-value status CHECK.
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

/** Insert one task the way the pre-stage-3 code did, and return its id. */
function insertLegacyTask(
  db: Database,
  userId: number,
  task: {
    title: string;
    parentId: number | null;
    kind: 'project' | 'epic' | 'task';
    position: number;
  },
): number {
  const row = db
    .prepare<IdRow, [number | null, string, string, number, number, number]>(
      `INSERT INTO tasks (parent_id, title, kind, position, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, 'open', ?, ?) RETURNING id`,
    )
    .get(task.parentId, task.title, task.kind, task.position, userId, userId);
  if (row === null) fail(`could not insert ${task.title}`);
  return row.id;
}

function nextActionsTool() {
  const tool = tasksMcpApp.tools.find((t) => t.name === 'next_actions');
  if (tool === undefined) {
    fail('the tasks app exposes no next_actions tool — the assistant cannot answer "what next"');
  }
  return tool;
}

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'eal-sequential-'));
  const dbPath = join(dir, 'legacy.db');
  let api: BootedApi | null = null;

  try {
    // ── 1. A database in the pre-stage-2 shape ────────────────────────────────
    const seeded = seedCliToken({ dbPath, displayName: 'sequential-migration', ttlMs: 10 * 60_000 });

    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    downgradeTasksTable(db);
    const columnsBefore = db
      .prepare<{ name: string }, []>('PRAGMA table_info(tasks)')
      .all()
      .map((r) => r.name);
    check(
      !columnsBefore.includes('sequential'),
      'the pre-migration database already carries the sequential column',
    );
    const preShape = db
      .prepare<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'",
      )
      .get();
    check(
      preShape !== null && !preShape.sql.includes("'doing'"),
      'the pre-migration database already carries the widened status CHECK',
    );

    // ── 2. A real project of three steps ──────────────────────────────────────
    const project = insertLegacyTask(db, seeded.userId, {
      title: 'Renovate the kitchen', parentId: null, kind: 'project', position: 0,
    });
    const stepOne = insertLegacyTask(db, seeded.userId, {
      title: 'Strip the wallpaper', parentId: project, kind: 'task', position: 0,
    });
    const stepTwo = insertLegacyTask(db, seeded.userId, {
      title: 'Plaster the wall', parentId: project, kind: 'task', position: 1,
    });
    const stepThree = insertLegacyTask(db, seeded.userId, {
      title: 'Paint the ceiling', parentId: project, kind: 'task', position: 2,
    });
    db.close();
    console.log(
      'e2e-tasks-sequential-migration: wrote a 3-step project with no sequential column and the old status CHECK',
    );

    // ── 3. Boot the real server over it ───────────────────────────────────────
    api = await bootApi({ database: dbPath });
    console.log('e2e-tasks-sequential-migration: api booted over the pre-migration database');

    // ── 4. Both migrations ran, in the right order ────────────────────────────
    const afterBoot = new Database(dbPath, { readonly: true });
    const columnsAfter = afterBoot
      .prepare<{ name: string }, []>('PRAGMA table_info(tasks)')
      .all()
      .map((r) => r.name);
    afterBoot.close();
    check(
      columnsAfter.includes('sequential'),
      'the sequential column is not on the table after boot — the status rebuild ate it, ' +
        'which is what happens when its ensureColumn is placed before rebuildTasksStatusIfLegacy',
    );
    console.log('e2e-tasks-sequential-migration: the sequential column survived the status rebuild');

    const client = createEalClient(api.url, { token: seeded.token });
    const migrated = await client.listTasks({});
    check(migrated.length === 4, `expected 4 rows back, got ${migrated.length}`);
    for (const task of migrated) {
      check(
        task.sequential === false,
        `"${task.title}" came back sequential=${String(task.sequential)}; ` +
          'the migration must change no behaviour — every existing container is parallel',
      );
      // The stage-2 rebuild ran too, in the same boot: nothing still reads
      // 'open'. Ordering is right in both directions, not just one.
      check(
        task.status === 'todo',
        `"${task.title}" reads status ${task.status}, expected todo — the status rebuild did not run`,
      );
      check(
        task.parentId === (task.id === project ? null : project),
        `"${task.title}" lost its place in the tree`,
      );
    }
    console.log(
      'e2e-tasks-sequential-migration: every migrated row is parallel, todo, and still filed where it was',
    );

    // The assistant's answer before the flag is set: a parallel project hands
    // out all three steps at once.
    const tool = nextActionsTool();
    const parallelAnswer = await tool.run(client, {});
    for (const title of ['Strip the wallpaper', 'Plaster the wall', 'Paint the ceiling']) {
      check(
        parallelAnswer.includes(title),
        `a parallel project should offer "${title}"; next_actions said:\n${parallelAnswer}`,
      );
    }
    check(
      !parallelAnswer.includes('Renovate the kitchen'),
      `the container is not an action while it holds work; next_actions said:\n${parallelAnswer}`,
    );
    console.log('e2e-tasks-sequential-migration: parallel — next_actions offers all three steps');

    // ── 5. The flag, set over real HTTP, changes the answer ───────────────────
    const patched = await fetch(`${api.url}/api/v1/tasks/${project}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${seeded.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sequential: true }),
    });
    check(
      patched.ok,
      `PATCH sequential answered ${patched.status}: ${await bodyText(patched)}`,
    );
    const sequentialAnswer = await tool.run(client, {});
    check(
      sequentialAnswer.includes('Strip the wallpaper'),
      `a sequential project should offer its first step; next_actions said:\n${sequentialAnswer}`,
    );
    for (const title of ['Plaster the wall', 'Paint the ceiling']) {
      check(
        !sequentialAnswer.includes(title),
        `a sequential project must hold "${title}" back; next_actions said:\n${sequentialAnswer}`,
      );
    }
    console.log('e2e-tasks-sequential-migration: sequential — next_actions offers exactly step one');

    // Completing the first step advances the answer, with no triage pass and
    // nothing to remember to move. That is the whole argument for the flag.
    await client.completeTask(stepOne);
    const advanced = await tool.run(client, {});
    check(
      advanced.includes('Plaster the wall'),
      `completing step one should surface step two; next_actions said:\n${advanced}`,
    );
    check(
      !advanced.includes('Strip the wallpaper') && !advanced.includes('Paint the ceiling'),
      `only step two should be offered now; next_actions said:\n${advanced}`,
    );
    console.log('e2e-tasks-sequential-migration: completing step one advanced the answer to step two');

    // A blocked step hands out nothing rather than skipping ahead — the honest
    // answer, and the one that makes the person unblock it.
    await client.setTaskStatus(stepTwo, 'blocked');
    const stuck = await tool.run(client, {});
    check(
      !stuck.includes('Plaster the wall') && !stuck.includes('Paint the ceiling'),
      `a blocked step must not let the next one through; next_actions said:\n${stuck}`,
    );
    await client.setTaskStatus(stepTwo, 'todo');
    console.log('e2e-tasks-sequential-migration: a blocked step stops the project rather than skipping it');

    // ── 6. A second boot keeps the flag ───────────────────────────────────────
    await api.kill();
    api = await bootApi({ database: dbPath });
    const rebooted = createEalClient(api.url, { token: seeded.token });
    const again = await rebooted.listTasks({});
    const projectRow = again.find((t) => t.id === project);
    check(projectRow !== undefined, 'the project vanished across the second boot');
    check(
      projectRow?.sequential === true,
      'the second boot reset the sequential flag — ensureColumn is not idempotent',
    );
    check(again.length === 4, `the second boot changed the row count to ${again.length}`);
    const afterReboot = await nextActionsTool().run(rebooted, {});
    check(
      afterReboot.includes('Plaster the wall') && !afterReboot.includes('Paint the ceiling'),
      `the answer changed across a reboot; next_actions said:\n${afterReboot}`,
    );
    check(stepThree > 0, 'step three was never created');
    console.log('e2e-tasks-sequential-migration: the flag and the answer both survived a second boot');

    console.log('e2e-tasks-sequential-migration: OK');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`e2e-tasks-sequential-migration: FAIL — ${message}`);
    return 1;
  } finally {
    if (api !== null) await api.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

process.exit(await main());
