/**
 * Phase 7D — DTMF IVR + voicemail glue.
 *
 * The inbound voice webhook splits two ways:
 *   - Known caller whose contact carries `intended_user_id` → goes
 *     straight to `<Connect><Stream routed_user_id=N>` so the bridge
 *     rings only that user's online devices.
 *   - Anyone else → returns `<Gather numDigits=1>` with a TTS menu of
 *     opted-in users; the `<Gather action>` URL is `/twilio/ivr-pick`.
 *
 * `/twilio/ivr-pick` reads the pressed digit and either routes to the
 * chosen user (another `<Connect><Stream>` with routed_user_id) or
 * drops to a household-voicemail `<Record>`.
 *
 * `<Connect>` carries an `action` so Twilio POSTs `/twilio/after-connect`
 * once the media stream ends. That handler reads the in-memory outcomes
 * tracker the bridge writes to: 'answered' → end the call cleanly,
 * 'unanswered' → emit `<Record>` to the recipient's inbox.
 *
 * `/twilio/recording` fetches the resulting audio with Basic auth,
 * extracts PCM samples from the WAV container, and persists into
 * `family_phone_voice_messages` against the target the outcomes record
 * primed.
 *
 * Pure module: no env reads, no global fetch. The router builds the
 * dependency bundle once at boot.
 */
import type { TwilioConfig } from '../twilio/config.ts';
import type { UsersRepo, UserRow } from '../db/repos/users.ts';
import type { PstnContactsRepo } from '../db/repos/family-phone-pstn-contacts.ts';
import type { FamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import type { FamilyPhoneVoiceMessagesRepo } from '../db/repos/family-phone-voice-messages.ts';
import type { PstnCallOutcomes, PstnCallRecord } from './family-phone-pstn-outcomes.ts';

export interface IvrDeps {
  twilio: TwilioConfig;
  users: UsersRepo;
  pstnContacts: PstnContactsRepo;
  devices: FamilyPhoneDevicesRepo;
  voicemails: FamilyPhoneVoiceMessagesRepo;
  outcomes: PstnCallOutcomes;
  publicHost: string;
  /**
   * HTTP transport. Production omits; tests inject a captured fake so
   * the recording fetch is testable without network. Mirrors the
   * pattern in twilio/rest.ts.
   */
  fetch?: typeof fetch;
}

/**
 * Build the `<Connect><Stream>` body, optionally carrying customParameters
 * the bridge reads (`direction`, `handset` for outbound, `routed_user_id`
 * for IVR-resolved inbound). Always sets `action=/twilio/after-connect` so
 * Twilio gives us a follow-up shot at TwiML once the stream ends.
 */
export interface ConnectStreamOptions {
  publicHost: string;
  callSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  targetHandsetId?: number;
  routedUserId?: number;
}

export function buildConnectStreamTwiML(opts: ConnectStreamOptions): string {
  const streamUrl = `wss://${opts.publicHost}/api/family-phone/twilio/media`;
  const afterConnectUrl = `https://${opts.publicHost}/api/family-phone/twilio/after-connect`;
  const parameters: Array<[string, string]> = [
    ['callSid', opts.callSid],
    ['from', opts.from],
    ['to', opts.to],
    ['direction', opts.direction],
  ];
  if (opts.targetHandsetId !== undefined) {
    parameters.push(['handset', String(opts.targetHandsetId)]);
  }
  if (opts.routedUserId !== undefined) {
    parameters.push(['routed_user_id', String(opts.routedUserId)]);
  }
  const paramTags = parameters
    .map(([n, v]) => `      <Parameter name="${n}" value="${escapeAttribute(v)}"/>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Connect action="${escapeAttribute(afterConnectUrl)}">`,
    `    <Stream url="${escapeAttribute(streamUrl)}">`,
    paramTags,
    '    </Stream>',
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

/**
 * The DTMF menu: a `<Gather>` with one digit per opted-in user, plus
 * the post-timeout fallback that drops to household voicemail. The
 * action URL is signed by Twilio when it POSTs back.
 */
export function buildIvrGatherTwiML(deps: {
  publicHost: string;
  menu: UserRow[];
  householdName?: string;
}): string {
  const householdName = deps.householdName ?? 'household';
  const actionUrl = `https://${deps.publicHost}/api/family-phone/twilio/ivr-pick`;
  const recordActionUrl =
    `https://${deps.publicHost}/api/family-phone/twilio/recording?target=household`;
  const promptParts: string[] = [
    `You've reached the ${householdName}.`,
  ];
  if (deps.menu.length === 0) {
    promptParts.push('Please leave a message after the tone.');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `  <Say>${escapeXml(promptParts.join(' '))}</Say>`,
      `  <Record action="${escapeAttribute(recordActionUrl)}" maxLength="60" finishOnKey="#" playBeep="true"/>`,
      '</Response>',
    ].join('\n');
  }
  deps.menu.forEach((u, i) => {
    promptParts.push(`Press ${i + 1} for ${u.display_name}.`);
  });
  promptParts.push('Or stay on the line to leave a message for the household.');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Gather numDigits="1" action="${escapeAttribute(actionUrl)}" method="POST" timeout="8" finishOnKey="">`,
    `    <Say>${escapeXml(promptParts.join(' '))}</Say>`,
    '  </Gather>',
    // Gather falls through to here if no digit was pressed within the
    // timeout. Drop to household voicemail.
    `  <Record action="${escapeAttribute(recordActionUrl)}" maxLength="60" finishOnKey="#" playBeep="true"/>`,
    '</Response>',
  ].join('\n');
}

/** TwiML reply for `<Connect action>` when the call WAS answered — end. */
export function buildAfterConnectAnsweredTwiML(): string {
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<Response/>'].join('\n');
}

/** TwiML reply for `<Connect action>` when the call was NOT answered —
 *  voicemail. The action URL carries the target the outcomes record
 *  primed so /recording knows which inbox to write to. */
export function buildAfterConnectVoicemailTwiML(deps: {
  publicHost: string;
  callSid: string;
}): string {
  const recordActionUrl =
    `https://${deps.publicHost}/api/family-phone/twilio/recording?target=primed&call_sid=` +
    encodeURIComponent(deps.callSid);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say>The person you're calling can't take your call right now. Please leave a message after the tone.</Say>`,
    `  <Record action="${escapeAttribute(recordActionUrl)}" maxLength="60" finishOnKey="#" playBeep="true"/>`,
    '</Response>',
  ].join('\n');
}

/**
 * Decide which inbox a voicemail row should land in given an IVR
 * selection. The outcomes record stashes this so the recording webhook
 * can apply it without re-deriving.
 */
export function pickVoicemailTarget(
  deps: { devices: FamilyPhoneDevicesRepo },
  selection: { kind: 'household' } | { kind: 'user'; userId: number },
): PstnCallRecord['voicemailTarget'] {
  if (selection.kind === 'household') {
    return { kind: 'household', householdDeviceId: deps.devices.getHouseholdDevice().id };
  }
  const owned = deps.devices.listByUser(selection.userId);
  return { kind: 'user', userId: selection.userId, deviceIds: owned.map((d) => d.id) };
}

/**
 * Map a single DTMF digit ('1'..'9') onto the menu the prompt read out.
 * Returns null when the digit is empty, out of range, or non-numeric.
 */
export function pickMenuUser(menu: UserRow[], digits: string): UserRow | null {
  if (digits.length === 0) return null;
  // Twilio collects the digit string verbatim — '1' for "press 1".
  if (!/^[1-9]$/.test(digits)) return null;
  const idx = Number.parseInt(digits, 10) - 1;
  return menu[idx] ?? null;
}

/**
 * Fetch a Twilio recording (WAV) with Basic auth, extract its PCM
 * samples, and return a payload ready to insert into
 * family_phone_voice_messages. Throws on HTTP failure, malformed WAV,
 * or unsupported codec.
 */
export async function downloadAndExtractRecording(
  deps: IvrDeps,
  recordingUrl: string,
): Promise<{ pcm: Uint8Array; sampleRate: number; channels: number; durationMs: number }> {
  const httpFetch = deps.fetch ?? fetch;
  // Twilio appends `.wav` to the recording URL when fetching the audio
  // (the bare URL serves JSON metadata). Be defensive — if the caller
  // already included `.wav`, don't double it.
  const url = /\.wav$/.test(recordingUrl) ? recordingUrl : `${recordingUrl}.wav`;
  const basic = `Basic ${btoa(`${deps.twilio.accountSid}:${deps.twilio.authToken}`)}`;
  const res = await httpFetch(url, {
    method: 'GET',
    headers: { authorization: basic, accept: 'audio/wav' },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Twilio recording fetch failed (${res.status}): ${await res.text()}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return extractWavPcm(bytes);
}

/**
 * Minimal WAV chunk walker. Extracts the first `fmt ` and `data`
 * chunks, asserts 16-bit PCM (format code 1), returns the PCM bytes
 * verbatim plus sample_rate/channels/duration. Twilio recordings can
 * include extra chunks (`LIST`, `fact`) between fmt and data — the
 * walker skips them.
 */
export function extractWavPcm(bytes: Uint8Array): {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
  durationMs: number;
} {
  if (bytes.byteLength < 44) throw new Error('WAV too short');
  const td = new TextDecoder('ascii');
  if (td.decode(bytes.subarray(0, 4)) !== 'RIFF') throw new Error('WAV missing RIFF');
  if (td.decode(bytes.subarray(8, 12)) !== 'WAVE') throw new Error('WAV missing WAVE');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let formatCode = 0;
  let pcm: Uint8Array | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = td.decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (id === 'fmt ') {
      formatCode = view.getUint16(dataStart, true);
      channels = view.getUint16(dataStart + 2, true);
      sampleRate = view.getUint32(dataStart + 4, true);
      bitsPerSample = view.getUint16(dataStart + 14, true);
    } else if (id === 'data') {
      pcm = bytes.subarray(dataStart, dataStart + size);
      break;
    }
    // Chunk sizes are padded to a 2-byte boundary.
    offset = dataStart + size + (size % 2);
  }
  if (pcm === null) throw new Error('WAV missing data chunk');
  if (formatCode !== 1) throw new Error(`unsupported WAV format code ${formatCode} (need 1=PCM)`);
  if (bitsPerSample !== 16) {
    throw new Error(`unsupported WAV bit depth ${bitsPerSample} (need 16)`);
  }
  if (sampleRate <= 0 || channels <= 0) throw new Error('WAV fmt chunk had bad sample_rate/channels');
  const sampleCount = pcm.byteLength / 2 / channels;
  const durationMs = Math.round((sampleCount / sampleRate) * 1000);
  return { pcm, sampleRate, channels, durationMs };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
