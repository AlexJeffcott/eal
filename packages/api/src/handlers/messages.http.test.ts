import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createMessagesRepo } from '../db/repos/messages.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

async function get(
  app: Awaited<ReturnType<typeof createTestApp>>,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`https://localhost:4321${path}`));
  const text = await res.text();
  return { status: res.status, body: text.length === 0 ? null : JSON.parse(text) };
}

async function post(
  app: Awaited<ReturnType<typeof createTestApp>>,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`https://localhost:4321${path}`, { method: 'POST' }),
  );
  const text = await res.text();
  return { status: res.status, body: text.length === 0 ? null : JSON.parse(text) };
}

function messageContents(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('messages' in body)) {
    throw new Error('expected a {messages} envelope');
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) throw new Error('messages is not an array');
  return messages.map((m: { content: string }) => m.content);
}

describe('messages http wire contract', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
  });

  test('GET /api/v1/messages returns the principal’s conversation', async () => {
    const repo = createMessagesRepo(db);
    repo.insert({ role: 'user', content: 'hello', createdBy: alex.userId });
    repo.insert({ role: 'assistant', content: 'hi there', createdBy: alex.userId });

    const app = await createTestApp(db, { principalOverride: alex });
    const res = await get(app, '/api/v1/messages');
    expect(res.status).toBe(200);
    if (typeof res.body !== 'object' || res.body === null || !('messages' in res.body)) {
      throw new Error('expected {messages} envelope');
    }
    const messages = res.body.messages;
    if (!Array.isArray(messages)) throw new Error('messages is not an array');
    expect(messages.map((m: { role: string; content: string }) => `${m.role}:${m.content}`)).toEqual([
      'user:hello',
      'assistant:hi there',
    ]);
  });

  test('GET /api/v1/messages is 401 without a principal', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await get(app, '/api/v1/messages');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  test('POST /api/v1/messages/clear empties the conversation', async () => {
    const repo = createMessagesRepo(db);
    repo.insert({ role: 'user', content: 'hello', createdBy: alex.userId });
    repo.insert({ role: 'assistant', content: 'hi there', createdBy: alex.userId });

    const app = await createTestApp(db, { principalOverride: alex });
    expect(messageContents((await get(app, '/api/v1/messages')).body)).toEqual(['hello', 'hi there']);

    const cleared = await post(app, '/api/v1/messages/clear');
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ ok: true });

    expect(messageContents((await get(app, '/api/v1/messages')).body)).toEqual([]);
  });

  test('POST /api/v1/messages/clear is 401 without a principal', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await post(app, '/api/v1/messages/clear');
    expect(res.status).toBe(401);
  });
});
