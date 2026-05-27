import { describe, expect, test } from 'bun:test';
import {
  createVoiceLoop,
  DEFAULT_VOICE_LOOP_OPTIONS,
  type VoiceLoopDeps,
  type VoiceLoopOptions,
} from './voice-loop.ts';
import type { ClaudeRunner } from './claude-runner.ts';
import type { SttProvider, TtsProvider } from './voice-providers.ts';

function pcm16Bytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(samples.length * 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return out;
}

function silenceFrame(samplesPerFrame: number): Uint8Array {
  return pcm16Bytes(new Int16Array(samplesPerFrame));
}

function speechFrame(samplesPerFrame: number, amplitude = 6000): Uint8Array {
  const s = new Int16Array(samplesPerFrame);
  for (let i = 0; i < samplesPerFrame; i++) s[i] = i % 2 === 0 ? amplitude : -amplitude;
  return pcm16Bytes(s);
}

interface Spies {
  sttCalls: number;
  ttsCalls: string[];
  claudeCalls: number;
  sentFrames: Uint8Array[];
  logs: string[];
}

function makeDeps(
  reply: string,
  options?: { sttTranscript?: string; ttsFramesPerSentence?: number },
): { deps: VoiceLoopDeps; spies: Spies } {
  const spies: Spies = {
    sttCalls: 0,
    ttsCalls: [],
    claudeCalls: 0,
    sentFrames: [],
    logs: [],
  };
  const stt: SttProvider = {
    async transcribe(pcm) {
      spies.sttCalls += 1;
      if (pcm.length === 0) return '';
      return options?.sttTranscript ?? 'what time is it';
    },
  };
  const tts: TtsProvider = {
    async *speak(text) {
      spies.ttsCalls.push(text);
      const frames = options?.ttsFramesPerSentence ?? 2;
      for (let f = 0; f < frames; f++) yield new Int16Array(480).fill(1234);
    },
  };
  const runClaude: ClaudeRunner = async (_input, emit) => {
    spies.claudeCalls += 1;
    // Emit the reply as a single delta — the loop must still chunk it
    // by sentence boundary before handing to TTS.
    emit(reply);
    return { content: reply, sessionId: `session-${spies.claudeCalls}` };
  };
  const deps: VoiceLoopDeps = {
    runClaude,
    stt,
    tts,
    sendAudio: (payload) => {
      spies.sentFrames.push(payload);
    },
    log: (line) => spies.logs.push(line),
  };
  return { deps, spies };
}

const FAST_OPTIONS: VoiceLoopOptions = {
  ...DEFAULT_VOICE_LOOP_OPTIONS,
  silenceHangoverFrames: 3,
  minUtteranceFrames: 2,
  // Tests inspect sent frames synchronously after one microtask flush;
  // a real 20 ms pacing wait would push every frame past the assertion.
  outboundFramePaceMs: 0,
};

async function flush(): Promise<void> {
  // Let microtasks drain so async STT/runClaude/TTS chains complete.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('createVoiceLoop', () => {
  test('runs STT, Claude, and TTS for one utterance after the silence hangover', async () => {
    const { deps, spies } = makeDeps('Hello there. Good to hear you.');
    const loop = createVoiceLoop(deps, FAST_OPTIONS);

    // 4 speech frames (over the 2-frame minimum) then 3 silence frames
    // (reaching the hangover threshold) — exactly one utterance.
    for (let i = 0; i < 4; i++) loop.onInboundFrame(speechFrame(FAST_OPTIONS.samplesPerFrame));
    for (let i = 0; i < 3; i++) loop.onInboundFrame(silenceFrame(FAST_OPTIONS.samplesPerFrame));

    await flush();

    expect(spies.sttCalls).toBe(1);
    expect(spies.claudeCalls).toBe(1);
    // Two sentences in the reply → two TTS calls.
    expect(spies.ttsCalls).toEqual(['Hello there.', 'Good to hear you.']);
    // Each TTS yielded 2 frames; outbound count is sentences * frames.
    expect(spies.sentFrames.length).toBe(4);
  });

  test('drops sub-threshold thumps without invoking STT', async () => {
    const { deps, spies } = makeDeps('ok');
    const loop = createVoiceLoop(deps, FAST_OPTIONS);
    // One speech frame is below the 2-frame minimum.
    loop.onInboundFrame(speechFrame(FAST_OPTIONS.samplesPerFrame));
    for (let i = 0; i < 5; i++) loop.onInboundFrame(silenceFrame(FAST_OPTIONS.samplesPerFrame));
    await flush();
    expect(spies.sttCalls).toBe(0);
    expect(spies.claudeCalls).toBe(0);
    expect(spies.ttsCalls).toEqual([]);
  });

  test('half-duplex: inbound frames during thinking are ignored', async () => {
    const { deps, spies } = makeDeps('Reply.', { ttsFramesPerSentence: 1 });
    const loop = createVoiceLoop(deps, FAST_OPTIONS);

    for (let i = 0; i < 3; i++) loop.onInboundFrame(speechFrame(FAST_OPTIONS.samplesPerFrame));
    for (let i = 0; i < 3; i++) loop.onInboundFrame(silenceFrame(FAST_OPTIONS.samplesPerFrame));
    // Immediately deliver another burst of "speech" before the async
    // pipeline has finished — it must be dropped.
    for (let i = 0; i < 4; i++) loop.onInboundFrame(speechFrame(FAST_OPTIONS.samplesPerFrame));
    for (let i = 0; i < 3; i++) loop.onInboundFrame(silenceFrame(FAST_OPTIONS.samplesPerFrame));

    await flush();

    expect(spies.sttCalls).toBe(1);
    expect(spies.claudeCalls).toBe(1);
  });

  test('close stops any further processing', async () => {
    const { deps, spies } = makeDeps('Hi.');
    const loop = createVoiceLoop(deps, FAST_OPTIONS);
    loop.close();
    for (let i = 0; i < 4; i++) loop.onInboundFrame(speechFrame(FAST_OPTIONS.samplesPerFrame));
    for (let i = 0; i < 3; i++) loop.onInboundFrame(silenceFrame(FAST_OPTIONS.samplesPerFrame));
    await flush();
    expect(spies.sttCalls).toBe(0);
    expect(spies.sentFrames.length).toBe(0);
  });

  test('an empty STT transcript skips Claude and returns to listening', async () => {
    const { deps, spies } = makeDeps('reply', { sttTranscript: '' });
    const loop = createVoiceLoop(deps, FAST_OPTIONS);
    for (let i = 0; i < 4; i++) loop.onInboundFrame(speechFrame(FAST_OPTIONS.samplesPerFrame));
    for (let i = 0; i < 3; i++) loop.onInboundFrame(silenceFrame(FAST_OPTIONS.samplesPerFrame));
    await flush();
    expect(spies.sttCalls).toBe(1);
    expect(spies.claudeCalls).toBe(0);
    expect(spies.ttsCalls).toEqual([]);
  });

  test('a reply without sentence punctuation still speaks the tail at end-of-stream', async () => {
    const { deps, spies } = makeDeps('no punctuation here');
    const loop = createVoiceLoop(deps, FAST_OPTIONS);
    for (let i = 0; i < 4; i++) loop.onInboundFrame(speechFrame(FAST_OPTIONS.samplesPerFrame));
    for (let i = 0; i < 3; i++) loop.onInboundFrame(silenceFrame(FAST_OPTIONS.samplesPerFrame));
    await flush();
    expect(spies.ttsCalls).toEqual(['no punctuation here']);
  });
});
