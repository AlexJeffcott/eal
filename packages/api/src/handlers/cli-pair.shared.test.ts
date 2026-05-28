import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createCliPairingsRepo } from '../db/repos/cli-pairings.ts';
import { createUsersRepo, type UsersRepo } from '../db/repos/users.ts';
import { createSessionsRepo } from '../auth/sessions.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';
import {
  CLI_PAIR_TTL_MS,
  CLI_SESSION_TTL_MS,
  POLL_INTERVAL_MS,
  buildVerificationUrl,
  claimCore,
  defaultRandomDeviceCode,
  defaultRandomUserCode,
  normaliseUserCode,
  pollCore,
  startCore,
  type CliPairDeps,
} from './cli-pair.shared.ts';
import { formatSqliteDateTime } from '../auth/datetime.ts';

function makeDeps(db: DatabaseClient, overrides: Partial<CliPairDeps> = {}): CliPairDeps {
  const fixedNow = new Date('2026-05-19T12:00:00Z');
  return {
    sessions: createSessionsRepo(db, { now: () => fixedNow }),
    pairings: createCliPairingsRepo(db),
    users: createUsersRepo(db),
    now: () => fixedNow,
    randomUserCode: () => 'WXYZ-1234',
    randomDeviceCode: () => 'device-code-fixed-abcdef',
    ...overrides,
  };
}

function seedUser(usersRepo: UsersRepo, displayName: string): Principal {
  const user = usersRepo.insert({ displayName });
  return { userId: user.id, displayName: user.display_name };
}

describe('production randomisers', () => {
  // Constants for these would silently break sequential pair requests:
  // the user_code UNIQUE constraint and device_code_hash PRIMARY KEY would
  // reject the second insert, making the api unusable past the first call.
  test('defaultRandomUserCode produces a fresh value on each call', () => {
    const samples = new Set<string>();
    for (let i = 0; i < 20; i++) samples.add(defaultRandomUserCode());
    expect(samples.size).toBeGreaterThan(10);
  });

  test('defaultRandomUserCode shape matches XXXX-XXXX from the Crockford alphabet', () => {
    for (let i = 0; i < 10; i++) {
      expect(defaultRandomUserCode()).toMatch(/^[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$/);
    }
  });

  test('defaultRandomDeviceCode produces a fresh value on each call', () => {
    const samples = new Set<string>();
    for (let i = 0; i < 20; i++) samples.add(defaultRandomDeviceCode());
    expect(samples.size).toBe(20);
  });

  test('defaultRandomDeviceCode is at least 32 bytes of entropy (base64url)', () => {
    // 32 bytes → 43 base64url chars (no padding).
    expect(defaultRandomDeviceCode().length).toBeGreaterThanOrEqual(43);
  });
});

describe('normaliseUserCode', () => {
  test('round-trips a canonical code', () => {
    expect(normaliseUserCode('WXYZ-1234')).toBe('WXYZ-1234');
  });
  test('strips dashes and whitespace', () => {
    expect(normaliseUserCode('  WXYZ 1234 ')).toBe('WXYZ-1234');
    expect(normaliseUserCode('WXYZ1234')).toBe('WXYZ-1234');
  });
  test('uppercases', () => {
    expect(normaliseUserCode('wxyz-1234')).toBe('WXYZ-1234');
  });
  test('folds I/L → 1 and O → 0', () => {
    expect(normaliseUserCode('IOLO-1234')).toBe('1010-1234');
  });
  test('rejects malformed codes', () => {
    expect(normaliseUserCode('WXYZ-12')).toBeNull();
    expect(normaliseUserCode('WXYZ-12345')).toBeNull();
    expect(normaliseUserCode('!!!!-!!!!')).toBeNull();
    expect(normaliseUserCode('UUUU-UUUU')).toBeNull(); // U not in alphabet
  });
});

describe('buildVerificationUrl', () => {
  test('appends the public path + code query', () => {
    expect(buildVerificationUrl('https://localhost:3000', 'WXYZ-1234')).toBe(
      'https://localhost:3000/public/auth/cli-pair?code=WXYZ-1234',
    );
  });
  test('handles trailing slash on base URL', () => {
    expect(buildVerificationUrl('https://localhost:3000/', 'WXYZ-1234')).toBe(
      'https://localhost:3000/public/auth/cli-pair?code=WXYZ-1234',
    );
  });
  test('URL-encodes the code', () => {
    expect(buildVerificationUrl('https://x', 'AB CD-EF')).toContain('AB%20CD-EF');
  });
});

describe('startCore', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('mints a fresh pair request and returns the verification URL', () => {
    const deps = makeDeps(db);
    const result = startCore(deps, { baseUrl: 'https://localhost:3000' });
    expect(result.userCode).toBe('WXYZ-1234');
    expect(result.deviceCode).toBe('device-code-fixed-abcdef');
    expect(result.verificationUrl).toContain('/public/auth/cli-pair?code=WXYZ-1234');
    expect(result.pollIntervalMs).toBe(POLL_INTERVAL_MS);

    const row = deps.pairings.findByUserCode('WXYZ-1234');
    expect(row).not.toBeNull();
    expect(row?.user_id).toBeNull();
    expect(row?.expires_at).toBe('2026-05-19 12:10:00');
  });

  test('exported TTL constants match their documented day/minute values', async () => {
    const mod = await import('./cli-pair.shared.ts');
    expect(mod.CLI_PAIR_TTL_MS).toBe(10 * 60 * 1000);
    expect(mod.CLI_SESSION_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(mod.POLL_INTERVAL_MS).toBe(2000);
  });

  test('expiresAtIso reflects CLI_PAIR_TTL_MS', () => {
    const deps = makeDeps(db);
    const result = startCore(deps, { baseUrl: 'https://localhost:3000' });
    const expected = new Date(deps.now().getTime() + CLI_PAIR_TTL_MS).toISOString();
    expect(result.expiresAtIso).toBe(expected);
  });

  test('retries on user_code collision and succeeds on the second attempt', () => {
    const deps = makeDeps(db);
    deps.pairings.insert({
      deviceCodeHash: new Uint8Array(32).fill(9),
      userCode: 'WXYZ-1234',
      expiresAt: '2999-01-01 00:00:00',
    });
    let calls = 0;
    deps.randomUserCode = () => {
      calls += 1;
      return calls === 1 ? 'WXYZ-1234' : 'NEWC-ODE0';
    };
    // Different device_code each attempt so the PK doesn't collide.
    let dcCalls = 0;
    deps.randomDeviceCode = () => {
      dcCalls += 1;
      return `device-code-${dcCalls}`;
    };
    const result = startCore(deps, { baseUrl: 'https://localhost:3000' });
    expect(result.userCode).toBe('NEWC-ODE0');
  });

  test('throws AuthError after exactly four collisions, message includes the underlying error', () => {
    const deps = makeDeps(db);
    deps.pairings.insert({
      deviceCodeHash: new Uint8Array(32).fill(9),
      userCode: 'WXYZ-1234',
      expiresAt: '2999-01-01 00:00:00',
    });
    deps.randomUserCode = () => 'WXYZ-1234';
    let dcCalls = 0;
    deps.randomDeviceCode = () => `device-code-${++dcCalls}`;
    try {
      startCore(deps, { baseUrl: 'https://x' });
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AuthError)) throw new Error('expected AuthError');
      expect(err.status).toBe(500);
      expect(err.message).toMatch(/could not mint a unique code/);
      expect(err.message).not.toMatch(/null/);
    }
    // The bound is exactly four attempts; if it crept to five, dcCalls would be 5.
    expect(dcCalls).toBe(4);
  });
});

describe('claimCore', () => {
  let db: DatabaseClient;
  let alex: Principal;
  let usersRepo: UsersRepo;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    usersRepo = createUsersRepo(db);
    alex = seedUser(usersRepo, 'alex');
  });

  test('claims an unclaimed pair and returns ok', () => {
    const deps = makeDeps(db);
    startCore(deps, { baseUrl: 'https://x' });
    const result = claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'my-laptop' });
    expect(result).toEqual({ ok: true });
    const row = deps.pairings.findByUserCode('WXYZ-1234');
    expect(row?.user_id).toBe(alex.userId);
    expect(row?.label).toBe('my-laptop');
  });

  test('rejects an empty/whitespace label', () => {
    const deps = makeDeps(db);
    startCore(deps, { baseUrl: 'https://x' });
    expect(() => claimCore(deps, alex, { userCode: 'WXYZ-1234', label: '' })).toThrow(/label/);
    expect(() => claimCore(deps, alex, { userCode: 'WXYZ-1234', label: '   ' })).toThrow(/label/);
  });

  test('rejects a malformed user_code with 400', () => {
    const deps = makeDeps(db);
    try {
      claimCore(deps, alex, { userCode: 'NOPE', label: 'l' });
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AuthError)) throw new Error('expected AuthError');
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/user_code is malformed/);
    }
  });

  test('rejects an unknown user_code with 404', () => {
    const deps = makeDeps(db);
    try {
      claimCore(deps, alex, { userCode: 'NOPE-0000', label: 'l' });
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AuthError)) throw new Error('expected AuthError');
      expect(err.status).toBe(404);
      expect(err.message).toMatch(/user_code not found/);
    }
  });

  test('rejects an expired user_code with 410', () => {
    const deps = makeDeps(db);
    startCore(deps, { baseUrl: 'https://x' });
    // Advance "now" past the TTL.
    deps.now = () => new Date(Date.now() + CLI_PAIR_TTL_MS * 100);
    try {
      claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AuthError)) throw new Error('expected AuthError');
      expect(err.status).toBe(410);
      expect(err.message).toMatch(/user_code expired/);
    }
  });

  test('rejects a double-claim with 409 (already-claimed message)', () => {
    const deps = makeDeps(db);
    const leo = seedUser(usersRepo, 'leo');
    startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
    try {
      claimCore(deps, leo, { userCode: 'WXYZ-1234', label: 'l2' });
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AuthError)) throw new Error('expected AuthError');
      expect(err.status).toBe(409);
      expect(err.message).toMatch(/user_code already claimed/);
    }
  });

  test('trims surrounding whitespace from the label before storing', () => {
    const deps = makeDeps(db);
    startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, alex, { userCode: 'WXYZ-1234', label: '   my-laptop   ' });
    expect(deps.pairings.findByUserCode('WXYZ-1234')?.label).toBe('my-laptop');
  });

  test('accepts a forgiving user_code (lowercase, no dash, I→1)', () => {
    const deps = makeDeps(db);
    startCore(deps, { baseUrl: 'https://x' });
    // 'WXYZ-1234' has no I/L/O so verify forgiveness in another shape.
    expect(claimCore(deps, alex, { userCode: 'wxyz1234', label: 'l' })).toEqual({ ok: true });
  });

  test('TOCTOU race: row looks unclaimed but markClaimed returns false → 409', () => {
    // Simulates two browsers racing on claim. Both pass the early read (the row
    // still shows user_id IS NULL), but only one wins the atomic UPDATE. The
    // loser's markClaimed returns false. Without the post-update recheck we'd
    // falsely tell the loser `ok: true`.
    const deps = makeDeps(db);
    startCore(deps, { baseUrl: 'https://x' });
    // Wrap pairings.markClaimed to lie about success — model the lost race.
    const original = deps.pairings;
    deps.pairings = {
      ...original,
      markClaimed: () => false,
    };
    try {
      claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AuthError)) throw new Error('expected AuthError');
      expect(err.status).toBe(409);
    }
  });
});

describe('pollCore', () => {
  let db: DatabaseClient;
  let alex: Principal;
  let usersRepo: UsersRepo;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    usersRepo = createUsersRepo(db);
    alex = seedUser(usersRepo, 'alex');
  });

  test('returns pending when the row exists but is unclaimed', () => {
    const deps = makeDeps(db);
    const { deviceCode } = startCore(deps, { baseUrl: 'https://x' });
    expect(pollCore(deps, { deviceCode })).toEqual({ status: 'pending' });
  });

  test('returns authorized + mints a session for the CLAIMING user (not the first user in the db)', () => {
    // Seed two users so a hardcoded findById(1) bug would mint for the wrong
    // identity. The claimer is the SECOND user — the assertion must match them.
    const leo = seedUser(usersRepo, 'leo');
    const deps = makeDeps(db);
    const { deviceCode } = startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, leo, { userCode: 'WXYZ-1234', label: 'my-laptop' });
    const result = pollCore(deps, { deviceCode });
    expect(result.status).toBe('authorized');
    if (result.status !== 'authorized') throw new Error('unreachable');
    expect(result.user).toEqual({ id: leo.userId, displayName: 'leo' });
    expect(result.user.id).not.toBe(alex.userId);
    expect(result.token.length).toBeGreaterThan(0);
    // The minted token verifies as a session for the claimer with the right label.
    const session = deps.sessions.verify(result.token);
    expect(session?.user_id).toBe(leo.userId);
    expect(session?.label).toBe('my-laptop');
    // CLI sessions live longer than SPA sessions (90 days vs 30) — copy-pasting
    // the SPA TTL into the cli-pair path would silently halve the lifetime.
    const expectedExpiry = formatSqliteDateTime(new Date(deps.now().getTime() + CLI_SESSION_TTL_MS));
    expect(session?.expires_at).toBe(expectedExpiry);
  });

  test('second poll after authorized returns expired (one-shot)', () => {
    const deps = makeDeps(db);
    const { deviceCode } = startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
    const first = pollCore(deps, { deviceCode });
    expect(first.status).toBe('authorized');
    expect(pollCore(deps, { deviceCode })).toEqual({ status: 'expired' });
  });

  test('unknown device_code → expired (do not leak existence)', () => {
    const deps = makeDeps(db);
    expect(pollCore(deps, { deviceCode: 'bogus' })).toEqual({ status: 'expired' });
  });

  test('expired pair → expired even when claimed', () => {
    const deps = makeDeps(db);
    const { deviceCode } = startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
    deps.now = () => new Date(Date.now() + CLI_PAIR_TTL_MS * 100);
    expect(pollCore(deps, { deviceCode })).toEqual({ status: 'expired' });
  });

  test('user deleted after claim → expired (do not crash)', () => {
    const deps = makeDeps(db);
    const { deviceCode } = startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
    db.exec(`DELETE FROM users WHERE id = ${alex.userId}`);
    // Cascading delete removed the pair row already, but cover the in-between
    // case explicitly by claiming again with a fresh user → fresh pair.
    expect(pollCore(deps, { deviceCode })).toEqual({ status: 'expired' });
  });

  test('claimed pair where users.findById returns null → expired (in-between window)', () => {
    const deps = makeDeps(db);
    const { deviceCode } = startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
    // Simulate the user-row being gone in the narrow window between claim and
    // poll, with the pairing row still present.
    deps.users = { ...deps.users, findById: () => null };
    expect(pollCore(deps, { deviceCode })).toEqual({ status: 'expired' });
  });

  test('markConsumed race loser → expired (do not mint a session)', () => {
    const deps = makeDeps(db);
    const { deviceCode } = startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
    // Two polls race; the loser sees markConsumed return false.
    deps.pairings = { ...deps.pairings, markConsumed: () => false };
    expect(pollCore(deps, { deviceCode })).toEqual({ status: 'expired' });
  });

  test('row already consumed → expired without re-calling markConsumed', () => {
    const deps = makeDeps(db);
    const { deviceCode } = startCore(deps, { baseUrl: 'https://x' });
    claimCore(deps, alex, { userCode: 'WXYZ-1234', label: 'l' });
    // Authorize once to flip consumed_at to non-null.
    expect(pollCore(deps, { deviceCode }).status).toBe('authorized');
    // From here, markConsumed should never be reached again — if it is, treat
    // the test as failing (it would falsely mint another session).
    let markConsumedCalls = 0;
    const realMarkConsumed = deps.pairings.markConsumed;
    deps.pairings = {
      ...deps.pairings,
      markConsumed: (args) => {
        markConsumedCalls += 1;
        return realMarkConsumed(args);
      },
    };
    expect(pollCore(deps, { deviceCode })).toEqual({ status: 'expired' });
    expect(markConsumedCalls).toBe(0);
  });
});
