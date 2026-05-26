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

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
 * the connection itself and fires on close.
 */
function installCallEventHandlers(
  event: FamilyPhoneCallEvent,
): void {
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
      // Caller-side: the callee picked up. Transition pending → connected.
      const current = $activeCall.value;
      if (current && current.role === 'caller' && current.callId === event.callId) {
        $activeCall.value = { ...current, state: 'connected' };
      }
      return;
    }
    case 'call:accept-ack': {
      // Callee-side acknowledgement that the server registered the accept.
      const current = $activeCall.value;
      if (current && current.role === 'callee' && current.callId === event.callId) {
        $activeCall.value = { ...current, state: 'connected' };
      }
      return;
    }
    case 'call:rejected': {
      $activeCall.value = null;
      $callNote.value = 'Call was rejected.';
      return;
    }
    case 'call:cancelled': {
      $incomingCall.value = null;
      $callNote.value = 'Caller cancelled the call.';
      return;
    }
    case 'call:hung-up': {
      $activeCall.value = null;
      $incomingCall.value = null;
      $callNote.value =
        event.reason === 'peer-disconnect' ? 'The other device disconnected.' : 'Call ended.';
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
  'family-phone:set-pair-label': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$pairStartLabel.value = value;
  },

  'family-phone:set-pair-kind': ({ data, stores }) => {
    const value = data['value'];
    if (!isKind(value)) return;
    stores.$pairStartKind.value = value;
  },

  'family-phone:set-complete-code': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$pairCompleteCode.value = value;
  },

  'family-phone:start-pair': async ({ event, stores }) => {
    event.preventDefault();
    const label = stores.$pairStartLabel.value.trim();
    if (label.length === 0) {
      stores.$familyPhoneError.value = 'Give the new device a label.';
      return;
    }
    stores.$familyPhoneError.value = null;
    try {
      const result = await stores.client.startFamilyPhonePair({
        label,
        kind: stores.$pairStartKind.value,
      });
      stores.$pairStartCode.value = result.userCode;
    } catch (err) {
      stores.$familyPhoneError.value = describeError(err);
    }
  },

  'family-phone:complete-pair': async ({ event, stores }) => {
    event.preventDefault();
    const code = stores.$pairCompleteCode.value.trim();
    if (code.length === 0) {
      stores.$familyPhoneError.value = 'Enter the spoken code first.';
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
      });
      const paired: PairedThisSession = {
        deviceId: result.deviceId,
        privateKey: kp.privateKey,
        publicKeyB64,
      };
      stores.$pairedThisSession.value = paired;
      stores.$pairCompleteCode.value = '';
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
    stores.$activeCall.value = { ...active, state: 'closing' };
  },
};
