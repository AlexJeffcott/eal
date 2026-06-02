import type { DatabaseClient } from '../client.ts';

export type FamilyPhoneDeviceKind = 'handset' | 'pwa' | 'agent' | 'pstn' | 'household';

export interface FamilyPhoneDeviceRow {
  id: number;
  /**
   * Owning user. Null only for kind='pstn' (remote phone number) and
   * kind='household' (the single user-less inbox row for the no-IVR-
   * selection / unknown-caller path) — the schema CHECK enforces this.
   */
  user_id: number | null;
  label: string;
  kind: FamilyPhoneDeviceKind;
  created_at: string;
  paired_at: string | null;
}

/**
 * Device row joined with its owner's display name. The directory endpoint
 * returns this shape so every row carries enough context to render
 * "Leo's handset (Leo)" without a second round-trip. Excludes kind='pstn'
 * rows because they have no owner — the household directory paints
 * humans-and-their-devices only.
 */
export interface FamilyPhoneDeviceWithOwner extends FamilyPhoneDeviceRow {
  user_id: number;
  owner_display_name: string;
}

export interface FamilyPhoneDevicesRepo {
  insert(input: {
    userId: number;
    label: string;
    kind: Exclude<FamilyPhoneDeviceKind, 'pstn' | 'household'>;
    pairedAt?: string;
  }): FamilyPhoneDeviceRow;
  /**
   * The singleton kind='household' row provisioned by
   * `ensureHouseholdDevice` on schema apply. Voicemails for the
   * unknown-caller / no-IVR-selection path use its id as
   * `to_device_id`; every paired browser subscribes to it client-
   * side. Throws if the migration hasn't run.
   */
  getHouseholdDevice(): FamilyPhoneDeviceRow;
  /**
   * Materialise (or fetch) the device row that represents an inbound or
   * outbound PSTN counterparty. Keyed by E.164 via the partial unique
   * index on (label) WHERE kind='pstn'. Always returns the canonical row
   * — fresh insert on first sight, existing row otherwise.
   */
  upsertPstnByE164(e164: string): FamilyPhoneDeviceRow;
  /**
   * Every household device (kind != 'pstn'), ordered by owner name then
   * device id. PSTN rows are excluded — they are per-call ephemera with
   * no human owner and the directory UI does not surface them.
   */
  listAllWithOwner(): FamilyPhoneDeviceWithOwner[];
  findById(id: number): FamilyPhoneDeviceRow | null;
  /** Set a new label on an existing device. Returns the patched row,
   * or null when the id doesn't exist. */
  renameById(id: number, label: string): FamilyPhoneDeviceRow | null;
  /** Removes the device. ON DELETE CASCADE clears its key, challenges, sessions. */
  deleteById(id: number): boolean;
}

export function createFamilyPhoneDevicesRepo(db: DatabaseClient): FamilyPhoneDevicesRepo {
  const insertStmt = db.prepare<FamilyPhoneDeviceRow, [number, string, string, string | null]>(
    `INSERT INTO family_phone_devices (user_id, label, kind, paired_at)
     VALUES (?, ?, ?, ?)
     RETURNING id, user_id, label, kind, created_at, paired_at`,
  );
  // The partial unique index on (label) WHERE kind='pstn' makes this a
  // safe upsert keyed by E.164. ON CONFLICT(label) is rejected by SQLite
  // for a partial index target, so the lookup-then-insert pattern lives
  // inside a transaction below to keep concurrent calls from racing.
  const findPstnStmt = db.prepare<FamilyPhoneDeviceRow, [string]>(
    `SELECT id, user_id, label, kind, created_at, paired_at
       FROM family_phone_devices
      WHERE kind = 'pstn' AND label = ?`,
  );
  const insertPstnStmt = db.prepare<FamilyPhoneDeviceRow, [string]>(
    `INSERT INTO family_phone_devices (user_id, label, kind)
     VALUES (NULL, ?, 'pstn')
     RETURNING id, user_id, label, kind, created_at, paired_at`,
  );
  const listAllStmt = db.prepare<FamilyPhoneDeviceWithOwner, []>(
    `SELECT d.id, d.user_id, d.label, d.kind, d.created_at, d.paired_at,
            u.display_name AS owner_display_name
     FROM family_phone_devices d
     JOIN users u ON u.id = d.user_id
     WHERE d.kind NOT IN ('pstn','household')
     ORDER BY u.display_name COLLATE NOCASE, d.id`,
  );
  const householdStmt = db.prepare<FamilyPhoneDeviceRow, []>(
    `SELECT id, user_id, label, kind, created_at, paired_at
       FROM family_phone_devices WHERE kind = 'household' LIMIT 1`,
  );
  const findByIdStmt = db.prepare<FamilyPhoneDeviceRow, [number]>(
    `SELECT id, user_id, label, kind, created_at, paired_at
     FROM family_phone_devices WHERE id = ?`,
  );
  const deleteByIdStmt = db.prepare<unknown, [number]>(
    'DELETE FROM family_phone_devices WHERE id = ?',
  );
  const renameByIdStmt = db.prepare<FamilyPhoneDeviceRow, [string, number]>(
    `UPDATE family_phone_devices
     SET label = ?
     WHERE id = ?
     RETURNING id, user_id, label, kind, created_at, paired_at`,
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
    getHouseholdDevice(): FamilyPhoneDeviceRow {
      const row = householdStmt.get();
      if (!row) {
        throw new Error(
          'family_phone_devices.getHouseholdDevice: no household row — applySchema must run before this is called.',
        );
      }
      return row;
    },
    upsertPstnByE164(e164): FamilyPhoneDeviceRow {
      const existing = findPstnStmt.get(e164);
      if (existing) return existing;
      const inserted = insertPstnStmt.get(e164);
      if (!inserted) {
        throw new Error('family_phone_devices.upsertPstnByE164: RETURNING gave no row');
      }
      return inserted;
    },
    listAllWithOwner(): FamilyPhoneDeviceWithOwner[] {
      return listAllStmt.all();
    },
    findById(id): FamilyPhoneDeviceRow | null {
      return findByIdStmt.get(id) ?? null;
    },
    renameById(id, label): FamilyPhoneDeviceRow | null {
      return renameByIdStmt.get(label, id) ?? null;
    },
    deleteById(id): boolean {
      return deleteByIdStmt.run(id).changes > 0;
    },
  };
}
