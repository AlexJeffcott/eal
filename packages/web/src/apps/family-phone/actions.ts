import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AppStores } from '../../stores.ts';
import type { FamilyPhoneDeviceKind } from '@eal/client';

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
 * Actions for the family-phone web app. The trusted-device side mints a
 * `user_code` to read aloud; the new-device side generates an ECDSA P-256
 * keypair, exports the public half as SPKI, and submits both. Phase G keeps
 * the keypair in memory only — persistence (IndexedDB) lands when later
 * phases need the device to remain authenticated across reloads.
 */
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
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
      const publicKeyB64 = toBase64Url(spki);
      const result = await stores.client.completeFamilyPhonePair({
        userCode: code,
        publicKey: publicKeyB64,
        alg: 'ES256',
      });
      stores.$pairedThisSession.value = {
        deviceId: result.deviceId,
        privateKey: kp.privateKey,
        publicKeyB64,
      };
      stores.$pairCompleteCode.value = '';
      // Refresh the directory so the new device appears immediately.
      stores.$familyPhoneDevices.value = await stores.client.listFamilyPhoneDevices();
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
};
