/**
 * Family-phone wire types — the shape the API returns, in idiomatic
 * client-side casing where the wire uses snake_case.
 */

export type FamilyPhoneDeviceKind = 'handset' | 'pwa' | 'agent';

export interface FamilyPhoneDevice {
  id: number;
  label: string;
  kind: FamilyPhoneDeviceKind;
  createdAt: string;
  pairedAt: string | null;
}

export interface FamilyPhonePairStartInput {
  label: string;
  kind: FamilyPhoneDeviceKind;
}

export interface FamilyPhonePairStartResult {
  userCode: string;
  expiresAt: string;
}

export interface FamilyPhonePairCompleteInput {
  userCode: string;
  /** base64url-encoded SPKI public key bytes. */
  publicKey: string;
  /** ES256 today; future expansion when we support more curves. */
  alg: 'ES256';
}

export interface FamilyPhonePairCompleteResult {
  deviceId: number;
}
