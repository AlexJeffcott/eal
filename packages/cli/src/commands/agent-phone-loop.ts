import type { FamilyPhoneCallEvent, FamilyPhoneDeviceConnection } from '@eal/client';

/**
 * Handler for the agent's family-phone device socket.
 *
 * v0: the worker pairs onto family-phone purely so it appears as
 * 'online' in the directory and the call path can be verified
 * end-to-end. Voice is not implemented yet, so any incoming call is
 * politely rejected with a reason the UI can surface. When the voice
 * loop lands this is the seam to swap.
 */

export interface AgentPhoneHandlerDeps {
  log: (line: string) => void;
  /**
   * Reason returned to the caller when the agent rejects a call. Kept
   * injectable so the eventual voice-capable handler can advertise its
   * own state ("agent is busy on another call", etc.) without forking
   * this module.
   */
  rejectReason: string;
}

/**
 * Subscribe to call events on an open connection. Returns an
 * unsubscribe that detaches the handler without closing the connection
 * itself — the caller owns the lifetime.
 */
export function installAgentPhoneHandler(
  connection: FamilyPhoneDeviceConnection,
  deps: AgentPhoneHandlerDeps,
): () => void {
  const handle = (event: FamilyPhoneCallEvent): void => {
    if (event.type === 'call:incoming') {
      deps.log(
        `eal agent: call ${event.callId} from device ${event.fromDeviceId} — rejecting (${deps.rejectReason})`,
      );
      connection.rejectCall(event.callId);
      return;
    }
    if (event.type === 'call:hung-up') {
      deps.log(`eal agent: call ${event.callId} hung up${event.reason ? ` (${event.reason})` : ''}`);
      return;
    }
    if (event.type === 'directory:changed' || event.type === 'presence:changed') {
      // Quiet: these fire on every roster update and would flood the log.
      return;
    }
    deps.log(`eal agent: family-phone event ${event.type}`);
  };
  return connection.subscribe(handle);
}

export const DEFAULT_REJECT_REASON =
  'voice not yet implemented — the agent appears online but cannot take calls';
