import { Elysia } from 'elysia';
import type { TwilioConfig } from '../twilio/config.ts';
import { verifyTwilioSignature } from '../twilio/signature.ts';
import type { PstnInboundRateLimiter } from './family-phone-pstn-rate-limit.ts';

export interface TwilioRoutesContext {
  twilio: TwilioConfig;
  /**
   * Hostname the api is reachable at from Twilio (i.e. the Tailscale
   * Funnel domain in prod). Used to build the `wss://` stream URL the
   * TwiML response points Twilio at.
   */
  publicHost: string;
  /**
   * Per-source rate limiter (Phase 7D). Consulted only on inbound calls
   * — for outbound dial-outs, Twilio's TwiML fetch carries our own
   * number as `From`, which would otherwise throttle the household's
   * own UI. When omitted, no rate-limit gate applies.
   */
  rateLimit?: PstnInboundRateLimiter;
}

interface TwiMLOptions {
  streamUrl: string;
  callSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  /**
   * Only set on outbound calls. The handset that placed the call: the
   * bridge binds the media stream to this device id, skipping fan-out.
   */
  targetHandsetId: number | null;
}

/**
 * The TwiML response Twilio fetches on every call: ask Twilio to open
 * a bidirectional Media Stream to our WS endpoint and bridge it with
 * the caller. The `customParameters` carry every per-call field the
 * bridge needs — caller-id, direction, and (on outbound) the bound
 * handset — so the WS side does not have to parse separate events
 * for them.
 */
function buildTwiML(opts: TwiMLOptions): string {
  const parameters: Array<[string, string]> = [
    ['callSid', opts.callSid],
    ['from', opts.from],
    ['to', opts.to],
    ['direction', opts.direction],
  ];
  if (opts.targetHandsetId !== null) {
    parameters.push(['handset', String(opts.targetHandsetId)]);
  }
  const paramTags = parameters
    .map(([name, value]) => `      <Parameter name="${name}" value="${escapeAttribute(value)}"/>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${escapeAttribute(opts.streamUrl)}">`,
    paramTags,
    '    </Stream>',
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

/**
 * The "drop this call without ringing the household" reply. Twilio
 * treats `<Reject reason="busy">` as a SIP 486 Busy from our side, so
 * the dialler hears a busy tone and Twilio bills nothing further. The
 * webhook still returns 200 — the response status reflects "we
 * understood the request", not "we accepted the call".
 */
function buildRejectTwiML(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Reject reason="busy"/>',
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
function parseHandsetParam(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

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
        // Outbound calls come back through this same webhook with a
        // `direction=outbound&handset=<id>` query string the
        // place-call handler (7C.4) puts on the TwiML URL it sends
        // Twilio. Twilio signs the full URL — query included — so
        // the verifier above has already proved the params are
        // exactly the ones we requested.
        const requestUrl = new URL(request.url);
        const direction: 'inbound' | 'outbound' =
          requestUrl.searchParams.get('direction') === 'outbound' ? 'outbound' : 'inbound';
        const targetHandsetId = parseHandsetParam(requestUrl.searchParams.get('handset'));
        set.headers['content-type'] = 'text/xml; charset=utf-8';
        // Phase 7D rate limit — inbound only. The `from` field is the
        // remote E.164 on inbound calls; on outbound it's our own
        // trunk number, where throttling would just block the
        // household's own dial-pad.
        if (direction === 'inbound' && ctx.rateLimit) {
          const verdict = ctx.rateLimit.check(from);
          if (!verdict.allowed) {
            console.warn(
              `[twilio] rate-limited inbound call from ${from} (${verdict.count}/${verdict.max} in ${verdict.windowMs}ms)`,
            );
            return buildRejectTwiML();
          }
        }
        const streamUrl = `wss://${ctx.publicHost}/api/family-phone/twilio/media`;
        return buildTwiML({ streamUrl, callSid, from, to, direction, targetHandsetId });
      },
      {
        // Twilio sends application/x-www-form-urlencoded; we read the
        // raw text body ourselves so the signature verifier sees the
        // same bytes Twilio signed.
        parse: 'text',
      },
    );
}
