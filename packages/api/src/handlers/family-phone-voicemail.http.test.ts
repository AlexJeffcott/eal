import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

interface VoiceMessageRecord {
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

function isVoiceMessageRecord(value: unknown): value is VoiceMessageRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value && 'toDeviceId' in value && 'body' in value)) return false;
  return (
    typeof value.id === 'number' &&
    typeof value.toDeviceId === 'number' &&
    typeof value.body === 'string'
  );
}

function isVoiceMessageResponse(value: unknown): value is { voiceMessage: VoiceMessageRecord } {
  if (typeof value !== 'object' || value === null || !('voiceMessage' in value)) return false;
  return isVoiceMessageRecord(value.voiceMessage);
}

function isVoiceMessagesResponse(value: unknown): value is { voiceMessages: VoiceMessageRecord[] } {
  if (typeof value !== 'object' || value === null || !('voiceMessages' in value)) return false;
  return Array.isArray(value.voiceMessages) && value.voiceMessages.every(isVoiceMessageRecord);
}

function isErrorResponse(value: unknown): value is { error: string } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  return typeof value.error === 'string';
}

function expectVoiceMessage(value: unknown): VoiceMessageRecord {
  if (!isVoiceMessageResponse(value)) {
    throw new Error(`expected { voiceMessage }, got ${JSON.stringify(value)}`);
  }
  return value.voiceMessage;
}

function expectError(value: unknown): string {
  if (!isErrorResponse(value)) {
    throw new Error(`expected { error }, got ${JSON.stringify(value)}`);
  }
  return value.error;
}

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

async function fetchJson(
  app: TestApp,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await app.handle(new Request(`https://localhost:3000${path}`, init));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

function toBase64(bytes: number[]): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe('family-phone voicemail http wire contract', () => {
  let db: DatabaseClient;
  let alex: Principal;
  let agentDeviceId: number;
  let targetDeviceId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
    const devices = createFamilyPhoneDevicesRepo(db);
    agentDeviceId = devices.insert({ userId: u.id, label: 'agent', kind: 'agent' }).id;
    targetDeviceId = devices.insert({ userId: u.id, label: 'leo handset', kind: 'handset' }).id;
  });

  test('POST without auth returns 401', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      body: 'x',
      audio_b64: toBase64([1, 2, 3, 4]),
    });
    expect(res.status).toBe(401);
  });

  test('POST inserts a voicemail attributed to the agent device', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    // 480 bytes = 240 PCM samples at 24kHz mono ≈ 10ms — big enough
    // for the rounded duration_ms to be non-zero.
    const audio = Array.from({ length: 480 }, (_, i) => i & 0xff);
    const res = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      from_device_id: agentDeviceId,
      body: 'time for bed',
      audio_b64: toBase64(audio),
      sample_rate: 24000,
      channels: 1,
    });
    expect(res.status).toBe(200);
    const vm = expectVoiceMessage(res.body);
    expect(vm.toDeviceId).toBe(targetDeviceId);
    expect(vm.fromDeviceId).toBe(agentDeviceId);
    expect(vm.body).toBe('time for bed');
    expect(vm.sampleRate).toBe(24000);
    expect(vm.durationMs).toBeGreaterThan(0);
    expect(vm.readAt).toBeNull();
  });

  test('POST rejects a from_device_id the caller does not own', async () => {
    const elisa = createUsersRepo(db).insert({ displayName: 'elisa' });
    const elisasDevice = createFamilyPhoneDevicesRepo(db).insert({
      userId: elisa.id,
      label: 'elisas phone',
      kind: 'pwa',
    }).id;
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      from_device_id: elisasDevice,
      body: 'spoofing',
      audio_b64: toBase64([1, 2, 3, 4]),
    });
    expect(res.status).toBe(403);
    expect(expectError(res.body)).toMatch(/from_device/);
  });

  test('POST rejects an unknown to_device_id', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: 9999,
      body: 'x',
      audio_b64: toBase64([1, 2]),
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/unknown to_device_id/);
  });

  test('POST rejects an empty audio payload', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      body: 'x',
      audio_b64: '',
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/audio is empty/);
  });

  test('POST rejects an empty body string', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      body: '  ',
      audio_b64: toBase64([1, 2]),
    });
    expect(res.status).toBe(400);
    expect(expectError(res.body)).toMatch(/body is required/);
  });

  test('GET lists the caller-owned device voicemails, optionally unread only', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      from_device_id: agentDeviceId,
      body: 'one',
      audio_b64: toBase64([1, 2, 3, 4]),
    });
    const second = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      from_device_id: agentDeviceId,
      body: 'two',
      audio_b64: toBase64([5, 6, 7, 8]),
    });
    const secondId = expectVoiceMessage(second.body).id;
    // Mark the first read by reading the second's `id - 1`.
    await fetchJson(app, 'POST', `/api/family-phone/voice-messages/${secondId - 1}/read`);

    const all = await fetchJson(app, 'GET', `/api/family-phone/voice-messages?device_id=${targetDeviceId}`);
    if (!isVoiceMessagesResponse(all.body)) throw new Error('expected list');
    expect(all.body.voiceMessages).toHaveLength(2);

    const unread = await fetchJson(
      app,
      'GET',
      `/api/family-phone/voice-messages?device_id=${targetDeviceId}&unread=1`,
    );
    if (!isVoiceMessagesResponse(unread.body)) throw new Error('expected list');
    expect(unread.body.voiceMessages).toHaveLength(1);
    expect(unread.body.voiceMessages[0]?.id).toBe(secondId);
  });

  test('GET rejects a device_id the caller does not own', async () => {
    const elisa = createUsersRepo(db).insert({ displayName: 'elisa' });
    const elisasDevice = createFamilyPhoneDevicesRepo(db).insert({
      userId: elisa.id,
      label: 'elisas phone',
      kind: 'pwa',
    }).id;
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(
      app,
      'GET',
      `/api/family-phone/voice-messages?device_id=${elisasDevice}`,
    );
    expect(res.status).toBe(403);
  });

  test('GET /:id/audio returns a WAV header followed by the original PCM bytes', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      from_device_id: agentDeviceId,
      body: 'x',
      audio_b64: toBase64([10, 20, 30, 40]),
    });
    const id = expectVoiceMessage(created.body).id;
    const res = await app.handle(
      new Request(`https://localhost:3000/api/family-phone/voice-messages/${id}/audio`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const wav = new Uint8Array(await res.arrayBuffer());
    // Header is 44 bytes; the first four spell "RIFF" and the four
    // after "WAVE" appear at offset 8.
    const ascii = (offset: number): string =>
      String.fromCharCode(...Array.from(wav.slice(offset, offset + 4)));
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(wav.byteLength).toBe(44 + 4);
    expect(Array.from(wav.slice(44))).toEqual([10, 20, 30, 40]);
  });

  test('GET /:id/audio rejects a caller who does not own the target device', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      from_device_id: agentDeviceId,
      body: 'x',
      audio_b64: toBase64([1, 2, 3, 4]),
    });
    const id = expectVoiceMessage(created.body).id;
    const elisa = createUsersRepo(db).insert({ displayName: 'elisa' });
    const elisaPrincipal: Principal = { userId: elisa.id, displayName: elisa.display_name };
    const app2 = await createTestApp(db, { principalOverride: elisaPrincipal });
    const res = await fetchJson(app2, 'GET', `/api/family-phone/voice-messages/${id}/audio`);
    expect(res.status).toBe(403);
  });

  test('POST /:id/read marks a voicemail read and is idempotent', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      from_device_id: agentDeviceId,
      body: 'x',
      audio_b64: toBase64([1, 2]),
    });
    const id = expectVoiceMessage(created.body).id;
    const first = await fetchJson(app, 'POST', `/api/family-phone/voice-messages/${id}/read`);
    const firstAt = expectVoiceMessage(first.body).readAt;
    expect(firstAt).not.toBeNull();
    const second = await fetchJson(app, 'POST', `/api/family-phone/voice-messages/${id}/read`);
    expect(expectVoiceMessage(second.body).readAt).toBe(firstAt);
  });

  test('POST /:id/read returns 404 for an unknown id', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/family-phone/voice-messages/9999/read');
    expect(res.status).toBe(404);
  });

  test('GET ?device_id=X surfaces household voicemails alongside personal ones', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    // Personal voicemail.
    await fetchJson(app, 'POST', '/api/family-phone/voice-messages', {
      to_device_id: targetDeviceId,
      from_device_id: agentDeviceId,
      body: 'personal',
      audio_b64: toBase64([1, 2, 3, 4]),
    });
    // Household voicemail — written directly via the repo since the
    // Phase 7D IVR/recording path is what produces them in real use.
    const devices = createFamilyPhoneDevicesRepo(db);
    const household = devices.getHouseholdDevice();
    db.prepare(
      `INSERT INTO family_phone_voice_messages
         (to_device_id, from_device_id, from_external, body, audio_blob, sample_rate, channels, duration_ms)
       VALUES (?, NULL, '+12025550100', 'household greeting', ?, 24000, 1, 100)`,
    ).run(household.id, new Uint8Array([9, 9, 9, 9]));
    const list = await fetchJson(
      app,
      'GET',
      `/api/family-phone/voice-messages?device_id=${targetDeviceId}`,
    );
    if (!isVoiceMessagesResponse(list.body)) throw new Error('expected list');
    const bodies = list.body.voiceMessages.map((v) => v.body).sort();
    expect(bodies).toEqual(['household greeting', 'personal']);
  });

  test('GET /:id/audio for a household voicemail is allowed for any paired member', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const devices = createFamilyPhoneDevicesRepo(db);
    const household = devices.getHouseholdDevice();
    const row = db
      .prepare<{ id: number }, [number, Uint8Array]>(
        `INSERT INTO family_phone_voice_messages
           (to_device_id, from_external, body, audio_blob, sample_rate, channels, duration_ms)
         VALUES (?, '+12025550100', 'house', ?, 24000, 1, 100) RETURNING id`,
      )
      .get(household.id, new Uint8Array([1, 2, 3, 4]));
    const res = await fetchJson(app, 'GET', `/api/family-phone/voice-messages/${row?.id}/audio`);
    expect(res.status).toBe(200);
  });
});
