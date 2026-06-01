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

export type TwilioEvent =
  | { type: 'connected'; version: string }
  | { type: 'start'; streamSid: string; callSid: string; from: string; to: string }
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
  return { type: 'start', streamSid, callSid, from, to };
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
