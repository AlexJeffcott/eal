/**
 * Synthesised ringtone. Uses two oscillators (440 Hz + 480 Hz, the classic
 * North-American dual-tone ring frequencies) routed through a gain node
 * that's envelope-shaped to give a familiar "ring ring … pause … ring
 * ring" pattern. No bundled audio file; everything is generated in
 * WebAudio.
 *
 * The AudioContext constructor is injected so unit tests can pass a stub
 * and assert the sequence of WebAudio calls without a real audio backend.
 */

/**
 * Minimum WebAudio surface the Ringtone touches. Both the real
 * `AudioContext` class and the test stub assign structurally.
 */
export interface GainLike {
  readonly gain: {
    value: number;
    setValueAtTime(value: number, startTime: number): unknown;
    linearRampToValueAtTime(value: number, endTime: number): unknown;
  };
  connect(target: unknown): unknown;
}
export interface OscillatorLike {
  readonly frequency: { value: number };
  connect(target: unknown): unknown;
  start(): void;
  stop(): void;
}
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  createGain(): GainLike;
  createOscillator(): OscillatorLike;
  close(): Promise<void>;
}

export interface AudioContextCtor {
  new (options?: AudioContextOptions): AudioContextLike;
}

const RING_DUTY_ON_SECONDS = 2.0;
const RING_DUTY_OFF_SECONDS = 4.0;

export interface RingtoneDeps {
  audioContextCtor?: AudioContextCtor;
}

export class Ringtone {
  private ctx: AudioContextLike | null = null;
  private a: OscillatorLike | null = null;
  private b: OscillatorLike | null = null;
  private gain: GainLike | null = null;
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ctor: AudioContextCtor;

  constructor(deps: RingtoneDeps = {}) {
    // Default to the global AudioContext; tests pass a stub class.
    this.ctor = deps.audioContextCtor ?? AudioContext;
  }

  /** Start ringing. No-op if already started. */
  start(): void {
    if (this.ctx !== null) return;
    const ctx = new this.ctor();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const a = ctx.createOscillator();
    a.frequency.value = 440;
    a.connect(gain);
    const b = ctx.createOscillator();
    b.frequency.value = 480;
    b.connect(gain);
    a.start();
    b.start();
    this.ctx = ctx;
    this.a = a;
    this.b = b;
    this.gain = gain;
    this.scheduleNextCycle(0);
  }

  /** Stop ringing and release the audio resources. */
  async stop(): Promise<void> {
    if (this.scheduleTimer !== null) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    const { ctx, a, b, gain } = this;
    this.ctx = null;
    this.a = null;
    this.b = null;
    this.gain = null;
    if (gain) gain.gain.value = 0;
    try { a?.stop(); } catch { /* already stopped */ }
    try { b?.stop(); } catch { /* already stopped */ }
    if (ctx && ctx.state !== 'closed') {
      await ctx.close().catch(() => {});
    }
  }

  /** True when the ringtone is currently producing sound (between cycles). */
  isPlaying(): boolean {
    return this.ctx !== null;
  }

  /**
   * Schedule one ring + silence cycle starting after `delayMs`. The
   * envelope ramps gain up at start-of-ring and down at end-of-ring; the
   * scheduling re-enters via setTimeout so a missed cycle (browser
   * throttling, suspended context) just lands late without crashing.
   */
  private scheduleNextCycle(delayMs: number): void {
    this.scheduleTimer = setTimeout(() => {
      if (this.ctx === null || this.gain === null) return;
      const now = this.ctx.currentTime;
      this.gain.gain.setValueAtTime(0, now);
      this.gain.gain.linearRampToValueAtTime(0.2, now + 0.05);
      this.gain.gain.setValueAtTime(0.2, now + RING_DUTY_ON_SECONDS - 0.05);
      this.gain.gain.linearRampToValueAtTime(0, now + RING_DUTY_ON_SECONDS);
      this.scheduleNextCycle((RING_DUTY_ON_SECONDS + RING_DUTY_OFF_SECONDS) * 1000);
    }, delayMs);
  }
}
