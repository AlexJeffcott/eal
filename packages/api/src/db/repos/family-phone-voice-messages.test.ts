import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../client.ts';
import { applySchema } from '../schema.ts';
import { createFamilyPhoneDevicesRepo } from './family-phone-devices.ts';
import { createFamilyPhoneVoiceMessagesRepo } from './family-phone-voice-messages.ts';
import { createUsersRepo } from './users.ts';

interface Seeded {
  agentDeviceId: number;
  targetDeviceId: number;
  otherTargetDeviceId: number;
}

function seed(db: DatabaseClient): Seeded {
  const userId = createUsersRepo(db).insert({ displayName: 'alex' }).id;
  const devices = createFamilyPhoneDevicesRepo(db);
  return {
    agentDeviceId: devices.insert({ userId, label: 'agent', kind: 'agent' }).id,
    targetDeviceId: devices.insert({ userId, label: 'leo handset', kind: 'handset' }).id,
    otherTargetDeviceId: devices.insert({ userId, label: 'elisa phone', kind: 'pwa' }).id,
  };
}

function pcm(bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

describe('FamilyPhoneVoiceMessagesRepo', () => {
  let db: DatabaseClient;
  let seeded: Seeded;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    seeded = seed(db);
  });

  test('insert round-trips every field and defaults read_at to null', () => {
    const repo = createFamilyPhoneVoiceMessagesRepo(db);
    const row = repo.insert({
      toDeviceId: seeded.targetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'time for bed',
      audio: pcm([1, 2, 3, 4]),
      sampleRate: 24000,
      channels: 1,
      durationMs: 80,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.to_device_id).toBe(seeded.targetDeviceId);
    expect(row.from_device_id).toBe(seeded.agentDeviceId);
    expect(row.from_external).toBeNull();
    expect(row.body).toBe('time for bed');
    expect(row.sample_rate).toBe(24000);
    expect(row.channels).toBe(1);
    expect(row.duration_ms).toBe(80);
    expect(row.read_at).toBeNull();
    expect(row.created_at).toBeTruthy();
  });

  test('findById returns the row including the audio_blob bytes', () => {
    const repo = createFamilyPhoneVoiceMessagesRepo(db);
    const inserted = repo.insert({
      toDeviceId: seeded.targetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'x',
      audio: pcm([10, 20, 30, 40, 50, 60]),
      sampleRate: 16000,
      channels: 1,
      durationMs: 200,
    });
    const found = repo.findById(inserted.id);
    expect(found).not.toBeNull();
    expect(found?.audio_blob).toBeInstanceOf(Uint8Array);
    expect(Array.from(found?.audio_blob ?? [])).toEqual([10, 20, 30, 40, 50, 60]);
  });

  test('list filters by toDeviceId and unreadOnly independently', () => {
    const repo = createFamilyPhoneVoiceMessagesRepo(db);
    const a = repo.insert({
      toDeviceId: seeded.targetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'a',
      audio: pcm([1]),
      sampleRate: 24000,
      channels: 1,
      durationMs: 10,
    });
    const b = repo.insert({
      toDeviceId: seeded.targetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'b',
      audio: pcm([1]),
      sampleRate: 24000,
      channels: 1,
      durationMs: 10,
    });
    repo.insert({
      toDeviceId: seeded.otherTargetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'c',
      audio: pcm([1]),
      sampleRate: 24000,
      channels: 1,
      durationMs: 10,
    });
    repo.markRead(a.id, '2025-06-01T00:00:00.000Z');

    expect(repo.list({ toDeviceId: seeded.targetDeviceId }).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(repo.list({ toDeviceId: seeded.targetDeviceId, unreadOnly: true }).map((r) => r.id)).toEqual([b.id]);
    expect(repo.list({ unreadOnly: true }).filter((r) => r.to_device_id === seeded.targetDeviceId).map((r) => r.id)).toEqual([b.id]);
    expect(repo.list({}).length).toBe(3);
  });

  test('markRead is idempotent — a second mark preserves the first readAt', () => {
    const repo = createFamilyPhoneVoiceMessagesRepo(db);
    const inserted = repo.insert({
      toDeviceId: seeded.targetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'x',
      audio: pcm([1]),
      sampleRate: 24000,
      channels: 1,
      durationMs: 10,
    });
    const first = repo.markRead(inserted.id, '2025-06-01T00:00:00.000Z');
    const second = repo.markRead(inserted.id, '2025-07-01T00:00:00.000Z');
    expect(first?.read_at).toBe('2025-06-01T00:00:00.000Z');
    expect(second?.read_at).toBe('2025-06-01T00:00:00.000Z');
  });

  test('markRead returns null for an unknown id', () => {
    const repo = createFamilyPhoneVoiceMessagesRepo(db);
    expect(repo.markRead(9999, '2025-01-01T00:00:00.000Z')).toBeNull();
  });

  test('deleteOlderThan removes rows by created_at and returns the count', () => {
    const repo = createFamilyPhoneVoiceMessagesRepo(db);
    repo.insert({
      toDeviceId: seeded.targetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'x',
      audio: pcm([1]),
      sampleRate: 24000,
      channels: 1,
      durationMs: 10,
    });
    // Use a far-future cutoff so every existing row is past it.
    const removed = repo.deleteOlderThan('2099-12-31T00:00:00');
    expect(removed).toBeGreaterThan(0);
    expect(repo.list({}).length).toBe(0);
  });

  test('ON DELETE CASCADE wipes voicemails when the target device is deleted', () => {
    const repo = createFamilyPhoneVoiceMessagesRepo(db);
    repo.insert({
      toDeviceId: seeded.targetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'x',
      audio: pcm([1]),
      sampleRate: 24000,
      channels: 1,
      durationMs: 10,
    });
    createFamilyPhoneDevicesRepo(db).deleteById(seeded.targetDeviceId);
    expect(repo.list({}).length).toBe(0);
  });

  test('ON DELETE SET NULL clears from_device_id when the source device is deleted', () => {
    const repo = createFamilyPhoneVoiceMessagesRepo(db);
    const inserted = repo.insert({
      toDeviceId: seeded.targetDeviceId,
      fromDeviceId: seeded.agentDeviceId,
      fromExternal: null,
      body: 'x',
      audio: pcm([1]),
      sampleRate: 24000,
      channels: 1,
      durationMs: 10,
    });
    createFamilyPhoneDevicesRepo(db).deleteById(seeded.agentDeviceId);
    expect(repo.findById(inserted.id)?.from_device_id).toBeNull();
  });
});
