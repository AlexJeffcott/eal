import { Elysia, t } from 'elysia';
import { ensures, requires } from '@fairfox/polly/verify';
import type { DatabaseClient } from '../db/client.ts';
import { createSessionsRepo } from '../auth/sessions.ts';
import { createChallengeStore } from '../auth/challenges.ts';
import { createWebAuthnAdapter, type RpConfig } from '../auth/webauthn.ts';
import {
  createRegistrationThrottle,
  type RegistrationConfig,
} from '../auth/registration.ts';
import { authMachine } from '../specs/auth-machine.ts';
import { sessionsMachine } from '../specs/sessions-machine.ts';

// Polly anchor flag. False at runtime — production never mutates the shadow
// `auth.phase` signal. Polly's static extractor reads the guarded assignments
// to link these handlers to the shadow auth-machine for TLC. See
// specs/verification.config.ts and packages/api/src/specs/auth-machine.ts.
const POLLY_ANCHOR = process.env['POLLY_VERIFY'] === '1';
import {
  AuthError,
  loginOptionsCore,
  loginVerifyCore,
  logoutCore,
  meCore,
  registerOptionsCore,
  registerVerifyCore,
  type AuthDeps,
} from './auth.shared.ts';
import { createCliPairingsRepo } from '../db/repos/cli-pairings.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import {
  claimCore,
  defaultRandomDeviceCode,
  defaultRandomUserCode,
  pollCore,
  startCore,
  type CliPairDeps,
} from './cli-pair.shared.ts';
import { getPrincipal } from '../auth/principals.ts';

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.trim().match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export interface AuthRoutesContext {
  db: DatabaseClient;
  rp: RpConfig;
  /**
   * The registration gate. Passed in rather than read from the environment
   * here, so a test configures it explicitly and a developer's `.env` cannot
   * decide whether the door is open. See `../auth/registration.ts`.
   */
  registration: RegistrationConfig;
}

/**
 * Auth HTTP routes — split into two plugins so the gating middleware can mount
 * the public ceremonies (register/login) under `/public/auth/*` and the authed
 * operations (me/logout) under `/api/v1/auth/*`. The challenge store + adapter
 * are shared between both halves.
 */
export function authHttpRoutes(ctx: AuthRoutesContext) {
  const challenges = createChallengeStore();
  const sessions = createSessionsRepo(ctx.db);
  const webauthn = createWebAuthnAdapter(ctx.db, challenges, ctx.rp);
  const deps: AuthDeps = {
    webauthn,
    sessions,
    registration: ctx.registration,
    // One throttle per route tree, so its window lives as long as the server.
    registrationThrottle: createRegistrationThrottle(),
  };
  const cliPairDeps: CliPairDeps = {
    sessions,
    pairings: createCliPairingsRepo(ctx.db),
    users: createUsersRepo(ctx.db),
    now: () => new Date(),
    randomUserCode: defaultRandomUserCode,
    randomDeviceCode: defaultRandomDeviceCode,
  };

  const publicRoutes = new Elysia({ prefix: '/public/auth' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .post(
      '/register/options',
      async ({ body }) => {
        requires(authMachine.value.phase !== 'authenticated', 'register/options: not already authenticated');
        if (POLLY_ANCHOR) authMachine.value = { phase: 'authenticating' };
        const result = await registerOptionsCore(deps, body);
        ensures(authMachine.value.phase === 'authenticating', 'register/options: in-flight');
        return result;
      },
      // `inviteCode` is optional on the wire so a caller that omits it gets the
      // handler's own 403, not Elysia's 422 shape. The gate treats a missing
      // code exactly as a wrong one.
      { body: t.Object({ displayName: t.String(), inviteCode: t.Optional(t.String()) }) },
    )
    .post(
      '/register/verify',
      async ({ body }) => {
        requires(authMachine.value.phase === 'authenticating', 'register/verify: must follow register/options');
        requires(sessionsMachine.value.outstanding < 2, 'register/verify: session capacity available');
        const result = await registerVerifyCore(deps, { response: body.response });
        if (POLLY_ANCHOR) authMachine.value = { phase: 'authenticated' };
        if (POLLY_ANCHOR) sessionsMachine.value = { outstanding: sessionsMachine.value.outstanding + 1 };
        ensures(authMachine.value.phase === 'authenticated', 'register/verify: authenticated');
        ensures(sessionsMachine.value.outstanding >= 1, 'register/verify: session minted');
        return result;
      },
      { body: t.Object({ response: t.Any() }) },
    )
    .post('/login/options', async () => {
      requires(authMachine.value.phase !== 'authenticated', 'login/options: not already authenticated');
      if (POLLY_ANCHOR) authMachine.value = { phase: 'authenticating' };
      const result = await loginOptionsCore(deps);
      ensures(authMachine.value.phase === 'authenticating', 'login/options: in-flight');
      return result;
    })
    .post(
      '/login/verify',
      async ({ body }) => {
        requires(authMachine.value.phase === 'authenticating', 'login/verify: must follow login/options');
        requires(sessionsMachine.value.outstanding < 2, 'login/verify: session capacity available');
        const result = await loginVerifyCore(deps, { response: body.response });
        if (POLLY_ANCHOR) authMachine.value = { phase: 'authenticated' };
        if (POLLY_ANCHOR) sessionsMachine.value = { outstanding: sessionsMachine.value.outstanding + 1 };
        ensures(authMachine.value.phase === 'authenticated', 'login/verify: authenticated');
        ensures(sessionsMachine.value.outstanding >= 1, 'login/verify: session minted');
        return result;
      },
      { body: t.Object({ response: t.Any() }) },
    )
    .post('/cli-pair/start', () => {
      // The verification URL the CLI prints needs an origin the user can
      // actually open, and it carries a single-use pairing code. It comes from
      // the configured public origin (`EAL_ORIGIN`, the same value the
      // WebAuthn RP is derived from) — never from the request.
      //
      // Deriving it from the request printed `http://eal.fly.dev/…` in
      // production: the platform proxy terminates TLS and forwards plain HTTP,
      // so `url.protocol` inside the container reads `http:`. The link worked
      // only because the proxy redirects, and a client that does not follow
      // redirects would have sent the code in clear.
      const result = startCore(cliPairDeps, { baseUrl: ctx.rp.origin });
      return {
        user_code: result.userCode,
        device_code: result.deviceCode,
        verification_url: result.verificationUrl,
        poll_interval_ms: result.pollIntervalMs,
        expires_at: result.expiresAtIso,
      };
    })
    .post(
      '/cli-pair/poll',
      ({ body }) => {
        const result = pollCore(cliPairDeps, { deviceCode: body.device_code });
        if (result.status === 'authorized') {
          return {
            status: 'authorized' as const,
            token: result.token,
            user: { id: result.user.id, display_name: result.user.displayName },
          };
        }
        return { status: result.status };
      },
      { body: t.Object({ device_code: t.String() }) },
    );

  const authedRoutes = new Elysia({ prefix: '/api/v1/auth' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .post('/logout', ({ request, set }) => {
      requires(authMachine.value.phase === 'authenticated', 'logout: must be authenticated');
      requires(sessionsMachine.value.outstanding > 0, 'logout: must have a session to revoke');
      const token = parseBearerToken(request.headers.get('authorization'));
      if (!token) {
        set.status = 401;
        return { error: 'no token' };
      }
      const result = logoutCore(deps, { token });
      if (POLLY_ANCHOR) authMachine.value = { phase: 'anonymous' };
      if (POLLY_ANCHOR) sessionsMachine.value = { outstanding: sessionsMachine.value.outstanding - 1 };
      ensures(authMachine.value.phase === 'anonymous', 'logout: back to anonymous');
      ensures(sessionsMachine.value.outstanding >= 0, 'logout: session revoked');
      return result;
    })
    .get('/me', ({ request, set }) => {
      requires(authMachine.value.phase === 'authenticated', 'me: must be authenticated');
      const principal = getPrincipal(request, ctx.db);
      const result = meCore(principal);
      if (!result) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      ensures(authMachine.value.phase === 'authenticated', 'me: still authenticated');
      return result;
    })
    .post(
      '/cli-pair/claim',
      ({ body, request, set }) => {
        requires(sessionsMachine.value.outstanding < 2, 'cli-pair/claim: session capacity available');
        const principal = getPrincipal(request, ctx.db);
        if (!principal) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const result = claimCore(cliPairDeps, principal, {
          userCode: body.user_code,
          label: body.label,
        });
        if (POLLY_ANCHOR) sessionsMachine.value = { outstanding: sessionsMachine.value.outstanding + 1 };
        ensures(sessionsMachine.value.outstanding >= 1, 'cli-pair/claim: session minted');
        return result;
      },
      {
        body: t.Object({
          user_code: t.String(),
          label: t.String(),
        }),
      },
    );

  return { public: publicRoutes, authed: authedRoutes };
}
