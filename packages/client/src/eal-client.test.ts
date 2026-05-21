import { describe, expect, test } from 'bun:test';
import { extractServerError } from './eal-client.ts';

/**
 * Pure-function coverage for the http error-envelope unwrap. The web UI's
 * friendly mapping depends on this function returning the SERVER message
 * (e.g. "webauthn: credential not found") rather than the wrapping JSON.
 * If this contract drifts, the friendly mappers in actions/registry.ts
 * will silently stop matching.
 */
describe('extractServerError', () => {
  describe('happy path: { "error": "..." } envelope', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['{"error":"oh no"}', 'oh no'],
      ['{"error":"webauthn: credential not found"}', 'webauthn: credential not found'],
      // Extra fields must not poison the unwrap.
      ['{"error":"x","code":500,"path":"/y"}', 'x'],
      // Whitespace inside the JSON is fine.
      ['{ "error" : "spaced" }', 'spaced'],
      // The inner string is returned verbatim — no trimming, no JSON re-escape.
      ['{"error":"  padded  "}', '  padded  '],
      ['{"error":""}', ''],
    ];
    for (const [body, expected] of cases) {
      test(`${JSON.stringify(body)} → ${JSON.stringify(expected)}`, () => {
        expect(extractServerError(body)).toBe(expected);
      });
    }
  });

  describe('fallback: returns raw body when not a recognised envelope', () => {
    const cases: ReadonlyArray<[label: string, body: string]> = [
      ['no `error` key', '{"code":500}'],
      ['`error` is a number', '{"error":42}'],
      ['`error` is null', '{"error":null}'],
      ['`error` is a boolean', '{"error":true}'],
      ['`error` is an object', '{"error":{"nested":"x"}}'],
      ['`error` is an array', '{"error":["x"]}'],
      ['top-level null', 'null'],
      ['top-level string', '"just a string"'],
      ['top-level number', '42'],
      ['top-level array', '["error","x"]'],
      ['invalid JSON', 'not json {'],
      ['empty body', ''],
      ['whitespace only', '   '],
      ['html error page', '<html><body>500</body></html>'],
    ];
    for (const [label, body] of cases) {
      test(`${label}: returns the raw body unchanged`, () => {
        expect(extractServerError(body)).toBe(body);
      });
    }
  });

  test('multi-line server error is preserved verbatim', () => {
    const body = '{"error":"line one\\nline two"}';
    expect(extractServerError(body)).toBe('line one\nline two');
  });

  test('unicode in the server error round-trips', () => {
    const body = '{"error":"ünïcødé ✓ 中文"}';
    expect(extractServerError(body)).toBe('ünïcødé ✓ 中文');
  });
});
