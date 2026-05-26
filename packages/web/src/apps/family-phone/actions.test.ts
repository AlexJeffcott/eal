import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  installCallEventHandlers,
  setNotifierForTest,
  setRingtoneForTest,
} from './actions.ts';
import { $activeCall, $callNote, $incomingCall } from './stores.ts';
import { Ringtone } from './ringtone.ts';
import {
  IncomingCallNotifier,
  type NotificationApi,
  type NotificationCtor,
  type NotificationLike,
} from './notifications.ts';
import { $devices } from '../devices/stores.ts';

/**
 * Wiring tests: prove that the right thing happens to the ringtone and
 * the notifier when call-event messages arrive on the WS. The pure logic
 * of those two pieces is covered by ringtone.test.ts and
 * notifications.test.ts; this file proves they fire from the right
 * triggers in the right sequence.
 */

interface SpyRingtone {
  starts: number;
  stops: number;
  ring: Ringtone;
}
class StubAudioContext {
  readonly state = 'running';
  readonly currentTime = 0;
  readonly destination = {};
  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
      },
      connect() {},
    };
  }
  createOscillator() {
    return {
      frequency: { value: 0 },
      connect() {},
      start() {},
      stop() {},
    };
  }
  async close() {}
}

function makeRingtoneSpy(): SpyRingtone {
  const spy: SpyRingtone = {
    starts: 0,
    stops: 0,
    ring: new Ringtone({ audioContextCtor: StubAudioContext }),
  };
  const realStart = spy.ring.start.bind(spy.ring);
  const realStop = spy.ring.stop.bind(spy.ring);
  spy.ring.start = () => { spy.starts += 1; realStart(); };
  spy.ring.stop = async () => { spy.stops += 1; await realStop(); };
  return spy;
}

interface SpyNotifier {
  shows: { title: string; body: string }[];
  dismisses: number;
  notifier: IncomingCallNotifier;
}
function makeNotifierSpy(): SpyNotifier {
  class StubNotification implements NotificationLike {
    close(): void { /* recorded by the dismiss spy */ }
  }
  const ctor: NotificationCtor = StubNotification;
  async function alwaysGranted(): Promise<NotificationPermission> {
    return 'granted';
  }
  const api: NotificationApi = {
    permission: 'granted',
    requestPermission: alwaysGranted,
    ctor,
  };
  const spy: SpyNotifier = {
    shows: [],
    dismisses: 0,
    notifier: new IncomingCallNotifier(api),
  };
  const realShow = spy.notifier.show.bind(spy.notifier);
  const realDismiss = spy.notifier.dismiss.bind(spy.notifier);
  spy.notifier.show = (title, body) => {
    spy.shows.push({ title, body });
    realShow(title, body);
  };
  spy.notifier.dismiss = () => {
    spy.dismisses += 1;
    realDismiss();
  };
  return spy;
}

describe('family-phone action wiring — ringtone + notifier reactions', () => {
  let ring: SpyRingtone;
  let note: SpyNotifier;

  beforeEach(() => {
    ring = makeRingtoneSpy();
    note = makeNotifierSpy();
    setRingtoneForTest(ring.ring);
    setNotifierForTest(note.notifier);
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

  afterEach(() => {
    setRingtoneForTest(null);
    setNotifierForTest(null);
  });

  test('call:incoming starts the ringtone and shows a notification with caller name', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    expect(ring.starts).toBe(1);
    expect(note.shows.length).toBe(1);
    expect(note.shows[0]?.title).toBe('Incoming call');
    expect(note.shows[0]?.body).toContain("Leo's handset");
    expect(note.shows[0]?.body).toContain('leo');
    expect($incomingCall.value?.callId).toBe('c1');
  });

  test('call:cancelled stops the ringtone and dismisses the notification', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    installCallEventHandlers({ type: 'call:cancelled', callId: 'c1' });
    expect(ring.stops).toBe(1);
    expect(note.dismisses).toBe(1);
    expect($incomingCall.value).toBeNull();
  });

  test('call:rejected stops the ringtone (this device rejected the call)', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    installCallEventHandlers({ type: 'call:rejected', callId: 'c1' });
    expect(ring.stops).toBe(1);
    expect(note.dismisses).toBe(1);
  });

  test('call:accept-ack stops the ringtone (this device accepted)', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    // Mimic the action handler that flips $activeCall before the ack arrives.
    $activeCall.value = { callId: 'c1', role: 'callee', peerDeviceId: 7, state: 'pending' };
    installCallEventHandlers({ type: 'call:accept-ack', callId: 'c1' });
    expect(ring.stops).toBe(1);
    expect(note.dismisses).toBe(1);
  });

  test('call:hung-up after accept dismisses (no ring was active, dismiss is idempotent)', () => {
    installCallEventHandlers({ type: 'call:incoming', callId: 'c1', fromDeviceId: 7 });
    $activeCall.value = { callId: 'c1', role: 'callee', peerDeviceId: 7, state: 'connected' };
    installCallEventHandlers({ type: 'call:accept-ack', callId: 'c1' });
    const stopsAfterAccept = ring.stops;
    installCallEventHandlers({ type: 'call:hung-up', callId: 'c1' });
    expect(ring.stops).toBe(stopsAfterAccept + 1);
    expect($activeCall.value).toBeNull();
  });

  test('caller-side call:invite-ack does NOT start the ringtone', () => {
    installCallEventHandlers({ type: 'call:invite-ack', callId: 'c1' });
    expect(ring.starts).toBe(0);
    expect(note.shows.length).toBe(0);
  });
});
