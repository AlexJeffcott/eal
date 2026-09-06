import { loadPushVapidConfig, pushSubscriptionRoutes } from '../handlers/push.http.ts';
import {
  createTaskReminderTick,
  createWebPushSender,
  resolveReminderTickMs,
  startReminderLoop,
} from '../handlers/task-reminders.ts';
import type { ApiApp } from './types.ts';

/**
 * The push app — the person-level half of Web Push, and the due-date reminder
 * scan that is its first consumer.
 *
 * It owns one table and one background loop. The table is not
 * `family_phone_push_subscriptions`, whose foreign key is a paired handset;
 * see db/repos/push-subscriptions.ts for the argument.
 */
const SCHEMA = `
-- One row per (person, browser-vendor push endpoint). Endpoint is the natural
-- unique key: the vendor mints one per browser profile, and a key rotation
-- briefly leaves two rows for one person until the old endpoint answers
-- 404/410 and the sender drops it. ON DELETE CASCADE because a subscription
-- addressed to a person who no longer exists is addressed to nobody.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT    NOT NULL UNIQUE,
  p256dh      TEXT    NOT NULL,
  auth        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions (user_id);
`;

export const pushApp: ApiApp = {
  id: 'push',
  schema: SCHEMA,
  routes: (ctx) => pushSubscriptionRoutes({ db: ctx.db, getPrincipal: ctx.getPrincipal }),
  start: (ctx) => {
    // All three VAPID values or none — `loadPushVapidConfig` throws on the
    // half-configured set, which is the deploy mistake worth failing the boot
    // for. With none of them set there is no identity to sign a push with, so
    // the scan does not start: an instance that cannot deliver must not pretend
    // to, and stamping `reminded_at` on rows nobody was told about would
    // silently swallow every deadline until the keys arrived.
    const vapid = loadPushVapidConfig(ctx.env);
    if (vapid === null) {
      console.warn(
        '[reminders] EAL_VAPID_{PUBLIC_KEY,PRIVATE_KEY,SUBJECT} are unset — ' +
          'due-date reminders are off. Subscriptions are still accepted and ' +
          'start being delivered as soon as the keys are set.',
      );
      return null;
    }
    const intervalMs = resolveReminderTickMs(ctx.env);
    const tick = createTaskReminderTick({ db: ctx.db, send: createWebPushSender(vapid) });
    console.log(`[reminders] due-date scan every ${intervalMs}ms`);
    return startReminderLoop({ tick, intervalMs, label: 'reminders' });
  },
};
