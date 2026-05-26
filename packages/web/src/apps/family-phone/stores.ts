import { $state } from '@fairfox/polly/state';
import type {
  FamilyPhoneDevice,
  FamilyPhoneDeviceConnection,
  FamilyPhoneDeviceKind,
} from '@eal/client';

/** Reactive state owned by the family-phone app. */

/** The signed-in user's devices, mirrored from /api/family-phone/devices. */
export const $familyPhoneDevices = $state<FamilyPhoneDevice[]>([]);
/** Surfaced to the user when an action handler caught an error. */
export const $familyPhoneError = $state<string | null>(null);

/** Form state for the trusted-device side of pairing (mints the user_code). */
export const $pairStartLabel = $state<string>('');
export const $pairStartKind = $state<FamilyPhoneDeviceKind>('pwa');
/** The minted code, shown for the trusted-device user to read aloud. */
export const $pairStartCode = $state<string | null>(null);

/** Form state for the new-device side of pairing (submits the code + key). */
export const $pairCompleteCode = $state<string>('');
/**
 * The result of completing pair on this device: the issued device_id plus the
 * generated keypair. Phase G keeps this in memory only — the private key is
 * lost on reload. Persistence (IndexedDB) lands when subsequent phases need
 * the device to remain authenticated across page loads.
 */
export interface PairedThisSession {
  deviceId: number;
  privateKey: CryptoKey;
  publicKeyB64: string;
}
export const $pairedThisSession = $state<PairedThisSession | null>(null);

/**
 * The live device WebSocket, opened after a successful pair-complete in
 * this tab. Null when no device is paired here or the connection has not
 * yet finished its challenge/sign handshake.
 */
export const $deviceConnection = $state<FamilyPhoneDeviceConnection | null>(null);

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

export interface FamilyPhoneStores {
  $familyPhoneDevices: typeof $familyPhoneDevices;
  $familyPhoneError: typeof $familyPhoneError;
  $pairStartLabel: typeof $pairStartLabel;
  $pairStartKind: typeof $pairStartKind;
  $pairStartCode: typeof $pairStartCode;
  $pairCompleteCode: typeof $pairCompleteCode;
  $pairedThisSession: typeof $pairedThisSession;
  $deviceConnection: typeof $deviceConnection;
  $incomingCall: typeof $incomingCall;
  $activeCall: typeof $activeCall;
  $callNote: typeof $callNote;
}

export function createFamilyPhoneStores(): FamilyPhoneStores {
  return {
    $familyPhoneDevices,
    $familyPhoneError,
    $pairStartLabel,
    $pairStartKind,
    $pairStartCode,
    $pairCompleteCode,
    $pairedThisSession,
    $deviceConnection,
    $incomingCall,
    $activeCall,
    $callNote,
  };
}

export function resetFamilyPhoneStores(): void {
  $familyPhoneDevices.value = [];
  $familyPhoneError.value = null;
  $pairStartLabel.value = '';
  $pairStartKind.value = 'pwa';
  $pairStartCode.value = null;
  $pairCompleteCode.value = '';
  $pairedThisSession.value = null;
  $deviceConnection.value?.close();
  $deviceConnection.value = null;
  $incomingCall.value = null;
  $activeCall.value = null;
  $callNote.value = null;
}
