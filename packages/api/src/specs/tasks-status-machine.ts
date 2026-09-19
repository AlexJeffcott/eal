/**
 * Shadow task-status state machine for `polly verify`. Not imported by
 * production code for its behaviour — only `taskStatusMachine` itself is, so
 * the HTTP handlers can anchor to it. Mirrors the lifecycle of a SINGLE task at
 * the abstract level so TLC can prove the status invariants we care about
 * without modelling sqlite.
 *
 * Stage 2 widened the workflow axis from two states to four. `todo`, `doing`
 * and `blocked` are the three *live* states — a task with work still in it —
 * and `done` is the fourth. `deleted` is not on that axis at all: it is the
 * trash, reached only by softDelete and left only by restore.
 *
 *              setStatus (any live ↔ any live, including done)
 *            ┌──────────────────────────────────────────────┐
 *            │                                              │
 *            ▼        complete                              │
 *   ┌──────┐ ┌───────┐ ┌─────────┐  ──────────────►  ┌──────────┐
 *   │ todo │ │ doing │ │ blocked │                   │   done   │
 *   └──────┘ └───────┘ └─────────┘  ◄──reopen──────  └──────────┘
 *       └────────┬─────────┘                               │
 *                │                                         │
 *      softDelete│                            softDelete   │
 *                ▼                                         ▼
 *             ┌──────────┐ ◄─────────────────────────────────
 *             │ deleted  │ ─────restore────►  todo
 *             └──────────┘
 *
 * Proven invariants when `bun devctl verify` runs:
 *   - `complete` is valid from any live state and always lands in `done`. All
 *     three live states finish the same way: there is no reason to make someone
 *     move a card to `doing` before they are allowed to tick it off.
 *   - `reopen` is only valid from `done` and always lands in `todo` — the same
 *     predictable-resurrection rule `restore` follows, rather than restoring
 *     whatever state the task held before it was completed (which would need a
 *     column to remember).
 *   - `setStatus` — the board's lane move — is valid from any of the four
 *     workflow states and lands in one of the four. It therefore never reaches
 *     `deleted` and never leaves it: **no drag on the board can bin a task or
 *     resurrect one.** That is the property the two axes being separate buys.
 *   - `softDelete` is valid from any of the four workflow states, never from
 *     `deleted` (idempotent no-op handled at the application layer; the spec is
 *     the strict version).
 *   - `restore` is only valid from `deleted` and always lands in `todo`
 *     (the predictable-resurrection rule documented in docs/tasks-v1.md).
 *
 * Not modelled here, deliberately: the `done` ⇔ `completed_at IS NOT NULL` tie.
 * That is a table-level CHECK in packages/api/src/apps/tasks.ts, enforced by
 * the storage on every write, and a shadow model of a single abstract field
 * cannot say anything the constraint does not already guarantee.
 *
 * Not modelled here, and not for want of trying: RECURRENCE
 * (docs/plans/05-recurring-tasks.md). The property worth proving is "at most
 * one live row of a series carries its rule, whatever order ticks, unticks and
 * edits arrive in". This machine cannot state it, for three reasons:
 *
 *   1. It is a property of a SERIES — the finished row, its successor, the
 *      successor's successor — and this machine is one enum for one task.
 *      polly's generator has no sets, no sequences and no second entity (the
 *      same wall `TasksConvergence.tla` was hand-written to get round).
 *   2. Whether an untick takes the successor back depends on whether anyone
 *      has written to a DIFFERENT row since, through a different route. From
 *      inside one task's machine a PATCH to the successor and a PATCH to this
 *      row are the same transition.
 *   3. Whether `complete` spawns anything depends on a column's value. The
 *      extractor reads literal assignments; a branch on data extracts as both
 *      branches or neither. A `successor: none | untouched | touched` field
 *      could be added and anchored, but every transition on it would be one I
 *      typed to mirror the code, and TLC would prove my typing.
 *
 * What stands in its place is handlers/tasks.recurrence.property.test.ts:
 * fast-check drives arbitrary complete / reopen / lane-move / edit / bin /
 * restore sequences, from two people, against the real cores and a real SQLite
 * file, and checks four laws after every step. It is a search, not a proof. It
 * is falsified: three broken repos each fail it.
 *
 * What DOES hold here unchanged: the status axis. A recurring completion is
 * still `live → done`, the untick is still `done → todo`, and the successor is
 * a new task that starts its own life in `todo`. The routes kept their
 * `requires` / `ensures`, and `bun devctl verify` passes over them.
 *
 * ╔════════════════════════ ANCHORING ════════════════════════════════╗
 * ║ The HTTP route handlers in handlers/tasks.http.ts carry inline    ║
 * ║ `requires` / `ensures` and guarded                                ║
 * ║ `taskStatusMachine.value = ...` assignments. The anchored          ║
 * ║ surface is `POST /:id/complete`, `POST /:id/reopen`,               ║
 * ║ `POST /:id/status`, `DELETE /:id`, and `POST /:id/restore`.        ║
 * ║ Same pattern as auth-machine.ts.                                   ║
 * ║                                                                    ║
 * ║ `POST /:id/status` writes its four landing states as four literal ║
 * ║ assignments rather than one on the request body. Polly's static   ║
 * ║ extractor reads literals; `{ status: body.status }` extracts to   ║
 * ║ nothing and the route would model as changing no state at all.    ║
 * ║                                                                    ║
 * ║ Not modelled here (deferred to a future convergence machine):     ║
 * ║   - multi-device interleaving                                     ║
 * ║   - parent/child hierarchy + cascade                              ║
 * ║   - WS broadcast ordering / replay                                ║
 * ║                                                                    ║
 * ║ The multi-device convergence property is enforced by              ║
 * ║ scripts/e2e-tasks-multi.ts instead — two real browsers, real      ║
 * ║ broadcast plumbing, observed convergence in seconds. That's a     ║
 * ║ runtime check, not a proof, but it catches the failure mode the   ║
 * ║ household needs to trust.                                         ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 */
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

/**
 * The modelled state set. Wider than the stored `TaskStatus` in
 * db/repos/tasks.ts by one: `deleted` is `deleted_at IS NOT NULL` on the row,
 * not a value the status column can hold. The model collapses the two into one
 * field because a single task is only ever in one of these places.
 */
export type ModelledTaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'deleted';

export const taskStatusMachine = $sharedState<{ status: ModelledTaskStatus }>('taskStatusMachine', {
  status: 'todo',
});

export function complete(): void {
  // Written out longhand rather than through a helper predicate: polly's
  // extractor reads the *text* of these expressions, and every condition here
  // is a byte-for-byte twin of the one on its route in handlers/tasks.http.ts.
  requires(
    taskStatusMachine.value.status === 'todo' ||
      taskStatusMachine.value.status === 'doing' ||
      taskStatusMachine.value.status === 'blocked',
    'complete: must be live and unfinished',
  );
  taskStatusMachine.value = { status: 'done' };
  ensures(taskStatusMachine.value.status === 'done', 'complete: end in done');
}

export function reopen(): void {
  requires(taskStatusMachine.value.status === 'done', 'reopen: must be done');
  // Predictable resurrection, the same rule `restore` follows: back to the
  // start of the axis, not to whatever lane the task sat in before.
  taskStatusMachine.value = { status: 'todo' };
  ensures(taskStatusMachine.value.status === 'todo', 'reopen: end in todo');
}

/**
 * Moving a card between lanes. Every workflow state reaches every other,
 * including `done` in both directions — the board's `done` lane is a lane like
 * the rest. What it cannot reach is `deleted`, which is the point.
 *
 * The four landing states are four literal assignments, not one on `next`, for
 * the same reason the route is written that way: a literal is what the static
 * extractor can read, so the model explores all four.
 */
export function setStatus(next: 'todo' | 'doing' | 'blocked' | 'done'): void {
  requires(
    taskStatusMachine.value.status === 'todo' ||
      taskStatusMachine.value.status === 'doing' ||
      taskStatusMachine.value.status === 'blocked' ||
      taskStatusMachine.value.status === 'done',
    'setStatus: must be live',
  );
  if (next === 'done') taskStatusMachine.value = { status: 'done' };
  else if (next === 'doing') taskStatusMachine.value = { status: 'doing' };
  else if (next === 'blocked') taskStatusMachine.value = { status: 'blocked' };
  else taskStatusMachine.value = { status: 'todo' };
  ensures(
    taskStatusMachine.value.status === 'todo' ||
      taskStatusMachine.value.status === 'doing' ||
      taskStatusMachine.value.status === 'blocked' ||
      taskStatusMachine.value.status === 'done',
    'setStatus: ends live — the workflow axis never reaches the trash',
  );
}

export function softDelete(): void {
  requires(
    taskStatusMachine.value.status === 'todo' ||
      taskStatusMachine.value.status === 'doing' ||
      taskStatusMachine.value.status === 'blocked' ||
      taskStatusMachine.value.status === 'done',
    'softDelete: must be live (any of the four workflow states)',
  );
  taskStatusMachine.value = { status: 'deleted' };
  ensures(taskStatusMachine.value.status === 'deleted', 'softDelete: end in deleted');
}

export function restore(): void {
  requires(taskStatusMachine.value.status === 'deleted', 'restore: must be deleted');
  // Predictable resurrection: always returns to `todo`, never to `done` and
  // never to the lane the task was in when it was binned.
  // Mirrors the production behaviour in tasks-repo.restoreStmt.
  taskStatusMachine.value = { status: 'todo' };
  ensures(
    taskStatusMachine.value.status === 'todo',
    'restore: end in todo (predictable resurrection)',
  );
}
