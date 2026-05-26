import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWavPcm16 } from '../lib/wav.ts';
import type { SttProvider } from './voice-providers.ts';

/**
 * Local Whisper STT via the `whisper-cli` binary from whisper.cpp.
 *
 * The path the operator points us at is treated as opaque — we hand it
 * the model and a one-shot WAV, then read the transcript off stdout.
 * The temp WAV is deleted on success and on error.
 */

export interface WhisperLocalOptions {
  binPath: string;
  modelPath: string;
  /** Override extra args (e.g. ['--language', 'en']) the operator wants to pin. */
  extraArgs?: readonly string[];
  /** Cap per-run runtime. Defaults to 30 s — long enough for a 10 s clip on a Pi. */
  timeoutMs?: number;
}

const DEFAULT_WHISPER_TIMEOUT_MS = 30_000;

export function createWhisperLocalStt(opts: WhisperLocalOptions): SttProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WHISPER_TIMEOUT_MS;
  return {
    async transcribe(pcm, sampleRate) {
      if (pcm.length === 0) return '';
      const wav = encodeWavPcm16(pcm, sampleRate);
      const dir = mkdtempSync(join(tmpdir(), 'eal-whisper-'));
      const wavPath = join(dir, 'in.wav');
      writeFileSync(wavPath, wav);
      try {
        const args = [
          '-m',
          opts.modelPath,
          '-f',
          wavPath,
          '-nt',
          '-np',
          ...(opts.extraArgs ?? []),
        ];
        const text = await runAndCapture(opts.binPath, args, timeoutMs);
        return cleanWhisperOutput(text);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface WhisperHostedOptions {
  apiKey: string;
  /** Defaults to 'whisper-1', the only generally-available transcription model today. */
  model?: string;
  /** Override the API endpoint (for self-hosted Whisper compatibles). */
  endpoint?: string;
  timeoutMs?: number;
}

const DEFAULT_HOSTED_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_HOSTED_MODEL = 'whisper-1';

export function createWhisperHostedStt(opts: WhisperHostedOptions): SttProvider {
  const endpoint = opts.endpoint ?? DEFAULT_HOSTED_ENDPOINT;
  const model = opts.model ?? DEFAULT_HOSTED_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WHISPER_TIMEOUT_MS;
  return {
    async transcribe(pcm, sampleRate) {
      if (pcm.length === 0) return '';
      const wav = encodeWavPcm16(pcm, sampleRate);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', model);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}` },
          body: form,
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`whisper hosted ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }
        const parsed = await res.json();
        if (typeof parsed !== 'object' || parsed === null || !('text' in parsed)) return '';
        const text = parsed.text;
        return typeof text === 'string' ? text.trim() : '';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function runAndCapture(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
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
      resolve(stdout);
    });
  });
}

/**
 * whisper.cpp with `-nt -np` still emits a leading line of model
 * metadata in some builds, and trailing newlines. Trim to the actual
 * spoken text.
 */
export function cleanWhisperOutput(raw: string): string {
  const collapsed = raw.replace(/\r/g, '').trim();
  // Drop bracketed annotations like "[BLANK_AUDIO]" or "[Music]" that
  // whisper produces when there is no clear speech.
  const stripped = collapsed.replace(/\[[^\]]+\]/g, '').trim();
  return stripped;
}
