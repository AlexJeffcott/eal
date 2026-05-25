/**
 * Shadow pair-request state machine for `polly verify`. Not imported by
 * production code; same ANCHORING GAP caveat as the rest of the specs/ tier.
 * The `requires` / `ensures` annotations are runtime no-ops — only TLC
 * catches bad sequences.
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
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

export type PairingState = 'nonexistent' | 'pending' | 'consumed' | 'expired';

export const pairingMachine = $sharedState<{ state: PairingState }>('pairing', {
  state: 'nonexistent',
});

export function create(): void {
  requires(
    pairingMachine.value.state === 'nonexistent',
    'create: a pair request only exists once per code',
  );
  pairingMachine.value = { state: 'pending' };
  ensures(pairingMachine.value.state === 'pending', 'create: end pending');
}

export function consume(): void {
  requires(pairingMachine.value.state === 'pending', 'consume: must be pending');
  pairingMachine.value = { state: 'consumed' };
  ensures(pairingMachine.value.state === 'consumed', 'consume: end consumed');
}

export function expire(): void {
  requires(pairingMachine.value.state === 'pending', 'expire: must be pending');
  pairingMachine.value = { state: 'expired' };
  ensures(pairingMachine.value.state === 'expired', 'expire: end expired');
}
