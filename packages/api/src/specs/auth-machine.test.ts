import { beforeEach, describe, expect, test } from 'bun:test';
import { clearStateRegistry } from '@fairfox/polly/state';
import { authMachine, beginAuth, cancelAuth, completeAuth, signOut } from './auth-machine.ts';

/**
 * ┌─────────────────────────── ANCHORING GAP ───────────────────────────┐
 * │ These tests verify the auth-machine shadow MODEL transitions update │
 * │ state as written. They do NOT prove production handlers follow the  │
 * │ same sequencing:                                                    │
 * │                                                                     │
 * │   1. `requires` / `ensures` from `@fairfox/polly/verify` are        │
 * │      RUNTIME NO-OPS. They're parsed by the TLA+ extractor only.    │
 * │      So an "invalid sequence" test like calling completeAuth()      │
 * │      before beginAuth() does NOT throw at runtime — only `bun      │
 * │      devctl verify` catches that, via TLC model checking.          │
 * │                                                                     │
 * │   2. Production handlers (registerVerifyCore, logoutCore, etc.)     │
 * │      do NOT import these transition functions. They mutate sqlite   │
 * │      and return responses. The shadow model is an INTENT spec the   │
 * │      production code is supposed to match — not a wrapper around    │
 * │      it.                                                            │
 * │                                                                     │
 * │ Closing this gap requires refactoring handlers to call these        │
 * │ transitions (or equivalent runtime assertions). Tracked in TODO.    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

function reset(): void {
  clearStateRegistry();
  authMachine.value = { phase: 'anonymous' };
}

describe('auth-machine (shadow) — happy path transitions', () => {
  beforeEach(reset);

  test('starts in anonymous', () => {
    expect(authMachine.value.phase).toBe('anonymous');
  });

  test('beginAuth moves anonymous → authenticating', () => {
    beginAuth();
    expect(authMachine.value.phase).toBe('authenticating');
  });

  test('completeAuth moves authenticating → authenticated', () => {
    beginAuth();
    completeAuth();
    expect(authMachine.value.phase).toBe('authenticated');
  });

  test('cancelAuth moves authenticating → anonymous', () => {
    beginAuth();
    cancelAuth();
    expect(authMachine.value.phase).toBe('anonymous');
  });

  test('signOut moves authenticated → anonymous', () => {
    beginAuth();
    completeAuth();
    signOut();
    expect(authMachine.value.phase).toBe('anonymous');
  });

  test('full round-trip returns to anonymous', () => {
    beginAuth();
    completeAuth();
    signOut();
    beginAuth();
    completeAuth();
    signOut();
    expect(authMachine.value.phase).toBe('anonymous');
  });
});
