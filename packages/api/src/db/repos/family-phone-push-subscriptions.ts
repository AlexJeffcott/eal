import type { DatabaseClient } from '../client.ts';

/**
 * Web Push subscription rows for family-phone devices. One device may
 * accumulate more than one row across the lifetime of a single browser
 * profile (rare: only when the vendor rotates the subscription's
 * endpoint without the SW unsubscribing first). The push-send path
 * deletes any row whose endpoint returns 404/410, so the table tends
 * back to one-row-per-device on its own.
 */

export interface FamilyPhonePushSubscriptionRow {
  id: number;
  device_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
}

export interface FamilyPhonePushSubscriptionsRepo {
  /** Upsert by endpoint. Same endpoint with new keys updates in place
   * (Bun's SQLite supports ON CONFLICT). */
  upsert(input: {
    deviceId: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): FamilyPhonePushSubscriptionRow;
  listByDevice(deviceId: number): FamilyPhonePushSubscriptionRow[];
  deleteByEndpoint(endpoint: string): boolean;
  deleteByDevice(deviceId: number): number;
}

export function createFamilyPhonePushSubscriptionsRepo(
  db: DatabaseClient,
): FamilyPhonePushSubscriptionsRepo {
  const upsertStmt = db.prepare<
    FamilyPhonePushSubscriptionRow,
    [number, string, string, string]
  >(
    `INSERT INTO family_phone_push_subscriptions (device_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       device_id = excluded.device_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       updated_at = datetime('now')
     RETURNING id, device_id, endpoint, p256dh, auth, created_at, updated_at`,
  );
  const listByDeviceStmt = db.prepare<FamilyPhonePushSubscriptionRow, [number]>(
    `SELECT id, device_id, endpoint, p256dh, auth, created_at, updated_at
     FROM family_phone_push_subscriptions
     WHERE device_id = ?
     ORDER BY id`,
  );
  const deleteByEndpointStmt = db.prepare<unknown, [string]>(
    'DELETE FROM family_phone_push_subscriptions WHERE endpoint = ?',
  );
  const deleteByDeviceStmt = db.prepare<unknown, [number]>(
    'DELETE FROM family_phone_push_subscriptions WHERE device_id = ?',
  );

  return {
    upsert(input): FamilyPhonePushSubscriptionRow {
      const row = upsertStmt.get(input.deviceId, input.endpoint, input.p256dh, input.auth);
      if (!row) {
        throw new Error('family_phone_push_subscriptions.upsert: RETURNING gave no row');
      }
      return row;
    },
    listByDevice(deviceId): FamilyPhonePushSubscriptionRow[] {
      return listByDeviceStmt.all(deviceId);
    },
    deleteByEndpoint(endpoint): boolean {
      return deleteByEndpointStmt.run(endpoint).changes > 0;
    },
    deleteByDevice(deviceId): number {
      return deleteByDeviceStmt.run(deviceId).changes;
    },
  };
}
