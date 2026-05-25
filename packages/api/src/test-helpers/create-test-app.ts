import { Elysia } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import { getPrincipal, type GetPrincipalFn, type Principal } from '../auth/principals.ts';
import { createAppInternal } from '../server-factory.ts';
import type { RpConfig } from '../auth/webauthn.ts';
import type { ApiApp } from '../apps/types.ts';

/**
 * Fixed RP for the test tier. Production derives the RP origin from the
 * required PORT env var; tests pass this explicit config so they never depend
 * on the environment. Port 4321 matches the documented local dev port.
 */
const TEST_RP: RpConfig = {
  rpID: 'localhost',
  rpName: 'eal',
  origin: 'https://localhost:4321',
};

export type PrincipalOverride =
  | Principal
  | null
  | GetPrincipalFn
  | undefined;

interface CreateTestAppOptions {
  principalOverride?: PrincipalOverride;
  /**
   * Skip the SPA bundle build. Defaults to true: tests rarely exercise the
   * HTML shell, and `Bun.build` resolves workspace deps from cwd which makes
   * api tests fragile when run from the project root. Set to false when the
   * test specifically needs to serve `/public/*` HTML.
   */
  skipSpaBuild?: boolean;
  /**
   * Override the installed apps. Defaults to the production `API_APPS`. Pass
   * a custom array to exercise the apps surface (ownsAuthFor, route
   * composition) in isolation from the production registry.
   */
  apps?: readonly ApiApp[];
}

function resolveGetPrincipal(
  db: DatabaseClient,
  override: PrincipalOverride,
): GetPrincipalFn {
  if (override === undefined) {
    return (request) => getPrincipal(request, db);
  }
  if (override === null) {
    return () => null;
  }
  if (typeof override === 'function') {
    return override;
  }
  return () => override;
}

/**
 * Test-only factory that constructs the full Elysia app but swaps in a
 * principal-resolution function chosen by the caller.
 *
 * - `principalOverride: undefined` → real `getPrincipal` (parity tests want the full auth path)
 * - `principalOverride: null`      → always-anonymous
 * - `principalOverride: Principal` → always-this-principal
 * - `principalOverride: (req) => …`→ fully programmable
 *
 * Production code never imports this module. The `scripts/check-no-test-app-in-prod.ts`
 * lint script gates that contract.
 */
export function createTestApp(db: DatabaseClient, options: CreateTestAppOptions = {}) {
  const skipSpa = options.skipSpaBuild ?? true;
  const noopSpa = skipSpa ? new Elysia() : undefined;
  return createAppInternal(db, resolveGetPrincipal(db, options.principalOverride), {
    rp: TEST_RP,
    ...(noopSpa ? { spa: noopSpa } : {}),
    ...(options.apps ? { apps: options.apps } : {}),
  });
}
