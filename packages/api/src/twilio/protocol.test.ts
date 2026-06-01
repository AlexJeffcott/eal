import { describe, expect, test } from 'bun:test';
import { parseTwilioEvent } from './protocol.ts';

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

describe('parseTwilioEvent — malformed input', () => {
  test('non-JSON returns null', () => {
    expect(parseTwilioEvent('not json')).toBeNull();
    expect(parseTwilioEvent('')).toBeNull();
  });

  test('JSON that is not an object returns null', () => {
    expect(parseTwilioEvent('null')).toBeNull();
    expect(parseTwilioEvent('"a string"')).toBeNull();
    expect(parseTwilioEvent('42')).toBeNull();
    expect(parseTwilioEvent('[]')).toBeNull();
  });

  test('object without an event tag returns null', () => {
    expect(parseTwilioEvent(asJson({ foo: 'bar' }))).toBeNull();
  });

  test('unknown event types return null', () => {
    expect(parseTwilioEvent(asJson({ event: 'dtmf', streamSid: 's' }))).toBeNull();
    expect(parseTwilioEvent(asJson({ event: 'unknown' }))).toBeNull();
  });
});

describe('parseTwilioEvent — connected', () => {
  test('parses with version', () => {
    expect(parseTwilioEvent(asJson({ event: 'connected', version: '1.0.0' }))).toEqual({
      type: 'connected',
      version: '1.0.0',
    });
  });

  test('missing version returns null', () => {
    expect(parseTwilioEvent(asJson({ event: 'connected' }))).toBeNull();
  });
});

describe('parseTwilioEvent — start', () => {
  const VALID_START = {
    event: 'start',
    start: {
      streamSid: 'MZ001',
      callSid: 'CA001',
      customParameters: { from: '+12025550100', to: '+441234567890', callSid: 'CA001' },
    },
  };

  test('parses with streamSid, callSid, and customParameters.from/to', () => {
    expect(parseTwilioEvent(asJson(VALID_START))).toEqual({
      type: 'start',
      streamSid: 'MZ001',
      callSid: 'CA001',
      from: '+12025550100',
      to: '+441234567890',
    });
  });

  test('accepts streamSid at the top level as a fallback', () => {
    const withTopLevel = {
      event: 'start',
      streamSid: 'MZ001',
      start: {
        callSid: 'CA001',
        customParameters: { from: '+1', to: '+2' },
      },
    };
    const parsed = parseTwilioEvent(asJson(withTopLevel));
    expect(parsed?.type).toBe('start');
    if (parsed?.type !== 'start') throw new Error('unreachable');
    expect(parsed.streamSid).toBe('MZ001');
  });

  test('missing customParameters returns null', () => {
    expect(
      parseTwilioEvent(
        asJson({ event: 'start', start: { streamSid: 'M', callSid: 'C' } }),
      ),
    ).toBeNull();
  });

  test('customParameters without from or to returns null', () => {
    expect(
      parseTwilioEvent(
        asJson({
          event: 'start',
          start: { streamSid: 'M', callSid: 'C', customParameters: { from: '+1' } },
        }),
      ),
    ).toBeNull();
    expect(
      parseTwilioEvent(
        asJson({
          event: 'start',
          start: { streamSid: 'M', callSid: 'C', customParameters: { to: '+2' } },
        }),
      ),
    ).toBeNull();
  });

  test('missing callSid returns null', () => {
    expect(
      parseTwilioEvent(
        asJson({
          event: 'start',
          start: { streamSid: 'M', customParameters: { from: '+1', to: '+2' } },
        }),
      ),
    ).toBeNull();
  });

  test('missing start block returns null', () => {
    expect(parseTwilioEvent(asJson({ event: 'start' }))).toBeNull();
  });
});

describe('parseTwilioEvent — media', () => {
  test('parses inbound payload', () => {
    const event = parseTwilioEvent(
      asJson({
        event: 'media',
        streamSid: 'M',
        media: { track: 'inbound', payload: 'base64-bytes', chunk: 1, timestamp: '100' },
      }),
    );
    expect(event).toEqual({
      type: 'media',
      streamSid: 'M',
      track: 'inbound',
      payload: 'base64-bytes',
    });
  });

  test('outbound-track media is rejected (returns null)', () => {
    expect(
      parseTwilioEvent(
        asJson({
          event: 'media',
          streamSid: 'M',
          media: { track: 'outbound', payload: 'x' },
        }),
      ),
    ).toBeNull();
  });

  test('missing payload returns null', () => {
    expect(
      parseTwilioEvent(
        asJson({
          event: 'media',
          streamSid: 'M',
          media: { track: 'inbound' },
        }),
      ),
    ).toBeNull();
  });

  test('missing streamSid returns null', () => {
    expect(
      parseTwilioEvent(
        asJson({ event: 'media', media: { track: 'inbound', payload: 'x' } }),
      ),
    ).toBeNull();
  });
});

describe('parseTwilioEvent — mark', () => {
  test('parses a named mark', () => {
    expect(
      parseTwilioEvent(asJson({ event: 'mark', streamSid: 'M', mark: { name: 'sent-prompt' } })),
    ).toEqual({ type: 'mark', streamSid: 'M', name: 'sent-prompt' });
  });

  test('missing mark.name returns null', () => {
    expect(
      parseTwilioEvent(asJson({ event: 'mark', streamSid: 'M', mark: {} })),
    ).toBeNull();
  });
});

describe('parseTwilioEvent — stop', () => {
  test('parses with streamSid', () => {
    expect(parseTwilioEvent(asJson({ event: 'stop', streamSid: 'M' }))).toEqual({
      type: 'stop',
      streamSid: 'M',
    });
  });

  test('missing streamSid returns null', () => {
    expect(parseTwilioEvent(asJson({ event: 'stop' }))).toBeNull();
  });
});
