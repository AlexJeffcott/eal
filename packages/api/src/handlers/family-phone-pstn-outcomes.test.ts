import { describe, expect, test } from 'bun:test';
import { createPstnCallOutcomes } from './family-phone-pstn-outcomes.ts';

describe('createPstnCallOutcomes', () => {
  test('prime then setOutcome then get round-trips the record; drop removes it', () => {
    const o = createPstnCallOutcomes();
    o.prime('CA1', { kind: 'household', householdDeviceId: 7 }, '+12025550100');
    o.setOutcome('CA1', 'answered');
    const r = o.get('CA1');
    expect(r?.outcome).toBe('answered');
    expect(r?.fromE164).toBe('+12025550100');
    expect(r?.voicemailTarget.kind).toBe('household');
    o.drop('CA1');
    expect(o.get('CA1')).toBeNull();
  });

  test('setOutcome on an unknown CallSid is a no-op (no priming, no record)', () => {
    const o = createPstnCallOutcomes();
    o.setOutcome('CA-orphan', 'unanswered');
    expect(o.get('CA-orphan')).toBeNull();
  });

  test('prune drops entries older than the TTL', () => {
    let nowVal = 1_000;
    const o = createPstnCallOutcomes({ ttlMs: 100, now: () => nowVal });
    o.prime('CA-old', { kind: 'household', householdDeviceId: 1 }, '+1');
    nowVal = 2_000;
    // The next prime triggers prune; the old record is past its TTL.
    o.prime('CA-new', { kind: 'household', householdDeviceId: 1 }, '+1');
    expect(o.get('CA-old')).toBeNull();
    expect(o.get('CA-new')).not.toBeNull();
  });
});
