import { defineVerification } from '@fairfox/polly/verify';

/**
 * Polly verify spec — five state machines modelled, each in its own shadow
 * module under `packages/api/src/specs/`:
 *
 *   auth-machine.ts          → `auth.phase`           anonymous ↔ authenticating ↔ authenticated
 *   ws-machine.ts            → `ws.state`             idle → connecting → connected | error → idle
 *   sessions-machine.ts      → `sessions.outstanding` bounded counter 0..2
 *   tasks-status-machine.ts  → `taskStatus.status`    open → done → open; either → deleted → open
 *   auth-gate-machine.ts     → `authGate.state`       undecided → {public, appOwned, principalRequired} → {handled, rejected}
 *
 * Each shadow module declares its `$sharedState` and annotates every
 * transition with `requires`/`ensures`. TLC explores only the transitions
 * those preconditions allow, then checks the postconditions hold.
 *
 * Proven invariants (collectively):
 *   - no jump to authenticated that skips authenticating
 *   - signOut is the only exit from authenticated
 *   - cancelAuth is the only exit from authenticating short of completion
 *   - WS connected is reachable only via connecting (no shortcut from idle)
 *   - WS error is a non-terminal-but-stuck state until disconnect
 *   - outstanding never goes negative
 *   - outstanding never exceeds the model bound
 *   - revokeAllSessions deterministically zeros the counter
 *   - complete is only valid from open; reopen is only valid from done
 *   - restore always lands in open (predictable resurrection)
 *   - the auth gate's `handled` state is reachable only after a classification
 *     (public, appOwned, or principalRequired+principalPresent) — no request
 *     passes through without one of the three checks
 *
 * Not modelled (deliberate): cross-machine coupling like "WS connect requires
 * auth.phase=authenticated". The runtime enforces it; the model treats the
 * machines as independent so the state space stays small enough for `maxInFlight=1`.
 * Multi-device task convergence is also out of scope — it needs a richer model
 * than the single-instance status machine here. See scripts/e2e-tasks-multi.ts
 * for the runtime evidence that broadcasts converge across browsers.
 */
export default defineVerification({
  state: {
    'auth.phase': { type: 'enum', values: ['anonymous', 'authenticating', 'authenticated'] },
    'ws.state': { type: 'enum', values: ['idle', 'connecting', 'connected', 'error'] },
    'sessions.outstanding': { type: 'number', min: 0, max: 2 },
    'taskStatus.status': { type: 'enum', values: ['open', 'done', 'deleted'] },
    'authGate.state': {
      type: 'enum',
      values: ['undecided', 'public', 'appOwned', 'principalRequired', 'handled', 'rejected'],
    },
  },
  messages: {
    maxInFlight: 1,
    maxTabs: 1,
  },
  onBuild: 'warn',
  onRelease: 'error',
});
