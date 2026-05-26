import type { FamilyPhoneCallEvent, FamilyPhoneDeviceConnection } from '@eal/client';
import type { VoiceLoop } from './voice-loop.ts';

/**
 * Handler for the agent's family-phone device socket.
 *
 * When given a `voiceLoopFactory`, the handler accepts each incoming
 * call and routes inbound audio through the loop, piping the synthetic
 * reply back over the same socket. Without a factory it falls back to
 * politely rejecting calls so the directory entry never lies about
 * what the worker can do.
 *
 * Only one concurrent call is supported. A second incoming call is
 * rejected with a clear reason; v2 can revisit when needed.
 */

export interface AgentPhoneHandlerDeps {
  log: (line: string) => void;
  /**
   * Reason returned to the caller when the agent declines a call. Used
   * both when no voice loop is configured and when the worker is
   * already on another call.
   */
  rejectReason: string;
  /**
   * Build a VoiceLoop for one accepted call. The factory receives the
   * call id and a `sendAudio` closure already bound to that call. If
   * omitted the handler stays in reject-only mode.
   */
  voiceLoopFactory?: (
    callId: string,
    sendAudio: (payload: Uint8Array) => void,
  ) => VoiceLoop;
}

export function installAgentPhoneHandler(
  connection: FamilyPhoneDeviceConnection,
  deps: AgentPhoneHandlerDeps,
): () => void {
  let currentCallId: string | null = null;
  let currentLoop: VoiceLoop | null = null;

  function endCurrentCall(): void {
    if (currentLoop) currentLoop.close();
    currentLoop = null;
    currentCallId = null;
  }

  const offCall = connection.subscribe((event: FamilyPhoneCallEvent) => {
    if (event.type === 'call:incoming') {
      if (deps.voiceLoopFactory === undefined) {
        deps.log(
          `eal agent: call ${event.callId} from device ${event.fromDeviceId} — rejecting (${deps.rejectReason})`,
        );
        connection.rejectCall(event.callId);
        return;
      }
      if (currentCallId !== null) {
        deps.log(
          `eal agent: call ${event.callId} from device ${event.fromDeviceId} — rejecting (already on call ${currentCallId})`,
        );
        connection.rejectCall(event.callId);
        return;
      }
      currentCallId = event.callId;
      const sendAudio = (payload: Uint8Array): void => {
        if (currentCallId !== null) connection.sendAudio(currentCallId, payload);
      };
      currentLoop = deps.voiceLoopFactory(event.callId, sendAudio);
      deps.log(`eal agent: accepting call ${event.callId} from device ${event.fromDeviceId}`);
      connection.acceptCall(event.callId);
      return;
    }
    if (event.type === 'call:hung-up') {
      if (event.callId === currentCallId) {
        deps.log(`eal agent: call ${event.callId} hung up${event.reason ? ` (${event.reason})` : ''}`);
        endCurrentCall();
      }
      return;
    }
    if (event.type === 'directory:changed' || event.type === 'presence:changed') {
      return;
    }
    deps.log(`eal agent: family-phone event ${event.type}`);
  });

  const offAudio = connection.subscribeAudio((callId, payload) => {
    if (callId === currentCallId && currentLoop) currentLoop.onInboundFrame(payload);
  });

  return () => {
    offCall();
    offAudio();
    endCurrentCall();
  };
}

export const DEFAULT_REJECT_REASON =
  'voice not yet implemented — the agent appears online but cannot take calls';
