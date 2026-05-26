/**
 * Synthesised ringtone. Uses two oscillators (440 Hz + 480 Hz, the classic
 * North-American dual-tone ring frequencies) routed through a gain node
 * that's envelope-shaped to give a familiar "ring ring … pause … ring
 * ring" pattern. No bundled audio file; everything is generated in
 * WebAudio.
 *
 * The class touches the browser's AudioContext through the
 * `../../platform/audio-context.ts` adapter. Tests mock that module via
 * `mock.module(...)` and the spy class lands here without any DI.
 */
import { AudioContext } from '../../platform/audio-context.ts';

const RING_DUTY_ON_SECONDS = 2.0;
const RING_DUTY_OFF_SECONDS = 4.0;

export class Ringtone {
  private ctx: AudioContext | null = null;
  private a: OscillatorNode | null = null;
  private b: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Start ringing. No-op if already started or on platforms without WebAudio. */
  start(): void {
    if (this.ctx !== null) return;
    if (AudioContext === null) return;
    const ctx = new AudioContext();
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
