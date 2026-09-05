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
  setTaskStatusCore,
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
    expect(t.status).toBe('todo');
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
    const parent = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
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

  describe('ISO 8601 regex — boundary rejection', () => {
    const reject = (value: string) =>
      expect(() => createTaskCore(ctx.db, { title: 'x', dueAt: value }, ctx.alex)).toThrow(
        /due_at/,
      );
    const accept = (value: string) => {
      const t = createTaskCore(ctx.db, { title: 'x', dueAt: value }, ctx.alex);
      expect(t.dueAt).toBe(value);
    };

    test('rejects trailing garbage after a valid date', () => reject('2026-05-19-junk'));
    test('rejects leading garbage before a valid date', () => reject('junk-2026-05-19'));
    test('rejects day 32-39', () => reject('2026-05-32'));
    test('rejects day 30', () => accept('2026-05-30'));
    test('rejects month 00', () => reject('2026-00-15'));
    test('rejects month 13', () => reject('2026-13-15'));
    test('rejects day 00', () => reject('2026-05-00'));
    test('rejects a 3-digit year', () => reject('999-05-19'));
    test('accepts a leap-day-ish 29', () => accept('2024-02-29'));
    test('accepts a timestamp with fractional seconds', () =>
      accept('2026-05-19T10:00:00.123Z'));
    test('rejects an empty fractional-seconds suffix', () => reject('2026-05-19T10:00:00.Z'));
    test('rejects non-digit fractional seconds', () =>
      reject('2026-05-19T10:00:00.abcZ'));
    test('accepts a positive timezone offset', () =>
      accept('2026-05-19T10:00:00+02:00'));
    test('accepts a negative timezone offset', () =>
      accept('2026-05-19T10:00:00-05:30'));
    test('rejects a single-digit TZ hour', () => reject('2026-05-19T10:00:00+2:00'));
    test('rejects a non-digit TZ hour', () => reject('2026-05-19T10:00:00+ab:00'));
    test('rejects a non-sign sign character in the TZ offset', () =>
      reject('2026-05-19T10:00:00*02:00'));
    test('rejects a missing TZ designator', () => reject('2026-05-19T10:00:00'));
    test('rejects single-digit hours in the time portion', () =>
      reject('2026-05-19T1:00:00Z'));
    test('treats an explicit null as "field absent" (no error)', () => {
      const t = createTaskCore(
        ctx.db,
        { title: 'x', dueAt: null, deferUntil: null },
        ctx.alex,
      );
      expect(t.dueAt).toBeNull();
      expect(t.deferUntil).toBeNull();
    });
  });

  test('siblings get incrementing positions automatically', () => {
    const p = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
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
    // A legal three-level chain, so the move below is refused for being a
    // cycle and not for breaking the level rule — the two checks are ordered,
    // cycle first, and this pins that order.
    const g = createTaskCore(ctx.db, { title: 'g', kind: 'project' }, ctx.alex);
    const p = createTaskCore(ctx.db, { title: 'p', kind: 'epic', parentId: g.id }, ctx.alex);
    const c = createTaskCore(ctx.db, { title: 'c', parentId: p.id }, ctx.alex);
    expect(() => updateTaskCore(ctx.db, g.id, { parentId: c.id }, ctx.alex)).toThrow(/cycle/);
  });

  test('re-parenting to root (null) is always allowed', () => {
    const p = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
    const c = createTaskCore(ctx.db, { title: 'c', parentId: p.id }, ctx.alex);
    const moved = updateTaskCore(ctx.db, c.id, { parentId: null }, ctx.alex);
    expect(moved.parentId).toBeNull();
  });

  test('400 when defer_until on update is not ISO 8601', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    expect(() => updateTaskCore(ctx.db, t.id, { deferUntil: 'soon' }, ctx.alex)).toThrow(
      /defer_until/,
    );
  });

  test('400 when due_at on update is not ISO 8601', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    expect(() => updateTaskCore(ctx.db, t.id, { dueAt: '2026-13-01' }, ctx.alex)).toThrow(
      /due_at/,
    );
  });

  test('update applies notes independently of title', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const u = updateTaskCore(ctx.db, t.id, { notes: 'just notes' }, ctx.alex);
    expect(u.title).toBe('x');
    expect(u.notes).toBe('just notes');
  });

  test('update applies deferUntil and dueAt independently', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const u = updateTaskCore(
      ctx.db,
      t.id,
      { deferUntil: '2026-06-01', dueAt: '2026-07-01' },
      ctx.alex,
    );
    expect(u.deferUntil).toBe('2026-06-01');
    expect(u.dueAt).toBe('2026-07-01');
  });

  test('update applies a position change', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const u = updateTaskCore(ctx.db, t.id, { position: 42 }, ctx.alex);
    expect(u.position).toBe(42);
  });

  test('clearing assignedTo via null vs leaving it via absence', () => {
    const t = createTaskCore(ctx.db, { title: 'x', assignedTo: ctx.elisa.userId }, ctx.alex);
    const left = updateTaskCore(ctx.db, t.id, { title: 'y' }, ctx.alex);
    expect(left.assignedTo).toBe(ctx.elisa.userId);
    const cleared = updateTaskCore(ctx.db, t.id, { assignedTo: null }, ctx.alex);
    expect(cleared.assignedTo).toBeNull();
  });
});

describe('levels', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('capture defaults to the bottom level', () => {
    // Quick-add never has to decide. "Write it down, discover later it is a
    // project" is the whole reason the level is a column and not a table.
    expect(createTaskCore(ctx.db, { title: 'x' }, ctx.alex).kind).toBe('task');
  });

  test('promotion keeps the row id, so every reference to it survives', () => {
    const captured = createTaskCore(ctx.db, { title: 'renovate the kitchen' }, ctx.alex);
    const promoted = updateTaskCore(ctx.db, captured.id, { kind: 'project' }, ctx.alex);
    expect(promoted.id).toBe(captured.id);
    expect(promoted.kind).toBe('project');
  });

  test('400 on a create that breaks the level rule, naming which rule', () => {
    const project = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
    expect(() =>
      createTaskCore(ctx.db, { title: 'nested', kind: 'project', parentId: project.id }, ctx.alex),
    ).toThrow(/a project cannot be filed under another task/);
    expect(() => createTaskCore(ctx.db, { title: 'loose', kind: 'epic' }, ctx.alex)).toThrow(
      /an epic must be filed under a project/,
    );
    const plain = createTaskCore(ctx.db, { title: 'plain' }, ctx.alex);
    expect(() => createTaskCore(ctx.db, { title: 'sub', parentId: plain.id }, ctx.alex)).toThrow(
      /a task cannot be filed under another task/,
    );
  });

  test('one PATCH may move both halves of the pair at once', () => {
    // Promoting a filed task to a project has to unfile it in the same call,
    // or neither half is ever legal on its own.
    const project = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
    const child = createTaskCore(ctx.db, { title: 'c', parentId: project.id }, ctx.alex);
    expect(() => updateTaskCore(ctx.db, child.id, { kind: 'project' }, ctx.alex)).toThrow(
      /a project cannot be filed under another task/,
    );
    const moved = updateTaskCore(ctx.db, child.id, { kind: 'project', parentId: null }, ctx.alex);
    expect(moved.kind).toBe('project');
    expect(moved.parentId).toBeNull();
  });

  test('a demotion that would strand a child is refused, and nothing changes', () => {
    const project = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
    const epic = createTaskCore(ctx.db, { title: 'e', kind: 'epic', parentId: project.id }, ctx.alex);
    expect(() => updateTaskCore(ctx.db, project.id, { kind: 'task' }, ctx.alex)).toThrow(
      new RegExp(`task ${epic.id} would no longer fit under it`),
    );
    expect(getTaskCore(ctx.db, project.id).task.kind).toBe('project');
  });

  test('a trashed child still constrains its parent’s level', () => {
    // Soft-delete leaves the row filed where it was and restore returns it in
    // place, so a demotion waved through here would come back as an illegal
    // pairing the moment the child is restored — with no write left to catch it.
    const project = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
    const child = createTaskCore(ctx.db, { title: 'c', parentId: project.id }, ctx.alex);
    deleteTaskCore(ctx.db, child.id, ctx.alex);
    expect(() => updateTaskCore(ctx.db, project.id, { kind: 'task' }, ctx.alex)).toThrow(
      /would no longer fit under it/,
    );
    // Demoting to an epic is fine — a task fits under an epic — but only once
    // the project is itself filed under a project.
    const outer = createTaskCore(ctx.db, { title: 'outer', kind: 'project' }, ctx.alex);
    const demoted = updateTaskCore(
      ctx.db,
      project.id,
      { kind: 'epic', parentId: outer.id },
      ctx.alex,
    );
    expect(demoted.kind).toBe('epic');
  });

  test('a childless demotion to task is allowed', () => {
    const project = createTaskCore(ctx.db, { title: 'never mind', kind: 'project' }, ctx.alex);
    expect(updateTaskCore(ctx.db, project.id, { kind: 'task' }, ctx.alex).kind).toBe('task');
  });

  test('clone carries the level of every row in the subtree', () => {
    const project = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'e', kind: 'epic', parentId: project.id }, ctx.alex);
    const cloned = cloneTaskCore(ctx.db, project.id, ctx.alex);
    expect(cloned.tasks.map((t) => t.kind).sort()).toEqual(['epic', 'project']);
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

  test('reopen clears completed_at and lands in todo; reopening a live task is a no-op', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    completeTaskCore(ctx.db, t.id, ctx.alex);
    const reopened = reopenTaskCore(ctx.db, t.id, ctx.alex);
    expect(reopened.status).toBe('todo');
    expect(reopened.completedAt).toBeNull();

    const second = reopenTaskCore(ctx.db, t.id, ctx.elisa);
    expect(second.updatedBy).toBe(ctx.alex.userId); // no-op
  });

  test('complete finishes a task from every unfinished lane', () => {
    for (const from of ['todo', 'doing', 'blocked'] as const) {
      const t = createTaskCore(ctx.db, { title: from }, ctx.alex);
      setTaskStatusCore(ctx.db, t.id, from, ctx.alex);
      const done = completeTaskCore(ctx.db, t.id, ctx.alex);
      expect(done.status).toBe('done');
      expect(done.completedAt).not.toBeNull();
    }
  });

  test('reopen from a lane that is not done is a no-op, not a reset to todo', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    setTaskStatusCore(ctx.db, t.id, 'blocked', ctx.alex);
    const same = reopenTaskCore(ctx.db, t.id, ctx.elisa);
    expect(same.status).toBe('blocked');
    // No write happened, so the row still belongs to whoever last moved it.
    expect(same.updatedBy).toBe(ctx.alex.userId);
  });

  test('complete/reopen 404 when task is in trash', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    deleteTaskCore(ctx.db, t.id, ctx.alex);
    expect(() => completeTaskCore(ctx.db, t.id, ctx.alex)).toThrow(/not found or in trash/);
    expect(() => reopenTaskCore(ctx.db, t.id, ctx.alex)).toThrow(/not found or in trash/);
  });
});

describe('setTaskStatus', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('reaches every lane from every lane', () => {
    const lanes = ['todo', 'doing', 'blocked', 'done'] as const;
    for (const from of lanes) {
      for (const to of lanes) {
        const t = createTaskCore(ctx.db, { title: `${from}->${to}` }, ctx.alex);
        setTaskStatusCore(ctx.db, t.id, from, ctx.alex);
        const moved = setTaskStatusCore(ctx.db, t.id, to, ctx.alex);
        expect(moved.status).toBe(to);
        // The tie the storage CHECK enforces, checked on every landing.
        expect(moved.completedAt === null).toBe(to !== 'done');
      }
    }
  });

  test('moving a card to the lane it is already in is a no-op', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    const first = setTaskStatusCore(ctx.db, t.id, 'doing', ctx.alex);
    const second = setTaskStatusCore(ctx.db, t.id, 'doing', ctx.elisa);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.updatedBy).toBe(ctx.alex.userId);
  });

  test('a trashed task cannot be moved between lanes', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    deleteTaskCore(ctx.db, t.id, ctx.alex);
    expect(() => setTaskStatusCore(ctx.db, t.id, 'doing', ctx.alex)).toThrow(
      /not found or in trash/,
    );
  });

  test('restore returns a card to todo, not to the lane it was binned from', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    setTaskStatusCore(ctx.db, t.id, 'blocked', ctx.alex);
    deleteTaskCore(ctx.db, t.id, ctx.alex);
    expect(restoreTaskCore(ctx.db, t.id, ctx.alex).status).toBe('todo');
  });
});

describe('delete / restore', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('delete soft-deletes; restore brings back as todo', () => {
    const t = createTaskCore(ctx.db, { title: 'x' }, ctx.alex);
    completeTaskCore(ctx.db, t.id, ctx.alex);
    const trashed = deleteTaskCore(ctx.db, t.id, ctx.elisa);
    expect(trashed.deletedAt).not.toBeNull();

    const restored = restoreTaskCore(ctx.db, t.id, ctx.alex);
    expect(restored.deletedAt).toBeNull();
    expect(restored.status).toBe('todo');
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
    const p = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
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
    const shop = createTaskCore(ctx.db, { title: 'shop', kind: 'project' }, ctx.alex);
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
    const p = createTaskCore(ctx.db, { title: 'project', kind: 'project' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'child', parentId: p.id }, ctx.alex);
    const titles = listTasksCore(ctx.db, { inbox: true }, ctx.alex).map((t) => t.title).sort();
    expect(titles).toEqual(['in-1', 'project']);
  });

  test('kind filter narrows to one level', () => {
    const project = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'e', kind: 'epic', parentId: project.id }, ctx.alex);
    createTaskCore(ctx.db, { title: 't' }, ctx.alex);
    expect(listTasksCore(ctx.db, { kind: 'project' }, ctx.alex).map((t) => t.title)).toEqual(['p']);
    expect(listTasksCore(ctx.db, { kind: 'epic' }, ctx.alex).map((t) => t.title)).toEqual(['e']);
    expect(listTasksCore(ctx.db, { kind: 'task' }, ctx.alex).map((t) => t.title)).toEqual(['t']);
  });

  test('parentId filter narrows to a parent; absence returns root + children', () => {
    const p = createTaskCore(ctx.db, { title: 'project', kind: 'project' }, ctx.alex);
    const c = createTaskCore(ctx.db, { title: 'child', parentId: p.id }, ctx.alex);
    expect(listTasksCore(ctx.db, { parentId: p.id }, ctx.alex).map((t) => t.id)).toEqual([c.id]);
    expect(listTasksCore(ctx.db, {}, ctx.alex).map((t) => t.id).sort()).toEqual(
      [p.id, c.id].sort(),
    );
  });

  test('status filter narrows by status', () => {
    const open = createTaskCore(ctx.db, { title: 'open' }, ctx.alex);
    const done = createTaskCore(ctx.db, { title: 'done' }, ctx.alex);
    completeTaskCore(ctx.db, done.id, ctx.alex);
    expect(listTasksCore(ctx.db, { status: 'todo' }, ctx.alex).map((t) => t.id)).toEqual([
      open.id,
    ]);
    expect(listTasksCore(ctx.db, { status: 'done' }, ctx.alex).map((t) => t.id)).toEqual([
      done.id,
    ]);
  });

  test('today keeps every unfinished lane and drops only the finished', () => {
    const kept: number[] = [];
    for (const status of ['todo', 'doing', 'blocked'] as const) {
      const t = createTaskCore(ctx.db, { title: status }, ctx.alex);
      setTaskStatusCore(ctx.db, t.id, status, ctx.alex);
      kept.push(t.id);
    }
    const finished = createTaskCore(ctx.db, { title: 'finished' }, ctx.alex);
    completeTaskCore(ctx.db, finished.id, ctx.alex);

    expect(listTasksCore(ctx.db, { today: true }, ctx.alex).map((t) => t.id).sort()).toEqual(
      [...kept].sort(),
    );
  });

  test('dueBefore filter excludes tasks dated on or after the cutoff', () => {
    const early = createTaskCore(ctx.db, { title: 'early', dueAt: '2026-01-01' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'late', dueAt: '2026-12-31' }, ctx.alex);
    expect(
      listTasksCore(ctx.db, { dueBefore: '2026-06-01' }, ctx.alex).map((t) => t.id),
    ).toEqual([early.id]);
  });

  test('dueBefore rejects an invalid ISO value', () => {
    expect(() => listTasksCore(ctx.db, { dueBefore: 'tomorrow' }, ctx.alex)).toThrow(
      /due_before/,
    );
  });

  test('deferAfter filter excludes tasks deferred at or before the cutoff', () => {
    createTaskCore(ctx.db, { title: 'past', deferUntil: '2026-01-01' }, ctx.alex);
    const future = createTaskCore(
      ctx.db,
      { title: 'future', deferUntil: '2026-12-31' },
      ctx.alex,
    );
    expect(
      listTasksCore(ctx.db, { deferAfter: '2026-06-01' }, ctx.alex).map((t) => t.id),
    ).toEqual([future.id]);
  });

  test('deferAfter rejects an invalid ISO value', () => {
    expect(() => listTasksCore(ctx.db, { deferAfter: 'later' }, ctx.alex)).toThrow(
      /defer_after/,
    );
  });

  test('q filter matches by substring of the title', () => {
    const milk = createTaskCore(ctx.db, { title: 'buy milk' }, ctx.alex);
    createTaskCore(ctx.db, { title: 'water the plants' }, ctx.alex);
    expect(listTasksCore(ctx.db, { q: 'milk' }, ctx.alex).map((t) => t.id)).toEqual([milk.id]);
  });

  test('today filter accepts an explicit todayCutoff and rejects an invalid one', () => {
    const t = createTaskCore(
      ctx.db,
      { title: 'past', deferUntil: '2020-01-01T00:00:00Z' },
      ctx.alex,
    );
    expect(
      listTasksCore(
        ctx.db,
        { today: true, todayCutoff: '2026-05-19T10:00:00Z' },
        ctx.alex,
      ).map((row) => row.id),
    ).toEqual([t.id]);
    expect(() =>
      listTasksCore(ctx.db, { today: true, todayCutoff: 'whenever' }, ctx.alex),
    ).toThrow(/today_cutoff/);
  });
});

describe('getTaskCore', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('returns task + children (children excludes trashed)', () => {
    const p = createTaskCore(ctx.db, { title: 'p', kind: 'project' }, ctx.alex);
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
