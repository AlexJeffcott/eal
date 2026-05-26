import type { SttProvider, TtsProvider } from './voice-providers.ts';

/**
 * Deterministic STT/TTS pair for tests and pre-Whisper bring-up.
 *
 * The fixture STT resolves any non-empty utterance to a canned
 * transcript, and the fixture TTS emits a fixed-duration tone burst.
 * Selected by setting `EAL_STT_PROVIDER=fixture` / `EAL_TTS_PROVIDER=fixture`.
 * They make the wire path verifiable end to end without depending on
 * external binaries or hosted APIs.
 */

export interface FixtureSttOptions {
  /** What to return for any utterance. Empty input is ignored. */
  transcript: string;
}

export function createFixtureStt(opts: FixtureSttOptions = { transcript: 'hello' }): SttProvider {
  return {
    async transcribe(pcm) {
      if (pcm.length === 0) return '';
      return opts.transcript;
    },
  };
}

export interface FixtureTtsOptions {
  /** Tone frequency in Hz; defaults to 440 (a common reference pitch). */
  toneHz: number;
  /**
   * How long, in 20 ms frames, to play. Multiplied by `text.length` so a
   * one-word reply is short and a long reply is long — that lets a test
   * distinguish "TTS happened" from "the right TTS happened" without
   * coupling to a real model.
   */
  framesPerChar: number;
  /** Peak amplitude as a fraction of full scale (0..1). */
  amplitude: number;
}

const DEFAULT_TTS_OPTIONS: FixtureTtsOptions = {
  toneHz: 440,
  framesPerChar: 1,
  amplitude: 0.5,
};

export function createFixtureTts(opts: Partial<FixtureTtsOptions> = {}): TtsProvider {
  const merged: FixtureTtsOptions = { ...DEFAULT_TTS_OPTIONS, ...opts };
  return {
    async *speak(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const frames = Math.max(1, trimmed.length * merged.framesPerChar);
      const samplesPerFrame = 480; // 20 ms at 24 kHz
      const peak = Math.max(0, Math.min(1, merged.amplitude)) * 0x7fff;
      let phase = 0;
      const phaseInc = (2 * Math.PI * merged.toneHz) / 24_000;
      for (let f = 0; f < frames; f++) {
        const chunk = new Int16Array(samplesPerFrame);
        for (let i = 0; i < samplesPerFrame; i++) {
          chunk[i] = Math.round(Math.sin(phase) * peak);
          phase += phaseInc;
          if (phase > Math.PI * 2) phase -= Math.PI * 2;
        }
        yield chunk;
      }
    },
  };
}
