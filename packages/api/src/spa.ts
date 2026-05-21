import { Elysia } from 'elysia';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../web');
const ENTRY_POINT = resolve(WEB_ROOT, 'src/main.tsx');

interface SpaBundle {
  js: string;
  css: string;
  html: string;
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eal</title>
<link rel="stylesheet" href="/public/static/main.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/public/static/main.js"></script>
</body>
</html>`;

  return { js, css, html };
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
