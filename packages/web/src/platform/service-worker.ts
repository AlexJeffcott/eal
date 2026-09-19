/**
 * Service-worker registration adapter.
 *
 * Production code calls `installServiceWorker()` at boot; tests can
 * swap this module via `mock.module` if they ever need to assert that
 * registration happened (or didn't). The function is best-effort —
 * a browser refusing to register (private mode, hostile extension)
 * leaves push and the offline shell off for that session.
 */

const SW_PATH = '/sw.js';
const SW_SCOPE = '/';
const SW_KILL_PATH = '/public/sw-kill';

/**
 * The kill switch — `EAL_SW_KILL=1` on the server, see `api/src/spa.ts`.
 *
 * The worker reads this too and unregisters itself, but that alone does not
 * hold: `register()` on the same scope revives a registration that
 * `unregister()` has only marked for removal, and this module calls
 * `register()` on every boot. So the page reads the switch first. No answer
 * is not a kill order — offline is the case the worker exists for.
 */
async function isKilled(): Promise<boolean> {
  try {
    const response = await fetch(SW_KILL_PATH, { cache: 'no-store' });
    if (!response.ok) return false;
    return (await response.text()).trim() === '1';
  } catch {
    return false;
  }
}

async function removeWorkerAndCaches(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  console.warn('[platform] service worker removed: the kill switch is on');
}

export async function installServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    if (await isKilled()) {
      await removeWorkerAndCaches();
      return null;
    }
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
