import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import { createSessionsRepo } from '../auth/sessions.ts';
import { createChallengeStore } from '../auth/challenges.ts';
import { createWebAuthnAdapter, type RpConfig } from '../auth/webauthn.ts';
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
  const deps: AuthDeps = { webauthn, sessions };
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
      ({ body }) => registerOptionsCore(deps, body),
      { body: t.Object({ displayName: t.String() }) },
    )
    .post(
      '/register/verify',
      ({ body }) => registerVerifyCore(deps, { response: body.response }),
      { body: t.Object({ response: t.Any() }) },
    )
    .post('/login/options', () => loginOptionsCore(deps))
    .post(
      '/login/verify',
      ({ body }) => loginVerifyCore(deps, { response: body.response }),
      { body: t.Object({ response: t.Any() }) },
    )
    .post('/cli-pair/start', ({ request }) => {
      // The verification URL the CLI prints needs an origin the user can
      // actually open. We derive it from the incoming request rather than
      // taking it from the body so the CLI cannot pin it.
      const url = new URL(request.url);
      const baseUrl = `${url.protocol}//${url.host}`;
      const result = startCore(cliPairDeps, { baseUrl });
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
      const token = parseBearerToken(request.headers.get('authorization'));
      if (!token) {
        set.status = 401;
        return { error: 'no token' };
      }
      return logoutCore(deps, { token });
    })
    .get('/me', ({ request, set }) => {
      const principal = getPrincipal(request, ctx.db);
      const result = meCore(principal);
      if (!result) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      return result;
    })
    .post(
      '/cli-pair/claim',
      ({ body, request, set }) => {
        const principal = getPrincipal(request, ctx.db);
        if (!principal) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        return claimCore(cliPairDeps, principal, {
          userCode: body.user_code,
          label: body.label,
        });
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
