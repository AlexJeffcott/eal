import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createUsersRepo } from './users.ts';
import { createTasksRepo, type TasksRepo } from './tasks.ts';

interface SetupContext {
  db: DatabaseClient;
  tasks: TasksRepo;
  /** The repo's clock — mutate `now` to advance time without a real sleep. */
  clock: { now: string };
  alex: number;
  elisa: number;
  leo: number;
}

function setup(): SetupContext {
  const db = createDb(':memory:');
  applySchema(db);
  const users = createUsersRepo(db);
  const alex = users.insert({ displayName: 'alex' });
  const elisa = users.insert({ displayName: 'elisa' });
  const leo = users.insert({ displayName: 'leo' });
  const clock = { now: '2026-01-01 00:00:00' };
  return {
    db,
    tasks: createTasksRepo(db, () => clock.now),
    clock,
    alex: alex.id,
    elisa: elisa.id,
    leo: leo.id,
  };
}

function defaults(overrides: Partial<Parameters<TasksRepo['insert']>[0]> & { createdBy: number }): Parameters<TasksRepo['insert']>[0] {
  return {
    parentId: null,
    title: 'untitled',
    notes: '',
    kind: 'task',
    deferUntil: null,
    dueAt: null,
    assignedTo: null,
    position: 0,
    sequential: false,
    clientId: null,
    ...overrides,
  };
}

describe('tasks repo', () => {
  let ctx: SetupContext;

  beforeEach(() => {
    ctx = setup();
  });

  describe('insert', () => {
    test('returns a fully-populated row with status="todo" and no completed_at', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'buy milk' }));
      expect(row.id).toBeGreaterThan(0);
      expect(row.title).toBe('buy milk');
      expect(row.status).toBe('todo');
      expect(row.completed_at).toBeNull();
      expect(row.deleted_at).toBeNull();
      expect(row.created_by).toBe(ctx.alex);
      expect(row.updated_by).toBe(ctx.alex);
      expect(row.position).toBe(0);
    });

    test('inserting under a deleted parent still works (callers gate this — repo does not)', () => {
      // The repo is dumb about deletion of the parent; the application layer
      // enforces "no parenting under deleted." This test documents that
      // contract so a future change at the repo layer is intentional.
      const parent = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'p' }));
      ctx.tasks.softDelete(parent.id, { updatedBy: ctx.alex });
      const child = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'c', parentId: parent.id }));
      expect(child.parent_id).toBe(parent.id);
    });
  });

  describe('kind', () => {
    test('stores the level it is given and reads it back', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, kind: 'project' }));
      expect(row.kind).toBe('project');
      expect(ctx.tasks.findById(row.id)?.kind).toBe('project');
    });

    test('update moves the level — one UPDATE, same id', () => {
      // The whole reason the level is a column: promotion keeps the row, so
      // every reference to it (an assistant’s `#12`, a pending broadcast)
      // stays valid. A projects table would make this a delete and an insert.
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      const promoted = ctx.tasks.update(row.id, { kind: 'project', updatedBy: ctx.alex });
      expect(promoted?.id).toBe(row.id);
      expect(promoted?.kind).toBe('project');
    });

    test('list filters by level', () => {
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'p', kind: 'project' }));
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 't' }));
      expect(ctx.tasks.list({ kind: 'project' }).map((r) => r.title)).toEqual(['p']);
      expect(ctx.tasks.list({ kind: 'task' }).map((r) => r.title)).toEqual(['t']);
    });

    test('the repo does not police the pairing — that is the handler’s job', () => {
      // Same contract as the deleted-parent case above: the repo is dumb, and
      // handlers/tasks.shared.ts:levelViolation is the only place the rule
      // lives. Documented here so a future CHECK is a deliberate change.
      const plain = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'plain' }));
      const nested = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, title: 'nested', parentId: plain.id }),
      );
      expect(nested.parent_id).toBe(plain.id);
    });
  });

  describe('sequential', () => {
    test('defaults off, stores what it is given, and reads back as 0/1', () => {
      // The column is an INTEGER because SQLite has no boolean; the repo is the
      // layer that speaks 0/1 and handlers/tasks.shared.ts:toTask is the one
      // that turns it into the boolean the wire carries.
      const parallel = ctx.tasks.insert(defaults({ createdBy: ctx.alex, kind: 'project' }));
      expect(parallel.sequential).toBe(0);
      const stepwise = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, kind: 'project', sequential: true }),
      );
      expect(stepwise.sequential).toBe(1);
      expect(ctx.tasks.findById(stepwise.id)?.sequential).toBe(1);
    });

    test('update flips it in both directions, and leaves it alone when unset', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, kind: 'project' }));
      expect(ctx.tasks.update(row.id, { sequential: true, updatedBy: ctx.alex })?.sequential).toBe(1);
      // No `sequential` key at all: the flag must survive an unrelated edit,
      // or a title change would quietly reorder someone's project.
      expect(ctx.tasks.update(row.id, { title: 'renamed', updatedBy: ctx.alex })?.sequential).toBe(1);
      expect(ctx.tasks.update(row.id, { sequential: false, updatedBy: ctx.alex })?.sequential).toBe(0);
    });

    test('cloneSubtree carries the flag on the root and on every descendant', () => {
      // A cloned project that came back parallel would hand out all its steps
      // at once, which is the opposite of what was copied.
      const p = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, title: 'reno', kind: 'project', sequential: true }),
      );
      const e = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, title: 'tiling', kind: 'epic', parentId: p.id, sequential: true }),
      );
      ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, title: 'buy tiles', parentId: e.id }),
      );
      const clone = ctx.tasks.cloneSubtree(p.id, { createdBy: ctx.alex });
      expect(clone.map((r) => [r.title, r.sequential])).toEqual([
        ['reno', 1],
        ['tiling', 1],
        ['buy tiles', 0],
      ]);
    });
  });

  describe('findById', () => {
    test('returns null for unknown ids', () => {
      expect(ctx.tasks.findById(999)).toBeNull();
    });

    test('omits soft-deleted by default; includes them with includeDeleted', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      ctx.tasks.softDelete(row.id, { updatedBy: ctx.alex });
      expect(ctx.tasks.findById(row.id)).toBeNull();
      expect(ctx.tasks.findById(row.id, { includeDeleted: true })?.id).toBe(row.id);
    });
  });

  describe('CHECK invariant: status ⇔ completed_at', () => {
    test('setStatus("done") sets completed_at; reopen clears it', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));

      const done = ctx.tasks.setStatus(row.id, { status: 'done', updatedBy: ctx.elisa });
      expect(done?.status).toBe('done');
      expect(done?.completed_at).not.toBeNull();
      expect(done?.updated_by).toBe(ctx.elisa);

      const reopened = ctx.tasks.setStatus(row.id, { status: 'todo', updatedBy: ctx.leo });
      expect(reopened?.status).toBe('todo');
      expect(reopened?.completed_at).toBeNull();
      expect(reopened?.updated_by).toBe(ctx.leo);
    });

    test('setStatus reaches each live lane and clears completed_at on the way out of done', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      ctx.tasks.setStatus(row.id, { status: 'done', updatedBy: ctx.alex });
      for (const status of ['doing', 'blocked', 'todo'] as const) {
        const moved = ctx.tasks.setStatus(row.id, { status, updatedBy: ctx.elisa });
        expect(moved?.status).toBe(status);
        expect(moved?.completed_at).toBeNull();
      }
    });

    test('cannot setStatus on a soft-deleted task (returns null)', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      ctx.tasks.softDelete(row.id, { updatedBy: ctx.alex });
      expect(ctx.tasks.setStatus(row.id, { status: 'done', updatedBy: ctx.alex })).toBeNull();
    });
  });

  describe('soft delete / restore', () => {
    test('soft delete sets deleted_at, hides from default list', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      const deleted = ctx.tasks.softDelete(row.id, { updatedBy: ctx.elisa });
      expect(deleted?.deleted_at).not.toBeNull();
      expect(deleted?.updated_by).toBe(ctx.elisa);
      expect(ctx.tasks.list({})).toHaveLength(0);
      expect(ctx.tasks.list({ deletedOnly: true })).toHaveLength(1);
    });

    test('restore: undeletes AND forces status back to todo (predictable resurrection)', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      ctx.tasks.setStatus(row.id, { status: 'done', updatedBy: ctx.alex });
      ctx.tasks.softDelete(row.id, { updatedBy: ctx.alex });

      const restored = ctx.tasks.restore(row.id, { updatedBy: ctx.elisa });
      expect(restored?.deleted_at).toBeNull();
      expect(restored?.status).toBe('todo');
      expect(restored?.completed_at).toBeNull();
      expect(restored?.updated_by).toBe(ctx.elisa);
    });

    test('soft delete on already-deleted is a no-op (returns null)', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      ctx.tasks.softDelete(row.id, { updatedBy: ctx.alex });
      expect(ctx.tasks.softDelete(row.id, { updatedBy: ctx.alex })).toBeNull();
    });

    test('restore on a live task is a no-op (returns null)', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      expect(ctx.tasks.restore(row.id, { updatedBy: ctx.alex })).toBeNull();
    });
  });

  describe('cascade on hard delete of parent', () => {
    test('ON DELETE CASCADE removes children when parent row truly leaves the table', () => {
      const parent = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'p' }));
      const child = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'c', parentId: parent.id }));
      // Application-level delete is SOFT, but a true DELETE (purge / test) must cascade.
      ctx.db.prepare('DELETE FROM tasks WHERE id = ?').run(parent.id);
      expect(ctx.tasks.findById(child.id, { includeDeleted: true })).toBeNull();
    });
  });

  describe('list filters', () => {
    function seed(): { p: number; c1: number; c2: number; mine: number } {
      const p = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'project' }));
      const c1 = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'child-1', parentId: p.id, assignedTo: ctx.elisa }));
      const c2 = ctx.tasks.insert(defaults({ createdBy: ctx.elisa, title: 'child-2', parentId: p.id }));
      const mine = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'mine-only', assignedTo: ctx.alex }));
      return { p: p.id, c1: c1.id, c2: c2.id, mine: mine.id };
    }

    test('parentId=null returns roots only', () => {
      const ids = seed();
      const roots = ctx.tasks.list({ parentId: null });
      expect(roots.map((r) => r.id).sort()).toEqual([ids.p, ids.mine].sort());
    });

    test('parentId=<id> returns children of that parent in position order', () => {
      const ids = seed();
      const kids = ctx.tasks.list({ parentId: ids.p });
      expect(kids.map((r) => r.id)).toEqual([ids.c1, ids.c2]);
    });

    test('assignedTo filter (number + "any" + null)', () => {
      const ids = seed();
      expect(ctx.tasks.list({ assignedTo: ctx.elisa }).map((r) => r.id)).toEqual([ids.c1]);
      expect(ctx.tasks.list({ assignedTo: ctx.alex }).map((r) => r.id)).toEqual([ids.mine]);
      expect(ctx.tasks.list({ assignedTo: null }).map((r) => r.id).sort()).toEqual([ids.p, ids.c2].sort());
    });

    test('inbox filter requires parent=null AND assigned=null AND defer=null', () => {
      const ids = seed();
      const inbox = ctx.tasks.list({ inbox: true }).map((r) => r.id);
      // p is parent=null but it has children — still counts as inbox per spec
      // (no children criterion); mine is assigned. So only p qualifies.
      expect(inbox).toEqual([ids.p]);
    });

    test('q search hits title and notes, trims and is case-insensitive at LIKE level', () => {
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'Buy MILK', notes: 'whole fat' }));
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'Eggs', notes: 'a dozen' }));
      expect(ctx.tasks.list({ q: '  milk ' }).map((r) => r.title)).toEqual(['Buy MILK']);
      expect(ctx.tasks.list({ q: 'dozen' }).map((r) => r.title)).toEqual(['Eggs']);
      expect(ctx.tasks.list({ q: '' })).toHaveLength(2);
    });

    test('status filter', () => {
      const a = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'a' }));
      const b = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'b' }));
      ctx.tasks.setStatus(b.id, { status: 'done', updatedBy: ctx.alex });
      expect(ctx.tasks.list({ status: 'todo' }).map((r) => r.id)).toEqual([a.id]);
      expect(ctx.tasks.list({ status: 'done' }).map((r) => r.id)).toEqual([b.id]);
    });

    test('unfinished keeps the three live lanes and drops done', () => {
      const ids: number[] = [];
      for (const status of ['todo', 'doing', 'blocked'] as const) {
        const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: status }));
        ctx.tasks.setStatus(row.id, { status, updatedBy: ctx.alex });
        ids.push(row.id);
      }
      const finished = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'finished' }));
      ctx.tasks.setStatus(finished.id, { status: 'done', updatedBy: ctx.alex });

      expect(ctx.tasks.list({ unfinished: true }).map((r) => r.id).sort()).toEqual(
        [...ids].sort(),
      );
      // Off by default: an unset flag must not narrow the list.
      expect(ctx.tasks.list({}).length).toBe(4);
    });

    test('todayCutoff includes undated AND deferred up to the cutoff', () => {
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'no-defer' }));
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'past', deferUntil: '2020-01-01T00:00:00Z' }));
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'future', deferUntil: '2999-01-01T00:00:00Z' }));
      const today = ctx.tasks.list({ todayCutoff: '2026-05-19T23:59:59Z' }).map((r) => r.title).sort();
      expect(today).toEqual(['no-defer', 'past']);
    });
  });

  describe('descendants', () => {
    test('returns the full subtree in BFS order (depth then position) excluding the root', () => {
      const p = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'p' }));
      const a = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'a', parentId: p.id, position: 0 }));
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'b', parentId: p.id, position: 1 }));
      const a1 = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'a1', parentId: a.id }));
      const titles = ctx.tasks.descendants(p.id).map((r) => r.title);
      expect(titles).toEqual(['a', 'b', 'a1']);
      // and confirm a1 is correctly reached
      expect(ctx.tasks.descendants(p.id).find((t) => t.id === a1.id)).toBeDefined();
    });

    test('excludes soft-deleted descendants by default', () => {
      const p = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'p' }));
      const a = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'a', parentId: p.id }));
      ctx.tasks.softDelete(a.id, { updatedBy: ctx.alex });
      expect(ctx.tasks.descendants(p.id)).toHaveLength(0);
      expect(ctx.tasks.descendants(p.id, { includeDeleted: true })).toHaveLength(1);
    });
  });

  describe('wouldCycle', () => {
    test('cycle: parenting a task under itself', () => {
      const a = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      expect(ctx.tasks.wouldCycle(a.id, a.id)).toBe(true);
    });

    test('cycle: parenting an ancestor under its descendant', () => {
      const grand = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'g' }));
      const parent = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'p', parentId: grand.id }));
      const child = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'c', parentId: parent.id }));
      // Moving grand to be a child of child = cycle.
      expect(ctx.tasks.wouldCycle(grand.id, child.id)).toBe(true);
    });

    test('non-cycle: moving across unrelated subtrees', () => {
      const a = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'a' }));
      const b = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'b' }));
      expect(ctx.tasks.wouldCycle(a.id, b.id)).toBe(false);
      expect(ctx.tasks.wouldCycle(b.id, a.id)).toBe(false);
    });
  });

  describe('update', () => {
    test('only listed fields change; updated_at / updated_by always change', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'before' }));
      // Advance the repo clock so the update lands at a distinct timestamp —
      // a controlled clock in place of a real one-second sleep.
      ctx.clock.now = '2026-01-01 00:00:01';
      const updated = ctx.tasks.update(row.id, { title: 'after', updatedBy: ctx.elisa });
      expect(updated?.title).toBe('after');
      expect(updated?.notes).toBe(row.notes);
      expect(updated?.updated_by).toBe(ctx.elisa);
      expect(updated?.updated_at).not.toBe(row.updated_at);
    });

    test('returns null for soft-deleted task (cannot patch)', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      ctx.tasks.softDelete(row.id, { updatedBy: ctx.alex });
      expect(ctx.tasks.update(row.id, { title: 'no', updatedBy: ctx.alex })).toBeNull();
    });

    test('clearing assignedTo with null vs leaving it alone with undefined', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, assignedTo: ctx.elisa }));
      const left = ctx.tasks.update(row.id, { updatedBy: ctx.alex }); // no assignedTo key
      expect(left?.assigned_to).toBe(ctx.elisa);
      const cleared = ctx.tasks.update(row.id, { assignedTo: null, updatedBy: ctx.alex });
      expect(cleared?.assigned_to).toBeNull();
    });
  });

  describe('cloneSubtree', () => {
    test('clones root + all live descendants; new ids; status forced to open', () => {
      const p = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'shop' }));
      const m = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'milk', parentId: p.id }));
      const e = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'eggs', parentId: p.id, position: 1 }));
      ctx.tasks.setStatus(m.id, { status: 'done', updatedBy: ctx.alex });

      const subtree = ctx.tasks.cloneSubtree(p.id, { createdBy: ctx.elisa });
      expect(subtree).toHaveLength(3);
      const titles = subtree.map((r) => r.title).sort();
      expect(titles).toEqual(['eggs', 'milk', 'shop']);
      // All new ids
      expect(subtree.every((r) => r.id !== p.id && r.id !== m.id && r.id !== e.id)).toBe(true);
      // Every clone starts at the top of the workflow axis with no completed_at
      expect(subtree.every((r) => r.status === 'todo')).toBe(true);
      expect(subtree.every((r) => r.completed_at === null)).toBe(true);
      // Created by the new creator
      expect(subtree.every((r) => r.created_by === ctx.elisa)).toBe(true);
      // Root carried its parent reference (which was null)
      const newRoot = subtree.find((r) => r.title === 'shop');
      expect(newRoot?.parent_id).toBeNull();
      // Children point at the new root, not the old one
      const newKids = subtree.filter((r) => r.title !== 'shop');
      expect(newKids.every((r) => r.parent_id === newRoot?.id)).toBe(true);
    });

    test('does NOT clone soft-deleted descendants (orphan filter is intentional)', () => {
      const p = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'p' }));
      const a = ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'a', parentId: p.id }));
      ctx.tasks.softDelete(a.id, { updatedBy: ctx.alex });
      const subtree = ctx.tasks.cloneSubtree(p.id, { createdBy: ctx.alex });
      expect(subtree.map((r) => r.title)).toEqual(['p']);
    });

    test('returns empty when root is soft-deleted', () => {
      const p = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      ctx.tasks.softDelete(p.id, { updatedBy: ctx.alex });
      expect(ctx.tasks.cloneSubtree(p.id, { createdBy: ctx.alex })).toEqual([]);
    });
  });

  describe('the reminder columns', () => {
    test('a new task is unreminded, whatever its deadline', () => {
      const row = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2020-01-01', title: 'long overdue' }),
      );
      expect(row.reminded_at).toBeNull();
    });

    test('markReminded stamps once and refuses a second time', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, dueAt: '2026-01-01' }));
      expect(ctx.tasks.markReminded(row.id, '2026-01-01 09:00:00')).toBe(true);
      expect(ctx.tasks.findById(row.id)?.reminded_at).toBe('2026-01-01 09:00:00');
      // The second call is what a second tick would do. It must change nothing:
      // this is the guard that makes two overlapping scans harmless.
      expect(ctx.tasks.markReminded(row.id, '2026-01-01 09:01:00')).toBe(false);
      expect(ctx.tasks.findById(row.id)?.reminded_at).toBe('2026-01-01 09:00:00');
    });

    test('markReminded will not stamp a trashed task', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, dueAt: '2026-01-01' }));
      ctx.tasks.softDelete(row.id, { updatedBy: ctx.alex });
      expect(ctx.tasks.markReminded(row.id, '2026-01-01 09:00:00')).toBe(false);
    });

    test('markReminded leaves updated_at and updated_by alone', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, dueAt: '2026-01-01' }));
      ctx.clock.now = '2026-06-01 12:00:00';
      ctx.tasks.markReminded(row.id, '2026-06-01 12:00:00');
      const after = ctx.tasks.findById(row.id);
      // The scan is not a person editing the task. Touching these would push
      // every overdue row to the top of a recently-changed ordering at whatever
      // minute it happened to fire.
      expect(after?.updated_at).toBe(row.updated_at);
      expect(after?.updated_by).toBe(row.updated_by);
    });

    test('moving the deadline clears the stamp; re-writing the same one does not', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, dueAt: '2026-01-01' }));
      ctx.tasks.markReminded(row.id, '2026-01-01 09:00:00');

      const same = ctx.tasks.update(row.id, { dueAt: '2026-01-01', updatedBy: ctx.alex });
      expect(same?.reminded_at).toBe('2026-01-01 09:00:00');

      const moved = ctx.tasks.update(row.id, { dueAt: '2026-02-01', updatedBy: ctx.alex });
      expect(moved?.reminded_at).toBeNull();
    });

    test('clearing the deadline clears the stamp, and a null-to-null write does not', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, dueAt: '2026-01-01' }));
      ctx.tasks.markReminded(row.id, '2026-01-01 09:00:00');
      expect(ctx.tasks.update(row.id, { dueAt: null, updatedBy: ctx.alex })?.reminded_at).toBeNull();

      // And the symmetric case: a stamped row with no deadline, written null
      // again, keeps its stamp. `IS` rather than `=` is what makes this work —
      // SQL equality on two NULLs is unknown, which would clear it.
      ctx.tasks.markReminded(row.id, '2026-01-02 09:00:00');
      expect(ctx.tasks.update(row.id, { dueAt: null, updatedBy: ctx.alex })?.reminded_at).toBe(
        '2026-01-02 09:00:00',
      );
    });

    test('an edit that does not touch the deadline leaves the stamp alone', () => {
      const row = ctx.tasks.insert(defaults({ createdBy: ctx.alex, dueAt: '2026-01-01' }));
      ctx.tasks.markReminded(row.id, '2026-01-01 09:00:00');
      const renamed = ctx.tasks.update(row.id, { title: 'renamed', updatedBy: ctx.alex });
      expect(renamed?.reminded_at).toBe('2026-01-01 09:00:00');
    });

    test('a clone starts unreminded — it is a new deadline for a new row', () => {
      const row = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-01-01', title: 'original' }),
      );
      ctx.tasks.markReminded(row.id, '2026-01-01 09:00:00');
      const [clone] = ctx.tasks.cloneSubtree(row.id, { createdBy: ctx.alex });
      expect(clone?.due_at).toBe('2026-01-01');
      expect(clone?.reminded_at).toBeNull();
    });
  });

  describe('list: the reminder scan filters', () => {
    test('dueOnOrBefore includes the boundary instant', () => {
      const at = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-05-19T10:00:00Z', title: 'exactly now' }),
      );
      const later = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-05-19T10:00:01Z', title: 'a second later' }),
      );
      const found = ctx.tasks.list({ dueOnOrBefore: '2026-05-19 10:00:00' }).map((t) => t.id);
      // `dueBefore` would drop the boundary row and push it to the next tick;
      // for a deadline that is an exact instant, that is the wrong side.
      expect(found).toEqual([at.id]);
      expect(found).not.toContain(later.id);
    });

    test('dueOnOrBefore compares through datetime(), not as strings', () => {
      // The three shapes a stored deadline actually takes. Raw string
      // comparison gets two of them wrong: 'T' (0x54) sorts above ' ' (0x20),
      // so any T-form timestamp would read as later than any space-form "now"
      // on the same date, and an offset is not normalised at all.
      const dateOnly = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-05-19', title: 'date only' }),
      );
      const zulu = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-05-19T08:00:00Z', title: 'zulu' }),
      );
      const offset = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-05-19T10:00:00+02:00', title: 'offset' }),
      );
      const notYet = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-05-19T23:00:00Z', title: 'tonight' }),
      );

      // 08:00Z: the date-only deadline (00:00Z), the zulu one, and the offset
      // one (10:00+02:00 is 08:00Z) have all passed. Tonight has not.
      const found = ctx.tasks.list({ dueOnOrBefore: '2026-05-19 08:00:00' }).map((t) => t.id);
      expect(found.sort()).toEqual([dateOnly.id, zulu.id, offset.id].sort());
      expect(found).not.toContain(notYet.id);
    });

    test('dueOnOrBefore never matches a task with no deadline', () => {
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, title: 'someday' }));
      expect(ctx.tasks.list({ dueOnOrBefore: '2099-01-01 00:00:00' })).toEqual([]);
    });

    test('notReminded drops rows the scan has already been round', () => {
      const fresh = ctx.tasks.insert(defaults({ createdBy: ctx.alex, dueAt: '2026-01-01' }));
      const done = ctx.tasks.insert(defaults({ createdBy: ctx.alex, dueAt: '2026-01-01' }));
      ctx.tasks.markReminded(done.id, '2026-01-01 09:00:00');
      expect(ctx.tasks.list({ notReminded: true }).map((t) => t.id)).toEqual([fresh.id]);
    });

    test('the scan predicate — unfinished + due + unreminded — keeps blocked and drops done', () => {
      const todo = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-01-01', title: 'todo' }),
      );
      const doing = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-01-01', title: 'doing' }),
      );
      const blocked = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-01-01', title: 'blocked' }),
      );
      const finished = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-01-01', title: 'done' }),
      );
      const trashed = ctx.tasks.insert(
        defaults({ createdBy: ctx.alex, dueAt: '2026-01-01', title: 'trashed' }),
      );
      ctx.tasks.setStatus(doing.id, { status: 'doing', updatedBy: ctx.alex });
      ctx.tasks.setStatus(blocked.id, { status: 'blocked', updatedBy: ctx.alex });
      ctx.tasks.setStatus(finished.id, { status: 'done', updatedBy: ctx.alex });
      ctx.tasks.softDelete(trashed.id, { updatedBy: ctx.alex });

      const found = ctx.tasks
        .list({ unfinished: true, dueOnOrBefore: '2026-06-01 00:00:00', notReminded: true })
        .map((t) => t.id);
      // Blocked and overdue is the single most useful reminder there is: it is
      // the case where something is waiting on a person and the deadline has
      // now gone past. Excluding it would silence exactly the reminder worth
      // hearing.
      expect(found.sort()).toEqual([todo.id, doing.id, blocked.id].sort());
    });
  });

  describe('nextSiblingPosition', () => {
    test('zero for an empty parent, increments per child', () => {
      const p = ctx.tasks.insert(defaults({ createdBy: ctx.alex }));
      expect(ctx.tasks.nextSiblingPosition(p.id)).toBe(0);
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, parentId: p.id, position: 0 }));
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, parentId: p.id, position: 1 }));
      expect(ctx.tasks.nextSiblingPosition(p.id)).toBe(2);
    });

    test('null parent uses root scope and increments across roots', () => {
      expect(ctx.tasks.nextSiblingPosition(null)).toBe(0);
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, position: 0 }));
      ctx.tasks.insert(defaults({ createdBy: ctx.alex, position: 1 }));
      expect(ctx.tasks.nextSiblingPosition(null)).toBe(2);
    });
  });
});
