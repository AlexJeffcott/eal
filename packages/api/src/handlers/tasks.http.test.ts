import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

/**
 * Wire contract for /api/v1/tasks/*. The web client (extractServerError) and
 * the friendly mappers in actions/registry.ts depend on the {error: string}
 * envelope; the broadcast tests below depend on the {task: Task} success shape.
 * These tests pin both. If you change the wire keys, this test fails first.
 */

interface ApiResponse {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function fetch(
  app: Awaited<ReturnType<typeof createTestApp>>,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const res = await app.handle(new Request(`https://localhost:3000${path}`, init));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    /* keep parsed = text */
  }
  return { status: res.status, contentType: res.headers.get('content-type'), body: parsed };
}

interface MinimalTask {
  id: number;
  title: string;
  status: 'open' | 'done';
  deletedAt: string | null;
}

function isMinimalTask(value: unknown): value is MinimalTask {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value && 'title' in value && 'status' in value && 'deletedAt' in value)) return false;
  return (
    typeof value.id === 'number' &&
    typeof value.title === 'string' &&
    (value.status === 'open' || value.status === 'done') &&
    (value.deletedAt === null || typeof value.deletedAt === 'string')
  );
}

function isTaskEnvelope(body: unknown): body is { task: MinimalTask } {
  if (typeof body !== 'object' || body === null || !('task' in body)) return false;
  return isMinimalTask(body.task);
}

function isTasksList(body: unknown): body is { tasks: MinimalTask[] } {
  if (typeof body !== 'object' || body === null || !('tasks' in body)) return false;
  if (!Array.isArray(body.tasks)) return false;
  return body.tasks.every(isMinimalTask);
}

function isCloneEnvelope(body: unknown): body is { rootId: number; tasks: MinimalTask[] } {
  if (typeof body !== 'object' || body === null) return false;
  if (!('rootId' in body && 'tasks' in body)) return false;
  if (typeof body.rootId !== 'number') return false;
  if (!Array.isArray(body.tasks)) return false;
  return body.tasks.every(isMinimalTask);
}

function isErrorEnvelope(body: unknown): body is { error: string } {
  if (typeof body !== 'object' || body === null) return false;
  if (!('error' in body)) return false;
  return typeof body.error === 'string';
}

function unwrapTask(body: unknown): MinimalTask {
  if (!isTaskEnvelope(body)) throw new Error(`expected {task} envelope, got ${JSON.stringify(body)}`);
  return body.task;
}

describe('tasks http wire contract', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
  });

  test('POST /api/v1/tasks: 200 returns {task} envelope with camelCase fields', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetch(app, 'POST', '/api/v1/tasks', { title: 'buy milk' });
    expect(res.status).toBe(200);
    expect(res.contentType ?? '').toContain('application/json');
    expect(isTaskEnvelope(res.body)).toBe(true);
    if (!isTaskEnvelope(res.body)) throw new Error('unreachable');
    expect(res.body.task.title).toBe('buy milk');
    expect(res.body.task.status).toBe('open');
  });

  test('POST /api/v1/tasks: 400 with {error} envelope when title is empty', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetch(app, 'POST', '/api/v1/tasks', { title: '   ' });
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res.body)).toBe(true);
    if (!isErrorEnvelope(res.body)) throw new Error('unreachable');
    expect(res.body.error).toContain('title is required');
  });

  test('POST /api/v1/tasks: 401 when unauthenticated', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await fetch(app, 'POST', '/api/v1/tasks', { title: 'x' });
    expect(res.status).toBe(401);
    expect(isErrorEnvelope(res.body)).toBe(true);
  });

  test('GET /api/v1/tasks: 200 returns {tasks: Task[]}', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    await fetch(app, 'POST', '/api/v1/tasks', { title: 'a' });
    await fetch(app, 'POST', '/api/v1/tasks', { title: 'b' });
    const res = await fetch(app, 'GET', '/api/v1/tasks');
    expect(res.status).toBe(200);
    // NB: deliberately avoid toMatchObject with expect.any(...) here — Bun
    // mutates the source object's matched fields into asymmetric placeholders,
    // which breaks any subsequent reads of res.body. Validate fields directly.
    const body = res.body;
    if (typeof body !== 'object' || body === null || !('tasks' in body)) {
      throw new Error('expected {tasks} envelope');
    }
    const tasks = body.tasks;
    if (!Array.isArray(tasks)) throw new Error('expected tasks to be an array');
    const titles: string[] = [];
    for (const item of tasks) {
      if (typeof item === 'object' && item !== null && 'title' in item && typeof item.title === 'string') {
        titles.push(item.title);
      }
    }
    expect(titles.sort()).toEqual(['a', 'b']);
  });

  test('GET /api/v1/tasks?inbox=1 filter passes through', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    await fetch(app, 'POST', '/api/v1/tasks', { title: 'in' });
    const elisaUser = createUsersRepo(db).insert({ displayName: 'elisa' });
    await fetch(app, 'POST', '/api/v1/tasks', { title: 'assigned', assigned_to: elisaUser.id });
    const res = await fetch(app, 'GET', '/api/v1/tasks?inbox=1');
    expect(res.status).toBe(200);
    if (!isTasksList(res.body)) throw new Error('expected {tasks} envelope');
    expect(res.body.tasks.map((t) => t.title)).toEqual(['in']);
  });

  test('PATCH /api/v1/tasks/:id accepts snake_case wire payload', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = unwrapTask((await fetch(app, 'POST', '/api/v1/tasks', { title: 'before' })).body);
    const res = await fetch(app, 'PATCH', `/api/v1/tasks/${created.id}`, { title: 'after' });
    expect(res.status).toBe(200);
    expect(unwrapTask(res.body).title).toBe('after');
  });

  test('POST /complete + /reopen flip status and return {task}', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = unwrapTask((await fetch(app, 'POST', '/api/v1/tasks', { title: 'x' })).body);

    const done = await fetch(app, 'POST', `/api/v1/tasks/${created.id}/complete`);
    expect(done.status).toBe(200);
    expect(unwrapTask(done.body).status).toBe('done');

    const open = await fetch(app, 'POST', `/api/v1/tasks/${created.id}/reopen`);
    expect(unwrapTask(open.body).status).toBe('open');
  });

  test('DELETE soft-deletes; POST /restore brings it back', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = unwrapTask((await fetch(app, 'POST', '/api/v1/tasks', { title: 'x' })).body);

    const del = await fetch(app, 'DELETE', `/api/v1/tasks/${created.id}`);
    expect(del.status).toBe(200);
    expect(unwrapTask(del.body).deletedAt).not.toBeNull();

    const live = await fetch(app, 'GET', '/api/v1/tasks');
    if (!isTasksList(live.body)) throw new Error('expected {tasks} envelope');
    expect(live.body.tasks).toHaveLength(0);

    const trash = await fetch(app, 'GET', '/api/v1/tasks?trash=1');
    if (!isTasksList(trash.body)) throw new Error('expected {tasks} envelope');
    expect(trash.body.tasks).toHaveLength(1);

    const restored = await fetch(app, 'POST', `/api/v1/tasks/${created.id}/restore`);
    expect(unwrapTask(restored.body).deletedAt).toBeNull();
  });

  test('PATCH cycle: 400 with cycle phrase', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const g = unwrapTask((await fetch(app, 'POST', '/api/v1/tasks', { title: 'g', kind: 'project' })).body);
    const p = unwrapTask(
      (await fetch(app, 'POST', '/api/v1/tasks', { title: 'p', kind: 'epic', parent_id: g.id })).body,
    );
    const c = unwrapTask((await fetch(app, 'POST', '/api/v1/tasks', { title: 'c', parent_id: p.id })).body);

    const cyc = await fetch(app, 'PATCH', `/api/v1/tasks/${g.id}`, { parent_id: c.id });
    expect(cyc.status).toBe(400);
    if (!isErrorEnvelope(cyc.body)) throw new Error('expected {error} envelope');
    expect(cyc.body.error).toContain('cycle');
  });

  test('kind rides the wire on create, list and patch', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetch(app, 'POST', '/api/v1/tasks', {
      title: 'renovate',
      kind: 'project',
    });
    expect(created.status).toBe(200);
    const project = unwrapTask(created.body);

    const listed = await fetch(app, 'GET', '/api/v1/tasks?kind=project');
    if (!isTasksList(listed.body)) throw new Error('expected {tasks} envelope');
    expect(listed.body.tasks.map((t) => t.title)).toEqual(['renovate']);

    const demoted = await fetch(app, 'PATCH', `/api/v1/tasks/${project.id}`, { kind: 'task' });
    expect(demoted.status).toBe(200);
    const after = await fetch(app, 'GET', '/api/v1/tasks?kind=task');
    if (!isTasksList(after.body)) throw new Error('expected {tasks} envelope');
    expect(after.body.tasks.map((t) => t.title)).toEqual(['renovate']);
  });

  test('a level rejection is a 400 in the {error} envelope', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const plain = unwrapTask((await fetch(app, 'POST', '/api/v1/tasks', { title: 'plain' })).body);
    const res = await fetch(app, 'POST', '/api/v1/tasks', {
      title: 'sub',
      parent_id: plain.id,
    });
    expect(res.status).toBe(400);
    if (!isErrorEnvelope(res.body)) throw new Error('expected {error} envelope');
    expect(res.body.error).toContain('a task cannot be filed under another task');
  });

  test('an unknown kind is rejected rather than ignored', async () => {
    // Silently dropping it would list everything and call that a filter.
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetch(app, 'GET', '/api/v1/tasks?kind=milestone');
    expect(res.status).toBe(400);
    if (!isErrorEnvelope(res.body)) throw new Error('expected {error} envelope');
    expect(res.body.error).toContain('kind must be');
  });

  test('POST /clone returns {rootId, tasks: Task[]}', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const shop = unwrapTask(
      (await fetch(app, 'POST', '/api/v1/tasks', { title: 'shop', kind: 'project' })).body,
    );
    await fetch(app, 'POST', '/api/v1/tasks', { title: 'milk', parent_id: shop.id });

    const cloned = await fetch(app, 'POST', `/api/v1/tasks/${shop.id}/clone`);
    expect(cloned.status).toBe(200);
    if (!isCloneEnvelope(cloned.body)) throw new Error('expected {rootId, tasks} envelope');
    expect(cloned.body.rootId).not.toBe(shop.id);
    expect(cloned.body.tasks.map((t) => t.title).sort()).toEqual(['milk', 'shop']);
  });

  test('404 for unknown task ids has {error} envelope', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetch(app, 'POST', '/api/v1/tasks/999999/complete');
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res.body)).toBe(true);
  });
});
