/**
 * Browser-side notifications for incoming family-phone calls.
 *
 * A thin wrapper around the Web Notifications API: ask for permission
 * once (in a dedicated permissions step after pairing), then fire one
 * notification per incoming call and close it when the call resolves.
 *
 * Touches the browser through the `../../platform/notification.ts`
 * adapter. Tests mock that module via `mock.module(...)` and the spy
 * class lands here without any DI.
 */
import { Notification } from '../../platform/notification.ts';

export class IncomingCallNotifier {
  private current: Notification | null = null;

  /**
   * Current permission state from the browser's perspective. Returns
   * 'unsupported' on platforms that do not implement Notifications at all.
   */
  permission(): NotificationPermission | 'unsupported' {
    if (Notification === null) return 'unsupported';
    return Notification.permission;
  }

  /**
   * Ask the user for permission. The browser shows its native dialog
   * exactly once per origin; subsequent calls return the persisted
   * answer without re-prompting. Returns the final state so callers can
   * surface "denied — re-enable in site settings" guidance.
   */
  async requestPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (Notification === null) return 'unsupported';
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Notification.permission;
    }
    return await Notification.requestPermission();
  }

  /**
   * Show a notification for an incoming call. Closes any previous one
   * first so back-to-back calls don't stack. Silent if permission is
   * not granted (no auto-prompt; that is the dedicated permissions
   * step's job).
   */
  show(title: string, body: string): void {
    if (Notification === null) return;
    if (Notification.permission !== 'granted') return;
    if (this.current !== null) {
      try { this.current.close(); } catch { /* already closed */ }
    }
    this.current = new Notification(title, { body, tag: 'family-phone-incoming' });
  }

  /** Dismiss the currently-shown notification, if any. */
  dismiss(): void {
    if (this.current !== null) {
      try { this.current.close(); } catch { /* already closed */ }
      this.current = null;
    }
  }
}
