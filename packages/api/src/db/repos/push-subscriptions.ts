import type { DatabaseClient } from '../client.ts';

/**
 * Web Push subscriptions owned by a *person*, not by a device row.
 *
 * Deliberately not `family_phone_push_subscriptions`, which this table sits
 * beside rather than replaces. That one's foreign key is a
 * `family_phone_devices(id)` — a handset paired into the call directory — and
 * its only sender is the missed-call wake path. A due-date reminder is
 * addressed to whoever the task belongs to, on whatever browser they granted
 * notifications in, and most of those browsers will never pair as a phone. The
 * two lifetimes are different too: unpairing a handset should stop it ringing
 * for calls without also silencing that person's task deadlines.
 *
 * One row per (person, browser-vendor endpoint). `endpoint` is the natural
 * unique key — the vendor mints a new one per browser profile, and a key
 * rotation temporarily leaves two rows for one person until the old endpoint
 * answers 404/410 and the sender drops it.
 */

export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
}

export interface PushSubscriptionsRepo {
  /**
   * Upsert by endpoint. The same endpoint re-registered with fresh keys
   * updates in place, and re-registered by a different person moves — a shared
   * browser profile signed into a second account must not keep pushing the
   * first person's deadlines to it.
   */
  upsert(input: {
    userId: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): PushSubscriptionRow;
  listByUser(userId: number): PushSubscriptionRow[];
  /** Every subscription in the household — the fan-out for an unassigned task. */
  listAll(): PushSubscriptionRow[];
  deleteByEndpoint(endpoint: string): boolean;
  deleteByUser(userId: number): number;
}

const COLS = 'id, user_id, endpoint, p256dh, auth, created_at, updated_at';

export function createPushSubscriptionsRepo(db: DatabaseClient): PushSubscriptionsRepo {
  const upsertStmt = db.prepare<PushSubscriptionRow, [number, string, string, string]>(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       updated_at = datetime('now')
     RETURNING ${COLS}`,
  );
  const listByUserStmt = db.prepare<PushSubscriptionRow, [number]>(
    `SELECT ${COLS} FROM push_subscriptions WHERE user_id = ? ORDER BY id`,
  );
  const listAllStmt = db.prepare<PushSubscriptionRow, []>(
    `SELECT ${COLS} FROM push_subscriptions ORDER BY id`,
  );
  const deleteByEndpointStmt = db.prepare<unknown, [string]>(
    'DELETE FROM push_subscriptions WHERE endpoint = ?',
  );
  const deleteByUserStmt = db.prepare<unknown, [number]>(
    'DELETE FROM push_subscriptions WHERE user_id = ?',
  );

  return {
    upsert(input): PushSubscriptionRow {
      const row = upsertStmt.get(input.userId, input.endpoint, input.p256dh, input.auth);
      if (!row) throw new Error('push_subscriptions.upsert: RETURNING gave no row');
      return row;
    },
    listByUser(userId): PushSubscriptionRow[] {
      return listByUserStmt.all(userId);
    },
    listAll(): PushSubscriptionRow[] {
      return listAllStmt.all();
    },
    deleteByEndpoint(endpoint): boolean {
      return deleteByEndpointStmt.run(endpoint).changes > 0;
    },
    deleteByUser(userId): number {
      return deleteByUserStmt.run(userId).changes;
    },
  };
}
