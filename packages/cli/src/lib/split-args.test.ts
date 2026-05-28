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

  test('-h aliases --help', () => {
    const r = splitArgs(['-h']);
    expect(r.global.help).toBe(true);
  });

  test('--verbose flag is recognised in its long form too', () => {
    const r = splitArgs(['--verbose']);
    expect(r.global.verbose).toBe(true);
  });

  test('strips global --token-path <path> before the command', () => {
    const r = splitArgs(['--token-path', '/tmp/elsewhere', 'hello']);
    expect(r.command).toBe('hello');
    expect(r.global.tokenPathOverride).toBe('/tmp/elsewhere');
  });

  test('strips global --token-path=<path> equals form too', () => {
    const r = splitArgs(['--token-path=/tmp/equals', 'hello']);
    expect(r.global.tokenPathOverride).toBe('/tmp/equals');
  });

  test('explicit --token-path wins over EAL_TOKEN_PATH env', () => {
    process.env['EAL_TOKEN_PATH'] = '/env/path';
    const r = splitArgs(['--token-path', '/flag/path', 'hello']);
    expect(r.global.tokenPathOverride).toBe('/flag/path');
  });

  test('falls back to default api url when EAL_API_URL is an empty string', () => {
    process.env['EAL_API_URL'] = '';
    const r = splitArgs([]);
    expect(r.global.apiUrl).toBe('https://127.0.0.1:3000');
  });

  test('tokenPathOverride is undefined when EAL_TOKEN_PATH is an empty string', () => {
    process.env['EAL_TOKEN_PATH'] = '';
    const r = splitArgs([]);
    expect(r.global.tokenPathOverride).toBeUndefined();
  });

  test('--api-url with no following value leaves apiUrl at the env/default', () => {
    const r = splitArgs(['--api-url']);
    expect(r.global.apiUrl).toBe('https://127.0.0.1:3000');
  });

  test('--api-url <value> consumes the next token so it is not treated as a command', () => {
    const r = splitArgs(['--api-url', 'https://example.test:9000']);
    expect(r.command).toBeUndefined();
    expect(r.global.commandArgs).toEqual([]);
  });

  test('a sparse argv slot (undefined element) is skipped', () => {
    // Sparse array — index 1 has no value, mirroring how some argv plumbing
    // surfaces a missing positional. The function's `if (a === undefined)`
    // continue is the guard under test.
    const argv: string[] = [];
    argv[0] = 'hello';
    argv[2] = '--flag';
    const r = splitArgs(argv);
    expect(r.command).toBe('hello');
    expect(r.global.commandArgs).toEqual(['--flag']);
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
