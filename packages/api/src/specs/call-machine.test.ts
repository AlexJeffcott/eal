import { beforeEach, describe, expect, test } from 'bun:test';
import { clearStateRegistry } from '@fairfox/polly/state';
import { accept, callMachine, cancel, hangup, invite, reject } from './call-machine.ts';

/**
 * Shadow-model transition tests. Same ANCHORING GAP caveat as the rest of
 * the specs/ tier — production WS handlers (family-phone.ws.ts) do not
 * call these transitions; `bun devctl verify` is what proves no reachable
 * interleaving violates the requires / ensures invariants.
 */

function reset(): void {
  clearStateRegistry();
  callMachine.value = { state: 'nonexistent' };
}

describe('call-machine — happy path transitions', () => {
  beforeEach(reset);

  test('starts nonexistent', () => {
    expect(callMachine.value.state).toBe('nonexistent');
  });

  test('invite: nonexistent → pending', () => {
    invite();
    expect(callMachine.value.state).toBe('pending');
  });

  test('accept: pending → connected', () => {
    invite();
    accept();
    expect(callMachine.value.state).toBe('connected');
  });

  test('reject: pending → closed', () => {
    invite();
    reject();
    expect(callMachine.value.state).toBe('closed');
  });

  test('cancel: pending → closed', () => {
    invite();
    cancel();
    expect(callMachine.value.state).toBe('closed');
  });

  test('hangup: connected → closed', () => {
    invite();
    accept();
    hangup();
    expect(callMachine.value.state).toBe('closed');
  });
});
