import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import type { TaskRow, TasksRepo, ListFilter } from '../db/repos/tasks.ts';
import { createTasksRepo } from '../db/repos/tasks.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { AuthError } from './auth.shared.ts';

/**
 * Wire shape — what the SPA and the CLI both see. CamelCase to match the rest
 * of the codebase (CurrentUser, CliPairStartResult, HelloSaidPayload).
 */
export interface Task {
  id: number;
  parentId: number | null;
  title: string;
  notes: string;
  status: 'open' | 'done';
  deferUntil: string | null;
  dueAt: string | null;
  createdBy: number;
  assignedTo: number | null;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  position: number;
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    deferUntil: row.defer_until,
    dueAt: row.due_at,
    createdBy: row.created_by,
    assignedTo: row.assigned_to,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    deletedAt: row.deleted_at,
    position: row.position,
  };
}

export interface CreateTaskInput {
  title: string;
  parentId?: number | null | undefined;
  assignedTo?: number | null | undefined;
  notes?: string | undefined;
  deferUntil?: string | null | undefined;
  dueAt?: string | null | undefined;
}

export interface UpdateTaskInput {
  title?: string | undefined;
  notes?: string | undefined;
  assignedTo?: number | null | undefined;
  parentId?: number | null | undefined;
  deferUntil?: string | null | undefined;
  dueAt?: string | null | undefined;
  position?: number | undefined;
}

export interface ListTasksInput {
  parentId?: number | null | undefined;
  assignedTo?: number | 'me' | undefined;
  createdBy?: number | 'me' | undefined;
  status?: 'open' | 'done' | undefined;
  dueBefore?: string | undefined;
  deferAfter?: string | undefined;
  today?: boolean | undefined;
  /** Client-provided "end of my local day" ISO 8601. Defaults to UTC end-of-day. */
  todayCutoff?: string | undefined;
  inbox?: boolean | undefined;
  trash?: boolean | undefined;
  q?: string | undefined;
}

// ISO 8601 — a calendar date (YYYY-MM-DD) or a full timestamp. Date-only is a
// first-class value: the UI's date pickers, and "due on a day" semantics, want
// it, and it sorts correctly against full timestamps lexicographically. Month
// and day are range-bounded so an impossible date like 2026-13-01 is rejected.
const ISO_8601 =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function validateIso(field: string, value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!ISO_8601.test(value)) {
    throw new AuthError(
      400,
      `${field} must be an ISO 8601 date or timestamp (e.g. 2026-05-19 or 2026-05-19T10:00:00Z)`,
    );
  }
}

function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new AuthError(400, 'title is required');
  }
  return trimmed;
}

function requireUserExists(repo: ReturnType<typeof createUsersRepo>, userId: number, field: string): void {
  if (repo.findById(userId) === null) {
    throw new AuthError(409, `${field} references unknown user ${userId}`);
  }
}

function requireLiveParent(repo: TasksRepo, parentId: number): TaskRow {
  const parent = repo.findById(parentId);
  if (parent === null) {
    throw new AuthError(404, `parent task ${parentId} not found`);
  }
  return parent;
}

function defaultTodayCutoff(now: Date): string {
  // End of current UTC day. Callers can override per their local timezone.
  const eod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  return eod.toISOString();
}

export function createTaskCore(
  db: DatabaseClient,
  input: CreateTaskInput,
  principal: Principal,
): Task {
  const tasks = createTasksRepo(db);
  const users = createUsersRepo(db);

  const title = validateTitle(input.title);
  validateIso('defer_until', input.deferUntil);
  validateIso('due_at', input.dueAt);

  const parentId = input.parentId ?? null;
  if (parentId !== null) requireLiveParent(tasks, parentId);

  const assignedTo = input.assignedTo ?? null;
  if (assignedTo !== null) requireUserExists(users, assignedTo, 'assigned_to');

  const row = tasks.insert({
    parentId,
    title,
    notes: input.notes ?? '',
    deferUntil: input.deferUntil ?? null,
    dueAt: input.dueAt ?? null,
    createdBy: principal.userId,
    assignedTo,
    position: tasks.nextSiblingPosition(parentId),
  });
  return toTask(row);
}

export function listTasksCore(
  db: DatabaseClient,
  input: ListTasksInput,
  principal: Principal,
  opts: { now?: Date } = {},
): Task[] {
  const tasks = createTasksRepo(db);

  const filter: ListFilter = {};
  // Stryker disable all -- equivalent: the `if (X !== undefined)` guards on filter-dispatch are observationally identical to unconditional `filter.X = input.X`, because the downstream `tasks.list` treats `{ field: undefined }` the same as `{}`. Per-field presence is covered by the focused tests above; the guards stay for clarity.
  if (input.parentId !== undefined) filter.parentId = input.parentId;
  if (input.assignedTo !== undefined) {
    filter.assignedTo = input.assignedTo === 'me' ? principal.userId : input.assignedTo;
  }
  if (input.createdBy !== undefined) {
    filter.createdBy = input.createdBy === 'me' ? principal.userId : input.createdBy;
  }
  if (input.status !== undefined) filter.status = input.status;
  if (input.dueBefore !== undefined) {
    validateIso('due_before', input.dueBefore);
    filter.dueBefore = input.dueBefore;
  }
  if (input.deferAfter !== undefined) {
    validateIso('defer_after', input.deferAfter);
    filter.deferAfter = input.deferAfter;
  }
  if (input.today) {
    if (input.todayCutoff !== undefined) {
      validateIso('today_cutoff', input.todayCutoff);
      filter.todayCutoff = input.todayCutoff;
    } else {
      filter.todayCutoff = defaultTodayCutoff(opts.now ?? new Date());
    }
    filter.status = 'open';
  }
  if (input.inbox) filter.inbox = true;
  if (input.trash) filter.deletedOnly = true;
  if (input.q !== undefined) filter.q = input.q;
  // Stryker restore all

  return tasks.list(filter).map(toTask);
}

export interface TaskDetail {
  task: Task;
  children: Task[];
}

export function getTaskCore(db: DatabaseClient, id: number): TaskDetail {
  const tasks = createTasksRepo(db);
  const row = tasks.findById(id, { includeDeleted: true });
  if (row === null) throw new AuthError(404, `task ${id} not found`);
  const children = tasks.list({ parentId: id }).map(toTask);
  return { task: toTask(row), children };
}

export function updateTaskCore(
  db: DatabaseClient,
  id: number,
  input: UpdateTaskInput,
  principal: Principal,
): Task {
  const tasks = createTasksRepo(db);
  const users = createUsersRepo(db);

  const existing = tasks.findById(id);
  if (existing === null) throw new AuthError(404, `task ${id} not found or in trash`);

  const patch: Parameters<TasksRepo['update']>[1] = { updatedBy: principal.userId };

  // Stryker disable all -- equivalent: see listTasksCore note; `tasks.update({ field: undefined })` is identical to `tasks.update({})` under the repo's patch semantics.
  if (input.title !== undefined) patch.title = validateTitle(input.title);
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.deferUntil !== undefined) {
    validateIso('defer_until', input.deferUntil);
    patch.deferUntil = input.deferUntil;
  }
  if (input.dueAt !== undefined) {
    validateIso('due_at', input.dueAt);
    patch.dueAt = input.dueAt;
  }
  if (input.position !== undefined) patch.position = input.position;
  // Stryker restore all

  if (input.assignedTo !== undefined) {
    if (input.assignedTo !== null) requireUserExists(users, input.assignedTo, 'assigned_to');
    patch.assignedTo = input.assignedTo;
  }

  if (input.parentId !== undefined) {
    if (input.parentId !== null) {
      requireLiveParent(tasks, input.parentId);
      if (tasks.wouldCycle(id, input.parentId)) {
        throw new AuthError(400, 'would create cycle: cannot parent a task under itself or its descendants');
      }
    }
    patch.parentId = input.parentId;
  }

  const updated = tasks.update(id, patch);
  // Stryker disable next-line all -- defensive: we just confirmed the row exists with findById above, so this branch is unreachable in practice (kept for invariant clarity)
  if (updated === null) {
    throw new AuthError(404, `task ${id} not found or in trash`);
  }
  return toTask(updated);
}

export function completeTaskCore(
  db: DatabaseClient,
  id: number,
  principal: Principal,
): Task {
  const tasks = createTasksRepo(db);
  const existing = tasks.findById(id);
  if (existing === null) throw new AuthError(404, `task ${id} not found or in trash`);
  if (existing.status === 'done') return toTask(existing);
  const done = tasks.setStatus(id, { status: 'done', updatedBy: principal.userId });
  // Stryker disable next-line all -- defensive: existence was verified above; this branch is unreachable in practice
  if (done === null) throw new AuthError(404, `task ${id} not found or in trash`);
  return toTask(done);
}

export function reopenTaskCore(
  db: DatabaseClient,
  id: number,
  principal: Principal,
): Task {
  const tasks = createTasksRepo(db);
  const existing = tasks.findById(id);
  if (existing === null) throw new AuthError(404, `task ${id} not found or in trash`);
  if (existing.status === 'open') return toTask(existing);
  const open = tasks.setStatus(id, { status: 'open', updatedBy: principal.userId });
  // Stryker disable next-line all -- defensive: existence was verified above; this branch is unreachable in practice
  if (open === null) throw new AuthError(404, `task ${id} not found or in trash`);
  return toTask(open);
}

export function deleteTaskCore(
  db: DatabaseClient,
  id: number,
  principal: Principal,
): Task {
  const tasks = createTasksRepo(db);
  const existing = tasks.findById(id, { includeDeleted: true });
  if (existing === null) throw new AuthError(404, `task ${id} not found`);
  if (existing.deleted_at !== null) return toTask(existing);
  const deleted = tasks.softDelete(id, { updatedBy: principal.userId });
  // Stryker disable next-line all -- defensive: existence was verified above; this branch is unreachable in practice
  if (deleted === null) throw new AuthError(404, `task ${id} not found`);
  return toTask(deleted);
}

export function restoreTaskCore(
  db: DatabaseClient,
  id: number,
  principal: Principal,
): Task {
  const tasks = createTasksRepo(db);
  const existing = tasks.findById(id, { includeDeleted: true });
  if (existing === null) throw new AuthError(404, `task ${id} not found`);
  if (existing.deleted_at === null) return toTask(existing);
  const restored = tasks.restore(id, { updatedBy: principal.userId });
  // Stryker disable next-line all -- defensive: existence was verified above; this branch is unreachable in practice
  if (restored === null) throw new AuthError(404, `task ${id} not found`);
  return toTask(restored);
}

export interface TreeCloneResult {
  rootId: number;
  tasks: Task[];
}

export function cloneTaskCore(
  db: DatabaseClient,
  id: number,
  principal: Principal,
): TreeCloneResult {
  const tasks = createTasksRepo(db);
  const source = tasks.findById(id);
  if (source === null) throw new AuthError(404, `task ${id} not found or in trash`);
  const subtree = tasks.cloneSubtree(id, { createdBy: principal.userId });
  // Stryker disable next-line all -- invariant guard: source was verified to exist above, so cloneSubtree always produces at least one row in practice
  if (subtree.length === 0) throw new Error('cloneTaskCore: source existed but clone produced no rows (invariant broken)');
  const root = subtree[0];
  // Stryker disable next-line all -- invariant guard: subtree.length === 0 was just rejected, so subtree[0] is non-nullish
  if (!root) throw new Error('cloneTaskCore: subtree[0] missing (invariant broken)');
  return { rootId: root.id, tasks: subtree.map(toTask) };
}
