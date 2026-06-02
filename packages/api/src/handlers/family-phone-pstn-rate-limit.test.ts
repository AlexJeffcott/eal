import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createPstnCallsRepo } from '../db/repos/family-phone-pstn-calls.ts';
import { createPstnInboundRateLimiter } from './family-phone-pstn-rate-limit.ts';

describe('createPstnInboundRateLimiter', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('allows attempts up to the cap and rejects everything beyond inside the window', () => {
    const limiter = createPstnInboundRateLimiter({
      calls: createPstnCallsRepo(db),
      windowMs: 60_000,
      maxCalls: 3,
    });
    const verdicts = Array.from({ length: 5 }, () => limiter.check('+12025550100'));
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false, false]);
    expect(verdicts.map((v) => v.count)).toEqual([1, 2, 3, 4, 5]);
    expect(verdicts[4]?.max).toBe(3);
    expect(verdicts[4]?.windowMs).toBe(60_000);
  });

  test('records every attempt — over-limit calls still count toward the burst total', () => {
    const limiter = createPstnInboundRateLimiter({
      calls: createPstnCallsRepo(db),
      windowMs: 60_000,
      maxCalls: 2,
    });
    for (let i = 0; i < 6; i++) limiter.check('+12025550100');
    const repoCount = createPstnCallsRepo(db).countSince(
      '+12025550100',
      '1990-01-01 00:00:00',
    );
    expect(repoCount).toBe(6);
  });

  test('scopes the count per source — another caller is unaffected by the first burst', () => {
    const limiter = createPstnInboundRateLimiter({
      calls: createPstnCallsRepo(db),
      windowMs: 60_000,
      maxCalls: 2,
    });
    for (let i = 0; i < 5; i++) limiter.check('+12025550100');
    const fresh = limiter.check('+441234567890');
    expect(fresh.allowed).toBe(true);
    expect(fresh.count).toBe(1);
  });

  test('rows older than the window do not count — the clock injection moves time forward', () => {
    const repo = createPstnCallsRepo(db);
    // Two old rows: outside the window when "now" advances past them.
    db.exec(
      "INSERT INTO family_phone_pstn_calls (source_e164, created_at) VALUES ('+12025550100', '2020-01-01 00:00:00'), ('+12025550100', '2020-01-01 00:00:00')",
    );
    const limiter = createPstnInboundRateLimiter({
      calls: repo,
      windowMs: 60_000,
      maxCalls: 2,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const v = limiter.check('+12025550100');
    // The old rows are outside the 60s window, so only the just-
    // recorded attempt counts.
    expect(v.count).toBe(1);
    expect(v.allowed).toBe(true);
  });
});
