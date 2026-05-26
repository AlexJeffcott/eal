import { $state } from '@fairfox/polly/state';

/** Reactive state owned by the family-phone app: call lifecycle only.
 *  Device identity, pair flow, and the WS connection itself live in the
 *  devices app (../devices/stores.ts) — family-phone is a call surface
 *  consuming the devices it finds in the household directory. */

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
  $incomingCall: typeof $incomingCall;
  $activeCall: typeof $activeCall;
  $callNote: typeof $callNote;
}

export function createFamilyPhoneStores(): FamilyPhoneStores {
  return { $incomingCall, $activeCall, $callNote };
}

export function resetFamilyPhoneStores(): void {
  $incomingCall.value = null;
  $activeCall.value = null;
  $callNote.value = null;
}
