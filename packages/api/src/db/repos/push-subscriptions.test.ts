import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createUsersRepo } from './users.ts';
import { createPushSubscriptionsRepo, type PushSubscriptionsRepo } from './push-subscriptions.ts';

interface SetupContext {
  db: DatabaseClient;
  subs: PushSubscriptionsRepo;
  alex: number;
  elisa: number;
}

function setup(): SetupContext {
  const db = createDb(':memory:');
  applySchema(db);
  const users = createUsersRepo(db);
  return {
    db,
    subs: createPushSubscriptionsRepo(db),
    alex: users.insert({ displayName: 'alex' }).id,
    elisa: users.insert({ displayName: 'elisa' }).id,
  };
}

function sub(userId: number, endpoint: string) {
  return { userId, endpoint, p256dh: `p-${endpoint}`, auth: `a-${endpoint}` };
}

describe('push_subscriptions repo', () => {
  let ctx: SetupContext;
  beforeEach(() => {
    ctx = setup();
  });

  test('upsert stores a subscription and lists it back for its owner', () => {
    const row = ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/1'));
    expect(row.user_id).toBe(ctx.alex);
    expect(row.endpoint).toBe('https://vendor.example/1');
    expect(ctx.subs.listByUser(ctx.alex).map((r) => r.endpoint)).toEqual([
      'https://vendor.example/1',
    ]);
    expect(ctx.subs.listByUser(ctx.elisa)).toEqual([]);
  });

  test('the same endpoint re-registered updates in place rather than duplicating', () => {
    const first = ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/1'));
    const second = ctx.subs.upsert({
      userId: ctx.alex,
      endpoint: 'https://vendor.example/1',
      p256dh: 'rotated-key',
      auth: 'rotated-auth',
    });
    expect(second.id).toBe(first.id);
    expect(second.p256dh).toBe('rotated-key');
    expect(ctx.subs.listByUser(ctx.alex)).toHaveLength(1);
  });

  test('an endpoint re-registered by a different person moves to them', () => {
    ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/shared-browser'));
    ctx.subs.upsert(sub(ctx.elisa, 'https://vendor.example/shared-browser'));
    // A shared browser profile signed into a second account must not keep
    // delivering the first person's deadlines to it.
    expect(ctx.subs.listByUser(ctx.alex)).toEqual([]);
    expect(ctx.subs.listByUser(ctx.elisa)).toHaveLength(1);
  });

  test('listAll is the fan-out for an unassigned task', () => {
    ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/1'));
    ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/2'));
    ctx.subs.upsert(sub(ctx.elisa, 'https://vendor.example/3'));
    expect(ctx.subs.listAll()).toHaveLength(3);
  });

  test('deleteByEndpoint reports whether it removed anything', () => {
    ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/1'));
    expect(ctx.subs.deleteByEndpoint('https://vendor.example/1')).toBe(true);
    // The idempotent second call — what a browser that unsubscribes twice does.
    expect(ctx.subs.deleteByEndpoint('https://vendor.example/1')).toBe(false);
    expect(ctx.subs.listAll()).toEqual([]);
  });

  test('deleteByUser removes every browser that person registered', () => {
    ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/1'));
    ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/2'));
    ctx.subs.upsert(sub(ctx.elisa, 'https://vendor.example/3'));
    expect(ctx.subs.deleteByUser(ctx.alex)).toBe(2);
    expect(ctx.subs.listAll().map((r) => r.user_id)).toEqual([ctx.elisa]);
  });

  test('deleting the person deletes their subscriptions', () => {
    ctx.subs.upsert(sub(ctx.alex, 'https://vendor.example/1'));
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(ctx.alex);
    // A subscription addressed to someone who no longer exists is addressed to
    // nobody — the ON DELETE CASCADE says so rather than leaving a row the scan
    // would carry forever.
    expect(ctx.subs.listAll()).toEqual([]);
  });
});
