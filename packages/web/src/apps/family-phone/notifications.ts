/**
 * Browser-side notifications for incoming family-phone calls.
 *
 * A thin wrapper around the Web Notifications API: ask for permission
 * once (in a dedicated permissions step after pairing), then fire one
 * notification per incoming call and close it when the call resolves.
 *
 * The Notification constructor is injected so unit tests can pass a
 * stub and assert without a real browser.
 */

/** Minimum Notification surface this module touches. */
export interface NotificationLike {
  close(): void;
}
export interface NotificationCtor {
  new (title: string, options?: NotificationOptions): NotificationLike;
}

export interface NotificationApi {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  ctor: NotificationCtor;
}

/**
 * Default deps that read from the global `Notification` constructor.
 * If the browser doesn't support notifications (e.g. older Safari at
 * narrow viewport), every method becomes a no-op rather than throwing.
 */
export function defaultNotificationApi(): NotificationApi | null {
  if (typeof Notification === 'undefined') return null;
  return {
    get permission() { return Notification.permission; },
    requestPermission: () => Notification.requestPermission(),
    ctor: Notification,
  };
}

export class IncomingCallNotifier {
  private current: NotificationLike | null = null;

  constructor(private readonly api: NotificationApi | null) {}

  /**
   * Current permission state from the browser's perspective. Returns
   * 'unsupported' on platforms that do not implement Notifications at all.
   */
  permission(): NotificationPermission | 'unsupported' {
    if (this.api === null) return 'unsupported';
    return this.api.permission;
  }

  /**
   * Ask the user for permission. The browser shows its native dialog
   * exactly once per origin; subsequent calls return the persisted
   * answer without re-prompting. Returns the final state so callers can
   * surface "denied — re-enable in site settings" guidance.
   */
  async requestPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (this.api === null) return 'unsupported';
    if (this.api.permission === 'granted' || this.api.permission === 'denied') {
      return this.api.permission;
    }
    return await this.api.requestPermission();
  }

  /**
   * Show a notification for an incoming call. Closes any previous one
   * first so back-to-back calls don't stack. Silent if permission is
   * not granted (no auto-prompt; that is the dedicated permissions
   * step's job).
   */
  show(title: string, body: string): void {
    if (this.api === null) return;
    if (this.api.permission !== 'granted') return;
    // Close any existing notification inline rather than calling dismiss()
    // so spies in tests don't double-count the dismiss path.
    if (this.current !== null) {
      try { this.current.close(); } catch { /* already closed */ }
    }
    this.current = new this.api.ctor(title, { body, tag: 'family-phone-incoming' });
  }

  /** Dismiss the currently-shown notification, if any. */
  dismiss(): void {
    if (this.current !== null) {
      try { this.current.close(); } catch { /* already closed */ }
      this.current = null;
    }
  }
}
