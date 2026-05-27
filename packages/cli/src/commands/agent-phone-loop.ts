import type {
  FamilyPhoneCallEvent,
  FamilyPhoneDeviceConnection,
  FamilyPhoneDeviceKind,
} from '@eal/client';
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

export interface VoiceLoopFactoryInput {
  callId: string;
  /**
   * The device id of the call's originator. Used by the factory to
   * decide which reply channel to wire up — for example, a PWA peer
   * gets the text channel; a handset gets audio only.
   */
  fromDeviceId: number;
  /** Send a PCM frame back to the caller. */
  sendAudio: (payload: Uint8Array) => void;
  /**
   * Send a sentence back as a text frame instead of audio. The
   * factory chooses whether to expose this to the voice loop; loops
   * given the function emit text and skip TTS, loops without it fall
   * back to local TTS + sendAudio.
   */
  sendText: (text: string) => void;
  /**
   * The caller's declared device kind — `pwa`, `handset`, `agent`, or
   * null when a directory lookup failed. The factory uses this to
   * decide whether `sendText` is appropriate to route through to the
   * loop (PWAs render text locally via Web Speech; other kinds cannot).
   */
  callerKind: FamilyPhoneDeviceKind | null;
}

export interface AgentPhoneHandlerDeps {
  log: (line: string) => void;
  /**
   * Reason returned to the caller when the agent declines a call. Used
   * both when no voice loop is configured and when the worker is
   * already on another call.
   */
  rejectReason: string;
  /**
   * Build a VoiceLoop for one accepted call. Receives the call id, the
   * caller's device id and kind, and both reply channels — the factory
   * decides which channel to expose to the loop. If omitted the handler
   * stays in reject-only mode.
   */
  voiceLoopFactory?: (input: VoiceLoopFactoryInput) => VoiceLoop;
  /**
   * Look up a paired device's kind from the directory so the factory
   * can pick the right reply channel. Returns null when the device id
   * is unknown or the lookup fails — the factory then defaults to
   * audio (the lowest-common-denominator channel).
   */
  lookupDeviceKind?: (deviceId: number) => Promise<FamilyPhoneDeviceKind | null>;
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
      // Reserve the slot synchronously so a second incoming call during
      // the directory lookup still hits the busy guard above.
      currentCallId = event.callId;
      void acceptCall(event.callId, event.fromDeviceId, deps.voiceLoopFactory);
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

  async function acceptCall(
    callId: string,
    fromDeviceId: number,
    factory: (input: VoiceLoopFactoryInput) => VoiceLoop,
  ): Promise<void> {
    let callerKind: FamilyPhoneDeviceKind | null = null;
    if (deps.lookupDeviceKind !== undefined) {
      try {
        callerKind = await deps.lookupDeviceKind(fromDeviceId);
      } catch (err) {
        deps.log(
          `eal agent: device-kind lookup failed for ${fromDeviceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // The call may have been hung up while the lookup was in flight.
    if (currentCallId !== callId) return;

    const sendAudio = (payload: Uint8Array): void => {
      if (currentCallId !== null) connection.sendAudio(currentCallId, payload);
    };
    const sendText = (text: string): void => {
      if (currentCallId !== null) connection.sendText(currentCallId, text);
    };
    currentLoop = factory({ callId, fromDeviceId, sendAudio, sendText, callerKind });
    deps.log(
      `eal agent: accepting call ${callId} from device ${fromDeviceId}` +
        (callerKind !== null ? ` (kind=${callerKind})` : ''),
    );
    connection.acceptCall(callId);
  }

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
