import { beforeEach, describe, expect, test } from 'bun:test';
import { clearStateRegistry } from '@fairfox/polly/state';
import { consume, create, expire, pairingMachine } from './pairing-machine.ts';

/**
 * Shadow-model transition tests. Same ANCHORING GAP caveat as the rest of
 * the specs/ tier. The production handlers (family-phone-pair.shared.ts,
 * added in Phase C) do not call these transitions — `bun devctl verify` is
 * what proves no reachable interleaving violates the model's requires /
 * ensures invariants.
 */

function reset(): void {
  clearStateRegistry();
  pairingMachine.value = { state: 'nonexistent' };
}

describe('pairing-machine — happy path transitions', () => {
  beforeEach(reset);

  test('starts nonexistent', () => {
    expect(pairingMachine.value.state).toBe('nonexistent');
  });

  test('create moves nonexistent → pending', () => {
    create();
    expect(pairingMachine.value.state).toBe('pending');
  });

  test('consume moves pending → consumed', () => {
    create();
    consume();
    expect(pairingMachine.value.state).toBe('consumed');
  });

  test('expire moves pending → expired', () => {
    create();
    expire();
    expect(pairingMachine.value.state).toBe('expired');
  });
});
