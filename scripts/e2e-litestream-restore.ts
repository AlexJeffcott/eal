#!/usr/bin/env bun
/**
 * Cross-boundary Litestream restore test.
 *
 * The shape required by ~/projects/CLAUDE.md ("Green checks do not prove
 * features work"): proves the restore-on-cold-start choreography end-to-end,
 * using the *real* production entrypoint (deploy/entrypoint.sh) and a *real*
 * litestream process — only the replica is local (file) instead of S3.
 *
 * Steps:
 *  1. Seed a user + token into a fresh file-backed SQLite DB.
 *  2. Boot the server via the entrypoint (litestream replicate -exec server).
 *  3. Create a task through the api.
 *  4. Wait for litestream to replicate, then stop the server (graceful → final sync).
 *  5. DELETE the primary DB file (+ wal/shm) — simulating a cold container.
 *  6. Boot again via the entrypoint — it must `litestream restore` the DB.
 *  7. Assert the task created in step 3 is still there.
 */
import { spawn, type Subprocess } from 'bun';
import { rm, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedCliToken } from './lib/seed-cli-token.ts';
import { waitFor } from './lib/e2e-config.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/litestream-restore');
const DB_PATH = resolve(ARTIFACTS, 'eal.db');
const REPLICA_PATH = resolve(ARTIFACTS, 'replica');
const PORT = '4108';
const BASE = `http://localhost:${PORT}`;
const TASK_TITLE = 'survives-a-cold-restart';

function bootEntrypoint(): Subprocess {
  return spawn(['./deploy/entrypoint.sh'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'inherit',
    env: {
      ...process.env,
      PORT,
      DATABASE_PATH: DB_PATH,
      EAL_ORIGIN: `https://localhost:${PORT}`,
      // SKIP_TLS: this test exercises Litestream, not TLS — bind plain HTTP so
      // there's no cert dependency. A legitimate unit/test-tier use of the flag.
      SKIP_TLS: '1',
      // Pin the PSTN trunk off. The api auto-loads `.env`, and a half-filled
      // trunk there stops it booting; this script exercises Litestream, not
      // PSTN. An explicit value here wins — `.env` never overwrites one.
      TWILIO_ENABLED: 'false',
      LITESTREAM_CONFIG: 'deploy/litestream-dev.yml',
      LITESTREAM_DEV_REPLICA_PATH: REPLICA_PATH,
    },
  });
}

async function waitForListening(proc: Subprocess, timeoutMs = 15_000): Promise<void> {
  const stdout = proc.stdout;
  if (typeof stdout === 'number' || stdout === undefined) {
    throw new Error('entrypoint stdout was not piped');
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buf = '';
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      buf += chunk;
      process.stdout.write(chunk);
      if (buf.includes('EAL_API_LISTENING')) return;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error('entrypoint never printed EAL_API_LISTENING');
}

async function stop(proc: Subprocess): Promise<void> {
  // SIGTERM → litestream stops the server child and does a final replica sync.
  proc.kill('SIGTERM');
  const handle = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  await proc.exited;
  clearTimeout(handle);
}

async function createTask(token: string): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: TASK_TITLE }),
  });
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`);
}

/**
 * Newest mtime (ms) of any file under `dir`, recursively — or 0 if `dir` is
 * absent or empty. Litestream writing a replica file after a known instant is
 * a real "the WAL was synced" signal, in place of guessing a fixed delay.
 */
async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtime(full));
    } else {
      newest = Math.max(newest, (await stat(full)).mtimeMs);
    }
  }
  return newest;
}

async function listTaskTitles(token: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/v1/tasks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`task list failed: ${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('tasks' in body)) {
    throw new Error('unexpected list shape');
  }
  const tasks = body.tasks;
  if (!Array.isArray(tasks)) throw new Error('tasks is not an array');
  const titles: string[] = [];
  for (const t of tasks) {
    if (typeof t === 'object' && t !== null && 'title' in t && typeof t.title === 'string') {
      titles.push(t.title);
    }
  }
  return titles;
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });

  // ─── 1. Seed a user + token into a fresh DB ──────────────────────────────
  const seeded = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'litestream-test' });

  let proc: Subprocess | undefined;
  try {
    // ─── 2. Boot via the entrypoint (DB present → no restore, just replicate) ─
    proc = bootEntrypoint();
    await waitForListening(proc);

    // ─── 3. Create a task through the api ────────────────────────────────────
    await createTask(seeded.token);
    const before = await listTaskTitles(seeded.token);
    if (!before.includes(TASK_TITLE)) {
      throw new Error(`task not present before restart: ${JSON.stringify(before)}`);
    }
    console.log('e2e-litestream-restore: task created and visible pre-restart');

    // ─── 4. Wait until litestream has synced the replica, then stop ──────────
    // litestream copies the WAL on its sync interval; a replica file modified
    // after the task was committed proves that write reached the replica — the
    // real signal the old fixed 4s sleep only hoped for. The graceful stop
    // then does a final sync.
    const taskCommittedAt = Date.now();
    await waitFor(async () => (await newestMtime(REPLICA_PATH)) >= taskCommittedAt, {
      timeoutMs: 20_000,
      intervalMs: 250,
      description: 'litestream to replicate the task write',
    });
    await stop(proc);
    proc = undefined;

    // ─── 5. Delete the primary DB — simulate a cold container ────────────────
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${DB_PATH}${suffix}`, { force: true });
    }
    if (existsSync(DB_PATH)) throw new Error('DB file still present after delete');
    console.log('e2e-litestream-restore: primary DB deleted');

    // ─── 6. Boot again — the entrypoint must restore from the replica ────────
    proc = bootEntrypoint();
    await waitForListening(proc);
    if (!existsSync(DB_PATH)) throw new Error('DB file was not restored on boot');

    // ─── 7. Assert the task survived the cold restart ────────────────────────
    const after = await listTaskTitles(seeded.token);
    if (!after.includes(TASK_TITLE)) {
      throw new Error(`task did NOT survive the restore: ${JSON.stringify(after)}`);
    }

    console.log('e2e-litestream-restore: OK — task survived a cold restart via restore');
    return 0;
  } catch (err) {
    console.error('e2e-litestream-restore: FAIL', err);
    return 1;
  } finally {
    if (proc) await stop(proc);
  }
}

process.exit(await main());
