import { Elysia } from 'elysia';
import type { GetPrincipalFn, Principal } from './principals.ts';

/**
 * Elysia plugin that decorates every request with `principal: Principal | null`.
 * Handlers consume it via `.get('/x', ({ principal }) => ...)`.
 *
 * The `getPrincipalFn` is injected so `createApp` (production) and
 * `createTestApp` (tests) can each supply their own implementation.
 */
export function authMiddleware(getPrincipalFn: GetPrincipalFn) {
  return new Elysia({ name: 'eal-auth' }).derive(({ request }): { principal: Principal | null } => ({
    principal: getPrincipalFn(request),
  }));
}
