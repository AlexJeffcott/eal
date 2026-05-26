import { describe, expect, test } from 'bun:test';
import { delay } from '@eal/shared';
import { Ringtone, type AudioContextCtor } from './ringtone.ts';

/**
 * Stub WebAudio classes. The Ringtone class only touches a small surface
 * (createOscillator, createGain, currentTime, destination, gain ramps,
 * connect, close) — enough to assert with simple shape checks.
 */

interface StubGain {
  gain: {
    value: number;
    setValueAtTime: (v: number, t: number) => void;
    linearRampToValueAtTime: (v: number, t: number) => void;
  };
  connect: (target: unknown) => unknown;
  ramps: { v: number; t: number }[];
}

interface StubOscillator {
  frequency: { value: number };
  started: boolean;
  stopped: boolean;
  connect: (target: unknown) => unknown;
  start: () => void;
  stop: () => void;
}

interface StubCtx {
  state: 'running' | 'closed';
  currentTime: number;
  destination: unknown;
  gains: StubGain[];
  oscillators: StubOscillator[];
  closed: boolean;
  createGain: () => StubGain;
  createOscillator: () => StubOscillator;
  close: () => Promise<void>;
}

function makeStubCtor(): { ctor: AudioContextCtor; instances: StubCtx[] } {
  const instances: StubCtx[] = [];
  // Class form so `new ctor()` is well-typed against AudioContextCtor.
  class StubAudioContext {
    state: 'running' | 'closed' = 'running';
    currentTime = 0;
    destination = { id: 'destination' };
    gains: StubGain[] = [];
    oscillators: StubOscillator[] = [];
    closed = false;
    constructor() {
      instances.push(this);
    }
    createGain(): StubGain {
      const ramps: { v: number; t: number }[] = [];
      const gain: StubGain = {
        gain: {
          value: 0,
          setValueAtTime(v, t) { ramps.push({ v, t }); },
          linearRampToValueAtTime(v, t) { ramps.push({ v, t }); },
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
  // Structural match against AudioContextCtor — the stub class implements
  // every method Ringtone touches with compatible signatures.
  const ctor: AudioContextCtor = StubAudioContext;
  return { ctor, instances };
}

describe('Ringtone', () => {
  test('start() opens an AudioContext and runs two oscillators at 440 + 480 Hz', () => {
    const { ctor, instances } = makeStubCtor();
    const r = new Ringtone({ audioContextCtor: ctor });
    r.start();
    expect(instances.length).toBe(1);
    const ctx = instances[0];
    if (!ctx) throw new Error('unreachable');
    expect(ctx.oscillators.length).toBe(2);
    const freqs = ctx.oscillators.map((o) => o.frequency.value).sort();
    expect(freqs).toEqual([440, 480]);
    for (const o of ctx.oscillators) expect(o.started).toBe(true);
  });

  test('start() is idempotent — a second call does not open a new context', () => {
    const { ctor, instances } = makeStubCtor();
    const r = new Ringtone({ audioContextCtor: ctor });
    r.start();
    r.start();
    expect(instances.length).toBe(1);
  });

  test('stop() closes the AudioContext and marks oscillators stopped', async () => {
    const { ctor, instances } = makeStubCtor();
    const r = new Ringtone({ audioContextCtor: ctor });
    r.start();
    await r.stop();
    const ctx = instances[0];
    if (!ctx) throw new Error('unreachable');
    expect(ctx.closed).toBe(true);
    for (const o of ctx.oscillators) expect(o.stopped).toBe(true);
  });

  test('stop() before start() is a safe no-op', async () => {
    const r = new Ringtone({ audioContextCtor: makeStubCtor().ctor });
    await r.stop();
    expect(r.isPlaying()).toBe(false);
  });

  test('isPlaying() reflects start/stop transitions', async () => {
    const r = new Ringtone({ audioContextCtor: makeStubCtor().ctor });
    expect(r.isPlaying()).toBe(false);
    r.start();
    expect(r.isPlaying()).toBe(true);
    await r.stop();
    expect(r.isPlaying()).toBe(false);
  });

  test('start() schedules a gain envelope (ring-on for ~2s, ramps applied)', async () => {
    const { ctor, instances } = makeStubCtor();
    const r = new Ringtone({ audioContextCtor: ctor });
    r.start();
    // The first cycle is scheduled via setTimeout(_, 0); let it land.
    await delay(5);
    const ctx = instances[0];
    if (!ctx) throw new Error('unreachable');
    const gain = ctx.gains[0];
    expect(gain?.ramps.length).toBeGreaterThanOrEqual(2);
    await r.stop();
  });
});
