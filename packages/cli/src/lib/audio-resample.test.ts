import { describe, expect, test } from 'bun:test';
import { chunkInt16, resampleInt16 } from './audio-resample.ts';

describe('resampleInt16', () => {
  test('returns the same buffer when rates match', () => {
    const input = new Int16Array([100, 200, 300]);
    expect(resampleInt16(input, 24_000, 24_000)).toBe(input);
  });

  test('upsamples by integer ratio without losing samples', () => {
    const out = resampleInt16(new Int16Array([0, 100, 200]), 100, 200);
    expect(out.length).toBe(6);
    // Endpoints stay anchored; interior values are linearly interpolated.
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBeGreaterThan(100); // last sample is between 100 and 200
  });

  test('downsamples without going out of range', () => {
    const input = new Int16Array(1000);
    for (let i = 0; i < 1000; i++) input[i] = i;
    const out = resampleInt16(input, 1000, 250);
    expect(out.length).toBe(250);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBeLessThanOrEqual(1000);
  });

  test('an empty input yields an empty output', () => {
    expect(resampleInt16(new Int16Array(), 22_050, 24_000).length).toBe(0);
  });
});

describe('chunkInt16', () => {
  test('produces frames of exactly samplesPerFrame, padding the last one', () => {
    const samples = new Int16Array([1, 2, 3, 4, 5]);
    const frames = Array.from(chunkInt16(samples, 2));
    expect(frames.length).toBe(3);
    expect(Array.from(frames[0]!)).toEqual([1, 2]);
    expect(Array.from(frames[1]!)).toEqual([3, 4]);
    expect(Array.from(frames[2]!)).toEqual([5, 0]);
  });

  test('returns nothing when samplesPerFrame is non-positive', () => {
    expect(Array.from(chunkInt16(new Int16Array([1, 2, 3]), 0))).toEqual([]);
  });
});
