import { $state } from '@fairfox/polly/state';
import type { VoiceMessage } from '@eal/client';

/** Reactive state owned by the family-phone app: call lifecycle only.
 *  Device identity, pair flow, and the WS connection itself live in the
 *  devices app (../devices/stores.ts) — family-phone is a call surface
 *  consuming the devices it finds in the household directory. */

/** A banner shown when another device is ringing this one. */
export const $incomingCall = $state<{ callId: string; fromDeviceId: number } | null>(null);

/**
 * The active call this device is participating in, from either side.
 *  - `pending`: invite sent / received, awaiting accept;
 *  - `connected`: both peers in-call;
 *  - `closing`: hangup is in flight (UI feedback only — server already closed).
 */
export type ActiveCallState = 'pending' | 'connected' | 'closing';
export interface ActiveCall {
  callId: string;
  role: 'caller' | 'callee';
  peerDeviceId: number;
  state: ActiveCallState;
}
export const $activeCall = $state<ActiveCall | null>(null);

/** Surfaced for one-shot info messages: "call rejected", "peer disconnected". */
export const $callNote = $state<string | null>(null);

/** Running transcript for the active call. The agent emits its spoken
 *  replies as `call:text` frames; we mirror them here so the user can
 *  read the line even when the device's speaker is silent (iOS PWA
 *  standalone mode, mute switch on, accessibility, noisy room). Cleared
 *  on every new call so each transcript stands on its own. */
export interface CallTranscriptEntry {
  id: number;
  role: 'agent';
  text: string;
  at: string;
}
export const $callTranscript = $state<CallTranscriptEntry[]>([]);

/** Voicemails addressed to the device this browser is paired as. The
 *  list is mirrored from `/api/family-phone/voice-messages?device_id=…`
 *  on every route entry plus after the audio handler stamps a row read. */
export const $voiceMessages = $state<VoiceMessage[]>([]);
/** Last error from the voicemail load/play path. Cleared by the user. */
export const $voiceMessagesError = $state<string | null>(null);
/** The id of the voicemail currently fetching audio or playing, or null. */
export const $playingVoiceMessageId = $state<number | null>(null);
/** Blob URL for the currently-playing voicemail audio; null when none
 *  is loaded. Created in `voicemail:play`, revoked when a new mail is
 *  played or the panel resets. */
export const $voiceMessageAudioUrl = $state<string | null>(null);

export interface FamilyPhoneStores {
  $incomingCall: typeof $incomingCall;
  $activeCall: typeof $activeCall;
  $callNote: typeof $callNote;
  $callTranscript: typeof $callTranscript;
  $voiceMessages: typeof $voiceMessages;
  $voiceMessagesError: typeof $voiceMessagesError;
  $playingVoiceMessageId: typeof $playingVoiceMessageId;
  $voiceMessageAudioUrl: typeof $voiceMessageAudioUrl;
}

export function createFamilyPhoneStores(): FamilyPhoneStores {
  return {
    $incomingCall,
    $activeCall,
    $callNote,
    $callTranscript,
    $voiceMessages,
    $voiceMessagesError,
    $playingVoiceMessageId,
    $voiceMessageAudioUrl,
  };
}

export function resetFamilyPhoneStores(): void {
  $incomingCall.value = null;
  $activeCall.value = null;
  $callNote.value = null;
  $callTranscript.value = [];
  $voiceMessages.value = [];
  $voiceMessagesError.value = null;
  $playingVoiceMessageId.value = null;
  if ($voiceMessageAudioUrl.value !== null) {
    try {
      URL.revokeObjectURL($voiceMessageAudioUrl.value);
    } catch {
      /* best-effort */
    }
  }
  $voiceMessageAudioUrl.value = null;
}
