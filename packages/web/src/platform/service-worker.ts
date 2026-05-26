/**
 * Service-worker registration adapter.
 *
 * Production code calls `installServiceWorker()` at boot; tests can
 * swap this module via `mock.module` if they ever need to assert that
 * registration happened (or didn't). The function is best-effort —
 * a browser refusing to register (private mode, hostile extension)
 * leaves push disabled for that session, same as not granting
 * notification permission.
 */

const SW_PATH = '/sw.js';
const SW_SCOPE = '/';

export async function installServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register(SW_PATH, { scope: SW_SCOPE });
    // Force an update check on every boot. The /sw.js response ships
    // with Cache-Control: no-store, so this is a network fetch; if the
    // bytes match the installed worker the browser short-circuits.
    void registration.update();
    return registration;
  } catch (err) {
    console.warn('[platform] service worker registration failed:', err);
    return null;
  }
}
