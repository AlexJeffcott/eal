import type { DatabaseClient } from '../client.ts';

export interface UserRow {
  id: number;
  display_name: string;
  created_at: string;
}

export interface UsersRepo {
  insert(input: { displayName: string }): UserRow;
  findById(id: number): UserRow | null;
  findByDisplayName(displayName: string): UserRow | null;
  /** Every household member, ordered by display name — the assignee roster. */
  listAll(): UserRow[];
}

export function createUsersRepo(db: DatabaseClient): UsersRepo {
  const insertStmt = db.prepare<UserRow, [string]>(
    'INSERT INTO users (display_name) VALUES (?) RETURNING id, display_name, created_at',
  );
  const findByIdStmt = db.prepare<UserRow, [number]>(
    'SELECT id, display_name, created_at FROM users WHERE id = ?',
  );
  const findByDisplayNameStmt = db.prepare<UserRow, [string]>(
    'SELECT id, display_name, created_at FROM users WHERE display_name = ?',
  );
  const listAllStmt = db.prepare<UserRow, []>(
    'SELECT id, display_name, created_at FROM users ORDER BY display_name ASC',
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
  };
}
