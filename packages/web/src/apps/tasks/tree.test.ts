import { describe, expect, test } from 'bun:test';
import type { Task } from '@eal/client';
import { indexChildren, progressOf, tasksInTreeOrder } from './tree.ts';

function task(overrides: Partial<Task> & { id: number; title: string }): Task {
  return {
    parentId: null,
    notes: '',
    status: 'open',
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
    ...overrides,
  };
}

function mapOf(...tasks: Task[]): Map<number, Task> {
  return new Map(tasks.map((t) => [t.id, t]));
}

const DONE = { status: 'done', completedAt: '2026-05-20T09:00:00Z' } as const;
const GONE = { deletedAt: '2026-05-20T09:00:00Z' } as const;

function ids(tasks: readonly Task[]): number[] {
  return tasks.map((t) => t.id);
}

describe('indexChildren', () => {
  test('groups by parent id and leaves roots out of the index', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'root' }),
      task({ id: 2, title: 'child', parentId: 1 }),
      task({ id: 3, title: 'other root' }),
    );
    const index = indexChildren(tasks);
    expect(ids(index.get(1) ?? [])).toEqual([2]);
    expect(index.get(3)).toBeUndefined();
    expect(index.has(2)).toBe(false);
  });

  test('siblings come back in position order, id breaking a tie', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'root' }),
      task({ id: 2, title: 'third', parentId: 1, position: 5 }),
      task({ id: 3, title: 'first', parentId: 1, position: 1 }),
      task({ id: 4, title: 'second', parentId: 1, position: 1 }),
    );
    expect(ids(indexChildren(tasks).get(1) ?? [])).toEqual([3, 4, 2]);
  });

  test('a deleted child stays in the index — Trash orders by the same tree', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'root' }),
      task({ id: 2, title: 'trashed child', parentId: 1, ...GONE }),
    );
    expect(ids(indexChildren(tasks).get(1) ?? [])).toEqual([2]);
  });
});

describe('progressOf', () => {
  test('a leaf reports nothing to show', () => {
    const index = indexChildren(mapOf(task({ id: 1, title: 'lonely' })));
    expect(progressOf(index, 1)).toEqual({ done: 0, total: 0 });
  });

  test('counts every live descendant, not only the direct children', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'project' }),
      task({ id: 2, title: 'child', parentId: 1 }),
      task({ id: 3, title: 'grandchild', parentId: 2, ...DONE }),
      task({ id: 4, title: 'great-grandchild', parentId: 3 }),
    );
    expect(progressOf(indexChildren(tasks), 1)).toEqual({ done: 1, total: 3 });
  });

  test('progress is relative to the task asked about', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'project' }),
      task({ id: 2, title: 'child', parentId: 1 }),
      task({ id: 3, title: 'grandchild', parentId: 2, ...DONE }),
    );
    expect(progressOf(indexChildren(tasks), 2)).toEqual({ done: 1, total: 1 });
  });

  test('a trashed subtree counts for nothing and is not walked into', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'project' }),
      task({ id: 2, title: 'live', parentId: 1 }),
      task({ id: 3, title: 'trashed', parentId: 1, ...GONE }),
      task({ id: 4, title: 'under the trashed one', parentId: 3 }),
    );
    expect(progressOf(indexChildren(tasks), 1)).toEqual({ done: 0, total: 1 });
  });

  test('a cycle in the mirror terminates instead of hanging the render', () => {
    // The server rejects a re-parent that would make this, but broadcasts
    // arrive in any order, so the mirror can hold it between two of them.
    const tasks = mapOf(
      task({ id: 1, title: 'a', parentId: 2 }),
      task({ id: 2, title: 'b', parentId: 1, ...DONE }),
    );
    expect(progressOf(indexChildren(tasks), 1)).toEqual({ done: 1, total: 1 });
  });
});

describe('tasksInTreeOrder', () => {
  test('a root is followed by its own subtree, then the next root', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'first root', position: 0 }),
      task({ id: 2, title: 'second root', position: 1 }),
      task({ id: 3, title: 'child of 1', parentId: 1 }),
      task({ id: 4, title: 'child of 2', parentId: 2 }),
      task({ id: 5, title: 'grandchild of 1', parentId: 3 }),
    );
    expect(ids(tasksInTreeOrder(tasks))).toEqual([1, 3, 5, 2, 4]);
  });

  test('roots run in position order, id breaking a tie', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'last', position: 9 }),
      task({ id: 2, title: 'first', position: 0 }),
      task({ id: 3, title: 'middle', position: 0 }),
    );
    expect(ids(tasksInTreeOrder(tasks))).toEqual([2, 3, 1]);
  });

  test('positions collide across parents, and the tree order ignores that', () => {
    // Every one of these is position 0 — `nextSiblingPosition` numbers within a
    // parent. Sorting the flat set by position would scatter the children.
    const tasks = mapOf(
      task({ id: 1, title: 'root a' }),
      task({ id: 2, title: 'root b' }),
      task({ id: 3, title: 'child of b', parentId: 2 }),
      task({ id: 4, title: 'child of a', parentId: 1 }),
    );
    expect(ids(tasksInTreeOrder(tasks))).toEqual([1, 4, 2, 3]);
  });

  test('a task whose parent is missing from the mirror still lists, at the end', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'root' }),
      task({ id: 2, title: 'orphan', parentId: 99 }),
    );
    expect(ids(tasksInTreeOrder(tasks))).toEqual([1, 2]);
  });

  test('a cycle no root points into still lists, in sibling order', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'root' }),
      task({ id: 2, title: 'a', parentId: 3, position: 4 }),
      task({ id: 3, title: 'b', parentId: 2, position: 2 }),
    );
    expect(ids(tasksInTreeOrder(tasks))).toEqual([1, 3, 2]);
  });

  test('every task in the mirror comes back exactly once', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'root' }),
      task({ id: 2, title: 'child', parentId: 1 }),
      task({ id: 3, title: 'trashed child', parentId: 1, ...GONE }),
      task({ id: 4, title: 'orphan', parentId: 99 }),
    );
    expect(ids(tasksInTreeOrder(tasks)).sort()).toEqual([1, 2, 3, 4]);
  });
});
