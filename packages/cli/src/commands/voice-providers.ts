/**
 * Speech-to-text and text-to-speech provider seams for the agent's
 * voice loop. The loop depends on these interfaces; concrete bindings
 * (local whisper-cli, OpenAI Whisper, piper, macOS `say`, the fixture
 * pair used in tests) live in sibling modules and slot in by env var.
 */

export interface SttProvider {
  /**
   * Transcribe one utterance. The input is signed 16-bit PCM samples;
   * `sampleRate` is the rate the agent's call socket runs at (24 kHz
   * today). Implementations are responsible for any resampling the
   * underlying model requires.
   */
  transcribe(pcm: Int16Array, sampleRate: number): Promise<string>;
}

export interface TtsProvider {
  /**
   * Speak `text` and yield PCM frames the loop can pipe straight back
   * over the wire. Yielded chunks must be Int16Array at 24 kHz, mono,
   * 480 samples per chunk (one 20 ms frame). Implementations buffer
   * and resample as needed.
   */
  speak(text: string): AsyncIterable<Int16Array>;
}
