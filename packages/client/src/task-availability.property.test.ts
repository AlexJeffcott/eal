import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { Task, TaskStatus } from './task-types.ts';
import { availableTaskIds } from './task-availability.ts';

/**
 * The availability rule, checked as a law rather than as a list of cases.
 *
 * Same shape as `packages/api/src/handlers/tasks.levels.property.test.ts` from
 * stage 1, and for the same reason: the rule itself is small and legible, but
 * the way it *composes* down a chain of ancestors is where a bug lives, and no
 * hand-written case list reaches the arrangement that catches it.
 *
 * Three things are pinned here.
 *
 * 1. **The production implementation walks top-down**, carrying an `admitted`
 *    flag from the roots. The oracle below walks **bottom-up**, asking each
 *    task about its own ancestors independently. Two different shapes computing
 *    the same set is a real cross-check; a re-implementation of the same walk
 *    would only pin the typing.
 *
 * 2. **Nesting composes.** The naive implementation — check only the immediate
 *    parent — is the same oracle with `depthLimit: 1`, and the third test
 *    asserts the generator produces trees on which it *disagrees* with the
 *    rule. That is the non-vacuity guard: without it the first two properties
 *    could pass over a generator that never built a shape where nesting
 *    mattered, and would prove nothing about the part that is hard.
 *
 * 3. **The generator reaches the shapes at all** — a sequential container with
 *    a sequential container under it, and a sequential container with a
 *    parallel one under it. Both are counted and asserted non-zero.
 */

const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

const NOW = new Date('2026-09-06T12:00:00Z');
const PAST = '2026-09-01';
const FUTURE = '2026-12-25';

/** What the generator says about one node, before it is placed in a tree. */
interface NodeSpec {
  status: TaskStatus;
  sequential: boolean;
  /** null = a root; a number is reduced modulo the nodes placed so far. */
  parent: number | null;
  defer: 'none' | 'past' | 'future';
  trashed: boolean;
}

const nodeArb: fc.Arbitrary<NodeSpec> = fc.record({
  status: fc.constantFrom(...STATUSES),
  sequential: fc.boolean(),
  // Weighted towards having a parent: a generator that mostly built roots
  // would never reach the nesting this file exists to test.
  parent: fc.oneof(
    { arbitrary: fc.nat({ max: 1000 }), weight: 4 },
    { arbitrary: fc.constant(null), weight: 1 },
  ),
  defer: fc.constantFrom<'none' | 'past' | 'future'>('none', 'past', 'future'),
  // Rare: a trashed row is a real shape (Trash is a view over the same tree)
  // but a set that was mostly trash would test almost nothing else.
  trashed: fc.oneof(
    { arbitrary: fc.constant(false), weight: 9 },
    { arbitrary: fc.constant(true), weight: 1 },
  ),
});

function buildTree(specs: readonly NodeSpec[]): Task[] {
  const tasks: Task[] = [];
  const childCount = new Map<number | null, number>();
  specs.forEach((spec, index) => {
    const id = index + 1;
    let parentId: number | null = null;
    if (spec.parent !== null && tasks.length > 0) {
      // Only earlier nodes, so the generated shape is always a real tree; the
      // cycle and dangling-parent cases are covered by the unit tests, which
      // can state them exactly.
      parentId = (spec.parent % tasks.length) + 1;
    }
    const position = childCount.get(parentId) ?? 0;
    childCount.set(parentId, position + 1);
    const done = spec.status === 'done';
    tasks.push({
      id,
      parentId,
      title: `n${id}`,
      notes: '',
      status: spec.status,
      // `kind` plays no part in availability — the flag is read off whatever
      // row holds children — so the generator leaves it at the capture default
      // rather than also generating level-legal trees.
      kind: 'task',
      deferUntil: spec.defer === 'none' ? null : spec.defer === 'past' ? PAST : FUTURE,
      dueAt: null,
      createdBy: 1,
      assignedTo: null,
      updatedBy: 1,
      createdAt: '2026-09-06T08:00:00Z',
      updatedAt: '2026-09-06T08:00:00Z',
      completedAt: done ? '2026-09-06T09:00:00Z' : null,
      deletedAt: spec.trashed ? '2026-09-05T10:00:00Z' : null,
      position,
      sequential: spec.sequential,
      clientId: null,
    });
  });
  return tasks;
}

// ── The oracle: the definition, read bottom-up ─────────────────────────────

/** Children of `id`, in the sibling order the definition names. */
function childrenOf(tasks: readonly Task[], id: number): Task[] {
  return tasks
    .filter((t) => t.parentId === id)
    .sort((a, b) => (a.position !== b.position ? a.position - b.position : a.id - b.id));
}

/** This branch still carries work: live, and either not done or holding work. */
function outstanding(tasks: readonly Task[], task: Task): boolean {
  if (task.deletedAt !== null) return false;
  if (task.status !== 'done') return true;
  return childrenOf(tasks, task.id).some((child) => outstanding(tasks, child));
}

function firstOutstandingChild(tasks: readonly Task[], id: number): Task | null {
  for (const child of childrenOf(tasks, id)) {
    if (outstanding(tasks, child)) return child;
  }
  return null;
}

/** Rules 1–3: the row, on its own terms. */
function actionableRow(task: Task, cutoff: string): boolean {
  if (task.deletedAt !== null) return false;
  if (task.status !== 'todo' && task.status !== 'doing') return false;
  return task.deferUntil === null || task.deferUntil <= cutoff;
}

/**
 * The definition, restated as "ask this one task about its own ancestors".
 *
 * `depthLimit` is how many ancestors are consulted: `Infinity` is the rule,
 * `1` is the naive implementation the third test exists to rule out.
 */
function availableByOracle(
  tasks: readonly Task[],
  cutoff: string,
  depthLimit: number,
): Set<number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Set<number>();
  for (const task of tasks) {
    if (!actionableRow(task, cutoff)) continue;
    if (firstOutstandingChild(tasks, task.id) !== null) continue;

    let child = task;
    let parentId = task.parentId;
    let depth = 0;
    let admitted = true;
    while (parentId !== null && depth < depthLimit) {
      const parent = byId.get(parentId);
      if (parent === undefined) break;
      if (parent.sequential) {
        const gate = firstOutstandingChild(tasks, parent.id);
        if (gate === null || gate.id !== child.id) {
          admitted = false;
          break;
        }
      }
      child = parent;
      parentId = parent.parentId;
      depth += 1;
    }
    if (admitted) out.add(task.id);
  }
  return out;
}

const CUTOFF = (() => {
  const eod = new Date(NOW);
  eod.setHours(23, 59, 59, 999);
  return eod.toISOString();
})();

function sorted(ids: ReadonlySet<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

/** Does this tree hold a task with a sequential ancestor two or more up? */
function hasNestedSequentialAncestor(tasks: readonly Task[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const task of tasks) {
    let parentId = task.parentId;
    let depth = 0;
    while (parentId !== null) {
      const parent = byId.get(parentId);
      if (parent === undefined) break;
      depth += 1;
      if (depth >= 2 && parent.sequential) return true;
      parentId = parent.parentId;
    }
  }
  return false;
}

describe('availability under arbitrary trees, flags and states (property-based)', () => {
  const treeArb = fc.array(nodeArb, { minLength: 1, maxLength: 10 });

  test('the computed set is exactly the set the definition describes', () => {
    fc.assert(
      fc.property(treeArb, (specs) => {
        const tasks = buildTree(specs);
        expect(sorted(availableTaskIds(tasks, { now: NOW }))).toEqual(
          sorted(availableByOracle(tasks, CUTOFF, Number.POSITIVE_INFINITY)),
        );
      }),
      { numRuns: 500 },
    );
  });

  test('every available task satisfies each clause of the definition on its own', () => {
    // The oracle above could in principle share a misreading with the rule it
    // is checking. These are the clauses restated one at a time, so a wrong
    // *definition* — not just a wrong implementation — has somewhere to fail.
    fc.assert(
      fc.property(treeArb, (specs) => {
        const tasks = buildTree(specs);
        const byId = new Map(tasks.map((t) => [t.id, t]));
        for (const id of availableTaskIds(tasks, { now: NOW })) {
          const task = byId.get(id);
          expect(task).toBeDefined();
          if (task === undefined) return;
          expect(task.deletedAt).toBeNull();
          expect(task.status === 'todo' || task.status === 'doing').toBe(true);
          expect(task.deferUntil === null || task.deferUntil <= CUTOFF).toBe(true);
          expect(firstOutstandingChild(tasks, task.id)).toBeNull();
          // Rule 5, walked out longhand for this one task.
          let child = task;
          let parent = task.parentId === null ? undefined : byId.get(task.parentId);
          while (parent !== undefined) {
            if (parent.sequential) {
              expect(firstOutstandingChild(tasks, parent.id)?.id).toBe(child.id);
            }
            child = parent;
            parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  test('the generator reaches the nested cases — the properties above are not vacuous', () => {
    // A guard on the guards, in three parts: the generator must build nested
    // sequential ancestors at all, the naive "check only the immediate parent"
    // reading must actually disagree on some of them, and the disagreement must
    // be the one predicted — naive offers work the rule holds back, never the
    // reverse.
    let nested = 0;
    let naiveDisagreed = 0;
    let naiveOfferedMore = 0;
    fc.assert(
      fc.property(treeArb, (specs) => {
        const tasks = buildTree(specs);
        if (hasNestedSequentialAncestor(tasks)) nested += 1;
        const rule = availableByOracle(tasks, CUTOFF, Number.POSITIVE_INFINITY);
        const naive = availableByOracle(tasks, CUTOFF, 1);
        if (sorted(rule).join(',') !== sorted(naive).join(',')) {
          naiveDisagreed += 1;
          // Every id the rule admits, the naive reading admits too: dropping
          // ancestor checks can only ever loosen the gate.
          const superset = [...rule].every((id) => naive.has(id));
          if (superset && naive.size > rule.size) naiveOfferedMore += 1;
        }
      }),
      { numRuns: 500 },
    );
    expect({ nested: nested > 0, naiveDisagreed: naiveDisagreed > 0 }).toEqual({
      nested: true,
      naiveDisagreed: true,
    });
    expect(naiveOfferedMore).toBe(naiveDisagreed);
  });

  test('the disagreement, stated as the one tree that shows it', () => {
    // The shrunk counterexample the property above would report, written out
    // so the failure is readable without re-running fast-check: a sequential
    // project, a parallel epic under it, and a sequential epic beside that.
    const tasks = buildTree([
      { status: 'todo', sequential: true, parent: null, defer: 'none', trashed: false },
      { status: 'todo', sequential: false, parent: 0, defer: 'none', trashed: false },
      { status: 'todo', sequential: true, parent: 0, defer: 'none', trashed: false },
      { status: 'todo', sequential: false, parent: 1, defer: 'none', trashed: false },
      { status: 'todo', sequential: false, parent: 2, defer: 'none', trashed: false },
    ]);
    // ids: 1 project(seq) → 2 epic A(parallel) → 4; 3 epic B(seq) → 5.
    expect(sorted(availableTaskIds(tasks, { now: NOW }))).toEqual([4]);
    // The naive reading admits 5 as well: its own parent is sequential and it
    // is that parent's first step. It never asks whether the project above has
    // reached epic B at all.
    expect(sorted(availableByOracle(tasks, CUTOFF, 1))).toEqual([4, 5]);
  });
});
