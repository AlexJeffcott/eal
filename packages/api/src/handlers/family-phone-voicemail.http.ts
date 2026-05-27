import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import {
  createFamilyPhoneVoiceMessagesRepo,
  type FamilyPhoneVoiceMessageMeta,
} from '../db/repos/family-phone-voice-messages.ts';
import { AuthError } from './auth.shared.ts';

const RIFF = 0x52494646; // 'RIFF'
const WAVE = 0x57415645; // 'WAVE'
const FMT_ = 0x666d7420; // 'fmt '
const DATA = 0x64617461; // 'data'

/**
 * Wrap a raw 16-bit signed little-endian PCM payload in a canonical
 * 44-byte WAV header. The voice loop emits its frames in exactly this
 * format; the wire delivers them unaltered. Mono / 16-bit are the only
 * shape the schema accepts (column defaults + voicemail rule path).
 */
function wrapPcmInWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(44 + pcm.byteLength));
  const view = new DataView(out.buffer);
  view.setUint32(0, RIFF, false);
  view.setUint32(4, 36 + pcm.byteLength, true);
  view.setUint32(8, WAVE, false);
  view.setUint32(12, FMT_, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, DATA, false);
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

export interface VoiceMessageMetaWire {
  id: number;
  toDeviceId: number;
  fromDeviceId: number | null;
  fromExternal: string | null;
  body: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  readAt: string | null;
  createdAt: string;
}

export function toVoiceMessageWire(row: FamilyPhoneVoiceMessageMeta): VoiceMessageMetaWire {
  return {
    id: row.id,
    toDeviceId: row.to_device_id,
    fromDeviceId: row.from_device_id,
    fromExternal: row.from_external,
    body: row.body,
    sampleRate: row.sample_rate,
    channels: row.channels,
    durationMs: row.duration_ms,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface VoicemailRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
  now?: () => Date;
}

function requirePrincipal(
  ctx: VoicemailRoutesContext,
  request: Request,
): Principal {
  const p = ctx.getPrincipal(request);
  if (!p) throw new AuthError(401, 'unauthenticated');
  return p;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}

export function familyPhoneVoicemailHttpRoutes(ctx: VoicemailRoutesContext) {
  const messages = createFamilyPhoneVoiceMessagesRepo(ctx.db);
  const devices = createFamilyPhoneDevicesRepo(ctx.db);
  const now = ctx.now ?? (() => new Date());

  return new Elysia({ prefix: '/api/family-phone' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .post(
      '/voice-messages',
      ({ body, request, set }) => {
        const principal = requirePrincipal(ctx, request);
        const target = devices.findById(body.to_device_id);
        if (!target) {
          set.status = 400;
          return { error: `unknown to_device_id ${body.to_device_id}` };
        }
        let fromDeviceId: number | null = null;
        if (body.from_device_id !== undefined && body.from_device_id !== null) {
          const fromDevice = devices.findById(body.from_device_id);
          if (!fromDevice) {
            set.status = 400;
            return { error: `unknown from_device_id ${body.from_device_id}` };
          }
          // The signed-in user may only post voicemails attributed to a
          // device they own. This prevents the worker for user A from
          // forging a "from B" attribution.
          if (fromDevice.user_id !== principal.userId) {
            set.status = 403;
            return { error: 'caller does not own the from_device' };
          }
          fromDeviceId = fromDevice.id;
        }
        if (typeof body.body !== 'string' || body.body.trim().length === 0) {
          set.status = 400;
          return { error: 'body is required' };
        }
        const audio = decodeBase64(body.audio_b64);
        if (audio.byteLength === 0) {
          set.status = 400;
          return { error: 'audio is empty' };
        }
        const sampleRate = body.sample_rate ?? 24000;
        const channels = body.channels ?? 1;
        if (sampleRate <= 0 || channels <= 0) {
          set.status = 400;
          return { error: 'sample_rate and channels must be positive' };
        }
        // duration_ms = audio.byteLength / (sample_rate * channels * 2)
        // (16-bit samples). Compute server-side so the wire stays honest.
        const durationMs = Math.round(
          (audio.byteLength * 1000) / (sampleRate * channels * 2),
        );
        const fromExternal =
          body.from_external !== undefined && body.from_external !== null
            ? body.from_external
            : null;
        const inserted = messages.insert({
          toDeviceId: target.id,
          fromDeviceId,
          fromExternal,
          body: body.body,
          audio,
          sampleRate,
          channels,
          durationMs,
        });
        return { voiceMessage: toVoiceMessageWire(inserted) };
      },
      {
        body: t.Object({
          to_device_id: t.Number(),
          from_device_id: t.Optional(t.Union([t.Number(), t.Null()])),
          from_external: t.Optional(t.Union([t.String(), t.Null()])),
          body: t.String(),
          audio_b64: t.String(),
          sample_rate: t.Optional(t.Number()),
          channels: t.Optional(t.Number()),
        }),
      },
    )
    .get('/voice-messages', ({ query, request, set }) => {
      const principal = requirePrincipal(ctx, request);
      const deviceIdRaw = Array.isArray(query['device_id']) ? query['device_id'][0] : query['device_id'];
      const unreadRaw = Array.isArray(query['unread']) ? query['unread'][0] : query['unread'];
      let toDeviceId: number | undefined;
      if (deviceIdRaw !== undefined) {
        const n = Number(deviceIdRaw);
        if (!Number.isInteger(n) || n <= 0) {
          set.status = 400;
          return { error: 'device_id must be a positive integer' };
        }
        const device = devices.findById(n);
        if (!device || device.user_id !== principal.userId) {
          set.status = 403;
          return { error: 'caller does not own the device' };
        }
        toDeviceId = n;
      }
      const filter: { toDeviceId?: number; unreadOnly?: boolean } = {};
      if (toDeviceId !== undefined) filter.toDeviceId = toDeviceId;
      if (unreadRaw === '1' || unreadRaw === 'true') filter.unreadOnly = true;
      return {
        voiceMessages: messages.list(filter).map(toVoiceMessageWire),
      };
    })
    .get('/voice-messages/:id/audio', ({ params, request, set }) => {
      const principal = requirePrincipal(ctx, request);
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        set.status = 400;
        return { error: 'voice message id must be a positive integer' };
      }
      const row = messages.findById(id);
      if (!row) {
        set.status = 404;
        return { error: `voice message ${id} not found` };
      }
      const target = devices.findById(row.to_device_id);
      if (!target || target.user_id !== principal.userId) {
        set.status = 403;
        return { error: 'caller does not own the target device' };
      }
      const wav = wrapPcmInWav(row.audio_blob, row.sample_rate, row.channels);
      set.headers['content-type'] = 'audio/wav';
      set.headers['cache-control'] = 'no-store';
      return new Response(wav);
    })
    .post('/voice-messages/:id/read', ({ params, request, set }) => {
      const principal = requirePrincipal(ctx, request);
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        set.status = 400;
        return { error: 'voice message id must be a positive integer' };
      }
      const row = messages.findById(id);
      if (!row) {
        set.status = 404;
        return { error: `voice message ${id} not found` };
      }
      const target = devices.findById(row.to_device_id);
      if (!target || target.user_id !== principal.userId) {
        set.status = 403;
        return { error: 'caller does not own the target device' };
      }
      const updated = messages.markRead(id, now().toISOString());
      if (!updated) {
        set.status = 404;
        return { error: `voice message ${id} not found` };
      }
      return { voiceMessage: toVoiceMessageWire(updated) };
    });
}
