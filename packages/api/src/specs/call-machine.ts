/**
 * Shadow per-call state machine for `polly verify`. Not imported by
 * production code; same ANCHORING GAP caveat as the rest of the specs/ tier.
 *
 * Modelled lifecycle of a single family-phone call as the server sees it.
 * Each call moves through these states:
 *
 *   nonexistent ──invite──▶ pending ──accept──▶ connected ──hangup──▶ closed
 *                              │                                         ▲
 *                              ├──reject───────────────────────────────▶│
 *                              └──cancel───────────────────────────────▶│
 *
 * The model proves the properties that motivate the signalling protocol:
 *
 *   - accept fires only from pending — no jumping a call to connected
 *     without an invite (no two-party "connection" without explicit consent).
 *   - reject and cancel are the only exits from pending besides accept —
 *     a pending invite is never silently abandoned in the model.
 *   - hangup fires only from connected — there is no path that disconnects
 *     audio before the call was ever active.
 *   - closed is terminal — once a call ends, no transition reopens it
 *     (re-establishing the call requires a fresh invite, modelled as a
 *     new instance starting from nonexistent).
 *
 * The runtime additionally proves — by an in-process call_id → state map
 * with a single accept-time CAS — that simultaneous hangups from both peers
 * collapse to a single closed transition, not two; and that an audio frame
 * arriving after the closed transition is dropped without forwarding. Those
 * properties are not in the spec (they depend on per-message ordering rather
 * than per-call state) and are covered by the family-phone.ws tests.
 */
// Stryker disable all -- declared initial value is overwritten by every test beforeEach; registry name not used at the test boundary
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

export type CallState = 'nonexistent' | 'pending' | 'connected' | 'closed';

export const callMachine = $sharedState<{ state: CallState }>('call', { state: 'nonexistent' });
// Stryker restore all

export function invite(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(callMachine.value.state === 'nonexistent', 'invite: a call exists once per id');
  callMachine.value = { state: 'pending' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(callMachine.value.state === 'pending', 'invite: end pending');
}

export function accept(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(callMachine.value.state === 'pending', 'accept: must be pending');
  callMachine.value = { state: 'connected' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(callMachine.value.state === 'connected', 'accept: end connected');
}

export function reject(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(callMachine.value.state === 'pending', 'reject: must be pending');
  callMachine.value = { state: 'closed' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(callMachine.value.state === 'closed', 'reject: end closed');
}

export function cancel(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(callMachine.value.state === 'pending', 'cancel: must be pending');
  callMachine.value = { state: 'closed' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(callMachine.value.state === 'closed', 'cancel: end closed');
}

export function hangup(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(callMachine.value.state === 'connected', 'hangup: must be connected');
  callMachine.value = { state: 'closed' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(callMachine.value.state === 'closed', 'hangup: end closed');
}
