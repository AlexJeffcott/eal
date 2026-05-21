import { beforeEach, describe, expect, test } from 'bun:test';
import { clearStateRegistry } from '@fairfox/polly/state';
import { beginConnect, connectFailed, connectSucceeded, disconnect, wsMachine } from './ws-machine.ts';

/**
 * See `auth-machine.test.ts` for the ANCHORING GAP banner. Same caveats apply:
 * requires/ensures are runtime no-ops; only `bun devctl verify` catches bad
 * sequences. These tests verify happy-path transitions only.
 */

function reset(): void {
  clearStateRegistry();
  wsMachine.value = { state: 'idle' };
}

describe('ws-machine (shadow) — happy path transitions', () => {
  beforeEach(reset);

  test('starts idle', () => {
    expect(wsMachine.value.state).toBe('idle');
  });

  test('idle → connecting → connected → idle', () => {
    beginConnect();
    expect(wsMachine.value.state).toBe('connecting');
    connectSucceeded();
    expect(wsMachine.value.state).toBe('connected');
    disconnect();
    expect(wsMachine.value.state).toBe('idle');
  });

  test('idle → connecting → error → idle', () => {
    beginConnect();
    connectFailed();
    expect(wsMachine.value.state).toBe('error');
    disconnect();
    expect(wsMachine.value.state).toBe('idle');
  });

  test('successive reconnect cycles return to idle each time', () => {
    for (let i = 0; i < 3; i += 1) {
      beginConnect();
      connectSucceeded();
      disconnect();
    }
    expect(wsMachine.value.state).toBe('idle');
  });
});
