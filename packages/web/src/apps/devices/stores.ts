import { $state } from '@fairfox/polly/state';
import type {
  FamilyPhoneDevice,
  FamilyPhoneDeviceConnection,
  FamilyPhoneDeviceKind,
} from '@eal/client';

/** Reactive state owned by the devices app. */

/** The household's full device directory, mirrored from /api/family-phone/devices. */
export const $devices = $state<FamilyPhoneDevice[]>([]);
/** Surfaced to the user when an action handler caught an error. */
export const $devicesError = $state<string | null>(null);

/** The minted invite code, displayed for the joiner to type in. */
export const $pairStartCode = $state<string | null>(null);
/** Seconds remaining before the displayed code expires; 0 when none in flight. */
export const $pairStartSecondsLeft = $state<number>(0);

/** Form state for the joining device: code + its own label + its own kind. */
export const $pairCompleteCode = $state<string>('');
export const $pairCompleteLabel = $state<string>('');
export const $pairCompleteKind = $state<FamilyPhoneDeviceKind>('pwa');

/**
 * The result of completing pair on this browser: the issued device_id plus
 * the generated keypair. Persisted across reloads via IndexedDB (keystore.ts).
 */
export interface PairedThisSession {
  deviceId: number;
  privateKey: CryptoKey;
  publicKeyB64: string;
}
export const $pairedThisSession = $state<PairedThisSession | null>(null);

/**
 * The live device WebSocket, opened after a successful pair-complete in
 * this tab (or rehydrated from IndexedDB on next load). Null when this
 * browser has no paired device or the connection has not yet finished its
 * challenge/sign handshake.
 */
export const $deviceConnection = $state<FamilyPhoneDeviceConnection | null>(null);

export interface DevicesStores {
  $devices: typeof $devices;
  $devicesError: typeof $devicesError;
  $pairStartCode: typeof $pairStartCode;
  $pairStartSecondsLeft: typeof $pairStartSecondsLeft;
  $pairCompleteCode: typeof $pairCompleteCode;
  $pairCompleteLabel: typeof $pairCompleteLabel;
  $pairCompleteKind: typeof $pairCompleteKind;
  $pairedThisSession: typeof $pairedThisSession;
  $deviceConnection: typeof $deviceConnection;
}

export function createDevicesStores(): DevicesStores {
  return {
    $devices,
    $devicesError,
    $pairStartCode,
    $pairStartSecondsLeft,
    $pairCompleteCode,
    $pairCompleteLabel,
    $pairCompleteKind,
    $pairedThisSession,
    $deviceConnection,
  };
}

export function resetDevicesStores(): void {
  $devices.value = [];
  $devicesError.value = null;
  $pairStartCode.value = null;
  $pairStartSecondsLeft.value = 0;
  $pairCompleteCode.value = '';
  $pairCompleteLabel.value = '';
  $pairCompleteKind.value = 'pwa';
  $pairedThisSession.value = null;
  $deviceConnection.value?.close();
  $deviceConnection.value = null;
}
