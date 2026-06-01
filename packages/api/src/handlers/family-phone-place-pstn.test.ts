import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import {
  createFamilyPhoneDevicesRepo,
  type FamilyPhoneDevicesRepo,
} from '../db/repos/family-phone-devices.ts';
import { placePstn, type PlacePstnDeps } from './family-phone-place-pstn.ts';
import { TwilioRestError, type TwilioRestClient } from '../twilio/rest.ts';

function makeRestClient(
  impl: (input: { to: string; twimlUrl: string }) => Promise<{ callSid: string; status: string }>,
): TwilioRestClient {
  return {
    placeOutboundCall: impl,
  };
}

const TWIML_BASE = 'https://eal.example.com/api/family-phone/twilio/voice';

describe('placePstn', () => {
  let db: DatabaseClient;
  let devices: FamilyPhoneDevicesRepo;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    db.prepare("INSERT INTO users (display_name) VALUES ('alex')").run();
    devices = createFamilyPhoneDevicesRepo(db);
    devices.insert({ userId: 1, label: 'phone', kind: 'handset' });
  });

  test('happy path: upserts the PSTN device, calls Twilio, returns the CallSid', async () => {
    let capturedTwimlUrl: string | null = null;
    const deps: PlacePstnDeps = {
      restClient: makeRestClient(async (input) => {
        capturedTwimlUrl = input.twimlUrl;
        return { callSid: 'CAabc', status: 'queued' };
      }),
      devices,
      twimlBaseUrl: TWIML_BASE,
    };
    const result = await placePstn(deps, { fromDeviceId: 1, to: '+12025550100' });
    expect(result).toEqual({ ok: true, callSid: 'CAabc' });

    const url = new URL(capturedTwimlUrl ?? '');
    expect(url.searchParams.get('direction')).toBe('outbound');
    expect(url.searchParams.get('handset')).toBe('1');

    const pstn = db
      .prepare<{ count: number }, []>(
        "SELECT count(*) AS count FROM family_phone_devices WHERE kind='pstn'",
      )
      .get();
    expect(pstn?.count).toBe(1);
  });

  test('rejects a malformed E.164 with reason="bad-e164" and never calls Twilio', async () => {
    let called = false;
    const deps: PlacePstnDeps = {
      restClient: makeRestClient(async () => {
        called = true;
        return { callSid: 'CAabc', status: 'queued' };
      }),
      devices,
      twimlBaseUrl: TWIML_BASE,
    };
    for (const bad of ['12025550100', '+0123', '+', 'phone', '+12025 5550100']) {
      const result = await placePstn(deps, { fromDeviceId: 1, to: bad });
      expect(result).toEqual({ ok: false, reason: 'bad-e164' });
    }
    expect(called).toBe(false);
  });

  test('isOutboundAllowed=false short-circuits to reason="not-allowed"', async () => {
    let called = false;
    const deps: PlacePstnDeps = {
      restClient: makeRestClient(async () => {
        called = true;
        return { callSid: 'CAabc', status: 'queued' };
      }),
      devices,
      twimlBaseUrl: TWIML_BASE,
      isOutboundAllowed: () => false,
    };
    const result = await placePstn(deps, { fromDeviceId: 1, to: '+12025550100' });
    expect(result).toEqual({ ok: false, reason: 'not-allowed' });
    expect(called).toBe(false);
  });

  test('Twilio 4xx maps to reason="twilio-rejected"', async () => {
    const deps: PlacePstnDeps = {
      restClient: makeRestClient(async () => {
        throw new TwilioRestError('bad number', 400, 21217);
      }),
      devices,
      twimlBaseUrl: TWIML_BASE,
    };
    const result = await placePstn(deps, { fromDeviceId: 1, to: '+12025550100' });
    expect(result).toEqual({ ok: false, reason: 'twilio-rejected' });
  });

  test('Twilio 5xx maps to reason="twilio-unreachable"', async () => {
    const deps: PlacePstnDeps = {
      restClient: makeRestClient(async () => {
        throw new TwilioRestError('Twilio down', 503);
      }),
      devices,
      twimlBaseUrl: TWIML_BASE,
    };
    const result = await placePstn(deps, { fromDeviceId: 1, to: '+12025550100' });
    expect(result).toEqual({ ok: false, reason: 'twilio-unreachable' });
  });

  test('non-HTTP transport error also maps to reason="twilio-unreachable"', async () => {
    const deps: PlacePstnDeps = {
      restClient: makeRestClient(async () => {
        throw new TypeError('fetch failed: ENOTFOUND');
      }),
      devices,
      twimlBaseUrl: TWIML_BASE,
    };
    const result = await placePstn(deps, { fromDeviceId: 1, to: '+12025550100' });
    expect(result).toEqual({ ok: false, reason: 'twilio-unreachable' });
  });

  test('the same E.164 upserted twice keeps a single PSTN row', async () => {
    const deps: PlacePstnDeps = {
      restClient: makeRestClient(async () => ({ callSid: 'CAabc', status: 'queued' })),
      devices,
      twimlBaseUrl: TWIML_BASE,
    };
    await placePstn(deps, { fromDeviceId: 1, to: '+12025550100' });
    await placePstn(deps, { fromDeviceId: 1, to: '+12025550100' });
    const pstn = db
      .prepare<{ count: number }, []>(
        "SELECT count(*) AS count FROM family_phone_devices WHERE kind='pstn'",
      )
      .get();
    expect(pstn?.count).toBe(1);
  });
});
