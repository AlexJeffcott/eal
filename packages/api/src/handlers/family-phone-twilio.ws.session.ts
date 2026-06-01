import { createTwilioBridge, type TwilioBridge } from '../twilio/bridge.ts';
import { parseTwilioEvent } from '../twilio/protocol.ts';
import type { CallRouter } from './family-phone-call-router.ts';
import type { FamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';

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
      const handsetIds = [...ctx.onlineDevices];
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
