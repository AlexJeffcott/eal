import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';
import {
  completeTaskCore,
  cloneTaskCore,
  createTaskCore,
  deleteTaskCore,
  getTaskCore,
  listTasksCore,
  reopenTaskCore,
  restoreTaskCore,
  updateTaskCore,
} from './tasks.shared.ts';

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

describe('createTaskCore', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('happy path: creates a task with sensible defaults', () => {
    const t = createTaskCore(ctx.db, { title: 'buy milk' }, ctx.alex);
    expect(t.title).toBe('buy milk');
    expect(t.status).toBe('open');
    expect(t.completedAt).toBeNull();
    expect(t.deletedAt).toBeNull();
    expect(t.parentId).toBeNull();
    expect(t.notes).toBe('');
    expect(t.assignedTo).toBeNull();
    expect(t.createdBy).toBe(ctx.alex.userId);
    expect(t.updatedBy).toBe(ctx.alex.userId);
  });

  test('title is trimmed', () => {
    const t = createTaskCore(ctx.db, { title: '  spaced  ' }, ctx.alex);
    expect(t.title).toBe('spaced');
  });

  test('400 when title is empty or whitespace-only', () => {
    expect(() => createTaskCore(ctx.db, { title: '' }, ctx.alex)).toThrow(AuthError);
    expect(() => createTaskCore(ctx.db, { title: '   ' }, ctx.alex)).toThrow(/title is required/);
  });

  test('404 when parent does not exist', () => {
    expect(() => createTaskCore(ctx.db, { title: 'x', parentId: 999 }, ctx.alex)).toThrow(/parent task 999 not found/);
  });

  test('404 when parent is soft-deleted', () => {
    const parent = createTaskCore(ctx.db, { title: 'p' }, ctx.alex);
    deleteTaskCore(ctx.db, parent.id, ctx.alex);
    expect(() => createTaskCore(ctx.db, { title: 'c', parentId: parent.id }, ctx.alex)).toThrow(/not found/);
  });

  test('409 when assigned_to references unknown user', () => {
    expect(() => createTaskCore(ctx.db, { title: 'x', assignedTo: 999 }, ctx.alex)).toThrow(/assigned_to/);
  });

  test('400 when defer_until is not ISO 8601', () => {
    expect(() => createTaskCore(ctx.db, { title: 'x', deferUntil: 'tomorrow' }, ctx.alex)).toThrow(/defer_until/);
  });

  test('400 when due_at is not ISO 8601', () => {
    expect(() => createTaskCore(ctx.db, { title: 'x', dueAt: '2026-13-01' }, ctx.alex)).toThrow(/due_at/);
  });

  test('a date-only YYYY-MM-DD is accepted for due_at and defer_until', () => {
    const created = createTaskCore(
      ctx.db,
      { title: 'x', dueAt: '2026-07-01', deferUntil: '2026-06-15' },
      ctx.alex,
    );
    expect(created.dueAt).toBe('2026-07-01');
    expect(created.deferUntil).toBe('2026-06-15');
  });

  test('siblings get incrementing positions automatically', () => {
    const p = createTaskCore(ctx.db, { title: 'p' }, ctx.alex);
    const c1 = createTaskCore(ctx.db, { title: 'c1', parentId: p.id }, ctx.alex);
    const c2 = createTaskCore(ctx.db, { title: 'c2', parentId: p.id }, ctx.alex);
    expect(c1.position).toBe(0);
    expect(c2.position).toBe(1);
  });
});

describe('updateTaskCore', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('updates listed fields, sets updated_by to the actor', () => {
    const t = createTaskCore(ctx.db, { title: 'before' }, ctx.alex);
    const after = updateTaskCore(ctx.db, t.id, { title: 'after', notes: 'detail' }, ctx.elisa);
    expect(after.title).toBe('after');
    expect(after.notes).toBe('detail');
    expect(after.updatedBy).toBe(ctx.elisa.userId);
  });

  test('400 when retitle is empty', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    expect(() => updateTaskCore(ctx.db, t.id, { title: '   ' }, ctx.alex)).toThrow(/title is required/);
  });

  test('404 when target is in trash', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    deleteTaskCore(ctx.db, t.id, ctx.alex);
    expect(() => updateTaskCore(ctx.db, t.id, { title: 'y' }, ctx.alex)).toThrow(/not found or in trash/);
  });

  test('400 cycle detection: cannot re-parent under self', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    expect(() => updateTaskCore(ctx.db, t.id, { parentId: t.id }, ctx.alex)).toThrow(/cycle/);
  });

  test('400 cycle detection: cannot re-parent under own descendant', () => {
    const g = createTaskCore(ctx.db, { title: 'g' }, ctx.alex);
    const p = createTaskCore(ctx.db, { title: 'p', parentId: g.id }, ctx.alex);
    const c = createTaskCore(ctx.db, { title: 'c', parentId: p.id }, ctx.alex);
    expect(() => updateTaskCore(ctx.db, g.id, { parentId: c.id }, ctx.alex)).toThrow(/cycle/);
  });

  test('re-parenting to root (null) is always allowed', () => {
    const p = createTaskCore(ctx.db, { title: 'p' }, ctx.alex);
    const c = createTaskCore(ctx.db, { title: 'c', parentId: p.id }, ctx.alex);
    const moved = updateTaskCore(ctx.db, c.id, { parentId: null }, ctx.alex);
    expect(moved.parentId).toBeNull();
  });

  test('clearing assignedTo via null vs leaving it via absence', () => {
    const t = createTaskCore(ctx.db, { title: 'x', assignedTo: ctx.elisa.userId }, ctx.alex);
    const left = updateTaskCore(ctx.db, t.id, { title: 'y' }, ctx.alex);
    expect(left.assignedTo).toBe(ctx.elisa.userId);
    const cleared = updateTaskCore(ctx.db, t.id, { assignedTo: null }, ctx.alex);
    expect(cleared.assignedTo).toBeNull();
  });
});

describe('complete / reopen', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('complete sets status=done + completed_at', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const done = completeTaskCore(ctx.db, t.id, ctx.elisa);
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();
    expect(done.updatedBy).toBe(ctx.elisa.userId);
  });

  test('completing an already-done task is a no-op (returns current row, no error)', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const first = completeTaskCore(ctx.db, t.id, ctx.alex);
    const second = completeTaskCore(ctx.db, t.id, ctx.elisa);
    expect(second.id).toBe(first.id);
    expect(second.completedAt).toBe(first.completedAt);
    // updated_by stayed alex because the no-op skipped the write
    expect(second.updatedBy).toBe(ctx.alex.userId);
  });

  test('reopen clears completed_at; reopening an open task is a no-op', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    completeTaskCore(ctx.db, t.id, ctx.alex);
    const reopened = reopenTaskCore(ctx.db, t.id, ctx.alex);
    expect(reopened.status).toBe('open');
    expect(reopened.completedAt).toBeNull();

    const second = reopenTaskCore(ctx.db, t.id, ctx.elisa);
    expect(second.updatedBy).toBe(ctx.alex.userId); // no-op
  });

  test('complete/reopen 404 when task is in trash', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    deleteTaskCore(ctx.db, t.id, ctx.alex);
    expect(() => completeTaskCore(ctx.db, t.id, ctx.alex)).toThrow(/not found or in trash/);
    expect(() => reopenTaskCore(ctx.db, t.id, ctx.alex)).toThrow(/not found or in trash/);
  });
});

describe('delete / restore', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('delete soft-deletes; restore brings back as open', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    completeTaskCore(ctx.db, t.id, ctx.alex);
    const trashed = deleteTaskCore(ctx.db, t.id, ctx.elisa);
    expect(trashed.deletedAt).not.toBeNull();

    const restored = restoreTaskCore(ctx.db, t.id, ctx.alex);
    expect(restored.deletedAt).toBeNull();
    expect(restored.status).toBe('open');
    expect(restored.completedAt).toBeNull();
  });

  test('delete idempotent (already-trash returns current row)', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const once = deleteTaskCore(ctx.db, t.id, ctx.alex);
    const twice = deleteTaskCore(ctx.db, t.id, ctx.elisa);
    expect(twice.deletedAt).toBe(once.deletedAt);
  });

  test('restore idempotent (already-live returns current row)', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const r = restoreTaskCore(ctx.db, t.id, ctx.elisa);
    expect(r.id).toBe(t.id);
    expect(r.deletedAt).toBeNull();
  });

  test('delete is shallow at this layer — children remain (cascade is at purge time only)', () => {
    const p = createTaskCore(ctx.db, { title: 'p' }, ctx.alex);
    const c = createTaskCore(ctx.db, { title: 'c', parentId: p.id }, ctx.alex);
    deleteTaskCore(ctx.db, p.id, ctx.alex);
    // The child is NOT auto-trashed by soft-delete of the parent. The application
    // can either also-trash children or leave them as orphaned roots — that's a
    // separate UX decision, not enforced here.
    const childDetail = getTaskCore(ctx.db, c.id);
    expect(childDetail.task.deletedAt).toBeNull();
  });
});

describe('cloneTaskCore', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('clones root + descendants under the actor', () => {
    const shop = createTaskCore(ctx.db, { title: 'shop' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'milk', parentId: shop.id }, ctx.alex);
    createTaskCore(ctx.db, { title: 'eggs', parentId: shop.id }, ctx.alex);
    const cloned = cloneTaskCore(ctx.db, shop.id, ctx.elisa);
    expect(cloned.tasks).toHaveLength(3);
    expect(cloned.rootId).not.toBe(shop.id);
    expect(cloned.tasks.every((t) => t.createdBy === ctx.elisa.userId)).toBe(true);
  });

  test('404 when source is in trash', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    deleteTaskCore(ctx.db, t.id, ctx.alex);
    expect(() => cloneTaskCore(ctx.db, t.id, ctx.alex)).toThrow(/not found or in trash/);
  });
});

describe('listTasksCore', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('"me" resolves to the principal for assignedTo and createdBy', () => {
    const a = createTaskCore(ctx.db, { title: 'a-mine', assignedTo: ctx.alex.userId }, ctx.alex);
    const b = createTaskCore(ctx.db, { title: 'b-hers', assignedTo: ctx.elisa.userId }, ctx.alex);
    expect(listTasksCore(ctx.db, { assignedTo: 'me' }, ctx.alex).map((t) => t.id)).toEqual([a.id]);
    expect(listTasksCore(ctx.db, { assignedTo: 'me' }, ctx.elisa).map((t) => t.id)).toEqual([b.id]);
    expect(listTasksCore(ctx.db, { createdBy: 'me' }, ctx.alex).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(listTasksCore(ctx.db, { createdBy: 'me' }, ctx.elisa)).toEqual([]);
  });

  test('today filter implies status=open and uses default UTC cutoff when none provided', () => {
    const now = new Date('2026-05-19T10:00:00Z');
    createTaskCore(ctx.db, { title: 'past', deferUntil: '2020-01-01T00:00:00Z' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'future', deferUntil: '2999-01-01T00:00:00Z' }, ctx.alex);
    const noDefer = createTaskCore(ctx.db, { title: 'no-defer' }, ctx.alex);
    completeTaskCore(ctx.db, noDefer.id, ctx.alex);

    const titles = listTasksCore(ctx.db, { today: true }, ctx.alex, { now }).map((t) => t.title).sort();
    // Excludes 'future' (deferred past today) and 'no-defer' (status=done after completion).
    expect(titles).toEqual(['past']);
  });

  test('trash filter returns only soft-deleted', () => {
    const a = createTaskCore(ctx.db, { title: 'a' }, ctx.alex);
    const b = createTaskCore(ctx.db, { title: 'b' }, ctx.alex);
    deleteTaskCore(ctx.db, b.id, ctx.alex);
    expect(listTasksCore(ctx.db, {}, ctx.alex).map((t) => t.id)).toEqual([a.id]);
    expect(listTasksCore(ctx.db, { trash: true }, ctx.alex).map((t) => t.id)).toEqual([b.id]);
  });

  test('inbox filter: parent null AND assignee null AND no defer', () => {
    createTaskCore(ctx.db, { title: 'in-1' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'assigned', assignedTo: ctx.alex.userId }, ctx.alex);
    const p = createTaskCore(ctx.db, { title: 'project' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'child', parentId: p.id }, ctx.alex);
    const titles = listTasksCore(ctx.db, { inbox: true }, ctx.alex).map((t) => t.title).sort();
    expect(titles).toEqual(['in-1', 'project']);
  });
});

describe('getTaskCore', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('returns task + children (children excludes trashed)', () => {
    const p = createTaskCore(ctx.db, { title: 'p' }, ctx.alex);
    const a = createTaskCore(ctx.db, { title: 'a', parentId: p.id }, ctx.alex);
    const b = createTaskCore(ctx.db, { title: 'b', parentId: p.id }, ctx.alex);
    deleteTaskCore(ctx.db, b.id, ctx.alex);
    const detail = getTaskCore(ctx.db, p.id);
    expect(detail.task.id).toBe(p.id);
    expect(detail.children.map((t) => t.id)).toEqual([a.id]);
  });

  test('detail of a trashed task is still fetchable (so Trash view can render)', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    deleteTaskCore(ctx.db, t.id, ctx.alex);
    const detail = getTaskCore(ctx.db, t.id);
    expect(detail.task.deletedAt).not.toBeNull();
  });
});
