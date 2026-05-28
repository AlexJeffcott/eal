/**
 * Shadow auth state machine for `polly verify`. This module is NOT imported by
 * production code. It exists so the TLA+ extractor in `@fairfox/polly/verify`
 * can read the state declaration and the `requires`/`ensures` annotations, and
 * TLC then explores transitions constrained by those preconditions and
 * postconditions.
 *
 * The runtime production state lives in sqlite (sessions table, users table,
 * principal extraction from headers). This file mirrors that state at the
 * abstract level — anonymous → authenticating → authenticated → anonymous —
 * so model-checking can prove invariants like "from authenticated you can
 * only reach anonymous via signOut" without needing to model sqlite.
 *
 * ╔════════════════════════ ANCHORING GAP ════════════════════════════╗
 * ║ This model is INTENT, not enforcement. Production handlers        ║
 * ║ (registerVerifyCore, loginVerifyCore, logoutCore in handlers/     ║
 * ║ auth.shared.ts) do not import `beginAuth` / `completeAuth` /      ║
 * ║ `signOut`. They mutate sqlite directly.                           ║
 * ║                                                                   ║
 * ║ Consequences:                                                     ║
 * ║   - `polly verify` proves the SPEC is internally consistent.      ║
 * ║   - It does NOT prove the production handlers match the spec.     ║
 * ║   - Drift between spec and code is invisible.                     ║
 * ║                                                                   ║
 * ║ To close: handlers should call these transitions in addition to   ║
 * ║ their sqlite writes (with the polly state registry scoped per     ║
 * ║ request), OR equivalent runtime assertions should mirror the      ║
 * ║ requires/ensures bodies inline in the handler code paths.         ║
 * ║                                                                   ║
 * ║ Also note: `requires` and `ensures` from @fairfox/polly/verify    ║
 * ║ are RUNTIME NO-OPS. Importing this file and calling the           ║
 * ║ transitions does NOT raise on bad sequences. Only TLC catches     ║
 * ║ that, via `bun devctl verify`.                                    ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 */
// Stryker disable all -- declared initial value is overwritten by every test beforeEach; registry name not used at the test boundary
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

export type AuthPhase = 'anonymous' | 'authenticating' | 'authenticated';

export const authMachine = $sharedState<{ phase: AuthPhase }>('auth', { phase: 'anonymous' });
// Stryker restore all

export function beginAuth(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(authMachine.value.phase === 'anonymous', 'beginAuth: must start from anonymous');
  authMachine.value = { phase: 'authenticating' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authMachine.value.phase === 'authenticating', 'beginAuth: end in authenticating');
}

export function completeAuth(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(authMachine.value.phase === 'authenticating', 'completeAuth: must be in-flight');
  authMachine.value = { phase: 'authenticated' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authMachine.value.phase === 'authenticated', 'completeAuth: end in authenticated');
}

export function cancelAuth(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(authMachine.value.phase === 'authenticating', 'cancelAuth: only cancels an in-flight attempt');
  authMachine.value = { phase: 'anonymous' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authMachine.value.phase === 'anonymous', 'cancelAuth: end in anonymous');
}

export function signOut(): void {
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  requires(authMachine.value.phase === 'authenticated', 'signOut: must be authenticated');
  authMachine.value = { phase: 'anonymous' };
  // Stryker disable next-line all -- runtime no-op; only meaningful in TLA+ translation
  ensures(authMachine.value.phase === 'anonymous', 'signOut: end in anonymous');
}
