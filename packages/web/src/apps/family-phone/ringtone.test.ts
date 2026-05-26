import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { delay } from '@eal/shared';

/**
 * Mock the platform adapter so Ringtone constructs the stub class
 * instead of the real browser AudioContext. The mock is module-level
 * — every `new AudioContext()` inside ringtone.ts lands on
 * StubAudioContext, and the test inspects what the stub recorded.
 */

interface StubGain {
  gain: {
    value: number;
    setValueAtTime(value: number, time: number): unknown;
    linearRampToValueAtTime(value: number, time: number): unknown;
  };
  connect(target: unknown): unknown;
  ramps: { v: number; t: number }[];
}

interface StubOscillator {
  frequency: { value: number };
  started: boolean;
  stopped: boolean;
  connect(target: unknown): unknown;
  start(): void;
  stop(): void;
}

class StubAudioContext {
  static instances: StubAudioContext[] = [];
  state: 'running' | 'closed' = 'running';
  currentTime = 0;
  destination: unknown = { id: 'destination' };
  gains: StubGain[] = [];
  oscillators: StubOscillator[] = [];
  closed = false;

  constructor() {
    StubAudioContext.instances.push(this);
  }

  createGain(): StubGain {
    const ramps: { v: number; t: number }[] = [];
    const gain: StubGain = {
      gain: {
        value: 0,
        setValueAtTime(v: number, t: number) { ramps.push({ v, t }); },
        linearRampToValueAtTime(v: number, t: number) { ramps.push({ v, t }); },
      },
      connect: () => undefined,
      ramps,
    };
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): StubOscillator {
    const o: StubOscillator = {
      frequency: { value: 0 },
      started: false,
      stopped: false,
      connect: () => undefined,
      start() { this.started = true; },
      stop() { this.stopped = true; },
    };
    this.oscillators.push(o);
    return o;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
  }
}

mock.module('../../platform/audio-context.ts', () => ({
  AudioContext: StubAudioContext,
}));

const { Ringtone } = await import('./ringtone.ts');

describe('Ringtone', () => {
  beforeEach(() => {
    StubAudioContext.instances = [];
  });

  test('start() opens an AudioContext and runs two oscillators at 440 + 480 Hz', () => {
    const r = new Ringtone();
    r.start();
    expect(StubAudioContext.instances.length).toBe(1);
    const ctx = StubAudioContext.instances[0];
    if (!ctx) throw new Error('unreachable');
    expect(ctx.oscillators.length).toBe(2);
    const freqs = ctx.oscillators.map((o) => o.frequency.value).sort();
    expect(freqs).toEqual([440, 480]);
    for (const o of ctx.oscillators) expect(o.started).toBe(true);
  });

  test('start() is idempotent — a second call does not open a new context', () => {
    const r = new Ringtone();
    r.start();
    r.start();
    expect(StubAudioContext.instances.length).toBe(1);
  });

  test('stop() closes the AudioContext and marks oscillators stopped', async () => {
    const r = new Ringtone();
    r.start();
    await r.stop();
    const ctx = StubAudioContext.instances[0];
    if (!ctx) throw new Error('unreachable');
    expect(ctx.closed).toBe(true);
    for (const o of ctx.oscillators) expect(o.stopped).toBe(true);
  });

  test('stop() before start() is a safe no-op', async () => {
    const r = new Ringtone();
    await r.stop();
    expect(r.isPlaying()).toBe(false);
  });

  test('isPlaying() reflects start/stop transitions', async () => {
    const r = new Ringtone();
    expect(r.isPlaying()).toBe(false);
    r.start();
    expect(r.isPlaying()).toBe(true);
    await r.stop();
    expect(r.isPlaying()).toBe(false);
  });

  test('start() schedules a gain envelope (ring-on for ~2s, ramps applied)', async () => {
    const r = new Ringtone();
    r.start();
    // The first cycle is scheduled via setTimeout(_, 0); let it land.
    await delay(5);
    const ctx = StubAudioContext.instances[0];
    if (!ctx) throw new Error('unreachable');
    const gain = ctx.gains[0];
    expect(gain?.ramps.length).toBeGreaterThanOrEqual(2);
    await r.stop();
  });

  test('stop() during an active cycle clears the scheduled callback', async () => {
    const r = new Ringtone();
    r.start();
    await delay(5);
    await r.stop();
    const ramps = StubAudioContext.instances[0]?.gains[0]?.ramps.length ?? 0;
    // Wait past one full cycle window — no new ramps should be added
    // because the schedule timer was cleared by stop().
    await delay(50);
    const after = StubAudioContext.instances[0]?.gains[0]?.ramps.length ?? 0;
    expect(after).toBe(ramps);
  });
});
