import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AppStores } from '../../stores.ts';
import type { EalClient, FamilyPhoneCallEvent, FamilyPhoneDeviceKind } from '@eal/client';
import {
  $activeCall,
  $callNote,
  $deviceConnection,
  $incomingCall,
  type PairedThisSession,
} from './stores.ts';
import { clearPairedDevice, loadPairedDevice, savePairedDevice } from './keystore.ts';
import { startAudioCapture, startAudioPlayback, type AudioCapture, type AudioPlayback } from './audio.ts';

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
  conn: NonNullable<ReturnType<() => typeof $deviceConnection.value>>,
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

function isKind(value: unknown): value is FamilyPhoneDeviceKind {
  return value === 'handset' || value === 'pwa' || value === 'agent';
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Wire the device's call signalling events into the local stores. Called
 * once per device-connection lifetime; the returned unsubscribe is held by
 * the connection itself and fires on close. Side-effect: starts and stops
 * the audio capture/playback pipeline as the call enters and leaves
 * `connected`.
 */
function installCallEventHandlers(event: FamilyPhoneCallEvent): void {
  switch (event.type) {
    case 'call:invite-ack': {
      // Caller's pending call now has its real call_id. The placeholder
      // entry was set the moment the user clicked Call.
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
      void stopAudio();
      return;
    }
    case 'call:cancelled': {
      $incomingCall.value = null;
      $callNote.value = 'Caller cancelled the call.';
      void stopAudio();
      return;
    }
    case 'call:hung-up': {
      $activeCall.value = null;
      $incomingCall.value = null;
      $callNote.value =
        event.reason === 'peer-disconnect' ? 'The other device disconnected.' : 'Call ended.';
      void stopAudio();
      return;
    }
  }
}

async function openDeviceConnection(
  client: EalClient,
  paired: PairedThisSession,
): Promise<void> {
  const existing = $deviceConnection.value;
  if (existing && existing.deviceId === paired.deviceId) return;
  existing?.close();
  const conn = await client.connectFamilyPhoneDevice({
    deviceId: paired.deviceId,
    privateKey: paired.privateKey,
  });
  conn.subscribe(installCallEventHandlers);
  $deviceConnection.value = conn;
}

/**
 * Rehydrate a previously-paired device from IndexedDB and open its WS
 * connection. Called from the central session seeder in main.tsx whenever
 * auth completes; on first load with no paired device this returns
 * silently. Errors clear the stale row rather than getting stuck.
 */
export async function bootstrapFamilyPhonePairedDevice(
  stores: AppStores,
): Promise<void> {
  let persisted;
  try {
    persisted = await loadPairedDevice();
  } catch (err) {
    stores.$familyPhoneError.value = describeError(err);
    return;
  }
  if (!persisted) return;
  const paired: PairedThisSession = {
    deviceId: persisted.deviceId,
    privateKey: persisted.privateKey,
    publicKeyB64: persisted.publicKeyB64,
  };
  stores.$pairedThisSession.value = paired;
  try {
    await openDeviceConnection(stores.client, paired);
  } catch (err) {
    // Stale persisted device — the server no longer knows it (server
    // wipe, key revocation). Clear the row so the user can pair fresh.
    stores.$familyPhoneError.value =
      `Saved device could not reconnect (${describeError(err)}). Pair again.`;
    stores.$pairedThisSession.value = null;
    try { await clearPairedDevice(); } catch { /* ignore */ }
  }
}

export const FAMILY_PHONE_ACTIONS: ActionRegistry<AppStores> = {
  'family-phone:set-complete-code': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$pairCompleteCode.value = value;
  },

  'family-phone:set-complete-label': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$pairCompleteLabel.value = value;
  },

  'family-phone:set-complete-kind': ({ data, stores }) => {
    const value = data['value'];
    if (!isKind(value)) return;
    stores.$pairCompleteKind.value = value;
  },

  'family-phone:start-pair': async ({ event, stores }) => {
    event.preventDefault();
    stores.$familyPhoneError.value = null;
    try {
      const result = await stores.client.startFamilyPhonePair();
      stores.$pairStartCode.value = result.userCode;
    } catch (err) {
      stores.$familyPhoneError.value = describeError(err);
    }
  },

  'family-phone:complete-pair': async ({ event, stores }) => {
    event.preventDefault();
    // Re-entrancy guard. A paste that contains a trailing newline fires the
    // form's implicit submit; without this, clicking the button afterwards
    // submits a second (empty) time and surfaces a misleading error.
    if (stores.$pairedThisSession.value !== null) {
      stores.$familyPhoneError.value = null;
      stores.$pairCompleteCode.value = '';
      return;
    }
    const code = stores.$pairCompleteCode.value.trim();
    const label = stores.$pairCompleteLabel.value.trim();
    if (code.length === 0) {
      stores.$familyPhoneError.value = 'Enter the invite code first.';
      return;
    }
    if (label.length === 0) {
      stores.$familyPhoneError.value = 'Give this device a name.';
      return;
    }
    stores.$familyPhoneError.value = null;
    try {
      // `extractable: false` on the private key prevents JavaScript from
      // ever reading the raw bytes — and IndexedDB can still structured-
      // clone the CryptoKey object across reloads.
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      );
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
      const publicKeyB64 = toBase64Url(spki);
      const result = await stores.client.completeFamilyPhonePair({
        userCode: code,
        publicKey: publicKeyB64,
        alg: 'ES256',
        label,
        kind: stores.$pairCompleteKind.value,
      });
      const paired: PairedThisSession = {
        deviceId: result.deviceId,
        privateKey: kp.privateKey,
        publicKeyB64,
      };
      stores.$pairedThisSession.value = paired;
      stores.$pairCompleteCode.value = '';
      stores.$pairCompleteLabel.value = '';
      stores.$familyPhoneDevices.value = await stores.client.listFamilyPhoneDevices();
      // Persist before opening the WS so a crash mid-handshake still
      // leaves the pairing usable on next load.
      try {
        await savePairedDevice({
          deviceId: paired.deviceId,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          publicKeyB64,
        });
      } catch (err) {
        stores.$familyPhoneError.value =
          `Paired, but persistence failed (${describeError(err)}). Will not survive reload.`;
      }
      // Immediately open the device WS so the new device can place and
      // receive calls without an extra explicit step.
      await openDeviceConnection(stores.client, paired);
    } catch (err) {
      stores.$familyPhoneError.value = describeError(err);
    }
  },

  'family-phone:refresh-devices': async ({ stores }) => {
    stores.$familyPhoneError.value = null;
    try {
      stores.$familyPhoneDevices.value = await stores.client.listFamilyPhoneDevices();
    } catch (err) {
      stores.$familyPhoneError.value = describeError(err);
    }
  },

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
      stores.$callNote.value = 'Pair a device on this tab first to place a call.';
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

  'family-phone:delete-device': async ({ data, stores }) => {
    const raw = data['deviceId'];
    if (typeof raw !== 'string') return;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    stores.$familyPhoneError.value = null;
    try {
      await stores.client.deleteFamilyPhoneDevice(id);
    } catch (err) {
      stores.$familyPhoneError.value = describeError(err);
      return;
    }
    // If we just deleted the device this tab was paired as, the local key
    // is now useless. Tear it down so the UI returns to the pair card and
    // IndexedDB doesn't try to reconnect with a dead device on next load.
    const paired = stores.$pairedThisSession.value;
    if (paired && paired.deviceId === id) {
      await stopAudio();
      stores.$deviceConnection.value?.close();
      stores.$deviceConnection.value = null;
      stores.$pairedThisSession.value = null;
      stores.$activeCall.value = null;
      stores.$incomingCall.value = null;
      try { await clearPairedDevice(); } catch { /* best-effort */ }
    }
    try {
      stores.$familyPhoneDevices.value = await stores.client.listFamilyPhoneDevices();
    } catch { /* keep stale list */ }
    stores.$callNote.value = 'Device deleted.';
  },

  'family-phone:unpair': async ({ stores }) => {
    // Close any active call and the WS first, then clear in-memory state,
    // then the persisted row. Order matters — IndexedDB errors must not
    // leave a stale connection running.
    if (stores.$activeCall.value !== null) {
      const conn = stores.$deviceConnection.value;
      if (conn && stores.$activeCall.value.callId !== '') {
        conn.hangup(stores.$activeCall.value.callId);
      }
    }
    await stopAudio();
    stores.$deviceConnection.value?.close();
    stores.$deviceConnection.value = null;
    stores.$pairedThisSession.value = null;
    stores.$activeCall.value = null;
    stores.$incomingCall.value = null;
    stores.$callNote.value = 'Device un-paired on this tab.';
    try {
      await clearPairedDevice();
    } catch {
      /* best-effort */
    }
    // Refresh the directory so the device that *was* this tab still shows
    // up (it's still server-side; un-pairing here is local only).
    try {
      stores.$familyPhoneDevices.value = await stores.client.listFamilyPhoneDevices();
    } catch {
      /* keep stale list */
    }
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
    // confirmation that never arrives. The peer's call:hung-up handler does
    // the symmetric clear on their side.
    stores.$activeCall.value = null;
    stores.$callNote.value = 'Call ended.';
    void stopAudio();
  },
};
