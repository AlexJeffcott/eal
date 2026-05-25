import type { DatabaseClient } from '../client.ts';

export interface FamilyPhoneDeviceKeyRow {
  device_id: number;
  public_key: Uint8Array;
  alg: string;
  created_at: string;
}

export interface FamilyPhoneDeviceKeysRepo {
  insert(input: {
    deviceId: number;
    publicKey: Uint8Array;
    alg: string;
  }): FamilyPhoneDeviceKeyRow;
  findByDeviceId(deviceId: number): FamilyPhoneDeviceKeyRow | null;
}

export function createFamilyPhoneDeviceKeysRepo(
  db: DatabaseClient,
): FamilyPhoneDeviceKeysRepo {
  const insertStmt = db.prepare<FamilyPhoneDeviceKeyRow, [number, Uint8Array, string]>(
    `INSERT INTO family_phone_device_keys (device_id, public_key, alg)
     VALUES (?, ?, ?)
     RETURNING device_id, public_key, alg, created_at`,
  );
  const findByDeviceIdStmt = db.prepare<FamilyPhoneDeviceKeyRow, [number]>(
    `SELECT device_id, public_key, alg, created_at
     FROM family_phone_device_keys WHERE device_id = ?`,
  );

  return {
    insert(input): FamilyPhoneDeviceKeyRow {
      const row = insertStmt.get(input.deviceId, input.publicKey, input.alg);
      if (!row) throw new Error('family_phone_device_keys.insert: RETURNING gave no row');
      return row;
    },
    findByDeviceId(deviceId): FamilyPhoneDeviceKeyRow | null {
      return findByDeviceIdStmt.get(deviceId) ?? null;
    },
  };
}
