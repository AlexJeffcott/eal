/**
 * Shadow auth-gate state machine for `polly verify`. Not imported by
 * production code; same ANCHORING GAP caveats as `auth-machine.ts`. The
 * `requires` / `ensures` annotations are runtime no-ops — only TLC catches
 * bad sequences.
 *
 * Modelled lifecycle of a single inbound HTTP request as it passes through
 * the global `onBeforeHandle` gate in `server-factory.ts`:
 *
 *   undecided ──classifyAsPublic──▶ public ────passThrough──▶ handled
 *      │                                                          ▲
 *      ├────classifyAsAppOwned──▶ appOwned ───passThrough─────────┤
 *      │                                                          │
 *      └─classifyAsPrincipalRequired──▶ principalRequired         │
 *                                            │                    │
 *                                            ├──principalPresent──┤
 *                                            │
 *                                            └──principalAbsent──▶ rejected
 *
 * The model proves the property that motivates `ownsAuthFor`:
 *
 *   *handled* is reachable only via a state that classifies the request — no
 *   request slips through without either matching the public carve-out, an
 *   app's claim, or carrying a valid principal.
 *
 * An app with a mis-scoped `ownsAuthFor` can still hand back a 200 from a
 * write path: that footgun is the app's own bug, not the framework's, and is
 * gated by per-app tests that exercise unauthenticated requests against
 * every claimed route.
 */
// Stryker disable all -- declared initial value is overwritten by every test beforeEach; registry name not used at the test boundary
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

export type AuthGateState =
  | 'undecided'
  | 'public'
  | 'appOwned'
  | 'principalRequired'
  | 'handled'
  | 'rejected';

export const authGateMachine = $sharedState<{ state: AuthGateState }>('authGate', {
  state: 'undecided',
});
// Stryker restore all

export function classifyAsPublic(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(authGateMachine.value.state === 'undecided', 'classifyAsPublic: must start undecided');
  authGateMachine.value = { state: 'public' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authGateMachine.value.state === 'public', 'classifyAsPublic: end public');
}

export function classifyAsAppOwned(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(authGateMachine.value.state === 'undecided', 'classifyAsAppOwned: must start undecided');
  authGateMachine.value = { state: 'appOwned' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authGateMachine.value.state === 'appOwned', 'classifyAsAppOwned: end appOwned');
}

export function classifyAsPrincipalRequired(): void {
  // Stryker disable all -- runtime no-op; only meaningful in TLA+ translation
  requires(
    authGateMachine.value.state === 'undecided',
    'classifyAsPrincipalRequired: must start undecided',
  );
  // Stryker restore all
  authGateMachine.value = { state: 'principalRequired' };
  // Stryker disable all -- runtime no-op; only meaningful in TLA+ translation
  ensures(
    authGateMachine.value.state === 'principalRequired',
    'classifyAsPrincipalRequired: end principalRequired',
  );
  // Stryker restore all
}

export function principalPresent(): void {
  // Stryker disable all -- runtime no-op; only meaningful in TLA+ translation
  requires(
    authGateMachine.value.state === 'principalRequired',
    'principalPresent: only after principalRequired',
  );
  // Stryker restore all
  authGateMachine.value = { state: 'handled' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authGateMachine.value.state === 'handled', 'principalPresent: end handled');
}

export function principalAbsent(): void {
  // Stryker disable all -- runtime no-op; only meaningful in TLA+ translation
  requires(
    authGateMachine.value.state === 'principalRequired',
    'principalAbsent: only after principalRequired',
  );
  // Stryker restore all
  authGateMachine.value = { state: 'rejected' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authGateMachine.value.state === 'rejected', 'principalAbsent: end rejected');
}

export function passThrough(): void {
  // Stryker disable all -- runtime no-op; only meaningful in TLA+ translation
  requires(
    authGateMachine.value.state === 'public' || authGateMachine.value.state === 'appOwned',
    'passThrough: must be public or appOwned',
  );
  // Stryker restore all
  authGateMachine.value = { state: 'handled' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authGateMachine.value.state === 'handled', 'passThrough: end handled');
}

export function resetRequest(): void {
  // Stryker disable all -- runtime no-op; only meaningful in TLA+ translation
  requires(
    authGateMachine.value.state === 'handled' || authGateMachine.value.state === 'rejected',
    'resetRequest: only from a terminal state',
  );
  // Stryker restore all
  authGateMachine.value = { state: 'undecided' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authGateMachine.value.state === 'undecided', 'resetRequest: end undecided');
}
