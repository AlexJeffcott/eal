import { describe, expect, test } from 'bun:test';
import { createFixtureStt, createFixtureTts } from './voice-providers-fixture.ts';

describe('createFixtureStt', () => {
  test('returns the canned transcript for any non-empty utterance', async () => {
    const stt = createFixtureStt({ transcript: 'goodbye' });
    const out = await stt.transcribe(new Int16Array([1, 2, 3]), 24_000);
    expect(out).toBe('goodbye');
  });

  test('returns an empty string for empty input (the loop treats this as no speech)', async () => {
    const stt = createFixtureStt();
    const out = await stt.transcribe(new Int16Array(), 24_000);
    expect(out).toBe('');
  });
});

describe('createFixtureTts', () => {
  test('emits 480-sample frames whose count scales with text length', async () => {
    const tts = createFixtureTts({ framesPerChar: 1, toneHz: 200, amplitude: 0.5 });
    const frames: Int16Array[] = [];
    for await (const f of tts.speak('hello')) frames.push(f);
    expect(frames.length).toBe(5); // one frame per character
    for (const f of frames) {
      expect(f.length).toBe(480);
      // The tone should produce non-zero energy.
      let energy = 0;
      for (let i = 0; i < f.length; i++) energy += Math.abs(f[i] ?? 0);
      expect(energy / f.length).toBeGreaterThan(0);
    }
  });

  test('yields nothing for whitespace-only text', async () => {
    const tts = createFixtureTts();
    const frames: Int16Array[] = [];
    for await (const f of tts.speak('   ')) frames.push(f);
    expect(frames).toEqual([]);
  });

  test('amplitude=0 produces silent frames', async () => {
    const tts = createFixtureTts({ amplitude: 0 });
    const frames: Int16Array[] = [];
    for await (const f of tts.speak('hi')) frames.push(f);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) for (let i = 0; i < f.length; i++) expect(f[i]).toBe(0);
  });
});
