/**
 * Shadow session-counter state machine for `polly verify`. The production
 * routes in handlers/auth.http.ts now carry inline `requires` / `ensures`
 * and guarded `sessionsMachine.value =` assignments on the mint sites
 * (`POST /register/verify`, `POST /login/verify`, `POST /cli-pair/claim`) and
 * the revoke site (`POST /logout`). `sessions.outstanding` is co-modelled
 * with `auth.phase` in the `auth` subsystem because those handlers transition
 * both at once.
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
// Stryker disable all -- declared initial value is overwritten by every test beforeEach; registry name not used at the test boundary
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

const MAX_OUTSTANDING = 2;

export const sessionsMachine = $sharedState<{ outstanding: number }>('sessionsMachine', { outstanding: 0 });
// Stryker restore all

export function mintSession(): void {
  // Stryker disable all -- runtime no-op; only meaningful in TLA+ translation
  requires(
    sessionsMachine.value.outstanding < MAX_OUTSTANDING,
    'mintSession: outstanding sessions are capped at MAX_OUTSTANDING for model bound',
  );
  // Stryker restore all
  sessionsMachine.value = { outstanding: sessionsMachine.value.outstanding + 1 };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(sessionsMachine.value.outstanding >= 1, 'mintSession: outstanding ≥ 1 after mint');
}

export function revokeSession(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(sessionsMachine.value.outstanding > 0, 'revokeSession: must have ≥ 1 to revoke');
  sessionsMachine.value = { outstanding: sessionsMachine.value.outstanding - 1 };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(sessionsMachine.value.outstanding >= 0, 'revokeSession: outstanding ≥ 0 after revoke');
}

export function revokeAllSessions(): void {
  sessionsMachine.value = { outstanding: 0 };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(sessionsMachine.value.outstanding === 0, 'revokeAllSessions: outstanding = 0');
}
