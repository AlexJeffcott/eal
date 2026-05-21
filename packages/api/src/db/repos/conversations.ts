import type { DatabaseClient } from '../client.ts';

interface ConversationRow {
  claude_session_id: string | null;
  cleared_before_id: number;
}

/**
 * One row per household member's assistant conversation.
 *  - `claude_session_id` — the Claude Code session carrying this conversation's
 *    working context, so the agent can `claude --resume` it instead of
 *    re-sending the transcript. `null` means seed a fresh one.
 *  - `cleared_before_id` — messages with id ≤ this are hidden ("Clear" sets it
 *    to the latest message id). The rows stay in the table; they just drop out
 *    of the conversation the user and the assistant see.
 */
export interface ConversationsRepo {
  getSessionId(userId: number): string | null;
  setSessionId(userId: number, sessionId: string): void;
  getClearedBeforeId(userId: number): number;
  /** Reset the conversation: hide everything up to `clearedBeforeId`, drop the session. */
  clear(userId: number, clearedBeforeId: number): void;
}

export function createConversationsRepo(db: DatabaseClient): ConversationsRepo {
  const getStmt = db.prepare<ConversationRow, [number]>(
    'SELECT claude_session_id, cleared_before_id FROM conversations WHERE user_id = ?',
  );
  const setSessionStmt = db.prepare<unknown, [number, string]>(
    `INSERT INTO conversations (user_id, claude_session_id, updated_at)
       VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       claude_session_id = excluded.claude_session_id,
       updated_at        = excluded.updated_at`,
  );
  const clearStmt = db.prepare<unknown, [number, number]>(
    `INSERT INTO conversations (user_id, claude_session_id, cleared_before_id, updated_at)
       VALUES (?, NULL, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       claude_session_id = NULL,
       cleared_before_id = excluded.cleared_before_id,
       updated_at        = excluded.updated_at`,
  );

  return {
    getSessionId(userId): string | null {
      return getStmt.get(userId)?.claude_session_id ?? null;
    },
    setSessionId(userId, sessionId): void {
      setSessionStmt.run(userId, sessionId);
    },
    getClearedBeforeId(userId): number {
      return getStmt.get(userId)?.cleared_before_id ?? 0;
    },
    clear(userId, clearedBeforeId): void {
      clearStmt.run(userId, clearedBeforeId);
    },
  };
}
