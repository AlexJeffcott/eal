import { $state } from '@fairfox/polly/state';
import type { FamilyPhoneDevice, FamilyPhoneDeviceKind } from '@eal/client';

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

export interface FamilyPhoneStores {
  $familyPhoneDevices: typeof $familyPhoneDevices;
  $familyPhoneError: typeof $familyPhoneError;
  $pairStartLabel: typeof $pairStartLabel;
  $pairStartKind: typeof $pairStartKind;
  $pairStartCode: typeof $pairStartCode;
  $pairCompleteCode: typeof $pairCompleteCode;
  $pairedThisSession: typeof $pairedThisSession;
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
}
