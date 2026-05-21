import { $state } from '@fairfox/polly/state';

/**
 * The shell's path router. `$route` mirrors `location.pathname`; the shell
 * reads it to decide which app to mount. The api serves the SPA shell for
 * every path (see `packages/api/src/spa.ts`), so these routes are real,
 * server-served URLs — a refresh or a shared link lands on the right app.
 *
 * In-app state still lives in the query string (see each app's url-sync) — the
 * router only owns the path.
 */
export const $route = $state<string>(
  typeof window === 'undefined' ? '/' : window.location.pathname,
);

/** Navigate to a path without a full reload, and update `$route`. */
export function navigate(path: string): void {
  if (path === $route.value) return;
  window.history.pushState({}, '', path);
  $route.value = path;
}

/** Wire the back/forward buttons to `$route`. Call once at boot. */
export function installRouter(): void {
  window.addEventListener('popstate', () => {
    $route.value = window.location.pathname;
  });
}
