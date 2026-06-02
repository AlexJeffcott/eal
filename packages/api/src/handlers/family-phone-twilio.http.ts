import { Elysia } from 'elysia';
import type { TwilioConfig } from '../twilio/config.ts';
import { verifyTwilioSignature } from '../twilio/signature.ts';
import type { PstnInboundRateLimiter } from './family-phone-pstn-rate-limit.ts';
import type { IvrDeps } from './family-phone-pstn-ivr.ts';
import {
  buildConnectStreamTwiML,
  buildIvrGatherTwiML,
  buildAfterConnectAnsweredTwiML,
  buildAfterConnectVoicemailTwiML,
  downloadAndExtractRecording,
  pickMenuUser,
  pickVoicemailTarget,
} from './family-phone-pstn-ivr.ts';

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
  /**
   * Phase 7D IVR + voicemail. When omitted, the voice webhook still
   * works but the IVR branch + voicemail recording are unavailable —
   * useful for the inbound-only tests that don't exercise the menu.
   */
  ivr?: IvrDeps;
}

/** Constant-folded "no IVR" answer for the few legacy tests that still
 *  mount the routes without an IVR bundle. */
function buildPlainConnectStreamTwiML(opts: {
  publicHost: string;
  callSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  targetHandsetId: number | null;
}): string {
  return buildConnectStreamTwiML({
    publicHost: opts.publicHost,
    callSid: opts.callSid,
    from: opts.from,
    to: opts.to,
    direction: opts.direction,
    ...(opts.targetHandsetId !== null ? { targetHandsetId: opts.targetHandsetId } : {}),
  });
}

function buildRejectTwiML(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Reject reason="busy"/>',
    '</Response>',
  ].join('\n');
}

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

/** Verify the X-Twilio-Signature on a form-encoded POST and parse the
 *  fields out. Returns null on auth failure so callers can branch to
 *  a 403 response identically. */
function verifyAndParse(
  request: Request,
  raw: string,
  authToken: string,
): Record<string, string> | null {
  const fields = searchParamsToFields(new URLSearchParams(raw));
  const signatureHeader = request.headers.get('x-twilio-signature');
  const ok = verifyTwilioSignature({
    authToken,
    url: publicUrl(request),
    formFields: fields,
    signatureHeader,
  });
  return ok ? fields : null;
}

export function twilioHttpRoutes(ctx: TwilioRoutesContext) {
  const ivr = ctx.ivr;
  return new Elysia({ prefix: '/api/family-phone/twilio' })
    .post(
      '/voice',
      ({ body, request, set }) => {
        const raw = typeof body === 'string' ? body : '';
        const fields = verifyAndParse(request, raw, ctx.twilio.authToken);
        if (fields === null) {
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
        const requestUrl = new URL(request.url);
        const direction: 'inbound' | 'outbound' =
          requestUrl.searchParams.get('direction') === 'outbound' ? 'outbound' : 'inbound';
        const targetHandsetId = parseHandsetParam(requestUrl.searchParams.get('handset'));
        set.headers['content-type'] = 'text/xml; charset=utf-8';
        // Phase 7D rate limit — inbound only.
        if (direction === 'inbound' && ctx.rateLimit) {
          const verdict = ctx.rateLimit.check(from);
          if (!verdict.allowed) {
            console.warn(
              `[twilio] rate-limited inbound call from ${from} (${verdict.count}/${verdict.max} in ${verdict.windowMs}ms)`,
            );
            return buildRejectTwiML();
          }
        }
        // Outbound: bridge straight to the stream as before.
        if (direction === 'outbound') {
          return buildPlainConnectStreamTwiML({
            publicHost: ctx.publicHost,
            callSid,
            from,
            to,
            direction,
            targetHandsetId,
          });
        }
        // Inbound without IVR wiring — keep the legacy path so old
        // mounts still work.
        if (!ivr) {
          return buildPlainConnectStreamTwiML({
            publicHost: ctx.publicHost,
            callSid,
            from,
            to,
            direction,
            targetHandsetId,
          });
        }
        // Known caller with an intended recipient: ring just them.
        const contact = ivr.pstnContacts.findByE164(from);
        if (contact && contact.intended_user_id !== null) {
          ivr.outcomes.prime(
            callSid,
            pickVoicemailTarget(
              { devices: ivr.devices },
              { kind: 'user', userId: contact.intended_user_id },
            ),
            from,
          );
          return buildConnectStreamTwiML({
            publicHost: ctx.publicHost,
            callSid,
            from,
            to,
            direction: 'inbound',
            routedUserId: contact.intended_user_id,
          });
        }
        // Unknown caller (or known but no recipient): DTMF menu.
        const menu = ivr.users.listInIvrMenu();
        return buildIvrGatherTwiML({ publicHost: ctx.publicHost, menu });
      },
      { parse: 'text' },
    )
    .post(
      '/ivr-pick',
      ({ body, request, set }) => {
        const raw = typeof body === 'string' ? body : '';
        const fields = verifyAndParse(request, raw, ctx.twilio.authToken);
        if (fields === null) {
          set.status = 403;
          return 'forbidden';
        }
        if (!ivr) {
          set.status = 500;
          return 'IVR not configured';
        }
        const callSid = fields['CallSid'] ?? '';
        const from = fields['From'] ?? '';
        const to = fields['To'] ?? '';
        const digits = fields['Digits'] ?? '';
        set.headers['content-type'] = 'text/xml; charset=utf-8';
        const picked = pickMenuUser(ivr.users.listInIvrMenu(), digits);
        if (!picked) {
          // No / unknown digit → household voicemail.
          ivr.outcomes.prime(
            callSid,
            pickVoicemailTarget({ devices: ivr.devices }, { kind: 'household' }),
            from,
          );
          // Fall through to a household-record TwiML by reusing the
          // gather builder's fallback shape: skip the gather, emit
          // just the record.
          return buildIvrGatherTwiML({
            publicHost: ctx.publicHost,
            menu: [],
            householdName: 'household',
          });
        }
        ivr.outcomes.prime(
          callSid,
          pickVoicemailTarget({ devices: ivr.devices }, { kind: 'user', userId: picked.id }),
          from,
        );
        return buildConnectStreamTwiML({
          publicHost: ctx.publicHost,
          callSid,
          from,
          to,
          direction: 'inbound',
          routedUserId: picked.id,
        });
      },
      { parse: 'text' },
    )
    .post(
      '/after-connect',
      ({ body, request, set }) => {
        const raw = typeof body === 'string' ? body : '';
        const fields = verifyAndParse(request, raw, ctx.twilio.authToken);
        if (fields === null) {
          set.status = 403;
          return 'forbidden';
        }
        if (!ivr) {
          set.status = 500;
          return 'IVR not configured';
        }
        const callSid = fields['CallSid'] ?? '';
        const record = ivr.outcomes.get(callSid);
        set.headers['content-type'] = 'text/xml; charset=utf-8';
        if (!record || record.outcome === 'answered') {
          return buildAfterConnectAnsweredTwiML();
        }
        return buildAfterConnectVoicemailTwiML({
          publicHost: ctx.publicHost,
          callSid,
        });
      },
      { parse: 'text' },
    )
    .post(
      '/recording',
      async ({ body, request, set }) => {
        const raw = typeof body === 'string' ? body : '';
        const fields = verifyAndParse(request, raw, ctx.twilio.authToken);
        if (fields === null) {
          set.status = 403;
          return 'forbidden';
        }
        if (!ivr) {
          set.status = 500;
          return 'IVR not configured';
        }
        const recordingUrl = fields['RecordingUrl'] ?? '';
        const callSid = fields['CallSid'] ?? '';
        const from = fields['From'] ?? '';
        const requestUrl = new URL(request.url);
        const targetParam = requestUrl.searchParams.get('target') ?? '';
        if (recordingUrl === '') {
          set.status = 400;
          return 'missing RecordingUrl';
        }
        let target: ReturnType<typeof pickVoicemailTarget> | null = null;
        const primed = ivr.outcomes.get(callSid);
        if (targetParam === 'household' || !primed) {
          target = pickVoicemailTarget({ devices: ivr.devices }, { kind: 'household' });
        } else {
          target = primed.voicemailTarget;
        }
        try {
          const audio = await downloadAndExtractRecording(ivr, recordingUrl);
          const body = `Voicemail from ${from || 'unknown'}`;
          if (target.kind === 'household') {
            ivr.voicemails.insert({
              toDeviceId: target.householdDeviceId,
              fromDeviceId: null,
              fromExternal: from || null,
              body,
              audio: audio.pcm,
              sampleRate: audio.sampleRate,
              channels: audio.channels,
              durationMs: audio.durationMs,
            });
          } else {
            // Fan-out one row per device the recipient owns.
            for (const deviceId of target.deviceIds) {
              ivr.voicemails.insert({
                toDeviceId: deviceId,
                fromDeviceId: null,
                fromExternal: from || null,
                body,
                audio: audio.pcm,
                sampleRate: audio.sampleRate,
                channels: audio.channels,
                durationMs: audio.durationMs,
              });
            }
          }
        } catch (err) {
          console.error('[twilio] /recording failed to persist voicemail:', err);
          set.status = 500;
          return 'recording persistence failed';
        }
        ivr.outcomes.drop(callSid);
        set.headers['content-type'] = 'text/xml; charset=utf-8';
        return '<?xml version="1.0" encoding="UTF-8"?>\n<Response/>';
      },
      { parse: 'text' },
    );
}
