import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';
import {
  cloneTaskCore,
  completeTaskCore,
  createTaskCore,
  deleteTaskCore,
  listTasksCore,
  reopenTaskCore,
  restoreTaskCore,
  setTaskStatusCore,
  type Task,
  updateTaskCore,
} from './tasks.shared.ts';

/**
 * Recurring tasks at the core — docs/plans/05-recurring-tasks.md.
 *
 * `nextOccurrence` has its own suite in @eal/shared. What is pinned here is
 * everything around it: which date it is fed, what the successor copies, where
 * the rule lives afterwards, and the accidental tick.
 */

interface Ctx {
  db: DatabaseClient;
  alex: Principal;
  elisa: Principal;
}

function setup(): Ctx {
  const db = createDb(':memory:');
  applySchema(db);
  const users = createUsersRepo(db);
  const a = users.insert({ displayName: 'alex' });
  const e = users.insert({ displayName: 'elisa' });
  return {
    db,
    alex: { userId: a.id, displayName: a.display_name },
    elisa: { userId: e.id, displayName: e.display_name },
  };
}

/** Saturday. Every test names its own `today`, so none depends on the clock. */
const NOW = new Date('2026-09-19T10:00:00Z');
const TODAY = '2026-09-19';
const TUESDAYS = { every: 'week', days: ['tue'], basis: 'due' } as const;

function live(ctx: Ctx): Task[] {
  return listTasksCore(ctx.db, {}, ctx.alex);
}

function statusError(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof AuthError) return err.status;
    throw err;
  }
  throw new Error('expected the call to be refused');
}

describe('the rule at the boundary', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('create stores a rule and returns it canonical', () => {
    const t = createTaskCore(
      ctx.db,
      { title: 'bins', recurrence: { every: 'week', days: ['thu', 'mon', 'thu'], basis: 'due' } },
      ctx.alex,
    );
    expect(t.recurrence).toEqual({ every: 'week', days: ['mon', 'thu'], basis: 'due' });
  });

  test('a task that does not repeat carries null', () => {
    expect(createTaskCore(ctx.db, { title: 'x' }, ctx.alex).recurrence).toBeNull();
    expect(createTaskCore(ctx.db, { title: 'y', recurrence: null }, ctx.alex).recurrence).toBeNull();
  });

  test('a bad rule is a 400 on create and on update, and stores nothing', () => {
    expect(
      statusError(() =>
        createTaskCore(ctx.db, { title: 'x', recurrence: { every: 'fortnight' } }, ctx.alex),
      ),
    ).toBe(400);
    expect(live(ctx)).toEqual([]);

    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    expect(
      statusError(() =>
        updateTaskCore(
          ctx.db,
          t.id,
          { recurrence: { every: 'days', interval: 0, basis: 'due' } },
          ctx.alex,
        ),
      ),
    ).toBe(400);
    expect(
      statusError(() =>
        updateTaskCore(
          ctx.db,
          t.id,
          { recurrence: { every: 'weekdays', basis: 'due', until: '2027-01-01' } },
          ctx.alex,
        ),
      ),
    ).toBe(400);
  });

  test('update sets a rule, leaves it alone, and clears it', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const set = updateTaskCore(ctx.db, t.id, { recurrence: TUESDAYS }, ctx.alex);
    expect(set.recurrence).toEqual({ every: 'week', days: ['tue'], basis: 'due' });
    const untouched = updateTaskCore(ctx.db, t.id, { title: 'renamed' }, ctx.alex);
    expect(untouched.recurrence).toEqual({ every: 'week', days: ['tue'], basis: 'due' });
    expect(updateTaskCore(ctx.db, t.id, { recurrence: null }, ctx.alex).recurrence).toBeNull();
  });
});

describe('completing a recurring task', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('spawns one successor, dated by the rule, and hands it the rule', () => {
    const bins = createTaskCore(
      ctx.db,
      { title: 'bins', notes: 'green one', dueAt: '2026-09-22', recurrence: TUESDAYS, assignedTo: ctx.elisa.userId },
      ctx.alex,
    );
    const change = completeTaskCore(ctx.db, bins.id, ctx.elisa, { today: '2026-09-20', now: NOW });

    expect(change.task.status).toBe('done');
    // The finished occurrence reads as an ordinary done task.
    expect(change.task.recurrence).toBeNull();
    expect(change.removed).toEqual([]);
    expect(change.spawned).toHaveLength(1);

    const next = change.spawned[0]!;
    expect(next.id).not.toBe(bins.id);
    expect(next.status).toBe('todo');
    expect(next.completedAt).toBeNull();
    expect(next.dueAt).toBe('2026-09-29');
    expect(next.recurrence).toEqual({ every: 'week', days: ['tue'], basis: 'due' });
    // The same task continuing: everything a person set is kept.
    expect(next.title).toBe('bins');
    expect(next.notes).toBe('green one');
    expect(next.kind).toBe('task');
    expect(next.parentId).toBeNull();
    expect(next.position).toBe(bins.position);
    expect(next.assignedTo).toBe(ctx.elisa.userId);
    expect(next.sequential).toBe(false);
    // …and so is its author. Who ticked the last one is `updatedBy`.
    expect(next.createdBy).toBe(ctx.alex.userId);
    expect(next.updatedBy).toBe(ctx.elisa.userId);
    // No device captured it.
    expect(next.clientId).toBeNull();
  });

  test('never a backlog: three weeks late yields one row, next week', () => {
    const bins = createTaskCore(ctx.db, { title: 'bins', dueAt: '2026-09-01', recurrence: TUESDAYS }, ctx.alex);
    const change = completeTaskCore(ctx.db, bins.id, ctx.alex, { today: TODAY, now: NOW });
    expect(change.spawned.map((t) => t.dueAt)).toEqual(['2026-09-22']);
    expect(live(ctx).filter((t) => t.status !== 'done')).toHaveLength(1);
  });

  test('basis completed counts from today, and keeps the time of day', () => {
    const plants = createTaskCore(
      ctx.db,
      {
        title: 'plants',
        dueAt: '2026-09-10T08:00:00+02:00',
        recurrence: { every: 'days', interval: 5, basis: 'completed' },
      },
      ctx.alex,
    );
    const change = completeTaskCore(ctx.db, plants.id, ctx.alex, { today: TODAY, now: NOW });
    expect(change.spawned[0]!.dueAt).toBe('2026-09-24T08:00:00+02:00');
  });

  test('basis due with no due date counts from today', () => {
    const t = createTaskCore(ctx.db, { title: 'x', recurrence: TUESDAYS }, ctx.alex);
    const change = completeTaskCore(ctx.db, t.id, ctx.alex, { today: TODAY, now: NOW });
    expect(change.spawned[0]!.dueAt).toBe('2026-09-22');
  });

  test('hide-until moves by as many days as the due date did', () => {
    const t = createTaskCore(
      ctx.db,
      { title: 'x', dueAt: '2026-09-22', deferUntil: '2026-09-20', recurrence: TUESDAYS },
      ctx.alex,
    );
    const change = completeTaskCore(ctx.db, t.id, ctx.alex, { today: '2026-09-22', now: new Date('2026-09-22T09:00:00Z') });
    expect(change.spawned[0]!.dueAt).toBe('2026-09-29');
    expect(change.spawned[0]!.deferUntil).toBe('2026-09-27');
  });

  test('without a `today`, the server uses the UTC date of its own clock', () => {
    const daily = { every: 'days', interval: 1, basis: 'completed' } as const;
    const t = createTaskCore(ctx.db, { title: 'x', recurrence: daily }, ctx.alex);
    // 00:30 in Rome on the 20th. UTC says the 19th, so "after today" is the 20th.
    const change = completeTaskCore(ctx.db, t.id, ctx.alex, { now: new Date('2026-09-19T22:30:00Z') });
    expect(change.spawned[0]!.dueAt).toBe('2026-09-20');
  });

  test('the device saying it is already tomorrow moves the answer by a day', () => {
    const daily = { every: 'days', interval: 1, basis: 'completed' } as const;
    const t = createTaskCore(ctx.db, { title: 'x', recurrence: daily }, ctx.alex);
    const change = completeTaskCore(ctx.db, t.id, ctx.alex, {
      today: '2026-09-20',
      now: new Date('2026-09-19T22:30:00Z'),
    });
    expect(change.spawned[0]!.dueAt).toBe('2026-09-21');
  });

  test('a `today` more than a day from the server is refused, and nothing is written', () => {
    const t = createTaskCore(ctx.db, { title: 'x', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    for (const today of ['2026-09-21', '2026-09-17', '2027-09-19', 'today', '2026-02-30']) {
      expect(statusError(() => completeTaskCore(ctx.db, t.id, ctx.alex, { today, now: NOW }))).toBe(400);
    }
    const [row] = live(ctx);
    expect(row?.status).toBe('todo');
    expect(row?.recurrence).not.toBeNull();
    expect(live(ctx)).toHaveLength(1);
  });

  test('a bad `today` on a task that does not repeat is not consulted', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const change = completeTaskCore(ctx.db, t.id, ctx.alex, { today: 'nonsense', now: NOW });
    expect(change.task.status).toBe('done');
    expect(change.spawned).toEqual([]);
  });

  test('a second tick of the same box spawns nothing more', () => {
    const t = createTaskCore(ctx.db, { title: 'x', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    completeTaskCore(ctx.db, t.id, ctx.alex, { today: TODAY, now: NOW });
    const again = completeTaskCore(ctx.db, t.id, ctx.elisa, { today: TODAY, now: NOW });
    expect(again.spawned).toEqual([]);
    expect(live(ctx)).toHaveLength(2);
  });

  test('dropping the card into Done on the board is a completion too', () => {
    const t = createTaskCore(ctx.db, { title: 'x', dueAt: '2026-09-22', recurrence: TUESDAYS }, ctx.alex);
    const change = setTaskStatusCore(ctx.db, t.id, 'done', ctx.alex, { today: TODAY, now: NOW });
    expect(change.spawned.map((s) => s.dueAt)).toEqual(['2026-09-29']);
    expect(change.task.recurrence).toBeNull();
  });

  test('a move between live lanes spawns nothing', () => {
    const t = createTaskCore(ctx.db, { title: 'x', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    const change = setTaskStatusCore(ctx.db, t.id, 'doing', ctx.alex, { today: TODAY, now: NOW });
    expect(change.spawned).toEqual([]);
    expect(change.task.recurrence).not.toBeNull();
  });

  test('the successor recurs in its turn', () => {
    const t = createTaskCore(ctx.db, { title: 'x', dueAt: '2026-09-22', recurrence: TUESDAYS }, ctx.alex);
    const first = completeTaskCore(ctx.db, t.id, ctx.alex, { today: '2026-09-20', now: NOW }).spawned[0]!;
    const second = completeTaskCore(ctx.db, first.id, ctx.alex, { today: '2026-09-20', now: NOW }).spawned[0]!;
    expect(second.dueAt).toBe('2026-10-06');
    expect(live(ctx).filter((r) => r.recurrence !== null).map((r) => r.id)).toEqual([second.id]);
  });
});

describe('the accidental tick', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  function tickBins(): { bins: Task; next: Task } {
    const bins = createTaskCore(ctx.db, { title: 'bins', dueAt: '2026-09-22', recurrence: TUESDAYS }, ctx.alex);
    const change = completeTaskCore(ctx.db, bins.id, ctx.alex, { today: TODAY, now: NOW });
    return { bins, next: change.spawned[0]! };
  }

  test('reopening takes an untouched successor back, whole', () => {
    const { bins, next } = tickBins();
    const undo = reopenTaskCore(ctx.db, bins.id, ctx.alex);
    expect(undo.removed).toEqual([next.id]);
    expect(undo.spawned).toEqual([]);
    expect(undo.task.status).toBe('todo');
    expect(undo.task.recurrence).toEqual({ every: 'week', days: ['tue'], basis: 'due' });
    expect(undo.task.dueAt).toBe('2026-09-22');
    // Gone, not binned.
    expect(live(ctx).map((t) => t.id)).toEqual([bins.id]);
    expect(listTasksCore(ctx.db, { trash: true }, ctx.alex)).toEqual([]);
  });

  test('dragging the card back out of Done is the same undo', () => {
    const { bins, next } = tickBins();
    const undo = setTaskStatusCore(ctx.db, bins.id, 'doing', ctx.alex);
    expect(undo.removed).toEqual([next.id]);
    expect(undo.task.status).toBe('doing');
    expect(undo.task.recurrence).not.toBeNull();
  });

  test('tick, untick, tick again: one successor, not two', () => {
    const { bins } = tickBins();
    reopenTaskCore(ctx.db, bins.id, ctx.alex);
    const again = completeTaskCore(ctx.db, bins.id, ctx.alex, { today: TODAY, now: NOW });
    expect(again.spawned).toHaveLength(1);
    expect(live(ctx).filter((t) => t.status !== 'done')).toHaveLength(1);
    expect(live(ctx)).toHaveLength(2);
  });

  // Every way a person can touch the successor. After any of them the
  // successor is theirs, and an untick must leave it alone.
  const touches: ReadonlyArray<[string, (c: Ctx, next: Task) => void]> = [
    ['an edit', (c, next) => void updateTaskCore(c.db, next.id, { notes: 'and the glass' }, c.elisa)],
    ['a change of rule', (c, next) => void updateTaskCore(c.db, next.id, { recurrence: { every: 'weekdays', basis: 'due' } }, c.elisa)],
    ['a lane move', (c, next) => void setTaskStatusCore(c.db, next.id, 'doing', c.elisa)],
    ['a lane move and back', (c, next) => {
      setTaskStatusCore(c.db, next.id, 'doing', c.elisa);
      setTaskStatusCore(c.db, next.id, 'todo', c.elisa);
    }],
    ['a bin', (c, next) => void deleteTaskCore(c.db, next.id, c.elisa)],
    ['a bin and a restore', (c, next) => {
      deleteTaskCore(c.db, next.id, c.elisa);
      restoreTaskCore(c.db, next.id, c.elisa);
    }],
    ['a clone of it', (c, next) => void cloneTaskCore(c.db, next.id, c.elisa)],
  ];
  for (const [name, touch] of touches) {
    test(`after ${name}, the successor stays and the reopened row comes back plain`, () => {
      const { bins, next } = tickBins();
      touch(ctx, next);
      const undo = reopenTaskCore(ctx.db, bins.id, ctx.alex);
      expect(undo.removed).toEqual([]);
      expect(undo.task.status).toBe('todo');
      expect(undo.task.recurrence).toBeNull();
      const all = [...live(ctx), ...listTasksCore(ctx.db, { trash: true }, ctx.alex)];
      expect(all.some((t) => t.id === next.id)).toBe(true);
    });
  }

  test('an edit in the same second as the spawn still counts — untouched is not a timestamp', () => {
    // Both clocks are whole seconds, so this successor's `updated_at` equals
    // its `created_at` after the edit. A timestamp comparison would remove it.
    const { bins, next } = tickBins();
    updateTaskCore(ctx.db, next.id, { title: 'bins and glass' }, ctx.alex);
    // Pinned by hand rather than left to how fast the test ran.
    ctx.db.prepare('UPDATE tasks SET updated_at = created_at WHERE id = ?').run(next.id);
    expect(reopenTaskCore(ctx.db, bins.id, ctx.alex).removed).toEqual([]);
  });

  test('the reminder scan is not a person: a rung deadline leaves the successor untouched', () => {
    const { bins, next } = tickBins();
    ctx.db.prepare("UPDATE tasks SET reminded_at = '2026-09-29 00:00:00' WHERE id = ?").run(next.id);
    expect(reopenTaskCore(ctx.db, bins.id, ctx.alex).removed).toEqual([next.id]);
  });

  test('a rule set on the finished row since it was ticked wins over the one coming back', () => {
    const { bins, next } = tickBins();
    updateTaskCore(ctx.db, bins.id, { recurrence: { every: 'weekdays', basis: 'due' } }, ctx.alex);
    const undo = reopenTaskCore(ctx.db, bins.id, ctx.alex);
    expect(undo.removed).toEqual([next.id]);
    expect(undo.task.recurrence).toEqual({ every: 'weekdays', basis: 'due' });
  });

  test('reopening a finished row that never recurred removes nothing', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    completeTaskCore(ctx.db, t.id, ctx.alex);
    expect(reopenTaskCore(ctx.db, t.id, ctx.alex).removed).toEqual([]);
  });
});

describe('the trash', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('binning a recurring row spawns nothing, and restoring it brings the rule back', () => {
    const t = createTaskCore(ctx.db, { title: 'x', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    const binned = deleteTaskCore(ctx.db, t.id, ctx.alex);
    expect(binned.recurrence).not.toBeNull();
    expect(live(ctx)).toEqual([]);
    expect(listTasksCore(ctx.db, { trash: true }, ctx.alex)).toHaveLength(1);

    const back = restoreTaskCore(ctx.db, t.id, ctx.alex);
    expect(back.recurrence).toEqual({ every: 'week', days: ['tue'], basis: 'due' });
    expect(live(ctx)).toHaveLength(1);
  });

  test('binning one occurrence leaves the finished ones where they are', () => {
    const t = createTaskCore(ctx.db, { title: 'x', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    const next = completeTaskCore(ctx.db, t.id, ctx.alex, { today: TODAY, now: NOW }).spawned[0]!;
    deleteTaskCore(ctx.db, next.id, ctx.alex);
    expect(live(ctx).map((r) => r.id)).toEqual([t.id]);
  });
});

describe('a recurring container', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('the successor is the live subtree, every row back at todo, dates moved together', () => {
    const clean = createTaskCore(
      ctx.db,
      { title: 'Weekly clean', kind: 'project', dueAt: '2026-09-20', sequential: true, recurrence: { every: 'days', interval: 7, basis: 'due' } },
      ctx.alex,
    );
    const rooms = createTaskCore(ctx.db, { title: 'Rooms', kind: 'epic', parentId: clean.id }, ctx.alex);
    const kitchen = createTaskCore(ctx.db, { title: 'Kitchen', parentId: rooms.id, dueAt: '2026-09-18' }, ctx.alex);
    const bath = createTaskCore(ctx.db, { title: 'Bathroom', parentId: clean.id, dueAt: '2026-09-19T18:00:00Z', deferUntil: '2026-09-17' }, ctx.alex);
    const binned = createTaskCore(ctx.db, { title: 'Garage', parentId: clean.id }, ctx.alex);
    completeTaskCore(ctx.db, kitchen.id, ctx.alex);
    setTaskStatusCore(ctx.db, bath.id, 'blocked', ctx.alex);
    deleteTaskCore(ctx.db, binned.id, ctx.alex);

    const change = completeTaskCore(ctx.db, clean.id, ctx.alex, { today: TODAY, now: NOW });

    // Completing a container completes its own row and leaves the children be.
    expect(change.task.status).toBe('done');
    expect(listTasksCore(ctx.db, { parentId: clean.id }, ctx.alex).map((t) => t.status).sort()).toEqual(['blocked', 'todo']);

    // Root first, then by depth, then by position.
    expect(change.spawned.map((t) => t.title)).toEqual(['Weekly clean', 'Rooms', 'Bathroom', 'Kitchen']);
    expect(new Set(change.spawned.map((t) => t.status))).toEqual(new Set(['todo']));
    expect(change.spawned.every((t) => t.completedAt === null && t.clientId === null)).toBe(true);

    const [root, newRooms, newBath, newKitchen] = change.spawned;
    expect(root!.kind).toBe('project');
    expect(root!.sequential).toBe(true);
    expect(root!.dueAt).toBe('2026-09-27');
    expect(root!.recurrence).not.toBeNull();
    // The tree is rebuilt under the new root, not hung off the old one.
    expect(newBath!.parentId).toBe(root!.id);
    expect(newRooms!.parentId).toBe(root!.id);
    expect(newKitchen!.parentId).toBe(newRooms!.id);
    expect(newRooms!.kind).toBe('epic');
    // Seven days on, the same as the root — times and hide-untils included.
    expect(newKitchen!.dueAt).toBe('2026-09-25');
    expect(newBath!.dueAt).toBe('2026-09-26T18:00:00Z');
    expect(newBath!.deferUntil).toBe('2026-09-24');
    expect(newRooms!.dueAt).toBeNull();
  });

  test('reopening the container takes the whole untouched tree back', () => {
    const p = createTaskCore(ctx.db, { title: 'P', kind: 'project', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    createTaskCore(ctx.db, { title: 'a', parentId: p.id }, ctx.alex);
    createTaskCore(ctx.db, { title: 'b', parentId: p.id }, ctx.alex);
    const spawned = completeTaskCore(ctx.db, p.id, ctx.alex, { today: TODAY, now: NOW }).spawned;
    expect(spawned).toHaveLength(3);
    const undo = reopenTaskCore(ctx.db, p.id, ctx.alex);
    expect(undo.removed).toEqual(spawned.map((t) => t.id).sort((x, y) => x - y));
    expect(live(ctx)).toHaveLength(3);
    expect(undo.task.recurrence).not.toBeNull();
  });

  // A touch anywhere in the tree is a touch of the tree.
  const treeTouches: ReadonlyArray<[string, (c: Ctx, spawned: Task[]) => void]> = [
    ['ticking one child', (c, s) => void completeTaskCore(c.db, s[1]!.id, c.alex)],
    ['editing one child', (c, s) => void updateTaskCore(c.db, s[2]!.id, { title: 'b!' }, c.alex)],
    ['filing something new inside it', (c, s) => void createTaskCore(c.db, { title: 'new', parentId: s[0]!.id }, c.alex)],
    ['moving an outside task into it', (c, s) => {
      const loose = createTaskCore(c.db, { title: 'loose' }, c.alex);
      updateTaskCore(c.db, loose.id, { parentId: s[0]!.id }, c.alex);
    }],
    ['moving a child out of it', (c, s) => void updateTaskCore(c.db, s[1]!.id, { parentId: null }, c.alex)],
  ];
  for (const [name, touch] of treeTouches) {
    test(`after ${name}, reopening leaves the whole tree`, () => {
      const p = createTaskCore(ctx.db, { title: 'P', kind: 'project', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
      createTaskCore(ctx.db, { title: 'a', parentId: p.id }, ctx.alex);
      createTaskCore(ctx.db, { title: 'b', parentId: p.id }, ctx.alex);
      const spawned = completeTaskCore(ctx.db, p.id, ctx.alex, { today: TODAY, now: NOW }).spawned;
      const before = live(ctx).length;
      touch(ctx, spawned);
      const after = live(ctx).length;
      const undo = reopenTaskCore(ctx.db, p.id, ctx.alex);
      expect(undo.removed).toEqual([]);
      expect(undo.task.recurrence).toBeNull();
      expect(live(ctx)).toHaveLength(after);
      expect(after).toBeGreaterThanOrEqual(before);
    });
  }

  test('a finished occurrence of a series inside the container is not copied a second time', () => {
    const p = createTaskCore(ctx.db, { title: 'P', kind: 'project', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    const water = createTaskCore(
      ctx.db,
      { title: 'water', parentId: p.id, dueAt: TODAY, recurrence: { every: 'days', interval: 2, basis: 'due' } },
      ctx.alex,
    );
    // The child recurs on its own: one done occurrence, one live successor.
    completeTaskCore(ctx.db, water.id, ctx.alex, { today: TODAY, now: NOW });
    const spawned = completeTaskCore(ctx.db, p.id, ctx.alex, { today: TODAY, now: NOW }).spawned;
    // Root + the one LIVE "water". Copying the done one too would water twice.
    expect(spawned.map((t) => t.title)).toEqual(['P', 'water']);
    expect(spawned[1]!.recurrence).toEqual({ every: 'days', interval: 2, basis: 'due' });
  });

  test('a series inside the container that was ended by binning stays ended', () => {
    const p = createTaskCore(ctx.db, { title: 'P', kind: 'project', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    const water = createTaskCore(
      ctx.db,
      { title: 'water', parentId: p.id, dueAt: TODAY, recurrence: { every: 'days', interval: 2, basis: 'due' } },
      ctx.alex,
    );
    const next = completeTaskCore(ctx.db, water.id, ctx.alex, { today: TODAY, now: NOW }).spawned[0]!;
    deleteTaskCore(ctx.db, next.id, ctx.alex);
    const spawned = completeTaskCore(ctx.db, p.id, ctx.alex, { today: TODAY, now: NOW }).spawned;
    expect(spawned.map((t) => t.title)).toEqual(['P']);
  });
});

describe('cloning', () => {
  test('a copy of a recurring task recurs, and succeeds nothing', () => {
    const ctx = setup();
    const t = createTaskCore(ctx.db, { title: 'x', dueAt: TODAY, recurrence: TUESDAYS }, ctx.alex);
    const copy = cloneTaskCore(ctx.db, t.id, ctx.alex).tasks[0]!;
    expect(copy.recurrence).toEqual({ every: 'week', days: ['tue'], basis: 'due' });
    // Completing the original and reopening it must not reach the copy.
    completeTaskCore(ctx.db, t.id, ctx.alex, { today: TODAY, now: NOW });
    reopenTaskCore(ctx.db, t.id, ctx.alex);
    expect(listTasksCore(ctx.db, {}, ctx.alex).map((r) => r.id).sort()).toEqual([t.id, copy.id]);
  });
});
