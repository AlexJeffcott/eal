import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import { createFamilyPhoneChallengesRepo } from '../db/repos/family-phone-challenges.ts';
import { createFamilyPhoneDeviceKeysRepo } from '../db/repos/family-phone-device-keys.ts';
import { createFamilyPhoneDeviceSessionsRepo } from '../db/repos/family-phone-device-sessions.ts';
import {
  authCore,
  challengeCore,
  defaultRandomNonce,
  defaultRandomToken,
  type FamilyPhoneDeviceAuthDeps,
} from './family-phone-device-auth.shared.ts';
import { AuthError } from './auth.shared.ts';

export interface FamilyPhoneDeviceAuthRoutesContext {
  db: DatabaseClient;
}

export function familyPhoneDeviceAuthHttpRoutes(ctx: FamilyPhoneDeviceAuthRoutesContext) {
  const deps: FamilyPhoneDeviceAuthDeps = {
    challenges: createFamilyPhoneChallengesRepo(ctx.db),
    deviceKeys: createFamilyPhoneDeviceKeysRepo(ctx.db),
    sessions: createFamilyPhoneDeviceSessionsRepo(ctx.db),
    now: () => new Date(),
    randomNonce: defaultRandomNonce,
    randomToken: defaultRandomToken,
  };

  return new Elysia({ prefix: '/api/family-phone/device' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .post(
      '/challenge',
      ({ body }) => {
        const result = challengeCore(deps, { deviceId: body.device_id });
        return { nonce: result.nonce, expires_at: result.expiresAt };
      },
      { body: t.Object({ device_id: t.Number() }) },
    )
    .post(
      '/auth',
      async ({ body }) => {
        const result = await authCore(deps, {
          deviceId: body.device_id,
          nonce: body.nonce,
          signature: body.signature,
        });
        return {
          device_id: result.deviceId,
          token: result.token,
          expires_at: result.expiresAt,
        };
      },
      {
        body: t.Object({
          device_id: t.Number(),
          nonce: t.String(),
          signature: t.String(),
        }),
      },
    );
}
