import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createUsersRepo } from './users.ts';
import { createConversationsRepo, type ConversationsRepo } from './conversations.ts';

interface Ctx {
  db: DatabaseClient;
  conversations: ConversationsRepo;
  alex: number;
  elisa: number;
}

function setup(): Ctx {
  const db = createDb(':memory:');
  applySchema(db);
  const users = createUsersRepo(db);
  return {
    db,
    conversations: createConversationsRepo(db),
    alex: users.insert({ displayName: 'alex' }).id,
    elisa: users.insert({ displayName: 'elisa' }).id,
  };
}

describe('conversations repo', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('getSessionId is null before any session is recorded', () => {
    expect(ctx.conversations.getSessionId(ctx.alex)).toBeNull();
  });

  test('setSessionId then getSessionId round-trips', () => {
    ctx.conversations.setSessionId(ctx.alex, 'sess-abc');
    expect(ctx.conversations.getSessionId(ctx.alex)).toBe('sess-abc');
  });

  test('setSessionId upserts — a later session id replaces the earlier one', () => {
    ctx.conversations.setSessionId(ctx.alex, 'sess-old');
    ctx.conversations.setSessionId(ctx.alex, 'sess-new');
    expect(ctx.conversations.getSessionId(ctx.alex)).toBe('sess-new');
  });

  test('session ids are isolated per user', () => {
    ctx.conversations.setSessionId(ctx.alex, 'sess-alex');
    ctx.conversations.setSessionId(ctx.elisa, 'sess-elisa');
    expect(ctx.conversations.getSessionId(ctx.alex)).toBe('sess-alex');
    expect(ctx.conversations.getSessionId(ctx.elisa)).toBe('sess-elisa');
  });

  test('deleting a user cascades their conversation row away', () => {
    ctx.conversations.setSessionId(ctx.alex, 'sess-abc');
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(ctx.alex);
    expect(ctx.conversations.getSessionId(ctx.alex)).toBeNull();
  });

  test('getClearedBeforeId is 0 until the conversation is cleared', () => {
    expect(ctx.conversations.getClearedBeforeId(ctx.alex)).toBe(0);
  });

  test('clear records the boundary and drops the session id', () => {
    ctx.conversations.setSessionId(ctx.alex, 'sess-abc');
    ctx.conversations.clear(ctx.alex, 42);
    expect(ctx.conversations.getClearedBeforeId(ctx.alex)).toBe(42);
    expect(ctx.conversations.getSessionId(ctx.alex)).toBeNull();
  });

  test('clear works even when no conversation row exists yet', () => {
    ctx.conversations.clear(ctx.elisa, 7);
    expect(ctx.conversations.getClearedBeforeId(ctx.elisa)).toBe(7);
  });

  test('setSessionId after a clear keeps the clear boundary intact', () => {
    ctx.conversations.clear(ctx.alex, 10);
    ctx.conversations.setSessionId(ctx.alex, 'sess-new');
    expect(ctx.conversations.getSessionId(ctx.alex)).toBe('sess-new');
    expect(ctx.conversations.getClearedBeforeId(ctx.alex)).toBe(10);
  });
});
