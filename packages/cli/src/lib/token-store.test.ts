import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteToken, readToken, tokenPath, writeToken } from './token-store.ts';

describe('token-store', () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eal-token-'));
    prevEnv = process.env['EAL_TOKEN_PATH'];
    process.env['EAL_TOKEN_PATH'] = join(dir, 'token');
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env['EAL_TOKEN_PATH'];
    else process.env['EAL_TOKEN_PATH'] = prevEnv;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test('tokenPath honours EAL_TOKEN_PATH', () => {
    expect(tokenPath()).toBe(join(dir, 'token'));
  });

  test('readToken returns null when the file does not exist', () => {
    expect(readToken()).toBeNull();
  });

  test('writeToken creates the file with mode 0600 (POSIX)', () => {
    writeToken('eal_v1_secret');
    expect(existsSync(tokenPath())).toBe(true);
    const stat = statSync(tokenPath());
    // POSIX permission bits are the lower 9 bits of st_mode.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('writeToken creates the parent directory recursively', () => {
    const nestedPath = join(dir, 'a', 'b', 'c', 'token');
    process.env['EAL_TOKEN_PATH'] = nestedPath;
    writeToken('eal_v1_nested');
    expect(existsSync(nestedPath)).toBe(true);
  });

  test('readToken round-trips the written value, trimming surrounding whitespace', () => {
    writeToken('eal_v1_roundtrip');
    expect(readToken()).toBe('eal_v1_roundtrip');
  });

  test('readToken returns null for an empty file', () => {
    writeToken('');
    expect(readToken()).toBeNull();
  });

  test('deleteToken removes an existing file and returns true', () => {
    writeToken('eal_v1_doomed');
    expect(deleteToken()).toBe(true);
    expect(existsSync(tokenPath())).toBe(false);
  });

  test('deleteToken returns false when the file is already absent', () => {
    expect(deleteToken()).toBe(false);
  });

  test('tokenPath falls back to ~/.config/eal/token when env is unset', () => {
    delete process.env['EAL_TOKEN_PATH'];
    const fallback = tokenPath();
    expect(fallback.endsWith('.config/eal/token')).toBe(true);
  });

  test('tokenPath also falls back when env is empty string', () => {
    process.env['EAL_TOKEN_PATH'] = '';
    const fallback = tokenPath();
    expect(fallback.endsWith('.config/eal/token')).toBe(true);
  });
});
