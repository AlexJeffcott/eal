/**
 * Phase 7B.4c — Twilio Media Stream ↔ family-phone call router bridge.
 *
 * One bridge instance backs one Twilio media-WS connection (one inbound
 * PSTN call). The bridge:
 *
 *   1. Materialises a virtual device on the router for the PSTN side.
 *   2. Fans the inbound invite out to every currently-online handset.
 *      First handset to accept wins; the others get `call:cancelled`.
 *   3. Pumps audio in both directions through the codec module:
 *        Twilio  →  pcmuFrameToRelayPcm  →  router (binary frame)
 *        router  →  relayPcmToPcmuFrame  →  Twilio (`media` event)
 *   4. Tears down cleanly on Twilio `stop`, on remote-handset hangup,
 *      and when every fanned-out invite is rejected / unanswered.
 *
 * Pure module: no DB, no socket, no Elysia. The WS handler (a later
 * sub-phase) owns the upstream socket and the device-row materialisation
 * and wires this bridge in via the deps below.
 */
import { pcmuFrameToRelayPcm, relayPcmToPcmuFrame } from './codec.ts';
import type { TwilioEvent } from './protocol.ts';
import type { CallRouter, VirtualDeviceSinks } from '../handlers/family-phone-call-router.ts';

/**
 * Binary tag the family-phone WS uses for audio frames. Duplicated here so
 * the bridge does not need an import from the apps layer; both call sites
 * must stay in sync if the tag ever changes (the apps registry value at
 * `familyPhoneApp.ws.binaryTag` is the source of truth).
 */
const FAMILY_PHONE_BINARY_TAG = 0x10;

/**
 * Frame layout the router speaks, lifted from `family-phone-call-router.ts`:
 *   byte  0      — tag
 *   bytes 1..16  — UTF-8 call_id (16 hex chars, exactly 16 bytes)
 *   bytes 17..   — audio payload (Int16 LE PCM at 24 kHz, mono)
 */
const CALL_ID_BYTES = 16;
const FRAME_HEADER = 1 + CALL_ID_BYTES;

export interface TwilioBridgeDeps {
  router: CallRouter;
  /**
   * Device id of the PSTN family-phone-device row that represents this
   * inbound call. The WS handler materialises the row (kind='pstn',
   * label=E.164) before constructing the bridge.
   */
  pstnDeviceId: number;
  /**
   * Handset device ids the inbound invite should fan out to. The WS
   * handler queries the call matrix once at `start` and passes the
   * resolved targets in; the bridge does not re-evaluate it.
   */
  handsetDeviceIds: number[];
  /**
   * Write a JSON-stringified Twilio media-stream frame back upstream.
   * The bridge only ever sends `media` events.
   */
  sendUpstream(payload: string): void;
  /**
   * Fired when the bridge has nothing left to do: every fanned-out
   * invite was rejected/unanswered, or the active call hung up, or
   * Twilio sent a `stop`. The WS handler closes the upstream socket
   * in response. Idempotent on the caller's side — the bridge fires
   * at most once.
   */
  onTerminate(): void;
}

export interface TwilioBridge {
  /** Drive on every parsed Twilio Media Stream event. */
  handleEvent(event: TwilioEvent): void;
  /**
   * Called by the WS handler when the upstream connection closes for
   * any reason (Twilio dropped, server shutdown, fatal parse error).
   * Tears down the virtual device — the router fires `call:hung-up`
   * with reason `peer-disconnect` to the live handset. Idempotent.
   */
  close(): void;
}

export function createTwilioBridge(deps: TwilioBridgeDeps): TwilioBridge {
  const { router, pstnDeviceId, handsetDeviceIds, sendUpstream, onTerminate } = deps;

  let streamSid: string | null = null;
  let virtualWsId: string | null = null;
  /**
   * Calls fanned out by the bridge that have not yet resolved. Keyed by
   * the call_id the router returned from `placeCallFromVirtual`. As
   * each handset accepts/rejects/times out, its entry leaves this map.
   */
  const pendingCallIds = new Set<string>();
  let activeCallId: string | null = null;
  let terminated = false;

  function fireTerminate(): void {
    if (terminated) return;
    terminated = true;
    if (virtualWsId !== null) {
      router.unregisterDevice(virtualWsId);
      virtualWsId = null;
    }
    pendingCallIds.clear();
    activeCallId = null;
    onTerminate();
  }

  const sinks: VirtualDeviceSinks = {
    onEvent(payload) {
      if (terminated) return;
      const type = payload['type'];
      if (typeof type !== 'string') return;
      const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : null;

      switch (type) {
        case 'call:accepted': {
          if (callId === null) return;
          if (activeCallId !== null) return;
          if (!pendingCallIds.has(callId)) return;
          activeCallId = callId;
          pendingCallIds.delete(callId);
          // Cancel the losing invites. The virtual side is the caller
          // on every fan-out call, so `call:cancel` is the right verb.
          for (const losingId of pendingCallIds) {
            if (virtualWsId !== null) {
              router.submitEvent(virtualWsId, { type: 'call:cancel', call_id: losingId });
            }
          }
          pendingCallIds.clear();
          return;
        }
        case 'call:rejected':
        case 'call:cancelled':
        case 'call:unanswered': {
          if (callId !== null) pendingCallIds.delete(callId);
          if (activeCallId === null && pendingCallIds.size === 0) fireTerminate();
          return;
        }
        case 'call:hung-up': {
          if (callId !== null && callId === activeCallId) fireTerminate();
          return;
        }
        default:
          return;
      }
    },
    onAudioFrame(frame) {
      if (terminated || activeCallId === null || streamSid === null) return;
      if (frame.length < FRAME_HEADER) return;
      const callId = decodeCallId(frame);
      if (callId !== activeCallId) return;
      const pcm = readPcmPayload(frame);
      const pcmu = relayPcmToPcmuFrame(pcm);
      const base64 = base64Encode(pcmu);
      sendUpstream(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: base64 },
        }),
      );
    },
  };

  function handleStart(event: Extract<TwilioEvent, { type: 'start' }>): void {
    if (streamSid !== null) return;
    streamSid = event.streamSid;
    virtualWsId = router.registerVirtualDevice(pstnDeviceId, sinks);
    if (handsetDeviceIds.length === 0) {
      fireTerminate();
      return;
    }
    for (const targetId of handsetDeviceIds) {
      const result = router.placeCallFromVirtual(pstnDeviceId, targetId);
      if (result.ok) pendingCallIds.add(result.callId);
    }
    if (pendingCallIds.size === 0) fireTerminate();
  }

  function handleMedia(event: Extract<TwilioEvent, { type: 'media' }>): void {
    if (activeCallId === null || virtualWsId === null) return;
    const pcmu = base64Decode(event.payload);
    if (pcmu === null) return;
    const pcm = pcmuFrameToRelayPcm(pcmu);
    const frame = buildAudioFrame(activeCallId, pcm);
    router.submitBinary(virtualWsId, frame);
  }

  return {
    handleEvent(event) {
      if (terminated) return;
      switch (event.type) {
        case 'connected':
          return;
        case 'start':
          handleStart(event);
          return;
        case 'media':
          handleMedia(event);
          return;
        case 'mark':
          return;
        case 'stop':
          fireTerminate();
          return;
      }
    },
    close() {
      fireTerminate();
    },
  };
}

function decodeCallId(frame: Uint8Array): string {
  const slice = frame.slice(1, FRAME_HEADER);
  return new TextDecoder().decode(slice).replace(/\0+$/, '');
}

function readPcmPayload(frame: Uint8Array): Int16Array {
  const audio = frame.subarray(FRAME_HEADER);
  // Copy into a properly-aligned buffer; the WS layer may hand us a slice
  // whose byteOffset is not 2-byte aligned, which would make `new Int16Array`
  // on the underlying buffer throw on some runtimes.
  const aligned = new Uint8Array(audio.length);
  aligned.set(audio);
  const view = new DataView(aligned.buffer);
  const samples = new Int16Array(Math.floor(aligned.length / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

function buildAudioFrame(callId: string, pcm: Int16Array): Uint8Array {
  const audioBytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(audioBytes.buffer);
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(i * 2, pcm[i] ?? 0, true);
  }
  const frame = new Uint8Array(FRAME_HEADER + audioBytes.length);
  frame[0] = FAMILY_PHONE_BINARY_TAG;
  const callIdBytes = new TextEncoder().encode(callId);
  // call_ids are 16 hex chars; defensive clamp covers a future format change.
  frame.set(callIdBytes.subarray(0, CALL_ID_BYTES), 1);
  frame.set(audioBytes, FRAME_HEADER);
  return frame;
}

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64Decode(s: string): Uint8Array | null {
  try {
    const buf = Buffer.from(s, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
}
