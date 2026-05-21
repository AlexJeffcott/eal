import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import type { MessageRow } from '../db/repos/messages.ts';
import { createMessagesRepo } from '../db/repos/messages.ts';
import { createConversationsRepo } from '../db/repos/conversations.ts';
import { AuthError } from './auth.shared.ts';

/**
 * How many recent messages the relay hands the agent. The agent needs these
 * only to *seed* a fresh Claude session (cold start, or recovery after a lost
 * session) — once seeded, Claude Code's own session accumulates every turn and
 * compacts. So this is a seed bound, not a conversation window: the messages
 * table keeps the complete history regardless.
 */
export const RELAY_HISTORY_LIMIT = 100;

/**
 * Wire shape for a chat message. CamelCase to match the rest of the codebase;
 * kept byte-identical to packages/client/src/chat-types.ts.
 */
export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdBy: number;
  createdAt: string;
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Persist a human's chat message. The conversation owner is the principal —
 * every member talks to the assistant in their own conversation.
 */
export function sendUserMessageCore(
  db: DatabaseClient,
  input: { text: string },
  principal: Principal,
): Message {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new AuthError(400, 'message text is required');
  }
  const row = createMessagesRepo(db).insert({
    role: 'user',
    content: text,
    createdBy: principal.userId,
  });
  return toMessage(row);
}

/**
 * Persist the assistant's reply into a given member's conversation. Called by
 * the relay when the agent reports `chat:done` — there is no principal here,
 * the conversation owner is passed explicitly.
 */
export function recordAssistantMessageCore(
  db: DatabaseClient,
  input: { content: string; conversationUserId: number },
): Message {
  const row = createMessagesRepo(db).insert({
    role: 'assistant',
    content: input.content,
    createdBy: input.conversationUserId,
  });
  return toMessage(row);
}

/**
 * Load the principal's current conversation, oldest first — everything since
 * the last "Clear" (the whole thing if it has never been cleared).
 */
export function listConversationCore(db: DatabaseClient, principal: Principal): Message[] {
  const sinceId = createConversationsRepo(db).getClearedBeforeId(principal.userId);
  return createMessagesRepo(db).listByUser(principal.userId, sinceId).map(toMessage);
}

/**
 * The recent slice of the principal's current conversation the relay sends to
 * the agent — capped at RELAY_HISTORY_LIMIT, post-Clear, oldest first.
 */
export function listRecentConversationCore(db: DatabaseClient, principal: Principal): Message[] {
  const sinceId = createConversationsRepo(db).getClearedBeforeId(principal.userId);
  return createMessagesRepo(db)
    .listRecentByUser(principal.userId, RELAY_HISTORY_LIMIT, sinceId)
    .map(toMessage);
}

/**
 * Reset the principal's conversation: hide every message so far and drop the
 * Claude session, so the next turn starts the assistant fresh. Non-destructive
 * — the rows stay in the table, just below the new Clear boundary.
 */
export function clearConversationCore(db: DatabaseClient, principal: Principal): void {
  const latestId = createMessagesRepo(db).maxIdForUser(principal.userId);
  createConversationsRepo(db).clear(principal.userId, latestId);
}

/** The Claude session id carrying this conversation's context, or null. */
export function getClaudeSessionCore(db: DatabaseClient, principal: Principal): string | null {
  return createConversationsRepo(db).getSessionId(principal.userId);
}

/** Record the Claude session id the agent (re)seeded for a conversation. */
export function setClaudeSessionCore(
  db: DatabaseClient,
  conversationUserId: number,
  sessionId: string,
): void {
  createConversationsRepo(db).setSessionId(conversationUserId, sessionId);
}
