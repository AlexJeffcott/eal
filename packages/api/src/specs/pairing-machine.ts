/**
 * Shadow pair-request state machine for `polly verify`. Production routes in
 * handlers/family-phone-pair.http.ts now carry inline `requires` / `ensures`
 * and guarded `pairingMachine.value =` assignments mirroring the transitions
 * below; the `POST /start` and `POST /complete` routes are the anchored
 * surface. `requires` / `ensures` are runtime no-ops; the guarded
 * assignments fire only when `POLLY_VERIFY=1`.
 *
 * Modelled lifecycle of a single family-phone pair request as it passes
 * through `family-phone-pair.shared.ts` (added in Phase C of the plan):
 *
 *   nonexistent ──create──▶ pending ──consume──▶ consumed
 *                                │
 *                                └──expire──▶ expired
 *
 * The model proves the properties that motivate the spoken-code flow:
 *
 *   - A consumed request cannot be consumed again (consume requires pending).
 *   - An expired request cannot be consumed (expire is terminal in that
 *     direction; the next `consume` precondition `state === 'pending'` fails).
 *   - There is no path that consumes without first creating (consume
 *     requires pending; reaching pending requires create).
 *
 * The runtime additionally proves — by SQL CHECK and a single-shot UPDATE —
 * that the public_key recorded on consume is the one submitted with the
 * complete call, not a substitution by a racing request. That property is
 * not modelled here because TLC's state space doesn't include the key bytes;
 * the wire-contract tests in family-phone-pair.http.test.ts cover it.
 */
// Stryker disable all -- declared initial value is overwritten by every test beforeEach; registry name not used at the test boundary
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

export type PairingState = 'nonexistent' | 'pending' | 'consumed' | 'expired';

export const pairingMachine = $sharedState<{ state: PairingState }>('pairingMachine', {
  state: 'nonexistent',
});
// Stryker restore all

export function create(): void {
  // Stryker disable all -- runtime no-op; only meaningful in TLA+ translation
  requires(
    pairingMachine.value.state === 'nonexistent',
    'create: a pair request only exists once per code',
  );
  // Stryker restore all
  pairingMachine.value = { state: 'pending' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(pairingMachine.value.state === 'pending', 'create: end pending');
}

export function consume(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(pairingMachine.value.state === 'pending', 'consume: must be pending');
  pairingMachine.value = { state: 'consumed' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(pairingMachine.value.state === 'consumed', 'consume: end consumed');
}

export function expire(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(pairingMachine.value.state === 'pending', 'expire: must be pending');
  pairingMachine.value = { state: 'expired' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(pairingMachine.value.state === 'expired', 'expire: end expired');
}
