import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Wiring tests for installCallEventHandlers: prove that the right
 * browser-platform calls fire from the right WS event triggers. Pure
 * logic of the underlying classes lives in ringtone.test.ts and
 * notifications.test.ts; this file proves the integration.
 *
 * Platform adapters are mocked at module level so the singletons inside
 * actions.ts pick up the stubs when they lazy-construct on first call.
 */

class StubAudioContext {
  static instances: StubAudioContext[] = [];
  state: 'running' | 'closed' = 'running';
  currentTime = 0;
  destination: unknown = {};
  constructor() { StubAudioContext.instances.push(this); }
  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
      },
      connect: () => undefined,
    };
  }
  createOscillator() {
    return {
      frequency: { value: 0 },
      connect: () => undefined,
      start() {},
      stop() {},
    };
  }
  async close() { this.state = 'closed'; }
}

interface StubNotificationRecord {
  title: string;
  body: string | undefined;
  closed: boolean;
}
const notifications: StubNotificationRecord[] = [];
class StubNotification {
  static readonly permission: NotificationPermission = 'granted';
  static async requestPermission(): Promise<NotificationPermission> {
    return 'granted';
  }
  private readonly record: StubNotificationRecord;
  constructor(title: string, opts?: NotificationOptions) {
    this.record = { title, body: opts?.body, closed: false };
    notifications.push(this.record);
  }
  close(): void { this.record.closed = true; }
}

mock.module('../../platform/audio-context.ts', () => ({
  AudioContext: StubAudioContext,
}));
mock.module('../../platform/notification.ts', () => ({
  Notification: StubNotification,
}));

const { installCallEventHandlers } = await import('./actions.ts');
const { $activeCall, $callNote, $incomingCall } = await import('./stores.ts');
const { $devices } = await import('../devices/stores.ts');

describe('family-phone action wiring — ringtone + notifier reactions', () => {
  beforeEach(() => {
    StubAudioContext.instances = [];
    notifications.length = 0;
    $devices.value = [
      {
        id: 7,
        label: "Leo's handset",
        kind: 'handset',
        createdAt: '',
        pairedAt: '',
        ownerUserId: 2,
        ownerDisplayName: 'leo',
        online: true,
      },
    ];
    $incomingCall.value = null;
    $activeCall.value = null;
    $callNote.value = null;
  });

  test('call:incoming starts the ringtone and shows a notification with caller name', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    expect(StubAudioContext.instances.length).toBeGreaterThanOrEqual(1);
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.title).toBe('Incoming call');
    expect(notifications[0]?.body).toContain("Leo's handset");
    expect(notifications[0]?.body).toContain('leo');
    expect($incomingCall.value?.callId).toBe('c1');
  });

  test('call:cancelled stops the ringtone and dismisses the notification', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    installCallEventHandlers({ type: 'call:cancelled', callId: 'c1' });
    expect(notifications[0]?.closed).toBe(true);
    expect($incomingCall.value).toBeNull();
  });

  test('call:rejected stops the ringtone (this device rejected the call)', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    installCallEventHandlers({ type: 'call:rejected', callId: 'c1' });
    expect(notifications[0]?.closed).toBe(true);
  });

  test('call:accept-ack stops the ringtone (this device accepted)', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    $activeCall.value = { callId: 'c1', role: 'callee', peerDeviceId: 7, state: 'pending' };
    installCallEventHandlers({ type: 'call:accept-ack', callId: 'c1' });
    expect(notifications[0]?.closed).toBe(true);
  });

  test('call:hung-up after accept dismisses', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    $activeCall.value = { callId: 'c1', role: 'callee', peerDeviceId: 7, state: 'connected' };
    installCallEventHandlers({ type: 'call:accept-ack', callId: 'c1' });
    installCallEventHandlers({ type: 'call:hung-up', callId: 'c1' });
    expect($activeCall.value).toBeNull();
    expect(notifications[0]?.closed).toBe(true);
  });

  test('caller-side call:invite-ack does NOT start the ringtone', () => {
    installCallEventHandlers({ type: 'call:invite-ack', callId: 'c1' });
    expect(notifications.length).toBe(0);
  });
});
