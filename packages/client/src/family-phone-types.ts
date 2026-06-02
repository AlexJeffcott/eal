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
  | { type: 'call:text'; callId: string; text: string }
  /**
   * Server-side ack for `call:place-pstn` (Phase 7C). The CallSid is
   * Twilio's identifier for the just-queued outbound call; the eventual
   * `call:incoming` arrives later (when Twilio dials and the media
   * stream connects) and carries its own family-phone call id.
   */
  | { type: 'call:place-pstn-ack'; callSid: string }
  /**
   * Server-side rejection for `call:place-pstn`. The `reason` is one of:
   *   - `bad-shape`       — envelope was missing the `to` field
   *   - `bad-e164`        — `to` did not match the E.164 shape
   *   - `not-allowed`     — outbound to that number is denied by the
   *                          PSTN contacts allowlist (7D)
   *   - `twilio-rejected` — Twilio returned a 4xx (bad number, blocked)
   *   - `twilio-unreachable` — 5xx / transport / DNS / TLS
   *   - `outbound-disabled` — TWILIO_ENABLED=false on this deploy
   *
   * The UI maps these to distinct messages so the user knows whether
   * a retry could help.
   */
  | { type: 'call:place-pstn-failed'; reason: string }
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

/**
 * A row in the household's PSTN phonebook — an E.164 number with a
 * friendly label and per-direction allow flags. Phase 7's trunk bridge
 * reads `allowIn` on incoming calls and `allowOut` on dial-out attempts.
 */
export interface PstnContact {
  id: number;
  e164: string;
  label: string;
  allowIn: boolean;
  allowOut: boolean;
  /** Phase 7D — when set, inbound calls from this number ring only
   *  this user's online devices and any voicemail lands in their
   *  inbox. Null falls through to the DTMF IVR menu. */
  intendedUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePstnContactInput {
  e164: string;
  label: string;
  allowIn: boolean;
  allowOut: boolean;
  intendedUserId?: number | null;
}

export interface UpdatePstnContactInput {
  id: number;
  label: string;
  allowIn: boolean;
  allowOut: boolean;
  intendedUserId?: number | null;
}

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
  /**
   * Phase 7C — dial an outbound PSTN number through the Twilio trunk.
   * The server acks with `call:place-pstn-ack` (carrying Twilio's
   * CallSid) once Twilio queues the call, or rejects with
   * `call:place-pstn-failed`. The eventual `call:incoming` arrives
   * later through the same call event stream; the UI watches for an
   * incoming from any PSTN device while in "dialling" state and
   * auto-accepts.
   */
  placePstn(toE164: string): void;
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
   * Send a text frame on an active call — the spoken-reply equivalent of
   * `sendAudio` for peers that can synthesise locally (PWAs via the Web
   * Speech API). The server forwards verbatim through the same WS as
   * audio frames; the receiving client decides how to render it.
   */
  sendText(callId: string, text: string): void;
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
