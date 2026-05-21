import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readStringFlag, splitArgs } from './split-args.ts';

describe('splitArgs', () => {
  let prevApi: string | undefined;
  let prevTok: string | undefined;

  beforeEach(() => {
    prevApi = process.env['EAL_API_URL'];
    prevTok = process.env['EAL_TOKEN_PATH'];
    delete process.env['EAL_API_URL'];
    delete process.env['EAL_TOKEN_PATH'];
  });

  afterEach(() => {
    if (prevApi === undefined) delete process.env['EAL_API_URL'];
    else process.env['EAL_API_URL'] = prevApi;
    if (prevTok === undefined) delete process.env['EAL_TOKEN_PATH'];
    else process.env['EAL_TOKEN_PATH'] = prevTok;
  });

  test('empty argv yields no command and default api url', () => {
    const r = splitArgs([]);
    expect(r.command).toBeUndefined();
    expect(r.global.apiUrl).toBe('https://127.0.0.1:3000');
    expect(r.global.commandArgs).toEqual([]);
  });

  test('extracts the command and forwards subcommand args verbatim', () => {
    const r = splitArgs(['hello', '--name', 'world']);
    expect(r.command).toBe('hello');
    expect(r.global.commandArgs).toEqual(['--name', 'world']);
  });

  test('strips global --api-url <url> before identifying the command', () => {
    const r = splitArgs(['--api-url', 'https://example.test:9000', 'hello', '--name', 'world']);
    expect(r.command).toBe('hello');
    expect(r.global.apiUrl).toBe('https://example.test:9000');
    expect(r.global.commandArgs).toEqual(['--name', 'world']);
  });

  test('strips global --api-url=<url> equals form too', () => {
    const r = splitArgs(['--api-url=https://x.test', 'hello']);
    expect(r.global.apiUrl).toBe('https://x.test');
  });

  test('strips boolean globals from commandArgs', () => {
    const r = splitArgs(['--json', '-v', 'auth', 'status']);
    expect(r.global.json).toBe(true);
    expect(r.global.verbose).toBe(true);
    expect(r.command).toBe('auth');
    expect(r.global.commandArgs).toEqual(['status']);
  });

  test('passes subcommand-level flags through untouched', () => {
    const r = splitArgs(['auth', 'login', '--token', 'eal_v1_x']);
    expect(r.command).toBe('auth');
    expect(r.global.commandArgs).toEqual(['login', '--token', 'eal_v1_x']);
  });

  test('env vars provide defaults', () => {
    process.env['EAL_API_URL'] = 'https://env.test:1234';
    process.env['EAL_TOKEN_PATH'] = '/tmp/eal-test-token';
    const r = splitArgs(['hello']);
    expect(r.global.apiUrl).toBe('https://env.test:1234');
    expect(r.global.tokenPathOverride).toBe('/tmp/eal-test-token');
  });

  test('explicit --api-url wins over env', () => {
    process.env['EAL_API_URL'] = 'https://env.test:1234';
    const r = splitArgs(['--api-url', 'https://flag.test', 'hello']);
    expect(r.global.apiUrl).toBe('https://flag.test');
  });

  test('--help with no command flags the help intent', () => {
    const r = splitArgs(['--help']);
    expect(r.command).toBeUndefined();
    expect(r.global.help).toBe(true);
  });
});

describe('readStringFlag', () => {
  test('reads --name <value>', () => {
    expect(readStringFlag(['--name', 'alex'], 'name')).toBe('alex');
  });
  test('reads --name=<value>', () => {
    expect(readStringFlag(['--name=alex'], 'name')).toBe('alex');
  });
  test('returns undefined when absent', () => {
    expect(readStringFlag(['other'], 'name')).toBeUndefined();
  });
  test('does not consume a following flag as the value', () => {
    expect(readStringFlag(['--name', '--other'], 'name')).toBeUndefined();
  });
});
