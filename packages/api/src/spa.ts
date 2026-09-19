import { Elysia } from 'elysia';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../web');
const ENTRY_POINT = resolve(WEB_ROOT, 'src/main.tsx');

/*
 * Chrome colours.
 *
 * The browser toolbar and the PWA splash screen are painted from literals in
 * markup, where a CSS custom property cannot reach. These three mirror polly
 * tokens by value, so they must be re-read from `@fairfox/polly/ui/theme.css`
 * whenever polly's palette moves:
 *
 *   TOPBAR_LIGHT  --polly-surface-raised, light   (the shell top bar)
 *   TOPBAR_DARK   --polly-surface-raised, dark
 *   BRAND         --polly-accent, light           (the app icon)
 *
 * `theme-color` matches the top bar rather than the accent, so the toolbar
 * continues the bar instead of sitting against it as a second colour. The
 * manifest takes one value only and has no media query, so it takes the light
 * pair — the app's default when no preference is expressed.
 */
const TOPBAR_LIGHT = '#ffffff';
const TOPBAR_DARK = '#1c2027';
const BRAND = '#2451b5';

interface SpaBundle {
  js: string;
  css: string;
  html: string;
  manifest: string;
  iconSvg: string;
  iconMaskable: string;
  serviceWorker: string;
}

async function buildBundle(): Promise<SpaBundle> {
  const result = await Bun.build({
    entrypoints: [ENTRY_POINT],
    target: 'browser',
    sourcemap: 'inline',
    minify: false,
  });

  if (!result.success) {
    const message = result.logs.map((l) => String(l)).join('\n');
    throw new Error(`spa: Bun.build failed:\n${message}`);
  }

  let js = '';
  let css = '';
  for (const out of result.outputs) {
    const text = await out.text();
    if (out.type.startsWith('text/javascript')) js += text;
    else if (out.type.startsWith('text/css')) css += text;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>eal</title>
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${TOPBAR_LIGHT}">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${TOPBAR_DARK}">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="eal">
<link rel="stylesheet" href="/public/static/main.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/public/static/main.js"></script>
</body>
</html>`;

  const manifest = JSON.stringify({
    name: 'eal',
    short_name: 'eal',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: TOPBAR_LIGHT,
    theme_color: TOPBAR_LIGHT,
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  });

  // The icon family. SVG for everything Chrome and modern Safari accept; an
  // apple-touch-icon PNG can be added when there's real art to ship.
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="${BRAND}"/>
<text x="256" y="356" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="280" font-weight="700" fill="#ffffff" text-anchor="middle">eal</text>
</svg>`;
  // Maskable icons have a safe area in the centre 80%; everything beyond may
  // be cropped by the launcher. The text shrinks accordingly.
  const iconMaskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="${BRAND}"/>
<text x="256" y="320" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="200" font-weight="700" fill="#ffffff" text-anchor="middle">eal</text>
</svg>`;

  // Service worker — the app shell cache and notifications.
  //
  // The shell (the HTML, the bundle, the stylesheet, the icon, the manifest) is
  // NETWORK-FIRST with a cache fallback, never cache-first. A cache-first
  // worker that holds a broken bundle survives every redeploy; this one serves
  // the cache only when the network fails or does not answer inside
  // NETWORK_TIMEOUT_MS, and a late answer still replaces the cached entry.
  // Every other request — `/api/*`, the WS upgrade, every non-GET — is not
  // intercepted at all.
  //
  // The kill switch: `GET /public/sw-kill` answers `1` when `EAL_SW_KILL=1`.
  // The worker reads it on install, on activate and after every navigation. On
  // `1` it deletes every cache and unregisters itself. It does NOT reload the
  // page: a reload from here would loop for as long as the switch is on. The
  // page reads the same switch before it registers
  // (`web/src/platform/service-worker.ts`), because `register()` on a scope
  // revives a registration that `unregister()` has only marked for removal.
  //
  // Bump SW_VERSION in the same commit as any change to SHELL. The version is
  // the cache key, and activate deletes every other key.
  //
  // The push handler decodes the RFC 8291-decrypted body (web-push performs
  // the encryption on the server side), calls showNotification, and
  // notificationclick focuses or opens the eal PWA at the right route.
  //
  // Payload shape (server emits via web-push.sendNotification):
  //   { kind: 'call', title, body, tag, url }
  const serviceWorker = `const SW_VERSION = 'eal-sw-v2-shell';
const SHELL = ['/', '/public/static/main.js', '/public/static/main.css', '/icon.svg', '/manifest.json'];
const KILL_PATH = '/public/sw-kill';
const NETWORK_TIMEOUT_MS = 4000;

async function isKilled() {
  try {
    const response = await fetch(KILL_PATH, { cache: 'no-store' });
    if (!response.ok) return false;
    return (await response.text()).trim() === '1';
  } catch {
    // No answer is not a kill order: offline is the case the cache exists for.
    return false;
  }
}

// Once true, the fetch handler stops intercepting and nothing writes to a
// cache: a request still in flight must not rebuild what the kill deleted.
let killed = false;

async function destroySelfIfKilled() {
  if (killed) return true;
  if (!(await isKilled())) return false;
  killed = true;
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  await self.registration.unregister();
  console.log('[sw] ' + SW_VERSION + ' killed by ' + KILL_PATH);
  return true;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // A first visit is not controlled by the worker it registers, so nothing
    // that page fetched passes through the fetch handler. Precache here, or
    // one visit followed by an outage has no shell.
    try {
      if (!(await isKilled())) {
        const cache = await caches.open(SW_VERSION);
        await cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' })));
      }
    } catch (err) {
      // A failed precache must not fail the install: the old worker would
      // stay in control, and the fetch handler fills the cache anyway.
      console.warn('[sw] precache failed', err);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SW_VERSION).map((k) => caches.delete(k)));
    } catch {}
    if (await destroySelfIfKilled()) return;
    await self.clients.claim();
    console.log('[sw] ' + SW_VERSION + ' active');
  })());
});

// Every client route is served the same HTML (the '/*' wildcard in spa.ts), so
// every navigation shares the one cache entry under '/'.
function shellKeyFor(request) {
  if (killed) return null;
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (request.mode === 'navigate') {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/public/')) return null;
    return '/';
  }
  return SHELL.includes(url.pathname) ? url.pathname : null;
}

async function networkFirst(event, key) {
  const cache = await caches.open(SW_VERSION);
  const fromNetwork = fetch(event.request).then(async (response) => {
    if (response.ok && !killed) await cache.put(key, response.clone());
    return response;
  });
  // A late answer still has to land in the cache after the timeout has
  // already served the old entry.
  event.waitUntil(fromNetwork.catch(() => {}));
  const cached = await cache.match(key);
  if (!cached) return fromNetwork;
  // A deadline, not a sleep: whichever of the network and the clock answers
  // first decides, and a network answer cancels the clock.
  return new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS);
    fromNetwork.then(
      // A 502 from the proxy during a deploy is an answer, and a worse one
      // than the cached shell.
      (response) => { clearTimeout(deadline); resolve(response.ok ? response : cached); },
      () => { clearTimeout(deadline); resolve(cached); },
    );
  });
}

self.addEventListener('fetch', (event) => {
  const key = shellKeyFor(event.request);
  if (key === null) return;
  event.respondWith(networkFirst(event, key));
  if (event.request.mode === 'navigate') event.waitUntil(destroySelfIfKilled());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = null;
    if (event.data) {
      try { payload = event.data.json(); } catch {}
    }
    const title = (payload && typeof payload.title === 'string' && payload.title) || 'eal';
    const body = (payload && typeof payload.body === 'string' && payload.body) || '';
    const tag = (payload && typeof payload.tag === 'string' && payload.tag) || 'eal';
    const url = (payload && typeof payload.url === 'string' && payload.url) || '/';
    const kind = (payload && typeof payload.kind === 'string' && payload.kind) || '';
    // Vibrate pattern is the closest thing iOS Web Push gives us to a
    // ringtone — it overrides the user's notification-style choice for
    // "Banners" and triggers the haptic engine on a locked phone. The
    // pattern reads as ring-ring-ring (3 long buzzes, short gaps); the
    // OS still plays its default notification tone alongside.
    // Sustained or custom audio is not available to a SW push handler
    // on iOS; that's a platform limit, not a fairfox/eal one.
    const vibrate = kind === 'call' ? [400, 200, 400, 200, 400] : [200];
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: '/icon.svg',
      badge: '/icon.svg',
      vibrate,
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = (event.notification.data && typeof event.notification.data.url === 'string'
      ? event.notification.data.url
      : '/') || '/';
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) {
        try {
          await client.focus();
          if (!client.url.endsWith(target)) {
            await client.navigate(target);
          }
          return;
        } catch {}
      }
    }
    await self.clients.openWindow(target);
  })());
});
`;

  return { js, css, html, manifest, iconSvg, iconMaskable, serviceWorker };
}

/**
 * The service-worker kill switch, from `EAL_SW_KILL`.
 *
 * Same shape as `TWILIO_ENABLED`: unset means off, and any value other than
 * "0" or "1" refuses to boot. A kill switch that reads a typo as "off" fails
 * on the one day it is needed.
 */
export function resolveSwKill(env: NodeJS.ProcessEnv): boolean {
  const raw = env['EAL_SW_KILL'];
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw === '1') return true;
  throw new Error(`EAL_API: EAL_SW_KILL="${raw}" — expected "0" or "1" (or unset).`);
}

/**
 * Build the SPA once at server boot.
 *
 * The bundle (`main.js` / `main.css`) is served under `/public/static/*`. The
 * HTML shell is served at `/` and — via the `/*` wildcard — every other path,
 * so a cold load of a client route like `/tasks` or a shared deep link gets
 * the app instead of a 404. The api's data routes (`/api/*`) are matched ahead
 * of the wildcard; an unmatched `/api/*` path still 404s as JSON, never HTML.
 */
export async function buildSpa(options: { swKill: boolean }) {
  const bundle = await buildBundle();
  const htmlResponse = (): Response =>
    new Response(bundle.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  return new Elysia()
    .get('/public/static/main.js', () => new Response(bundle.js, { headers: { 'content-type': 'application/javascript; charset=utf-8' } }))
    .get('/public/static/main.css', () => new Response(bundle.css, { headers: { 'content-type': 'text/css; charset=utf-8' } }))
    .get('/manifest.json', () => new Response(bundle.manifest, {
      headers: { 'content-type': 'application/manifest+json; charset=utf-8' },
    }))
    .get('/icon.svg', () => new Response(bundle.iconSvg, {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
    }))
    .get('/icon-maskable.svg', () => new Response(bundle.iconMaskable, {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
    }))
    .get('/sw.js', () => new Response(bundle.serviceWorker, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'service-worker-allowed': '/',
        // A stale SW locks every installed PWA out of new versions;
        // refetch the bytes on every check.
        'cache-control': 'no-store',
      },
    }))
    // The worker's kill switch — see the `serviceWorker` source above. Under
    // `/public/` so the auth gate lets an unauthenticated worker read it.
    .get('/public/sw-kill', () => new Response(options.swKill ? '1' : '0', {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    }))
    .get('/', () => htmlResponse())
    .get('/*', ({ request, set }) => {
      // Unmatched `/api/*` paths are genuine 404s — never answer them with the
      // SPA shell, which would mask a typo'd endpoint behind an HTML 200.
      if (new URL(request.url).pathname.startsWith('/api/')) {
        set.status = 404;
        return { error: 'not found' };
      }
      return htmlResponse();
    });
}
