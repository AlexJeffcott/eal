import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Mock the platform adapter so IncomingCallNotifier constructs the stub
 * Notification class instead of the real browser one. The mock is
 * module-level — every `new Notification()` inside notifications.ts
 * lands on StubNotification, and the test inspects what it recorded.
 */

interface StubNotificationRecord {
  title: string;
  body: string | undefined;
  tag: string | undefined;
  closed: boolean;
}

let permission: NotificationPermission = 'default';
const shown: StubNotificationRecord[] = [];

class StubNotification {
  static get permission(): NotificationPermission { return permission; }
  static async requestPermission(): Promise<NotificationPermission> {
    if (permission === 'default') permission = 'granted';
    return permission;
  }
  private readonly record: StubNotificationRecord;
  constructor(title: string, opts?: NotificationOptions) {
    this.record = { title, body: opts?.body, tag: opts?.tag, closed: false };
    shown.push(this.record);
  }
  close(): void {
    this.record.closed = true;
  }
}

mock.module('../../platform/notification.ts', () => ({
  Notification: StubNotification,
}));

const { IncomingCallNotifier } = await import('./notifications.ts');

function setPermission(value: NotificationPermission): void {
  permission = value;
}

describe('IncomingCallNotifier', () => {
  beforeEach(() => {
    permission = 'default';
    shown.length = 0;
  });

  test('show() is a silent no-op when permission is "default"', () => {
    setPermission('default');
    const notifier = new IncomingCallNotifier();
    notifier.show('Ringing', 'Alex is calling');
    expect(shown.length).toBe(0);
  });

  test('show() is a silent no-op when permission is "denied"', () => {
    setPermission('denied');
    const notifier = new IncomingCallNotifier();
    notifier.show('Ringing', 'Alex is calling');
    expect(shown.length).toBe(0);
  });

  test('show() opens a notification when permission is "granted"', () => {
    setPermission('granted');
    const notifier = new IncomingCallNotifier();
    notifier.show('Ringing', 'Alex is calling');
    expect(shown.length).toBe(1);
    expect(shown[0]?.title).toBe('Ringing');
    expect(shown[0]?.body).toBe('Alex is calling');
    expect(shown[0]?.tag).toBe('family-phone-incoming');
  });

  test('show() called twice closes the previous notification before opening the new one', () => {
    setPermission('granted');
    const notifier = new IncomingCallNotifier();
    notifier.show('Ringing', 'Alex');
    notifier.show('Ringing', 'Elisa');
    expect(shown.length).toBe(2);
    expect(shown[0]?.closed).toBe(true);
    expect(shown[1]?.closed).toBe(false);
  });

  test('dismiss() closes the active notification', () => {
    setPermission('granted');
    const notifier = new IncomingCallNotifier();
    notifier.show('Ringing', 'Alex');
    notifier.dismiss();
    expect(shown[0]?.closed).toBe(true);
  });

  test('requestPermission() short-circuits when already granted', async () => {
    setPermission('granted');
    const notifier = new IncomingCallNotifier();
    const result = await notifier.requestPermission();
    expect(result).toBe('granted');
  });

  test('requestPermission() short-circuits when already denied', async () => {
    setPermission('denied');
    const notifier = new IncomingCallNotifier();
    const result = await notifier.requestPermission();
    expect(result).toBe('denied');
  });

  test('requestPermission() prompts when state is default', async () => {
    setPermission('default');
    const notifier = new IncomingCallNotifier();
    const result = await notifier.requestPermission();
    expect(result).toBe('granted');
  });

  test('permission() mirrors the platform adapter\'s current state', () => {
    setPermission('granted');
    expect(new IncomingCallNotifier().permission()).toBe('granted');
    setPermission('denied');
    expect(new IncomingCallNotifier().permission()).toBe('denied');
    setPermission('default');
    expect(new IncomingCallNotifier().permission()).toBe('default');
  });

  test('dismiss() before show() is a safe no-op', () => {
    setPermission('granted');
    const notifier = new IncomingCallNotifier();
    notifier.dismiss();
    expect(shown.length).toBe(0);
  });
});
