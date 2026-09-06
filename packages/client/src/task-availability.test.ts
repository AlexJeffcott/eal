import { describe, expect, test } from 'bun:test';
import type { Task } from './task-types.ts';
import { availableTaskIds, compareSiblingOrder, endOfDayIso } from './task-availability.ts';

/**
 * The worked examples. `task-availability.property.test.ts` proves the rule
 * holds over arbitrary trees; this file pins the handful of shapes a person can
 * read and check against the definition by eye, and is where a regression is
 * legible rather than being reported as a shrunk counterexample.
 */

let seq = 0;
function task(overrides: Partial<Task> & { id: number }): Task {
  seq += 1;
  return {
    parentId: null,
    title: `t${overrides.id}`,
    notes: '',
    status: 'todo',
    kind: 'task',
    deferUntil: null,
    dueAt: null,
    createdBy: 1,
    assignedTo: null,
    updatedBy: 1,
    createdAt: '2026-09-06T08:00:00Z',
    updatedAt: '2026-09-06T08:00:00Z',
    completedAt: null,
    deletedAt: null,
    position: seq,
    sequential: false,
    ...overrides,
  };
}

const NOW = new Date('2026-09-06T12:00:00Z');

function availableIn(...tasks: Task[]): number[] {
  return [...availableTaskIds(tasks, { now: NOW })].sort((a, b) => a - b);
}

describe('compareSiblingOrder', () => {
  test('orders by position, then by id', () => {
    const a = task({ id: 2, position: 0 });
    const b = task({ id: 1, position: 1 });
    expect(compareSiblingOrder(a, b)).toBeLessThan(0);
    const c = task({ id: 5, position: 3 });
    const d = task({ id: 4, position: 3 });
    expect(compareSiblingOrder(c, d)).toBeGreaterThan(0);
    expect(compareSiblingOrder(c, c)).toBe(0);
  });
});

describe('endOfDayIso', () => {
  test('is the end of the local day, so a date-only defer compares correctly', () => {
    const cutoff = endOfDayIso(new Date('2026-09-06T09:30:00Z'));
    // A bare calendar date sorts before any timestamp on the same day, which is
    // what lets `deferUntil <= cutoff` work on both shapes of stored value.
    expect('2026-09-06' <= cutoff).toBe(true);
    expect('2026-09-07' <= cutoff).toBe(false);
  });
});

describe('availableTaskIds — a flat list', () => {
  test('todo and doing are available; blocked and done are not', () => {
    expect(
      availableIn(
        task({ id: 1, status: 'todo' }),
        task({ id: 2, status: 'doing' }),
        task({ id: 3, status: 'blocked' }),
        task({ id: 4, status: 'done', completedAt: '2026-09-05T10:00:00Z' }),
      ),
    ).toEqual([1, 2]);
  });

  test('a task deferred past today is not available; one deferred to today is', () => {
    expect(
      availableIn(
        task({ id: 1, deferUntil: '2026-09-07' }),
        task({ id: 2, deferUntil: '2026-09-06' }),
        task({ id: 3, deferUntil: null }),
      ),
    ).toEqual([2, 3]);
  });

  test('a trashed task is never available', () => {
    expect(availableIn(task({ id: 1, deletedAt: '2026-09-05T10:00:00Z' }))).toEqual([]);
  });
});

describe('availableTaskIds — a parallel container', () => {
  test('every child is available and the container itself is not', () => {
    expect(
      availableIn(
        task({ id: 1, kind: 'project' }),
        task({ id: 2, parentId: 1, position: 0 }),
        task({ id: 3, parentId: 1, position: 1 }),
      ),
    ).toEqual([2, 3]);
  });

  test('a container whose children are all done becomes the action itself', () => {
    // The remaining act on a finished project is to tick it off, so it is
    // available — that is what "a container is not itself an action *while it
    // holds unfinished work*" means at the end of the work.
    expect(
      availableIn(
        task({ id: 1, kind: 'project' }),
        task({ id: 2, parentId: 1, status: 'done', completedAt: '2026-09-05T10:00:00Z' }),
      ),
    ).toEqual([1]);
  });

  test('a done container still holding live work is not an action, and its work is', () => {
    // `complete` does not cascade, so this shape is reachable: tick the project
    // off while a subtask is still open. The subtask is what remains to do.
    expect(
      availableIn(
        task({ id: 1, kind: 'project', status: 'done', completedAt: '2026-09-05T10:00:00Z' }),
        task({ id: 2, parentId: 1 }),
      ),
    ).toEqual([2]);
  });

  test('a trashed child neither blocks its parent nor lists itself', () => {
    expect(
      availableIn(
        task({ id: 1, kind: 'project' }),
        task({ id: 2, parentId: 1, deletedAt: '2026-09-05T10:00:00Z' }),
      ),
    ).toEqual([1]);
  });
});

describe('availableTaskIds — a sequential container', () => {
  const project = task({ id: 1, kind: 'project', sequential: true });
  const step1 = task({ id: 2, parentId: 1, position: 0, title: 'step 1' });
  const step2 = task({ id: 3, parentId: 1, position: 1, title: 'step 2' });
  const step3 = task({ id: 4, parentId: 1, position: 2, title: 'step 3' });

  test('hands out exactly the first step', () => {
    expect(availableIn(project, step1, step2, step3)).toEqual([2]);
  });

  test('completing the first step advances to the second', () => {
    const done1 = { ...step1, status: 'done' as const, completedAt: '2026-09-06T09:00:00Z' };
    expect(availableIn(project, done1, step2, step3)).toEqual([3]);
  });

  test('sibling order is (position, id), not insertion order', () => {
    // The same three steps, handed over in the wrong order and with ids that
    // disagree with positions. The first step is still the first step.
    const a = task({ id: 30, parentId: 1, position: 2 });
    const b = task({ id: 20, parentId: 1, position: 0 });
    const c = task({ id: 10, parentId: 1, position: 1 });
    expect(availableIn(project, a, c, b)).toEqual([20]);
  });

  test('a blocked first step hands out nothing — which is the honest answer', () => {
    const stuck = { ...step1, status: 'blocked' as const };
    expect(availableIn(project, stuck, step2, step3)).toEqual([]);
  });

  test('a deferred first step hands out nothing until its date', () => {
    const later = { ...step1, deferUntil: '2026-09-20' };
    expect(availableIn(project, later, step2, step3)).toEqual([]);
  });
});

describe('availableTaskIds — nesting, which is where the rule composes', () => {
  /**
   * A sequential project holding two epics. The first epic is parallel and the
   * second is sequential:
   *
   *   1 project (sequential)
   *     2 epic A (parallel)   → 4, 5
   *     3 epic B (sequential) → 6, 7
   *
   * The whole point of marking the project sequential is that epic B is not
   * started yet. An implementation that consulted only the immediate parent
   * would offer 6 as well, because 6 is epic B's own first step.
   */
  const tree = [
    task({ id: 1, kind: 'project', sequential: true, position: 0 }),
    task({ id: 2, kind: 'epic', parentId: 1, position: 0 }),
    task({ id: 3, kind: 'epic', parentId: 1, position: 1, sequential: true }),
    task({ id: 4, parentId: 2, position: 0 }),
    task({ id: 5, parentId: 2, position: 1 }),
    task({ id: 6, parentId: 3, position: 0 }),
    task({ id: 7, parentId: 3, position: 1 }),
  ];

  test('the outer sequential flag reaches past a parallel epic', () => {
    expect(availableIn(...tree)).toEqual([4, 5]);
  });

  test('sequential over sequential exposes one task overall, not one per level', () => {
    const seqA = tree.map((t) => (t.id === 2 ? { ...t, sequential: true } : t));
    expect(availableIn(...seqA)).toEqual([4]);
  });

  test('finishing the first epic moves the project on to the second', () => {
    const finished = tree.map((t) =>
      t.id === 2 || t.id === 4 || t.id === 5
        ? { ...t, status: 'done' as const, completedAt: '2026-09-06T09:00:00Z' }
        : t,
    );
    // Epic B is sequential, so it offers its own first step and nothing else.
    expect(availableIn(...finished)).toEqual([6]);
  });
});

describe('availableTaskIds — shapes the mirror can hold but the server rejects', () => {
  test('a task whose parent has not arrived yet is judged on its own', () => {
    // A broadcast can land out of order. Dropping the row would make a task
    // vanish from Next for a reason nobody could see; with no ancestor to ask,
    // its own predicates are everything that is known.
    expect(availableIn(task({ id: 9, parentId: 404 }))).toEqual([9]);
  });

  test('a cycle terminates, and its members are not offered as next actions', () => {
    // No well-founded ancestor chain exists for a row inside a loop, so there
    // is no honest answer to "does every ancestor admit it". They still list in
    // All, which is where a person would see and fix it.
    const a = task({ id: 1, parentId: 2, kind: 'project' });
    const b = task({ id: 2, parentId: 1, kind: 'project' });
    const outside = task({ id: 3 });
    expect(availableIn(a, b, outside)).toEqual([3]);
  });

  test('a self-parented row terminates too', () => {
    expect(availableIn(task({ id: 1, parentId: 1 }), task({ id: 2 }))).toEqual([2]);
  });

  test('an empty set is empty, not an error', () => {
    expect(availableIn()).toEqual([]);
  });
});
