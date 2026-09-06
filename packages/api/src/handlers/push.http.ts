import { Elysia, t } from 'elysia';
import { AuthError } from './auth.shared.ts';
import { createPushSubscriptionsRepo } from '../db/repos/push-subscriptions.ts';
import type { DatabaseClient } from '../db/client.ts';
import type { GetPrincipalFn } from '../auth/principals.ts';

/**
 * Web Push HTTP surface.
 *
 * Three endpoints:
 *   - GET  /public/push/vapid-public-key  (no auth — the SPA fetches it
 *     on boot to feed pushManager.subscribe; the key is, well, public)
 *   - POST /api/v1/push/subscribe         (authed — persists the signed-in
 *     person's browser subscription)
 *   - POST /api/v1/push/unsubscribe       (authed — clears it)
 *
 * The first is mounted globally by server-factory, because the SPA fetches it
 * before it has an app to ask. The other two belong to the `push` app
 * (apps/push.ts), which owns the `push_subscriptions` table they write to.
 *
 * Two things push in eal, and they do not share a table. A missed call wakes a
 * *device* through `family_phone_push_subscriptions`; a due date reminds a
 * *person* through `push_subscriptions`. See db/repos/push-subscriptions.ts for
 * why the second is not the first with a wider foreign key.
 *
 * VAPID config comes from env. When the keys are unset the public endpoint
 * returns 503 and the reminder scan does not start at all — eal keeps booting
 * so dev environments without a keypair stay usable, but nothing half-works:
 * a subscription can still be stored, and it starts being delivered to the
 * moment the keys are set.
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
 *
 * `env` is a parameter so an app can read the environment server-factory handed
 * it (`ApiAppContext.env`) rather than reaching for the process-wide one — the
 * same reason family-phone takes its trunk config that way. It defaults to
 * `process.env` for the two global call sites that boot before any app exists.
 */
export function loadPushVapidConfig(
  env: NodeJS.ProcessEnv = process.env,
): PushVapidConfig | null {
  const publicKey = env['EAL_VAPID_PUBLIC_KEY']?.trim() ?? '';
  const privateKey = env['EAL_VAPID_PRIVATE_KEY']?.trim() ?? '';
  const subject = env['EAL_VAPID_SUBJECT']?.trim() ?? '';
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

export interface PushSubscriptionRoutesContext {
  db: DatabaseClient;
  getPrincipal: GetPrincipalFn;
}

/**
 * The two authed routes the header comment above has promised since v1.
 *
 * They are the person's half of the reminder path: the browser has granted
 * notification permission and bound a subscription to this server's VAPID key,
 * and this is where that subscription is filed against whoever is signed in.
 *
 * No VAPID guard on either. A subscription stored while the keys are unset is
 * not a half-working feature, it is a row waiting for a deploy — and refusing
 * it would mean every browser had to be re-tapped after the keys were set.
 * Delivery is what the keys gate, and it gates it in one place (apps/push.ts).
 */
export function pushSubscriptionRoutes(ctx: PushSubscriptionRoutesContext) {
  const subscriptions = createPushSubscriptionsRepo(ctx.db);

  function requirePrincipal(request: Request): { userId: number } {
    const principal = ctx.getPrincipal(request);
    if (!principal) throw new AuthError(401, 'unauthenticated');
    return principal;
  }

  return new Elysia({ prefix: '/api/v1/push' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .post(
      '/subscribe',
      ({ body, request }) => {
        const principal = requirePrincipal(request);
        // Each field is checked here rather than by Elysia's own schema: a
        // schema rejection is flattened to a 500 by the onError above, and the
        // browser needs to read which half of the triple it failed to send.
        const endpoint = requireNonEmpty(body.endpoint, 'endpoint');
        const p256dh = requireNonEmpty(body.p256dh, 'p256dh');
        const auth = requireNonEmpty(body.auth, 'auth');
        const row = subscriptions.upsert({
          userId: principal.userId,
          endpoint,
          p256dh,
          auth,
        });
        return { subscription: { endpoint: row.endpoint, createdAt: row.created_at } };
      },
      {
        body: t.Object({
          endpoint: t.String(),
          p256dh: t.String(),
          auth: t.String(),
        }),
      },
    )
    .post(
      '/unsubscribe',
      ({ body, request }) => {
        requirePrincipal(request);
        const endpoint = requireNonEmpty(body.endpoint, 'endpoint');
        // Deleted by endpoint alone, without checking who owns it. The endpoint
        // is a vendor-minted secret capability — anyone holding it can already
        // push to that browser — and the browser that just called
        // `unsubscribe()` on it is telling the truth about it being dead.
        // Scoping the delete to the caller would strand the row when a shared
        // browser changes hands, which is the case the upsert already handles
        // by moving ownership.
        const removed = subscriptions.deleteByEndpoint(endpoint);
        return { removed };
      },
      { body: t.Object({ endpoint: t.String() }) },
    );
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new AuthError(400, `${field} is required`);
  return trimmed;
}
