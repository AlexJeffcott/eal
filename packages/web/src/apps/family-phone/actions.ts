import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AppStores } from '../../stores.ts';
import type { FamilyPhoneCallEvent } from '@eal/client';
import { $activeCall, $callNote, $incomingCall } from './stores.ts';
import { $deviceConnection, $devices } from '../devices/stores.ts';
import {
  startAudioCapture,
  startAudioPlayback,
  type AudioCapture,
  type AudioPlayback,
} from './audio.ts';
import { Ringtone } from './ringtone.ts';
import { IncomingCallNotifier } from './notifications.ts';
import {
  speechSynthesis,
  SpeechSynthesisUtterance,
} from '../../platform/speech-synthesis.ts';

/**
 * Singletons for the in-page ringtone + browser notification. Both pull
 * their browser dependencies through the per-API adapter modules
 * (platform/audio-context.ts, platform/notification.ts), so tests mock
 * those modules to spy on the calls. Lazy-build so importing this
 * module has no audio side effect at boot.
 */
let ringtoneInstance: Ringtone | null = null;
let notifierInstance: IncomingCallNotifier | null = null;

function ringtone(): Ringtone {
  if (ringtoneInstance === null) ringtoneInstance = new Ringtone();
  return ringtoneInstance;
}
function notifier(): IncomingCallNotifier {
  if (notifierInstance === null) notifierInstance = new IncomingCallNotifier();
  return notifierInstance;
}

/**
 * Ask the browser for every permission this app needs from a single user
 * gesture. Today that is the Notifications API; microphone is requested
 * just-in-time on call accept because browsers require it on a per-call
 * gesture anyway. Returns the resolved state.
 */
export async function requestCallPermissions(): Promise<{
  notifications: NotificationPermission | 'unsupported';
}> {
  const result = await notifier().requestPermission();
  return { notifications: result };
}

function callerLabel(fromDeviceId: number): { title: string; body: string } {
  const device = $devices.value.find((d) => d.id === fromDeviceId);
  if (!device) {
    return { title: 'Incoming call', body: `device #${fromDeviceId} is calling` };
  }
  return {
    title: 'Incoming call',
    body: `${device.label} (${device.ownerDisplayName}) is calling`,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Live audio resources for the current call, owned at module scope because
 * they are side-effecty (microphone permission, AudioContext) and there is
 * never more than one active call. Cleared on hangup / peer disconnect.
 */
interface ActiveAudio {
  callId: string;
  capture: AudioCapture;
  playback: AudioPlayback;
  unsubscribeAudio: () => void;
}
let activeAudio: ActiveAudio | null = null;

async function startAudioForCall(
  callId: string,
  conn: NonNullable<typeof $deviceConnection.value>,
): Promise<void> {
  if (activeAudio) await stopAudio();
  const playback = await startAudioPlayback();
  const unsubscribeAudio = conn.subscribeAudio((cid, payload) => {
    if (cid !== callId) return;
    playback.push(payload);
  });
  try {
    const capture = await startAudioCapture((payload) => {
      conn.sendAudio(callId, payload);
    });
    activeAudio = { callId, capture, playback, unsubscribeAudio };
  } catch (err) {
    // Mic permission denied or hardware failure — keep the call up so the
    // user can still hear the other side, but flag the asymmetry.
    unsubscribeAudio();
    await playback.stop();
    $callNote.value = `Microphone unavailable (${describeError(err)}); incoming audio disabled.`;
    throw err;
  }
}

async function stopAudio(): Promise<void> {
  const a = activeAudio;
  if (!a) return;
  activeAudio = null;
  a.unsubscribeAudio();
  await a.capture.stop().catch(() => {});
  await a.playback.stop().catch(() => {});
}

/**
 * Wire the device's call signalling events into the local stores. Attached
 * to the live WS connection by the devices bootstrap (which also subscribes
 * its own directory handler to the same connection). Only handles `call:*`
 * cases here; presence and directory updates are the devices app's job.
 */
export function installCallEventHandlers(event: FamilyPhoneCallEvent): void {
  switch (event.type) {
    case 'call:invite-ack': {
      const current = $activeCall.value;
      if (current && current.role === 'caller' && current.callId === '') {
        $activeCall.value = { ...current, callId: event.callId };
      }
      return;
    }
    case 'call:invite-failed': {
      $activeCall.value = null;
      $callNote.value = `Call could not be placed: ${event.reason}.`;
      return;
    }
    case 'call:incoming': {
      $incomingCall.value = { callId: event.callId, fromDeviceId: event.fromDeviceId };
      const { title, body } = callerLabel(event.fromDeviceId);
      ringtone().start();
      notifier().show(title, body);
      return;
    }
    case 'call:accepted': {
      const current = $activeCall.value;
      if (current && current.role === 'caller' && current.callId === event.callId) {
        $activeCall.value = { ...current, state: 'connected' };
        const conn = $deviceConnection.value;
        if (conn) {
          void startAudioForCall(event.callId, conn).catch(() => { /* note already set */ });
        }
      }
      return;
    }
    case 'call:accept-ack': {
      const current = $activeCall.value;
      if (current && current.role === 'callee' && current.callId === event.callId) {
        $activeCall.value = { ...current, state: 'connected' };
        // Callee just answered — silence the ring and dismiss the banner.
        void ringtone().stop();
        notifier().dismiss();
        const conn = $deviceConnection.value;
        if (conn) {
          void startAudioForCall(event.callId, conn).catch(() => { /* note already set */ });
        }
      }
      return;
    }
    case 'call:rejected': {
      $activeCall.value = null;
      $callNote.value = 'Call was rejected.';
      void ringtone().stop();
      notifier().dismiss();
      void stopAudio();
      return;
    }
    case 'call:cancelled': {
      $incomingCall.value = null;
      $callNote.value = 'Caller cancelled the call.';
      void ringtone().stop();
      notifier().dismiss();
      void stopAudio();
      return;
    }
    case 'call:hung-up': {
      $activeCall.value = null;
      $incomingCall.value = null;
      $callNote.value =
        event.reason === 'peer-disconnect' ? 'The other device disconnected.' : 'Call ended.';
      void ringtone().stop();
      notifier().dismiss();
      void stopAudio();
      stopSpeaking();
      return;
    }
    case 'call:unanswered': {
      // The server's unanswered timer fired on a pending outbound call.
      // Mirrors the rejected handler — the call is over before it ever
      // produced audio, so audio teardown is a defensive no-op.
      $activeCall.value = null;
      $callNote.value = 'No answer.';
      void ringtone().stop();
      notifier().dismiss();
      void stopAudio();
      return;
    }
    case 'call:text': {
      // The agent sends spoken text instead of audio when it knows this
      // peer can synthesise locally. Queue the sentence into the Web
      // Speech API; the browser plays it on the user's system voice.
      speakText(event.text);
      return;
    }
    case 'presence:changed':
    case 'directory:changed':
      // Devices app handles these on the same connection.
      return;
  }
}

/**
 * Queue a sentence into the browser's SpeechSynthesis. Each call adds
 * one utterance to the system queue, so a long reply that lands as
 * several `call:text` frames plays sentence-by-sentence in order. A
 * platform without the API (older browser, headless test runner) drops
 * the text silently — the agent has no way to know we couldn't render
 * it, and the user just hears nothing.
 */
function speakText(text: string): void {
  if (speechSynthesis === null || SpeechSynthesisUtterance === null) return;
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  speechSynthesis.speak(new SpeechSynthesisUtterance(trimmed));
}

function stopSpeaking(): void {
  if (speechSynthesis === null) return;
  speechSynthesis.cancel();
}

/**
 * Reset call-only state. Called from devices on un-pair / delete-self so
 * the call surface clears alongside the WS connection it depended on.
 */
export function resetFamilyPhoneCallState(): void {
  $activeCall.value = null;
  $incomingCall.value = null;
  $callNote.value = null;
  void ringtone().stop();
  notifier().dismiss();
  void stopAudio();
}

export const FAMILY_PHONE_ACTIONS: ActionRegistry<AppStores> = {
  'family-phone:dismiss-note': ({ stores }) => {
    stores.$callNote.value = null;
  },

  'family-phone:place-call': ({ data, stores }) => {
    const raw = data['targetDeviceId'];
    if (typeof raw !== 'string') return;
    const target = Number(raw);
    if (!Number.isFinite(target) || target <= 0) return;
    const conn = stores.$deviceConnection.value;
    if (!conn) {
      stores.$callNote.value = 'Pair this browser in Devices to place a call.';
      return;
    }
    if (stores.$activeCall.value !== null) {
      stores.$callNote.value = 'Already in a call.';
      return;
    }
    // The real call_id arrives on call:invite-ack; mark pending with an
    // empty placeholder so the UI can render an "Outgoing…" surface.
    stores.$activeCall.value = {
      callId: '',
      role: 'caller',
      peerDeviceId: target,
      state: 'pending',
    };
    conn.placeCall(target);
  },

  'family-phone:accept-call': ({ data, stores }) => {
    const callId = data['callId'];
    if (typeof callId !== 'string' || callId.length === 0) return;
    const incoming = stores.$incomingCall.value;
    if (!incoming || incoming.callId !== callId) return;
    const conn = stores.$deviceConnection.value;
    if (!conn) return;
    stores.$activeCall.value = {
      callId,
      role: 'callee',
      peerDeviceId: incoming.fromDeviceId,
      state: 'pending',
    };
    stores.$incomingCall.value = null;
    conn.acceptCall(callId);
  },

  'family-phone:reject-call': ({ data, stores }) => {
    const callId = data['callId'];
    if (typeof callId !== 'string' || callId.length === 0) return;
    const incoming = stores.$incomingCall.value;
    if (!incoming || incoming.callId !== callId) return;
    const conn = stores.$deviceConnection.value;
    if (!conn) return;
    stores.$incomingCall.value = null;
    conn.rejectCall(callId);
  },

  'family-phone:hangup': ({ stores }) => {
    const active = stores.$activeCall.value;
    if (!active) return;
    const conn = stores.$deviceConnection.value;
    if (!conn) return;
    if (active.role === 'caller' && active.state === 'pending' && active.callId !== '') {
      conn.cancelCall(active.callId);
    } else if (active.callId !== '') {
      conn.hangup(active.callId);
    }
    // The server delivers call:hung-up only to the peer, not the initiator,
    // so we clear our own state immediately rather than waiting for a
    // confirmation that never arrives.
    stores.$activeCall.value = null;
    stores.$callNote.value = 'Call ended.';
    void stopAudio();
  },

  'family-phone:load-voicemails': async ({ stores }) => {
    stores.$voiceMessagesError.value = null;
    const paired = stores.$pairedThisSession.value;
    if (paired === null) {
      stores.$voiceMessages.value = [];
      return;
    }
    try {
      stores.$voiceMessages.value = await stores.client.listVoiceMessages({
        deviceId: paired.deviceId,
      });
    } catch (err) {
      stores.$voiceMessagesError.value = describeError(err);
    }
  },

  'family-phone:play-voicemail': async ({ data, stores }) => {
    const raw = data['voicemailId'];
    if (typeof raw !== 'string') return;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    stores.$voiceMessagesError.value = null;
    stores.$playingVoiceMessageId.value = id;
    // Revoke any previous blob URL before swapping; otherwise the
    // page accumulates them until the tab is closed.
    if (stores.$voiceMessageAudioUrl.value !== null) {
      try {
        URL.revokeObjectURL(stores.$voiceMessageAudioUrl.value);
      } catch {
        /* best-effort */
      }
      stores.$voiceMessageAudioUrl.value = null;
    }
    try {
      const bytes = await stores.client.getVoiceMessageAudio(id);
      const blob = new Blob([bytes], { type: 'audio/wav' });
      stores.$voiceMessageAudioUrl.value = URL.createObjectURL(blob);
      await stores.client.markVoiceMessageRead(id);
      // Reflect the freshly-read row locally so the badge updates
      // without a round-trip.
      stores.$voiceMessages.value = stores.$voiceMessages.value.map((vm) =>
        vm.id === id && vm.readAt === null
          ? { ...vm, readAt: new Date().toISOString() }
          : vm,
      );
    } catch (err) {
      stores.$voiceMessagesError.value = describeError(err);
      stores.$playingVoiceMessageId.value = null;
    }
  },

  'family-phone:close-voicemail-player': ({ stores }) => {
    if (stores.$voiceMessageAudioUrl.value !== null) {
      try {
        URL.revokeObjectURL(stores.$voiceMessageAudioUrl.value);
      } catch {
        /* best-effort */
      }
      stores.$voiceMessageAudioUrl.value = null;
    }
    stores.$playingVoiceMessageId.value = null;
  },

  'family-phone:dismiss-voicemail-error': ({ stores }) => {
    stores.$voiceMessagesError.value = null;
  },
};
