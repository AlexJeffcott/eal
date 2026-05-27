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
  /** The user who owns this device — for "Leo's handset (Leo)" rendering. */
  ownerUserId: number;
  ownerDisplayName: string;
  /** True if the device currently holds an open device-authed WS to the server. */
  online: boolean;
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
  /** The joining device's self-chosen label, e.g. "Alex's phone". */
  label: string;
  /** The joining device's self-declared kind. */
  kind: FamilyPhoneDeviceKind;
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
  | { type: 'call:hung-up'; callId: string; reason?: string }
  | { type: 'call:unanswered'; callId: string }
  | { type: 'presence:changed'; deviceId: number; online: boolean }
  | { type: 'directory:changed' }
  | { type: 'push:subscribed' }
  | { type: 'push:subscribe-failed'; reason: string }
  | { type: 'push:unsubscribed' };

/**
 * Agent proactivity rule — one row per scheduled or repeating action the
 * `eal agent` worker should perform. `kind === 'place_call'` rings a
 * target device; `kind === 'voice_message'` stores a voicemail. The
 * worker reads rules on every scheduler tick and posts the resulting
 * action to /api/agent/actions/*.
 */
export type AgentRuleKind = 'place_call' | 'voice_message';

export interface AgentRule {
  id: number;
  name: string;
  enabled: boolean;
  targetDeviceId: number;
  kind: AgentRuleKind;
  body: string | null;
  systemPrompt: string | null;
  nextFireAt: string;
  intervalSec: number | null;
  cooldownSec: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAgentRuleInput {
  /** Set to update an existing rule; omit to insert. */
  id?: number;
  name: string;
  enabled: boolean;
  targetDeviceId: number;
  kind: AgentRuleKind;
  /** Either `body` or `systemPrompt` must be set (server enforces this). */
  body?: string | null;
  systemPrompt?: string | null;
  nextFireAt: string;
  intervalSec?: number | null;
  cooldownSec?: number;
}

export type AgentActionTrigger = 'scheduled' | 'tool';
export type AgentActionResult =
  | 'pending'
  | 'answered'
  | 'unanswered'
  | 'rejected'
  | 'failed'
  | 'sent';

export interface AgentAction {
  id: number;
  ruleId: number | null;
  kind: AgentRuleKind;
  targetDeviceId: number;
  trigger: AgentActionTrigger;
  result: AgentActionResult;
  callId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/**
 * Voice message metadata as the wire returns it. The audio bytes are
 * fetched separately via `getVoiceMessageAudio` to keep list payloads
 * cheap.
 */
export interface VoiceMessage {
  id: number;
  toDeviceId: number;
  fromDeviceId: number | null;
  fromExternal: string | null;
  body: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  readAt: string | null;
  createdAt: string;
}

export interface PostVoiceMessageInput {
  toDeviceId: number;
  fromDeviceId?: number | null;
  fromExternal?: string | null;
  body: string;
  /** Raw 16-bit signed little-endian PCM bytes. */
  audio: Uint8Array;
  sampleRate?: number;
  channels?: number;
}

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
  /**
   * Send an audio frame for an active call. The client wraps the payload in
   * the on-wire framing (1-byte tag + 16-byte ASCII call id + payload) so
   * callers can stay codec-agnostic.
   */
  sendAudio(callId: string, payload: Uint8Array): void;
  /**
   * Subscribe to audio frames arriving for any active call; returns an
   * unsubscribe. The handler receives the call id and the codec payload —
   * the wire framing is parsed out by the connection.
   */
  subscribeAudio(handler: (callId: string, payload: Uint8Array) => void): () => void;
  /** Register this device's Web Push subscription with the server so an
   * offline call:invite can wake the phone. Server upserts by endpoint;
   * calling again with the same endpoint refreshes the keys in place. */
  subscribePush(input: { endpoint: string; p256dh: string; auth: string }): void;
  /** Drop a Web Push subscription registration by its endpoint. */
  unsubscribePush(endpoint: string): void;
  /** Tear down the connection. */
  close(): void;
}
