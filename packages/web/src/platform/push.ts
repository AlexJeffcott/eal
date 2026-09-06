/**
 * Web Push subscription lifecycle adapter for eal.
 *
 * `pushManager.subscribe` requires three things to be true before it
 * succeeds:
 *   - the browser exposes ServiceWorker + PushManager + Notification,
 *   - the page is a secure context (HTTPS or http://localhost),
 *   - the user granted notification permission via a gesture-driven
 *     `Notification.requestPermission()` call.
 *
 * This module wraps each one in a small typed surface; the family-phone
 * device-connection delivers the resulting subscription to the server
 * over the already-authed WS, so no HTTP auth path is needed.
 */

export function pushSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
  return (
    'serviceWorker' in navigator &&
    typeof Notification !== 'undefined' &&
    typeof PushManager !== 'undefined'
  );
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

export function requestPushPermission(): Promise<NotificationPermission> {
  if (!pushSupported()) return Promise.resolve('denied');
  return Notification.requestPermission();
}

export interface SerializedPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Fetch this server's VAPID public key (cached client-side for an
 * hour on the response's Cache-Control), then bind a PushSubscription
 * to it. Returns the serialised triple on success, null on every
 * recoverable failure (unsupported browser, permission absent, no
 * VAPID configured server-side).
 */
export async function ensurePushSubscription(): Promise<SerializedPushSubscription | null> {
  if (!pushSupported()) return null;
  if (Notification.permission !== 'granted') return null;

  // `navigator.serviceWorker.ready` never settles when nothing is registered —
  // not a rejection, not a timeout, just a promise that hangs for the life of
  // the page. Measured in the browser tier: a control that awaited it sat on
  // "Just a moment…" until the 5s test timeout and would have sat there
  // forever in a real tab. `getRegistration()` resolves either way, so ask it
  // first and treat "no registration" as the recoverable failure it is.
  const registered = await navigator.serviceWorker.getRegistration();
  if (!registered) return null;
  const registration = await navigator.serviceWorker.ready;

  let publicKey: string;
  try {
    const res = await fetch('/public/push/vapid-public-key');
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null || !('publicKey' in data)) {
      return null;
    }
    const candidate = data.publicKey;
    if (typeof candidate !== 'string') return null;
    publicKey = candidate;
  } catch {
    return null;
  }

  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    });
  } catch (err) {
    console.warn('[push] pushManager.subscribe failed:', err);
    return null;
  }

  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (!p256dh || !auth) return null;

  return {
    endpoint: subscription.endpoint,
    p256dh: uint8ArrayToBase64Url(new Uint8Array(p256dh)),
    auth: uint8ArrayToBase64Url(new Uint8Array(auth)),
  };
}

/**
 * Drop the active subscription at the browser layer. Caller is
 * responsible for telling the server (over the device WS) — this
 * module is browser-side only.
 */
export async function dropPushSubscription(): Promise<string | null> {
  if (!pushSupported()) return null;
  try {
    // `getRegistration()`, not `.ready`, for the reason spelled out above: with
    // nothing registered `.ready` hangs forever, and unsubscribing does not
    // need an *active* worker anyway — only a registration that might hold a
    // subscription. No registration, nothing to drop.
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return null;
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return null;
    const endpoint = existing.endpoint;
    await existing.unsubscribe();
    return endpoint;
  } catch {
    return null;
  }
}

function base64UrlToUint8Array(input: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (input.length % 4)) % 4);
  const base64 = (input + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Backing ArrayBuffer is allocated explicitly so the view is
  // Uint8Array<ArrayBuffer>, not Uint8Array<ArrayBufferLike>; the
  // DOM `applicationServerKey` slot only accepts the former.
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
