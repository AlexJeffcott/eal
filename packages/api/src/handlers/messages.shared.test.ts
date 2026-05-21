import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';
import {
  clearConversationCore,
  getClaudeSessionCore,
  listConversationCore,
  listRecentConversationCore,
  recordAssistantMessageCore,
  sendUserMessageCore,
  setClaudeSessionCore,
} from './messages.shared.ts';

interface Ctx {
  db: DatabaseClient;
  alex: Principal;
  elisa: Principal;
}

function setup(): Ctx {
  const db = createDb(':memory:');
  applySchema(db);
  const users = createUsersRepo(db);
  const a = users.insert({ displayName: 'alex' });
  const e = users.insert({ displayName: 'elisa' });
  return {
    db,
    alex: { userId: a.id, displayName: a.display_name },
    elisa: { userId: e.id, displayName: e.display_name },
  };
}

describe('messages cores', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('sendUserMessageCore persists a trimmed user message owned by the principal', () => {
    const msg = sendUserMessageCore(ctx.db, { text: '  plan my week  ' }, ctx.alex);
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('plan my week');
    expect(msg.createdBy).toBe(ctx.alex.userId);
  });

  test('sendUserMessageCore rejects empty / whitespace text with 400', () => {
    expect(() => sendUserMessageCore(ctx.db, { text: '' }, ctx.alex)).toThrow(AuthError);
    expect(() => sendUserMessageCore(ctx.db, { text: '   ' }, ctx.alex)).toThrow(/text is required/);
  });

  test('recordAssistantMessageCore persists into the named conversation', () => {
    const msg = recordAssistantMessageCore(ctx.db, {
      content: 'here is your week',
      conversationUserId: ctx.alex.userId,
    });
    expect(msg.role).toBe('assistant');
    expect(msg.createdBy).toBe(ctx.alex.userId);
  });

  test('listConversationCore returns one member’s conversation, oldest first', () => {
    sendUserMessageCore(ctx.db, { text: 'q1' }, ctx.alex);
    recordAssistantMessageCore(ctx.db, { content: 'a1', conversationUserId: ctx.alex.userId });
    sendUserMessageCore(ctx.db, { text: 'q2' }, ctx.alex);
    // Elisa's conversation is separate.
    sendUserMessageCore(ctx.db, { text: 'hers' }, ctx.elisa);

    const alexConvo = listConversationCore(ctx.db, ctx.alex);
    expect(alexConvo.map((m) => `${m.role}:${m.content}`)).toEqual(['user:q1', 'assistant:a1', 'user:q2']);
    expect(listConversationCore(ctx.db, ctx.elisa).map((m) => m.content)).toEqual(['hers']);
  });

  test('listRecentConversationCore returns the principal’s recent messages oldest-first', () => {
    sendUserMessageCore(ctx.db, { text: 'q1' }, ctx.alex);
    recordAssistantMessageCore(ctx.db, { content: 'a1', conversationUserId: ctx.alex.userId });
    expect(listRecentConversationCore(ctx.db, ctx.alex).map((m) => m.content)).toEqual(['q1', 'a1']);
  });

  test('the Claude session id round-trips per conversation and is isolated per member', () => {
    expect(getClaudeSessionCore(ctx.db, ctx.alex)).toBeNull();
    setClaudeSessionCore(ctx.db, ctx.alex.userId, 'sess-xyz');
    expect(getClaudeSessionCore(ctx.db, ctx.alex)).toBe('sess-xyz');
    expect(getClaudeSessionCore(ctx.db, ctx.elisa)).toBeNull();
  });

  test('clearConversationCore hides prior messages, drops the session, and lets a fresh turn through', () => {
    sendUserMessageCore(ctx.db, { text: 'old q' }, ctx.alex);
    recordAssistantMessageCore(ctx.db, { content: 'old a', conversationUserId: ctx.alex.userId });
    setClaudeSessionCore(ctx.db, ctx.alex.userId, 'sess-1');
    expect(listConversationCore(ctx.db, ctx.alex).length).toBe(2);

    clearConversationCore(ctx.db, ctx.alex);
    expect(listConversationCore(ctx.db, ctx.alex)).toEqual([]);
    expect(listRecentConversationCore(ctx.db, ctx.alex)).toEqual([]);
    expect(getClaudeSessionCore(ctx.db, ctx.alex)).toBeNull();

    sendUserMessageCore(ctx.db, { text: 'fresh start' }, ctx.alex);
    expect(listConversationCore(ctx.db, ctx.alex).map((m) => m.content)).toEqual(['fresh start']);
  });
});
