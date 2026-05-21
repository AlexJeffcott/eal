import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockEalClient, type MockEalClient } from '@eal/client-mock';
import {
  authLoginCore,
  authLogoutCore,
  authStatusCore,
  type AuthDeps,
} from './auth.ts';

interface InMemoryStore {
  current: string | null;
  reads: number;
  writes: string[];
  deletes: number;
}

function makeDeps(mock: MockEalClient): { deps: AuthDeps; store: InMemoryStore } {
  const store: InMemoryStore = { current: null, reads: 0, writes: [], deletes: 0 };
  const deps: AuthDeps = {
    client: mock,
    readToken: (): string | null => {
      store.reads += 1;
      return store.current;
    },
    writeToken: (t: string): void => {
      store.writes.push(t);
      store.current = t;
    },
    deleteToken: (): boolean => {
      store.deletes += 1;
      if (store.current === null) return false;
      store.current = null;
      return true;
    },
    tokenPath: (): string => '/tmp/fake/token',
  };
  return { deps, store };
}

describe('authLoginCore', () => {
  let mock: MockEalClient;

  beforeEach(() => {
    mock = createMockEalClient();
  });

  test('errors when token is missing', async () => {
    const { deps, store } = makeDeps(mock);
    const result = await authLoginCore(deps, undefined);
    expect(result.code).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.message).toMatch(/--token=<token> is required/);
    expect(store.writes).toEqual([]);
  });

  test('errors when token is the empty string', async () => {
    const { deps, store } = makeDeps(mock);
    const result = await authLoginCore(deps, '');
    expect(result.code).toBe(1);
    expect(store.writes).toEqual([]);
  });

  test('errors when api rejects the token (getCurrentUser returns null)', async () => {
    // Mock with no setCurrentUser → getCurrentUser returns null.
    const { deps, store } = makeDeps(mock);
    const result = await authLoginCore(deps, 'eal_v1_bogus');
    expect(result.code).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.message).toMatch(/token rejected/);
    expect(store.writes).toEqual([]);
  });

  test('writes the token and emits a success message when accepted', async () => {
    mock.setCurrentUser({ userId: 7, displayName: 'alex' });
    const { deps, store } = makeDeps(mock);
    const result = await authLoginCore(deps, 'eal_v1_good');
    expect(result.code).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.message).toContain('signed in');
    expect(result.message).toContain('alex');
    expect(store.writes).toEqual(['eal_v1_good']);
  });
});

describe('authStatusCore', () => {
  let mock: MockEalClient;

  beforeEach(() => {
    mock = createMockEalClient();
  });

  test('reports not signed in when no token is on disk', async () => {
    const { deps } = makeDeps(mock);
    const result = await authStatusCore(deps);
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/not signed in/);
  });

  test('reports invalid/expired when a token is present but api rejects it', async () => {
    const { deps, store } = makeDeps(mock);
    store.current = 'eal_v1_stale';
    const result = await authStatusCore(deps);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/invalid or expired/);
  });

  test('reports signed in when a token resolves to a user', async () => {
    mock.setCurrentUser({ userId: 7, displayName: 'leo' });
    const { deps, store } = makeDeps(mock);
    store.current = 'eal_v1_ok';
    const result = await authStatusCore(deps);
    expect(result.code).toBe(0);
    expect(result.message).toContain('signed in');
    expect(result.message).toContain('leo');
  });
});

describe('authLogoutCore', () => {
  let mock: MockEalClient;

  beforeEach(() => {
    mock = createMockEalClient();
  });

  test('reports not signed in when no token is on disk and does not call signOut', async () => {
    const { deps, store } = makeDeps(mock);
    const result = await authLogoutCore(deps);
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/not signed in/);
    expect(store.deletes).toBe(0);
  });

  test('calls signOut + deletes the token + reports success', async () => {
    mock.setCurrentUser({ userId: 1, displayName: 'alex' });
    const { deps, store } = makeDeps(mock);
    store.current = 'eal_v1_ok';
    const result = await authLogoutCore(deps);
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/signed out/);
    expect(store.deletes).toBe(1);
    expect(store.current).toBeNull();
    // The mock's signOut clears its internal currentUser; verify that, too.
    expect(await mock.getCurrentUser()).toBeNull();
  });

  test('survives signOut errors and still removes the local token', async () => {
    // Force a signOut failure by replacing the mock's signOut briefly.
    mock.setCurrentUser({ userId: 1, displayName: 'alex' });
    const { deps, store } = makeDeps({
      ...mock,
      signOut: () => Promise.reject(new Error('network ded')),
    });
    store.current = 'eal_v1_ok';
    const result = await authLogoutCore(deps);
    expect(result.code).toBe(0);
    expect(store.deletes).toBe(1);
    expect(store.current).toBeNull();
  });
});
