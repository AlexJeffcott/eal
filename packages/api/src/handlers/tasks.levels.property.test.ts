import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createTasksRepo, type TaskKind } from '../db/repos/tasks.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import type { Principal } from '../auth/principals.ts';
import { createTaskCore, levelViolation, updateTaskCore } from './tasks.shared.ts';

/**
 * The level rule, checked as a law rather than as a list of cases.
 *
 * Two things need pinning and they are different things.
 *
 * 1. **The rule itself.** `levelViolation` is one function with three branches
 *    and it is the whole definition of "project → epic → task". The twelve
 *    pairings are enumerated by hand below, from the table in the design, so a
 *    branch flipped by accident fails against something written independently
 *    of the code.
 *
 * 2. **The plumbing.** `createTaskCore` and `updateTaskCore` have to consult
 *    the rule at every seam — a create, a re-parent, a change of kind, and the
 *    change of kind's effect on the row's own children. That is where a real
 *    bug lives: not in the three branches, but in a path that forgets to ask.
 *    fast-check builds an arbitrary tree, makes an arbitrary move, and asserts
 *    the same two invariants after every one: the stored tree never holds an
 *    illegal pairing, and a legal move is never refused.
 *
 * docs/tasks-v1.md planned this shape of test for cycle detection; this is the
 * same shape, for the constraint SQLite cannot express.
 */

const KINDS: readonly TaskKind[] = ['project', 'epic', 'task'];

interface Ctx {
  db: DatabaseClient;
  alex: Principal;
}

function setup(): Ctx {
  const db = createDb(':memory:');
  applySchema(db);
  const u = createUsersRepo(db).insert({ displayName: 'alex' });
  return { db, alex: { userId: u.id, displayName: u.display_name } };
}

/** Message fragments the cores throw, so a test can tell them apart. */
function isLevelRejection(message: string): boolean {
  return (
    message.includes('a project cannot be filed under another task') ||
    message.includes('an epic must be filed under a project') ||
    message.includes('a task cannot be filed under another task')
  );
}

describe('levelViolation — the rule, against a hand-written table', () => {
  // Read straight off the design's table. `null` is "sits at the top level".
  // Every one of the twelve cells is stated, so no pairing is left implied.
  const TABLE: ReadonlyArray<[kind: TaskKind, parent: TaskKind | null, allowed: boolean]> = [
    ['project', null, true],
    ['project', 'project', false],
    ['project', 'epic', false],
    ['project', 'task', false],
    ['epic', null, false],
    ['epic', 'project', true],
    ['epic', 'epic', false],
    ['epic', 'task', false],
    ['task', null, true],
    ['task', 'project', true],
    ['task', 'epic', true],
    ['task', 'task', false],
  ];

  for (const [kind, parent, allowed] of TABLE) {
    const where = parent === null ? 'the top level' : `a ${parent}`;
    test(`a ${kind} ${allowed ? 'may' : 'may not'} sit at ${where}`, () => {
      expect(levelViolation(kind, parent) === null).toBe(allowed);
    });
  }

  test('the epic level is optional — a project holds tasks directly', () => {
    // The decision that makes this a hierarchy people will actually use: a
    // one-off chore inside a project does not need a made-up epic above it.
    expect(levelViolation('task', 'project')).toBeNull();
  });
});

// ── The plumbing, under arbitrary trees and arbitrary moves ────────────────

const kindArb: fc.Arbitrary<TaskKind> = fc.constantFrom(...KINDS);

/**
 * A node to attempt: a level, and which earlier node to file it under
 * (`null` = the top level; a number is reduced modulo the nodes created so
 * far). Nodes whose pairing is illegal are simply not created — the generator
 * does not need to produce only-legal trees, because rejecting them *is* the
 * behaviour under test.
 */
const nodeArb = fc.record({
  kind: kindArb,
  parent: fc.option(fc.nat({ max: 1000 }), { nil: null }),
});

interface Built {
  ids: number[];
  /** How many creates the rule turned away — asserted non-zero across a run. */
  rejected: number;
}

function buildTree(ctx: Ctx, nodes: readonly { kind: TaskKind; parent: number | null }[]): Built {
  const tasks = createTasksRepo(ctx.db);
  const ids: number[] = [];
  let rejected = 0;
  for (const node of nodes) {
    let parentId: number | null = null;
    if (node.parent !== null && ids.length > 0) {
      const picked = ids[node.parent % ids.length];
      if (picked !== undefined) parentId = picked;
    }
    const parentKind = parentId === null ? null : tasks.findById(parentId)?.kind ?? null;
    const legal = levelViolation(node.kind, parentKind) === null;
    try {
      const created = createTaskCore(
        ctx.db,
        { title: `n${ids.length}`, kind: node.kind, parentId },
        ctx.alex,
      );
      expect(legal).toBe(true);
      ids.push(created.id);
    } catch (err) {
      rejected += 1;
      const message = err instanceof Error ? err.message : String(err);
      // The only reason a create may fail here is the level rule: the title is
      // non-empty, the parent is live, and no user is named.
      expect(isLevelRejection(message)).toBe(true);
      expect(legal).toBe(false);
    }
  }
  return { ids, rejected };
}

/** Every stored row satisfies the rule against its own parent. */
function assertTreeLegal(ctx: Ctx): void {
  const tasks = createTasksRepo(ctx.db);
  for (const row of tasks.list({ includeDeleted: true })) {
    const parentKind = row.parent_id === null ? null : tasks.findById(row.parent_id, { includeDeleted: true })?.kind ?? null;
    expect({ id: row.id, why: levelViolation(row.kind, parentKind) }).toEqual({
      id: row.id,
      why: null,
    });
  }
}

describe('level rules under arbitrary trees and moves (property-based)', () => {
  test('a stored tree never holds an illegal pairing, whatever is attempted', () => {
    fc.assert(
      fc.property(
        fc.array(nodeArb, { minLength: 1, maxLength: 8 }),
        fc.nat({ max: 1000 }),
        fc.option(fc.nat({ max: 1000 }), { nil: null }),
        fc.option(kindArb, { nil: null }),
        (nodes, moveWhich, moveWhere, newKind) => {
          const ctx = setup();
          const { ids } = buildTree(ctx, nodes);
          assertTreeLegal(ctx);
          if (ids.length === 0) return;

          const subject = ids[moveWhich % ids.length];
          if (subject === undefined) return;
          const target =
            moveWhere === null ? null : (ids[moveWhere % ids.length] ?? null);

          const patch: { parentId?: number | null; kind?: TaskKind } = { parentId: target };
          if (newKind !== null) patch.kind = newKind;
          try {
            updateTaskCore(ctx.db, subject, patch, ctx.alex);
          } catch {
            /* a rejection is a legal outcome; the invariant below is the point */
          }
          assertTreeLegal(ctx);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('a legal move is never refused, and an illegal one always is', () => {
    fc.assert(
      fc.property(
        fc.array(nodeArb, { minLength: 1, maxLength: 8 }),
        fc.nat({ max: 1000 }),
        fc.option(fc.nat({ max: 1000 }), { nil: null }),
        fc.option(kindArb, { nil: null }),
        (nodes, moveWhich, moveWhere, newKind) => {
          const ctx = setup();
          const { ids } = buildTree(ctx, nodes);
          if (ids.length === 0) return;
          const tasks = createTasksRepo(ctx.db);

          const subject = ids[moveWhich % ids.length];
          if (subject === undefined) return;
          const target = moveWhere === null ? null : (ids[moveWhere % ids.length] ?? null);

          const before = tasks.findById(subject);
          if (before === null) return;
          const nextKind = newKind ?? before.kind;
          const parentKind = target === null ? null : tasks.findById(target)?.kind ?? null;

          // What the rule says should happen, worked out independently of the
          // core: a cycle wins over everything, then the row's own pairing,
          // then whether its children still fit under the new level.
          const cycles = target !== null && tasks.wouldCycle(subject, target);
          const ownViolation = levelViolation(nextKind, parentKind);
          const strandsAChild =
            newKind !== null &&
            newKind !== before.kind &&
            tasks
              .list({ parentId: subject, includeDeleted: true })
              .some((child) => levelViolation(child.kind, newKind) !== null);

          const patch: { parentId?: number | null; kind?: TaskKind } = { parentId: target };
          if (newKind !== null) patch.kind = newKind;

          let failure: string | null = null;
          try {
            updateTaskCore(ctx.db, subject, patch, ctx.alex);
          } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
          }

          if (cycles) {
            expect(failure).toContain('cycle');
            return;
          }
          if (ownViolation !== null) {
            expect(failure).toBe(ownViolation);
            return;
          }
          if (strandsAChild) {
            expect(failure ?? '').toContain('would no longer fit under it');
            return;
          }
          expect(failure).toBeNull();
          const after = tasks.findById(subject);
          expect(after?.parent_id ?? null).toBe(target);
          expect(after?.kind).toBe(nextKind);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('the generator does reach illegal creates — the properties above are not vacuous', () => {
    // A guard on the guards. If `nodeArb` only ever produced legal pairings,
    // both properties would pass while proving nothing about rejection.
    const ctx = setup();
    const { rejected } = buildTree(ctx, [
      { kind: 'task', parent: null },
      { kind: 'task', parent: 0 },
      { kind: 'epic', parent: null },
      { kind: 'project', parent: 0 },
    ]);
    expect(rejected).toBe(3);
  });
});
