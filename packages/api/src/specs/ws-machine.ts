/**
 * Shadow WS connection state machine for `polly verify`. Not imported by
 * production code. See `auth-machine.ts` for the full ANCHORING GAP banner —
 * same caveats apply: spec is intent, requires/ensures are runtime no-ops,
 * only `bun devctl verify` catches bad sequences.
 *
 * Transitions:
 *
 *   idle ──beginConnect──▶ connecting ──connectSucceeded──▶ connected
 *                                │                              │
 *                                └──connectFailed──▶ error      │
 *                                                       │       │
 *                                                       │       ▼
 *                                                       └──▶ idle ◀──disconnect
 *
 * The model proves:
 *   - connected is reachable only via connecting (no shortcut from idle)
 *   - error is a terminal "needs reset" state until disconnect resets it
 *   - disconnect requires non-idle (can't double-disconnect)
 *
 * Cross-machine invariants with `auth-machine.ts` are not yet encoded; the
 * runtime contract is that the SPA only calls beginConnect when authenticated,
 * but the TLC model treats the machines as independent for now.
 */
import { $sharedState } from '@fairfox/polly/state';
import { ensures, requires } from '@fairfox/polly/verify';

export type WsState = 'idle' | 'connecting' | 'connected' | 'error';

export const wsMachine = $sharedState<{ state: WsState }>('ws', { state: 'idle' });

export function beginConnect(): void {
  requires(wsMachine.value.state === 'idle', 'beginConnect: must start idle');
  wsMachine.value = { state: 'connecting' };
  ensures(wsMachine.value.state === 'connecting', 'beginConnect: end connecting');
}

export function connectSucceeded(): void {
  requires(wsMachine.value.state === 'connecting', 'connectSucceeded: must be connecting');
  wsMachine.value = { state: 'connected' };
  ensures(wsMachine.value.state === 'connected', 'connectSucceeded: end connected');
}

export function connectFailed(): void {
  requires(wsMachine.value.state === 'connecting', 'connectFailed: must be connecting');
  wsMachine.value = { state: 'error' };
  ensures(wsMachine.value.state === 'error', 'connectFailed: end error');
}

export function disconnect(): void {
  requires(
    wsMachine.value.state === 'connected' || wsMachine.value.state === 'error',
    'disconnect: must be connected or error',
  );
  wsMachine.value = { state: 'idle' };
  ensures(wsMachine.value.state === 'idle', 'disconnect: end idle');
}
