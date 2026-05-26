import { describe, expect, test } from 'bun:test';
import { decodeWavPcm16, encodeWavPcm16 } from './wav.ts';

describe('encodeWavPcm16 / decodeWavPcm16', () => {
  test('round-trips a small PCM-16 buffer at the given sample rate', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 100, -100]);
    const encoded = encodeWavPcm16(samples, 24_000);
    expect(encoded.byteLength).toBe(44 + samples.length * 2);
    const decoded = decodeWavPcm16(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.sampleRate).toBe(24_000);
    expect(Array.from(decoded?.samples ?? [])).toEqual(Array.from(samples));
  });

  test('rejects a buffer that is not a RIFF WAV', () => {
    expect(decodeWavPcm16(new Uint8Array(44))).toBeNull();
  });

  test('rejects a multi-channel WAV (only mono is in scope)', () => {
    // Forge a header: mark NumChannels = 2 to trip the guard.
    const wav = encodeWavPcm16(new Int16Array([1, 2, 3]), 24_000);
    new DataView(wav.buffer).setUint16(22, 2, true);
    expect(decodeWavPcm16(wav)).toBeNull();
  });

  test('rejects a 24-bit WAV (only 16-bit is in scope)', () => {
    const wav = encodeWavPcm16(new Int16Array([1, 2, 3]), 24_000);
    new DataView(wav.buffer).setUint16(34, 24, true);
    expect(decodeWavPcm16(wav)).toBeNull();
  });

  test('returns null for buffers shorter than a WAV header', () => {
    expect(decodeWavPcm16(new Uint8Array(10))).toBeNull();
  });
});
