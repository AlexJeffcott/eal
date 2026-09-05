#!/usr/bin/env bun
/**
 * Verification artefact for the tasks levels migration — stage 1 of the
 * project → epic → task work.
 *
 * `tasks.kind` arrives with `DEFAULT 'task'`, and a task may not hold children
 * (handlers/tasks.shared.ts:levelViolation). So without a promote pass, every
 * parent/child pair written before the column existed becomes a pairing the
 * rules refuse: the rows still read, but moving either one is a 400 nobody
 * asked for. `promoteGrandfatheredContainers` in db/schema.ts resolves those
 * from the tree itself. The unit tier proves that function against a table it
 * builds by hand; this script proves the deployed shape.
 *
 * It runs the real upgrade, not a reconstruction of one:
 *   1. Build a database, then take `kind` back off it. What is left is exactly
 *      the pre-stage-1 shape, because the column is added by `ensureColumn`
 *      and was never part of the tasks app's own CREATE TABLE.
 *   2. Write a three-level tree into it, as the old code would have.
 *   3. Boot the real api over that file. `applySchema` runs at boot, so the
 *      column lands and the promote pass runs, both in the server process.
 *   4. Read the levels back over real HTTP, with a real session token.
 *   5. Make the move the migration exists to permit: file the loose task under
 *      the promoted project. Before the pass that parent read 'task' and this
 *      request was refused.
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
  console.error(`e2e-tasks-levels-migration: FAIL — ${message}`);
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

/** Insert one task the way the pre-`kind` code did, and return its id. */
function insertLegacyTask(db: Database, title: string, parentId: number | null, userId: number): number {
  const row = db
    .prepare<IdRow, [number | null, string, number, number]>(
      `INSERT INTO tasks (parent_id, title, status, created_by, updated_by)
       VALUES (?, ?, 'todo', ?, ?) RETURNING id`,
    )
    .get(parentId, title, userId, userId);
  if (row === null) fail(`could not insert ${title}`);
  return row.id;
}

interface WireTask { id: number; title: string; kind: string; parentId: number | null }

async function listTasks(apiUrl: string, token: string): Promise<WireTask[]> {
  const res = await fetch(`${apiUrl}/api/v1/tasks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) fail(`GET /api/v1/tasks answered ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('tasks' in body)) {
    fail('GET /api/v1/tasks returned no `tasks` array');
  }
  const { tasks } = body;
  if (!Array.isArray(tasks)) fail('GET /api/v1/tasks returned a non-array `tasks`');
  return tasks;
}

function kindOf(tasks: readonly WireTask[], id: number): string {
  const found = tasks.find((t) => t.id === id);
  if (found === undefined) fail(`task ${id} is missing from the list response`);
  return found.kind;
}

/**
 * Exit code for the runner. The whole script runs inside a function so the
 * `process.exit` at the bottom is the only way out: a stray handle from a
 * spawned api would otherwise keep bun alive and hang the multi tier.
 */
async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'eal-levels-'));
  const dbPath = join(dir, 'legacy.db');
  let api: BootedApi | null = null;

  try {
    // ── 1. A database in the pre-stage-1 shape ────────────────────────────────
    // seedCliToken applies the current schema and mints the token the HTTP
    // checks below use. Removing `kind` afterwards returns `tasks` to the shape
    // it had before stage 1 — the column is added by ensureColumn, so the app's
    // own CREATE TABLE has never carried it.
    const seeded = seedCliToken({ dbPath, displayName: 'levels-migration', ttlMs: 10 * 60_000 });

    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('DROP INDEX IF EXISTS idx_tasks_kind');
    db.exec('ALTER TABLE tasks DROP COLUMN kind');
    const preColumns = db
      .prepare<{ name: string }, []>('PRAGMA table_info(tasks)')
      .all()
      .map((c) => c.name);
    check(!preColumns.includes('kind'), 'the pre-migration database still carries a kind column');

    // ── 2. The tree the household already has ─────────────────────────────────
    const project = insertLegacyTask(db, 'Redecorate the hall', null, seeded.userId);
    const epic = insertLegacyTask(db, 'Choose a paint colour', project, seeded.userId);
    const leaf = insertLegacyTask(db, 'Get tester pots', epic, seeded.userId);
    const loose = insertLegacyTask(db, 'Book the dentist', null, seeded.userId);
    db.close();
    console.log('e2e-tasks-levels-migration: wrote a 3-level tree with no kind column');

    // ── 3. Boot the real server over it ───────────────────────────────────────
    api = await bootApi({ database: dbPath });
    console.log('e2e-tasks-levels-migration: api booted over the pre-migration database');

    // ── 4. The levels, read back over HTTP ────────────────────────────────────
    const tasks = await listTasks(api.url, seeded.token);
    check(kindOf(tasks, project) === 'project', `the root holding children is ${kindOf(tasks, project)}, not project`);
    check(kindOf(tasks, epic) === 'epic', `the project's child holding children is ${kindOf(tasks, epic)}, not epic`);
    check(kindOf(tasks, leaf) === 'task', `a childless row was promoted to ${kindOf(tasks, leaf)}`);
    check(kindOf(tasks, loose) === 'task', `a childless root was promoted to ${kindOf(tasks, loose)}`);
    console.log('e2e-tasks-levels-migration: levels read back project → epic → task');

    // ── 5. The move the pass exists to permit ─────────────────────────────────
    const moved = await fetch(`${api.url}/api/v1/tasks/${loose}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${seeded.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parent_id: project }),
    });
    const movedBody = await bodyText(moved);
    check(moved.ok, `filing a task under the promoted project answered ${moved.status}: ${movedBody}`);
    console.log('e2e-tasks-levels-migration: a task files under the promoted project');

    // And the rules are live, not merely unexercised: the same move under a row
    // the pass correctly left at the bottom level is still refused.
    const refused = await fetch(`${api.url}/api/v1/tasks/${epic}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${seeded.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parent_id: leaf }),
    });
    check(refused.status === 400, `filing under a plain task answered ${refused.status}, expected 400`);
    console.log('e2e-tasks-levels-migration: filing under a plain task is still refused (400)');

    // ── 6. A second boot changes nothing ──────────────────────────────────────
    await api.kill();
    api = await bootApi({ database: dbPath });
    const again = await listTasks(api.url, seeded.token);
    check(kindOf(again, project) === 'project', 'the second boot changed the project level');
    check(kindOf(again, epic) === 'epic', 'the second boot changed the epic level');
    check(kindOf(again, loose) === 'task', 'the second boot promoted a row it should not have');
    console.log('e2e-tasks-levels-migration: a second boot leaves every level untouched');

    console.log('e2e-tasks-levels-migration: OK');
  } finally {
    if (api !== null) await api.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

process.exit(await main());
