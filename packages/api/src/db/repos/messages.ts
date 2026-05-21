import type { DatabaseClient } from '../client.ts';

export interface MessageRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_by: number;
  created_at: string;
}

/**
 * Chat messages. `created_by` is the conversation owner: every row — whether
 * the human's question (role='user') or the assistant's reply (role='assistant')
 * — is tagged with the household member whose conversation it belongs to. A
 * user's conversation is therefore just `WHERE created_by = ? ORDER BY id`,
 * with no separate thread table.
 */
interface MaxIdRow {
  max_id: number;
}

/**
 * `sinceId` excludes messages with id ≤ it — the conversation's "Clear" point.
 * It defaults to 0, which includes everything (message ids start at 1).
 */
export interface MessagesRepo {
  insert(input: { role: 'user' | 'assistant'; content: string; createdBy: number }): MessageRow;
  listByUser(userId: number, sinceId?: number): MessageRow[];
  /** The most recent `limit` messages for a user, returned oldest-first. */
  listRecentByUser(userId: number, limit: number, sinceId?: number): MessageRow[];
  /** The highest message id for a user, or 0 if they have none. */
  maxIdForUser(userId: number): number;
}

const COLS = 'id, role, content, created_by, created_at';

export function createMessagesRepo(db: DatabaseClient): MessagesRepo {
  const insertStmt = db.prepare<MessageRow, [string, string, number]>(
    `INSERT INTO messages (role, content, created_by) VALUES (?, ?, ?) RETURNING ${COLS}`,
  );
  const listByUserStmt = db.prepare<MessageRow, [number, number]>(
    `SELECT ${COLS} FROM messages WHERE created_by = ? AND id > ? ORDER BY id ASC`,
  );
  const listRecentStmt = db.prepare<MessageRow, [number, number, number]>(
    `SELECT ${COLS} FROM (
       SELECT ${COLS} FROM messages WHERE created_by = ? AND id > ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  );
  const maxIdStmt = db.prepare<MaxIdRow, [number]>(
    'SELECT coalesce(max(id), 0) AS max_id FROM messages WHERE created_by = ?',
  );

  return {
    insert(input): MessageRow {
      const row = insertStmt.get(input.role, input.content, input.createdBy);
      if (!row) throw new Error('messages.insert: RETURNING gave no row');
      return row;
    },
    listByUser(userId, sinceId = 0): MessageRow[] {
      return listByUserStmt.all(userId, sinceId);
    },
    listRecentByUser(userId, limit, sinceId = 0): MessageRow[] {
      return listRecentStmt.all(userId, sinceId, limit);
    },
    maxIdForUser(userId): number {
      return maxIdStmt.get(userId)?.max_id ?? 0;
    },
  };
}
