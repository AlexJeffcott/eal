import { Elysia } from 'elysia';
import {
  createTwilioMediaSession,
  type TwilioMediaWsContext,
} from './family-phone-twilio.ws.session.ts';

/**
 * Phase 7B.4d — Twilio Media Stream WebSocket endpoint, mounted at
 * `/api/family-phone/twilio/media`. The path matches the `wss://…/media`
 * URL the voice-webhook TwiML response points Twilio at (7B.3). One
 * Twilio inbound call opens one WS connection here; the per-connection
 * state machine lives in `family-phone-twilio.ws.session.ts` so the
 * Elysia plumbing here is a thin shim that adapts ws.send/ws.close
 * onto the session surface.
 *
 * The endpoint is auth-less by design — Twilio cannot sign the WS open
 * (Media Streams have no `X-Twilio-Signature` for the upgrade) and the
 * URL is only minted inside a signed TwiML response. 7D layers a
 * per-source-number allowlist on top of that.
 */

export type { TwilioMediaWsContext };
export {
  createTwilioMediaSession,
  type TwilioMediaSession,
  type TwilioMediaWs,
} from './family-phone-twilio.ws.session.ts';

export function twilioMediaWsRoute(ctx: TwilioMediaWsContext) {
  const session = createTwilioMediaSession(ctx);
  return new Elysia({ prefix: '/api/family-phone/twilio' }).ws('/media', {
    message(ws, raw) {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      session.message(
        {
          id: ws.id,
          send: (payload) => {
            ws.send(payload);
          },
          close: () => {
            ws.close();
          },
        },
        text,
      );
    },
    close(ws) {
      session.close({ id: ws.id, send: () => {}, close: () => {} });
    },
  });
}
