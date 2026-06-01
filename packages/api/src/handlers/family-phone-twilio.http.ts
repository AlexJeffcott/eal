import { Elysia } from 'elysia';
import type { TwilioConfig } from '../twilio/config.ts';
import { verifyTwilioSignature } from '../twilio/signature.ts';

export interface TwilioRoutesContext {
  twilio: TwilioConfig;
  /**
   * Hostname the api is reachable at from Twilio (i.e. the Tailscale
   * Funnel domain in prod). Used to build the `wss://` stream URL the
   * TwiML response points Twilio at.
   */
  publicHost: string;
}

/**
 * The TwiML response Twilio fetches on every inbound call: ask Twilio to
 * open a bidirectional Media Stream to our WS endpoint and bridge it
 * with the caller. The `customParameters` carry the call's identifying
 * fields so the WS side does not have to parse a separate event for
 * caller-id.
 */
function buildTwiML(streamUrl: string, callSid: string, from: string, to: string): string {
  const escapedSid = escapeAttribute(callSid);
  const escapedFrom = escapeAttribute(from);
  const escapedTo = escapeAttribute(to);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${escapeAttribute(streamUrl)}">`,
    `      <Parameter name="callSid" value="${escapedSid}"/>`,
    `      <Parameter name="from" value="${escapedFrom}"/>`,
    `      <Parameter name="to" value="${escapedTo}"/>`,
    '    </Stream>',
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

/**
 * Minimal XML attribute escape — Twilio's parser is strict about the
 * five XML attribute-unsafe chars. The values come from Twilio in the
 * first place (call SID, caller-id) and are already E.164/uuid-shaped,
 * but escaping is cheap and forecloses an injection if Twilio ever
 * relaxes its caller-id normalisation.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert an URLSearchParams instance into the plain Record the
 * signature module wants. Each parameter appears once — Twilio does
 * not send repeated keys for voice webhooks.
 */
function searchParamsToFields(params: URLSearchParams): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [k, v] of params.entries()) fields[k] = v;
  return fields;
}

/**
 * Reconstruct the URL Twilio used to call us — Elysia gives us the
 * Request which has the full origin and path. Twilio signs whatever it
 * dialled, including the query string, so the URL the verifier sees
 * must match byte-for-byte.
 */
function publicUrl(request: Request): string {
  return request.url;
}

export function twilioHttpRoutes(ctx: TwilioRoutesContext) {
  return new Elysia({ prefix: '/api/family-phone/twilio' })
    .post(
      '/voice',
      ({ body, request, set }) => {
        const raw = typeof body === 'string' ? body : '';
        const fields = searchParamsToFields(new URLSearchParams(raw));
        const signatureHeader = request.headers.get('x-twilio-signature');
        const ok = verifyTwilioSignature({
          authToken: ctx.twilio.authToken,
          url: publicUrl(request),
          formFields: fields,
          signatureHeader,
        });
        if (!ok) {
          set.status = 403;
          return 'forbidden';
        }
        const callSid = fields['CallSid'] ?? '';
        const from = fields['From'] ?? '';
        const to = fields['To'] ?? '';
        if (callSid === '' || from === '' || to === '') {
          set.status = 400;
          return 'missing required Twilio voice fields';
        }
        const streamUrl = `wss://${ctx.publicHost}/api/family-phone/twilio/media`;
        set.headers['content-type'] = 'text/xml; charset=utf-8';
        return buildTwiML(streamUrl, callSid, from, to);
      },
      {
        // Twilio sends application/x-www-form-urlencoded; we read the
        // raw text body ourselves so the signature verifier sees the
        // same bytes Twilio signed.
        parse: 'text',
      },
    );
}
