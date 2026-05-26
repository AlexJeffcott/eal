/**
 * Minimal WAV (RIFF/PCM) reader/writer for the voice loop.
 *
 * The local STT path needs to hand whisper.cpp a file on disk, and the
 * macOS `say` TTS path writes its output as a WAV. Neither requires a
 * full WAVE parser — only canonical 16-bit PCM mono is in scope, and
 * malformed inputs are rejected rather than coerced.
 */

const RIFF = 0x52494646; // 'RIFF'
const WAVE = 0x57415645; // 'WAVE'
const FMT_ = 0x666d7420; // 'fmt '
const DATA = 0x64617461; // 'data'

export interface WavPcm16 {
  samples: Int16Array;
  sampleRate: number;
}

/** Encode a single-channel PCM-16 sample buffer as a 44-byte-header WAV. */
export function encodeWavPcm16(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(new ArrayBuffer(44 + dataBytes));
  const view = new DataView(out.buffer);

  view.setUint32(0, RIFF, false);              // ChunkID
  view.setUint32(4, 36 + dataBytes, true);     // ChunkSize
  view.setUint32(8, WAVE, false);              // Format
  view.setUint32(12, FMT_, false);             // Subchunk1ID
  view.setUint32(16, 16, true);                // Subchunk1Size (PCM)
  view.setUint16(20, 1, true);                 // AudioFormat = PCM
  view.setUint16(22, 1, true);                 // NumChannels = 1
  view.setUint32(24, sampleRate, true);        // SampleRate
  view.setUint32(28, sampleRate * 2, true);    // ByteRate
  view.setUint16(32, 2, true);                 // BlockAlign
  view.setUint16(34, 16, true);                // BitsPerSample
  view.setUint32(36, DATA, false);             // Subchunk2ID
  view.setUint32(40, dataBytes, true);         // Subchunk2Size

  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  return out;
}

/**
 * Decode a canonical 16-bit mono PCM WAV. Returns null on any
 * structural surprise (multi-channel, non-PCM, missing chunks) — the
 * caller should not silently coerce a WAV we did not expect.
 */
export function decodeWavPcm16(bytes: Uint8Array): WavPcm16 | null {
  if (bytes.byteLength < 44) return null;
  const aligned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  aligned.set(bytes);
  const view = new DataView(aligned.buffer);

  if (view.getUint32(0, false) !== RIFF) return null;
  if (view.getUint32(8, false) !== WAVE) return null;

  // Walk chunks looking for fmt and data — some encoders insert LIST
  // chunks between them.
  let cursor = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: { offset: number; length: number } | null = null;
  while (cursor + 8 <= aligned.byteLength) {
    const id = view.getUint32(cursor, false);
    const size = view.getUint32(cursor + 4, true);
    const next = cursor + 8 + size + (size % 2);
    if (id === FMT_) {
      if (size < 16) return null;
      format = {
        audioFormat: view.getUint16(cursor + 8, true),
        channels: view.getUint16(cursor + 10, true),
        sampleRate: view.getUint32(cursor + 12, true),
        bitsPerSample: view.getUint16(cursor + 22, true),
      };
    } else if (id === DATA) {
      data = { offset: cursor + 8, length: size };
    }
    if (format !== null && data !== null) break;
    cursor = next;
  }

  if (format === null || data === null) return null;
  if (format.audioFormat !== 1) return null;
  if (format.channels !== 1) return null;
  if (format.bitsPerSample !== 16) return null;
  if (data.offset + data.length > aligned.byteLength) return null;

  const sampleCount = Math.floor(data.length / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = view.getInt16(data.offset + i * 2, true);
  return { samples, sampleRate: format.sampleRate };
}
