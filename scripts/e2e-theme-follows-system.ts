#!/usr/bin/env bun
/**
 * Regression guard: eal renders in the viewer's colour scheme, from polly tokens.
 *
 * Three faults this script exists to catch, all of which shipped together:
 *
 *   1. `packages/api/src/spa.ts` used to stamp `data-polly-theme="light"` on
 *      <html>, which overrides `prefers-color-scheme`. polly's dark palette was
 *      built, bundled and shipped, and could never render.
 *   2. The `theme-color` meta was a fixed `#1a73e8` — a colour that appears
 *      nowhere in the rendered app, so the browser toolbar met the top bar as a
 *      second, unrelated colour. It is now a media-scoped pair mirroring
 *      `--polly-surface-raised`, the token the top bar is painted from.
 *   3. Sixteen declarations in eal's own CSS named `--polly-color-*` tokens that
 *      polly does not define (`--polly-color-info`, `--polly-color-danger`,
 *      `--polly-color-surface-hover`, and five more). Every one fell through to
 *      a hard-coded hex or rgba fallback, so those stripes and panel
 *      backgrounds were fixed light-mode colours that no theme could move.
 *
 * The three are one fault in practice: (1) hid (2) and (3), because nothing
 * could reach dark mode to expose them. So this script drives the real app at
 * both system preferences and asserts the pixels actually change.
 *
 * Runs at a 350px-wide viewport: the user's small phone is the hard floor.
 *
 *   bun scripts/e2e-theme-follows-system.ts
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/theme-follows-system');
const PROFILE = resolve(ARTIFACTS, 'profile');
const DB_PATH = resolve(ARTIFACTS, 'theme-follows-system.sqlite');
const VIEWPORT = { width: 350, height: 720 };

/**
 * The polly palette values the shell is painted from, read from
 * `@fairfox/polly/ui/theme.css`. The script asserts against these rather than
 * "light differs from dark" alone, so a bundle that half-applies a theme is a
 * failure rather than a pass.
 */
const PALETTE = {
  light: { raised: 'rgb(255, 255, 255)', text: 'rgb(17, 20, 24)' },
  dark: { raised: 'rgb(28, 32, 39)', text: 'rgb(238, 240, 243)' },
} as const;

/** The `theme-color` metas spa.ts emits, one per preference. */
const THEME_COLOR = { light: '#ffffff', dark: '#1c2027' } as const;

/**
 * The eal-authored classes that used to be painted by a non-existent token and
 * its literal fallback. Each names the property that carried the colour. An
 * element wearing one of these must change colour when the scheme changes.
 */
interface Probe {
  selector: string;
  /** The CSS property that carried the colour, as `getPropertyValue` spells it. */
  property: string;
}

const THEMED_CLASSES: readonly Probe[] = [
  { selector: '.family-phone-incoming', property: 'border-left-color' },
  { selector: '.family-phone-active-call', property: 'border-left-color' },
  { selector: '.family-phone-note', property: 'border-left-color' },
  { selector: '.family-phone-pair-first', property: 'border-left-color' },
  { selector: '.family-phone-diagnostics', property: 'border-left-color' },
  { selector: '.family-phone-leave-message', property: 'border-left-color' },
  { selector: '.family-phone-dialpad', property: 'border-left-color' },
  { selector: '.family-phone-diag-result', property: 'background-color' },
  { selector: '.family-phone-transcript', property: 'background-color' },
  { selector: '.devices-error', property: 'border-left-color' },
];

type Scheme = 'light' | 'dark';

interface Reading {
  hasThemePin: boolean;
  colorScheme: string;
  topbarBackground: string;
  bodyColor: string;
  themeColorMetas: Array<{ media: string; content: string }>;
  /** Elements the app actually rendered on the routes visited. */
  live: Record<string, string>;
  /** Every class in THEMED_CLASSES, measured on a swatch element. */
  swatch: Record<string, string>;
}

async function read(page: Page, selectors: readonly Probe[]): Promise<Reading> {
  return page.evaluate((probes: Probe[]) => {
    const root = document.documentElement;
    const rootStyle = getComputedStyle(root);
    const topbar = document.querySelector('[data-topbar]');

    const live: Record<string, string> = {};
    for (const probe of probes) {
      const el = document.querySelector(probe.selector);
      if (el === null) continue;
      live[probe.selector] = getComputedStyle(el).getPropertyValue(probe.property);
    }

    // Several of these classes only render in a call state the harness cannot
    // reach (an incoming call, a completed diagnostic). Measure every one on a
    // swatch instead: a bare element wearing the class, styled by the shipped
    // bundle against the live theme. It proves the rule resolves; the live
    // readings above prove the app really wears these classes.
    const swatch: Record<string, string> = {};
    for (const probe of probes) {
      const el = document.createElement('div');
      el.className = probe.selector.slice(1);
      document.body.append(el);
      swatch[probe.selector] = getComputedStyle(el).getPropertyValue(probe.property);
      el.remove();
    }

    return {
      hasThemePin: root.hasAttribute('data-polly-theme'),
      colorScheme: rootStyle.colorScheme,
      topbarBackground: topbar === null ? '' : getComputedStyle(topbar).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      themeColorMetas: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({
        media: m.getAttribute('media') ?? '',
        content: m.getAttribute('content') ?? '',
      })),
      live,
      swatch,
    };
  }, selectors.map((probe) => ({ selector: probe.selector, property: probe.property })));
}

/**
 * Read the app at one system preference across every route that carries the
 * classes under test, merging what each page contributes.
 */
async function readScheme(page: Page, apiUrl: string, scheme: Scheme, paths: readonly string[]): Promise<Reading> {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  let merged: Reading | null = null;
  for (const path of paths) {
    await page.goto(`${apiUrl}${path}`, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector('[data-topbar]', { timeout: NAV_TIMEOUT_MS });
    const reading: Reading = await read(page, THEMED_CLASSES);
    await page.screenshot({
      path: resolve(ARTIFACTS, `${scheme}${path.replace(/\//g, '-')}.png`),
      fullPage: true,
    });
    if (merged === null) {
      merged = reading;
      continue;
    }
    // The document-level readings are identical on every route at one
    // preference; only the class readings accumulate, since each route renders
    // a different subset.
    for (const [selector, colour] of Object.entries(reading.live)) merged.live[selector] = colour;
    for (const [selector, colour] of Object.entries(reading.swatch)) merged.swatch[selector] = colour;
  }
  if (merged === null) throw new Error('readScheme: no paths visited');
  return merged;
}

function check(failures: string[], label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function main(): Promise<number> {
  // The api serves HTTPS from packages/api/certs, which no CA in this process
  // signs. The browser is told to ignore that below; the bundle fetch needs
  // the same, and every other e2e script sets it the same way.
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });

  const seed = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'browser-seed' });
  const api = await bootApi({ database: DB_PATH, hostname: 'localhost' });
  let browser: Browser | undefined;
  const failures: string[] = [];

  try {
    browser = await puppeteer.launch({
      userDataDir: PROFILE,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    page.on('pageerror', (e: unknown) => {
      console.error('  [pageerror]', e instanceof Error ? e.message : String(e));
    });
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument((token: string) => {
      try {
        localStorage.setItem('eal-token', token);
      } catch {
        /* ignore */
      }
    }, seed.token);

    // ─── Fault 3, statically: no eal rule may name a token polly does not
    //     define. polly's own CSS uses none of the `--polly-color-*` names, so
    //     any hit in the served bundle is an eal rule silently on its fallback.
    const bundle = await (await fetch(`${api.url}/public/static/main.css`)).text();
    const ghosts = [...bundle.matchAll(/--polly-color-[a-z-]+/g)].map((m) => m[0]);
    if (ghosts.length > 0) {
      failures.push(`bundle names ${ghosts.length} token(s) polly does not define: ${[...new Set(ghosts)].join(', ')}`);
    }

    const paths = ['/tasks', '/family-phone', '/devices'] as const;
    const light = await readScheme(page, api.url, 'light', paths);
    const dark = await readScheme(page, api.url, 'dark', paths);

    // ─── Fault 1: nothing pins the scheme, and both palettes reach the page ──
    for (const [scheme, reading] of [['light', light], ['dark', dark]] as const) {
      if (reading.hasThemePin) failures.push(`${scheme}: <html> still carries data-polly-theme`);
      // `light dark` is the declared value — the root advertises both and lets
      // the preference pick. A single value here would be a pin by another name.
      check(failures, `${scheme}: root color-scheme`, reading.colorScheme, 'light dark');
      check(failures, `${scheme}: top bar background`, reading.topbarBackground, PALETTE[scheme].raised);
      check(failures, `${scheme}: body text`, reading.bodyColor, PALETTE[scheme].text);
    }

    // ─── Fault 2: the browser toolbar is painted the same colour as the bar
    //     it sits above, in both schemes ────────────────────────────────────
    const metas = light.themeColorMetas;
    check(failures, 'theme-color meta count', metas.length, 2);
    for (const scheme of ['light', 'dark'] as const) {
      const meta = metas.find((m) => m.media === `(prefers-color-scheme: ${scheme})`);
      check(failures, `theme-color[${scheme}]`, meta?.content, THEME_COLOR[scheme]);
    }

    // ─── Fault 3, live: every themed eal class must actually move ───────────
    for (const selector of THEMED_CLASSES.map((c) => c.selector)) {
      const l = light.swatch[selector];
      const d = dark.swatch[selector];
      if (l === undefined || d === undefined || l === '') {
        failures.push(`${selector}: no colour measured — the class has no rule in the bundle`);
      } else if (l === d) {
        failures.push(`${selector} is ${l} in both schemes — still a fixed colour`);
      }
    }
    const rendered = Object.keys(light.live).filter((k) => k in dark.live);
    if (rendered.length === 0) {
      failures.push('no themed eal class was rendered by the app on any route visited');
    }
    for (const selector of rendered) {
      if (light.live[selector] === dark.live[selector]) {
        failures.push(`${selector} (as rendered) is ${light.live[selector]} in both schemes`);
      }
    }
    console.log(`e2e-theme-follows-system: ${THEMED_CLASSES.length} class(es) measured, ${rendered.length} of them as the app rendered them`);
    console.log(`  rendered on these routes: ${rendered.join(', ')}`);

    // ─── A forced subtree narrows `color-scheme` with it ────────────────────
    //
    // The showcase panel sets data-polly-theme on itself so both palettes can
    // be inspected without touching the OS setting. shell.css matches that
    // attribute to keep the native controls inside the panel in step — without
    // it, a dark-forced panel on a light system still draws light scrollbars,
    // date pickers, and select popups.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.goto(`${api.url}/showcase`, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await page.locator('[data-action="showcase:set-theme"][data-action-theme="dark"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-showcase-panel]')?.getAttribute('data-polly-theme') === 'dark',
      { timeout: NAV_TIMEOUT_MS },
    );
    const forced = await page.evaluate(() => {
      const panel = document.querySelector('[data-showcase-panel]');
      const heading = document.querySelector('.showcase-title');
      return {
        panelColorScheme: panel === null ? '' : getComputedStyle(panel).colorScheme,
        panelBackground: panel === null ? '' : getComputedStyle(panel).backgroundColor,
        headingColor: heading === null ? '' : getComputedStyle(heading).color,
        rootColorScheme: getComputedStyle(document.documentElement).colorScheme,
      };
    });
    await page.screenshot({ path: resolve(ARTIFACTS, 'forced-dark-showcase.png') });
    check(failures, 'forced-dark panel color-scheme', forced.panelColorScheme, 'dark');
    check(failures, 'forced-dark panel background', forced.panelBackground, PALETTE.dark.raised);
    // Inherited `color` carries the value the root computed, so a heading that
    // does not name the token stays near-black on the forced dark surface.
    check(failures, 'forced-dark heading colour', forced.headingColor, PALETTE.dark.text);
    check(failures, 'root color-scheme outside the forced panel', forced.rootColorScheme, 'light dark');

    if (failures.length > 0) {
      console.error('e2e-theme-follows-system: FAILED');
      for (const f of failures) console.error(`  - ${f}`);
      return 1;
    }
    console.log('e2e-theme-follows-system: the app follows the system scheme, from polly tokens throughout');
    console.log(`  screenshots: ${ARTIFACTS}`);
    return 0;
  } finally {
    await browser?.close();
    await api.kill();
  }
}

process.exit(await main());
