import { beforeEach, describe, expect, test } from 'bun:test';
import { clearStateRegistry } from '@fairfox/polly/state';
import {
  authGateMachine,
  classifyAsAppOwned,
  classifyAsPrincipalRequired,
  classifyAsPublic,
  passThrough,
  principalAbsent,
  principalPresent,
  resetRequest,
} from './auth-gate-machine.ts';

/**
 * Shadow-model transition tests. Same ANCHORING GAP caveat as the rest of
 * the specs/ tier: these prove the model is internally consistent;
 * `bun devctl verify` is what proves no reachable interleaving violates the
 * requires/ensures invariants. The production `onBeforeHandle` callback in
 * server-factory.ts does NOT call these transitions — it mirrors them.
 */

function reset(): void {
  clearStateRegistry();
  authGateMachine.value = { state: 'undecided' };
}

describe('auth-gate-machine — happy path transitions', () => {
  beforeEach(reset);

  test('starts undecided', () => {
    expect(authGateMachine.value.state).toBe('undecided');
  });

  test('public path: undecided → public → handled', () => {
    classifyAsPublic();
    expect(authGateMachine.value.state).toBe('public');
    passThrough();
    expect(authGateMachine.value.state).toBe('handled');
  });

  test('app-owned path: undecided → appOwned → handled', () => {
    classifyAsAppOwned();
    expect(authGateMachine.value.state).toBe('appOwned');
    passThrough();
    expect(authGateMachine.value.state).toBe('handled');
  });

  test('principal-present path: undecided → principalRequired → handled', () => {
    classifyAsPrincipalRequired();
    expect(authGateMachine.value.state).toBe('principalRequired');
    principalPresent();
    expect(authGateMachine.value.state).toBe('handled');
  });

  test('principal-absent path: undecided → principalRequired → rejected', () => {
    classifyAsPrincipalRequired();
    principalAbsent();
    expect(authGateMachine.value.state).toBe('rejected');
  });

  test('resetRequest returns from handled to undecided for the next request', () => {
    classifyAsPublic();
    passThrough();
    resetRequest();
    expect(authGateMachine.value.state).toBe('undecided');
  });

  test('resetRequest returns from rejected to undecided', () => {
    classifyAsPrincipalRequired();
    principalAbsent();
    resetRequest();
    expect(authGateMachine.value.state).toBe('undecided');
  });
});
