import { describe, expect, test } from 'bun:test';
import {
  IncomingCallNotifier,
  type NotificationApi,
  type NotificationCtor,
  type NotificationLike,
} from './notifications.ts';

interface StubNotificationRecord {
  title: string;
  body: string | undefined;
  tag: string | undefined;
  closed: boolean;
}

function makeApi(initialPermission: NotificationPermission = 'default'): {
  api: NotificationApi;
  shown: StubNotificationRecord[];
} {
  let permission = initialPermission;
  const shown: StubNotificationRecord[] = [];
  class StubNotification implements NotificationLike {
    private readonly record: StubNotificationRecord;
    constructor(title: string, opts?: NotificationOptions) {
      this.record = { title, body: opts?.body, tag: opts?.tag, closed: false };
      shown.push(this.record);
    }
    close(): void {
      this.record.closed = true;
    }
  }
  const ctor: NotificationCtor = StubNotification;
  const api: NotificationApi = {
    get permission() { return permission; },
    async requestPermission() {
      if (permission === 'default') permission = 'granted';
      return permission;
    },
    ctor,
  };
  return { api, shown };
}

describe('IncomingCallNotifier', () => {
  test('permission() returns "unsupported" when the Notifications API is absent', () => {
    const notifier = new IncomingCallNotifier(null);
    expect(notifier.permission()).toBe('unsupported');
  });

  test('show() is a silent no-op when permission is "default"', () => {
    const { api, shown } = makeApi('default');
    const notifier = new IncomingCallNotifier(api);
    notifier.show('Ringing', 'Alex is calling');
    expect(shown.length).toBe(0);
  });

  test('show() is a silent no-op when permission is "denied"', () => {
    const { api, shown } = makeApi('denied');
    const notifier = new IncomingCallNotifier(api);
    notifier.show('Ringing', 'Alex is calling');
    expect(shown.length).toBe(0);
  });

  test('show() opens a notification when permission is "granted"', () => {
    const { api, shown } = makeApi('granted');
    const notifier = new IncomingCallNotifier(api);
    notifier.show('Ringing', 'Alex is calling');
    expect(shown.length).toBe(1);
    expect(shown[0]?.title).toBe('Ringing');
    expect(shown[0]?.body).toBe('Alex is calling');
    expect(shown[0]?.tag).toBe('family-phone-incoming');
  });

  test('show() called twice closes the previous notification before opening the new one', () => {
    const { api, shown } = makeApi('granted');
    const notifier = new IncomingCallNotifier(api);
    notifier.show('Ringing', 'Alex');
    notifier.show('Ringing', 'Elisa');
    expect(shown.length).toBe(2);
    expect(shown[0]?.closed).toBe(true);
    expect(shown[1]?.closed).toBe(false);
  });

  test('dismiss() closes the active notification', () => {
    const { api, shown } = makeApi('granted');
    const notifier = new IncomingCallNotifier(api);
    notifier.show('Ringing', 'Alex');
    notifier.dismiss();
    expect(shown[0]?.closed).toBe(true);
  });

  test('requestPermission() short-circuits when already granted', async () => {
    const { api } = makeApi('granted');
    const notifier = new IncomingCallNotifier(api);
    const result = await notifier.requestPermission();
    expect(result).toBe('granted');
  });

  test('requestPermission() short-circuits when already denied', async () => {
    const { api } = makeApi('denied');
    const notifier = new IncomingCallNotifier(api);
    const result = await notifier.requestPermission();
    expect(result).toBe('denied');
  });

  test('requestPermission() prompts when state is default', async () => {
    const { api } = makeApi('default');
    const notifier = new IncomingCallNotifier(api);
    const result = await notifier.requestPermission();
    expect(result).toBe('granted');
  });
});
