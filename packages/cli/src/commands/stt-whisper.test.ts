import { describe, expect, test } from 'bun:test';
import { cleanWhisperOutput } from './stt-whisper.ts';

describe('cleanWhisperOutput', () => {
  test('trims whitespace and CRs', () => {
    expect(cleanWhisperOutput('  hello world  \r\n')).toBe('hello world');
  });

  test('strips bracketed annotations like [BLANK_AUDIO]', () => {
    expect(cleanWhisperOutput('[BLANK_AUDIO]')).toBe('');
    expect(cleanWhisperOutput('what [Music] time is it')).toBe('what  time is it');
  });

  test('preserves an utterance that has no annotations', () => {
    expect(cleanWhisperOutput('hello there')).toBe('hello there');
  });
});
