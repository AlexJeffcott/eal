/**
 * Shadow task-status state machine for `polly verify`. Not imported by
 * production code. Mirrors the lifecycle of a SINGLE task at the abstract
 * level so TLC can prove the status invariants we care about without modelling
 * sqlite.
 *
 *                         ┌──────────┐
 *                         │   open   │ ◄──────────────────┐
 *                         └──┬────┬──┘                    │
 *                            │    │                       │
 *                  complete  │    │  softDelete           │
 *                            ▼    ▼                       │
 *                         ┌──────────┐      restore       │
 *                         │   done   │ ─────softDelete──► │
 *                         └────┬─────┘                    │
 *                              │                          │
 *                  softDelete  │                          │
 *                              ▼                          │
 *                         ┌──────────┐ ─────restore───────┘
 *                         │ deleted  │
 *                         └──────────┘
 *
 * Proven invariants when `bun devctl verify` runs:
 *   - `complete` is only valid from `open`.
 *   - `reopen` is only valid from `done`.
 *   - `softDelete` is valid from `open` or `done`, never from `deleted` (idempotent
 *     no-op handled at the application layer; the spec is the strict version).
 *   - `restore` is only valid from `deleted` and always lands in `open`
 *     (the predictable-resurrection rule documented in docs/tasks-v1.md).
 *
 * ╔════════════════════════ ANCHORING GAP ════════════════════════════╗
 * ║ This model is INTENT, not enforcement. Production handlers in     ║
 * ║ handlers/tasks.shared.ts mutate sqlite directly; they do NOT      ║
 * ║ call beginComplete / completeDone / etc. Drift between spec and  ║
 * ║ code is invisible to TLC. To close, every core handler would     ║
 * ║ also need to call the matching transition, or inline a runtime   ║
 * ║ assert mirroring the requires/ensures body. Same gap the other   ║
 * ║ shadow machines (auth, ws, sessions) flag — see auth-machine.ts. ║
 * ║                                                                   ║
 * ║ Not modelled here (deferred to a future convergence machine):    ║
 * ║   - multi-device interleaving                                    ║
 * ║   - parent/child hierarchy + cascade                             ║
 * ║   - WS broadcast ordering / replay                               ║
 * ║                                                                   ║
 * ║ The multi-device convergence property is enforced by             ║
 * ║ scripts/e2e-tasks-multi.ts instead — two real browsers, real     ║
 * ║ broadcast plumbing, observed convergence in seconds. That's a    ║
 * ║ runtime check, not a proof, but it catches the failure mode the  ║
 * ║ household needs to trust.                                        ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 */
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

export type TaskStatus = 'open' | 'done' | 'deleted';

export const taskStatusMachine = $sharedState<{ status: TaskStatus }>('taskStatus', {
  status: 'open',
});

export function complete(): void {
  requires(taskStatusMachine.value.status === 'open', 'complete: must be open');
  taskStatusMachine.value = { status: 'done' };
  ensures(taskStatusMachine.value.status === 'done', 'complete: end in done');
}

export function reopen(): void {
  requires(taskStatusMachine.value.status === 'done', 'reopen: must be done');
  taskStatusMachine.value = { status: 'open' };
  ensures(taskStatusMachine.value.status === 'open', 'reopen: end in open');
}

export function softDelete(): void {
  requires(
    taskStatusMachine.value.status === 'open' || taskStatusMachine.value.status === 'done',
    'softDelete: must be live (open or done)',
  );
  taskStatusMachine.value = { status: 'deleted' };
  ensures(taskStatusMachine.value.status === 'deleted', 'softDelete: end in deleted');
}

export function restore(): void {
  requires(taskStatusMachine.value.status === 'deleted', 'restore: must be deleted');
  // Predictable resurrection: always returns to `open`, never to `done`.
  // Mirrors the production behaviour in tasks-repo.restoreStmt.
  taskStatusMachine.value = { status: 'open' };
  ensures(
    taskStatusMachine.value.status === 'open',
    'restore: end in open (predictable resurrection)',
  );
}
