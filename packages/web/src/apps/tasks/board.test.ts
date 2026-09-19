import { describe, expect, test } from 'bun:test';
import type { Task } from '@eal/client';
import { adjacentLane, BOARD_LANES, byDueThenPosition, isTaskStatus, lanesFor } from './board.ts';

function task(overrides: Partial<Task> & { id: number; title: string }): Task {
  return {
    parentId: null,
    notes: '',
    status: 'todo',
    kind: 'task',
    deferUntil: null,
    dueAt: null,
    createdBy: 1,
    assignedTo: null,
    updatedBy: 1,
    createdAt: '2026-05-20T08:00:00Z',
    updatedAt: '2026-05-20T08:00:00Z',
    completedAt: null,
    deletedAt: null,
    position: 0,
    sequential: false,
    clientId: null,
    ...overrides,
  };
}

describe('BOARD_LANES', () => {
  test('is the four workflow states, in the order work moves', () => {
    expect(BOARD_LANES.map((l) => l.status)).toEqual(['todo', 'doing', 'blocked', 'done']);
    expect(BOARD_LANES.map((l) => l.label)).toEqual(['To do', 'Doing', 'Blocked', 'Done']);
  });
});

describe('lanesFor', () => {
  test('buckets rows by status and returns every lane, empty ones included', () => {
    const lanes = lanesFor([
      task({ id: 1, title: 'a', status: 'doing' }),
      task({ id: 2, title: 'b', status: 'doing' }),
    ]);
    expect(lanes.map((l) => l.status)).toEqual(['todo', 'doing', 'blocked', 'done']);
    expect(lanes.map((l) => l.tasks.length)).toEqual([0, 2, 0, 0]);
  });

  test('keeps every row — nothing is dropped between the list and the board', () => {
    const rows = [
      task({ id: 1, title: 'a' }),
      task({ id: 2, title: 'b', status: 'doing' }),
      task({ id: 3, title: 'c', status: 'blocked' }),
      task({ id: 4, title: 'd', status: 'done', completedAt: '2026-05-20T09:00:00Z' }),
    ];
    const lanes = lanesFor(rows);
    expect(lanes.flatMap((l) => l.tasks.map((t) => t.id)).sort()).toEqual([1, 2, 3, 4]);
  });

  test('an empty selection still draws four lanes', () => {
    expect(lanesFor([]).map((l) => l.tasks.length)).toEqual([0, 0, 0, 0]);
  });

  test('sorts a lane by due date, then position, then id', () => {
    const lanes = lanesFor([
      task({ id: 10, title: 'undated', position: 0 }),
      task({ id: 11, title: 'later', dueAt: '2026-07-01', position: 5 }),
      task({ id: 12, title: 'sooner', dueAt: '2026-06-01', position: 9 }),
      task({ id: 13, title: 'same day, lower position', dueAt: '2026-06-01', position: 1 }),
    ]);
    const todo = lanes[0];
    expect(todo?.tasks.map((t) => t.id)).toEqual([13, 12, 11, 10]);
  });

  test('does not reorder the caller’s array', () => {
    // `visibleFor` hands the board the same array the list renders from; a
    // sort in place here would silently reshuffle the list too.
    const rows = [
      task({ id: 1, title: 'a', dueAt: '2026-07-01' }),
      task({ id: 2, title: 'b', dueAt: '2026-06-01' }),
    ];
    const before = rows.map((t) => t.id);
    lanesFor(rows);
    expect(rows.map((t) => t.id)).toEqual(before);
  });
});

describe('byDueThenPosition', () => {
  test('a dated task sorts before an undated one, whichever side it is on', () => {
    const dated = task({ id: 1, title: 'dated', dueAt: '2026-06-01' });
    const undated = task({ id: 2, title: 'undated' });
    expect(byDueThenPosition(dated, undated)).toBeLessThan(0);
    expect(byDueThenPosition(undated, dated)).toBeGreaterThan(0);
  });

  test('two undated tasks fall through to position, then id', () => {
    expect(
      byDueThenPosition(
        task({ id: 1, title: 'a', position: 3 }),
        task({ id: 2, title: 'b', position: 1 }),
      ),
    ).toBeGreaterThan(0);
    expect(
      byDueThenPosition(
        task({ id: 5, title: 'a', position: 1 }),
        task({ id: 9, title: 'b', position: 1 }),
      ),
    ).toBeLessThan(0);
  });

  test('a date-only value sorts before a timestamp on the same day', () => {
    expect(
      byDueThenPosition(
        task({ id: 1, title: 'a', dueAt: '2026-06-01' }),
        task({ id: 2, title: 'b', dueAt: '2026-06-01T09:00:00Z' }),
      ),
    ).toBeLessThan(0);
  });

  test('identical rows compare equal', () => {
    const a = task({ id: 1, title: 'a', dueAt: '2026-06-01', position: 2 });
    expect(byDueThenPosition(a, a)).toBe(0);
  });
});

describe('isTaskStatus', () => {
  test('admits the four lanes and nothing else', () => {
    for (const value of ['todo', 'doing', 'blocked', 'done']) {
      expect(isTaskStatus(value)).toBe(true);
    }
    for (const value of ['open', 'deleted', 'Doing', '']) {
      expect(isTaskStatus(value)).toBe(false);
    }
  });
});

describe('adjacentLane', () => {
  test('steps forward through the lanes', () => {
    expect(adjacentLane('todo', 1)).toBe('doing');
    expect(adjacentLane('doing', 1)).toBe('blocked');
    expect(adjacentLane('blocked', 1)).toBe('done');
  });

  test('steps back through the lanes', () => {
    expect(adjacentLane('done', -1)).toBe('blocked');
    expect(adjacentLane('blocked', -1)).toBe('doing');
    expect(adjacentLane('doing', -1)).toBe('todo');
  });

  test('wraps at both ends, so neither arrow is ever dead', () => {
    expect(adjacentLane('done', 1)).toBe('todo');
    expect(adjacentLane('todo', -1)).toBe('done');
  });

  test('four steps forward returns to where it started', () => {
    let lane = adjacentLane('todo', 1);
    for (let i = 0; i < 3; i += 1) lane = adjacentLane(lane, 1);
    expect(lane).toBe('todo');
  });
});
