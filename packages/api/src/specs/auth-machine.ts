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
 * ╔════════════════════════ ANCHORING ════════════════════════════════╗
 * ║ The HTTP route handlers in handlers/auth.http.ts now carry        ║
 * ║ inline `requires` / `ensures` and guarded `authMachine.value =`   ║
 * ║ assignments mirroring the transitions below. Polly's static       ║
 * ║ extractor walks the route bodies (not callees), so the anchor     ║
 * ║ has to live in the route function itself.                         ║
 * ║                                                                   ║
 * ║ The guarded assignments fire only when `POLLY_VERIFY=1` at        ║
 * ║ runtime — in normal serving they are dead branches. Polly's       ║
 * ║ analyzer is static and sees them regardless. `requires` /         ║
 * ║ `ensures` are runtime no-ops from `@fairfox/polly/verify` so      ║
 * ║ unguarded calls are also safe.                                    ║
 * ║                                                                   ║
 * ║ Anchored routes (auth subsystem):                                 ║
 * ║   POST /register/options  → anonymous → authenticating            ║
 * ║   POST /register/verify   → authenticating → authenticated        ║
 * ║   POST /login/options     → anonymous → authenticating            ║
 * ║   POST /login/verify      → authenticating → authenticated        ║
 * ║   POST /logout            → authenticated → anonymous             ║
 * ║   GET  /me                → authenticated → authenticated         ║
 * ║                                                                   ║
 * ║ The transition helpers below stay as the canonical shadow         ║
 * ║ machine and are exercised by `auth-machine.test.ts`.              ║
 * ║                                                                   ║
 * ║ The other six machines (ws, sessions, taskStatus, authGate,       ║
 * ║ pairing, call) still need the same anchoring on their respective  ║
 * ║ handlers — pattern in handlers/auth.http.ts.                      ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 */
// Stryker disable all -- declared initial value is overwritten by every test beforeEach; registry name not used at the test boundary
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

export type AuthPhase = 'anonymous' | 'authenticating' | 'authenticated';

export const authMachine = $sharedState<{ phase: AuthPhase }>('authMachine', { phase: 'anonymous' });
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
