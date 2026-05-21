import { beforeEach, describe, expect, test } from 'bun:test';
import { clearStateRegistry } from '@fairfox/polly/state';
import { mintSession, revokeAllSessions, revokeSession, sessionsMachine } from './sessions-machine.ts';

/**
 * See `auth-machine.test.ts` for the ANCHORING GAP banner. Same caveats apply:
 * requires/ensures are runtime no-ops; only `bun devctl verify` catches bad
 * sequences. These tests verify the counter wiring on valid call sequences.
 */

function reset(): void {
  clearStateRegistry();
  sessionsMachine.value = { outstanding: 0 };
}

describe('sessions-machine (shadow) — happy path counter wiring', () => {
  beforeEach(reset);

  test('starts at 0', () => {
    expect(sessionsMachine.value.outstanding).toBe(0);
  });

  test('mintSession increments by 1', () => {
    mintSession();
    expect(sessionsMachine.value.outstanding).toBe(1);
  });

  test('mint twice + revoke once leaves 1 outstanding', () => {
    mintSession();
    mintSession();
    revokeSession();
    expect(sessionsMachine.value.outstanding).toBe(1);
  });

  test('mint twice + revokeAllSessions zeros the counter', () => {
    mintSession();
    mintSession();
    revokeAllSessions();
    expect(sessionsMachine.value.outstanding).toBe(0);
  });

  test('revokeAllSessions on an empty counter stays at 0', () => {
    revokeAllSessions();
    expect(sessionsMachine.value.outstanding).toBe(0);
  });
});
