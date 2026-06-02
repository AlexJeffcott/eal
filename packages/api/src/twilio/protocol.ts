/**
 * Phase 7B — parser for Twilio Media Stream WebSocket events.
 *
 * Twilio sends every event as a JSON text frame with an `event` discriminator.
 * Documented at https://www.twilio.com/docs/voice/twiml/stream#message-format.
 * We accept the five events we care about and drop the rest defensively —
 * an unknown event is treated identically to malformed input (returns null,
 * caller logs and ignores).
 *
 * Pure: no I/O, no codec, no bridge knowledge. The bridge composes this with
 * the rest of the stack.
 */

/**
 * The `direction` field is supplied by our TwiML — it carries the
 * value back through the Media Stream's `customParameters` so the
 * bridge can pick between fan-out (inbound: ring every online handset)
 * and bind (outbound: the named handset placed the call and is the
 * only valid peer). Defaults to 'inbound' when absent so existing
 * inbound-only flows keep their semantics.
 *
 * `targetHandsetId` is only meaningful when `direction === 'outbound'`
 * — the device id of the handset that initiated the outbound call.
 */
export type TwilioEvent =
  | { type: 'connected'; version: string }
  | {
      type: 'start';
      streamSid: string;
      callSid: string;
      from: string;
      to: string;
      direction: 'inbound' | 'outbound';
      targetHandsetId: number | null;
      /**
       * Phase 7D: inbound DTMF IVR routing. When the caller picks a
       * household member from the menu, the action URL threads their
       * user_id through the next `<Connect><Stream>` as
       * `customParameters.routed_user_id`. The session rings every
       * online device that user owns.
       */
      routedUserId: number | null;
    }
  | { type: 'media'; streamSid: string; track: 'inbound'; payload: string }
  | { type: 'mark'; streamSid: string; name: string }
  | { type: 'stop'; streamSid: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === 'string' ? v : null;
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = record[key];
  return isRecord(v) ? v : null;
}

/**
 * Parse a single Twilio media-WS frame. Returns null for any of:
 *   - non-JSON or non-object payload
 *   - unknown `event` value
 *   - missing required field for the matched event
 *   - `media` event whose `track` is not 'inbound' (we set the TwiML to
 *     bidirectional Connect; outbound frames would be our own echo and
 *     dropping them is the right default)
 *
 * The caller decides what to do with null — typically log warn and ignore.
 * Never throws.
 */
export function parseTwilioEvent(raw: string): TwilioEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const eventTag = getString(parsed, 'event');
  if (eventTag === null) return null;
  switch (eventTag) {
    case 'connected':
      return parseConnected(parsed);
    case 'start':
      return parseStart(parsed);
    case 'media':
      return parseMedia(parsed);
    case 'mark':
      return parseMark(parsed);
    case 'stop':
      return parseStop(parsed);
    default:
      return null;
  }
}

function parseConnected(record: Record<string, unknown>): TwilioEvent | null {
  const version = getString(record, 'version');
  if (version === null) return null;
  return { type: 'connected', version };
}

function parseStart(record: Record<string, unknown>): TwilioEvent | null {
  const start = getRecord(record, 'start');
  if (start === null) return null;
  const streamSid = getString(start, 'streamSid') ?? getString(record, 'streamSid');
  if (streamSid === null) return null;
  const callSid = getString(start, 'callSid');
  if (callSid === null) return null;
  // The customParameters block carries `from` and `to`, threaded through
  // the TwiML `<Parameter>` tags. Twilio's other top-level start fields
  // (`from` / `to`) are populated on outbound calls only.
  const custom = getRecord(start, 'customParameters');
  if (custom === null) return null;
  const from = getString(custom, 'from');
  const to = getString(custom, 'to');
  if (from === null || to === null) return null;
  // Outbound TwiML adds `direction=outbound` + the device id of the
  // handset that placed the call. Inbound TwiML omits both — the
  // parser defaults to 'inbound' so 7B's inbound path is unchanged.
  const directionRaw = getString(custom, 'direction');
  const direction: 'inbound' | 'outbound' = directionRaw === 'outbound' ? 'outbound' : 'inbound';
  const targetHandsetId = parseIntStrict(getString(custom, 'handset'));
  const routedUserId = parseIntStrict(getString(custom, 'routed_user_id'));
  return {
    type: 'start',
    streamSid,
    callSid,
    from,
    to,
    direction,
    targetHandsetId,
    routedUserId,
  };
}

function parseIntStrict(s: string | null): number | null {
  if (s === null || s === '') return null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function parseMedia(record: Record<string, unknown>): TwilioEvent | null {
  const streamSid = getString(record, 'streamSid');
  if (streamSid === null) return null;
  const media = getRecord(record, 'media');
  if (media === null) return null;
  const track = getString(media, 'track');
  if (track !== 'inbound') return null;
  const payload = getString(media, 'payload');
  if (payload === null) return null;
  return { type: 'media', streamSid, track, payload };
}

function parseMark(record: Record<string, unknown>): TwilioEvent | null {
  const streamSid = getString(record, 'streamSid');
  if (streamSid === null) return null;
  const mark = getRecord(record, 'mark');
  if (mark === null) return null;
  const name = getString(mark, 'name');
  if (name === null) return null;
  return { type: 'mark', streamSid, name };
}

function parseStop(record: Record<string, unknown>): TwilioEvent | null {
  const streamSid = getString(record, 'streamSid');
  if (streamSid === null) return null;
  return { type: 'stop', streamSid };
}
