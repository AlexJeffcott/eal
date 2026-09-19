import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import type { Principal } from '../auth/principals.ts';
import { tasksHttpRoutes, type TaskEvent } from './tasks.http.ts';
import type { StatusChange, Task } from './tasks.shared.ts';

/**
 * Recurrence on the wire: what a second device is TOLD, and in what order.
 *
 * The cores have their own suites. This one drives the routes with a recording
 * broadcaster, because the defect it guards is one no core can have — a
 * successor made in the database and never announced, which the device that
 * ticked the box would see (it reads the response) and no other would.
 */

let db: DatabaseClient;
let alex: Principal;
let events: TaskEvent[];
let routes: ReturnType<typeof tasksHttpRoutes>;

beforeEach(() => {
  db = createDb(':memory:');
  applySchema(db);
  const u = createUsersRepo(db).insert({ displayName: 'alex' });
  alex = { userId: u.id, displayName: u.display_name };
  events = [];
  routes = tasksHttpRoutes({ db, getPrincipal: () => alex, broadcastTask: (e) => events.push(e) });
});

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await routes.handle(new Request(`https://localhost:3000/api/v1/tasks${path}`, init));
  const text = await res.text();
  return { status: res.status, body: text.length === 0 ? null : JSON.parse(text) };
}

function isTask(value: unknown): value is Task {
  return typeof value === 'object' && value !== null && 'id' in value && 'recurrence' in value;
}

function isChange(value: unknown): value is StatusChange {
  if (typeof value !== 'object' || value === null) return false;
  if (!('task' in value) || !isTask(value.task)) return false;
  if (!('spawned' in value) || !Array.isArray(value.spawned) || !value.spawned.every(isTask)) return false;
  return 'removed' in value && Array.isArray(value.removed);
}

function asChange(body: unknown): StatusChange {
  if (!isChange(body)) throw new Error(`not a status change: ${JSON.stringify(body)}`);
  return body;
}

async function create(body: Record<string, unknown>): Promise<Task> {
  const res = await send('POST', '/', body);
  if (res.status !== 200 || typeof res.body !== 'object' || res.body === null || !('task' in res.body) || !isTask(res.body.task)) {
    throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.task;
}

const today = new Date().toISOString().slice(0, 10);
const WEEKLY = { every: 'days', interval: 7, basis: 'due' };

describe('recurrence over HTTP', () => {
  test('a rule goes in as JSON on create and on PATCH, and comes back on the task', async () => {
    const made = await create({ title: 'bins', due_at: today, recurrence: WEEKLY });
    expect(made.recurrence).toEqual({ every: 'days', interval: 7, basis: 'due' });

    const patched = await send('PATCH', `/${made.id}`, { recurrence: { every: 'weekdays', basis: 'completed' } });
    expect(patched.status).toBe(200);
    const cleared = await send('PATCH', `/${made.id}`, { recurrence: null });
    expect(cleared.status).toBe(200);
    const listed = await send('GET', '/');
    expect(listed.body).toMatchObject({ tasks: [{ id: made.id, recurrence: null }] });
  });

  test('a bad rule is a 400 in the {error} envelope, not a schema 500', async () => {
    const bad = await send('POST', '/', { title: 'x', recurrence: { every: 'fortnight', basis: 'due' } });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      error: 'recurrence.every must be "days", "weekdays", "week" or "month"',
    });
    const alsoBad = await send('POST', '/', { title: 'x', recurrence: 'weekly' });
    expect(alsoBad.status).toBe(400);
    expect(alsoBad.body).toEqual({ error: 'recurrence must be an object' });
  });

  test('complete answers with both rows and announces them in order: the tick, then the successor', async () => {
    const bins = await create({ title: 'bins', due_at: today, recurrence: WEEKLY });
    events.length = 0;

    const res = await send('POST', `/${bins.id}/complete`, { today });
    expect(res.status).toBe(200);
    const change = asChange(res.body);
    expect(change.task.status).toBe('done');
    expect(change.spawned).toHaveLength(1);
    expect(change.removed).toEqual([]);

    expect(events.map((e) => e.type)).toEqual(['task:updated', 'task:created']);
    // Byte-identical to the response, so the device that ticked the box and
    // the one that only heard about it hold the same two rows.
    expect(events[0]?.payload).toEqual(change.task);
    expect(events[1]?.payload).toEqual(change.spawned[0]!);
  });

  test('complete with no body at all still completes — the CLI sends none', async () => {
    const bins = await create({ title: 'bins', due_at: today, recurrence: WEEKLY });
    const res = await send('POST', `/${bins.id}/complete`);
    expect(res.status).toBe(200);
    expect(asChange(res.body).spawned).toHaveLength(1);
  });

  test('a `today` more than a day out is a 400, and nothing is announced', async () => {
    const bins = await create({ title: 'bins', due_at: today, recurrence: WEEKLY });
    events.length = 0;
    const res = await send('POST', `/${bins.id}/complete`, { today: '2001-01-01' });
    expect(res.status).toBe(400);
    expect(events).toEqual([]);
    const viaBoard = await send('POST', `/${bins.id}/status`, { status: 'done', today: 'soon' });
    expect(viaBoard.status).toBe(400);
    expect(events).toEqual([]);
  });

  test('reopen announces the untick, then the rows that are gone', async () => {
    const bins = await create({ title: 'bins', due_at: today, recurrence: WEEKLY });
    const spawned = asChange((await send('POST', `/${bins.id}/complete`, { today })).body).spawned;
    events.length = 0;

    const res = await send('POST', `/${bins.id}/reopen`);
    const change = asChange(res.body);
    expect(change.removed).toEqual([spawned[0]!.id]);
    expect(change.task.recurrence).not.toBeNull();
    expect(events.map((e) => e.type)).toEqual(['task:updated', 'task:removed']);
    expect(events[1]?.payload).toEqual({ ids: [spawned[0]!.id] });
  });

  test('a reopen that takes nothing back announces only the untick', async () => {
    const plain = await create({ title: 'x' });
    await send('POST', `/${plain.id}/complete`);
    events.length = 0;
    await send('POST', `/${plain.id}/reopen`);
    expect(events.map((e) => e.type)).toEqual(['task:updated']);
  });

  test('the board: Done spawns, and dragging back out takes it back', async () => {
    const bins = await create({ title: 'bins', due_at: today, recurrence: WEEKLY });
    events.length = 0;
    const done = asChange((await send('POST', `/${bins.id}/status`, { status: 'done', today })).body);
    expect(done.spawned).toHaveLength(1);
    const back = asChange((await send('POST', `/${bins.id}/status`, { status: 'doing' })).body);
    expect(back.removed).toEqual([done.spawned[0]!.id]);
    expect(events.map((e) => e.type)).toEqual([
      'task:updated',
      'task:created',
      'task:updated',
      'task:removed',
    ]);
  });

  test('a recurring container is announced as one tree, root first', async () => {
    const project = await create({ title: 'clean', kind: 'project', due_at: today, recurrence: WEEKLY });
    await create({ title: 'kitchen', parent_id: project.id });
    await create({ title: 'bathroom', parent_id: project.id });
    events.length = 0;

    const change = asChange((await send('POST', `/${project.id}/complete`, { today })).body);
    expect(change.spawned.map((t) => t.title)).toEqual(['clean', 'kitchen', 'bathroom']);
    expect(events.map((e) => e.type)).toEqual(['task:updated', 'task:tree-cloned']);
    expect(events[1]?.payload).toEqual({ rootId: change.spawned[0]!.id, tasks: change.spawned });
  });
});
