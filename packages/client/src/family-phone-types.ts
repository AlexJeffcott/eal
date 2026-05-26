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

/**
 * Events the family-phone WS handler emits at the device-authed connection.
 * Mirrors the wire messages from family-phone.ws.ts on the server.
 */
export type FamilyPhoneCallEvent =
  | { type: 'call:invite-ack'; callId: string }
  | { type: 'call:invite-failed'; reason: string }
  | { type: 'call:incoming'; callId: string; fromDeviceId: number }
  | { type: 'call:accepted'; callId: string }
  | { type: 'call:accept-ack'; callId: string }
  | { type: 'call:rejected'; callId: string }
  | { type: 'call:cancelled'; callId: string }
  | { type: 'call:hung-up'; callId: string; reason?: string };

/**
 * A live device-authenticated WebSocket. Returned by
 * `EalClient.connectFamilyPhoneDevice`; the caller subscribes to events,
 * places calls, accepts/rejects/hangups, and closes when the device leaves
 * the network.
 */
export interface FamilyPhoneDeviceConnection {
  /** The device id this connection authenticated as. */
  deviceId: number;
  /** Place a call to another paired device. */
  placeCall(targetDeviceId: number): void;
  acceptCall(callId: string): void;
  rejectCall(callId: string): void;
  cancelCall(callId: string): void;
  hangup(callId: string): void;
  /** Register an event handler; returns an unsubscribe. */
  subscribe(handler: (event: FamilyPhoneCallEvent) => void): () => void;
  /** Tear down the connection. */
  close(): void;
}
