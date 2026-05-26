import { Elysia } from 'elysia';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../web');
const ENTRY_POINT = resolve(WEB_ROOT, 'src/main.tsx');

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
<html lang="en" data-polly-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>eal</title>
<meta name="theme-color" content="#1a73e8">
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
    background_color: '#ffffff',
    theme_color: '#1a73e8',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  });

  // The icon family. SVG for everything Chrome and modern Safari accept; an
  // apple-touch-icon PNG can be added when there's real art to ship.
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="#1a73e8"/>
<text x="256" y="356" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="280" font-weight="700" fill="#ffffff" text-anchor="middle">eal</text>
</svg>`;
  // Maskable icons have a safe area in the centre 80%; everything beyond may
  // be cropped by the launcher. The text shrinks accordingly.
  const iconMaskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#1a73e8"/>
<text x="256" y="320" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="200" font-weight="700" fill="#ffffff" text-anchor="middle">eal</text>
</svg>`;

  // Minimal service worker — just satisfies the install-criteria heuristic
  // browsers use to enable "Add to Home Screen" / install banners. No
  // caching yet; that lands when we have an actual offline story to tell.
  const serviceWorker = `self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => { /* pass-through */ });
`;

  return { js, css, html, manifest, iconSvg, iconMaskable, serviceWorker };
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
export async function buildSpa() {
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
      headers: { 'content-type': 'application/javascript; charset=utf-8', 'service-worker-allowed': '/' },
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
