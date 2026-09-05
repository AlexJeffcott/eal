import type { DatabaseClient } from '../client.ts';

/** A source of "now" as a SQLite datetime string — `YYYY-MM-DD HH:MM:SS`, UTC. */
export type Clock = () => string;

/**
 * The default clock: the real wall clock, formatted exactly as SQLite's
 * `datetime('now')` so stored timestamps are indistinguishable from rows the
 * database defaulted. Tests inject their own clock to advance time across an
 * insert/update without a real sleep.
 */
export const systemClock: Clock = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/**
 * The three fixed levels a task can sit at. Storage is a column on `tasks`,
 * not a separate table — see db/schema.ts for why. The rule about which kind
 * may sit under which is application-level (handlers/tasks.shared.ts); the
 * column's own CHECK only bounds the vocabulary.
 */
export type TaskKind = 'project' | 'epic' | 'task';

/**
 * The workflow axis, orthogonal to the level axis above: a project and a task
 * each have one of these. `blocked` is deliberately distinct from `doing` —
 * "started and moving" and "started and stuck waiting on someone" are the two
 * states the household kept confusing while everything read 'open'.
 *
 * `defer_until` is NOT merged into this. Defer is time-based and clears itself;
 * blocked is event-based and needs a person. Two questions, two fields.
 *
 * The column's own CHECK bounds the vocabulary, and a table-level CHECK ties
 * `done` to `completed_at`. Which transitions are legal is application-level
 * (handlers/tasks.shared.ts) and modelled in specs/tasks-status-machine.ts.
 */
export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/** The three states a task is in while there is still work in it. */
export const LIVE_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked'];

export interface TaskRow {
  id: number;
  parent_id: number | null;
  title: string;
  notes: string;
  status: TaskStatus;
  kind: TaskKind;
  defer_until: string | null;
  due_at: string | null;
  created_by: number;
  assigned_to: number | null;
  updated_by: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  position: number;
}

export interface InsertTaskInput {
  parentId: number | null;
  title: string;
  notes: string;
  kind: TaskKind;
  deferUntil: string | null;
  dueAt: string | null;
  createdBy: number;
  assignedTo: number | null;
  position: number;
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string;
  kind?: TaskKind;
  assignedTo?: number | null;
  parentId?: number | null;
  deferUntil?: string | null;
  dueAt?: string | null;
  position?: number;
  updatedBy: number;
}

export interface ListFilter {
  parentId?: number | null | 'any';
  kind?: TaskKind;
  assignedTo?: number | null | 'any';
  createdBy?: number;
  status?: TaskStatus;
  /**
   * Everything still carrying work — the three live states. Not expressible as
   * `status`, which is one equality, and the Today view needs all three: a task
   * you have started, or one you are stuck on, is still on today's list.
   */
  unfinished?: boolean;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  defaultExcludeDeleted?: boolean;
  dueBefore?: string;
  deferAfter?: string;
  todayCutoff?: string;
  inbox?: boolean;
  q?: string;
}

export interface TasksRepo {
  insert(input: InsertTaskInput): TaskRow;
  findById(id: number, opts?: { includeDeleted?: boolean }): TaskRow | null;
  list(filter: ListFilter): TaskRow[];
  /** Recursive descendants (excludes the root), ordered by depth ASC then position ASC. */
  descendants(id: number, opts?: { includeDeleted?: boolean }): TaskRow[];
  /** True if `candidateAncestor` is the same as `id` or any of its ancestors. */
  wouldCycle(id: number, candidateAncestor: number): boolean;
  update(id: number, input: UpdateTaskInput): TaskRow | null;
  setStatus(id: number, input: { status: TaskStatus; updatedBy: number }): TaskRow | null;
  softDelete(id: number, input: { updatedBy: number }): TaskRow | null;
  restore(id: number, input: { updatedBy: number }): TaskRow | null;
  /** Atomic clone of a task + every (non-deleted) descendant. Returns the cloned subtree. */
  cloneSubtree(rootId: number, input: { createdBy: number }): TaskRow[];
  nextSiblingPosition(parentId: number | null): number;
}

const COLS =
  'id, parent_id, title, notes, status, kind, defer_until, due_at, created_by, assigned_to, updated_by, created_at, updated_at, completed_at, deleted_at, position';

// Same list, prefixed with the `tasks.` alias for queries that join recursive
// CTEs (which themselves expose a column named `id`).
const T_COLS =
  'tasks.id, tasks.parent_id, tasks.title, tasks.notes, tasks.status, tasks.kind, tasks.defer_until, tasks.due_at, tasks.created_by, tasks.assigned_to, tasks.updated_by, tasks.created_at, tasks.updated_at, tasks.completed_at, tasks.deleted_at, tasks.position';

export function createTasksRepo(db: DatabaseClient, clock: Clock = systemClock): TasksRepo {
  const insertStmt = db.prepare<
    TaskRow,
    [
      number | null,
      string,
      string,
      TaskKind,
      string | null,
      string | null,
      number,
      number | null,
      number,
      number,
      string,
      string,
    ]
  >(
    `INSERT INTO tasks
       (parent_id, title, notes, status, kind, defer_until, due_at, created_by, assigned_to, updated_by, position, created_at, updated_at)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${COLS}`,
  );

  const findByIdStmt = db.prepare<TaskRow, [number]>(`SELECT ${COLS} FROM tasks WHERE id = ?`);
  const findLiveByIdStmt = db.prepare<TaskRow, [number]>(
    `SELECT ${COLS} FROM tasks WHERE id = ? AND deleted_at IS NULL`,
  );

  const nextSiblingPositionStmtRoot = db.prepare<{ next: number }, []>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE parent_id IS NULL`,
  );
  const nextSiblingPositionStmtChild = db.prepare<{ next: number }, [number]>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE parent_id = ?`,
  );

  // Two statements, not four: the storage CHECK ties `done` to a non-NULL
  // `completed_at` and every other state to a NULL one, so the completion
  // timestamp — not the status name — is what splits the write. The live
  // statement takes the status as a parameter because all three clear the
  // timestamp the same way.
  const setStatusLiveStmt = db.prepare<TaskRow, [TaskStatus, number, string, number]>(
    `UPDATE tasks
        SET status = ?,
            completed_at = NULL,
            updated_by = ?,
            updated_at = ?
      WHERE id = ?
        AND deleted_at IS NULL
      RETURNING ${COLS}`,
  );
  const setStatusDoneStmt = db.prepare<TaskRow, [string, number, string, number]>(
    `UPDATE tasks
        SET status = 'done',
            completed_at = ?,
            updated_by = ?,
            updated_at = ?
      WHERE id = ?
        AND deleted_at IS NULL
      RETURNING ${COLS}`,
  );
  const softDeleteStmt = db.prepare<TaskRow, [string, number, string, number]>(
    `UPDATE tasks
        SET deleted_at = ?,
            updated_by = ?,
            updated_at = ?
      WHERE id = ?
        AND deleted_at IS NULL
      RETURNING ${COLS}`,
  );
  const restoreStmt = db.prepare<TaskRow, [number, string, number]>(
    `UPDATE tasks
        SET deleted_at = NULL,
            status = 'todo',
            completed_at = NULL,
            updated_by = ?,
            updated_at = ?
      WHERE id = ?
        AND deleted_at IS NOT NULL
      RETURNING ${COLS}`,
  );

  // Cycle check: walk ancestors of `candidateAncestor`; if we visit `id`, a
  // move that re-parents `id` underneath `candidateAncestor` would loop.
  // The LIMIT 1000 is a hard safety stop in case of pre-existing data corruption.
  const cycleStmt = db.prepare<{ anc_id: number }, [number, number]>(
    `WITH RECURSIVE ancestors(anc_id, anc_parent) AS (
        SELECT t.id, t.parent_id FROM tasks t WHERE t.id = ?
        UNION ALL
        SELECT t.id, t.parent_id
          FROM tasks t
          JOIN ancestors a ON t.id = a.anc_parent
         LIMIT 1000
      )
      SELECT anc_id FROM ancestors WHERE anc_id = ?`,
  );

  return {
    insert(input): TaskRow {
      const ts = clock();
      const row = insertStmt.get(
        input.parentId,
        input.title,
        input.notes,
        input.kind,
        input.deferUntil,
        input.dueAt,
        input.createdBy,
        input.assignedTo,
        input.createdBy, // updated_by mirrors created_by at insert time
        input.position,
        ts, // created_at
        ts, // updated_at
      );
      if (!row) throw new Error('tasks.insert: RETURNING gave no row');
      return row;
    },

    findById(id, opts): TaskRow | null {
      const stmt = opts?.includeDeleted ? findByIdStmt : findLiveByIdStmt;
      return stmt.get(id) ?? null;
    },

    nextSiblingPosition(parentId): number {
      if (parentId === null) {
        return nextSiblingPositionStmtRoot.get()?.next ?? 0;
      }
      return nextSiblingPositionStmtChild.get(parentId)?.next ?? 0;
    },

    list(filter): TaskRow[] {
      const wheres: string[] = [];
      const params: Array<string | number | null> = [];

      if (filter.deletedOnly) {
        wheres.push('deleted_at IS NOT NULL');
      } else if (filter.includeDeleted !== true) {
        wheres.push('deleted_at IS NULL');
      }

      if (filter.parentId !== undefined && filter.parentId !== 'any') {
        if (filter.parentId === null) {
          wheres.push('parent_id IS NULL');
        } else {
          wheres.push('parent_id = ?');
          params.push(filter.parentId);
        }
      }

      if (filter.kind !== undefined) {
        wheres.push('kind = ?');
        params.push(filter.kind);
      }

      if (filter.assignedTo !== undefined && filter.assignedTo !== 'any') {
        if (filter.assignedTo === null) {
          wheres.push('assigned_to IS NULL');
        } else {
          wheres.push('assigned_to = ?');
          params.push(filter.assignedTo);
        }
      }

      if (filter.createdBy !== undefined) {
        wheres.push('created_by = ?');
        params.push(filter.createdBy);
      }

      if (filter.status !== undefined) {
        wheres.push('status = ?');
        params.push(filter.status);
      }

      // Everything not finished. Written as the negation rather than an
      // `IN ('todo','doing','blocked')` list so a fifth live state added later
      // is included by default instead of silently dropping out of Today.
      if (filter.unfinished === true) {
        wheres.push("status <> 'done'");
      }

      if (filter.dueBefore !== undefined) {
        wheres.push('due_at IS NOT NULL AND due_at < ?');
        params.push(filter.dueBefore);
      }

      if (filter.deferAfter !== undefined) {
        wheres.push('defer_until IS NOT NULL AND defer_until > ?');
        params.push(filter.deferAfter);
      }

      if (filter.todayCutoff !== undefined) {
        // Visible today: deferred until ≤ cutoff OR not deferred at all.
        wheres.push('(defer_until IS NULL OR defer_until <= ?)');
        params.push(filter.todayCutoff);
      }

      if (filter.inbox === true) {
        wheres.push('parent_id IS NULL');
        wheres.push('assigned_to IS NULL');
        wheres.push('defer_until IS NULL');
      }

      if (filter.q !== undefined && filter.q.trim().length > 0) {
        wheres.push('(title LIKE ? OR notes LIKE ?)');
        const needle = `%${filter.q.trim()}%`;
        params.push(needle, needle);
      }

      const sql =
        `SELECT ${COLS} FROM tasks` +
        (wheres.length > 0 ? ` WHERE ${wheres.join(' AND ')}` : '') +
        ` ORDER BY position ASC, id ASC`;
      return db.prepare<TaskRow, typeof params>(sql).all(...params);
    },

    descendants(id, opts): TaskRow[] {
      const cond = opts?.includeDeleted ? '' : 'AND t.deleted_at IS NULL';
      const sql = `
        WITH RECURSIVE sub(sub_id, depth) AS (
          SELECT id, 0 FROM tasks WHERE id = ?
          UNION ALL
          SELECT t.id, sub.depth + 1
            FROM tasks t
            JOIN sub ON t.parent_id = sub.sub_id
           WHERE 1=1 ${cond}
           LIMIT 10000
        )
        SELECT ${T_COLS}
          FROM tasks
          JOIN sub ON sub.sub_id = tasks.id
         WHERE sub.depth > 0
         ORDER BY sub.depth ASC, tasks.position ASC, tasks.id ASC`;
      return db.prepare<TaskRow, [number]>(sql).all(id);
    },

    wouldCycle(id, candidateAncestor): boolean {
      if (id === candidateAncestor) return true;
      return cycleStmt.get(candidateAncestor, id) !== null;
    },

    update(id, input): TaskRow | null {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (input.title !== undefined) {
        sets.push('title = ?');
        params.push(input.title);
      }
      if (input.notes !== undefined) {
        sets.push('notes = ?');
        params.push(input.notes);
      }
      if (input.kind !== undefined) {
        sets.push('kind = ?');
        params.push(input.kind);
      }
      if (input.assignedTo !== undefined) {
        sets.push('assigned_to = ?');
        params.push(input.assignedTo);
      }
      if (input.parentId !== undefined) {
        sets.push('parent_id = ?');
        params.push(input.parentId);
      }
      if (input.deferUntil !== undefined) {
        sets.push('defer_until = ?');
        params.push(input.deferUntil);
      }
      if (input.dueAt !== undefined) {
        sets.push('due_at = ?');
        params.push(input.dueAt);
      }
      if (input.position !== undefined) {
        sets.push('position = ?');
        params.push(input.position);
      }
      sets.push('updated_at = ?');
      params.push(clock());
      sets.push('updated_by = ?');
      params.push(input.updatedBy);
      params.push(id);

      const sql = `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL RETURNING ${COLS}`;
      return db.prepare<TaskRow, typeof params>(sql).get(...params) ?? null;
    },

    setStatus(id, input): TaskRow | null {
      const ts = clock();
      if (input.status === 'done') {
        return setStatusDoneStmt.get(ts, input.updatedBy, ts, id) ?? null;
      }
      return setStatusLiveStmt.get(input.status, input.updatedBy, ts, id) ?? null;
    },

    softDelete(id, input): TaskRow | null {
      const ts = clock();
      return softDeleteStmt.get(ts, input.updatedBy, ts, id) ?? null;
    },

    restore(id, input): TaskRow | null {
      const ts = clock();
      return restoreStmt.get(input.updatedBy, ts, id) ?? null;
    },

    cloneSubtree(rootId, input): TaskRow[] {
      const root = findLiveByIdStmt.get(rootId);
      if (!root) return [];

      const clone = db.transaction((): TaskRow[] => {
        const oldToNew = new Map<number, number>();
        const cloned: TaskRow[] = [];
        // One timestamp for the whole atomic clone.
        const ts = clock();

        // 1. Clone root.
        const newRoot = insertStmt.get(
          root.parent_id,
          root.title,
          root.notes,
          root.kind,
          root.defer_until,
          root.due_at,
          input.createdBy,
          root.assigned_to,
          input.createdBy,
          root.position,
          ts,
          ts,
        );
        if (!newRoot) throw new Error('tasks.cloneSubtree: root insert returned no row');
        oldToNew.set(root.id, newRoot.id);
        cloned.push(newRoot);

        // 2. Clone descendants in BFS order so each child's new parent_id is known.
        const descRows = db
          .prepare<TaskRow, [number]>(
            `WITH RECURSIVE sub(sub_id, depth) AS (
                SELECT id, 0 FROM tasks WHERE id = ?
                UNION ALL
                SELECT t.id, sub.depth + 1
                  FROM tasks t
                  JOIN sub ON t.parent_id = sub.sub_id
                 WHERE t.deleted_at IS NULL
                 LIMIT 10000
             )
             SELECT ${T_COLS}
               FROM tasks
               JOIN sub ON sub.sub_id = tasks.id
              WHERE sub.depth > 0
              ORDER BY sub.depth ASC, tasks.position ASC, tasks.id ASC`,
          )
          .all(root.id);

        for (const child of descRows) {
          const newParent = child.parent_id !== null ? oldToNew.get(child.parent_id) : null;
          if (child.parent_id !== null && newParent === undefined) {
            // Parent was not in the cloned set (e.g. soft-deleted) — skip the
            // orphan rather than reparenting it under root, which would
            // surprise the caller.
            continue;
          }
          const newChild = insertStmt.get(
            newParent ?? null,
            child.title,
            child.notes,
            child.kind,
            child.defer_until,
            child.due_at,
            input.createdBy,
            child.assigned_to,
            input.createdBy,
            child.position,
            ts,
            ts,
          );
          if (!newChild) throw new Error('tasks.cloneSubtree: child insert returned no row');
          oldToNew.set(child.id, newChild.id);
          cloned.push(newChild);
        }

        return cloned;
      });

      return clone();
    },
  };
}
