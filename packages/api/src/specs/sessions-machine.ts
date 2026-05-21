/**
 * Shadow session-counter state machine for `polly verify`. Not imported by
 * production code. See `auth-machine.ts` for the full ANCHORING GAP banner —
 * same caveats apply: spec is intent, requires/ensures are runtime no-ops,
 * only `bun devctl verify` catches bad sequences.
 *
 * `sessions.outstanding` is a bounded integer (0..MAX). Mint increments,
 * revoke decrements (requires ≥1 to revoke), revokeAll resets to zero.
 * The bound keeps TLC's state space tractable; the runtime sessions table
 * has no fixed cap.
 *
 * The model proves:
 *   - outstanding never goes negative (revoke requires ≥1)
 *   - outstanding never exceeds the bound (mint requires < MAX)
 *   - revokeAll deterministically zeros the counter
 */
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

const MAX_OUTSTANDING = 2;

export const sessionsMachine = $sharedState<{ outstanding: number }>('sessions', { outstanding: 0 });

export function mintSession(): void {
  requires(
    sessionsMachine.value.outstanding < MAX_OUTSTANDING,
    'mintSession: outstanding sessions are capped at MAX_OUTSTANDING for model bound',
  );
  sessionsMachine.value = { outstanding: sessionsMachine.value.outstanding + 1 };
  ensures(sessionsMachine.value.outstanding >= 1, 'mintSession: outstanding ≥ 1 after mint');
}

export function revokeSession(): void {
  requires(sessionsMachine.value.outstanding > 0, 'revokeSession: must have ≥ 1 to revoke');
  sessionsMachine.value = { outstanding: sessionsMachine.value.outstanding - 1 };
  ensures(sessionsMachine.value.outstanding >= 0, 'revokeSession: outstanding ≥ 0 after revoke');
}

export function revokeAllSessions(): void {
  sessionsMachine.value = { outstanding: 0 };
  ensures(sessionsMachine.value.outstanding === 0, 'revokeAllSessions: outstanding = 0');
}
