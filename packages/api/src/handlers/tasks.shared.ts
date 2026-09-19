import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import type { TaskRow, TasksRepo, ListFilter, TaskKind, TaskStatus } from '../db/repos/tasks.ts';
import { createTasksRepo } from '../db/repos/tasks.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import {
  dayNumber,
  deserialiseRecurrence,
  nextOccurrence,
  parseRecurrence,
  type Recurrence,
  RecurrenceError,
  serialiseRecurrence,
  shiftDate,
  utcDateOf,
  validateToday,
} from '@eal/shared';
import { AuthError } from './auth.shared.ts';

export type { TaskKind, TaskStatus };

/**
 * Wire shape — what the SPA and the CLI both see. CamelCase to match the rest
 * of the codebase (CurrentUser, CliPairStartResult, HelloSaidPayload).
 */
export interface Task {
  id: number;
  parentId: number | null;
  title: string;
  notes: string;
  status: TaskStatus;
  kind: TaskKind;
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
  /**
   * Does this container hand its work out one step at a time?
   *
   * It governs the row's *children*, so on a leaf it means nothing and no UI
   * offers it (tasks-panel.tsx shows the control on a container only). It is
   * still stored on every row rather than rejected on a leaf: the flag says how
   * this row would order children if it had any, so a task promoted to a
   * project keeps the answer it was given, and no write path gains a new way to
   * fail. What it *does* is defined in one place —
   * packages/client/src/task-availability.ts:availableTaskIds.
   */
  sequential: boolean;
  /**
   * The id the capturing device gave this task before the server had one, or
   * null. It is on the wire so the device can match a row that comes back by
   * broadcast or by seed to the outbox entry still waiting for it — the case
   * where the create landed and its response did not.
   */
  clientId: string | null;
  /**
   * The rule this task repeats by, or null. It sits on the one live row of a
   * series: completing that row makes the next occurrence and moves the rule
   * onto it, so a finished occurrence reads as an ordinary done task.
   * `@eal/shared` recurrence.ts is the rule's whole definition.
   */
  recurrence: Recurrence | null;
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    kind: row.kind,
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
    // The column is an INTEGER 0/1 (SQLite has no boolean); this is the one
    // place it becomes the boolean the wire and the SPA carry.
    sequential: row.sequential === 1,
    clientId: row.client_id,
    // Stored as the canonical JSON the boundary wrote. A row that does not
    // parse was not written by this code, and that is a 500, not a null.
    recurrence: row.recurrence === null ? null : deserialiseRecurrence(row.recurrence),
  };
}

export interface CreateTaskInput {
  title: string;
  kind?: TaskKind | undefined;
  parentId?: number | null | undefined;
  assignedTo?: number | null | undefined;
  notes?: string | undefined;
  deferUntil?: string | null | undefined;
  dueAt?: string | null | undefined;
  sequential?: boolean | undefined;
  /** See `Task.clientId`. A UUID; anything else is refused. */
  clientId?: string | undefined;
  /**
   * `unknown`, because this is the boundary: it arrives as JSON from a browser
   * or from the assistant, and `parseRecurrence` is what makes it a rule.
   */
  recurrence?: unknown;
}

export interface UpdateTaskInput {
  title?: string | undefined;
  notes?: string | undefined;
  kind?: TaskKind | undefined;
  assignedTo?: number | null | undefined;
  parentId?: number | null | undefined;
  deferUntil?: string | null | undefined;
  dueAt?: string | null | undefined;
  position?: number | undefined;
  sequential?: boolean | undefined;
  /** A rule to set, `null` to end the series, `undefined` to leave it alone. */
  recurrence?: unknown;
}

/**
 * What a move along the status axis did. `task` is the row that was asked
 * about. `spawned` is the next occurrence a completion made — root first, and
 * more than one row when the task was a container — and `removed` is the ids
 * of an untouched successor a reopen took back. Both are empty for a task that
 * does not recur, which is nearly all of them.
 */
export interface StatusChange {
  task: Task;
  spawned: Task[];
  removed: number[];
}

/** What a completion may be told, and what a test may pin. */
export interface StatusChangeOptions {
  /** The calendar date where the person is standing. See `validateToday`. */
  today?: string | undefined;
  now?: Date | undefined;
}

export interface ListTasksInput {
  parentId?: number | null | undefined;
  kind?: TaskKind | undefined;
  assignedTo?: number | 'me' | undefined;
  createdBy?: number | 'me' | undefined;
  status?: TaskStatus | undefined;
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

/**
 * The one rule binding the three levels: project → epic → task.
 *
 * | kind    | allowed parent                         |
 * |---------|----------------------------------------|
 * | project | none — a project is always a root      |
 * | epic    | a project                              |
 * | task    | none, a project, or an epic            |
 *
 * The epic level is optional: a project may hold tasks directly, which is what
 * the second row of the `task` case buys.
 *
 * SQLite cannot express this. A CHECK constraint sees only the row being
 * written and this rule reads the *parent* row's kind, so it lives here in
 * application code and is only as good as its tests — hence
 * tasks.levels.property.test.ts, which generates arbitrary trees and arbitrary
 * moves rather than enumerating the nine pairings by hand.
 *
 * Returns why a pairing is illegal, or null when it is allowed.
 */
export function levelViolation(kind: TaskKind, parentKind: TaskKind | null): string | null {
  if (kind === 'project') {
    if (parentKind === null) return null;
    return 'a project cannot be filed under another task';
  }
  if (kind === 'epic') {
    if (parentKind === 'project') return null;
    return 'an epic must be filed under a project';
  }
  if (parentKind === 'task') return 'a task cannot be filed under another task';
  return null;
}

/**
 * The kind of the row `parentId` names, or null for a root. Reads through the
 * trash: a soft-deleted parent still holds its children (delete does not
 * cascade in the application layer), so its level still constrains them.
 */
function parentKindOf(tasks: TasksRepo, parentId: number | null): TaskKind | null {
  if (parentId === null) return null;
  const parent = tasks.findById(parentId, { includeDeleted: true });
  // Stryker disable next-line all -- defensive: tasks.parent_id carries a
  // foreign key with ON DELETE CASCADE, so a stored parent_id always names a
  // row. Unreachable in practice; kept so a broken FK fails loudly.
  if (parent === null) throw new AuthError(404, `parent task ${parentId} not found`);
  return parent.kind;
}

function requireLevelAllowed(kind: TaskKind, parentKind: TaskKind | null): void {
  const violation = levelViolation(kind, parentKind);
  if (violation !== null) throw new AuthError(400, violation);
}

function defaultTodayCutoff(now: Date): string {
  // End of current UTC day. Callers can override per their local timezone.
  const eod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  return eod.toISOString();
}

/**
 * Admit a rule at the boundary and return its stored form. `null` and
 * `undefined` pass through: "end the series" and "say nothing" are both legal.
 */
function admitRecurrence(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  try {
    return serialiseRecurrence(parseRecurrence(value));
  } catch (err) {
    if (err instanceof RecurrenceError) throw new AuthError(400, err.message);
    throw err;
  }
}

/**
 * What day is it, for the purposes of "the first occurrence strictly after
 * today"? The device's answer when it gave one, checked; UTC's otherwise — the
 * CLI and the assistant run on the household's own machine and send none.
 */
function resolveToday(opts: StatusChangeOptions): string {
  const serverDate = utcDateOf(opts.now ?? new Date());
  if (opts.today === undefined) return serverDate;
  try {
    return validateToday(opts.today, serverDate);
  } catch (err) {
    if (err instanceof RecurrenceError) throw new AuthError(400, err.message);
    throw err;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateClientId(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!UUID_PATTERN.test(raw)) throw new AuthError(400, 'client_id must be a UUID');
  // One spelling per id: the unique index compares bytes.
  return raw.toLowerCase();
}

export function createTaskCore(
  db: DatabaseClient,
  input: CreateTaskInput,
  principal: Principal,
): Task {
  return createTaskOnce(db, input, principal).task;
}

/**
 * Create a task, at most once per `clientId`.
 *
 * A device that captures offline sends its create again whenever it cannot
 * tell whether the last one arrived — the response was lost, the tab was
 * closed, the phone went into a tunnel. The second send must be a success that
 * returns the first row, not a second row and not an error: the device treats
 * any answer with a failing status as "drop the entry and tell the user".
 *
 * `created` is false for that replay. The route broadcasts only on true — every
 * device already heard `task:created` the first time.
 *
 * The lookup runs BEFORE the parent and level checks. A parent binned between
 * the two sends would otherwise turn the replay into a 404 for a row that
 * exists. And it answers with the row as it is NOW, not as it was captured:
 * what the device needs is the truth to show, and the row may have been edited,
 * or binned, since.
 *
 * specs/tla/tasks-convergence/TasksConvergence.tla: AtMostOneRowPerClientId.
 */
export function createTaskOnce(
  db: DatabaseClient,
  input: CreateTaskInput,
  principal: Principal,
): { task: Task; created: boolean } {
  const tasks = createTasksRepo(db);
  const clientId = validateClientId(input.clientId);
  if (clientId !== null) {
    const existing = tasks.findByClientId(principal.userId, clientId);
    if (existing !== null) return { task: toTask(existing), created: false };
  }
  return { task: insertTask(db, input, clientId, principal), created: true };
}

function insertTask(
  db: DatabaseClient,
  input: CreateTaskInput,
  clientId: string | null,
  principal: Principal,
): Task {
  const tasks = createTasksRepo(db);
  const users = createUsersRepo(db);

  const title = validateTitle(input.title);
  validateIso('defer_until', input.deferUntil);
  validateIso('due_at', input.dueAt);

  const parentId = input.parentId ?? null;
  const parent = parentId === null ? null : requireLiveParent(tasks, parentId);

  // Capture defaults to the bottom level. "Write it down now, discover later
  // it is a project" is the flow the kind column exists to serve, so quick-add
  // never has to decide.
  const kind = input.kind ?? 'task';
  requireLevelAllowed(kind, parent === null ? null : parent.kind);

  const assignedTo = input.assignedTo ?? null;
  if (assignedTo !== null) requireUserExists(users, assignedTo, 'assigned_to');

  const row = tasks.insert({
    parentId,
    title,
    notes: input.notes ?? '',
    kind,
    deferUntil: input.deferUntil ?? null,
    dueAt: input.dueAt ?? null,
    createdBy: principal.userId,
    assignedTo,
    position: tasks.nextSiblingPosition(parentId),
    // Capture is parallel unless someone says otherwise, which is the same
    // default the column carries and the same "changes nothing" promise the
    // migration makes.
    sequential: input.sequential ?? false,
    clientId,
    recurrence: admitRecurrence(input.recurrence) ?? null,
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
    // Today is "still carrying work", which is three states now, not one. A
    // task you started this morning and one you are stuck on both belong on
    // today's list; only `done` leaves it.
    filter.unfinished = true;
  }
  if (input.kind !== undefined) filter.kind = input.kind;
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
  if (input.sequential !== undefined) patch.sequential = input.sequential;
  // Stryker restore all
  const recurrence = admitRecurrence(input.recurrence);
  if (recurrence !== undefined) patch.recurrence = recurrence;

  if (input.assignedTo !== undefined) {
    if (input.assignedTo !== null) requireUserExists(users, input.assignedTo, 'assigned_to');
    patch.assignedTo = input.assignedTo;
  }

  if (input.parentId !== undefined) {
    if (input.parentId !== null) {
      requireLiveParent(tasks, input.parentId);
      // Cycle first, level second. A move that both loops and breaks the level
      // rule is a cycle above all else, and naming it that way is the more
      // useful error: no choice of kinds would make the move legal.
      if (tasks.wouldCycle(id, input.parentId)) {
        throw new AuthError(400, 'would create cycle: cannot parent a task under itself or its descendants');
      }
    }
    patch.parentId = input.parentId;
  }
  if (input.kind !== undefined) patch.kind = input.kind;

  // The level rule reads the pair (kind, parent kind), and either half can
  // move in one PATCH — a promotion to project that also unfiles the row is a
  // single call. Resolve both to their post-update values before deciding.
  if (input.kind !== undefined || input.parentId !== undefined) {
    const nextKind = input.kind ?? existing.kind;
    const nextParentId = input.parentId === undefined ? existing.parent_id : input.parentId;
    requireLevelAllowed(nextKind, parentKindOf(tasks, nextParentId));
  }

  // A change of kind revalidates downwards as well as upwards: demoting a
  // project to a task would leave its children filed under something that
  // cannot hold them. Trashed children count, because soft-delete leaves a row
  // filed where it was and restore returns it in place — skipping them would
  // let a later restore resurrect a pairing no write ever checked.
  if (input.kind !== undefined && input.kind !== existing.kind) {
    for (const child of tasks.list({ parentId: id, includeDeleted: true })) {
      const stranded = levelViolation(child.kind, input.kind);
      if (stranded !== null) {
        throw new AuthError(400, `task ${child.id} would no longer fit under it: ${stranded}`);
      }
    }
  }

  const updated = tasks.update(id, patch);
  // Stryker disable next-line all -- defensive: we just confirmed the row exists with findById above, so this branch is unreachable in practice (kept for invariant clarity)
  if (updated === null) {
    throw new AuthError(404, `task ${id} not found or in trash`);
  }
  return toTask(updated);
}

/**
 * The recurring half of a completion: make the next occurrence.
 *
 * Runs inside the transaction that marked `completed` done. The successor's
 * due date is the first occurrence STRICTLY AFTER `today` — a weekly task
 * finished three weeks late comes back once, next week, never as three rows to
 * tick through. Where the count starts is the rule's `basis`:
 *
 *   due        the previous `due_at` — or `today`, when the task never had one,
 *              because "every Tuesday" on an undated task still has to start
 *              somewhere and the day it was done is the only date there is.
 *   completed  `today`, carrying whatever time the previous `due_at` had.
 *
 * Every other date in the tree — the root's `defer_until`, and a container's
 * children — moves by the same number of calendar days as the root's due date,
 * so a project whose steps were spread over its week keeps that spread.
 */
function spawnNextOccurrence(
  tasks: TasksRepo,
  completed: TaskRow,
  rule: Recurrence,
  today: string,
  principal: Principal,
): Task[] {
  const previousDue = completed.due_at;
  const timeOfDay = previousDue === null ? '' : previousDue.slice(10);
  const anchor = rule.basis === 'due' && previousDue !== null ? previousDue : today + timeOfDay;
  const dueAt = nextOccurrence(rule, anchor, today);
  const movedFrom = previousDue === null ? today : previousDue.slice(0, 10);
  const shiftDays = dayNumber(dueAt.slice(0, 10)) - dayNumber(movedFrom);
  return tasks
    .spawnSuccessor(completed.id, { updatedBy: principal.userId, dueAt, shiftDays, shift: shiftDate })
    .map(toTask);
}

/**
 * The one place a task's status moves, whichever route asked: the tick box,
 * the untick, and the board's lane move all land here, because recurrence
 * hangs off two edges of the status axis and every one of those routes can
 * cross them.
 *
 *   into `done`    a recurring row spawns its next occurrence and hands it the
 *                  rule — `spawnNextOccurrence`.
 *   out of `done`  THE ACCIDENTAL TICK. If the occurrence that completion
 *                  spawned is still untouched, it is removed and the rule
 *                  comes back to this row: the tick is undone, whole. If
 *                  anyone has touched the successor since — edited it, moved
 *                  it, started it, binned it, filed something in it — it
 *                  stays, it keeps the rule, and this row comes back as an
 *                  ordinary task. "Untouched" is the `spawn_group` column
 *                  (db/schema.ts), not a comparison of timestamps.
 *
 * Either way at most one live row of a series carries its rule, so no order of
 * ticks and unticks can make the bins come round twice:
 * tasks.recurrence.property.test.ts.
 *
 * A container completes the way it always has — its own row only, children
 * left as they are — and its successor copies the live subtree with every row
 * back at `todo`.
 */
function moveStatus(
  db: DatabaseClient,
  id: number,
  target: TaskStatus,
  principal: Principal,
  opts: StatusChangeOptions,
): StatusChange {
  const tasks = createTasksRepo(db);
  const existing = tasks.findById(id);
  if (existing === null) throw new AuthError(404, `task ${id} not found or in trash`);
  // Already there is a no-op returning the row — two devices ticking the same
  // box, or dropping the same card in the same lane, must both succeed, and
  // the second must not spawn a second successor.
  if (existing.status === target) return { task: toTask(existing), spawned: [], removed: [] };

  const rule =
    target === 'done' && existing.recurrence !== null
      ? deserialiseRecurrence(existing.recurrence)
      : null;
  // Resolved before the write, so a bad `today` refuses the whole request.
  const today = rule === null ? null : resolveToday(opts);

  return db.transaction((): StatusChange => {
    const moved = tasks.setStatus(id, { status: target, updatedBy: principal.userId });
    // Stryker disable next-line all -- defensive: existence was verified above; this branch is unreachable in practice
    if (moved === null) throw new AuthError(404, `task ${id} not found or in trash`);

    const spawned =
      rule !== null && today !== null
        ? spawnNextOccurrence(tasks, moved, rule, today, principal)
        : [];
    const removed = existing.status === 'done' ? tasks.reclaimUntouchedSuccessor(id) : [];

    // Both of those may have rewritten this row's rule after `setStatus` read it.
    const settled = spawned.length > 0 || removed.length > 0 ? tasks.findById(id) : moved;
    // Stryker disable next-line all -- defensive: the row was written a statement ago, inside this transaction
    if (settled === null) throw new AuthError(404, `task ${id} not found or in trash`);
    return { task: toTask(settled), spawned, removed };
  })();
}

/**
 * Ticking the box. With four states, "complete" means the same thing from all
 * three live ones: a task you had merely written down, one you had started, and
 * one you were stuck on are all finished the same way, so there is no reason to
 * make the person move a card to `doing` before they may finish it.
 *
 * Already done is a no-op returning the row, as before — two devices ticking
 * the same box must not make the second one an error.
 */
export function completeTaskCore(
  db: DatabaseClient,
  id: number,
  principal: Principal,
  opts: StatusChangeOptions = {},
): StatusChange {
  return moveStatus(db, id, 'done', principal, opts);
}

/**
 * Untucking the box. Reopen lands in `todo`, never in the state the task held
 * before it was completed — the same predictable-resurrection rule `restore`
 * already follows (docs/tasks-v1.md). Storing "what it was before" would need a
 * column, and a task you finished and then reopened is one you are starting
 * again anyway.
 *
 * Only `done` is reopenable. Called on a live task it is a no-op returning the
 * row, so an assistant that reopens twice does not get an error.
 */
export function reopenTaskCore(
  db: DatabaseClient,
  id: number,
  principal: Principal,
): StatusChange {
  const tasks = createTasksRepo(db);
  const existing = tasks.findById(id);
  if (existing === null) throw new AuthError(404, `task ${id} not found or in trash`);
  if (existing.status !== 'done') return { task: toTask(existing), spawned: [], removed: [] };
  return moveStatus(db, id, 'todo', principal, {});
}

/**
 * Moving a card between lanes. The workflow axis and the trash axis are
 * separate: this reaches every one of the four states and none of them is
 * `deleted`, so no drag on the board can bin a task or resurrect one.
 *
 * A task already in the target lane is a no-op returning the row. Two devices
 * dropping the same card into `doing` must both succeed.
 *
 * Dropping a card into Done is a completion and dragging one out is a reopen,
 * recurrence included — the board must not be a way to finish the bins without
 * them coming round again.
 */
export function setTaskStatusCore(
  db: DatabaseClient,
  id: number,
  status: TaskStatus,
  principal: Principal,
  opts: StatusChangeOptions = {},
): StatusChange {
  return moveStatus(db, id, status, principal, opts);
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
