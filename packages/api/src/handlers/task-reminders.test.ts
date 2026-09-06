import { beforeEach, describe, expect, test } from 'bun:test';
import { flushMicrotasks } from '@eal/shared';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createPushSubscriptionsRepo } from '../db/repos/push-subscriptions.ts';
import { createTasksRepo, type TaskRow, type TasksRepo } from '../db/repos/tasks.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import {
  createTaskReminderTick,
  DEFAULT_REMINDER_TICK_MS,
  resolveReminderTickMs,
  startReminderLoop,
  taskReminderPayload,
  type PushTarget,
  type TaskReminderTickResult,
} from './task-reminders.ts';

interface Sent {
  endpoint: string;
  payload: string;
}

interface SetupContext {
  db: DatabaseClient;
  tasks: TasksRepo;
  alex: number;
  elisa: number;
  sent: Sent[];
  /** Endpoints the fake vendor should reject, and with what status. */
  reject: Map<string, number>;
  clock: { now: string };
  tick: () => Promise<TaskReminderTickResult>;
  subscribe: (userId: number, endpoint: string) => void;
  addTask: (input: {
    title: string;
    dueAt: string | null;
    assignedTo?: number | null;
  }) => TaskRow;
}

/** An error shaped like the one web-push throws on a vendor response. */
function vendorError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`vendor said ${statusCode}`), { statusCode });
}

function setup(): SetupContext {
  const db = createDb(':memory:');
  applySchema(db);
  const users = createUsersRepo(db);
  const alex = users.insert({ displayName: 'alex' }).id;
  const elisa = users.insert({ displayName: 'elisa' }).id;
  const tasks = createTasksRepo(db);
  const subscriptions = createPushSubscriptionsRepo(db);
  const sent: Sent[] = [];
  const reject = new Map<string, number>();
  const clock = { now: '2026-05-19 12:00:00' };

  const send = async (target: PushTarget, payload: string): Promise<void> => {
    const status = reject.get(target.endpoint);
    if (status !== undefined) throw vendorError(status);
    sent.push({ endpoint: target.endpoint, payload });
  };

  return {
    db,
    tasks,
    alex,
    elisa,
    sent,
    reject,
    clock,
    tick: createTaskReminderTick({ db, send, clock: () => clock.now }),
    subscribe(userId, endpoint) {
      subscriptions.upsert({ userId, endpoint, p256dh: 'p', auth: 'a' });
    },
    addTask(input) {
      return tasks.insert({
        parentId: null,
        title: input.title,
        notes: '',
        kind: 'task',
        deferUntil: null,
        dueAt: input.dueAt,
        createdBy: alex,
        assignedTo: input.assignedTo ?? null,
        position: 0,
        sequential: false,
      });
    },
  };
}

describe('the due-date reminder tick', () => {
  let ctx: SetupContext;
  beforeEach(() => {
    ctx = setup();
  });

  test('sends nothing when nothing is due', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    ctx.addTask({ title: 'Next week', dueAt: '2026-05-26' });
    expect(await ctx.tick()).toEqual({ due: 0, sent: 0, dropped: 0, stamped: 0 });
    expect(ctx.sent).toEqual([]);
  });

  test('a passed deadline reaches the assignee, and only the assignee', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    ctx.subscribe(ctx.elisa, 'https://vendor.example/elisa');
    ctx.addTask({ title: 'Bins out', dueAt: '2026-05-19T08:00:00Z', assignedTo: ctx.alex });

    const result = await ctx.tick();

    expect(result).toEqual({ due: 1, sent: 1, dropped: 0, stamped: 1 });
    expect(ctx.sent.map((s) => s.endpoint)).toEqual(['https://vendor.example/alex']);
  });

  test('an unassigned deadline reaches the whole household', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    ctx.subscribe(ctx.elisa, 'https://vendor.example/elisa');
    ctx.addTask({ title: 'Rubbish collection', dueAt: '2026-05-19' });

    await ctx.tick();

    // Nobody's yet, so the house hears it — the honest answer to "whose is
    // this?".
    expect(ctx.sent.map((s) => s.endpoint).sort()).toEqual([
      'https://vendor.example/alex',
      'https://vendor.example/elisa',
    ]);
  });

  test('every browser one person registered is told', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/laptop');
    ctx.subscribe(ctx.alex, 'https://vendor.example/phone');
    ctx.addTask({ title: 'Bins out', dueAt: '2026-05-19', assignedTo: ctx.alex });

    await ctx.tick();

    expect(ctx.sent).toHaveLength(2);
  });

  test('the payload is the shape the service worker parses, and carries the title', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    const task = ctx.addTask({ title: 'Renew the passport', dueAt: '2026-05-19' });

    await ctx.tick();

    const first = ctx.sent[0];
    expect(first).toBeDefined();
    expect(JSON.parse(first?.payload ?? '{}')).toEqual({
      kind: 'task',
      title: 'Renew the passport',
      body: 'Due now',
      tag: `task:${task.id}`,
      url: '/tasks',
    });
  });

  test('the second tick sends nothing — the stamp is what makes it idempotent', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    ctx.addTask({ title: 'Bins out', dueAt: '2026-05-19' });

    expect((await ctx.tick()).sent).toBe(1);
    ctx.clock.now = '2026-05-19 12:01:00';
    expect(await ctx.tick()).toEqual({ due: 0, sent: 0, dropped: 0, stamped: 0 });
    expect(ctx.sent).toHaveLength(1);
  });

  test('moving the deadline re-arms it', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    const task = ctx.addTask({ title: 'Bins out', dueAt: '2026-05-19' });
    await ctx.tick();
    expect(ctx.sent).toHaveLength(1);

    ctx.tasks.update(task.id, { dueAt: '2026-05-20', updatedBy: ctx.alex });
    ctx.clock.now = '2026-05-20 12:00:00';
    await ctx.tick();

    expect(ctx.sent).toHaveLength(2);
  });

  test('a blocked task still reminds; a done one does not', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    const stuck = ctx.addTask({ title: 'Chase the delivery', dueAt: '2026-05-19' });
    const finished = ctx.addTask({ title: 'Already handled', dueAt: '2026-05-19' });
    ctx.tasks.setStatus(stuck.id, { status: 'blocked', updatedBy: ctx.alex });
    ctx.tasks.setStatus(finished.id, { status: 'done', updatedBy: ctx.alex });

    await ctx.tick();

    expect(ctx.sent).toHaveLength(1);
    expect(JSON.parse(ctx.sent[0]?.payload ?? '{}').title).toBe('Chase the delivery');
  });

  test('a trashed task does not remind', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    const task = ctx.addTask({ title: 'Binned', dueAt: '2026-05-19' });
    ctx.tasks.softDelete(task.id, { updatedBy: ctx.alex });

    expect(await ctx.tick()).toEqual({ due: 0, sent: 0, dropped: 0, stamped: 0 });
  });

  test('a task with nobody to tell is still stamped', async () => {
    // No subscriptions at all. Stamping anyway is the deliberate rule: without
    // it, the day someone finally taps "Remind me" they are buried under every
    // deadline that passed before they did.
    const task = ctx.addTask({ title: 'Nobody listening', dueAt: '2026-05-19' });

    expect(await ctx.tick()).toEqual({ due: 1, sent: 0, dropped: 0, stamped: 1 });
    expect(ctx.tasks.findById(task.id)?.reminded_at).toBe('2026-05-19 12:00:00');
  });

  test('a subscription the vendor calls gone is deleted, not retried', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/dead');
    ctx.subscribe(ctx.alex, 'https://vendor.example/live');
    ctx.reject.set('https://vendor.example/dead', 410);
    ctx.addTask({ title: 'One good, one gone', dueAt: '2026-05-19', assignedTo: ctx.alex });

    const result = await ctx.tick();

    expect(result.sent).toBe(1);
    expect(result.dropped).toBe(1);
    expect(createPushSubscriptionsRepo(ctx.db).listAll().map((r) => r.endpoint)).toEqual([
      'https://vendor.example/live',
    ]);
  });

  test('a 404 is treated as gone too', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/dead');
    ctx.reject.set('https://vendor.example/dead', 404);
    ctx.addTask({ title: 'Gone', dueAt: '2026-05-19' });

    expect((await ctx.tick()).dropped).toBe(1);
    expect(createPushSubscriptionsRepo(ctx.db).listAll()).toEqual([]);
  });

  test('a dropped subscription is not tried again later in the same pass', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/dead');
    ctx.reject.set('https://vendor.example/dead', 410);
    ctx.addTask({ title: 'First', dueAt: '2026-05-19' });
    ctx.addTask({ title: 'Second', dueAt: '2026-05-19' });

    // Two due tasks, one dead subscription: the pass must not spend a second
    // round trip on an endpoint it has already been told is gone.
    expect((await ctx.tick()).dropped).toBe(1);
  });

  test('a transient vendor failure still stamps, and keeps the subscription', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/flaky');
    ctx.reject.set('https://vendor.example/flaky', 500);
    const task = ctx.addTask({ title: 'Bins out', dueAt: '2026-05-19' });

    const result = await ctx.tick();

    // Not retried: a reminder that finally rings forty minutes late is worse
    // than one that did not ring, and retrying forever is what the alternative
    // costs. The subscription survives, because a 500 says nothing about it.
    expect(result).toEqual({ due: 1, sent: 0, dropped: 0, stamped: 1 });
    expect(ctx.tasks.findById(task.id)?.reminded_at).not.toBeNull();
    expect(createPushSubscriptionsRepo(ctx.db).listAll()).toHaveLength(1);
  });

  test('a deadline still ahead of the clock waits', async () => {
    ctx.subscribe(ctx.alex, 'https://vendor.example/alex');
    ctx.addTask({ title: 'Tonight', dueAt: '2026-05-19T23:00:00Z' });

    expect((await ctx.tick()).due).toBe(0);
    ctx.clock.now = '2026-05-19 23:00:00';
    expect((await ctx.tick()).due).toBe(1);
  });
});

describe('taskReminderPayload', () => {
  test("kind is 'task', so the service worker picks the single buzz", () => {
    const ctx = setup();
    const task = ctx.addTask({ title: 'Bins out', dueAt: '2026-05-19' });
    const payload = taskReminderPayload(task);
    // 'call' is the pattern that rings three times; a deadline is not a call.
    expect(payload.kind).toBe('task');
    expect(payload.url).toBe('/tasks');
    expect(payload.tag).toBe(`task:${task.id}`);
    expect(payload.title).toBe('Bins out');
  });
});

describe('resolveReminderTickMs', () => {
  test('defaults to a minute', () => {
    expect(resolveReminderTickMs({})).toBe(DEFAULT_REMINDER_TICK_MS);
    expect(resolveReminderTickMs({ EAL_REMINDER_TICK_MS: '' })).toBe(DEFAULT_REMINDER_TICK_MS);
  });

  test('an explicit override is honoured', () => {
    expect(resolveReminderTickMs({ EAL_REMINDER_TICK_MS: '250' })).toBe(250);
  });

  test('a value that is not a positive integer fails loudly', () => {
    for (const bad of ['0', '-1', 'soon', '1.5']) {
      expect(() => resolveReminderTickMs({ EAL_REMINDER_TICK_MS: bad })).toThrow(
        'EAL_REMINDER_TICK_MS',
      );
    }
  });
});

describe('startReminderLoop', () => {
  test('runs the first pass immediately, without waiting out an interval', async () => {
    let ticks = 0;
    // An hour: if the first pass waited for it, this test would not finish.
    const loop = startReminderLoop({ tick: async () => { ticks += 1; }, intervalMs: 3_600_000 });
    await flushMicrotasks();
    loop.stop();
    await loop.finished;
    expect(ticks).toBe(1);
  });

  test('a throwing tick does not kill the loop', async () => {
    let ticks = 0;
    const loop = startReminderLoop({
      tick: async () => {
        ticks += 1;
        throw new Error('database went away');
      },
      intervalMs: 3_600_000,
    });
    await flushMicrotasks();
    loop.stop();
    await loop.finished;
    // It survived the throw and is waiting for the next pass rather than gone.
    expect(ticks).toBe(1);
  });

  test('stop() ends it, and the handle settles', async () => {
    let ticks = 0;
    const loop = startReminderLoop({ tick: async () => { ticks += 1; }, intervalMs: 1 });
    await flushMicrotasks();
    loop.stop();
    await loop.finished;
    const after = ticks;
    await flushMicrotasks();
    // Nothing runs once it has settled — which is what keeps a stopped loop
    // from holding the process open.
    expect(ticks).toBe(after);
  });
});
