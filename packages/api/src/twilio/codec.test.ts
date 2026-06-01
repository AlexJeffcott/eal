import { describe, expect, test } from 'bun:test';
import {
  downsample24To8,
  pcm16ToPcmu,
  pcmuFrameToRelayPcm,
  pcmuToPcm16,
  relayPcmToPcmuFrame,
  upsample8To24,
} from './codec.ts';

describe('PCMU (G.711 μ-law) encoder/decoder', () => {
  test('decoding silence yields zeros', () => {
    // 0xFF is the μ-law silence sentinel (sign=1, exponent=7, mantissa=15,
    // post-inversion = 0x00 — magnitude underflows to zero).
    const silence = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const pcm = pcmuToPcm16(silence);
    expect(Array.from(pcm)).toEqual([0, 0, 0, 0]);
  });

  test('encoding zero PCM yields the μ-law silence byte', () => {
    const pcmu = pcm16ToPcmu(new Int16Array([0, 0, 0]));
    expect(Array.from(pcmu)).toEqual([0xff, 0xff, 0xff]);
  });

  test('encoder then decoder round-trips within μ-law quantisation', () => {
    // μ-law is lossy; the round-trip error grows with magnitude but
    // stays bounded by the step size at that magnitude. Pin a sample
    // set against generous-but-real ceilings.
    const inputs = [0, 100, -100, 1000, -1000, 8000, -8000, 32000, -32000];
    for (const sample of inputs) {
      const round = pcmuToPcm16(pcm16ToPcmu(new Int16Array([sample])))[0];
      if (round === undefined) throw new Error('round-trip lost a sample');
      const tolerance = Math.max(8, Math.abs(sample) >> 5);
      expect(Math.abs(round - sample) <= tolerance).toBe(true);
    }
  });

  test('paired ±sign bytes decode to magnitudes that mirror across zero', () => {
    // μ-law byte 0x80 has the sign bit set on the wire; after the
    // protocol inversion it decodes positive. 0x00 (its sign-flipped
    // companion) decodes to the same magnitude with the opposite sign.
    const positive = pcmuToPcm16(new Uint8Array([0x80]))[0];
    const negative = pcmuToPcm16(new Uint8Array([0x00]))[0];
    if (positive === undefined || negative === undefined) {
      throw new Error('decode lost a sample');
    }
    expect(positive > 0).toBe(true);
    expect(negative < 0).toBe(true);
    expect(Math.abs(Math.abs(positive) - Math.abs(negative))).toBeLessThanOrEqual(1);
  });
});

describe('8 kHz → 24 kHz upsample', () => {
  test('output length is exactly 3× input length', () => {
    const out = upsample8To24(new Int16Array(160));
    expect(out.length).toBe(480);
  });

  test('each original sample appears at index i*3 unchanged', () => {
    const input = new Int16Array([100, 200, 300, 400]);
    const out = upsample8To24(input);
    expect(out[0]).toBe(100);
    expect(out[3]).toBe(200);
    expect(out[6]).toBe(300);
    expect(out[9]).toBe(400);
  });

  test('interpolated samples lie between their neighbours', () => {
    const input = new Int16Array([0, 300]);
    const out = upsample8To24(input);
    // a=0, b=300 → 0, 100, 200 then 300 triplicated.
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(100);
    expect(out[2]).toBe(200);
    expect(out[3]).toBe(300);
  });

  test('the last sample is triplicated since there is no successor', () => {
    const input = new Int16Array([0, 0, 999]);
    const out = upsample8To24(input);
    expect(out[6]).toBe(999);
    expect(out[7]).toBe(999);
    expect(out[8]).toBe(999);
  });

  test('empty input yields empty output', () => {
    expect(upsample8To24(new Int16Array(0)).length).toBe(0);
  });
});

describe('24 kHz → 8 kHz downsample', () => {
  test('output length is ceil(input / 3)', () => {
    expect(downsample24To8(new Int16Array(480)).length).toBe(160);
    expect(downsample24To8(new Int16Array(481)).length).toBe(161);
    expect(downsample24To8(new Int16Array(482)).length).toBe(161);
  });

  test('each output sample is the mean of its three input neighbours', () => {
    const input = new Int16Array([10, 20, 30, 40, 50, 60]);
    const out = downsample24To8(input);
    expect(out[0]).toBe(20); // mean(10, 20, 30)
    expect(out[1]).toBe(50); // mean(40, 50, 60)
  });

  test('a partial trailing group averages just the present samples', () => {
    const input = new Int16Array([10, 20, 30, 40]);
    const out = downsample24To8(input);
    expect(out[0]).toBe(20);
    expect(out[1]).toBe(40); // mean(40)
  });

  test('empty input yields empty output', () => {
    expect(downsample24To8(new Int16Array(0)).length).toBe(0);
  });
});

describe('full Twilio↔relay bridge functions', () => {
  test('pcmuFrameToRelayPcm: a 160-sample 20 ms PCMU frame becomes 480 samples', () => {
    // Twilio's media events carry 160 PCMU bytes per 20 ms frame at 8 kHz.
    // The relay carries 24 kHz, so one frame produces 480 PCM samples.
    const pcmuFrame = new Uint8Array(160).fill(0xff);
    const pcm = pcmuFrameToRelayPcm(pcmuFrame);
    expect(pcm.length).toBe(480);
    // Silence in → silence out.
    expect(pcm.every((s) => s === 0)).toBe(true);
  });

  test('relayPcmToPcmuFrame: 480 samples of 24 kHz PCM → 160-byte PCMU frame', () => {
    const pcm = new Int16Array(480);
    const pcmu = relayPcmToPcmuFrame(pcm);
    expect(pcmu.length).toBe(160);
    // Silence in → μ-law silence (0xff) out.
    expect(pcmu.every((b) => b === 0xff)).toBe(true);
  });

  test('round-trip of a synthetic voice-band signal preserves shape modulo codec loss', () => {
    // Build a 24 kHz PCM ramp (~ DC-to-low-frequency content), pass it
    // through relay → Twilio → relay, and check the peak survives.
    const pcm = new Int16Array(480);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin(i / 24));
    const round = pcmuFrameToRelayPcm(relayPcmToPcmuFrame(pcm));
    expect(round.length).toBe(480);
    // Peak amplitudes survive within the codec's step error at that
    // magnitude — bounded by ~256 at 8000-magnitude territory.
    const peakIn = pcm.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    const peakOut = round.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    expect(Math.abs(peakIn - peakOut)).toBeLessThanOrEqual(512);
  });
});
