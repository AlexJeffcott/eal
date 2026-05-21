import { $recentlyCompleted, $taskFilter } from './stores.ts';
import { parseFilterFromUrl, serializeFilterToUrl } from './filter.ts';
import { $route } from '../../shell/router.ts';

const TASKS_PATH = '/tasks';

/**
 * Bidirectional bridge between the URL query string and `$taskFilter`, active
 * only while the tasks app is the mounted route. Other shell routes — the
 * landing page, the cli-pair page that owns `?code=` — are left untouched.
 *
 * - At boot onto `/tasks`: hydrate the filter from `location.search`, then
 *   canonicalise the URL so a messy inbound deep link settles to minimal form.
 * - On SPA arrival back at `/tasks`: keep the in-memory filter (it survives
 *   navigation) and write it into the now-bare URL.
 * - State → URL: a `$taskFilter` subscription writes `history.replaceState`
 *   (replace, not push — filter tweaks shouldn't pile up in the back stack).
 * - URL → state: a `popstate` listener re-hydrates the filter.
 *
 * The `suppress` flag breaks the feedback loop: when popstate writes the
 * signal, the signal subscription must not turn around and write the URL.
 */
export function installTaskUrlSync(): () => void {
  let suppress = false;
  const onTasksRoute = (): boolean =>
    $route.value === TASKS_PATH || $route.value.startsWith(`${TASKS_PATH}/`);

  function hydrateFromUrl(): void {
    suppress = true;
    $taskFilter.value = parseFilterFromUrl(window.location.search);
    $recentlyCompleted.value = new Set();
    suppress = false;
  }

  function writeUrl(): void {
    if (suppress || !onTasksRoute()) return;
    const url = `${window.location.pathname}${serializeFilterToUrl($taskFilter.value)}`;
    if (window.location.pathname + window.location.search !== url) {
      window.history.replaceState(null, '', url);
    }
  }

  // ── Route → activation ───────────────────────────────────────────────────
  // `$route.subscribe` fires immediately, so the first call is the boot route.
  // A boot straight onto /tasks hydrates from the URL (honouring deep links);
  // a later SPA arrival keeps the in-memory filter and just reflects it back
  // into the URL.
  let booted = false;
  let wasOnTasks = false;
  const unsubscribeRoute = $route.subscribe(() => {
    const now = onTasksRoute();
    if (now && !wasOnTasks) {
      if (!booted) hydrateFromUrl();
      writeUrl();
    }
    wasOnTasks = now;
    booted = true;
  });

  // ── State → URL ──────────────────────────────────────────────────────────
  const unsubscribeFilter = $taskFilter.subscribe(() => writeUrl());

  // ── URL → state (back/forward) ───────────────────────────────────────────
  const onPopState = (): void => {
    if (onTasksRoute()) hydrateFromUrl();
  };
  window.addEventListener('popstate', onPopState);

  return () => {
    unsubscribeRoute();
    unsubscribeFilter();
    window.removeEventListener('popstate', onPopState);
  };
}
