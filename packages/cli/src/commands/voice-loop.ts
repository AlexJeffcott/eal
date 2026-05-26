import type { Message } from '@eal/client';
import type { ClaudeRunner } from './claude-runner.ts';
import type { SttProvider, TtsProvider } from './voice-providers.ts';

/**
 * Voice loop: own one connected call's speech exchange.
 *
 * The agent's family-phone socket delivers binary PCM frames into
 * `onInboundFrame`. The loop runs a small energy-based VAD to segment
 * utterances, sends each completed utterance through STT, hands the
 * transcript to the existing ClaudeRunner, chunks the reply at sentence
 * boundaries, drives TTS for each sentence, and pipes the synthesised
 * PCM straight back via `sendAudio`.
 *
 * v1 is deliberately half-duplex: while the assistant is thinking or
 * speaking, inbound frames are dropped. Barge-in is a v2 concern.
 */

export interface VoiceLoopDeps {
  runClaude: ClaudeRunner;
  stt: SttProvider;
  tts: TtsProvider;
  /** Emit a 20 ms PCM frame back to the caller. */
  sendAudio: (payload: Uint8Array) => void;
  log: (line: string) => void;
}

export interface VoiceLoopOptions {
  /** Sample rate of the inbound PCM stream. The wire runs 24 kHz today. */
  sampleRate: number;
  /** Samples per inbound frame. 480 = 20 ms at 24 kHz, matching the PWA. */
  samplesPerFrame: number;
  /**
   * Frame energy (mean abs of Int16 samples) above which the frame is
   * considered speech. 500 sits comfortably above quiet-room ambient
   * (~50–200) and below normal speech (~2000+).
   */
  speechEnergyThreshold: number;
  /**
   * Number of consecutive silence frames after speech that closes an
   * utterance. 30 frames = 600 ms at 20 ms/frame, per the plan's D4
   * "energy + 600 ms silence hangover" rule.
   */
  silenceHangoverFrames: number;
  /**
   * Minimum number of speech frames required before an utterance is
   * accepted. Filters tiny clicks and door slams.
   */
  minUtteranceFrames: number;
}

export const DEFAULT_VOICE_LOOP_OPTIONS: VoiceLoopOptions = {
  sampleRate: 24_000,
  samplesPerFrame: 480,
  speechEnergyThreshold: 500,
  silenceHangoverFrames: 30,
  minUtteranceFrames: 5,
};

export interface VoiceLoop {
  /** Feed one inbound binary frame's PCM payload (post wire-framing strip). */
  onInboundFrame(pcm: Uint8Array): void;
  /** Stop accepting frames and abort any in-flight work. */
  close(): void;
}

type LoopState = 'listening' | 'thinking' | 'speaking';

export function createVoiceLoop(
  deps: VoiceLoopDeps,
  options: VoiceLoopOptions = DEFAULT_VOICE_LOOP_OPTIONS,
): VoiceLoop {
  let state: LoopState = 'listening';
  let closed = false;
  // Accumulated samples for the current in-progress utterance.
  const utterance: number[] = [];
  let speechFramesInUtterance = 0;
  let silenceFramesAfterSpeech = 0;
  // Per-call Claude session id — carried across turns so the assistant
  // remembers what was said earlier in the same conversation.
  let sessionId: string | null = null;

  function setState(next: LoopState): void {
    if (state === next) return;
    deps.log(`eal agent: voice loop ${state} → ${next}`);
    state = next;
  }

  function resetUtterance(): void {
    utterance.length = 0;
    speechFramesInUtterance = 0;
    silenceFramesAfterSpeech = 0;
  }

  async function processUtterance(samples: Int16Array): Promise<void> {
    setState('thinking');
    let transcript: string;
    try {
      transcript = (await deps.stt.transcribe(samples, options.sampleRate)).trim();
    } catch (err) {
      deps.log(`eal agent: STT failed: ${describe(err)}`);
      setState('listening');
      return;
    }
    if (transcript.length === 0) {
      deps.log('eal agent: empty transcript, returning to listening');
      setState('listening');
      return;
    }
    deps.log(`eal agent: heard "${transcript}"`);

    let pending = '';
    let claudeResult;
    try {
      claudeResult = await deps.runClaude(
        { conversation: [oneTurn(transcript)], sessionId },
        (delta) => {
          if (closed) return;
          pending += delta;
          // Emit each completed sentence to TTS as soon as it lands so the
          // reply starts playing before Claude finishes. The plan's D5
          // latency budget hinges on this — buffering until chat:done
          // pushes end-of-speech to first-audio over 3 s.
          let boundary = findSentenceBoundary(pending);
          while (boundary !== -1) {
            const sentence = pending.slice(0, boundary + 1).trim();
            pending = pending.slice(boundary + 1);
            if (sentence.length > 0) void speakSentence(sentence);
            boundary = findSentenceBoundary(pending);
          }
        },
      );
    } catch (err) {
      deps.log(`eal agent: Claude run failed: ${describe(err)}`);
      setState('listening');
      return;
    }
    sessionId = claudeResult.sessionId;
    const tail = pending.trim();
    if (tail.length > 0) await speakSentence(tail);
    if (!closed) setState('listening');
  }

  async function speakSentence(sentence: string): Promise<void> {
    if (closed) return;
    setState('speaking');
    try {
      for await (const chunk of deps.tts.speak(sentence)) {
        if (closed) return;
        deps.sendAudio(pcm16Bytes(chunk));
      }
    } catch (err) {
      deps.log(`eal agent: TTS failed: ${describe(err)}`);
    }
  }

  return {
    onInboundFrame(pcm) {
      if (closed) return;
      // Half-duplex: ignore audio while the agent is thinking or
      // speaking. Buffering would let the next utterance start before
      // the reply finishes, which the loop is not prepared to handle.
      if (state !== 'listening') return;

      const samples = decodePcm16(pcm);
      const energy = meanAbs(samples);
      const isSpeech = energy >= options.speechEnergyThreshold;

      if (isSpeech) {
        for (let i = 0; i < samples.length; i++) utterance.push(samples[i] ?? 0);
        speechFramesInUtterance += 1;
        silenceFramesAfterSpeech = 0;
        return;
      }

      // Silence. Only meaningful once we've started capturing speech;
      // pre-speech silence is dropped.
      if (speechFramesInUtterance === 0) return;
      // Keep the silence in the buffer so the model sees a natural tail.
      for (let i = 0; i < samples.length; i++) utterance.push(samples[i] ?? 0);
      silenceFramesAfterSpeech += 1;

      if (silenceFramesAfterSpeech < options.silenceHangoverFrames) return;
      if (speechFramesInUtterance < options.minUtteranceFrames) {
        // Too brief to be real speech (a click, a thump). Discard.
        resetUtterance();
        return;
      }

      const snapshot = new Int16Array(utterance);
      resetUtterance();
      void processUtterance(snapshot);
    },
    close() {
      closed = true;
      setState('listening');
      resetUtterance();
    },
  };
}

function decodePcm16(bytes: Uint8Array): Int16Array {
  // Copy into a fresh buffer so a DataView is well-aligned even when
  // the caller hands us an offset slice from a larger frame.
  const aligned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  aligned.set(bytes);
  const view = new DataView(aligned.buffer);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

function pcm16Bytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(samples.length * 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return out;
}

function meanAbs(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i++) total += Math.abs(samples[i] ?? 0);
  return total / samples.length;
}

/** Index (inclusive) of the first sentence-ending punctuation, or -1. */
function findSentenceBoundary(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      // Require the next char to be whitespace or end-of-string so we
      // don't slice on numbers like "3.5" or URLs.
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next)) return i;
    }
  }
  return -1;
}

function oneTurn(content: string): Message {
  return {
    id: 0,
    role: 'user',
    content,
    createdBy: 0,
    createdAt: new Date().toISOString(),
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
