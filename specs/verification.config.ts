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
    'authMachine.phase': { type: 'enum', values: ['anonymous', 'authenticating', 'authenticated'] },
    'wsMachine.state': { type: 'enum', values: ['idle', 'connecting', 'connected', 'error'] },
    'sessionsMachine.outstanding': { type: 'number', min: 0, max: 2 },
    'taskStatusMachine.status': { type: 'enum', values: ['open', 'done', 'deleted'] },
    'authGateMachine.state': {
      type: 'enum',
      values: ['undecided', 'public', 'appOwned', 'principalRequired', 'handled', 'rejected'],
    },
    'pairingMachine.state': {
      type: 'enum',
      values: ['nonexistent', 'pending', 'consumed', 'expired'],
    },
    'callMachine.state': {
      type: 'enum',
      values: ['nonexistent', 'pending', 'connected', 'closed'],
    },
  },
  messages: {
    maxInFlight: 1,
    maxTabs: 1,
  },
  /**
   * Subsystem partition. The combined model (7 fields × 45 handlers) estimates
   * at ~4.8B states — infeasible. Polly runs each subsystem as its own TLC
   * job, filtered to the listed handlers and state fields, so each per-job
   * state space stays bounded.
   *
   * Polly's analyzer keys handlers by route string only (no Elysia prefix).
   * Where a route name (e.g. `GET /`, `GET /:id`) appears in multiple files
   * the message type is ambiguous and we deliberately omit it from any
   * subsystem rather than alias unrelated handlers together. Every listed
   * handler must belong to exactly one subsystem.
   *
   * Three subsystems are anchored end-to-end (production handlers carry the
   * `requires` / `ensures` / guarded state-assignment lines that polly's
   * static extractor reads):
   *
   *   - auth  — auth.http.ts handlers; co-models sessions.outstanding because
   *             /register/verify, /login/verify, /logout, /cli-pair/claim all
   *             mutate both `auth.phase` and `sessions.outstanding`.
   *   - tasks — tasks.http.ts handlers.
   *   - pairing — family-phone-pair.http.ts handlers.
   *
   * Three machines have shadow models and unit tests but no subsystem here
   * because polly's analyzer cannot extract requires/ensures/assignments from
   * the surfaces that own their state transitions:
   *
   *   - ws.state lives in the browser client; the client uses
   *     `socket.addEventListener('open'|'close', …)` arrow handlers whose
   *     bodies polly does walk, but anchoring them needs care around the
   *     reconnect loop in packages/client/src/eal-client.ts.
   *   - authGate.state lives in middleware (auth/middleware.ts); the only
   *     route handlers polly sees with names that match are the gate tests in
   *     server-factory.auth-gate.test.ts.
   *   - call.state transitions live in the `switch (msg.type)` cases inside
   *     family-phone.ws.ts. Polly's `extractSwitchCaseHandlers` builds a
   *     handler entry per case but hardcodes assignments/pre/post to empty —
   *     anchoring would require refactoring the dispatch to a handler-map.
   *
   * The shadow modules for those three (ws-machine.ts, auth-gate-machine.ts,
   * call-machine.ts) stay as the intent spec and are exercised by their
   * `.test.ts` neighbours.
   */
  subsystems: {
    auth: {
      state: ['authMachine.phase', 'sessionsMachine.outstanding'],
      handlers: [
        'POST /register/options',
        'POST /register/verify',
        'POST /login/options',
        'POST /login/verify',
        'POST /logout',
        'GET /me',
        'POST /cli-pair/start',
        'POST /cli-pair/claim',
        'POST /cli-pair/poll',
      ],
      bounds: { maxInFlight: 2 },
    },
    tasks: {
      state: ['taskStatusMachine.status'],
      handlers: [
        'POST /:id/complete',
        'POST /:id/reopen',
        'POST /:id/clone',
        'POST /:id/restore',
        'DELETE /:id',
        'PATCH /:id',
      ],
      bounds: { maxInFlight: 1 },
    },
    pairing: {
      state: ['pairingMachine.state'],
      handlers: ['POST /start', 'POST /complete'],
      bounds: { maxInFlight: 1 },
    },
  },
  onBuild: 'warn',
  onRelease: 'error',
});
