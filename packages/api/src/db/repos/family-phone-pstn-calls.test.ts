import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createPstnCallsRepo } from './family-phone-pstn-calls.ts';

describe('PstnCallsRepo', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('recordInbound inserts a row carrying the source and a server timestamp', () => {
    const repo = createPstnCallsRepo(db);
    const row = repo.recordInbound('+12025550100');
    expect(row.id).toBeGreaterThan(0);
    expect(row.source_e164).toBe('+12025550100');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('countSince scopes to the given source and only counts rows at or after the cutoff', () => {
    const repo = createPstnCallsRepo(db);
    repo.recordInbound('+12025550100');
    repo.recordInbound('+12025550100');
    repo.recordInbound('+441234567890');
    // Insert an older row by hand so we can prove the cutoff trims it.
    db.exec(
      "INSERT INTO family_phone_pstn_calls (source_e164, created_at) VALUES ('+12025550100', '1999-01-01 00:00:00')",
    );
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    expect(repo.countSince('+12025550100', oneMinuteAgo)).toBe(2);
    expect(repo.countSince('+441234567890', oneMinuteAgo)).toBe(1);
    expect(repo.countSince('+12025550100', '1990-01-01 00:00:00')).toBe(3);
    expect(repo.countSince('+19999999999', '1990-01-01 00:00:00')).toBe(0);
  });
});
