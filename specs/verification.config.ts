import { defineVerification } from '@fairfox/polly/verify';

/**
 * Polly verify spec — five state machines modelled, each in its own shadow
 * module under `packages/api/src/specs/`:
 *
 *   auth-machine.ts          → `auth.phase`           anonymous ↔ authenticating ↔ authenticated
 *   ws-machine.ts            → `ws.state`             idle → connecting → connected | error → idle
 *   sessions-machine.ts      → `sessions.outstanding` bounded counter 0..2
 *   tasks-status-machine.ts  → `taskStatus.status`    todo/doing/blocked ⇄ done; any → deleted → todo
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
 *   - complete is valid from any unfinished state (todo, doing, blocked) and
 *     always lands in done; reopen is only valid from done and lands in todo
 *   - the board's lane move (POST /:id/status) reaches all four workflow states
 *     and none of them is `deleted`: no lane change can bin a task or bring one
 *     back, which is what keeping the workflow axis and the trash axis separate
 *     is worth
 *   - restore always lands in todo (predictable resurrection)
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
    'taskStatusMachine.status': {
      type: 'enum',
      values: ['todo', 'doing', 'blocked', 'done', 'deleted'],
    },
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
   * Subsystem partition. The combined model (7 fields × 182 handlers) estimates
   * at ~54B states — infeasible. Polly runs each subsystem as its own TLC
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
    // Order matters: polly runs subsystems in declaration order and stops at the
    // first failure, so the two cheap ones report before the expensive one.
    tasks: {
      state: ['taskStatusMachine.status'],
      handlers: [
        'POST /:id/complete',
        'POST /:id/reopen',
        'POST /:id/status',
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
    /**
     * Sized to terminate. Two handlers and one bound were cut here; each cut is
     * measured against what the generated TLA+ actually explores, which is not
     * what `--estimate` reports (polly#183).
     *
     * The generated `UserNext` sends a message by choosing, at every state:
     *
     *     \E src \in Contexts               3   (hardcoded background/content/popup)
     *     \E targetSet \in SUBSET Contexts   7   (non-empty subsets)
     *     \E tab \in Tabs                   2
     *     \E msgType \in UserMessageTypes    one per handler
     *
     * so the send branching factor is 42 x handlerCount, and `MaxMessages` is
     * the exponent on it. At maxInFlight 2 with 9 handlers that is 378^2 =
     * 142,884 message configurations, times 9^3 = 729 for the per-context copy
     * of the app state. TLC reached 9.6M distinct states in three minutes,
     * still at depth 6 with 8M queued, and the run was killed for memory.
     *
     * Cut 1 — `POST /cli-pair/start` and `POST /cli-pair/poll` are dropped.
     * Both generate `HandleX(ctx) == UNCHANGED contextStates` with no
     * precondition: they carry no `requires`/`ensures` and touch no declared
     * field, so they add a message type and prove nothing. Coverage lost: none.
     *
     * Cut 2 — `maxInFlight` drops from 2 to 1, which removes the squared term.
     * What that does NOT lose: a read-modify-write race on
     * `sessionsMachine.outstanding`. Each generated handler is a single atomic
     * TLA+ action whose guard and assignment are one step, so two messages in
     * flight never interleave between the `< 2` check and the increment. Two
     * in flight buys router-level interleaving (a send while another is
     * pending, a timeout, a port dropping mid-route) — MessageRouter
     * properties, not properties of these handlers.
     *
     * `GET /me` is kept. It is also `UNCHANGED contextStates`, but its
     * `requires(phase = 'authenticated')` is a real precondition and the
     * precondition-locality pass checks it.
     */
    auth: {
      state: ['authMachine.phase', 'sessionsMachine.outstanding'],
      handlers: [
        'POST /register/options',
        'POST /register/verify',
        'POST /login/options',
        'POST /login/verify',
        'POST /logout',
        'GET /me',
        'POST /cli-pair/claim',
      ],
      bounds: { maxInFlight: 1 },
    },
  },
  /**
   * The container reports 6 cores and polly defaults to 1 worker, so five
   * sixths of the CPU sat idle. TLC's fingerprint set grows with throughput
   * and the image sets no `-Xmx` and `docker run` no `--memory`
   * (polly#181), so raising this reaches any memory ceiling sooner.
   * It is set after the auth model was sized to terminate, not before.
   */
  verification: { workers: 6 },
  onBuild: 'warn',
  onRelease: 'error',
});
