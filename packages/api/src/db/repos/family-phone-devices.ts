import type { DatabaseClient } from '../client.ts';

export interface FamilyPhoneDeviceRow {
  id: number;
  user_id: number;
  label: string;
  kind: 'handset' | 'pwa' | 'agent';
  created_at: string;
  paired_at: string | null;
}

export interface FamilyPhoneDevicesRepo {
  insert(input: {
    userId: number;
    label: string;
    kind: 'handset' | 'pwa' | 'agent';
    pairedAt?: string;
  }): FamilyPhoneDeviceRow;
  listByUserId(userId: number): FamilyPhoneDeviceRow[];
}

export function createFamilyPhoneDevicesRepo(db: DatabaseClient): FamilyPhoneDevicesRepo {
  const insertStmt = db.prepare<FamilyPhoneDeviceRow, [number, string, string, string | null]>(
    `INSERT INTO family_phone_devices (user_id, label, kind, paired_at)
     VALUES (?, ?, ?, ?)
     RETURNING id, user_id, label, kind, created_at, paired_at`,
  );
  const listByUserIdStmt = db.prepare<FamilyPhoneDeviceRow, [number]>(
    `SELECT id, user_id, label, kind, created_at, paired_at
     FROM family_phone_devices WHERE user_id = ? ORDER BY id ASC`,
  );

  return {
    insert(input): FamilyPhoneDeviceRow {
      const row = insertStmt.get(
        input.userId,
        input.label,
        input.kind,
        input.pairedAt ?? null,
      );
      if (!row) throw new Error('family_phone_devices.insert: RETURNING gave no row');
      return row;
    },
    listByUserId(userId): FamilyPhoneDeviceRow[] {
      return listByUserIdStmt.all(userId);
    },
  };
}
