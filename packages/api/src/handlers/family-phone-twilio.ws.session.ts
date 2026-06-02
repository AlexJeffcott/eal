import { createTwilioBridge, type TwilioBridge } from '../twilio/bridge.ts';
import { parseTwilioEvent } from '../twilio/protocol.ts';
import type { CallRouter } from './family-phone-call-router.ts';
import type { FamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import type { PstnContactsRepo } from '../db/repos/family-phone-pstn-contacts.ts';

/**
 * Phase 7B.4d — per-connection state machine for the Twilio Media Stream
 * WS, lifted out of the Elysia route so it is directly testable with a
 * captured fake `TwilioMediaWs`. The route (`family-phone-twilio.ws.ts`)
 * is a thin shim that adapts Elysia's callbacks onto this.
 */

export interface TwilioMediaWsContext {
  /**
   * Shared call router. Real handsets register against the same router
   * via the family-phone WS handler; the bridge participates as a
   * virtual device and reaches them by id.
   */
  router: CallRouter;
  /**
   * Devices repo, used once per connection at the Twilio `start` event
   * to materialise (or fetch) the PSTN counterparty's device row.
   */
  devices: FamilyPhoneDevicesRepo;
  /**
   * Live set of currently-online household device ids (handsets, PWAs,
   * agents). The bridge fans out one `placeCallFromVirtual` per id at
   * the `start` event; first acceptance wins.
   */
  onlineDevices: Set<number>;
  /**
   * Phase 7D — PSTN phonebook. On inbound start, the session looks up
   * the caller's E.164 and, if the contact carries an intended
   * recipient, rings only that user's online devices instead of the
   * household fan-out. Unknown callers (and known contacts without an
   * intended recipient) continue to fan out for now; commit C will
   * replace the fan-out fallback with the DTMF IVR.
   */
  pstnContacts: PstnContactsRepo;
}

/**
 * Minimal surface the media-WS session needs from the underlying
 * connection. Elysia hands the route a fresh wrapper object on every
 * callback, so identity travels through `id`; `send` writes a JSON
 * frame upstream and `close` tears the connection down.
 */
export interface TwilioMediaWs {
  readonly id: string;
  send(payload: string): void;
  close(): void;
}

export interface TwilioMediaSession {
  message(ws: TwilioMediaWs, raw: string): void;
  close(ws: TwilioMediaWs): void;
}

interface BridgeSlot {
  bridge: TwilioBridge;
}

/**
 * Inbound routing for the bridge's per-call fan-out target list.
 *   - Known caller with an intended recipient → just that user's online
 *     devices. An empty result terminates the bridge upstream so Twilio
 *     drops the call (the IVR fallback in commit C will replace that
 *     with a voicemail prompt).
 *   - Anyone else → household fan-out, preserving today's behaviour.
 *     Commit C swaps this fallback for the DTMF IVR.
 */
function resolveInboundHandsets(ctx: TwilioMediaWsContext, fromE164: string): number[] {
  const contact = ctx.pstnContacts.findByE164(fromE164);
  if (contact && contact.intended_user_id !== null) {
    const owned = ctx.devices.listByUser(contact.intended_user_id);
    return owned.filter((d) => ctx.onlineDevices.has(d.id)).map((d) => d.id);
  }
  return [...ctx.onlineDevices];
}

export function createTwilioMediaSession(ctx: TwilioMediaWsContext): TwilioMediaSession {
  // Per-connection bridge instances. A bridge slot is created lazily
  // when the Twilio `start` event lands — that is the first frame
  // where we know the remote E.164 needed for the PSTN device upsert.
  const slots = new Map<string, BridgeSlot>();

  return {
    message(ws, raw) {
      const event = parseTwilioEvent(raw);
      if (event === null) return;

      const existing = slots.get(ws.id);
      if (existing !== undefined) {
        existing.bridge.handleEvent(event);
        return;
      }

      // Twilio sends `connected` before `start`; the bridge has nothing
      // to do until `start` so anything earlier is dropped.
      if (event.type !== 'start') return;

      const pstn = ctx.devices.upsertPstnByE164(event.from);
      // Outbound: the TwiML carried direction=outbound + the device id
      // of the handset that placed the call. Bind to that handset only
      // — fan-out would ring uninvolved household devices. Skip if the
      // handset has gone offline; the bridge terminates on an empty
      // target list, which closes the upstream WS and Twilio drops
      // the call.
      let handsetIds: number[];
      if (event.direction === 'outbound' && event.targetHandsetId !== null) {
        handsetIds = ctx.onlineDevices.has(event.targetHandsetId)
          ? [event.targetHandsetId]
          : [];
      } else {
        handsetIds = resolveInboundHandsets(ctx, event.from);
      }
      const bridge = createTwilioBridge({
        router: ctx.router,
        pstnDeviceId: pstn.id,
        handsetDeviceIds: handsetIds,
        sendUpstream: (payload) => {
          ws.send(payload);
        },
        onTerminate: () => {
          ws.close();
        },
      });
      slots.set(ws.id, { bridge });
      bridge.handleEvent(event);
    },
    close(ws) {
      const slot = slots.get(ws.id);
      if (slot === undefined) return;
      slot.bridge.close();
      slots.delete(ws.id);
    },
  };
}
