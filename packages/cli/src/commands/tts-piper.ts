import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkInt16, resampleInt16 } from '../lib/audio-resample.ts';
import { decodeWavPcm16 } from '../lib/wav.ts';
import type { TtsProvider } from './voice-providers.ts';

/**
 * Piper TTS via the `piper` binary. The model file is provided by the
 * operator (`EAL_PIPER_MODEL`); Piper voices ship at a fixed sample
 * rate (often 22 050 Hz) which is resampled to the 24 kHz wire format
 * before chunking into 20 ms frames.
 */

const WIRE_SAMPLE_RATE = 24_000;
const SAMPLES_PER_FRAME = 480; // 20 ms at 24 kHz
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PIPER_RATE = 22_050;

export interface PiperOptions {
  binPath: string;
  modelPath: string;
  /** Piper voice sample rate; check the model card. Defaults to 22050. */
  modelSampleRate?: number;
  timeoutMs?: number;
}

export function createPiperTts(opts: PiperOptions): TtsProvider {
  const modelRate = opts.modelSampleRate ?? DEFAULT_PIPER_RATE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    speak(text) {
      return runPiper(opts.binPath, opts.modelPath, text, modelRate, timeoutMs);
    },
  };
}

async function* runPiper(
  bin: string,
  modelPath: string,
  text: string,
  modelRate: number,
  timeoutMs: number,
): AsyncIterable<Int16Array> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  // Piper's `--output-raw` mode streams raw 16-bit PCM at the model
  // sample rate; ideal in principle, but parsing partial frames adds
  // complexity. The simpler path writes one WAV per utterance and
  // streams it back from disk — keeps unit testing of the helper code
  // possible and matches what `say` does on macOS.
  const dir = mkdtempSync(join(tmpdir(), 'eal-piper-'));
  const outPath = join(dir, 'out.wav');
  try {
    await runWithStdin(bin, ['--model', modelPath, '--output_file', outPath], trimmed, timeoutMs);
    const wavBytes = readFileSync(outPath);
    const decoded = decodeWavPcm16(new Uint8Array(wavBytes));
    if (decoded === null) throw new Error('piper produced an unexpected WAV format');
    const resampled = decoded.sampleRate === WIRE_SAMPLE_RATE
      ? decoded.samples
      : resampleInt16(decoded.samples, decoded.sampleRate, WIRE_SAMPLE_RATE);
    for (const frame of chunkInt16(resampled, SAMPLES_PER_FRAME)) yield frame;
    // Quiet the unused-modelRate-when-decoded-matches lint by referring
    // to it once: if the decoded rate disagrees with what the operator
    // declared, we trust the WAV header (it cannot lie about itself).
    void modelRate;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * macOS TTS via the `say` binary. Useful for dev on a laptop without
 * piper installed. `say` writes a WAV to the output path; we read it
 * back the same way piper's output is consumed.
 */
export function createSayTts(): TtsProvider {
  return {
    speak(text) {
      return runSay(text);
    },
  };
}

async function* runSay(text: string): AsyncIterable<Int16Array> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'eal-say-'));
  const outPath = join(dir, 'out.wav');
  try {
    await runWithStdin(
      'say',
      ['-o', outPath, '--data-format=LEI16@24000', '--file-format=WAVE', trimmed],
      '',
      DEFAULT_TIMEOUT_MS,
    );
    const wavBytes = readFileSync(outPath);
    const decoded = decodeWavPcm16(new Uint8Array(wavBytes));
    if (decoded === null) throw new Error('say produced an unexpected WAV format');
    // `say` was asked for 24 kHz directly, but resample defensively
    // anyway — a future macOS release might quietly ignore the flag.
    const samples = decoded.sampleRate === WIRE_SAMPLE_RATE
      ? decoded.samples
      : resampleInt16(decoded.samples, decoded.sampleRate, WIRE_SAMPLE_RATE);
    for (const frame of chunkInt16(samples, SAMPLES_PER_FRAME)) yield frame;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWithStdin(
  bin: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not run ${bin}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 300);
        reject(new Error(`${bin} exited ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolve();
    });
    if (stdin.length > 0) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
