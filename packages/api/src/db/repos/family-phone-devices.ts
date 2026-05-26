import type { DatabaseClient } from '../client.ts';

export interface FamilyPhoneDeviceRow {
  id: number;
  user_id: number;
  label: string;
  kind: 'handset' | 'pwa' | 'agent';
  created_at: string;
  paired_at: string | null;
}

/**
 * Device row joined with its owner's display name. The directory endpoint
 * returns this shape so every row carries enough context to render
 * "Leo's handset (Leo)" without a second round-trip.
 */
export interface FamilyPhoneDeviceWithOwner extends FamilyPhoneDeviceRow {
  owner_display_name: string;
}

export interface FamilyPhoneDevicesRepo {
  insert(input: {
    userId: number;
    label: string;
    kind: 'handset' | 'pwa' | 'agent';
    pairedAt?: string;
  }): FamilyPhoneDeviceRow;
  /** Every device in the household, ordered by owner name then device id. */
  listAllWithOwner(): FamilyPhoneDeviceWithOwner[];
}

export function createFamilyPhoneDevicesRepo(db: DatabaseClient): FamilyPhoneDevicesRepo {
  const insertStmt = db.prepare<FamilyPhoneDeviceRow, [number, string, string, string | null]>(
    `INSERT INTO family_phone_devices (user_id, label, kind, paired_at)
     VALUES (?, ?, ?, ?)
     RETURNING id, user_id, label, kind, created_at, paired_at`,
  );
  const listAllStmt = db.prepare<FamilyPhoneDeviceWithOwner, []>(
    `SELECT d.id, d.user_id, d.label, d.kind, d.created_at, d.paired_at,
            u.display_name AS owner_display_name
     FROM family_phone_devices d
     JOIN users u ON u.id = d.user_id
     ORDER BY u.display_name COLLATE NOCASE, d.id`,
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
    listAllWithOwner(): FamilyPhoneDeviceWithOwner[] {
      return listAllStmt.all();
    },
  };
}
