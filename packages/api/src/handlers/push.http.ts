import { Elysia } from 'elysia';
import { AuthError } from './auth.shared.ts';

/**
 * Web Push HTTP surface.
 *
 * Three endpoints:
 *   - GET  /public/push/vapid-public-key  (no auth — the SPA fetches it
 *     on boot to feed pushManager.subscribe; the key is, well, public)
 *   - POST /api/v1/push/subscribe         (authed — persists a device's
 *     subscription)
 *   - POST /api/v1/push/unsubscribe       (authed — clears it)
 *
 * The actual web-push delivery doesn't live here. It happens inside
 * the family-phone ws handler when an incoming `call:invite` finds
 * the target device offline. That's the only event that pushes in
 * v1; other features can opt in later.
 *
 * VAPID config comes from env. When the keys are unset the public
 * endpoint returns 503 and subscribe/unsubscribe are no-ops — eal
 * keeps booting so dev environments without a keypair stay usable.
 */

export interface PushVapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Read the VAPID config from env. Returns null when no keys are set;
 * throws when the set is half-configured (the common deploy mistake).
 * Subject must start with `mailto:` or `https://` — vendors require
 * a reachable contact on every push.
 */
export function loadPushVapidConfig(): PushVapidConfig | null {
  const publicKey = process.env['EAL_VAPID_PUBLIC_KEY']?.trim() ?? '';
  const privateKey = process.env['EAL_VAPID_PRIVATE_KEY']?.trim() ?? '';
  const subject = process.env['EAL_VAPID_SUBJECT']?.trim() ?? '';
  const set = [publicKey, privateKey, subject].filter((v) => v !== '').length;
  if (set === 0) return null;
  if (set !== 3) {
    throw new Error(
      'EAL_API: EAL_VAPID_{PUBLIC_KEY,PRIVATE_KEY,SUBJECT} must all be set together or none of them.',
    );
  }
  if (!/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error(
      `EAL_API: EAL_VAPID_SUBJECT must start with "mailto:" or "https://" (got ${JSON.stringify(subject)}).`,
    );
  }
  return { publicKey, privateKey, subject };
}

export interface PushRoutesContext {
  vapid: PushVapidConfig | null;
}

export function pushHttpRoutes(ctx: PushRoutesContext) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .get('/public/push/vapid-public-key', ({ set }) => {
      if (!ctx.vapid) {
        set.status = 503;
        return { error: 'VAPID not configured' };
      }
      // The key is stable per deploy; hour-long cache is plenty and
      // saves the SPA a round-trip on every boot.
      set.headers['cache-control'] = 'public, max-age=3600';
      return { publicKey: ctx.vapid.publicKey };
    });
}
