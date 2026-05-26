/**
 * Family-phone audio capture and playback.
 *
 * Microphone audio is captured at 24 kHz mono via the WebAudio graph, framed
 * into 20 ms blocks (480 samples), quantised to signed 16-bit PCM, and
 * delivered to a callback. The reverse direction takes 16-bit PCM frames
 * and queues them for playback through a worklet-backed ring buffer.
 *
 * Both legs use an AudioWorkletProcessor delivered as an inline Blob URL so
 * the worklet code bundles with main.tsx — no separate static file, no
 * fragile bundler rule. The processor is small and identical-shaped on each
 * side (a ring buffer with input → port or port → output).
 *
 * Codec: raw PCM. Adequate for a family-scale loopback test; Opus
 * compression slots in as a transformation between this module's PCM frames
 * and the bytes that travel over the wire, and is left for a follow-up
 * where a live browser session can verify the encoder/decoder timing.
 */
import { AudioContext } from '../../platform/audio-context.ts';
import { AudioWorkletNode } from '../../platform/audio-worklet-node.ts';
import { mediaDevices } from '../../platform/media-devices.ts';

const SAMPLE_RATE = 24_000;
const FRAME_SAMPLES = 480; // 20 ms at 24 kHz

const CAPTURE_WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(${FRAME_SAMPLES});
    this._cursor = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const take = Math.min(channel.length - i, ${FRAME_SAMPLES} - this._cursor);
      this._buf.set(channel.subarray(i, i + take), this._cursor);
      this._cursor += take;
      i += take;
      if (this._cursor === ${FRAME_SAMPLES}) {
        this.port.postMessage(this._buf.slice(), [this._buf.buffer]);
        this._buf = new Float32Array(${FRAME_SAMPLES});
        this._cursor = 0;
      }
    }
    return true;
  }
}
registerProcessor('family-phone-capture', CaptureProcessor);
`;

const PLAYBACK_WORKLET_SRC = `
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._current = null;
    this._cursor = 0;
    this.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) {
        this._queue.push(e.data);
        if (this._queue.length > 50) this._queue.shift();
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    let i = 0;
    while (i < out.length) {
      if (!this._current) {
        this._current = this._queue.shift() ?? null;
        this._cursor = 0;
        if (!this._current) {
          out.fill(0, i);
          return true;
        }
      }
      const take = Math.min(out.length - i, this._current.length - this._cursor);
      out.set(this._current.subarray(this._cursor, this._cursor + take), i);
      i += take;
      this._cursor += take;
      if (this._cursor >= this._current.length) {
        this._current = null;
      }
    }
    return true;
  }
}
registerProcessor('family-phone-playback', PlaybackProcessor);
`;

function workletUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
}

function pcm16FromFloat32(pcm: Float32Array): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(pcm.length * 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}

function float32FromPcm16(bytes: Uint8Array): Float32Array {
  // Copy into a fresh ArrayBuffer so the DataView is well-aligned even when
  // the source view is offset into a larger frame (which it always is —
  // the connection strips the 17-byte header before handing us bytes).
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const view = new DataView(buf);
  const samples = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true);
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}

export interface AudioCapture {
  stop(): Promise<void>;
}

/**
 * Begin capturing microphone audio. The callback receives PCM bytes
 * (mono signed 16-bit little-endian at 24 kHz, 480 samples per frame)
 * roughly every 20 ms. Throws if the user denies microphone permission.
 */
export async function startAudioCapture(
  onFrame: (payload: Uint8Array) => void,
): Promise<AudioCapture> {
  if (mediaDevices === null) throw new Error('mediaDevices unavailable on this platform');
  if (AudioContext === null) throw new Error('AudioContext unavailable on this platform');
  if (AudioWorkletNode === null) throw new Error('AudioWorkletNode unavailable on this platform');
  const stream = await mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const url = workletUrl(CAPTURE_WORKLET_SRC);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, 'family-phone-capture');
  worklet.port.onmessage = (e: MessageEvent) => {
    if (e.data instanceof Float32Array) {
      onFrame(pcm16FromFloat32(e.data));
    }
  };
  source.connect(worklet);
  // Connect to destination via a zero-gain node so the worklet's process()
  // is actually called; without a path to destination the graph may idle.
  const gain = ctx.createGain();
  gain.gain.value = 0;
  worklet.connect(gain).connect(ctx.destination);

  return {
    async stop() {
      worklet.port.onmessage = null;
      worklet.disconnect();
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      await ctx.close();
    },
  };
}

export interface AudioPlayback {
  /** Push a PCM frame (signed 16-bit LE mono at 24 kHz) for playback. */
  push(payload: Uint8Array): void;
  stop(): Promise<void>;
}

/** Start a playback pipeline whose `push` feeds frames into the speaker. */
export async function startAudioPlayback(): Promise<AudioPlayback> {
  if (AudioContext === null) throw new Error('AudioContext unavailable on this platform');
  if (AudioWorkletNode === null) throw new Error('AudioWorkletNode unavailable on this platform');
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const url = workletUrl(PLAYBACK_WORKLET_SRC);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const worklet = new AudioWorkletNode(ctx, 'family-phone-playback');
  worklet.connect(ctx.destination);

  return {
    push(payload) {
      const samples = float32FromPcm16(payload);
      worklet.port.postMessage(samples, [samples.buffer]);
    },
    async stop() {
      worklet.disconnect();
      await ctx.close();
    },
  };
}
