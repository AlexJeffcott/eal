import type { DatabaseClient } from '../client.ts';

export interface UserRow {
  id: number;
  display_name: string;
  created_at: string;
  /** 1 when this user opts into the inbound DTMF IVR menu; default 0. */
  in_ivr_menu: 0 | 1;
}

export interface UsersRepo {
  insert(input: { displayName: string }): UserRow;
  findById(id: number): UserRow | null;
  findByDisplayName(displayName: string): UserRow | null;
  /** Every household member, ordered by display name — the assignee roster. */
  listAll(): UserRow[];
  /**
   * Every user with in_ivr_menu=1, ordered by display name. Inbound PSTN
   * calls without an intended recipient build their DTMF menu from
   * this list (1 → first listed, 2 → second, …).
   */
  listInIvrMenu(): UserRow[];
  /** Flip the opt-in flag. Returns the patched row, or null on miss. */
  setInIvrMenu(id: number, on: boolean): UserRow | null;
}

const COLS = 'id, display_name, created_at, in_ivr_menu';

export function createUsersRepo(db: DatabaseClient): UsersRepo {
  const insertStmt = db.prepare<UserRow, [string]>(
    `INSERT INTO users (display_name) VALUES (?) RETURNING ${COLS}`,
  );
  const findByIdStmt = db.prepare<UserRow, [number]>(
    `SELECT ${COLS} FROM users WHERE id = ?`,
  );
  const findByDisplayNameStmt = db.prepare<UserRow, [string]>(
    `SELECT ${COLS} FROM users WHERE display_name = ?`,
  );
  const listAllStmt = db.prepare<UserRow, []>(
    `SELECT ${COLS} FROM users ORDER BY display_name ASC`,
  );
  const listInIvrMenuStmt = db.prepare<UserRow, []>(
    `SELECT ${COLS} FROM users WHERE in_ivr_menu = 1 ORDER BY display_name ASC`,
  );
  const setInIvrMenuStmt = db.prepare<UserRow, [0 | 1, number]>(
    `UPDATE users SET in_ivr_menu = ? WHERE id = ? RETURNING ${COLS}`,
  );

  return {
    insert(input): UserRow {
      const row = insertStmt.get(input.displayName);
      if (!row) throw new Error('users.insert: RETURNING gave no row');
      return row;
    },
    findById(id): UserRow | null {
      return findByIdStmt.get(id) ?? null;
    },
    findByDisplayName(displayName): UserRow | null {
      return findByDisplayNameStmt.get(displayName) ?? null;
    },
    listAll(): UserRow[] {
      return listAllStmt.all();
    },
    listInIvrMenu(): UserRow[] {
      return listInIvrMenuStmt.all();
    },
    setInIvrMenu(id, on): UserRow | null {
      return setInIvrMenuStmt.get(on ? 1 : 0, id) ?? null;
    },
  };
}
