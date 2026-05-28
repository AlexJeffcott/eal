import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AppStores } from '../../stores.ts';
import type { FamilyPhoneCallEvent } from '@eal/client';
import {
  $activeCall,
  $callNote,
  $callTranscript,
  $incomingCall,
} from './stores.ts';
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
import { delay } from '@eal/shared';

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
      // Don't ship mic frames while the browser is speaking the agent's
      // reply — the speaker bleeds into the mic and the agent ends up
      // transcribing its own voice on the next turn. The `speaking`
      // flag covers active utterances; the trailing gate adds a small
      // grace period after the last word so the speaker's tail does
      // not sneak through on the very next frame.
      if (isAgentSpeaking()) return;
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
      // Also append to the in-call transcript so the user can read the
      // line whether or not the speaker actually produces sound — iOS
      // PWAs in standalone mode, the mute switch, and a noisy room all
      // silently swallow the spoken version.
      appendTranscript(event.text);
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
 * Tracks whether the local speaker is rendering an agent reply right
 * now (or has rendered one within the recent trailing window). The
 * call-capture path consults this so a frame the mic picks up off the
 * speaker is not sent back over the wire as fresh user speech. The
 * window survives the last utterance by ~400 ms — enough to cover the
 * speaker's physical decay and the audio system's buffered tail.
 */
const SPEECH_TAIL_MS = 400;
let lastAgentSpeechAt = 0;

export function isAgentSpeaking(): boolean {
  if (speechSynthesis !== null && (speechSynthesis.speaking || speechSynthesis.pending)) {
    return true;
  }
  return Date.now() - lastAgentSpeechAt < SPEECH_TAIL_MS;
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
  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.onend = (): void => {
    lastAgentSpeechAt = Date.now();
  };
  utterance.onerror = (): void => {
    lastAgentSpeechAt = Date.now();
  };
  speechSynthesis.speak(utterance);
}

/**
 * iOS Safari (and iOS PWAs in standalone mode in particular) silently
 * drop any `speechSynthesis.speak()` call that is not preceded by a
 * speak() invoked from within a user gesture. The agent's replies
 * arrive over the WebSocket — no gesture — so without priming the
 * very first utterance, and every utterance after it, plays nothing
 * on iOS. Call this from the click handlers that already exist
 * (place-call, accept-call). A short space-only utterance counts as
 * the priming speak; iOS sometimes also needs the voice list pulled
 * eagerly and the queue cleared before it will respect the first real
 * utterance, so we do those here as well. Keep `volume` audible —
 * volume=0 was observed on at least one iOS build to skip past the
 * speak() entirely without the unlock side effect.
 */
function primeSpeechSynthesis(): void {
  if (speechSynthesis === null || SpeechSynthesisUtterance === null) return;
  try {
    speechSynthesis.getVoices();
  } catch {
    /* best-effort */
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(' ');
  speechSynthesis.speak(u);
}

let nextTranscriptId = 1;

function appendTranscript(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  $callTranscript.value = [
    ...$callTranscript.value,
    { id: nextTranscriptId++, role: 'agent', text: trimmed, at: new Date().toISOString() },
  ];
}

function stopSpeaking(): void {
  if (speechSynthesis === null) return;
  speechSynthesis.cancel();
  lastAgentSpeechAt = Date.now();
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
    stores.$callTranscript.value = [];
    primeSpeechSynthesis();
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
    stores.$callTranscript.value = [];
    primeSpeechSynthesis();
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

  'family-phone:dismiss-diagnostics': ({ stores }) => {
    stores.$diagnosticsResult.value = null;
  },

  // Speak a short test phrase from a real user gesture. On iOS this both
  // primes the SpeechSynthesis API for the rest of the page's lifetime
  // and confirms that the device's speaker is actually producing sound
  // (mute switch, standalone PWA support, output route all in one).
  'family-phone:sound-check': ({ stores }) => {
    if (speechSynthesis === null || SpeechSynthesisUtterance === null) {
      stores.$diagnosticsResult.value = {
        message: 'Speech synthesis is not available in this browser.',
        tone: 'danger',
      };
      return;
    }
    primeSpeechSynthesis();
    const u = new SpeechSynthesisUtterance(
      'Sound check. If you can hear this, the agent will be audible during calls.',
    );
    u.onend = (): void => {
      stores.$diagnosticsResult.value = {
        message: 'Sound check finished. If you heard nothing, check the mute switch and that the PWA is up to date.',
        tone: 'info',
      };
    };
    u.onerror = (): void => {
      stores.$diagnosticsResult.value = {
        message: 'Sound check failed — the browser refused the utterance.',
        tone: 'danger',
      };
    };
    speechSynthesis.speak(u);
    stores.$diagnosticsResult.value = {
      message: 'Sound check: speaking…',
      tone: 'info',
    };
  },

  // Open the microphone briefly and count frames. A successful capture
  // proves that the permission is granted, the OS lets the browser have
  // the mic, and the WebAudio graph wakes up — the same chain a real
  // call depends on. Stops itself after a short window so the test
  // never lingers.
  'family-phone:mic-check': async ({ stores }) => {
    let frameCount = 0;
    let capture: AudioCapture | null = null;
    stores.$diagnosticsResult.value = {
      message: 'Mic check: listening for 1.5 seconds…',
      tone: 'info',
    };
    try {
      capture = await startAudioCapture(() => {
        frameCount += 1;
      });
    } catch (err) {
      stores.$diagnosticsResult.value = {
        message: `Mic check failed: ${describeError(err)}`,
        tone: 'danger',
      };
      return;
    }
    // 1.5s × (1 frame per 20ms) ≈ 75 frames if the graph is healthy.
    await delay(1_500);
    await capture.stop().catch(() => {});
    if (frameCount === 0) {
      stores.$diagnosticsResult.value = {
        message: 'Mic check: microphone opened but produced no audio frames.',
        tone: 'danger',
      };
      return;
    }
    stores.$diagnosticsResult.value = {
      message: `Mic check OK — captured ${frameCount} frames in 1.5 s.`,
      tone: 'success',
    };
  },

  // Report the live state of every browser permission this app needs,
  // and re-request the ones it can ask for from a gesture. The mic is
  // not re-requested here — browsers tie that to the call-accept tap
  // by design — but we surface its current state so the user knows
  // whether the next call will trigger a fresh prompt.
  'family-phone:permissions-check': async ({ stores }) => {
    const lines: string[] = [];
    if (typeof Notification === 'undefined') {
      lines.push('Notifications: unsupported in this browser');
    } else {
      if (Notification.permission === 'default') {
        try {
          const next = await Notification.requestPermission();
          lines.push(`Notifications: ${next}`);
        } catch {
          lines.push('Notifications: request failed');
        }
      } else {
        lines.push(`Notifications: ${Notification.permission}`);
      }
    }
    // The Permissions API microphone state is not exposed via the
    // typed PermissionName union, so this check leaves it to the Mic
    // check button — that one actually opens the device, which is a
    // stronger signal than a permission state string anyway.
    lines.push('Microphone: use the Mic check button to test');
    const speech = speechSynthesis !== null ? 'available' : 'unavailable';
    lines.push(`Speech synthesis: ${speech}`);
    const tone = lines.some((l) => l.includes('denied') || l.includes('unavailable'))
      ? 'danger'
      : 'info';
    stores.$diagnosticsResult.value = { message: lines.join(' · '), tone };
  },
};
