import type { DatabaseClient } from '../client.ts';

export interface FamilyPhoneDeviceSessionRow {
  token_hash: Uint8Array;
  device_id: number;
  created_at: string;
  expires_at: string;
  last_used_at: string;
}

export interface FamilyPhoneDeviceSessionsRepo {
  insert(input: {
    tokenHash: Uint8Array;
    deviceId: number;
    expiresAt: string;
  }): FamilyPhoneDeviceSessionRow;
}

export function createFamilyPhoneDeviceSessionsRepo(
  db: DatabaseClient,
): FamilyPhoneDeviceSessionsRepo {
  const insertStmt = db.prepare<FamilyPhoneDeviceSessionRow, [Uint8Array, number, string]>(
    `INSERT INTO family_phone_device_sessions (token_hash, device_id, expires_at)
     VALUES (?, ?, ?)
     RETURNING token_hash, device_id, created_at, expires_at, last_used_at`,
  );

  return {
    insert(input): FamilyPhoneDeviceSessionRow {
      const row = insertStmt.get(input.tokenHash, input.deviceId, input.expiresAt);
      if (!row) throw new Error('family_phone_device_sessions.insert: RETURNING gave no row');
      return row;
    },
  };
}
