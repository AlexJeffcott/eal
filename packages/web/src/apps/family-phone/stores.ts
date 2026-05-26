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

/** The minted code, displayed on the inviting browser for the joiner to type in. */
export const $pairStartCode = $state<string | null>(null);

/** Form state for the joining device: code + its own label + its own kind. */
export const $pairCompleteCode = $state<string>('');
export const $pairCompleteLabel = $state<string>('');
export const $pairCompleteKind = $state<FamilyPhoneDeviceKind>('pwa');
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
  $pairStartCode: typeof $pairStartCode;
  $pairCompleteCode: typeof $pairCompleteCode;
  $pairCompleteLabel: typeof $pairCompleteLabel;
  $pairCompleteKind: typeof $pairCompleteKind;
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
    $pairStartCode,
    $pairCompleteCode,
    $pairCompleteLabel,
    $pairCompleteKind,
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
  $pairStartCode.value = null;
  $pairCompleteCode.value = '';
  $pairCompleteLabel.value = '';
  $pairCompleteKind.value = 'pwa';
  $pairedThisSession.value = null;
  $deviceConnection.value?.close();
  $deviceConnection.value = null;
  $incomingCall.value = null;
  $activeCall.value = null;
  $callNote.value = null;
}
