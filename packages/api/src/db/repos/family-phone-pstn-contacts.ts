import type { DatabaseClient } from '../client.ts';

export interface PstnContactRow {
  id: number;
  e164: string;
  label: string;
  allow_in: 0 | 1;
  allow_out: 0 | 1;
  /**
   * The household member this contact was calling for, when known.
   * Inbound calls from this E.164 ring only that user's online
   * handsets and route any voicemail to their inbox. Null when the
   * contact has no intended recipient — the call falls through to
   * the DTMF IVR.
   */
  intended_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface InsertPstnContactInput {
  e164: string;
  label: string;
  allowIn: boolean;
  allowOut: boolean;
  intendedUserId?: number | null;
}

export interface UpdatePstnContactInput {
  id: number;
  label: string;
  allowIn: boolean;
  allowOut: boolean;
  intendedUserId?: number | null;
}

export interface PstnContactsRepo {
  insert(input: InsertPstnContactInput): PstnContactRow;
  /** Patch label + allow flags + intended recipient. e164 is immutable
   *  — a different number is a different contact, so the caller
   *  deletes + reinserts to change it. */
  update(input: UpdatePstnContactInput): PstnContactRow | null;
  findById(id: number): PstnContactRow | null;
  findByE164(e164: string): PstnContactRow | null;
  listAll(): PstnContactRow[];
  deleteById(id: number): boolean;
}

const COLS =
  'id, e164, label, allow_in, allow_out, intended_user_id, created_at, updated_at';

export function createPstnContactsRepo(db: DatabaseClient): PstnContactsRepo {
  const insertStmt = db.prepare<
    PstnContactRow,
    [string, string, 0 | 1, 0 | 1, number | null]
  >(
    `INSERT INTO family_phone_pstn_contacts (e164, label, allow_in, allow_out, intended_user_id)
     VALUES (?, ?, ?, ?, ?)
     RETURNING ${COLS}`,
  );
  const updateStmt = db.prepare<
    PstnContactRow,
    [string, 0 | 1, 0 | 1, number | null, number]
  >(
    `UPDATE family_phone_pstn_contacts
        SET label = ?, allow_in = ?, allow_out = ?, intended_user_id = ?,
            updated_at = datetime('now')
      WHERE id = ?
     RETURNING ${COLS}`,
  );
  const findByIdStmt = db.prepare<PstnContactRow, [number]>(
    `SELECT ${COLS} FROM family_phone_pstn_contacts WHERE id = ?`,
  );
  const findByE164Stmt = db.prepare<PstnContactRow, [string]>(
    `SELECT ${COLS} FROM family_phone_pstn_contacts WHERE e164 = ?`,
  );
  const listAllStmt = db.prepare<PstnContactRow, []>(
    `SELECT ${COLS} FROM family_phone_pstn_contacts ORDER BY label, e164`,
  );
  const deleteByIdStmt = db.prepare<unknown, [number]>(
    'DELETE FROM family_phone_pstn_contacts WHERE id = ?',
  );

  return {
    insert(input): PstnContactRow {
      const row = insertStmt.get(
        input.e164,
        input.label,
        input.allowIn ? 1 : 0,
        input.allowOut ? 1 : 0,
        input.intendedUserId ?? null,
      );
      if (!row) throw new Error('family_phone_pstn_contacts.insert: RETURNING gave no row');
      return row;
    },
    update(input): PstnContactRow | null {
      return (
        updateStmt.get(
          input.label,
          input.allowIn ? 1 : 0,
          input.allowOut ? 1 : 0,
          input.intendedUserId ?? null,
          input.id,
        ) ?? null
      );
    },
    findById(id): PstnContactRow | null {
      return findByIdStmt.get(id) ?? null;
    },
    findByE164(e164): PstnContactRow | null {
      return findByE164Stmt.get(e164) ?? null;
    },
    listAll(): PstnContactRow[] {
      return listAllStmt.all();
    },
    deleteById(id): boolean {
      return deleteByIdStmt.run(id).changes > 0;
    },
  };
}
