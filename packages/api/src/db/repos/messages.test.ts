import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createUsersRepo } from './users.ts';
import { createMessagesRepo, type MessagesRepo } from './messages.ts';

interface Ctx {
  db: DatabaseClient;
  messages: MessagesRepo;
  alex: number;
  elisa: number;
}

function setup(): Ctx {
  const db = createDb(':memory:');
  applySchema(db);
  const users = createUsersRepo(db);
  return {
    db,
    messages: createMessagesRepo(db),
    alex: users.insert({ displayName: 'alex' }).id,
    elisa: users.insert({ displayName: 'elisa' }).id,
  };
}

describe('messages repo', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });

  test('insert returns the populated row', () => {
    const row = ctx.messages.insert({ role: 'user', content: 'what should I do today?', createdBy: ctx.alex });
    expect(row.id).toBeGreaterThan(0);
    expect(row.role).toBe('user');
    expect(row.content).toBe('what should I do today?');
    expect(row.created_by).toBe(ctx.alex);
    expect(row.created_at.length).toBeGreaterThan(0);
  });

  test('listByUser returns a single conversation in insertion order', () => {
    ctx.messages.insert({ role: 'user', content: 'q1', createdBy: ctx.alex });
    ctx.messages.insert({ role: 'assistant', content: 'a1', createdBy: ctx.alex });
    ctx.messages.insert({ role: 'user', content: 'q2', createdBy: ctx.alex });
    const convo = ctx.messages.listByUser(ctx.alex);
    expect(convo.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:q1',
      'assistant:a1',
      'user:q2',
    ]);
  });

  test('conversations are isolated per created_by', () => {
    ctx.messages.insert({ role: 'user', content: 'alex-only', createdBy: ctx.alex });
    ctx.messages.insert({ role: 'user', content: 'elisa-only', createdBy: ctx.elisa });
    expect(ctx.messages.listByUser(ctx.alex).map((m) => m.content)).toEqual(['alex-only']);
    expect(ctx.messages.listByUser(ctx.elisa).map((m) => m.content)).toEqual(['elisa-only']);
  });

  test('listByUser is empty for a user with no messages', () => {
    expect(ctx.messages.listByUser(ctx.alex)).toEqual([]);
  });

  test('listRecentByUser returns the last N messages, still oldest-first', () => {
    for (let i = 1; i <= 6; i++) {
      ctx.messages.insert({ role: 'user', content: `m${i}`, createdBy: ctx.alex });
    }
    const recent = ctx.messages.listRecentByUser(ctx.alex, 3);
    expect(recent.map((m) => m.content)).toEqual(['m4', 'm5', 'm6']);
  });

  test('listRecentByUser returns everything when the limit exceeds the count', () => {
    ctx.messages.insert({ role: 'user', content: 'only', createdBy: ctx.alex });
    expect(ctx.messages.listRecentByUser(ctx.alex, 50).map((m) => m.content)).toEqual(['only']);
  });

  test('sinceId hides messages up to and including that id from both list queries', () => {
    const a = ctx.messages.insert({ role: 'user', content: 'before', createdBy: ctx.alex });
    const b = ctx.messages.insert({ role: 'user', content: 'after', createdBy: ctx.alex });
    expect(ctx.messages.listByUser(ctx.alex, a.id).map((m) => m.content)).toEqual(['after']);
    expect(ctx.messages.listRecentByUser(ctx.alex, 50, a.id).map((m) => m.content)).toEqual(['after']);
    // Clearing past the latest message hides the whole conversation.
    expect(ctx.messages.listByUser(ctx.alex, b.id)).toEqual([]);
  });

  test('maxIdForUser returns the highest id, or 0 when the user has none', () => {
    expect(ctx.messages.maxIdForUser(ctx.alex)).toBe(0);
    const row = ctx.messages.insert({ role: 'user', content: 'x', createdBy: ctx.alex });
    expect(ctx.messages.maxIdForUser(ctx.alex)).toBe(row.id);
  });

  test('the role CHECK constraint rejects anything but user/assistant', () => {
    expect(() =>
      ctx.db
        .prepare("INSERT INTO messages (role, content, created_by) VALUES ('system', 'x', ?)")
        .run(ctx.alex),
    ).toThrow();
  });

  test('deleting a user cascades their messages away', () => {
    ctx.messages.insert({ role: 'user', content: 'x', createdBy: ctx.alex });
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(ctx.alex);
    expect(ctx.messages.listByUser(ctx.alex)).toEqual([]);
  });
});
