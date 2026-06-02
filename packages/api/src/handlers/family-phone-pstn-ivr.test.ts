import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import {
  buildAfterConnectAnsweredTwiML,
  buildAfterConnectVoicemailTwiML,
  buildConnectStreamTwiML,
  buildIvrGatherTwiML,
  extractWavPcm,
  pickMenuUser,
  pickVoicemailTarget,
} from './family-phone-pstn-ivr.ts';

describe('extractWavPcm', () => {
  function buildWav(opts: {
    sampleRate: number;
    channels: number;
    pcm: Uint8Array;
    extraChunkBeforeData?: { id: string; size: number };
  }): Uint8Array {
    const { sampleRate, channels, pcm } = opts;
    const fmtSize = 16;
    const extraSize = opts.extraChunkBeforeData
      ? 8 + opts.extraChunkBeforeData.size + (opts.extraChunkBeforeData.size % 2)
      : 0;
    const dataSize = pcm.byteLength;
    const totalRiffSize = 4 + (8 + fmtSize) + extraSize + (8 + dataSize);
    const out = new Uint8Array(8 + totalRiffSize);
    const view = new DataView(out.buffer);
    const enc = new TextEncoder();
    out.set(enc.encode('RIFF'), 0);
    view.setUint32(4, totalRiffSize, true);
    out.set(enc.encode('WAVE'), 8);
    out.set(enc.encode('fmt '), 12);
    view.setUint32(16, fmtSize, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    let offset = 36;
    if (opts.extraChunkBeforeData) {
      out.set(enc.encode(opts.extraChunkBeforeData.id), offset);
      view.setUint32(offset + 4, opts.extraChunkBeforeData.size, true);
      offset += 8 + opts.extraChunkBeforeData.size + (opts.extraChunkBeforeData.size % 2);
    }
    out.set(enc.encode('data'), offset);
    view.setUint32(offset + 4, dataSize, true);
    out.set(pcm, offset + 8);
    return out;
  }

  test('extracts PCM bytes and reports the sample rate / channels / duration', () => {
    const samples = 8000; // 1s @ 8 kHz mono = 16000 bytes
    const pcm = new Uint8Array(samples * 2);
    const result = extractWavPcm(buildWav({ sampleRate: 8000, channels: 1, pcm }));
    expect(result.pcm.byteLength).toBe(pcm.byteLength);
    expect(result.sampleRate).toBe(8000);
    expect(result.channels).toBe(1);
    expect(result.durationMs).toBe(1000);
  });

  test('skips an unknown chunk between fmt and data (Twilio sometimes emits LIST)', () => {
    const pcm = new Uint8Array(160);
    const result = extractWavPcm(
      buildWav({
        sampleRate: 8000,
        channels: 1,
        pcm,
        extraChunkBeforeData: { id: 'LIST', size: 5 },
      }),
    );
    expect(result.pcm.byteLength).toBe(160);
  });

  test('throws on truncated input', () => {
    expect(() => extractWavPcm(new Uint8Array(8))).toThrow();
  });

  test('throws on missing RIFF / WAVE markers', () => {
    const buf = new Uint8Array(64);
    expect(() => extractWavPcm(buf)).toThrow();
  });
});

describe('pickMenuUser', () => {
  const menu = [
    { id: 1, display_name: 'alex', created_at: '', in_ivr_menu: 1 as const },
    { id: 2, display_name: 'sarah', created_at: '', in_ivr_menu: 1 as const },
  ];

  test('1 → first user, 2 → second user', () => {
    expect(pickMenuUser(menu, '1')?.id).toBe(1);
    expect(pickMenuUser(menu, '2')?.id).toBe(2);
  });

  test('out-of-range, empty, and non-numeric digits return null', () => {
    expect(pickMenuUser(menu, '0')).toBeNull();
    expect(pickMenuUser(menu, '3')).toBeNull();
    expect(pickMenuUser(menu, '')).toBeNull();
    expect(pickMenuUser(menu, '#')).toBeNull();
    expect(pickMenuUser(menu, 'a')).toBeNull();
  });
});

describe('pickVoicemailTarget', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('household selection resolves to the singleton household device id', () => {
    const devices = createFamilyPhoneDevicesRepo(db);
    const t = pickVoicemailTarget({ devices }, { kind: 'household' });
    expect(t.kind).toBe('household');
    if (t.kind === 'household') {
      expect(t.householdDeviceId).toBe(devices.getHouseholdDevice().id);
    }
  });

  test('user selection collects every device that user owns', () => {
    const users = createUsersRepo(db);
    const devices = createFamilyPhoneDevicesRepo(db);
    const alex = users.insert({ displayName: 'alex' });
    const a = devices.insert({ userId: alex.id, label: 'phone', kind: 'handset' });
    const b = devices.insert({ userId: alex.id, label: 'pwa', kind: 'pwa' });
    const t = pickVoicemailTarget({ devices }, { kind: 'user', userId: alex.id });
    expect(t.kind).toBe('user');
    if (t.kind === 'user') {
      expect(t.deviceIds.sort()).toEqual([a.id, b.id].sort());
    }
  });
});

describe('TwiML builders', () => {
  test('buildConnectStreamTwiML includes routed_user_id when provided', () => {
    const xml = buildConnectStreamTwiML({
      publicHost: 'eal.example.com',
      callSid: 'CA1',
      from: '+1',
      to: '+2',
      direction: 'inbound',
      routedUserId: 9,
    });
    expect(xml).toContain('name="routed_user_id" value="9"');
    expect(xml).toContain('<Stream');
    expect(xml).toContain('action="https://eal.example.com/api/family-phone/twilio/after-connect"');
  });

  test('buildIvrGatherTwiML lists each opted-in user with a digit', () => {
    const menu = [
      { id: 1, display_name: 'alex', created_at: '', in_ivr_menu: 1 as const },
      { id: 2, display_name: 'sarah', created_at: '', in_ivr_menu: 1 as const },
    ];
    const xml = buildIvrGatherTwiML({ publicHost: 'eal.example.com', menu });
    expect(xml).toContain('<Gather');
    expect(xml).toContain('Press 1 for alex');
    expect(xml).toContain('Press 2 for sarah');
    expect(xml).toContain('action="https://eal.example.com/api/family-phone/twilio/ivr-pick"');
    // Falls through to a Record on Gather timeout.
    expect(xml).toContain('<Record');
    expect(xml).toContain('target=household');
  });

  test('buildIvrGatherTwiML with an empty menu skips Gather, goes straight to Record', () => {
    const xml = buildIvrGatherTwiML({ publicHost: 'eal.example.com', menu: [] });
    expect(xml).not.toContain('<Gather');
    expect(xml).toContain('<Record');
  });

  test('buildAfterConnect: answered → empty Response, unanswered → Record', () => {
    expect(buildAfterConnectAnsweredTwiML()).toContain('<Response/>');
    const vm = buildAfterConnectVoicemailTwiML({
      publicHost: 'eal.example.com',
      callSid: 'CA1',
    });
    expect(vm).toContain('<Record');
    expect(vm).toContain('target=primed');
    expect(vm).toContain('call_sid=CA1');
  });
});
