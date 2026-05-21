import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockEalClient, type MockEalClient } from '@eal/client-mock';
import { authPairCore, type PairDeps } from './pair.ts';

interface InMemoryStore {
  written: string[];
  current: string | null;
}

interface SpyLog {
  lines: string[];
}

interface SleepRecord {
  sleeps: number[];
}

function makeDeps(mock: MockEalClient): {
  deps: PairDeps;
  store: InMemoryStore;
  logs: SpyLog;
  sleeps: SleepRecord;
} {
  const store: InMemoryStore = { written: [], current: null };
  const logs: SpyLog = { lines: [] };
  const sleeps: SleepRecord = { sleeps: [] };
  const deps: PairDeps = {
    client: mock,
    writeToken: (t): void => {
      store.written.push(t);
      store.current = t;
    },
    tokenPath: (): string => '/tmp/fake/token',
    sleep: async (ms: number): Promise<void> => {
      sleeps.sleeps.push(ms);
    },
    log: (line: string): void => {
      logs.lines.push(line);
    },
  };
  return { deps, store, logs, sleeps };
}

describe('authPairCore', () => {
  let mock: MockEalClient;

  beforeEach(() => {
    mock = createMockEalClient();
  });

  test('rejects a missing label', async () => {
    const { deps, store } = makeDeps(mock);
    const result = await authPairCore(deps, undefined);
    expect(result.code).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.message).toMatch(/--label/);
    expect(store.written).toEqual([]);
  });

  test('rejects an empty/whitespace label', async () => {
    const { deps, store } = makeDeps(mock);
    expect((await authPairCore(deps, '')).code).toBe(1);
    expect((await authPairCore(deps, '   ')).code).toBe(1);
    expect(store.written).toEqual([]);
  });

  test('writes the token and reports success when the first poll returns authorized', async () => {
    mock.mockCliPair({
      start: {
        userCode: 'WXYZ-1234',
        deviceCode: 'dev-1',
        verificationUrl: 'https://x/public/auth/cli-pair?code=WXYZ-1234',
        pollIntervalMs: 2000,
        expiresAt: '2026-05-19T12:10:00.000Z',
      },
      polls: [
        { status: 'authorized', token: 'eal_v1_paired', user: { userId: 7, displayName: 'alex' } },
      ],
    });
    const { deps, store, logs } = makeDeps(mock);
    const result = await authPairCore(deps, 'my-laptop');
    expect(result.code).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.message).toContain('paired as alex');
    expect(result.message).toContain('label=my-laptop');
    expect(store.written).toEqual(['eal_v1_paired']);
    expect(logs.lines.some((l) => l.includes('WXYZ-1234'))).toBe(true);
    expect(logs.lines.some((l) => l.includes('verification'))).toBe(false); // not in our copy
    expect(logs.lines.some((l) => l.includes('public/auth/cli-pair'))).toBe(true);
  });

  test('polls until authorized', async () => {
    mock.mockCliPair({
      start: {
        userCode: 'WXYZ-1234',
        deviceCode: 'dev-1',
        verificationUrl: 'https://x',
        pollIntervalMs: 1000,
        expiresAt: 'iso',
      },
      polls: [
        { status: 'pending' },
        { status: 'pending' },
        { status: 'authorized', token: 'eal_v1_ok', user: { userId: 1, displayName: 'alex' } },
      ],
    });
    const { deps, store, sleeps } = makeDeps(mock);
    const result = await authPairCore(deps, 'l');
    expect(result.code).toBe(0);
    expect(store.written).toEqual(['eal_v1_ok']);
    expect(sleeps.sleeps).toEqual([1000, 1000]);
  });

  test('reports expiry without writing a token', async () => {
    mock.mockCliPair({
      start: {
        userCode: 'WXYZ-1234',
        deviceCode: 'dev-1',
        verificationUrl: 'https://x',
        pollIntervalMs: 100,
        expiresAt: 'iso',
      },
      polls: [{ status: 'pending' }, { status: 'expired' }],
    });
    const { deps, store } = makeDeps(mock);
    const result = await authPairCore(deps, 'l');
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/expired/);
    expect(store.written).toEqual([]);
  });

  test('reports start failures cleanly', async () => {
    // No mockCliPair call → startCliPair throws.
    const { deps, store } = makeDeps(mock);
    const result = await authPairCore(deps, 'l');
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/could not start/);
    expect(store.written).toEqual([]);
  });

  test('reports poll failures cleanly', async () => {
    // Seed start but not polls → pollCliPair throws.
    mock.mockCliPair({
      start: {
        userCode: 'WXYZ-1234',
        deviceCode: 'dev-1',
        verificationUrl: 'https://x',
        pollIntervalMs: 1000,
        expiresAt: 'iso',
      },
      polls: [],
    });
    const { deps, store } = makeDeps(mock);
    const result = await authPairCore(deps, 'l');
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/poll failed/);
    expect(store.written).toEqual([]);
  });
});
