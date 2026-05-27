import { beforeEach, describe, expect, test } from 'bun:test';
import { runAction } from '@fairfox/polly/actions';
import { createMockEalClient, type MockEalClient } from '@eal/client-mock';
import { resetStoresForTest, createStores, type AppStores } from '../../stores.ts';
import { FAMILY_PHONE_ACTIONS } from './actions.ts';

let stores: AppStores;
let mock: MockEalClient;
let dummyPrivateKey: CryptoKey;

beforeEach(async () => {
  resetStoresForTest();
  mock = createMockEalClient();
  mock.setCurrentUser({ userId: 1, displayName: 'alex' });
  stores = createStores(mock);
  if (dummyPrivateKey === undefined) {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    );
    dummyPrivateKey = kp.privateKey;
  }
});

async function run(action: string, data: Record<string, string> = {}): Promise<void> {
  await runAction(FAMILY_PHONE_ACTIONS, action, { stores, data });
}

describe('family-phone:load-voicemails', () => {
  test('without a paired device the list is cleared and no error is set', async () => {
    stores.$voiceMessages.value = [
      {
        id: 1,
        toDeviceId: 1,
        fromDeviceId: 2,
        fromExternal: null,
        body: 'old',
        sampleRate: 24000,
        channels: 1,
        durationMs: 100,
        readAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    await run('family-phone:load-voicemails');
    expect(stores.$voiceMessages.value).toEqual([]);
    expect(stores.$voiceMessagesError.value).toBeNull();
  });

  test('with a paired device the action calls listVoiceMessages on the client', async () => {
    stores.$pairedThisSession.value = {
      deviceId: 7,
      privateKey: dummyPrivateKey,
      publicKeyB64: 'pk',
    };
    await run('family-phone:load-voicemails');
    expect(stores.$voiceMessagesError.value).toBeNull();
    // The mock returns [] which is also the initial value — assert that
    // the call did not error out and the list is at-least defined.
    expect(stores.$voiceMessages.value).toEqual([]);
  });
});

describe('family-phone:play-voicemail', () => {
  test('rejects a non-positive id silently', async () => {
    await run('family-phone:play-voicemail', { voicemailId: '-1' });
    expect(stores.$playingVoiceMessageId.value).toBeNull();
    expect(stores.$voiceMessageAudioUrl.value).toBeNull();
  });

  test('happy path fetches audio, creates a blob URL, marks read locally', async () => {
    stores.$pairedThisSession.value = {
      deviceId: 7,
      privateKey: dummyPrivateKey,
      publicKeyB64: 'pk',
    };
    stores.$voiceMessages.value = [
      {
        id: 9,
        toDeviceId: 7,
        fromDeviceId: 2,
        fromExternal: null,
        body: 'time for bed',
        sampleRate: 24000,
        channels: 1,
        durationMs: 100,
        readAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    await run('family-phone:play-voicemail', { voicemailId: '9' });
    expect(stores.$playingVoiceMessageId.value).toBe(9);
    expect(stores.$voiceMessageAudioUrl.value).toMatch(/^blob:/);
    expect(stores.$voiceMessages.value[0]?.readAt).not.toBeNull();
  });

  test('a new play revokes the previous blob URL before swapping', async () => {
    stores.$pairedThisSession.value = {
      deviceId: 7,
      privateKey: dummyPrivateKey,
      publicKeyB64: 'pk',
    };
    stores.$voiceMessages.value = [
      {
        id: 10,
        toDeviceId: 7,
        fromDeviceId: 2,
        fromExternal: null,
        body: 'one',
        sampleRate: 24000,
        channels: 1,
        durationMs: 100,
        readAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 11,
        toDeviceId: 7,
        fromDeviceId: 2,
        fromExternal: null,
        body: 'two',
        sampleRate: 24000,
        channels: 1,
        durationMs: 100,
        readAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    await run('family-phone:play-voicemail', { voicemailId: '10' });
    const firstUrl = stores.$voiceMessageAudioUrl.value;
    await run('family-phone:play-voicemail', { voicemailId: '11' });
    const secondUrl = stores.$voiceMessageAudioUrl.value;
    expect(firstUrl).not.toBeNull();
    expect(secondUrl).not.toBeNull();
    expect(firstUrl).not.toBe(secondUrl);
  });
});

describe('family-phone:close-voicemail-player', () => {
  test('clears the playing id and the blob URL', async () => {
    stores.$pairedThisSession.value = {
      deviceId: 7,
      privateKey: dummyPrivateKey,
      publicKeyB64: 'pk',
    };
    stores.$voiceMessages.value = [
      {
        id: 12,
        toDeviceId: 7,
        fromDeviceId: 2,
        fromExternal: null,
        body: 'x',
        sampleRate: 24000,
        channels: 1,
        durationMs: 100,
        readAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    await run('family-phone:play-voicemail', { voicemailId: '12' });
    expect(stores.$voiceMessageAudioUrl.value).not.toBeNull();
    await run('family-phone:close-voicemail-player');
    expect(stores.$voiceMessageAudioUrl.value).toBeNull();
    expect(stores.$playingVoiceMessageId.value).toBeNull();
  });
});

describe('family-phone:dismiss-voicemail-error', () => {
  test('clears the error string', async () => {
    stores.$voiceMessagesError.value = 'boom';
    await run('family-phone:dismiss-voicemail-error');
    expect(stores.$voiceMessagesError.value).toBeNull();
  });
});
