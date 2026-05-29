import { Elysia, t } from 'elysia';
import { ensures, requires } from '@fairfox/polly/verify';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { pairingMachine } from '../specs/pairing-machine.ts';

const POLLY_ANCHOR = process.env['POLLY_VERIFY'] === '1';
import { createFamilyPhonePairingsRepo } from '../db/repos/family-phone-pairings.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { createFamilyPhoneDeviceKeysRepo } from '../db/repos/family-phone-device-keys.ts';
import {
  completeCore,
  defaultRandomUserCode,
  startCore,
  type FamilyPhonePairDeps,
} from './family-phone-pair.shared.ts';
import { AuthError } from './auth.shared.ts';

export interface FamilyPhonePairRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
  /** Notify connected family-phone WS clients that the directory grew. */
  onDirectoryChanged: () => void;
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const bytes = Uint8Array.from(atob(padded + '='.repeat(padLen)), (c) => c.charCodeAt(0));
    return bytes;
  } catch {
    return null;
  }
}

export function familyPhonePairHttpRoutes(ctx: FamilyPhonePairRoutesContext) {
  const deps: FamilyPhonePairDeps = {
    db: ctx.db,
    pairings: createFamilyPhonePairingsRepo(ctx.db),
    devices: createFamilyPhoneDevicesRepo(ctx.db),
    deviceKeys: createFamilyPhoneDeviceKeysRepo(ctx.db),
    now: () => new Date(),
    randomUserCode: defaultRandomUserCode,
  };

  return new Elysia({ prefix: '/api/family-phone/pair' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .post(
      '/start',
      ({ request, set }) => {
        requires(pairingMachine.value.state !== 'pending', 'pair/start: no in-flight pairing');
        const principal = ctx.getPrincipal(request);
        if (!principal) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const result = startCore(deps, principal);
        if (POLLY_ANCHOR) pairingMachine.value = { state: 'pending' };
        ensures(pairingMachine.value.state === 'pending', 'pair/start: pending');
        return { user_code: result.userCode, expires_at: result.expiresAt };
      },
    )
    .post(
      '/complete',
      ({ body, request, set }) => {
        requires(pairingMachine.value.state === 'pending', 'pair/complete: requires pending pair');
        const publicKey = decodeBase64Url(body.public_key);
        if (!publicKey) {
          set.status = 400;
          return { error: 'public_key must be base64url-encoded' };
        }
        // The route is ownsAuthFor-exempt so an unauthed joiner can pair,
        // but if the joiner *is* signed in (which is the usual case — they
        // had to register via WebAuthn before navigating here) the new
        // device should be owned by them, not by the inviter who minted
        // the code.
        const joiner = ctx.getPrincipal(request);
        const result = completeCore(deps, {
          userCode: body.user_code,
          publicKey,
          alg: body.alg,
          label: body.label,
          kind: body.kind,
          ...(joiner ? { overrideOwnerUserId: joiner.userId } : {}),
        });
        ctx.onDirectoryChanged();
        if (POLLY_ANCHOR) pairingMachine.value = { state: 'consumed' };
        ensures(pairingMachine.value.state === 'consumed', 'pair/complete: consumed');
        return { device_id: result.deviceId };
      },
      {
        body: t.Object({
          user_code: t.String(),
          public_key: t.String(),
          alg: t.String(),
          label: t.String(),
          kind: t.Union([t.Literal('handset'), t.Literal('pwa'), t.Literal('agent')]),
        }),
      },
    );
}
