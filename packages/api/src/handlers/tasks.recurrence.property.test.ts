import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import type { TaskStatus } from '../db/repos/tasks.ts';
import type { Principal } from '../auth/principals.ts';
import {
  completeTaskCore,
  createTaskCore,
  deleteTaskCore,
  reopenTaskCore,
  restoreTaskCore,
  setTaskStatusCore,
  updateTaskCore,
} from './tasks.shared.ts';

/**
 * The bins must never come round twice.
 *
 * A recurring task is a series of rows, and two of the things a person does to
 * it pull in opposite directions: ticking a row makes the next one, and
 * unticking it may take the next one back. Interleave those with edits, lane
 * moves, bins and restores — on any row of the series, in any order, from two
 * people — and the question is whether some order leaves two live occurrences,
 * or none.
 *
 * The example tests in tasks.recurrence.test.ts walk the orders someone thought
 * of. This one does not choose: fast-check builds the sequence, and the same
 * laws are checked after every single step.
 *
 *   ONE RULE      exactly one row of the series carries the rule, always. It
 *                 moves; it is never copied and never lost.
 *   ONE SUCCESSOR so at most one row that still has work in it carries it —
 *                 "two live successors" is a special case of two rules.
 *   DONE IS PLAIN a finished occurrence carries none: completing it handed the
 *                 rule on.
 *   NO ORPHANS    a row marked as somebody's untouched successor has a
 *                 finished, unbinned row to be the successor of — the only
 *                 kind of row an untick can reach — and its tree has one root.
 *
 * Deliberately outside the generator: setting a rule by hand, and cloning. Both
 * start a second series on purpose, and "one rule" is a law about one.
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

type Op =
  | { kind: 'complete'; pick: number; who: number; today: number }
  | { kind: 'reopen'; pick: number; who: number }
  | { kind: 'status'; pick: number; who: number; status: TaskStatus; today: number }
  | { kind: 'edit'; pick: number; who: number }
  | { kind: 'delete'; pick: number; who: number }
  | { kind: 'restore'; pick: number; who: number };

const pick = fc.nat({ max: 50 });
const who = fc.nat({ max: 1 });
// The device's date may lead or trail the server's by a day; both are legal.
const today = fc.integer({ min: -1, max: 1 });
const status = fc.constantFrom<TaskStatus>('todo', 'doing', 'blocked', 'done');

const opArb: fc.Arbitrary<Op> = fc.oneof(
  // Weighted towards the two that move the rule: that is where the bug would be.
  { weight: 4, arbitrary: fc.record({ kind: fc.constant<'complete'>('complete'), pick, who, today }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant<'reopen'>('reopen'), pick, who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant<'status'>('status'), pick, who, status, today }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant<'edit'>('edit'), pick, who }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant<'delete'>('delete'), pick, who }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant<'restore'>('restore'), pick, who }) },
);

const NOW = new Date('2026-09-19T12:00:00Z');
const DAYS = ['2026-09-18', '2026-09-19', '2026-09-20'];

interface Row {
  id: number;
  status: TaskStatus;
  deleted_at: string | null;
  recurrence: string | null;
  spawned_from: number | null;
  spawn_group: number | null;
}

function rows(db: DatabaseClient): Row[] {
  return db
    .prepare<Row, []>('SELECT id, status, deleted_at, recurrence, spawned_from, spawn_group FROM tasks ORDER BY id')
    .all();
}

/** Run one step. A refusal (a 404 for a binned row) is a legal outcome, not a failure. */
function apply(ctx: Ctx, op: Op): void {
  const all = rows(ctx.db);
  const target = all[op.pick % all.length];
  if (target === undefined) return;
  const principal = op.who === 0 ? ctx.alex : ctx.elisa;
  try {
    if (op.kind === 'complete') {
      completeTaskCore(ctx.db, target.id, principal, { today: DAYS[op.today + 1], now: NOW });
    } else if (op.kind === 'reopen') {
      reopenTaskCore(ctx.db, target.id, principal);
    } else if (op.kind === 'status') {
      setTaskStatusCore(ctx.db, target.id, op.status, principal, { today: DAYS[op.today + 1], now: NOW });
    } else if (op.kind === 'edit') {
      updateTaskCore(ctx.db, target.id, { notes: `edited by ${principal.displayName}` }, principal);
    } else if (op.kind === 'delete') {
      deleteTaskCore(ctx.db, target.id, principal);
    } else {
      restoreTaskCore(ctx.db, target.id, principal);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) return;
    throw err;
  }
}

function checkLaws(db: DatabaseClient, step: string): void {
  const all = rows(db);
  const carrying = all.filter((r) => r.recurrence !== null);
  // ONE RULE
  expect({ step, carrying: carrying.map((r) => r.id) }).toEqual({
    step,
    carrying: [carrying[0]?.id ?? -1],
  });
  // ONE SUCCESSOR
  const liveCarrying = carrying.filter((r) => r.deleted_at === null && r.status !== 'done');
  expect(liveCarrying.length).toBeLessThanOrEqual(1);
  // DONE IS PLAIN — outside the bin; restore is what brings a binned row back
  // to `todo`, so a binned row's status is whatever it was binned with.
  for (const r of all) {
    if (r.status === 'done') expect({ step, id: r.id, rule: r.recurrence }).toEqual({ step, id: r.id, rule: null });
  }
  // NO ORPHANS
  for (const r of all) {
    if (r.spawn_group === null) continue;
    const from = all.find((c) => c.id === r.spawn_group);
    expect({ step, id: r.id, from: from?.status, binned: from?.deleted_at }).toEqual({
      step,
      id: r.id,
      from: 'done',
      binned: null,
    });
    const roots = all.filter((c) => c.spawn_group === r.spawn_group && c.spawned_from === r.spawn_group);
    expect({ step, group: r.spawn_group, roots: roots.length }).toEqual({
      step,
      group: r.spawn_group,
      roots: 1,
    });
  }
}

describe('a recurring series under arbitrary ticks, unticks, edits, bins and restores', () => {
  for (const [name, rule] of [
    ['a rule counted from the due date', { every: 'week', days: ['tue', 'fri'], basis: 'due' }],
    ['a rule counted from completion', { every: 'days', interval: 3, basis: 'completed' }],
  ] as const) {
    test(`${name}: one rule, one live successor, after every step`, () => {
      fc.assert(
        fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
          const ctx = setup();
          createTaskCore(ctx.db, { title: 'bins', dueAt: '2026-09-15', recurrence: rule }, ctx.alex);
          checkLaws(ctx.db, 'start');
          ops.forEach((op, i) => {
            apply(ctx, op);
            checkLaws(ctx.db, `step ${i}: ${JSON.stringify(op)}`);
          });
          ctx.db.close();
        }),
        { numRuns: 300 },
      );
    });
  }

  test('a recurring container: the same laws hold for the root of the tree', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
        const ctx = setup();
        const p = createTaskCore(
          ctx.db,
          { title: 'clean', kind: 'project', dueAt: '2026-09-15', recurrence: { every: 'days', interval: 7, basis: 'due' } },
          ctx.alex,
        );
        createTaskCore(ctx.db, { title: 'kitchen', parentId: p.id }, ctx.alex);
        createTaskCore(ctx.db, { title: 'bathroom', parentId: p.id }, ctx.alex);
        checkLaws(ctx.db, 'start');
        ops.forEach((op, i) => {
          apply(ctx, op);
          checkLaws(ctx.db, `step ${i}: ${JSON.stringify(op)}`);
        });
        ctx.db.close();
      }),
      { numRuns: 200 },
    );
  });
});
